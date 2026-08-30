import type { League, Position } from "../sleeper/types.ts";
import type { Projection } from "./projections.ts";

// Value over replacement, tuned to a specific league. A player's worth is not
// his raw projected points but how far he clears the freely-available
// replacement at his position. In a shallow 8-team league the replacement
// level is high, which sharpens the value of genuine studs.

export interface RankedPlayer extends Projection {
  vor: number; // points above positional replacement
  tier: number; // 1 = best tier at the position
  posRank: number; // rank within position by projected points
}

// How the two FLEX slots are expected to be filled across the league. RB/WR
// carry most flex usage; TE a little. Used to raise the replacement baseline.
const FLEX_SPLIT: Record<string, number> = { RB: 0.45, WR: 0.45, TE: 0.1 };

function starterCounts(league: League): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const slot of league.roster_positions) {
    if (slot === "BN") continue;
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

// The positional rank at which a player becomes "replacement level" for this
// league: league-wide starting demand at the position, including a share of
// the FLEX slots for RB/WR/TE.
function replacementRanks(league: League): Record<string, number> {
  const teams = league.settings.num_teams;
  const counts = starterCounts(league);
  const flexSlots = counts["FLEX"] ?? 0;

  const ranks: Record<string, number> = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const dedicated = (counts[pos] ?? 0) * teams;
    const flexShare = (FLEX_SPLIT[pos] ?? 0) * flexSlots * teams;
    ranks[pos] = Math.max(1, Math.round(dedicated + flexShare));
  }
  return ranks;
}

// Break a points-sorted list into tiers at the biggest scoring gaps: a gap
// larger than mean + 1 stdev of gaps starts a new tier. Captures the natural
// cliffs drafters feel ("if I miss this tier I wait a round").
function assignTiers(sortedDesc: Projection[]): number[] {
  if (sortedDesc.length <= 1) return sortedDesc.map(() => 1);
  const gaps: number[] = [];
  for (let i = 1; i < sortedDesc.length; i++) {
    gaps.push(sortedDesc[i - 1]!.points - sortedDesc[i]!.points);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const threshold = mean + Math.sqrt(variance);

  const tiers = [1];
  let tier = 1;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > threshold) tier++;
    tiers.push(tier);
  }
  return tiers;
}

// Rank every projected player by VOR for this league, with positional tiers.
//
// `baselineFrom` supplies a SEPARATE list used only to locate the replacement
// level. Pass the unadjusted projections whenever `projections` has been
// devalued (see src/data/news.ts): docking a handful of fringe RBs for injury
// otherwise drags the RB23 replacement point down and silently inflates the VOR
// of every healthy RB, tilting the whole board toward RB for no football reason.
// The baseline is a property of the LEAGUE's replacement level, not of who
// happens to be hurt.
export function rankByVor(
  projections: Projection[],
  league: League,
  baselineFrom?: Projection[],
): RankedPlayer[] {
  const ranks = replacementRanks(league);
  const byPos = new Map<Position, Projection[]>();
  for (const p of projections) {
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push(p);
  }

  // Replacement points per position, from the baseline list if one was given.
  const baselinePoints = new Map<string, number>();
  if (baselineFrom) {
    const rawByPos = new Map<Position, Projection[]>();
    for (const p of baselineFrom) {
      if (!rawByPos.has(p.position)) rawByPos.set(p.position, []);
      rawByPos.get(p.position)!.push(p);
    }
    for (const [pos, players] of rawByPos) {
      const sorted = players.slice().sort((a, b) => b.points - a.points);
      const idx = Math.min(sorted.length - 1, (ranks[pos] ?? sorted.length) - 1);
      baselinePoints.set(pos, sorted[idx]?.points ?? 0);
    }
  }

  const ranked: RankedPlayer[] = [];
  for (const [pos, players] of byPos) {
    players.sort((a, b) => b.points - a.points);
    const replIdx = Math.min(players.length - 1, (ranks[pos] ?? players.length) - 1);
    const replacement = baselinePoints.get(pos) ?? players[replIdx]?.points ?? 0;
    const tiers = assignTiers(players);

    players.forEach((p, i) => {
      ranked.push({
        ...p,
        vor: Math.round((p.points - replacement) * 10) / 10,
        tier: tiers[i] ?? 1,
        posRank: i + 1,
      });
    });
  }

  ranked.sort((a, b) => b.vor - a.vor);
  return ranked;
}
