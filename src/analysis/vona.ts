import type { RankedPlayer } from "./vor.ts";
import type { Position } from "../sleeper/types.ts";

// VONA — Value Over Next Available.
//
// VOR (vor.ts) answers "who is the best player" against a static replacement
// baseline. It does not answer the question that actually decides a snake pick:
// "given who I can still get when the pick comes back to me, who should I take
// NOW?" Two players can have similar value, but if one position will be picked
// clean before my next turn and the other is deep, the scarce one is worth more
// to draft here even at slightly lower raw value.
//
// VONA makes that explicit. For each available player we estimate the chance he
// survives to our NEXT pick, then the expected value of the best player still
// available at his position at that point. A player's VONA is his value now
// minus that expectation — the value we would forfeit by waiting. We draft the
// biggest drop-off. This is board-state driven: opponent tendencies enter only
// as a small, capped survival shave (a weak prior), never a hard rule.
//
// Currency throughout is VOR (points above positional replacement), so "now"
// and "later" are compared in the same units.

export interface VonaContext {
  // Our next overall pick number after the one we're making now (snake gap).
  nextPickNo: number;
  // Logistic scale for ADP uncertainty. Larger = humbler (players go over a
  // wider window around their ADP), which flattens survival toward 0.5.
  adpSpread: number;
  // Optional weak prior: extra positional demand from opponents picking in the
  // gap before our next turn, 0..1 per position. Shaves that position's
  // survival probability. Empty/undefined = no opponent effect.
  gapDemand?: Partial<Record<Position, number>>;
  // Maximum survival probability shaved by a fully-leaned opponent position.
  // 0 disables the opponent prior entirely (pure board-state VONA).
  oppNudge?: number;
}

export interface VonaPlayer extends RankedPlayer {
  vona: number; // vor now minus expected best-available VOR at our next pick
  pSurvive: number; // probability this player is still on the board at nextPickNo
}

// Probability a player with the given full-PPR ADP is still available at
// `nextPickNo`. Logistic in (adp - nextPickNo): an ADP far past our next pick
// survives with near-certainty; one well before it is almost surely gone.
// ADP 999 encodes "undrafted/unknown" — treat as certain to survive.
export function survivalProb(adp: number, nextPickNo: number, spread: number): number {
  if (!Number.isFinite(adp) || adp >= 999) return 1;
  return 1 / (1 + Math.exp((nextPickNo - adp) / Math.max(1, spread)));
}

// Expected VOR of the BEST player still available at a position at our next
// pick. Walking value-high to value-low, the first survivor is what we'd take;
// E = Σ vor_i · s_i · Π_{j<i}(1 − s_j). If nobody on the list survives we fall
// to replacement level (VOR 0), which the product tail encodes as zero.
// `atPos` must be sorted by VOR descending. Negative VOR is floored at 0 (a
// replacement-level player is worth ~0, never a penalty, to us later).
export function expectedBestLaterVor(atPos: { vor: number; pSurvive: number }[]): number {
  let carried = 1; // prob every higher-value player at the position is already gone
  let exp = 0;
  for (const p of atPos) {
    exp += Math.max(0, p.vor) * p.pSurvive * carried;
    carried *= 1 - p.pSurvive;
    if (carried < 1e-4) break; // remaining players can't move the expectation
  }
  return exp;
}

// Rank available players by VONA. `available` are the players still on the board
// (already valued by VOR). Returns them scored + sorted, best drop-off first.
export function rankByVona(available: RankedPlayer[], ctx: VonaContext): VonaPlayer[] {
  const nudge = ctx.oppNudge ?? 0;
  const scored: VonaPlayer[] = available.map((p) => {
    let s = survivalProb(p.adp, ctx.nextPickNo, ctx.adpSpread);
    const demand = ctx.gapDemand?.[p.position] ?? 0;
    if (nudge > 0 && demand > 0) s *= 1 - Math.min(1, nudge * demand);
    return { ...p, pSurvive: s, vona: 0 };
  });

  const byPos = new Map<Position, VonaPlayer[]>();
  for (const p of scored) {
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push(p);
  }

  for (const arr of byPos.values()) {
    arr.sort((a, b) => b.vor - a.vor);
    // Expected best available at this position INCLUDING the player himself —
    // not taking him leaves him in the pool, so the chance he falls back to us
    // is correctly baked into the opportunity cost. The top survivor's VONA
    // collapses toward 0 when he's likely to still be there next turn.
    const expLater = expectedBestLaterVor(arr);
    for (const p of arr) p.vona = Math.round((Math.max(0, p.vor) - expLater) * 10) / 10;
  }

  scored.sort((a, b) => b.vona - a.vona || b.vor - a.vor);
  return scored;
}
