// Is THIS player on waivers right now? Per player, from Sleeper's rules.
//
// Before 2026-09-23 the run asked one question of the whole league ("is the
// waiver window open?") and answered it by whether anybody had a pending claim.
// That was wrong in both directions: on Sunday evening 2026-09-20 J.K. Dobbins,
// whose team played Monday night, was a free add while everyone who had played
// was on waivers; and a league with no claim filed looked "open for free adds"
// on a Tuesday when nobody was. The rule (sleeper/rules.ts playerOnWaivers) is
// per player: dropped inside waiver_clear_days, or his team has kicked off
// since the last waiver run. The write-time fallback in waiver-run stays as the
// last word when this is wrong.

import { playerOnWaivers } from "../sleeper/rules.ts";
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
