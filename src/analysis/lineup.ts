import type { Position } from "../sleeper/types.ts";

// The optimal starting-lineup solver.
//
// Picking the best lineup is an assignment problem, and the naive "sort everyone
// by projection and fill top down" is wrong: it can strand a required slot (fill
// both FLEX with your best RB and WR, then have no one left the QB slot will
// take). But greedy IS optimal here, provided slots are filled from MOST
// restrictive to LEAST restrictive, because every dedicated slot's eligibility
// set is a strict subset of FLEX's. Fill QB, K, DEF, TE, then the RB slots, then
// the WR slots, then the FLEX slots from whatever RB/WR/TE remains. Within each
// slot, take the highest projection among players not already assigned.
//
// Why the subtlety that looks like a problem is not one: if your two tight ends
// are one elite and one mediocre, it makes no difference whether the elite one
// sits in the TE slot or a FLEX slot. The same two players start either way and
// the total is identical. Ordering by restrictiveness handles it.
//
// BEFORE any of that, zero out anyone who cannot play: OUT, on IR, on bye, or
// confirmed inactive. Starting a player who is not playing is the single most
// expensive avoidable mistake in fantasy, so it is done first and unconditionally
// rather than left to a low projection to handle.

export interface LineupPlayer {
  playerId: string;
  name: string;
  position: Position;
  points: number; // this week's projection under league scoring
  injuryStatus?: string | null; // Sleeper injury_status
  onBye?: boolean; // team is on bye this week
  inactive?: boolean; // confirmed inactive / not playing (e.g. late scratch)
}

// Which positions each starting slot will accept. FLEX is the only multi-position
// slot in this league; the rest are their own position. Kept as data so the
// solver generalises to any roster_positions the league might use.
export const SLOT_ELIGIBILITY: Record<string, Set<Position>> = {
  QB: new Set(["QB"]),
  RB: new Set(["RB"]),
  WR: new Set(["WR"]),
  TE: new Set(["TE"]),
  K: new Set(["K"]),
  DEF: new Set(["DEF"]),
  FLEX: new Set(["RB", "WR", "TE"]),
  // Declared for completeness in case the league ever adds them; unused today.
  SUPER_FLEX: new Set(["QB", "RB", "WR", "TE"]),
  WRRB_FLEX: new Set(["RB", "WR"]),
  REC_FLEX: new Set(["WR", "TE"]),
};

// Injury statuses that mean the player is NOT going to play this week. "IR" and
// "PUP"/"NA"/"Sus"/"DNR" are roster-reserve states; "Out" and "Doubtful" are
// weekly game statuses. "Questionable" is deliberately NOT here: a Q player
// usually plays, and benching every Q would gut a lineup (Sleeper blanket-tags
// half the league Questionable, which is exactly the trap the draft news layer's
// `soft` status was built to survive).
const NON_PLAYING_STATUS = new Set(["OUT", "DOUBTFUL", "IR", "PUP", "NA", "SUS", "DNR", "COV"]);

export interface Availability {
  available: boolean;
  reason: string; // why not, when unavailable; "" when available
}

// A player is unavailable if we have positive evidence he will not play. This is
// intentionally conservative: only clear signals bench a player, because a false
// "unavailable" leaves a real starter on the bench for no reason.
export function availabilityOf(p: LineupPlayer): Availability {
  if (p.inactive) return { available: false, reason: "confirmed inactive" };
  if (p.onBye) return { available: false, reason: "on bye" };
  const s = (p.injuryStatus ?? "").trim().toUpperCase();
  if (s && NON_PLAYING_STATUS.has(s)) return { available: false, reason: `injury status ${p.injuryStatus}` };
  return { available: true, reason: "" };
}

export interface SlotAssignment {
  slot: string; // e.g. "QB", "FLEX"
  player: LineupPlayer | null; // null when nothing eligible was available to fill it
}

export interface Lineup {
  slots: SlotAssignment[]; // in the league's roster_positions order
  starters: LineupPlayer[]; // the players actually started, slot order
  bench: LineupPlayer[]; // everyone not started (available or not)
  total: number; // projected points of the started players
  unfilled: string[]; // slots left empty for want of an eligible available player
  excluded: { player: LineupPlayer; reason: string }[]; // zeroed out before solving
}

// Order slots most-restrictive-first: fewest eligible positions first, FLEX-like
// slots last. This is the property that makes greedy optimal (see the file
// header). A stable secondary key keeps a deterministic order among slots of
// equal restrictiveness.
function restrictivenessOrder(slots: string[]): number[] {
  return slots
    .map((slot, index) => ({ slot, index, width: SLOT_ELIGIBILITY[slot]?.size ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.width - b.width || a.index - b.index)
    .map((s) => s.index);
}

// Solve the optimal starting lineup for `startingSlots` (the league's
// roster_positions with BN/IR removed), given every rosterable player and this
// week's projections already attached.
export function solveLineup(players: LineupPlayer[], startingSlots: string[]): Lineup {
  // 1. Zero out anyone who cannot play, FIRST. They are never candidates.
  const excluded: { player: LineupPlayer; reason: string }[] = [];
  const eligible: LineupPlayer[] = [];
  for (const p of players) {
    const a = availabilityOf(p);
    if (a.available) eligible.push(p);
    else excluded.push({ player: p, reason: a.reason });
  }

  // 2. Fill slots most-restrictive-first. Within a slot, take the highest
  //    projection among unassigned eligible players the slot accepts.
  const assignments: (LineupPlayer | null)[] = new Array(startingSlots.length).fill(null);
  const used = new Set<string>();
  const pool = eligible.slice().sort((a, b) => b.points - a.points); // best first, once

  for (const slotIdx of restrictivenessOrder(startingSlots)) {
    const accept = SLOT_ELIGIBILITY[startingSlots[slotIdx]!];
    if (!accept) continue; // unknown slot type: leave unfilled rather than guess
    const pick = pool.find((p) => !used.has(p.playerId) && accept.has(p.position));
    if (pick) {
      assignments[slotIdx] = pick;
      used.add(pick.playerId);
    }
  }

  // 3. Assemble the result in original slot order.
  const slots: SlotAssignment[] = startingSlots.map((slot, i) => ({ slot, player: assignments[i] ?? null }));
  const starters = assignments.filter((p): p is LineupPlayer => p !== null);
  const startedIds = new Set(starters.map((p) => p.playerId));
  const bench = players.filter((p) => !startedIds.has(p.playerId));
  const total = Math.round(starters.reduce((s, p) => s + p.points, 0) * 100) / 100;
  const unfilled = slots.filter((s) => s.player === null).map((s) => s.slot);

  return { slots, starters, bench, total, unfilled, excluded };
}

// The list of starting slot labels in a league's roster_positions, BN and IR
// dropped. This is the order setLineup expects the player ids in.
export function startingSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter((slot) => slot !== "BN" && slot !== "IR" && slot !== "TAXI");
}

// Map a solved lineup to the ordered player-id array setLineup expects: one id
// per starting slot, in roster_positions order. Throws on any unfilled slot,
// because setLineup cannot start an empty slot and a half-filled lineup must
// fail loudly rather than silently drop a starter. An unfilled slot in-season is
// a real problem (not enough healthy bodies at a position) that needs a human.
export function starterIds(lineup: Lineup): string[] {
  const ids: string[] = [];
  for (const s of lineup.slots) {
    if (!s.player) throw new Error(`lineup has no player for the ${s.slot} slot; refusing to set a partial lineup`);
    ids.push(s.player.playerId);
  }
  return ids;
}
