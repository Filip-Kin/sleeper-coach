// Choosing forced drops from the roster the cap actually counts.
//
// The audit of 2026-09-23 found reconcileRoster handing chooseForcedDrops the
// droppable() SUBSET: the handful of bodies outside the protected top twelve.
// chooseForcedDrops solves a lineup over whatever it is given, and a lineup
// built from four fringe players has an empty QB slot, so every candidate
// "would empty a mandatory slot", the function returned [], and the daemon
// alerted "cannot auto-fix" once a poll for an over-cap roster it could have
// fixed with one drop. The rule now: the solver sees the FULL active roster,
// and droppable() is the post-check on what it chose.

import { droppable, type RosterView } from "./roster-view.ts";
import { chooseForcedDrops, type ForcedDrop } from "./roster-fit.ts";
import type { FairnessConfig } from "./trade-fair.ts";
import { DEFAULT_RAILS, type RailConfig, type RailPlayer } from "./rails.ts";

export interface LegalDrop extends ForcedDrop { playerId: string }

/** The active roster as RailPlayers, matched by id against the view. A man on
 *  IR is excluded structurally (he is not active), and every entry is marked
 *  active so a stale onIr flag from the source cannot leak in. */
export function activeRailRoster(view: RosterView, railRoster: RailPlayer[]): RailPlayer[] {
  return railRoster
    .filter((p) => (p.playerId ? view.activeIds.has(p.playerId) : !p.onIr))
    .map((p) => ({ ...p, onIr: false }));
}

/** `count` drops chosen over the full active roster, every one of which passes
 *  droppable(). When the solver picks a name the rails protect (a backup QB
 *  whose season points rank him in the top twelve but whose removal costs
 *  nothing), that name is pinned as a keep and the solver runs again, so a
 *  legal answer is found whenever one exists. Fewer than `count` means the
 *  rails leave no legal way, and the caller alerts a human. */
export function chooseLegalForcedDrops(
  view: RosterView, full: RailPlayer[], count: number, cfg: FairnessConfig, rails: RailConfig = DEFAULT_RAILS,
): LegalDrop[] {
  if (count <= 0) return [];
  const allowed = new Map<string, string>();
  for (const p of droppable(view, full, rails)) allowed.set(p.name.toLowerCase(), p.playerId ?? "");
  const keep: string[] = [];
  for (let attempt = 0; attempt <= full.length; attempt++) {
    const drops = chooseForcedDrops(full, count, cfg, keep, rails);
    const bad = drops.filter((d) => !allowed.has(d.name.toLowerCase()));
    if (!bad.length) {
      return drops
        .map((d) => ({ ...d, playerId: allowed.get(d.name.toLowerCase()) ?? "" }))
        .filter((d) => d.playerId !== "");
    }
    keep.push(...bad.map((d) => d.name));
  }
  return [];
}
