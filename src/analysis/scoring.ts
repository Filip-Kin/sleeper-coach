import type { ScoringSettings } from "../sleeper/types.ts";

// Turn a projected stat line into fantasy points under this league's exact
// scoring. Most Sleeper scoring keys share the stat key name (rec, rush_yd,
// pass_td, ...), so a straight dot-product covers the common case.
//
// NOTE: threshold buckets (pts_allow_*, fgm_<range>) are not simple multiplies
// and are handled where defence/kicker projections are built, not here.
export function projectPoints(
  stats: Record<string, number>,
  scoring: ScoringSettings,
): number {
  let total = 0;
  for (const [key, value] of Object.entries(stats)) {
    const weight = scoring[key];
    if (weight !== undefined) total += value * weight;
  }
  return Math.round(total * 100) / 100;
}

// A quick human-readable summary of the scoring rules that most change draft
// strategy, so the board and the coach's prompts stay grounded in reality.
export function describeScoring(scoring: ScoringSettings): string[] {
  const notes: string[] = [];
  const rec = scoring["rec"] ?? 0;
  notes.push(rec >= 1 ? "Full PPR (1.0 per reception)" : rec > 0 ? `${rec} PPR` : "Standard (no PPR)");
  if (scoring["pass_td"]) notes.push(`Pass TD ${scoring["pass_td"]}`);
  if (scoring["pass_int"]) notes.push(`INT ${scoring["pass_int"]}`);
  if (scoring["fum_lost"]) notes.push(`Fumble lost ${scoring["fum_lost"]}`);
  return notes;
}
