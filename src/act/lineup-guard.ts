// The lineup guard: every daemon poll, is our current lineup still the optimal
// one? If a starter went from Questionable to Out since the last scheduled
// lock, or a player who was Out is back and outscores his fill-in, the lineup
// is rewritten now rather than at the next fixed lock. Filip: "Why not just do
// it on the 90s periodic? Cheap deterministic check if any player is out, also
// if previously out player is back in."
//
// It is cheap because the reads never touch the 14 MB player dump. GraphQL
// league_rosters answers a bare POST in ~130 ms and its player_map carries the
// live injury_status of every rostered player; the week's projections are the
// 30-minute file cache. Only the write needs the session token
// (roster_update_starters), and only when the solved lineup actually differs
// from the one on the site.
//
// Game lock. Once a player's game has kicked off Sleeper will not move him, in
// or out, so a locked starter is pinned to his slot and a locked bench player
// is never a candidate. Kickoffs come from the pick'em job's cache of Sleeper's
// own scores feed, which the daily backstop refreshes. A team with no cached
// kickoff is treated as unlocked: the worst case is a write Sleeper refuses,
// which the read-back catches and logs, never a wrong lineup.

import { solveLineup, startingSlots, type LineupPlayer } from "../analysis/lineup.ts";
import { buildRosterWeek } from "../analysis/roster-week.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { loadPlayers } from "../data/players.ts";
import { sleeper } from "../sleeper/client.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import type { PlayersMap, Roster, ScoringSettings, SleeperPlayer } from "../sleeper/types.ts";
import { tokenGql, updateStarters } from "../league/api.ts";
import { freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";
import { config } from "../config.ts";

const KICKOFF_CACHE = `${process.env.STATE_DIR ?? "/data/sleeper-coach"}/pickem-kickoffs.json`;

// #region pure
export interface LineupSwap { slot: string; out: string; in: string; why: string }
export interface LineupPlan {
  ids: string[]; // slot order, "0" for an empty slot
  changed: boolean;
  unfilled: string[]; // slots the solver could not fill; the current occupant is kept
  swaps: LineupSwap[];
}

/** Slots with the same label are interchangeable (FLEX, FLEX), so a lineup
 *  that only permutes players among like slots is the same lineup. Writing it
 *  would be a pointless mutation every poll. */
function canonical(ids: string[], slots: string[]): string {
  const groups = new Map<string, string[]>();
  slots.forEach((slot, i) => groups.set(slot, [...(groups.get(slot) ?? []), ids[i] ?? "0"]));
  return [...groups.entries()].sort().map(([slot, v]) => `${slot}:${v.sort().join(",")}`).join("|");
}

/** Decide the lineup we want, given what is on the site now. Pure. */
export function planLineup(current: string[], candidates: LineupPlayer[], slots: string[], locked: Set<string>): LineupPlan {
  const cur = slots.map((_, i) => current[i] || "0");
  // 1. Locked starters stay where they are; locked bench players cannot come in.
  const pinned = cur.map((pid) => (pid !== "0" && locked.has(pid) ? pid : null));
  const pinnedSet = new Set(pinned.filter((p): p is string => p !== null));
  const free = candidates.filter((p) => !pinnedSet.has(p.playerId) && !locked.has(p.playerId));
  const freeIdx = slots.map((_, i) => i).filter((i) => pinned[i] === null);

  // 2. Solve the slots that are still open with the players that can move.
  const solved = solveLineup(free, freeIdx.map((i) => slots[i]!));
  const ids = cur.slice();
  const unfilled: string[] = [];
  freeIdx.forEach((slotI, k) => {
    const p = solved.slots[k]?.player ?? null;
    if (p) ids[slotI] = p.playerId;
    else unfilled.push(slots[slotI]!);
  });
  // An unfilled slot keeps its current occupant when he was not moved elsewhere
  // (an Out kicker with no replacement stays put, which is what a human does),
  // and is never written empty when the site has someone there.
  freeIdx.forEach((slotI) => {
    if (solved.slots[freeIdx.indexOf(slotI)]?.player) return;
    const occupant = cur[slotI]!;
    ids[slotI] = occupant !== "0" && !ids.some((v, j) => j !== slotI && v === occupant) ? occupant : "0";
  });

  // 3. Same lineup up to like-slot permutation means no write.
  if (canonical(ids, slots) === canonical(cur, slots)) return { ids: cur, changed: false, unfilled, swaps: [] };
  if (ids.some((v, i) => v === "0" && cur[i] !== "0")) {
    // Refuse to empty a slot the site has filled; the scheduled lock alerts a human.
    return { ids: cur, changed: false, unfilled, swaps: [] };
  }

  const byId = new Map(candidates.map((p) => [p.playerId, p]));
  const why = new Map(solved.excluded.map((e) => [e.player.playerId, e.reason]));
  const outs = cur.filter((id) => id !== "0" && !ids.includes(id));
  const ins = ids.filter((id) => id !== "0" && !cur.includes(id));
  const swaps: LineupSwap[] = [];
  const label = (id: string) => {
    const p = byId.get(id);
    return p ? `${p.name} ${p.points.toFixed(1)}` : id;
  };
  for (let k = 0; k < Math.max(outs.length, ins.length); k++) {
    const out = outs[k] ?? "";
    const inn = ins[k] ?? "";
    const slot = slots[ids.indexOf(inn)] ?? slots[cur.indexOf(out)] ?? "";
    const reason = out ? why.get(out) ?? "outscored" : "open slot";
    swaps.push({ slot, out: out ? label(out) : "(empty)", in: inn ? label(inn) : "(empty)", why: reason });
  }
  return { ids, changed: true, unfilled, swaps };
}

/** Team -> kickoff ms, from the pick'em kickoff cache ("AWAY@HOME" labels). */
export function parseTeamKickoffs(cache: { games?: { startTime?: number; label?: string }[] } | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of cache?.games ?? []) {
    const t = Number(g.startTime);
    const m = /^([A-Z]{2,4})@([A-Z]{2,4})$/.exec(g.label ?? "");
    if (!Number.isFinite(t) || t <= 0 || !m) continue;
    out.set(m[1]!, t);
    out.set(m[2]!, t);
  }
  return out;
}

/** Lay the roster's live player_map (position, team, injury_status) over the
 *  cached player dump, so the solver benches on today's status, not the
 *  dump's. Pure; returns a new map. */
export function overlayRosterStatus(dump: PlayersMap, roster: Pick<Roster, "player_map">): PlayersMap {
  const pm = roster.player_map;
  if (!pm) return dump;
  const out: PlayersMap = { ...dump };
  for (const [id, m] of Object.entries(pm)) {
    const base: SleeperPlayer = out[id] ?? {
      player_id: id, first_name: m.first_name, last_name: m.last_name, position: m.position,
      fantasy_positions: m.fantasy_positions, team: m.team, age: null, years_exp: null,
      status: m.status, injury_status: m.injury_status, injury_notes: null, search_rank: null,
    };
    out[id] = {
      ...base,
      full_name: base.full_name ?? `${m.first_name} ${m.last_name}`.trim(),
      position: m.position ?? base.position,
      fantasy_positions: m.fantasy_positions ?? base.fantasy_positions,
      team: m.team ?? base.team,
      status: m.status ?? base.status,
      injury_status: m.injury_status, // null means healthy; the dump's stale "Questionable" must not win
    };
  }
  return out;
}
// #endregion

// #region io
async function cachedTeamKickoffs(): Promise<Map<string, number>> {
  try {
    const f = Bun.file(KICKOFF_CACHE);
    if (!(await f.exists())) return new Map();
    return parseTeamKickoffs((await f.json()) as { games?: { startTime?: number; label?: string }[] });
  } catch {
    return new Map();
  }
}

// League slots and scoring change once a season; cache them for an hour.
let leagueCache: { at: number; slots: string[]; scoring: ScoringSettings } | null = null;
async function leagueShape(): Promise<{ slots: string[]; scoring: ScoringSettings }> {
  if (leagueCache && Date.now() - leagueCache.at < 60 * 60_000) return leagueCache;
  const league = await sleeper.league(config.leagueId);
  leagueCache = { at: Date.now(), slots: startingSlots(league.roster_positions), scoring: league.scoring_settings };
  return leagueCache;
}

// A plan that failed to write is not retried every 90 s; and a dead token or a
// freeze is said once an hour, not forty times.
let lastFailure: { key: string; at: number } | null = null;
let lastHeldNotice = 0;
const RETRY_MS = 15 * 60_000;
const NOTICE_MS = 60 * 60_000;

export interface GuardDeps {
  /** Can a write go out right now? The daemon answers from its token check. */
  tokenReady: () => Promise<boolean>;
  now?: number;
}

/** One pass. Returns the plan (changed or not), or null when out of season. */
export async function runLineupGuard(deps: GuardDeps): Promise<LineupPlan | null> {
  const now = deps.now ?? Date.now();
  const state = await sleeper.nflState();
  if (!["regular", "post"].includes(state.season_type) || !(state.week >= 1)) return null;
  const week = state.week;

  const rosters = await leagueRosters(config.leagueId);
  const mine = rosters.find((r) => r.roster_id === config.rosterId);
  if (!mine?.players?.length) throw new Error(`lineup-guard: roster ${config.rosterId} missing or empty`);

  const { slots, scoring } = await leagueShape();
  const [dump, weekProj, kickoffs] = await Promise.all([
    loadPlayers(), // cached; only names and positions come from it now
    loadWeekProjections(state.season || config.season, week, scoring),
    cachedTeamKickoffs(),
  ]);
  const candidates = buildRosterWeek(mine.players, overlayRosterStatus(dump, mine), byPlayerId(weekProj), week);
  const locked = new Set(candidates.filter((p) => (kickoffs.get(p.team) ?? Number.POSITIVE_INFINITY) <= now).map((p) => p.playerId));
  const plan = planLineup(mine.starters ?? [], candidates, slots, locked);
  if (!plan.changed) return plan;

  const key = plan.ids.join(",");
  const summary = plan.swaps.map((s) => `${s.slot}: ${s.out} -> ${s.in} (${s.why})`).join("; ");
  if (lastFailure && lastFailure.key === key && now - lastFailure.at < RETRY_MS) return plan;

  const froze = freezeState();
  if (froze.frozen) {
    if (now - lastHeldNotice > NOTICE_MS) {
      lastHeldNotice = now;
      logEvent("coach", "lineup-held", `Lineup change wanted but writes are frozen: ${summary}`, { week, reason: froze.reason });
    }
    return plan;
  }
  if (!(await deps.tokenReady())) {
    if (now - lastHeldNotice > NOTICE_MS) {
      lastHeldNotice = now;
      logEvent("coach", "lineup-held", `Lineup change wanted but the Sleeper token is not usable: ${summary}`, { week });
      await sendAlert("Lineup change pending, Sleeper token not usable", summary).catch(() => {});
    }
    return plan;
  }

  try {
    await updateStarters(tokenGql(), plan.ids);
    const back = (await leagueRosters(config.leagueId)).find((r) => r.roster_id === config.rosterId)?.starters ?? [];
    if (back.join(",") !== key) throw new Error(`read-back mismatch: site has ${back.join(",")}`);
    console.log(`[lineup-guard] week ${week} lineup changed: ${summary}`);
    logEvent("coach", "lineup-auto", `Week ${week} lineup changed between locks: ${summary}`, { week, ids: plan.ids, swaps: plan.swaps });
    lastFailure = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastFailure = { key, at: now };
    console.error(`[lineup-guard] write failed: ${msg}`);
    logEvent("coach", "lineup-auto-failed", `Week ${week} lineup change failed: ${msg}`, { week, ids: plan.ids, swaps: plan.swaps });
    await sendAlert("Lineup guard write failed", `${summary}\n${msg}`).catch(() => {});
  }
  return plan;
}
// #endregion
