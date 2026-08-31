import { config, vonaConfig } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { byeWeek } from "../data/byes.ts";
import { loadWeekGames, type NflGame } from "../data/nfl-games.ts";
import { loadWeekProjections, byPlayerId, type WeekProjection } from "../analysis/week-projections.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { buildRosterWeek, type RosterWeekPlayer } from "../analysis/roster-week.ts";
import { solveLineup, startingSlots, availabilityOf, type LineupPlayer } from "../analysis/lineup.ts";
import { describeScoring } from "../analysis/scoring.ts";
import { loadRestOfSeason } from "../analysis/ros-projections.ts";
import { evaluateTradeTwoSided } from "../analysis/trade-fair.ts";
import { planWaivers, planOne } from "../analysis/waivers.ts";
import {
  classifyStarter,
  sideOutlook,
  winProbability,
  type MatchupPhase,
  type StarterLine,
  type StarterStatus,
  type SideOutlook,
  type WinProb,
} from "../analysis/win-prob.ts";
import type { League, LeagueUser, Roster } from "../sleeper/types.ts";

// The IN-SEASON view: everything Filip needs during a football week, assembled
// read-only from the Sleeper API plus the same analysis modules the engine uses.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. Filip does not have the Sleeper app on
// his phone. This is a REPLACEMENT for it, not a companion, so anything that
// matters during a week and is otherwise only visible in Sleeper has to be here:
// injury status, bye weeks, waiver priority, the live scoreboard, the standings
// and the playoff line. A gap here is not a missing nicety, it is information he
// simply cannot get.
//
// Nothing in here writes. It does not touch the engine, the in-season runners or
// /data/sleeper-coach. It imports the solver and the trade/waiver analysis exactly
// as the runners do, so the lineup this view shows is the lineup the coach would
// actually set rather than a second opinion that could drift from it.
//
// Two endpoints, split by cost, because the phone must paint fast:
//   seasonWeek()   the scoreboard, standings, lineup call and byes. Cheap.
//   seasonIntent() pending trades and the waiver plan. Needs rest-of-season
//                  projections (a dozen weekly tables) so it is fetched
//                  separately and cached hard.

// #region cache
// The renderCached pattern from Projects/stonkbot/src/dashboard.ts: a short
// server-side cache in front of the upstream API so any number of viewers (and a
// phone that re-focuses the tab every few seconds) cannot rate-limit Sleeper.
// During live scoring the matchups endpoint is the hot path, so this is the piece
// that keeps us polite.
//
// The PROMISE is cached, not just the value, so ten simultaneous requests on a
// cold cache share ONE upstream fetch instead of starting ten. A rejected promise
// is evicted immediately, so a transient network error is never cached.
interface CacheEntry {
  at: number;
  value: Promise<unknown>;
}
const store = new Map<string, CacheEntry>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  store.set(key, { at: now, value });
  value.catch(() => {
    // Do not let a failure stick around and be served for the whole TTL.
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

// Cache lifetimes. The current week has live scores in it and must feel current;
// a past week is final and never changes again.
const TTL_CURRENT_WEEK_MS = 25_000;
const TTL_OTHER_WEEK_MS = 5 * 60 * 1000;
const TTL_STATE_MS = 60_000;
const TTL_INTENT_MS = 10 * 60 * 1000;
// #endregion

// #region season shape
// The fantasy season that matters ends with the championship. playoff_week_start
// is 16 and there are 4 playoff teams, so that is a semi-final in 16 and a final
// in 17. Week 18 exists in the NFL but has no fantasy meaning in this league, so
// the selector stops at 17.
const CHAMPIONSHIP_WEEK = 17;

export interface WeekTab {
  week: number;
  phase: MatchupPhase;
  playoff: boolean;
  label: string; // short label for the selector chip
}

function weekTabs(currentWeek: number, playoffStart: number): WeekTab[] {
  const tabs: WeekTab[] = [];
  for (let w = 1; w <= CHAMPIONSHIP_WEEK; w++) {
    tabs.push({
      week: w,
      // Coarse phase for the selector only. The SELECTED week's phase is derived
      // from real game states below, which is stricter and can disagree (week 1
      // is "current" all through the preceding week, when nothing has kicked off).
      phase: w < currentWeek ? "past" : w > currentWeek ? "future" : "live",
      playoff: w >= playoffStart,
      label: w >= playoffStart ? (w === CHAMPIONSHIP_WEEK ? "Final" : `PO${w}`) : `W${w}`,
    });
  }
  return tabs;
}
// #endregion

// #region types
export interface PlayerCell {
  playerId: string;
  name: string;
  pos: string;
  team: string;
  opponent: string | null;
  slot: string;
  banked: number; // points scored so far this week
  projection: number; // weekly projection under league scoring
  status: StarterStatus; // banked | live | toplay | bye | out
  // Fraction of his game still to run; drives the win-probability variance.
  fracRemaining: number;
  gameState: "pre" | "in" | "post" | null; // null when the scoreboard is unavailable
  gameDetail: string | null; // ESPN's own text, e.g. "Q3 5:00"
  kickoff: number | null; // epoch ms, so the phone can format in local time
  injury: string | null;
  bye: number | null;
  // Set when the player is unavailable, so the row can say WHY in one word.
  note: string | null;
}

export interface SideView {
  rosterId: number;
  teamName: string;
  owner: string;
  avatar: string | null;
  record: string;
  starters: PlayerCell[];
  bench: PlayerCell[];
  outlook: SideOutlook;
  // Straight from the matchup row, so the header can be reconciled against
  // Sleeper itself rather than only against our own sum.
  sleeperPoints: number;
}

export interface SlotRow {
  slot: string;
  ours: PlayerCell | null;
  theirs: PlayerCell | null;
}

export interface LineupMove {
  name: string;
  pos: string;
  slot: string; // the slot he would occupy (for a start) or vacates (for a sit)
  projection: number;
  note: string | null; // why he is being sat, when there is a reason
}

export interface LineupCall {
  // The lineup our solver would set for this week, in slot order.
  optimal: { slot: string; name: string; pos: string; team: string; projection: number }[];
  optimalTotal: number;
  currentTotal: number;
  gain: number; // optimalTotal - currentTotal
  // The diff as a SET difference, not a per-slot comparison. Comparing slot by
  // slot produces shuffle chains ("McCaffrey out for Chase Brown" in the first RB
  // slot, then "Chase Brown out for Walker" in the second) which are technically
  // accurate and completely unreadable as an instruction. Who starts and who sits
  // is the actual decision.
  start: LineupMove[]; // on the bench now, should be starting
  sit: LineupMove[]; // starting now, should be on the bench
  sameLineup: boolean;
  unfilled: string[];
  benchedForCause: { name: string; reason: string }[];
  // True when the week is over: the diff is then "what we left on the bench",
  // not an instruction.
  retrospective: boolean;
  locked: boolean; // the week has started, so some of this may no longer be settable
}

export interface ByeWeekLoad {
  week: number;
  count: number;
  heavy: boolean;
  players: { name: string; pos: string; team: string }[];
}

export interface ByeTrouble {
  loads: ByeWeekLoad[];
  // The bye load on the week currently being viewed, so the matchup screen can
  // say "four of your players are off this week" without the reader hunting for
  // it in the list.
  selected: ByeWeekLoad | null;
  // The next heavy bye week still ahead of us, priced in starting-lineup points.
  next: {
    week: number;
    count: number;
    costPts: number; // what the bye costs the optimal lineup that week
    withByes: number;
    withoutByes: number;
    players: { name: string; pos: string; team: string }[];
  } | null;
}

export interface StandingRow {
  rank: number;
  rosterId: number;
  teamName: string;
  owner: string;
  avatar: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  waiverPosition: number | null;
  moves: number;
  isUs: boolean;
  inPlayoffSpot: boolean;
}
// #endregion

// #region helpers
function teamNameOf(users: LeagueUser[], roster: Roster): { teamName: string; owner: string; avatar: string | null } {
  const u = users.find((x) => x.user_id === roster.owner_id);
  return {
    teamName: u?.metadata?.team_name?.trim() || u?.display_name || `Roster ${roster.roster_id}`,
    owner: u?.display_name ?? "unknown",
    avatar: u?.avatar ?? null,
  };
}

// Sleeper stores a roster's points for as an integer part plus a separate
// hundredths field. Summing them wrong is how a standings table ends up saying
// 1284 instead of 1284.36.
function pointsFor(roster: Roster): number {
  const s = roster.settings as unknown as { fpts?: number; fpts_decimal?: number };
  return Math.round(((s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100) * 100) / 100;
}

function recordOf(roster: Roster): string {
  const s = roster.settings;
  return s.ties ? `${s.wins}-${s.losses}-${s.ties}` : `${s.wins}-${s.losses}`;
}

// The shape the matchups endpoint actually returns. Declared locally because the
// shared client types it as unknown[].
interface MatchupRow {
  matchup_id: number | null;
  roster_id: number;
  players: string[] | null;
  starters: string[] | null;
  starters_points: number[] | null;
  players_points: Record<string, number> | null;
  points: number;
  custom_points: number | null;
}

// Sleeper uses "0" (and sometimes "") to mean an empty starting slot.
function isEmptySlot(id: string | null | undefined): boolean {
  return !id || id === "0";
}

// Derive the week's real phase from actual game states rather than from the
// calendar. This matters right now: /state/nfl reports week 1 for the whole of
// the preceding week, when no game has kicked off, and showing that as "live"
// with a 0-0 scoreboard would be wrong. Falls back to the calendar when the
// scoreboard is unavailable.
export function derivePhase(
  week: number,
  currentWeek: number,
  games: Map<string, NflGame>,
  scoreboardOk: boolean,
): MatchupPhase {
  if (!scoreboardOk || games.size === 0) {
    return week < currentWeek ? "past" : week > currentWeek ? "future" : "live";
  }
  const states = new Set([...games.values()].map((g) => g.state));
  if (states.has("in")) return "live";
  if (states.has("pre")) return states.has("post") ? "live" : "future";
  return "past";
}

// Build one starter or bench cell, joining the roster player, the weekly
// projection and the live game state.
function toCell(
  p: RosterWeekPlayer,
  slot: string,
  banked: number,
  proj: WeekProjection | undefined,
  game: NflGame | undefined,
  phase: MatchupPhase,
): PlayerCell {
  const avail = availabilityOf(p as LineupPlayer);
  const unavailable = !avail.available && !p.onBye;
  const status = classifyStarter(banked, {
    onBye: p.onBye ?? false,
    unavailable,
    hasGame: p.hasProjection && (proj?.hasGame ?? false),
    phase,
    gameState: game?.state ?? null,
  });
  return {
    playerId: p.playerId,
    name: p.name,
    pos: p.position,
    team: p.team,
    opponent: proj?.opponent ?? null,
    slot,
    banked: Math.round(banked * 100) / 100,
    projection: p.points,
    status,
    // Only a live starter's clock is ever read, and only when we actually have one.
    fracRemaining: status === "live" ? (game?.fracRemaining ?? 0) : status === "toplay" ? 1 : 0,
    gameState: game?.state ?? null,
    gameDetail: game?.detail ?? null,
    kickoff: game?.kickoff ?? null,
    injury: p.injuryStatus ?? null,
    bye: byeWeek(p.team),
    note: p.onBye ? "on bye" : unavailable ? avail.reason : null,
  };
}

function toStarterLine(c: PlayerCell): StarterLine {
  return { banked: c.banked, projection: c.projection, status: c.status, fracRemaining: c.fracRemaining };
}
// #endregion

// #region week view
export interface WeekView {
  league: {
    name: string;
    teams: number;
    playoffTeams: number;
    playoffWeekStart: number;
    championshipWeek: number;
    tradeDeadline: number;
    scoring: string[];
    // This league is ROLLING WAIVER PRIORITY, not FAAB. Sent so the UI can never
    // print a dollar budget that does not exist.
    waiverType: "rolling-priority" | "faab" | "other";
  };
  currentWeek: number;
  week: number;
  phase: MatchupPhase;
  weeks: WeekTab[];
  scoreboard: { ok: boolean; note: string | null };
  matchup: {
    us: SideView;
    them: SideView | null;
    rows: SlotRow[];
    winProb: WinProb;
    // True when there is no opponent this week (a bye in the fantasy schedule).
    noOpponent: boolean;
  };
  lineup: LineupCall;
  byes: ByeTrouble;
  standings: StandingRow[];
  us: { rosterId: number; teamName: string; rank: number; record: string; pointsFor: number; waiverPosition: number | null; inPlayoffSpot: boolean; gamesToPlayoffLine: number };
  generatedAt: number;
  // Seconds the client should wait before refetching. Mirrors the server cache so
  // the phone never polls faster than the data can change.
  refreshSeconds: number;
}

async function buildWeekView(week: number, currentWeek: number): Promise<WeekView> {
  const [league, users, rosters, players] = await Promise.all([
    sleeper.league(config.leagueId),
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    loadPlayers(),
  ]);

  const [weekProj, games, rawMatchups] = await Promise.all([
    loadWeekProjections(config.season, week, league.scoring_settings),
    loadWeekGames(config.season, week),
    sleeper.matchups(config.leagueId, week).catch(() => [] as unknown[]),
  ]);

  const projIndex = byPlayerId(weekProj);
  const phase = derivePhase(week, currentWeek, games.byTeam, games.ok);
  const matchups = rawMatchups as MatchupRow[];
  const slots = startingSlots(league.roster_positions as string[]);

  const ourRoster = rosters.find((r) => r.roster_id === config.rosterId);
  if (!ourRoster) throw new Error(`roster ${config.rosterId} not found in league ${config.leagueId}`);

  const ourRow = matchups.find((m) => m.roster_id === config.rosterId) ?? null;
  const theirRow =
    ourRow && ourRow.matchup_id != null
      ? matchups.find((m) => m.matchup_id === ourRow.matchup_id && m.roster_id !== config.rosterId) ?? null
      : null;

  // Build a side from its matchup row. Falls back to the roster's own starters
  // when a row is missing (a future week Sleeper has not populated yet), so a
  // future matchup still shows a real lineup rather than an empty grid.
  const buildSide = (roster: Roster, row: MatchupRow | null): SideView => {
    const ids = roster.players ?? [];
    const week1 = buildRosterWeek(ids, players, projIndex, week);
    const byId = new Map(week1.map((p) => [p.playerId, p]));

    const starterIdList = (row?.starters ?? roster.starters ?? []).slice();
    const starterPts = row?.starters_points ?? [];
    const playerPts = row?.players_points ?? {};

    const starters: PlayerCell[] = [];
    starterIdList.forEach((pid, i) => {
      const slot = slots[i] ?? "FLEX";
      if (isEmptySlot(pid)) {
        // A genuinely empty slot must be visible, not silently skipped: an unset
        // slot is points thrown away and it is exactly what this app is for.
        starters.push({
          playerId: "", name: "empty slot", pos: slot, team: "", opponent: null, slot,
          banked: 0, projection: 0, status: "out", fracRemaining: 0, gameState: null,
          gameDetail: null, kickoff: null, injury: null, bye: null, note: "no player set",
        });
        return;
      }
      const p = byId.get(pid);
      if (!p) return;
      starters.push(toCell(p, slot, starterPts[i] ?? playerPts[pid] ?? 0, projIndex.get(pid), games.byTeam.get(p.team), phase));
    });

    const startedIds = new Set(starterIdList.filter((s) => !isEmptySlot(s)));
    const bench = week1
      .filter((p) => !startedIds.has(p.playerId))
      .map((p) => toCell(p, "BN", playerPts[p.playerId] ?? 0, projIndex.get(p.playerId), games.byTeam.get(p.team), phase))
      .sort((a, b) => b.projection - a.projection);

    const meta = teamNameOf(users, roster);
    return {
      rosterId: roster.roster_id,
      ...meta,
      record: recordOf(roster),
      starters,
      bench,
      outlook: sideOutlook(starters.map(toStarterLine)),
      sleeperPoints: Math.round((row?.custom_points ?? row?.points ?? 0) * 100) / 100,
    };
  };

  const us = buildSide(ourRoster, ourRow);
  const themRoster = theirRow ? rosters.find((r) => r.roster_id === theirRow.roster_id) ?? null : null;
  const them = themRoster && theirRow ? buildSide(themRoster, theirRow) : null;

  // Slot-by-slot rows: this is the mobile matchup layout, one row per starting
  // slot with our player and theirs on either side of the slot label.
  const rows: SlotRow[] = slots.map((slot, i) => ({
    slot,
    ours: us.starters[i] ?? null,
    theirs: them?.starters[i] ?? null,
  }));

  // With no opponent there is nothing to be probable about, so the model is fed
  // an empty side and reports a decided 100%: honest, and it never renders a
  // fake percentage against nobody.
  const winProb = winProbability(us.outlook, them?.outlook ?? sideOutlook([]));

  const lineup = buildLineupCall(ourRoster, ourRow, players, projIndex, slots, week, phase);
  const byes = await buildByeTrouble(ourRoster, players, league, currentWeek, week);
  const standings = buildStandings(rosters, users, league);
  const ourStanding = standings.find((s) => s.isUs)!;
  const playoffTeams = league.settings.playoff_teams ?? 4;
  const cutoff = standings[playoffTeams - 1];

  return {
    league: {
      name: league.name,
      teams: league.total_rosters,
      playoffTeams,
      playoffWeekStart: league.settings.playoff_week_start ?? 16,
      championshipWeek: CHAMPIONSHIP_WEEK,
      tradeDeadline: league.settings.trade_deadline ?? 0,
      scoring: describeScoring(league.scoring_settings),
      // waiver_type 0 is rolling priority. The stored waiver_budget of 100 is a
      // Sleeper default this league never uses, so it is deliberately not sent.
      waiverType:
        (league.settings as unknown as { waiver_type?: number }).waiver_type === 0
          ? "rolling-priority"
          : (league.settings as unknown as { waiver_type?: number }).waiver_type === 2
            ? "faab"
            : "other",
    },
    currentWeek,
    week,
    phase,
    weeks: weekTabs(currentWeek, league.settings.playoff_week_start ?? 16),
    scoreboard: {
      ok: games.ok,
      note: games.ok
        ? null
        : `Live game states are unavailable (${games.error ?? "scoreboard unreachable"}), so played/playing/yet-to-play cannot be shown for this week.`,
    },
    matchup: { us, them, rows, winProb, noOpponent: them === null },
    lineup,
    byes,
    standings,
    us: {
      rosterId: ourStanding.rosterId,
      teamName: ourStanding.teamName,
      rank: ourStanding.rank,
      record: `${ourStanding.wins}-${ourStanding.losses}${ourStanding.ties ? `-${ourStanding.ties}` : ""}`,
      pointsFor: ourStanding.pointsFor,
      waiverPosition: ourStanding.waiverPosition,
      inPlayoffSpot: ourStanding.inPlayoffSpot,
      // How many wins separate us from the last playoff spot. Positive means we
      // are inside it by that much.
      gamesToPlayoffLine: cutoff ? ourStanding.wins - cutoff.wins : 0,
    },
    generatedAt: Date.now(),
    refreshSeconds: week === currentWeek ? 30 : 300,
  };
}
// #endregion

// #region the coach's intent: the lineup call
// What the solver would set for this week, and how that differs from what is set
// now. This is the part no other app can show him, and it is why the app exists:
// the draft UI's failure was that the engine's intent was invisible.
function buildLineupCall(
  roster: Roster,
  row: MatchupRow | null,
  players: Awaited<ReturnType<typeof loadPlayers>>,
  projIndex: Map<string, WeekProjection>,
  slots: string[],
  week: number,
  phase: MatchupPhase,
): LineupCall {
  const candidates = buildRosterWeek(roster.players ?? [], players, projIndex, week);
  const solved = solveLineup(candidates, slots);

  const currentIds = (row?.starters ?? roster.starters ?? []).slice();
  const byId = new Map(candidates.map((p) => [p.playerId, p]));
  const currentTotal =
    Math.round(currentIds.reduce((s, id) => s + (isEmptySlot(id) ? 0 : byId.get(id)?.points ?? 0), 0) * 100) / 100;

  // Set difference between who starts now and who the solver would start.
  const currentSet = new Set(currentIds.filter((id) => !isEmptySlot(id)));
  const optimalSlotOf = new Map<string, string>();
  for (const sl of solved.slots) if (sl.player) optimalSlotOf.set(sl.player.playerId, sl.slot);
  const currentSlotOf = new Map<string, string>();
  currentIds.forEach((id, i) => {
    if (!isEmptySlot(id)) currentSlotOf.set(id, slots[i] ?? "FLEX");
  });

  const start: LineupMove[] = [];
  for (const [pid, slot] of optimalSlotOf) {
    if (currentSet.has(pid)) continue;
    const p = byId.get(pid);
    if (!p) continue;
    start.push({ name: p.name, pos: p.position, slot, projection: p.points, note: null });
  }
  const sit: LineupMove[] = [];
  for (const pid of currentSet) {
    if (optimalSlotOf.has(pid)) continue;
    const p = byId.get(pid);
    if (!p) {
      sit.push({ name: pid, pos: "?", slot: currentSlotOf.get(pid) ?? "?", projection: 0, note: "not found on the roster" });
      continue;
    }
    const avail = availabilityOf(p);
    sit.push({
      name: p.name,
      pos: p.position,
      slot: currentSlotOf.get(pid) ?? "?",
      projection: p.points,
      note: p.onBye ? "on bye" : avail.available ? null : avail.reason,
    });
  }
  // Biggest swings first: the change that matters most should be read first.
  start.sort((a, b) => b.projection - a.projection);
  sit.sort((a, b) => a.projection - b.projection);

  return {
    // solveLineup hands back the base LineupPlayer, which carries no team, so the
    // team is read back from the candidate index rather than widening the shared
    // solver's types for one display field.
    optimal: solved.slots.map((s) => ({
      slot: s.slot,
      name: s.player?.name ?? "–",
      pos: s.player?.position ?? "?",
      team: s.player ? byId.get(s.player.playerId)?.team ?? "" : "",
      projection: s.player?.points ?? 0,
    })),
    optimalTotal: solved.total,
    currentTotal,
    gain: Math.round((solved.total - currentTotal) * 100) / 100,
    start,
    sit,
    sameLineup: start.length === 0 && sit.length === 0,
    unfilled: solved.unfilled,
    benchedForCause: solved.excluded.map((e) => ({ name: e.player.name, reason: e.reason })),
    retrospective: phase === "past",
    locked: phase !== "future",
  };
}
// #endregion

// #region bye trouble
// Four of our players share the week 8 bye, which the draft post-mortem priced at
// about 10.7 points in that week and called the worst single-week hole in the
// league. Nothing surfaced it at the time, so it is surfaced here, and PRICED
// rather than just counted: the honest question is what the bye costs the lineup
// we can actually field, not how many names collide.
async function buildByeTrouble(
  roster: Roster,
  players: Awaited<ReturnType<typeof loadPlayers>>,
  league: League,
  currentWeek: number,
  selectedWeek: number,
): Promise<ByeTrouble> {
  const ids = roster.players ?? [];
  const rows = ids.map((id) => {
    const d = players[id];
    const isDef = !d && /^[A-Z]{2,4}$/.test(id);
    const team = d?.team ?? (isDef ? id : "");
    return {
      name: d?.full_name ?? (d ? `${d.first_name} ${d.last_name}`.trim() : isDef ? `${id} DEF` : id),
      pos: d?.position ?? (isDef ? "DEF" : "?"),
      team,
      bye: byeWeek(team),
    };
  });

  const byWeek = new Map<number, { name: string; pos: string; team: string }[]>();
  for (const r of rows) {
    if (r.bye == null) continue;
    const list = byWeek.get(r.bye) ?? [];
    list.push({ name: r.name, pos: r.pos, team: r.team });
    byWeek.set(r.bye, list);
  }

  const loads: ByeWeekLoad[] = [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, list]) => ({
      week,
      count: list.length,
      // Same threshold the draft engine's bye veto uses, so the UI and the engine
      // agree on what "crowded" means.
      heavy: list.length >= vonaConfig.byeStackMax,
      players: list,
    }));

  // Price only the NEXT heavy bye still ahead of us. Pricing every one would mean
  // fetching a projection table per bye week, which is a lot of work for weeks
  // that may never matter; this is the one he can still act on.
  const upcoming = loads.find((l) => l.heavy && l.week >= currentWeek) ?? null;
  let next: ByeTrouble["next"] = null;
  if (upcoming) {
    try {
      const proj = await loadWeekProjections(config.season, upcoming.week, league.scoring_settings);
      const idx = byPlayerId(proj);
      const slots = startingSlots(league.roster_positions as string[]);
      const candidates = buildRosterWeek(ids, players, idx, upcoming.week);
      const withByes = solveLineup(candidates, slots).total;

      // The counterfactual: the same roster with nobody on bye.
      //
      // Simply clearing the onBye flag prices the bye at ZERO, and that is not a
      // rounding issue, it is the whole trap. A player on bye has no row in that
      // week's projection table, so his weekly projection is already 0. Marking
      // him "available" just makes a 0-point player eligible, and the solver
      // correctly still prefers the bench player it was going to start anyway.
      // To price the hole we need what he WOULD have scored, so a bye player is
      // valued at his season projection spread over the 17-game season. That is a
      // typical week for him, which is exactly the right counterfactual, and the
      // UI labels the number as such.
      const season = await loadSeasonProjections(config.season, league.scoring_settings);
      const seasonById = new Map(season.map((s) => [s.playerId, s.points]));
      const withoutByes = solveLineup(
        candidates.map((c) =>
          c.onBye
            ? { ...c, onBye: false, points: Math.round(((seasonById.get(c.playerId) ?? 0) / 17) * 100) / 100 }
            : c,
        ),
        slots,
      ).total;
      next = {
        week: upcoming.week,
        count: upcoming.count,
        costPts: Math.round((withoutByes - withByes) * 10) / 10,
        withByes: Math.round(withByes * 10) / 10,
        withoutByes: Math.round(withoutByes * 10) / 10,
        players: upcoming.players,
      };
    } catch {
      // A missing projection table must not cost us the bye COUNT, which is the
      // part that always works.
      next = { week: upcoming.week, count: upcoming.count, costPts: 0, withByes: 0, withoutByes: 0, players: upcoming.players };
    }
  }

  return { loads, selected: loads.find((l) => l.week === selectedWeek) ?? null, next };
}
// #endregion

// #region standings
export function buildStandings(rosters: Roster[], users: LeagueUser[], league: League): StandingRow[] {
  const playoffTeams = league.settings.playoff_teams ?? 4;
  const sorted = rosters
    .slice()
    // Wins first, then points for as the tiebreak. This is Sleeper's default
    // (playoff_seed_type 0) and matches what the app itself shows.
    .sort((a, b) => b.settings.wins - a.settings.wins || pointsFor(b) - pointsFor(a));

  return sorted.map((r, i) => {
    const meta = teamNameOf(users, r);
    const s = r.settings as unknown as { waiver_position?: number; total_moves?: number };
    return {
      rank: i + 1,
      rosterId: r.roster_id,
      ...meta,
      wins: r.settings.wins,
      losses: r.settings.losses,
      ties: r.settings.ties,
      pointsFor: pointsFor(r),
      waiverPosition: s.waiver_position ?? null,
      moves: s.total_moves ?? 0,
      isUs: r.roster_id === config.rosterId,
      inPlayoffSpot: i < playoffTeams,
    };
  });
}
// #endregion

// #region public entry points
async function nflWeek(): Promise<number> {
  const st = await cached("state", TTL_STATE_MS, () => sleeper.nflState());
  return Math.max(1, Math.min(CHAMPIONSHIP_WEEK, st.week || 1));
}

export async function seasonWeek(requested?: number): Promise<WeekView> {
  const currentWeek = await nflWeek();
  const week = Number.isFinite(requested) && requested
    ? Math.max(1, Math.min(CHAMPIONSHIP_WEEK, Math.trunc(requested)))
    : currentWeek;
  const ttl = week === currentWeek ? TTL_CURRENT_WEEK_MS : TTL_OTHER_WEEK_MS;
  return cached(`week:${week}`, ttl, () => buildWeekView(week, currentWeek));
}
// #endregion

// #region the coach's intent: trades and waivers
// Split from the week view because it needs REST-OF-SEASON projections, which is
// a dozen weekly tables. Those are cached on disk after the first build, but the
// cold path is slow enough that it must never sit in front of the scoreboard on a
// Sunday. The phone paints the matchup first and fills this in behind it.

// The fields of a Sleeper transaction this view reads. The shared client types
// transactions as unknown[], so the shape is declared where it is used.
interface TransactionRow {
  transaction_id: string;
  type: string; // "trade" | "waiver" | "free_agent"
  status: string; // "complete" | "pending" | "failed"
  roster_ids: number[] | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  status_updated: number | null;
  created: number | null;
  creator: string | null;
}

export interface TradeSide {
  name: string;
  pos: string;
  team: string;
  rosPoints: number;
  injury: string | null;
  bye: number | null;
}

export interface PendingTradeView {
  transactionId: string;
  partnerRosterId: number | null;
  partnerName: string;
  receive: TradeSide[];
  give: TradeSide[];
  verdict: "accept" | "reject" | "surface";
  ourGain: number;
  theirGain: number;
  edge: number;
  reasons: string[];
  fairnessBlocks: string[];
  railBlocks: string[];
}

export interface WaiverMoveView {
  kind: string;
  add: string;
  pos: string;
  team: string;
  rosPoints: number;
  onWaivers: boolean;
  drop: string | null;
  dropPath: string;
  gainPts: number;
  startsForUs: boolean;
  priorityWorthy: boolean;
  reason: string;
  injury: string | null;
  bye: number | null;
}

export interface IntentView {
  week: number;
  // Waiver context. This league is ROLLING PRIORITY: a successful claim sends us
  // to the BACK of the queue, so the question is never "what is he worth" but "is
  // he worth going last for weeks". The UI says this out loud because there is no
  // budget to reason about and a FAAB mental model would be actively wrong.
  waiver: {
    position: number | null;
    teams: number;
    type: string;
    // Whether we could tell which players are still on waivers versus already
    // cleared. When false everything is treated as a free agent and labelled so.
    clearanceKnown: boolean;
    note: string;
  };
  trades: {
    deadlineWeek: number;
    deadlinePassed: boolean;
    pending: PendingTradeView[];
    // Set when the transactions feed could not be read, so an empty list is never
    // mistaken for "no offers".
    error: string | null;
  };
  waivers: {
    moves: WaiverMoveView[];
    considered: number;
    bestClaim: WaiverMoveView | null;
    // Why there is nothing to do, when there is nothing to do. An empty waiver
    // list is a real answer ("your roster is better than the wire"), but a blank
    // panel looks like a broken fetch, so the best rejected option and the engine's
    // own reason for rejecting it are carried through.
    nothingToDo: { candidate: string; pos: string; rosPoints: number; reason: string } | null;
    error: string | null;
  };
  generatedAt: number;
}

const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

async function buildIntent(week: number): Promise<IntentView> {
  const [league, users, rosters, players] = await Promise.all([
    sleeper.league(config.leagueId),
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    loadPlayers(),
  ]);

  const ourRoster = rosters.find((r) => r.roster_id === config.rosterId);
  if (!ourRoster) throw new Error(`roster ${config.rosterId} not found in league ${config.leagueId}`);

  const ros = await loadRestOfSeason(config.season, week, league.scoring_settings);
  const settings = league.settings as unknown as { waiver_type?: number; waiver_clear_days?: number; reserve_slots?: number; trade_deadline?: number };

  // Everything rostered anywhere in the league. What is left is addable.
  const rostered = new Set<string>();
  for (const r of rosters) for (const pid of r.players ?? []) rostered.add(pid);

  const toTradePlayer = (pid: string) => {
    const r = ros.get(pid);
    const d = players[pid];
    const isDef = !d && /^[A-Z]{2,4}$/.test(pid);
    const team = r?.team ?? d?.team ?? (isDef ? pid : "");
    return {
      name: r?.name ?? d?.full_name ?? (d ? `${d.first_name} ${d.last_name}`.trim() : isDef ? `${pid} DEF` : pid),
      position: r?.position ?? d?.position ?? (isDef ? "DEF" : ""),
      points: r?.points ?? 0,
      injuryStatus: d?.injury_status ?? r?.injuryStatus ?? undefined,
      returnsBeforePlayoffs: r?.returnsBeforePlayoffs ?? false,
      bye: byeWeek(team) ?? undefined,
      team,
    };
  };

  const ourTradeRoster = (ourRoster.players ?? []).map(toTradePlayer);

  // #region pending trades
  const tradeDeadline = settings.trade_deadline ?? 11;
  let pending: PendingTradeView[] = [];
  let tradesError: string | null = null;
  try {
    // A pending offer lives in the current scoring period. Look at this week and
    // the one before it, since an offer sent late in a week can still be open.
    const weeks = [...new Set([week, Math.max(1, week - 1)])];
    const seen = new Set<string>();
    const txs: TransactionRow[] = [];
    for (const w of weeks) {
      const rows = (await sleeper.transactions(config.leagueId, w)) as TransactionRow[];
      for (const t of rows) {
        if (seen.has(t.transaction_id)) continue;
        seen.add(t.transaction_id);
        txs.push(t);
      }
    }
    pending = txs
      .filter((t) => t.type === "trade" && t.status === "pending" && (t.roster_ids ?? []).includes(config.rosterId))
      .map((t) => {
        const receiveIds = Object.entries(t.adds ?? {}).filter(([, rid]) => rid === config.rosterId).map(([pid]) => pid);
        const giveIds = Object.entries(t.drops ?? {}).filter(([, rid]) => rid === config.rosterId).map(([pid]) => pid);
        const partnerRosterId = (t.roster_ids ?? []).find((rid) => rid !== config.rosterId) ?? null;
        const partnerRoster = partnerRosterId != null ? rosters.find((r) => r.roster_id === partnerRosterId) : undefined;
        const theirRoster = (partnerRoster?.players ?? []).map(toTradePlayer);

        const receive = receiveIds.map(toTradePlayer);
        const give = giveIds.map(toTradePlayer);
        // The two-sided verdict: Filip's rule is that a trade must be at least as
        // good for us as for them, which is what kills threshold probing.
        const ev = evaluateTradeTwoSided({ receive, give }, ourTradeRoster, theirRoster);
        const asSide = (p: ReturnType<typeof toTradePlayer>): TradeSide => ({
          name: p.name, pos: p.position, team: p.team, rosPoints: Math.round(p.points * 10) / 10,
          injury: p.injuryStatus ?? null, bye: p.bye ?? null,
        });
        return {
          transactionId: t.transaction_id,
          partnerRosterId,
          partnerName: partnerRoster ? teamNameOf(users, partnerRoster).teamName : "unknown",
          receive: receive.map(asSide),
          give: give.map(asSide),
          verdict: ev.verdict,
          ourGain: ev.ourGain,
          theirGain: ev.theirGain,
          edge: ev.edge,
          reasons: ev.reasons,
          fairnessBlocks: ev.fairnessBlocks,
          railBlocks: ev.railBlocks,
        };
      });
  } catch (err) {
    tradesError = err instanceof Error ? err.message : String(err);
  }
  // #endregion

  // #region waiver plan
  // Which addable players are still ON waivers (a claim burns our queue position)
  // versus already cleared (a costless free-agent add). Sleeper does not expose a
  // per-player waiver flag, so it is derived: a player dropped inside the league's
  // waiver_clear_days window has not cleared yet. If the transactions feed cannot
  // be read we say so rather than guessing, because the distinction is the whole
  // pricing decision under rolling priority.
  const clearDays = settings.waiver_clear_days ?? 2;
  const onWaiversIds = new Set<string>();
  let clearanceKnown = false;
  let waiversError: string | null = null;
  try {
    const now = Date.now();
    const windowMs = clearDays * 24 * 60 * 60 * 1000;
    for (const w of [...new Set([week, Math.max(1, week - 1)])]) {
      const rows = (await sleeper.transactions(config.leagueId, w)) as TransactionRow[];
      for (const t of rows) {
        if (t.status !== "complete") continue;
        const at = t.status_updated ?? t.created ?? 0;
        if (!at || now - at > windowMs) continue;
        for (const pid of Object.keys(t.drops ?? {})) if (!rostered.has(pid)) onWaiversIds.add(pid);
      }
    }
    clearanceKnown = true;
  } catch (err) {
    waiversError = err instanceof Error ? err.message : String(err);
  }

  // Candidate pool: the best unrostered players by rest-of-season projection.
  // Capped because planWaivers evaluates every drop path for every candidate, and
  // nobody is claiming the 60th best free agent.
  const CANDIDATE_DEPTH = 40;
  const candidates = [...ros.values()]
    .filter((p) => !rostered.has(p.playerId) && FANTASY_POS.has(p.position))
    .sort((a, b) => b.points - a.points)
    .slice(0, CANDIDATE_DEPTH)
    .map((p) => ({
      name: p.name,
      position: p.position,
      points: p.points,
      injuryStatus: players[p.playerId]?.injury_status ?? p.injuryStatus ?? undefined,
      returnsBeforePlayoffs: p.returnsBeforePlayoffs,
      bye: byeWeek(p.team) ?? undefined,
      onWaivers: onWaiversIds.has(p.playerId),
      team: p.team,
      playerId: p.playerId,
    }));

  const capacity = (league.roster_positions as string[]).filter((s) => s !== "IR" && s !== "TAXI").length;
  const reserveCount = (ourRoster.reserve ?? []).length;
  const activeCount = (ourRoster.players ?? []).length - reserveCount;
  const state = {
    roster: ourTradeRoster,
    openBenchSlots: Math.max(0, capacity - activeCount),
    openIrSlots: Math.max(0, (settings.reserve_slots ?? 0) - reserveCount),
    startingSlots: startingSlots(league.roster_positions as string[]),
  };

  const byName = new Map(candidates.map((c) => [c.name, c]));
  const moves: WaiverMoveView[] = planWaivers(candidates, state).map((m) => {
    const c = byName.get(m.add);
    return {
      kind: m.kind,
      add: m.add,
      pos: m.position,
      team: c?.team ?? "",
      rosPoints: Math.round((c?.points ?? 0) * 10) / 10,
      onWaivers: m.onWaivers,
      drop: m.drop,
      dropPath: m.dropPath,
      gainPts: m.gainPts,
      startsForUs: m.startsForUs,
      priorityWorthy: m.priorityWorthy,
      reason: m.reason,
      injury: c?.injuryStatus ?? null,
      bye: c?.bye ?? null,
    };
  });
  // #endregion

  // When nothing clears the bar, explain the near miss rather than showing a void.
  let nothingToDo: IntentView["waivers"]["nothingToDo"] = null;
  if (moves.length === 0 && candidates.length > 0) {
    const top = candidates[0]!;
    const verdict = planOne(top, state);
    nothingToDo = {
      candidate: top.name,
      pos: top.position,
      rosPoints: Math.round(top.points * 10) / 10,
      reason: verdict.reason,
    };
  }

  const ourWaiverPos = (ourRoster.settings as unknown as { waiver_position?: number }).waiver_position ?? null;
  return {
    week,
    waiver: {
      position: ourWaiverPos,
      teams: league.total_rosters,
      type: settings.waiver_type === 0 ? "rolling priority" : settings.waiver_type === 2 ? "FAAB" : "unknown",
      clearanceKnown,
      note:
        settings.waiver_type === 0
          ? `Rolling priority, not FAAB: there is no budget. We are #${ourWaiverPos ?? "?"} of ${league.total_rosters}, and a SUCCESSFUL claim sends us to the back of the queue. That is why a claim needs to be a genuine starter, not a streamer you could free-add once he clears.`
          : "This league does not use rolling waiver priority.",
    },
    trades: {
      deadlineWeek: tradeDeadline,
      deadlinePassed: week > tradeDeadline,
      pending,
      error: tradesError,
    },
    waivers: {
      moves,
      considered: candidates.length,
      bestClaim: moves.find((m) => m.kind === "waiver-claim") ?? null,
      nothingToDo,
      error: waiversError,
    },
    generatedAt: Date.now(),
  };
}

export async function seasonIntent(requested?: number): Promise<IntentView> {
  const currentWeek = await nflWeek();
  const week = Number.isFinite(requested) && requested
    ? Math.max(1, Math.min(CHAMPIONSHIP_WEEK, Math.trunc(requested)))
    : currentWeek;
  return cached(`intent:${week}`, TTL_INTENT_MS, () => buildIntent(week));
}
// #endregion
