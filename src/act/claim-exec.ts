// Filing one waiver claim: the two looks, the IR move when the claim goes
// through an IR slot, then the claim itself.
//
// The planner (analysis/waivers.ts) can answer "claim him, park Travis
// Etienne on IR, drop nobody". Until 2026-10-02 the claim block of
// waiver-run.ts handled only "claim him, drop X": a stash claim was filed
// with no drop and nobody was moved, so it sat pending against a full roster
// and was lost when waivers processed. It also skipped the two looks,
// because a move with no drop was taken to cost nobody. The free-add loop
// had done the IR move first since 2026-09-19; the claim never did.
//
// Pure of Sleeper: the writes are injected, so the order is tested.

import type { WaiverMove } from "../analysis/waivers.ts";

type ClaimMove = Pick<WaiverMove, "add" | "drop" | "dropPath" | "irStash">;

/** What a move costs the roster, as the two-looks key spells it: the player
 *  dropped, or the player parked on IR (he comes back, and then somebody
 *  makes room: a deferred drop). Null when an open slot absorbs the add,
 *  however the slot arose (Filip, 2026-10-06: an IR slot is a roster
 *  expansion; the return is priced on the way in, waivers.ts). */
export function moveCost(m: Pick<WaiverMove, "drop" | "dropPath" | "irStash">): string | null {
  if (m.drop) return m.drop;
  if (m.dropPath === "ir-stash") return `stash ${m.irStash ?? "?"}`;
  return null;
}

export interface ClaimDeps {
  /** May an IR move be made at all right now? False while a game is in
   *  progress (Sleeper locks reserve). Asked BEFORE the two looks, so a
   *  held claim keeps its recorded look and goes through on the first run
   *  that can write.
   *
   *  More than one claim of ours may be pending (Filip, 2026-10-06: two
   *  injured players, two pickups). The planner counts a pending add as
   *  ours (RailPlayer.claimAdd) and holds his seat, so a second claim
   *  measures its gain against a roster with the first one landed and
   *  cannot name the first one's drop (railsWithPendingDrops). Until
   *  2026-10-06 a pending claim held every later claim. */
  stashReady: () => Promise<boolean>;
  /** The two looks (drop-intent.ts). True when this run may write. */
  confirmed: (kind: string, add: string, cost: string | null) => boolean;
  /** Move exactly the named player to IR and read it back. False when no
   *  slot was freed. Never a different player: the looks confirmed this one. */
  stash: (name: string) => Promise<boolean>;
  submit: (add: string, drop: string | null) => Promise<{ transactionId: string; status: string }>;
  /** Put the stashed player back on the active roster: the claim was refused,
   *  so his slot is his again and nothing is left half done. */
  undoStash: (name: string) => Promise<void>;
}

export type ClaimOutcome =
  | { status: "filed"; transactionId: string; submitStatus: string }
  | { status: "waiting" } // first look recorded, or inside the confirmation window
  | { status: "held" }; // the IR slot cannot be freed now: nothing written, nothing filed

export async function fileClaim(claim: ClaimMove, deps: ClaimDeps): Promise<ClaimOutcome> {
  const viaStash = claim.dropPath === "ir-stash";
  // No slot, no claim: it would be refused at processing and the player lost.
  if (viaStash && (!claim.irStash || !(await deps.stashReady()))) return { status: "held" };
  if (!deps.confirmed("claim", claim.add, moveCost(claim))) return { status: "waiting" };
  if (viaStash && !(await deps.stash(claim.irStash!))) return { status: "held" };
  try {
    const res = await deps.submit(claim.add, claim.drop);
    return { status: "filed", transactionId: res.transactionId, submitStatus: res.status };
  } catch (err) {
    if (viaStash) await deps.undoStash(claim.irStash!);
    throw err;
  }
}
