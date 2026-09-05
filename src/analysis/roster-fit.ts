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

import { byeAwareLineupTotal, depthInsurance, type FairnessConfig, DEFAULT_FAIRNESS } from "./trade-fair.ts";
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

/** What our team loses if this player leaves: the fall in bye-aware starting
 *  value plus injury cover. This is the right currency, not raw projection: a
 *  backup QB has a big projection and near-zero removal cost, and is exactly who
 *  should go first, while a thin-position backup with a small projection can be
 *  costly to lose. */
export function removalCost(
  name: string, roster: RailPlayer[], cfg: FairnessConfig = DEFAULT_FAIRNESS,
): number {
  const weeks = cfg.upcomingWeeks ?? [];
  const without = roster.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  const lineupBefore = byeAwareLineupTotal(roster as never, weeks);
  const lineupAfter = byeAwareLineupTotal(without as never, weeks);
  const depthBefore = depthInsurance(roster as never, cfg);
  const depthAfter = depthInsurance(without as never, cfg);
  return Math.round(((lineupBefore - lineupAfter) + (depthBefore - depthAfter)) * 10) / 10;
}

export interface ForcedDrop { name: string; cost: number; reason: string }

/** The `count` players to drop to get back under the cap: the cheapest-to-lose
 *  droppable players. Rails still bind (never-drop, and an injured stash whose
 *  projection understates him), because the whole point of protecting a stash is
 *  that a roster-crunch is exactly when a naive model would cut him. If the rails
 *  leave fewer than `count` droppable players, it returns what it can and the
 *  caller must alert: refusing to overrun a hard protection is correct even when
 *  it means the roster cannot be made legal automatically.
 *
 *  `keep` is the set just acquired in the trade: never drop what we just traded
 *  for, whatever its projection. */
export function chooseForcedDrops(
  roster: RailPlayer[], count: number, cfg: FairnessConfig = DEFAULT_FAIRNESS,
  keep: string[] = [], rails: RailConfig = DEFAULT_RAILS,
): ForcedDrop[] {
  if (count <= 0) return [];
  const keepSet = new Set(keep.map((n) => n.toLowerCase()));
  // protectTopN must NOT apply here: we are not deciding WHETHER to drop, the
  // cap forces that, only WHOM, so the "do not drop a top player for a streamer"
  // guard would wrongly block the only legal choices. never-drop and stash stay.
  const forcedRails: RailConfig = { ...rails, protectTopN: 0 };
  // Pick greedily by cheapest cost, but NEVER take a drop that would leave a
  // mandatory starting slot with nobody to fill it. At a full roster we cannot
  // add a replacement without dropping again, so emptying our only kicker or
  // defense is a permanent hole, not a streamable one, and removalCost does not
  // know that (its replacement floor assumes we can stream). Re-check against
  // the CURRENT working roster each pick, since each drop changes what is left.
  const chosen: ForcedDrop[] = [];
  const remaining = roster.slice();
  const candidates = roster
    .filter((p) => !keepSet.has(p.name.toLowerCase()))
    .filter((p) => canDrop(p.name, roster, forcedRails).allowed)
    .map((p) => ({ name: p.name, cost: removalCost(p.name, roster, cfg) }))
    .sort((a, b) => a.cost - b.cost);

  for (const c of candidates) {
    if (chosen.length >= count) break;
    const after = remaining.filter((p) => p.name.toLowerCase() !== c.name.toLowerCase());
    const emptiesMandatory = bestLineup(after, STARTING_SLOTS).starters.some((x) => x.player === null);
    if (emptiesMandatory) continue; // would leave a starting slot unfillable
    chosen.push({ name: c.name, cost: c.cost, reason: `cheapest to lose without emptying a starting slot (${c.cost} team points)` });
    remaining.splice(remaining.findIndex((p) => p.name.toLowerCase() === c.name.toLowerCase()), 1);
  }
  return chosen;
}
