// The week lock on a trade's give side.
//
// A trade is a cut plus an add, and the cut paths already keep this week's
// starters: a starter is cut only when somebody better can take his slot this
// week (roster-fit.ts keptStarters). Until 2026-10-14 no trade path asked. The
// Wednesday proposer chose Colston Loveland (the only tight end of ours playing
// in week 6, LaPorta on bye) plus Jacksonville (the defense on the matchup leg,
// Seattle locked from Thursday night) for Carnell Tate: +9.8 season lineup
// points, and had it been accepted it would have processed Friday under the
// league's two review days and left TE and DEF empty on Sunday. The coach had
// also floated RJ Harvey and Loveland for Trevor Lawrence in a DM the night
// before, both week-6 starters.
//
// THE RULE. A player on this week's matchup leg who plays this week (a game,
// not on bye, not ruled out), whose slot nobody else on the roster can fill
// when he leaves, is not given away while the trade would process before his
// kickoff. "Process" is acceptance plus the league's trade_review_days (0 = at
// once); every body's ability to fill a slot is judged at that moment, since
// that is when the slot opens (a Thursday defense cannot cover a Friday
// departure). The test for "nobody can fill" is keptStarters' own: at a swap
// position a better body on the roster who can start; at a flex position no
// rostered body lifts the protection. He is givable again once his game has
// kicked off before the processing moment, or when the week flips and the leg
// is next week's. Bye and Out starters have no week points for us and are
// not locked. A man on IR is never on the leg.
//
// No table or schedule, no decision: with the week unknown every active
// starter on the leg is locked, the same answer the cut paths give ("every
// starter kept"). Pure: the live reads are in trade-wire.ts.

import type { RailPlayer } from "./rails.ts";
import type { WeekProjection } from "./week-projections.ts";
import { startableThisWeek, weekPointsThisWeek } from "./week-projections.ts";
import { keptStarters } from "./roster-fit.ts";

export interface WeekLockGame { away: string; home: string; startTime: number }

export interface WeekLockInput {
  /** Our roster as the trade snapshot carries it, IR included. */
  roster: readonly RailPlayer[];
  /** This week's matchup-leg starters, player ids ("0" for an empty slot). */
  starterIds: readonly string[];
  /** This week's projection table by player id; null when it could not be read. */
  table: Map<string, WeekProjection> | null;
  /** This week's slate; null when it could not be read. */
  games: readonly WeekLockGame[] | null;
  now: number;
  /** League settings trade_review_days. */
  reviewDays: number;
}

const DAY_MS = 86_400_000;

/** When a trade accepted now would process. */
export function tradeProcessesAt(now: number, reviewDays: number): number {
  return now + Math.max(0, reviewDays) * DAY_MS;
}

/** Kickoff of a team's game this week, or null when the slate has none. */
export function kickoffOf(team: string | null | undefined, games: readonly WeekLockGame[]): number | null {
  if (!team) return null;
  const g = games.find((x) => x.away === team || x.home === team);
  return g && g.startTime > 0 ? g.startTime : null;
}

/** Player ids of ours that a trade may not give away this week. */
export function weekLockedIds(input: WeekLockInput): Set<string> {
  const ids = new Set(input.starterIds.filter((id) => id && id !== "0"));
  const starters = input.roster.filter((p) => p.playerId && ids.has(p.playerId) && !p.onIr);
  const locked = new Set<string>();
  if (!starters.length) return locked;
  // Unknown week: every starter is kept, so every starter is locked.
  if (!input.table || !input.games) {
    for (const s of starters) locked.add(s.playerId!);
    return locked;
  }
  const processAt = tradeProcessesAt(input.now, input.reviewDays);
  const week = weekPointsThisWeek(input.table, input.games, input.now);
  const startable = startableThisWeek(input.table, input.games, processAt);
  const canFill = (body: RailPlayer, starter: RailPlayer): boolean => startable(body, starter);
  const kept = new Set(keptStarters(starters.map((s) => s.name), input.roster, canFill).map((n) => n.toLowerCase()));
  for (const s of starters) {
    const row = input.table.get(s.playerId!);
    // No week points for us: on bye, no game, ruled out, or no row at all.
    // A starter with no row is unknown and kept, as startableThisWeek reads
    // him ("not yet kicked off"): lock him.
    if (row && week.points(s, row.team) <= 0) continue;
    if (!kept.has(s.name.toLowerCase())) continue;
    const kickoff = row ? kickoffOf(row.team, input.games) : null;
    // His game begins before the trade processes: the week's points are ours
    // either way, and he is not locked.
    if (kickoff !== null && kickoff <= processAt) continue;
    locked.add(s.playerId!);
  }
  return locked;
}
