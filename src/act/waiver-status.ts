// Is THIS player on waivers right now? Per player, from Sleeper's rules.
//
// Before 2026-09-23 the run asked one question of the whole league ("is the
// waiver window open?") and answered it by whether anybody had a pending claim.
// That was wrong in both directions: on Sunday evening 2026-09-20 J.K. Dobbins,
// whose team played Monday night, was a free add while everyone who had played
// was on waivers; and a league with no claim filed looked "open for free adds"
// on a Tuesday when nobody was. The rule (sleeper/rules.ts playerOnWaivers) is
// per player: dropped inside waiver_clear_days, or his team has kicked off
// since the last waiver run, or his team had its bye since then (the bye
// week's first kickoff counts as his team's; 2026-10-13, Butker). The
// write-time fallback in waiver-run stays as the last word when this is wrong.
//
// "Since the last waiver run" spans two NFL weeks. The run is Wednesday 03:00
// ET and the week rolls on Tuesday, so on a Tuesday the kickoffs that put a
// player on waivers are LAST week's. Until 2026-10-06 the kickoffs came from
// the pick'em cache, which holds the current week only: every Tuesday the
// whole league read as free agents, the claim job (--claims-only) had nothing
// to claim, and the free-agent job (--adds-only) asked Sleeper for an add it
// refuses, with no fallback, because the two jobs are split. The write-time
// fallback only exists in a combined run. recentTeamKickoffs reads both
// weeks from the schedule itself.

import { playerOnWaivers, legsToScan } from "../sleeper/rules.ts";
import { lastOccurrence, type Job } from "../schedule.ts";

/** Sleeper processes this league's waivers Wednesday around 03:00 ET. The most
 *  recent processing at or before `now`. */
const WAIVER_RUN: Job = { name: "waiver-clear", dow: 3, hour: 3, minute: 0, maxLateMs: 0, why: "Sleeper's weekly waiver processing" };
export function lastWaiverRunAt(now: number, zone = "America/New_York"): number {
  return lastOccurrence(WAIVER_RUN, now, zone) ?? now - 7 * 86_400_000;
}

/** player_id -> when he was last dropped, from the REST transactions of the
 *  legs scanned. status_updated is when the drop processed; created is the
 *  fallback. */
export function droppedAtFromTransactions(
  txns: { drops?: Record<string, number> | null; created?: number; status_updated?: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of txns) {
    const at = Number(tx.status_updated ?? tx.created ?? 0);
    if (!at) continue;
    for (const id of Object.keys(tx.drops ?? {})) {
      if ((out.get(id) ?? 0) < at) out.set(id, at);
    }
  }
  return out;
}

/** A game as the waiver rule needs it (sleeper/graphql.ts weekSchedule). */
export interface ScheduledGame { away: string; home: string; startTime: number }

/** Team -> its most recent kickoff at or before `now`, over whatever weeks the
 *  games span. That one instant is what playerOnWaivers compares with the last
 *  waiver run: a later game that has not started yet says nothing. Pure. */
export function lastKickoffByTeam(games: ScheduledGame[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of games) {
    const t = Number(g.startTime);
    if (!Number.isFinite(t) || t <= 0 || t > now) continue;
    for (const team of [g.away, g.home]) {
      if (team && (out.get(team) ?? 0) < t) out.set(team, t);
    }
  }
  return out;
}

/** Every team's latest waiver instant since before the last waiver run: the
 *  current NFL week's schedule and the one before it (the run is weekly, so
 *  two weeks always cover it). `week` is the NFL week NOW, never a planning
 *  week.
 *
 *  A team with NO game in a week (its bye) is on waivers from that week's
 *  first kickoff: see waiverInstantsByTeam.
 *
 *  A week that cannot be read, or reads empty, throws. "Unknown" must not
 *  become "nobody has kicked off": that is the defect this replaced. The run
 *  dies before its write gate, so a scheduled job gets its two quick retries
 *  (daemon runJob) and then counts as failed for that occurrence; a confirm
 *  run keeps its intent; a drop reaction leaves the drop unreacted.
 *
 *  The regular season has 18 weeks. Past it the feed is empty, and the last
 *  two real weeks are the right answer to "who kicked off recently" anyway. */
export const LAST_SCHEDULE_WEEK = 18;
export async function recentTeamKickoffs(
  week: number, now: number, fetchWeek: (week: number) => Promise<ScheduledGame[]>,
): Promise<Map<string, number>> {
  const slates: ScheduledGame[][] = [];
  for (const w of legsToScan(Math.min(week, LAST_SCHEDULE_WEEK))) {
    const slate = await fetchWeek(w);
    if (!slate.length) throw new Error(`no games in the schedule for week ${w}; waiver status unknown`);
    slates.push(slate);
  }
  return waiverInstantsByTeam(slates, now);
}

/** Team -> the latest instant its unrostered players went on waivers, at or
 *  before `now`, over the weeks given (one slate per week): its own kickoff
 *  (lastKickoffByTeam), or, in a week it has no game, that week's FIRST
 *  kickoff. Pure.
 *
 *  2026-10-13, a Tuesday: Harrison Butker (KC, bye in week 5, never dropped)
 *  was planned as the free-add streamer for Jake Bates's week-6 bye, the
 *  confirming run asked Sleeper, and Sleeper refused: "At least one of the
 *  players being added in is on waivers." The kickoff rule read him as a
 *  free agent because nothing of his had kicked off since the last waiver
 *  run. Sleeper holds a bye team's players on waivers too, until the run;
 *  the exact instant inside the bye week it starts is not documented and
 *  has only been seen from the Tuesday after, so the earliest candidate,
 *  the week's first kickoff, is taken: the worst a too-early "on waivers"
 *  costs is a free add of a bye-week player delayed to Wednesday (a claim is
 *  filed on Tuesday only, when he is on waivers either way), while a
 *  too-late one is this incident again.
 *
 *  The set of teams is the union over the slates: every team plays in at
 *  least one of two consecutive weeks (byes are never consecutive), so a team
 *  absent from a slate is on bye that week, not missing from the feed. A
 *  single slate (week 1) has no byes, so nothing is absent. */
export function waiverInstantsByTeam(slates: ScheduledGame[][], now: number): Map<string, number> {
  const out = lastKickoffByTeam(slates.flat(), now);
  const teams = new Set<string>();
  for (const slate of slates) for (const g of slate) for (const team of [g.away, g.home]) if (team) teams.add(team);
  for (const slate of slates) {
    const playing = new Set<string>();
    let first = Infinity;
    for (const g of slate) {
      for (const team of [g.away, g.home]) if (team) playing.add(team);
      const t = Number(g.startTime);
      if (Number.isFinite(t) && t > 0 && t < first) first = t;
    }
    if (!Number.isFinite(first) || first > now) continue;
    for (const team of teams) {
      if (playing.has(team)) continue;
      if ((out.get(team) ?? 0) < first) out.set(team, first);
    }
  }
  return out;
}

export function onWaiversNow(args: {
  playerId: string; team: string | null | undefined;
  droppedAt: Map<string, number>; kickoffs: Map<string, number>; now: number; clearDays: number;
}): boolean {
  const { playerId, team, droppedAt, kickoffs, now, clearDays } = args;
  return playerOnWaivers({
    droppedAt: droppedAt.get(playerId) ?? null,
    teamKickoff: team ? kickoffs.get(team) ?? null : null,
    now,
    lastWaiverRunAt: lastWaiverRunAt(now),
    clearDays,
  });
}
