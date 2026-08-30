import { DATA_DIR } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { projectPoints } from "./scoring.ts";
import { byeWeek } from "../data/byes.ts";
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

function cachePath(season: string, week: number): string {
  return `${DATA_DIR}week-proj-${season}-${week}.json`;
}
function metaPath(season: string, week: number): string {
  return `${DATA_DIR}week-proj-${season}-${week}.meta.json`;
}

async function fetchAndCache(season: string, week: number): Promise<ProjectionRecord[]> {
  const records = await sleeper.weeklyProjections(season, week);
  await Bun.write(cachePath(season, week), JSON.stringify(records));
  await Bun.write(metaPath(season, week), JSON.stringify({ fetchedAt: Date.now(), count: records.length }, null, 2));
  return records;
}

async function rawWeek(season: string, week: number, forceRefresh: boolean): Promise<ProjectionRecord[]> {
  const meta = (await Bun.file(metaPath(season, week)).exists())
    ? ((await Bun.file(metaPath(season, week)).json()) as { fetchedAt: number })
    : null;
  const fresh = meta && Date.now() - meta.fetchedAt < TTL_MS;
  if (!forceRefresh && fresh && (await Bun.file(cachePath(season, week)).exists())) {
    return (await Bun.file(cachePath(season, week)).json()) as ProjectionRecord[];
  }
  return fetchAndCache(season, week);
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
  opts?: { forceRefresh?: boolean },
): Promise<WeekProjection[]> {
  const records = await rawWeek(season, week, opts?.forceRefresh ?? false);
  return normaliseWeek(records, week, scoring);
}

// Index a week by player id for O(1) lookup when assembling a specific roster.
export function byPlayerId(week: WeekProjection[]): Map<string, WeekProjection> {
  return new Map(week.map((p) => [p.playerId, p]));
}
