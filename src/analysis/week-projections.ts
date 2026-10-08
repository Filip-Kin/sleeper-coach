import { DATA_DIR } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { projectPoints } from "./scoring.ts";
import { byeWeek } from "../data/byes.ts";
import { weekSchedule } from "../sleeper/graphql.ts";
import { availabilityOf } from "./lineup.ts";
import { logEvent } from "../log.ts";
import type { ProjectionRecord, ScoringSettings, Position } from "../sleeper/types.ts";

// Per-week projections, scored under this league's exact rules. This is the
// input to the lineup solver: a weekly number per player, plus everything the
// solver needs to zero out anyone who is not going to play (injury status, bye,
// and whether the endpoint even carries a game for them this week).
//
// The season-long loader (projections.ts) is deliberately NOT reused: it caches
// one blob per season and scores season totals. A weekly lock needs the
// per-week endpoint, which also carries opponent and game id.
//
// Field reality, confirmed against the live endpoint on 2026-08-30: the
// `/projections/nfl/<season>/<week>` response is one company (rotowire, category
// "proj"), thousands of rows, one row per player. Each row has top-level
// `opponent`, `game_id` and `team`, and a nested `player` with `injury_status`.
// A player with no row for the week has no game that week, which for our
// purposes means bye or otherwise not playing.

export interface WeekProjection {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  opponent: string | null; // e.g. "PHI"; null if no game this week
  gameId: string | null;
  points: number; // projected points under the league's scoring
  ptsPpr: number; // Sleeper's generic full-PPR, kept for sanity checks
  injuryStatus: string | null; // "Questionable", "Out", "IR", ...
  onBye: boolean; // this player's team is on bye this week
  hasGame: boolean; // a projection row with a game id exists for the week
  stats: Record<string, number>;
}

const FANTASY = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
// Weekly projections churn as news breaks through the week (Wednesday inactive
// designations, Friday practice reports). Cache briefly so a lock and its
// read-back re-use one fetch, but never serve a stale table into a Sunday lock.
const TTL_MS = 30 * 60 * 1000;
// A table the feed answered with no numbers is retried sooner. Long enough
// that the 90 s poll does not pull 5 MB on every pass.
const DEGENERATE_TTL_MS = 5 * 60 * 1000;

// #region pure
/** A fetched week is a projection table only when enough of its rows carry
 *  a number. Measured on 2026-10-07 over the cached weeks 5 to 17: 415 to
 *  507 of about 3,230 fantasy rows per week score above zero under this
 *  league's rules; the rest are depth players at an honest 0. On 2026-10-07
 *  05:15 ET the endpoint answered 200 with every row at zero. Nothing
 *  checked it, the table was cached for 30 minutes, and the lineup guard
 *  benched Chase Brown and Nico Collins for Croskey-Merritt and Dowdle,
 *  "0.0 -> 0.0 (outscored)", until the cache expired at 05:46. A rival saw
 *  the lineup before the bot did. A hundred is a quarter of the thinnest
 *  real week and a hundred times an empty one. */
export const MIN_SCORED_ROWS = 100;

/** Rows projected above zero. */
export function scoredRows(table: { points: number }[]): number {
  return table.reduce((n, p) => n + (p.points > 0 ? 1 : 0), 0);
}

/** Can a lineup be decided from this table? */
export function tableIsUsable(table: { points: number }[]): boolean {
  return scoredRows(table) >= MIN_SCORED_ROWS;
}
// #endregion

interface WeekMeta {
  fetchedAt: number;
  count: number;
  /** The last fetch had no numbers. The cache file holds the last usable
   *  table (fetched at `keptFrom`) when there was one, else the empty answer. */
  degenerate?: boolean;
  keptFrom?: number | null;
}

/** Where a week comes from and where it is cached. Tests inject both. */
export interface WeekSource {
  fetch: (season: string, week: number) => Promise<ProjectionRecord[]>;
  dir: string;
  now?: () => number;
}
const DEFAULT_SOURCE: WeekSource = { fetch: (season, week) => sleeper.weeklyProjections(season, week), dir: DATA_DIR };

function cachePath(dir: string, season: string, week: number): string {
  return `${dir}week-proj-${season}-${week}.json`;
}
function metaPath(dir: string, season: string, week: number): string {
  return `${dir}week-proj-${season}-${week}.meta.json`;
}

const degenerateLogged = new Map<string, number>();
const NOTICE_MS = 60 * 60 * 1000;
function noteDegenerate(season: string, week: number, rows: number, keptFrom: number | null, now: number): void {
  const key = `${season}:${week}`;
  if (now - (degenerateLogged.get(key) ?? 0) < NOTICE_MS) return;
  degenerateLogged.set(key, now);
  const served = keptFrom != null ? `serving the table fetched ${new Date(keptFrom).toISOString()}` : "no earlier table on disk; lineup decisions hold";
  console.log(`[week-proj] ${season} week ${week}: the feed answered with no numbers (${rows} rows, under ${MIN_SCORED_ROWS} scored); ${served}`);
  logEvent("coach", "week-proj-degenerate", `Week ${week} projection feed answered with no numbers; ${served}.`, { season, week, rows, keptFrom });
}

async function rawWeek(season: string, week: number, scoring: ScoringSettings, forceRefresh: boolean, src: WeekSource): Promise<ProjectionRecord[]> {
  const cacheF = Bun.file(cachePath(src.dir, season, week));
  const metaF = Bun.file(metaPath(src.dir, season, week));
  const now = src.now?.() ?? Date.now();
  const meta = (await metaF.exists()) ? ((await metaF.json()) as WeekMeta) : null;
  const ttl = meta?.degenerate ? DEGENERATE_TTL_MS : TTL_MS;
  const fresh = meta != null && now - meta.fetchedAt < ttl;
  if (!forceRefresh && fresh && (await cacheF.exists())) {
    return (await cacheF.json()) as ProjectionRecord[];
  }

  const records = await src.fetch(season, week);
  const usable = (r: ProjectionRecord[]) => tableIsUsable(normaliseWeek(r, week, scoring));
  if (usable(records)) {
    await Bun.write(cacheF, JSON.stringify(records));
    await Bun.write(metaF, JSON.stringify({ fetchedAt: now, count: records.length } satisfies WeekMeta, null, 2));
    return records;
  }

  // The feed answered with a table nobody can decide from. Keep the last
  // usable table on disk and serve it, however old: statuses come from the
  // live roster, not from here, so a stale number is still a number and a
  // zero is nothing. Retry sooner than the normal TTL.
  const prev = (await cacheF.exists()) ? ((await cacheF.json()) as ProjectionRecord[]) : null;
  if (prev && usable(prev)) {
    const keptFrom = meta?.keptFrom ?? meta?.fetchedAt ?? null;
    await Bun.write(metaF, JSON.stringify({ fetchedAt: now, count: prev.length, degenerate: true, keptFrom } satisfies WeekMeta, null, 2));
    noteDegenerate(season, week, records.length, keptFrom, now);
    return prev;
  }
  // Nothing usable on disk either (first fetch of the week, or a fresh
  // container). Cache the empty answer briefly and hand it over; every
  // decision path treats a roster of zeros as no basis to act.
  await Bun.write(cacheF, JSON.stringify(records));
  await Bun.write(metaF, JSON.stringify({ fetchedAt: now, count: records.length, degenerate: true, keptFrom: null } satisfies WeekMeta, null, 2));
  noteDegenerate(season, week, records.length, null, now);
  return records;
}

// The projections endpoint carries extra top-level fields the shared
// ProjectionRecord type does not declare (opponent, game_id). Read them off a
// loose view rather than widening the type used elsewhere.
interface WeekRecord extends ProjectionRecord {
  opponent?: string | null;
  game_id?: string | null;
}

// Normalise a raw week into one scored WeekProjection per fantasy player,
// best-first. Deduplicates by player id (keeps the first row) in case the
// endpoint ever returns more than one source, so a player can never appear
// twice and be double-counted by the solver.
export function normaliseWeek(records: ProjectionRecord[], week: number, scoring: ScoringSettings): WeekProjection[] {
  const byId = new Map<string, WeekProjection>();

  for (const raw of records as WeekRecord[]) {
    const pos = (raw.player?.position ?? raw.player?.fantasy_positions?.[0] ?? null) as Position | null;
    if (!pos || !FANTASY.has(pos)) continue;
    if (byId.has(raw.player_id)) continue;

    const stats = raw.stats ?? {};
    const exact = projectPoints(stats, scoring);
    const ptsPpr = stats["pts_ppr"] ?? 0;
    // Fall back to pts_ppr only when the granular line is genuinely absent (some
    // K/DEF rows). A real 0 projection (a benched-by-projection player) must
    // stay 0, not silently borrow pts_ppr.
    const points = exact !== 0 ? exact : ptsPpr;
    const team = raw.player?.team ?? raw.team ?? "FA";
    const gameId = raw.game_id ?? null;

    byId.set(raw.player_id, {
      playerId: raw.player_id,
      name: `${raw.player?.first_name ?? ""} ${raw.player?.last_name ?? ""}`.trim() || raw.player_id,
      position: pos,
      team,
      opponent: raw.opponent ?? null,
      gameId,
      points: Math.round(points * 100) / 100,
      ptsPpr: Math.round(ptsPpr * 100) / 100,
      injuryStatus: raw.player?.injury_status ?? null,
      onBye: byeWeek(team) === week,
      hasGame: gameId != null,
      stats,
    });
  }

  return Array.from(byId.values()).sort((a, b) => b.points - a.points);
}

// Live per-week projections for an in-season lineup call.
export async function loadWeekProjections(
  season: string,
  week: number,
  scoring: ScoringSettings,
  opts?: { forceRefresh?: boolean; source?: WeekSource },
): Promise<WeekProjection[]> {
  const records = await rawWeek(season, week, scoring, opts?.forceRefresh ?? false, opts?.source ?? DEFAULT_SOURCE);
  return normaliseWeek(records, week, scoring);
}

// Index a week by player id for O(1) lookup when assembling a specific roster.
export function byPlayerId(week: WeekProjection[]): Map<string, WeekProjection> {
  return new Map(week.map((p) => [p.playerId, p]));
}

/** Whether a bench body can take a starter's slot this week (roster-fit.ts
 *  keptStarters): a projection row with a game, not on bye, not ruled out by
 *  his live status, points above zero, and not locked out of the slot. The
 *  lock compares the two games: a body whose game has kicked off cannot be
 *  moved into the lineup while the starter's game is still to come, so the
 *  slot would empty. Every other pairing is fine: before either kicks off
 *  the guard swaps them; once the starter's own game has begun the week's
 *  slot is settled by him, and a drop Sleeper refuses for his lock is retried
 *  later, never a cut of the better body (the review of 2026-10-07: on a
 *  Monday and a Tuesday before the week flips both defenses have played and
 *  the rental is still the cut). Pure over the loaded table and schedule.
 *  The live status on the player wins over the table's; a starter with no
 *  row is taken as not yet kicked off. */
export function startableThisWeek(
  table: Map<string, WeekProjection>, games: readonly { away: string; home: string; startTime: number }[], now: number,
): (body: { playerId?: string; injuryStatus?: string | null }, starter: { playerId?: string }) => boolean {
  const kickedOff = new Set<string>();
  for (const g of games) if (g.startTime > 0 && g.startTime <= now) { kickedOff.add(g.away); kickedOff.add(g.home); }
  const started = (p: { playerId?: string }): boolean => { const r = p.playerId ? table.get(p.playerId) : undefined; return !!r && kickedOff.has(r.team); };
  return (body, starter) => {
    const r = body.playerId ? table.get(body.playerId) : undefined;
    if (!r || !r.hasGame || r.onBye || r.points <= 0) return false;
    if (started(body) && !started(starter)) return false;
    return availabilityOf({ playerId: r.playerId, name: r.name, position: r.position, points: r.points, injuryStatus: body.injuryStatus ?? r.injuryStatus }).available;
  };
}

/** startableThisWeek over the live week table and schedule. No numbers, no
 *  decision: a failed or unusable read answers false for everyone, so every
 *  starter stays kept from a cut, and says so on the console. */
export async function loadStartableThisWeek(
  season: string, week: number, scoring: ScoringSettings, now = Date.now(),
): Promise<(body: { playerId?: string; injuryStatus?: string | null }, starter: { playerId?: string }) => boolean> {
  try {
    const [table, games] = await Promise.all([loadWeekProjections(season, week, scoring), weekSchedule(season, week)]);
    return startableThisWeek(byPlayerId(table), games, now);
  } catch (err) {
    console.log(`[week] no usable week ${week} table or schedule (${err instanceof Error ? err.message : String(err)}); every starter is kept from the cut`);
    return () => false;
  }
}
