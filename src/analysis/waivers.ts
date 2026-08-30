import { chooseDrop, DEFAULT_RAILS, type RailPlayer, type RailConfig } from "./rails.ts";
import { solveLineup, type LineupPlayer } from "./lineup.ts";

// The waiver engine, priced in WAIVER PRIORITY, not dollars.
//
// This league is ROLLING WAIVER PRIORITY (waiver_type 0), NOT FAAB. The stored
// waiver_budget of 100 is a Sleeper default that is never used. There is no
// bidding and no budget to pace. Instead we hold a position in a queue, and a
// SUCCESSFUL claim sends us to the BACK of it. So the question on every claim is
// not "what is he worth" but "is he worth going LAST for weeks". That argues for
// claiming rarely and decisively: a genuine starter or a real upside play, never
// a streaming defence you could pick up as a free agent anyway. A player who has
// already CLEARED waivers is a free agent and costs nothing, so a costless add
// is always preferred to a claim for the same player.
//
// Every drop this engine proposes goes through the rails in rails.ts. It never
// picks a drop target itself: chooseDrop only ever returns a player canDrop
// allows, so the strongest rail — never cut a player who is injured but
// projected back before the week 16 playoffs, who looks worthless to a weekly
// number and is exactly the one you must not drop — cannot be routed around,
// including on the "roster is full, must drop someone" path.

export interface WaiverConfig {
  rails: RailConfig;
  // Rest-of-season margin (points) required before BURNING waiver priority on a
  // claim. Deliberately much higher than the rails' costless-add margin: going
  // to the back of the queue is only worth it for a real difference.
  claimMarginPts: number;
  // A claim is only worth a priority burn if the incoming player would actually
  // START for us. A bench/handcuff upgrade never justifies going last; wait and
  // free-add him once he clears. Set false to allow claiming bench depth too.
  claimMustStart: boolean;
}

export const DEFAULT_WAIVERS: WaiverConfig = {
  rails: DEFAULT_RAILS,
  claimMarginPts: 15, // ROS points; a genuine multi-week difference, not a streamer
  claimMustStart: true,
};

// A player available to add. `onWaivers` is the pricing switch: true means a
// claim would burn our queue position; false means he has cleared and is a
// costless free-agent add.
export interface AvailablePlayer extends RailPlayer {
  onWaivers: boolean;
  rosteredPct?: number; // Sleeper rostered %, a scarcity signal for ranking
}

// The current roster state the drop-path resolver needs. "Prefer paths that drop
// nobody" (the plan): an empty bench slot first, then an IR slot for a genuinely
// injured incumbent (which opens a bench slot without a drop), and only then a
// straight drop.
export interface RosterState {
  roster: RailPlayer[];
  openBenchSlots: number; // empty BN slots right now
  openIrSlots: number; // empty IR slots right now
  startingSlots: string[]; // roster_positions with BN/IR removed, for the "would he start" test
}

export type MoveKind = "free-add" | "waiver-claim" | "wait" | "skip";
export type DropPath = "bench-slot" | "ir-stash" | "drop" | "none";

export interface WaiverMove {
  kind: MoveKind;
  add: string;
  position: string;
  onWaivers: boolean;
  drop: string | null; // full name of the player dropped; null when a slot absorbs the add
  dropPath: DropPath;
  gainPts: number; // ROS points the add clears the player it replaces (or the worst starter, for a slot add)
  startsForUs: boolean; // would the add crack our optimal ROS starting lineup
  priorityWorthy: boolean; // clears the bar to burn a queue position
  reason: string;
}

function asLineup(p: RailPlayer): LineupPlayer {
  return { playerId: p.name, name: p.name, position: p.position, points: p.points, injuryStatus: p.injuryStatus };
}

// The true value of a transaction, measured on the STARTING LINEUP: how many ROS
// points our optimal starting lineup gains by making this add (and its drop, if
// any). This is the number the rolling-priority decision must use, NOT the gap
// to whatever fringe body we cut. A streaming kicker who beats our benched
// backup QB by 50 points but only lifts the lineup by 8 is an 8-point add, and
// pricing it any other way is exactly the capped-position trap from draft night:
// cross-position gaps are not costs, only lineup deltas are.
//
// Baseline is the current roster's starting total. Result is the starting total
// of (roster minus the drop, plus the incoming). So dropping a starter correctly
// shrinks the gain, and dropping a bench body correctly costs nothing.
function lineupDelta(
  incoming: AvailablePlayer,
  dropName: string | null,
  state: RosterState,
): { gain: number; starts: boolean } {
  const baseline = solveLineup(state.roster.map(asLineup), state.startingSlots).total;
  const kept = state.roster.filter((p) => p.name !== dropName).map(asLineup);
  const after = solveLineup([...kept, asLineup(incoming)], state.startingSlots);
  const starts = after.starters.some((s) => s.playerId === incoming.name);
  return { gain: Math.round((after.total - baseline) * 10) / 10, starts };
}

// Resolve the cheapest drop path for one add, in the plan's order. Returns the
// drop target (or null for a costless slot add) and never violates the rails.
function resolveDropPath(
  incoming: AvailablePlayer,
  state: RosterState,
  cfg: WaiverConfig,
): { path: DropPath; drop: string | null; reason: string } | null {
  // 1. An empty bench slot: no drop at all.
  if (state.openBenchSlots > 0) {
    return { path: "bench-slot", drop: null, reason: "into an open bench slot (no drop)" };
  }
  // 2. An IR slot with a genuinely injured incumbent to stash: opens a bench
  //    slot without dropping anyone. The stash-worthy player is exactly the one
  //    the rails protect, so this is where he belongs, not on the drop table.
  const irStashable = state.roster.find(
    (p) => (p.returnsBeforePlayoffs || isReserveInjury(p.injuryStatus)) && !cfg.rails.neverDrop?.includes(p.name),
  );
  if (state.openIrSlots > 0 && irStashable) {
    return {
      path: "ir-stash",
      drop: null,
      reason: `stash ${irStashable.name} (injured) on IR to open a bench slot (no drop)`,
    };
  }
  // 3. A straight drop, chosen ONLY through the rails. chooseDrop returns the
  //    worst LEGAL drop that the add clears by the upgrade margin, or null.
  const chosen = chooseDrop(incoming, state.roster, cfg.rails);
  if (chosen) {
    return { path: "drop", drop: chosen.name, reason: chosen.reason };
  }
  return null; // no legal, worthwhile path
}

// Reserve-eligible injury states: a player in one of these can legitimately go
// to IR, freeing a bench slot. "Questionable"/"Doubtful" are weekly game states,
// not reserve states, so they are excluded.
function isReserveInjury(status?: string | null): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "IR" || s === "PUP" || s === "NA" || s === "SUS" || s === "DNR" || s === "COV";
}

// Plan a single available player into a decisive move.
export function planOne(incoming: AvailablePlayer, state: RosterState, cfg: WaiverConfig = DEFAULT_WAIVERS): WaiverMove {
  const base = {
    add: incoming.name,
    position: incoming.position,
    onWaivers: incoming.onWaivers,
  };

  const path = resolveDropPath(incoming, state, cfg);
  if (!path) {
    return {
      ...base, kind: "skip", drop: null, dropPath: "none", gainPts: 0, startsForUs: false, priorityWorthy: false,
      reason: "no rails-legal add: not a clear enough upgrade over any droppable player",
    };
  }

  // The drop path already passed the rails' upgrade margin (chooseDrop enforces
  // that a drop is justified). Pricing, though, is on the STARTING-LINEUP delta,
  // not the gap to the dropped body: that is the number that answers "is he
  // worth going last for".
  const { gain, starts } = lineupDelta(incoming, path.drop, state);

  // Pricing on rolling priority.
  if (!incoming.onWaivers) {
    // Cleared: costless. Take any rails-legal add.
    return {
      ...base, kind: "free-add", drop: path.drop, dropPath: path.path, gainPts: gain, startsForUs: starts,
      priorityWorthy: false,
      reason: `free agent, costless add — ${path.reason}${starts ? "; starts for us (+" + gain + " ROS to the lineup)" : "; bench depth"}`,
    };
  }

  // On waivers: burning a queue position. The bar is high, and it is on the
  // lineup improvement, not on who we drop.
  const bigEnough = gain >= cfg.claimMarginPts;
  const startsOk = starts || !cfg.claimMustStart;
  const priorityWorthy = bigEnough && startsOk;
  if (priorityWorthy) {
    return {
      ...base, kind: "waiver-claim", drop: path.drop, dropPath: path.path, gainPts: gain, startsForUs: starts,
      priorityWorthy: true,
      reason: `worth a priority burn: +${gain} ROS to the starting lineup${starts ? " (he starts)" : ""} — ${path.reason}`,
    };
  }
  // Not worth going last: wait for him to clear, then free-add for nothing.
  const why = !bigEnough
    ? `only +${gain} ROS to the lineup, under the ${cfg.claimMarginPts}pt claim bar`
    : "would not start for us";
  return {
    ...base, kind: "wait", drop: path.drop, dropPath: path.path, gainPts: gain, startsForUs: starts,
    priorityWorthy: false,
    reason: `do NOT claim (${why}); wait for him to clear waivers and free-add at no priority cost`,
  };
}

// Plan the whole waiver board: evaluate every available player, drop the skips,
// and rank the actionable moves. Free costless adds first (do them regardless),
// then priority-worthy claims by gain, then the "wait" notes. This ordering
// reflects the plan: prefer costless adds, claim rarely and decisively.
export function planWaivers(
  available: AvailablePlayer[],
  state: RosterState,
  cfg: WaiverConfig = DEFAULT_WAIVERS,
): WaiverMove[] {
  const moves = available.map((p) => planOne(p, state, cfg)).filter((m) => m.kind !== "skip");
  const rank: Record<MoveKind, number> = { "free-add": 0, "waiver-claim": 1, wait: 2, skip: 3 };
  return moves.sort((a, b) => rank[a.kind] - rank[b.kind] || b.gainPts - a.gainPts);
}

// The single most decisive move for this cycle. Because a successful claim sends
// us to the back of the queue, we submit AT MOST ONE claim per waiver run (the
// best one). Costless free-agent adds are unlimited and separate. This returns
// the one claim to submit, if any is worth it.
export function bestClaim(moves: WaiverMove[]): WaiverMove | null {
  return moves.find((m) => m.kind === "waiver-claim") ?? null;
}
