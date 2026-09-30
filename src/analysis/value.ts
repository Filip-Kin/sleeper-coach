// The ONE value behind every roster decision that is not this week's lineup.
//
// Filip, 2026-09-30, after the coach cut its best bench running back to take a
// worse one off injured reserve, and I then recommended cutting the next best
// one from Monday's numbers:
//
//   "When you drop a player you drop them for the season. We are playing for
//    20 weeks, not one." "If the numbers you are checking can swing, a player
//    is the weakest one day and the strongest the next, then you're checking
//    the wrong numbers. Those may be fine numbers to set the lineup for the
//    week, but not the numbers to drop a player." "Their projected score is
//    like an average of eight all the future weeks and there's a player on
//    waivers whose average for the rest of the season is ten: swap them."
//
// Before this file, four code paths valued a player four ways: the over-cap
// drop and IR activation priced him by how much THIS WEEK's best lineup fell
// without him (every bench player: zero, ties to list order); the trade
// engine used a full-season number scaled by a news feed (a one-week Out
// player: 5% of himself); the waiver engine used rest-of-season points but
// only counted a gain when a starter changed; and "injured stash" had two
// definitions, one of which could never fire. Each incident was fixed where
// it showed and the shared rule kept running elsewhere.
//
// Now: one number, one stash rule, built here and nowhere else.
//
//   value     = rest-of-season points: the sum of this week through the
//               championship week of the projection feed's weekly tables,
//               unscaled. No news multiplier, no weekly number.
//   valueAvg  = value / weeks left. What a manager reads: "he averages 10".
//   stash     = injured now, but ranked inside the startable tier at his
//               position on the full-season projection. Never cut, never
//               traded away, never stashed-and-forgotten by an automatic move.
//   injury    = the LIVE status from the roster read, never a cached dump.
//
// The lineup guard keeps using this week's projection. That is the one place
// a weekly number belongs.

import { loadRestOfSeason, type RosProjection } from "./ros-projections.ts";
import { loadSeasonProjections } from "./projections.ts";
import type { ScoringSettings, Position } from "../sleeper/types.ts";
import type { RailPlayer } from "./rails.ts";

/** The fantasy season ends with the championship in week 17. */
export const LAST_WEEK = 17;

/** How many weeks a decision made in `week` still plays for. */
export function weeksLeft(week: number): number {
  return Math.max(1, LAST_WEEK - Math.max(1, Math.trunc(week)) + 1);
}

/** The startable tier per position in an 8-team league with 2 RB, 2 WR, 1 TE,
 *  2 FLEX: a player ranked inside it on full-season talent is a starter for
 *  somebody, and an injury does not change that. Generous on purpose: the cost
 *  of protecting a fringe player for a few weeks is a bench slot; the cost of
 *  cutting a real one is the season. */
export const STASH_TIER: Record<string, number> = { QB: 14, RB: 36, WR: 40, TE: 14 };

/** Statuses that mean "not playing now". Both the league's IR-eligible set and
 *  the ordinary game-day designations; a stash is about talent, not about
 *  whether Sleeper lets him sit on IR. */
export const NOT_PLAYING = new Set(["IR", "PUP", "NA", "SUS", "DNR", "COV", "OUT", "DOUBTFUL"]);

export function notPlaying(status: string | null | undefined): boolean {
  return NOT_PLAYING.has((status ?? "").trim().toUpperCase());
}

export function isStash(position: string, seasonRank: number, injuryStatus: string | null | undefined, week: number): boolean {
  if (!notPlaying(injuryStatus)) return false;
  if (week >= LAST_WEEK) return false; // nothing to come back for
  const tier = STASH_TIER[position] ?? 0;
  return seasonRank > 0 && seasonRank <= tier;
}

export interface PlayerValue {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  /** Rest-of-season points, unscaled. The number every cut, add, claim and trade uses. */
  value: number;
  /** value / weeks left. */
  valueAvg: number;
  weeksLeft: number;
  /** Full-season projection: the talent signal behind the stash rule and the tie-break. */
  seasonPoints: number;
  /** Rank at his position on seasonPoints, 1 = best. 0 = unranked. */
  seasonRank: number;
  injuryStatus: string | null;
  stash: boolean;
}

/** Pure: join rest-of-season rows, season rows and live statuses into values.
 *  `liveStatus` wins over whatever the projection feed carried, because the
 *  feed is a daily table and the roster read is now. */
export function buildValues(
  ros: Iterable<RosProjection>,
  season: { playerId: string; position: Position; points: number }[],
  week: number,
  liveStatus?: Map<string, string | null | undefined>,
): Map<string, PlayerValue> {
  const wl = weeksLeft(week);
  const seasonById = new Map(season.map((s) => [s.playerId, s]));
  const rankById = new Map<string, number>();
  const byPos = new Map<string, { playerId: string; points: number }[]>();
  for (const s of season) {
    if (!byPos.has(s.position)) byPos.set(s.position, []);
    byPos.get(s.position)!.push(s);
  }
  for (const list of byPos.values()) {
    list.sort((a, b) => b.points - a.points).forEach((s, i) => rankById.set(s.playerId, i + 1));
  }
  const out = new Map<string, PlayerValue>();
  for (const r of ros) {
    const s = seasonById.get(r.playerId);
    const seasonPoints = s?.points ?? 0;
    const seasonRank = rankById.get(r.playerId) ?? 0;
    const live = liveStatus?.has(r.playerId) ? liveStatus.get(r.playerId) ?? null : r.injuryStatus;
    const value = Math.round(r.points * 10) / 10;
    out.set(r.playerId, {
      playerId: r.playerId,
      name: r.name,
      position: r.position,
      team: r.team,
      value,
      valueAvg: Math.round((value / wl) * 10) / 10,
      weeksLeft: wl,
      seasonPoints: Math.round(seasonPoints * 10) / 10,
      seasonRank,
      injuryStatus: live ?? null,
      stash: isStash(r.position, seasonRank, live, week),
    });
  }
  return out;
}

/** The live loader. Weekly and season tables are cached on disk by their own
 *  modules (30 min and 12 h); the live statuses are the caller's roster read. */
export async function loadValues(
  season: string,
  week: number,
  scoring: ScoringSettings,
  liveStatus?: Map<string, string | null | undefined>,
  opts?: { forceRefresh?: boolean },
): Promise<Map<string, PlayerValue>> {
  const ros = await loadRestOfSeason(season, week, scoring, { forceRefresh: opts?.forceRefresh });
  const seasonList = await loadSeasonProjections(season, scoring, { forceRefresh: opts?.forceRefresh });
  return buildValues(ros.values(), seasonList, week, liveStatus);
}

/** A rail/trade-engine player from a value. `points` is the ONE value. */
export function toRail(v: PlayerValue, extra: Partial<RailPlayer> = {}): RailPlayer {
  return {
    playerId: v.playerId,
    name: v.name,
    position: v.position,
    points: v.value,
    seasonPoints: v.seasonPoints,
    seasonRank: v.seasonRank,
    injuryStatus: v.injuryStatus ?? undefined,
    returnsBeforePlayoffs: v.stash,
    ...extra,
  };
}

/** Cut order: lowest rest-of-season value first, then lowest full-season
 *  talent, then name so the order is total. A tie is never list order. */
export function cutOrder<T extends { points: number; seasonPoints?: number; name: string }>(players: T[]): T[] {
  return players.slice().sort((a, b) =>
    a.points - b.points || (a.seasonPoints ?? 0) - (b.seasonPoints ?? 0) || a.name.localeCompare(b.name));
}

/** The live injury status of every player on every roster in the league,
 *  from the roster read's player_map. */
export function liveStatusFromRosters(rosters: { player_map?: Record<string, { injury_status?: string | null } | undefined> | null }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rosters) for (const [id, p] of Object.entries(r.player_map ?? {})) if (p) out.set(id, p.injury_status ?? null);
  return out;
}
