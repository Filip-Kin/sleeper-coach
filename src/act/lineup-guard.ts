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

import { solveLineup, startingSlots, availabilityOf, SLOT_ELIGIBILITY, type LineupPlayer } from "../analysis/lineup.ts";
import { buildRosterWeek } from "../analysis/roster-week.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { loadPlayers } from "../data/players.ts";
import { sleeper } from "../sleeper/client.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import type { PlayersMap, Roster, ScoringSettings, SleeperPlayer } from "../sleeper/types.ts";
import { tokenGql, updateStarters, currentStarters } from "../league/api.ts";
import { freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert, sendAlertOnce } from "../alert.ts";
import { config } from "../config.ts";
import { buildRosterView } from "../analysis/roster-view.ts";

import { KICKOFF_CACHE } from "../paths.ts";
import { FailureLedger, classifyLineupRefusal } from "./failure-ledger.ts";

// #region pure
/** A healthy starter is only replaced by a player projected at least this many
 *  points better. On 2026-09-24 the guard benched Jalen Hurts for Dak Prescott
 *  on 18.8 against 18.7, and on 09-22 it moved the same FLEX slot twice in
 *  eight hours on 0.6 and 0.5. Measured over weeks 1-3: 96% of the moves a
 *  healthy player's projection makes between locks are under 1.0, so an edge
 *  that small is the projection breathing, not news. Every swap that was
 *  about something real (2.7, 3.5, 4.9) clears it. */
export const SWAP_MARGIN = Number(process.env.LINEUP_SWAP_MARGIN ?? "1");

export interface LineupSwap { slot: string; out: string; in: string; why: string }
export interface LineupPlan {
  ids: string[]; // slot order, "0" for an empty slot
  changed: boolean;
  unfilled: string[]; // slots the solver could not fill; the current occupant is kept
  swaps: LineupSwap[];
  /** Set when the plan was not made at all: the numbers give no basis. */
  hold?: string;
}

/** Slots with the same label are interchangeable (FLEX, FLEX), so a lineup
 *  that only permutes players among like slots is the same lineup. Writing it
 *  would be a pointless mutation every poll. */
function canonical(ids: string[], slots: string[]): string {
  const groups = new Map<string, string[]>();
  slots.forEach((slot, i) => groups.set(slot, [...(groups.get(slot) ?? []), ids[i] ?? "0"]));
  return [...groups.entries()].sort().map(([slot, v]) => `${slot}:${v.sort().join(",")}`).join("|");
}

/** Decide the lineup we want, given what is on the site now. Pure.
 *
 *  An occupant who is not among the candidates (not on the active roster:
 *  dropped, traded away, or parked on IR while still listed) is a phantom, and
 *  a phantom is an empty slot. He is replaced when a body exists and written
 *  empty when none does, because Sleeper is already scoring the slot as empty. */
/** The late-game hedge.
 *
 *  A Questionable starter is normally started: he usually plays, and when he
 *  is ruled out the guard swaps him on the next poll. That stops being true
 *  when every player who could take his slot kicks off BEFORE his inactives
 *  are known. Then a scratch scores zero and nobody is left to bring in.
 *  2026-10-04: Evans (Questionable, 16:25 ET) over Croskey-Merritt (London,
 *  09:30 ET) on 14.0 against 13.3, with the whole bench locked by 13:00.
 *
 *  So, in the last half hour before a bench alternative locks, a Questionable
 *  player whose own inactives come after that lock is valued at what he is
 *  expected to score: Q_PLAY_PROB of his projection, plus the rest of the time
 *  the best replacement that will still be unlocked when his inactives land
 *  (zero when there is none). Nothing else changes: with a later replacement
 *  available the expected score is at least the replacement's, so the player
 *  with the higher projection still starts, and outside the window, or with
 *  no kickoff table, the plan is the plain one. */
export interface LateHedge {
  kickoffs: Map<string, number>; now: number; pPlay?: number;
  /** Ids the LIVE roster read flags Questionable. When given, only these are
   *  hedged: a candidate's status can come from the projection row, which is
   *  older than the roster's player_map. */
  questionable?: Set<string>;
}
/** Share of Questionable players who play. Roughly three in four across the
 *  league in recent seasons; the tag that reaches game day is the one that
 *  survived the final injury report. */
export const Q_PLAY_PROB = ((v) => (Number.isFinite(v) && v > 0 && v < 1 ? v : 0.75))(Number(process.env.LINEUP_Q_PLAY_PROB ?? "0.75"));
/** Inactives are published 90 minutes before kickoff. */
const INACTIVES_LEAD_MS = 90 * 60_000;
/** Sleeper's status and our 90 s poll need time to turn an inactive list into
 *  a swap; a replacement kicking off sooner than this after the list is not one. */
const REACT_MS = 30 * 60_000;
/** How long before an alternative locks the hedge is decided. Long enough for
 *  twenty polls, short enough that the status is the game-day one. */
const HEDGE_WINDOW_MS = 30 * 60_000;
/** A Questionable tag this far from the player's own kickoff is a practice
 *  report, not a game-time decision (Thursday's tag for a Sunday game). */
const HEDGE_HORIZON_MS = 36 * 60 * 60_000;

const isQuestionable = (p: LineupPlayer): boolean => (p.injuryStatus ?? "").trim().toUpperCase() === "QUESTIONABLE";
function shareSlot(a: LineupPlayer, b: LineupPlayer, slotLabels: string[]): boolean {
  return slotLabels.some((s) => SLOT_ELIGIBILITY[s]?.has(a.position) && SLOT_ELIGIBILITY[s]?.has(b.position));
}

/** Expected points for each Questionable player the hedge applies to, among
 *  the players the first solve would start. `free` carries solver points;
 *  `real` gives the projection. Pure. */
function hedgedPoints(
  starters: LineupPlayer[], bench: LineupPlayer[], real: Map<string, number>, slotLabels: string[], hedge: LateHedge,
): Map<string, { points: number; before: string; forcing: string[] }> {
  const out = new Map<string, { points: number; before: string; forcing: string[] }>();
  const p = hedge.pPlay ?? Q_PLAY_PROB;
  if (!(p >= 0 && p < 1)) return out;
  const kick = (x: LineupPlayer): number | undefined => hedge.kickoffs.get((x as LineupPlayer & { team?: string }).team ?? "");
  const playable = bench.filter((b) => availabilityOf(b).available && (real.get(b.playerId) ?? 0) > 0);
  for (const q of starters) {
    if (!isQuestionable(q) || (hedge.questionable && !hedge.questionable.has(q.playerId))) continue;
    const kq = kick(q);
    if (kq === undefined || kq <= hedge.now || kq - hedge.now > HEDGE_HORIZON_MS) continue;
    const decided = kq - INACTIVES_LEAD_MS + REACT_MS; // when a scratch can first be acted on
    const alts = playable.filter((b) => shareSlot(q, b, slotLabels));
    // An alternative about to lock, before his status can be acted on.
    const forcing = alts.filter((b) => { const kb = kick(b); return kb !== undefined && kb > hedge.now && kb - hedge.now <= HEDGE_WINDOW_MS && kb < decided; });
    if (!forcing.length) continue;
    // The best body still movable when the inactives land. No kickoff known = unlocked.
    // Not another Questionable player: he is no cover.
    const later = alts.filter((b) => !isQuestionable(b) && (kick(b) ?? Number.POSITIVE_INFINITY) >= decided).sort((a, b) => (real.get(b.playerId) ?? 0) - (real.get(a.playerId) ?? 0))[0];
    const own = real.get(q.playerId) ?? 0;
    const first = forcing.sort((a, b) => kick(a)! - kick(b)!)[0]!;
    out.set(q.playerId, { points: p * own + (1 - p) * (later ? real.get(later.playerId) ?? 0 : 0), before: first.name, forcing: forcing.map((b) => b.playerId) });
  }
  return out;
}

export function planLineup(current: string[], candidates: LineupPlayer[], slots: string[], locked: Set<string>, margin = SWAP_MARGIN, hedge?: LateHedge): LineupPlan {
  const active = new Set(candidates.map((p) => p.playerId));
  const site = slots.map((_, i) => current[i] || "0");
  const cur = site.map((pid) => (pid !== "0" && !active.has(pid) ? "0" : pid));
  // 0. No number for anyone is no basis for a decision, not a tie to break.
  //    On 2026-10-07 05:15 ET the projection feed answered with every row
  //    at zero; the solver then "outscored" Chase Brown and Nico Collins
  //    with Croskey-Merritt and Dowdle at 0.0 against 0.0 and wrote it. The
  //    loader refuses such a table now (week-projections.ts); this is the
  //    last gate before a write, for both writers, whatever the loader did.
  //    Table-level only: a single starter at zero with a game is the feed
  //    saying he is not expected to play (Collins 09-25, Smith 10-01, both
  //    Questionable at 0.0 and rightly benched), never a reason to hold.
  if (!candidates.some((p) => p.points > 0)) {
    return { ids: site, changed: false, unfilled: [], swaps: [], hold: "no projection for anyone on the active roster; the week table is empty or unpublished" };
  }
  // 1. Locked starters stay where they are; locked bench players cannot come in.
  const pinned = cur.map((pid) => (pid !== "0" && locked.has(pid) ? pid : null));
  const pinnedSet = new Set(pinned.filter((p): p is string => p !== null));
  const starting = new Set(cur.filter((pid) => pid !== "0"));
  // The incumbent keeps his slot unless the challenger beats him by `margin`.
  // The solver sees the starter's projection plus the margin; everything a
  // human reads (labels, totals) uses the real number. A starter projected
  // at zero gets no help, and one the solver excludes for status (Out, bye,
  // inactive) is excluded whatever his points say, so injury swaps are
  // untouched.
  const free = candidates
    .filter((p) => !pinnedSet.has(p.playerId) && !locked.has(p.playerId))
    .map((p) => (margin > 0 && p.points > 0 && starting.has(p.playerId) ? { ...p, points: p.points + margin } : p));
  const freeIdx = slots.map((_, i) => i).filter((i) => pinned[i] === null);

  // 2. Solve the slots that are still open with the players that can move.
  const freeSlots = freeIdx.map((i) => slots[i]!);
  let solved = solveLineup(free, freeSlots);
  // 2b. The late-game hedge (see LateHedge): re-solve with a Questionable
  //     starter at his expected score when his replacements are about to lock.
  //     The re-solve is kept only when it starts someone new and everyone it
  //     brings in is a player about to lock. The hedge exists to decide about
  //     HIM before he is gone; a replacement who kicks off later can wait for
  //     his own window, and taking him now is undone the moment the locking
  //     player locks (reviewer's replay: bench, restore, bench again). A
  //     re-solve that only trades seats among the same starters is no decision.
  const hedged = new Map<string, { points: number; before: string }>();
  if (hedge) {
    const real = new Map(candidates.map((p) => [p.playerId, p.points]));
    const found = hedgedPoints(solved.starters, solved.bench, real, freeSlots, hedge);
    if (found.size) {
      const again = solveLineup(free.map((p) => {
        const h = found.get(p.playerId);
        return h ? { ...p, points: h.points + (margin > 0 && starting.has(p.playerId) ? margin : 0) } : p;
      }), freeSlots);
      const before = new Set(solved.starters.map((p) => p.playerId));
      const incoming = again.starters.filter((p) => !before.has(p.playerId)).map((p) => p.playerId);
      const mayComeIn = new Set([...found.values()].flatMap((h) => h.forcing));
      if (incoming.length && incoming.every((id) => mayComeIn.has(id))) {
        solved = again;
        for (const [id, h] of found) hedged.set(id, h);
      }
    }
  }
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

  // 3. Same lineup up to like-slot permutation means no write. The comparison
  //    is against what the SITE has, so a phantom occupant is itself a change.
  if (canonical(ids, slots) === canonical(site, slots)) return { ids: site, changed: false, unfilled, swaps: [] };
  if (ids.some((v, i) => v === "0" && cur[i] !== "0")) {
    // Refuse to empty a slot an active player fills; the scheduled lock alerts a human.
    return { ids: site, changed: false, unfilled, swaps: [] };
  }

  const byId = new Map(candidates.map((p) => [p.playerId, p]));
  const why = new Map(solved.excluded.map((e) => [e.player.playerId, e.reason]));
  const outs = site.filter((id) => id !== "0" && !ids.includes(id));
  const ins = ids.filter((id) => id !== "0" && !site.includes(id));
  const swaps: LineupSwap[] = [];
  const label = (id: string) => {
    const p = byId.get(id);
    return p ? `${p.name} ${p.points.toFixed(1)}` : id;
  };
  for (let k = 0; k < Math.max(outs.length, ins.length); k++) {
    const out = outs[k] ?? "";
    const inn = ins[k] ?? "";
    const slot = slots[ids.indexOf(inn)] ?? slots[site.indexOf(out)] ?? "";
    const h = out ? hedged.get(out) : undefined;
    const reason = out
      ? why.get(out) ?? (h ? `Questionable, expected ${h.points.toFixed(1)}; no replacement is left once ${h.before} locks` : active.has(out) ? "outscored" : "not on the active roster")
      : "open slot";
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

/** Players Sleeper will not move, because their game has kicked off. Shared
 *  with the scheduled locks in lineup-run.ts: BOTH writers have to respect it,
 *  or the 11:00 Sunday lock happily benches a Thursday player who has already
 *  banked his points. Pure. */
export function lockedPlayerIds(
  candidates: { playerId: string; team: string }[], kickoffs: Map<string, number>, now: number,
): Set<string> {
  return new Set(
    candidates.filter((p) => (kickoffs.get(p.team) ?? Number.POSITIVE_INFINITY) <= now).map((p) => p.playerId),
  );
}

/** Ids the roster's live player_map flags Questionable. Pure. */
export function liveQuestionable(roster: Pick<Roster, "player_map">): Set<string> {
  return new Set(Object.entries(roster.player_map ?? {}).filter(([, m]) => (m?.injury_status ?? "").trim().toUpperCase() === "QUESTIONABLE").map(([id]) => id));
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

export interface KickoffCache { week?: number; updatedAt?: number; games?: { startTime?: number; label?: string }[] }

/** Is this cache the current week's? A cache for another week is worse than
 *  none: on 2026-09-30 a file from week 4 said every team had kicked off, so
 *  the lineup guard pinned the whole roster and waiver-run marked every
 *  dropped player as on waivers. A cache with no week at all (written before
 *  the writer recorded one) is also refused. Pure. */
export function kickoffCacheIsCurrent(cache: KickoffCache | null | undefined, currentWeek: number): boolean {
  return cache?.week != null && Number(cache.week) === currentWeek;
}

// #region io
let staleCacheLogged = "";

/** The pick'em kickoff cache, only when it is for `currentWeek`. Any other
 *  reader of KICKOFF_CACHE should come through here. */
export async function readKickoffCache(currentWeek: number): Promise<KickoffCache | null> {
  try {
    const f = Bun.file(KICKOFF_CACHE);
    if (!(await f.exists())) return null;
    const cache = (await f.json()) as KickoffCache;
    if (kickoffCacheIsCurrent(cache, currentWeek)) return cache;
    const key = `${cache.week ?? "none"}->${currentWeek}`;
    if (staleCacheLogged !== key) {
      staleCacheLogged = key;
      console.log(`[kickoffs] cache is for week ${cache.week ?? "(unset)"}, current week is ${currentWeek}; ignoring it until the pick'em job rewrites it`);
      logEvent("coach", "kickoff-cache-stale", `Kickoff cache is for week ${cache.week ?? "(unset)"}, not ${currentWeek}; treating every game as not started.`, { cacheWeek: cache.week ?? null, currentWeek });
    }
    return null;
  } catch {
    return null;
  }
}

/** Team -> kickoff ms for the current week, or an empty map (nobody locked)
 *  when the cache is missing or for another week. `currentWeek` comes from
 *  the caller's NFL state when it has one, else from sport_info here. */
export async function cachedTeamKickoffs(currentWeek?: number): Promise<Map<string, number>> {
  const week = currentWeek ?? (await sleeper.nflState().then((s) => s.week).catch(() => undefined));
  if (!(week != null && week >= 1)) return new Map();
  return parseTeamKickoffs(await readKickoffCache(week));
}

// League slots and scoring change once a season; cache them for an hour.
let leagueCache: { at: number; slots: string[]; scoring: ScoringSettings } | null = null;
async function leagueShape(): Promise<{ slots: string[]; scoring: ScoringSettings }> {
  if (leagueCache && Date.now() - leagueCache.at < 60 * 60_000) return leagueCache;
  const league = await sleeper.league(config.leagueId);
  leagueCache = { at: Date.now(), slots: startingSlots(league.roster_positions), scoring: league.scoring_settings };
  return leagueCache;
}

// A plan that failed to write backs off per distinct plan (15 min doubling to
// an hour) and alerts once a day per plan; a dead token or a freeze is said
// once an hour, not forty times. A refusal naming a locked player pins him for
// the rest of the day so the same plan is not offered again.
const failures = new FailureLedger();
let lastHeldNotice = 0;
const NOTICE_MS = 60 * 60_000;
const PIN_MS = 24 * 60 * 60_000;
const pinned = new Map<string, number>();
let emptyProjectionLogged = 0;
let holdLogged = 0;

export interface GuardDeps {
  /** Can a write go out right now? The daemon answers from its token check. */
  tokenReady: () => Promise<boolean>;
  now?: number;
  /** Sleeper refused the lineup because a reserve player is no longer eligible:
   *  the daemon runs the reserve reconciler now rather than at its next poll. */
  onReserveIneligible?: () => Promise<void>;
}

/** Tests only: forget every backoff and pin. */
export function resetGuardStateForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetGuardStateForTests is for tests only");
  pinned.clear();
  lastHeldNotice = 0;
  emptyProjectionLogged = 0;
  holdLogged = 0;
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
    cachedTeamKickoffs(week),
  ]);
  // Players on IR are NOT lineup candidates. Sleeper will not start a reserve
  // player, so offering one is at best a rejected write and at worst a slot
  // silently left empty. Nothing enforced this before 2026-09-19; it only
  // failed to bite because an IR player is usually also flagged Out, which the
  // solver benches for its own reasons. A player who clears his designation
  // while still parked on IR would have walked straight into the lineup.
  // No projection table means no basis for a decision: the endpoint has not
  // published the week yet, or the fetch failed. Solving on zeros would bench
  // everyone for nobody. Skip, and say so once an hour.
  if (weekProj.length === 0) {
    if (now - emptyProjectionLogged > NOTICE_MS) {
      emptyProjectionLogged = now;
      console.log(`[lineup-guard] week ${week} projection table is empty; skipping`);
    }
    return null;
  }
  const candidates = buildRosterWeek([...buildRosterView(mine).activeIds], overlayRosterStatus(dump, mine), byPlayerId(weekProj), week);
  const locked = lockedPlayerIds(candidates, kickoffs, now);
  for (const [id, until] of pinned) {
    if (until > now) locked.add(id);
    else pinned.delete(id);
  }
  // Plan from what the site will SCORE this week: the matchup leg, which is
  // what the app shows too. The roster array can disagree with it (see
  // matchupLegStarters) and did on 2026-09-23.
  const onSite = await currentStarters(tokenGql(), week, mine.starters ?? []);
  const plan = planLineup(onSite, candidates, slots, locked, SWAP_MARGIN, { kickoffs, now, questionable: liveQuestionable(mine) });
  if (plan.hold) {
    if (now - holdLogged > NOTICE_MS) {
      holdLogged = now;
      console.log(`[lineup-guard] week ${week} held: ${plan.hold}`);
    }
    return plan;
  }
  if (!plan.changed) return plan;

  const key = plan.ids.join(",");
  const summary = plan.swaps.map((s) => `${s.slot}: ${s.out} -> ${s.in} (${s.why})`).join("; ");
  if (!failures.shouldAttempt(key, now)) return plan;

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
      // The log line is hourly; the push is daily. A dead token is one fact,
      // and the token invariant already pages for it once a day too.
      await sendAlertOnce("Lineup change pending, Sleeper token not usable", summary, { key: "lineup-token", withinMs: 24 * 60 * 60_000 }).catch(() => {});
    }
    return plan;
  }

  try {
    // updateStarters writes the roster array and the week's leg and throws
    // unless the leg reads back as written.
    const back = await updateStarters(tokenGql(), plan.ids, config.rosterId, config.leagueId, week);
    if (back.join(",") !== key) throw new Error(`read-back mismatch: site has ${back.join(",")}`);
    console.log(`[lineup-guard] week ${week} lineup changed: ${summary}`);
    logEvent("coach", "lineup-auto", `Week ${week} lineup changed between locks: ${summary}`, { week, ids: plan.ids, swaps: plan.swaps });
    failures.clear(key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const verdict = failures.recordFailure(key, now);
    const why = classifyLineupRefusal(msg);
    console.error(`[lineup-guard] write failed (${why.kind}, retry in ${Math.round(verdict.retryInMs / 60_000)} min): ${msg}`);
    logEvent("coach", "lineup-auto-failed", `Week ${week} lineup change failed: ${msg}`, { week, ids: plan.ids, swaps: plan.swaps, kind: why.kind, attempt: verdict.count });
    if (why.kind === "reserve-ineligible" && deps.onReserveIneligible) {
      // The cause is a healed player still on IR. Fix that now; the next poll
      // re-plans against a legal roster.
      await deps.onReserveIneligible().catch((e) => console.error(`[lineup-guard] reserve fix failed: ${e instanceof Error ? e.message : String(e)}`));
    } else if (why.kind === "locked") {
      // Pin whoever Sleeper named; with no id, pin every player this plan
      // moves out, since one of them is the locked one.
      const ids = why.playerId ? [why.playerId] : onSite.filter((id) => id !== "0" && !plan.ids.includes(id));
      for (const id of ids) pinned.set(id, now + PIN_MS);
      if (ids.length) console.log(`[lineup-guard] pinned ${ids.join(", ")} until the lock lifts`);
    }
    if (verdict.alert) await sendAlert("Lineup guard write failed", `${summary}\n${msg}`).catch(() => {});
  }
  return plan;
}
// #endregion
