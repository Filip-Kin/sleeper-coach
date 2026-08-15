import type { Position } from "../sleeper/types.ts";

// Weak-prior draft tendencies of known human managers, keyed by lowercased
// Sleeper username. Observed from a single mock draft on 2026-08-15 (see the
// project-sleeper-draft-opponents memory), so treat them as a nudge, not truth.
//
// These feed ONLY the VONA opponent survival shave (analysis/vona.ts): when a
// leaned manager picks in the gap before our next turn, we shave the survival
// probability of the position(s) they favour. Bounded by VONA_OPP_NUDGE and
// never able to override a clear value pick. The `lean` weight is 0..1 =
// how strongly they draft that position relative to the field.
export interface OppLean {
  lean: Partial<Record<Position, number>>;
  note: string;
}

export const OPPONENT_PROFILES: Record<string, OppLean> = {
  // RB-anchor, late-QB committee: hammers elite/veteran RBs early.
  kronos27: { lean: { RB: 0.6 }, note: "RB-anchor, late-QB committee" },
  // Elite RB plus an elite TE unusually early (McBride in the 3rd), RB depth.
  owenm1515: { lean: { RB: 0.6, TE: 0.8 }, note: "elite RB + elite TE early" },
  // Takes his QB1 early (Allen R3) and hoards tight ends (3 of them).
  cookieeater45: { lean: { QB: 0.7, TE: 0.7 }, note: "early QB, TE hoarder" },
};

// Aggregate positional demand from a list of usernames picking before our next
// turn. Caps each position at 1.0 so a run of the same lean can't overwhelm the
// (already bounded) survival shave. Unknown managers contribute nothing.
export function gapDemandFor(usernames: string[]): Partial<Record<Position, number>> {
  const out: Partial<Record<Position, number>> = {};
  for (const u of usernames) {
    const prof = OPPONENT_PROFILES[u.toLowerCase()];
    if (!prof) continue;
    for (const [pos, w] of Object.entries(prof.lean)) {
      const key = pos as Position;
      out[key] = Math.min(1, (out[key] ?? 0) + (w ?? 0));
    }
  }
  return out;
}
