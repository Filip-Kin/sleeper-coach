// Keeping the roster legal after a trade completes.
//
// accept_trade takes only a transaction id; the drop-to-fit is a SEPARATE step
// that happens when the trade processes (after the league's trade-review days),
// and nothing here handled it. On 2026-09-04 Filip asked the obvious question:
// when a trade goes through and we are over the 16-man limit, does the coach
// drop the right players and fix the lineup? It did not.
//
// This module is the DECISION half: given a roster that is over capacity, which
// players do we shed. It is pure and tested. The daemon calls it from a
// reconciliation loop that fixes an over-cap roster however it arose (a
// completed trade, a botched manual move), which is more robust than trying to
// bundle the drop into the accept, whose exact mechanics Sleeper does not
// document and we cannot rehearse in staging.

import { type FairnessConfig, DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { cutOrder } from "./value.ts";
import { bestLineup, STARTING_SLOTS } from "./trade.ts";
import { canDrop, type RailPlayer, type RailConfig, DEFAULT_RAILS } from "./rails.ts";

/** Active roster capacity: the starting slots plus the bench. IR (reserve) is a
 *  separate pool and does not count, so an injured player parked on IR frees a
 *  spot without a drop. */
export function activeCapacity(rosterPositions: readonly string[]): number {
  return rosterPositions.length;
}

/** How many players we must drop to be legal, or 0 if we are fine. */
export function overCapBy(activePlayers: number, capacity: number): number {
  return Math.max(0, activePlayers - capacity);
}

export interface ForcedDrop { name: string; cost: number; reason: string }

/** The `count` players to drop to get back under the cap.
 *
 *  THE RULE (Filip, 2026-09-30): a dropped player is gone for the season, so
 *  the cut is the player worth the least for the REST OF THE SEASON, full
 *  stop. `points` on every RailPlayer is that one value (see value.ts). Ties
 *  break on full-season talent, never on list order: the 09-30 cut of Travis
 *  Etienne was a tie at "zero lineup cost" resolved by Sleeper's array order.
 *
 *  What is never cut, whatever the number says: a name in `keep` (this week's
 *  starters, a player we just traded for, the drop side of a pending claim),
 *  the never-drop list, a player on IR, an injured stash, and the only body
 *  for a mandatory slot (a lone kicker or defense; at a full roster we cannot
 *  add a replacement without dropping again). The top-N rail does NOT apply:
 *  the cap forces a drop, the question is only whom. */
export function chooseForcedDrops(
  roster: RailPlayer[], count: number, _cfg: FairnessConfig = DEFAULT_FAIRNESS,
  keep: string[] = [], rails: RailConfig = DEFAULT_RAILS, slots: readonly string[] = STARTING_SLOTS,
): ForcedDrop[] {
  if (count <= 0) return [];
  const keepSet = new Set(keep.map((n) => n.toLowerCase()));
  const forcedRails: RailConfig = { ...rails, protectTopN: 0 };
  const chosen: ForcedDrop[] = [];
  const remaining = roster.slice();
  const candidates = cutOrder(roster
    .filter((p) => !keepSet.has(p.name.toLowerCase()))
    .filter((p) => canDrop(p.name, roster, forcedRails).allowed));
  // A slot already empty before the cut is not the cut's doing: compare the
  // holes after with the holes before, so a roster with no kicker can still
  // shed a fifth receiver.
  const holes = (r: RailPlayer[]): number => bestLineup(r, slots).starters.filter((x) => x.player === null).length;
  for (const c of candidates) {
    if (chosen.length >= count) break;
    const after = remaining.filter((p) => p.name.toLowerCase() !== c.name.toLowerCase());
    const emptiesMandatory = holes(after) > holes(remaining);
    if (emptiesMandatory) continue;
    chosen.push({ name: c.name, cost: c.points, reason: `lowest rest-of-season value that keeps every starting slot filled (${Math.round(c.points)} points left this season)` });
    remaining.splice(remaining.findIndex((p) => p.name.toLowerCase() === c.name.toLowerCase()), 1);
  }
  return chosen;
}
