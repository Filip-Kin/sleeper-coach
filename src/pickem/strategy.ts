// How the coach picks. Pure functions only, so every rule here is testable
// without a browser or a season.
//
// WHY THIS WORKS AT ALL. The league is scored 1 point per correct pick ATS, so
// the only thing that matters is beating the spread more than half the time.
// Beating a LIVE spread is not possible for free. But the line we are graded
// against is not live: Sleeper freezes `pickem_spread` early and keeps updating
// its betting-market `spread` afterwards. Where the two disagree, the market has
// moved and our graded number is stale, so we take the side the market moved to.
// That is arbitrage against a stale number, not a forecast.
//
// MEASURED on 529 completed 2024+2025 games where the market line was provably
// last updated BEFORE kickoff (src/pickem/backtest.ts regenerates all of this):
//
//   gap 0.5 only ......  44/ 90 = 48.9%   p=0.62   <- NO edge. Ignored on purpose.
//   gap 1.0 only ......  89/148 = 60.1%   p=0.008
//   gap 1.5 only ......   8/ 16 = 50.0%   p=0.60   (n too small to mean anything)
//   gap 2.0-3.0 .......  31/ 48 = 64.6%   p=0.03
//   gap >= 3.5 ........  17/ 27 = 63.0%   p=0.12
//   gap 0, take fav ... 102/200 = 51.0%
//   FULL SLATE, gap>=1.0 rule else favourite: 298/529 = 56.3%  p=0.002
//   FULL SLATE, favourite every time:         278/529 = 52.6%  p=0.13
//
// The 0.5 bucket is the interesting negative result. Those are exactly the games
// where a whole-number market line is hooked out to .5, handing the underdog a
// free half point on the most common NFL margins (3 and 7 are 14.3% and 8.5% of
// all games). Theory says take the dog. Ninety games say 48.9%. So we don't.

export interface GameLine {
  gameId: string;
  away: string;
  home: string;
  startTime: number;
  /** The graded line, from the away team's perspective. +3.5 = away is a 3.5 dog. */
  gradedSpreadAway: number | null;
  marketSpreadAway: number | null;
  gradedLocked?: boolean;
  status?: string;
}

export interface Decision {
  gameId: string;
  team: string;
  /** Points of line value we hold versus the current market. 0 = no signal. */
  edge: number;
  /** Estimated probability this pick covers, calibrated from the backtest above. */
  confidence: number;
  rule: "market-move" | "favourite" | "coin-flip";
  reason: string;
}

/** Act on a disagreement only from a full point. Below that the measured record
 *  is 48.9%, i.e. noise we would be paying attention tax on. */
export const GAP_THRESHOLD = Number(process.env.PICKEM_GAP_THRESHOLD ?? "1.0");

/** Calibration from the buckets above, deliberately shaded toward the mean.
 *  The raw 2.0-3.0 bucket measured 64.6% on 48 games; claiming 0.646 from 48
 *  games would be overfitting, so each tier is pulled back. */
function confidenceFor(gap: number): number {
  const g = Math.abs(gap);
  if (g >= 2.0) return 0.61;
  if (g >= GAP_THRESHOLD) return 0.58;
  return 0.51;
}

/** Which side does a stale graded line favour?
 *  gradedSpreadAway - marketSpreadAway > 0 means the graded line gives the away
 *  team MORE cushion than the market now does, so away is the value side. */
export function decide(game: GameLine): Decision | null {
  const graded = game.gradedSpreadAway;
  if (graded === null) return null; // no line to be graded against, unpickable

  const market = game.marketSpreadAway;
  const gap = market === null ? 0 : graded - market;

  if (Math.abs(gap) >= GAP_THRESHOLD - 1e-9) {
    const team = gap > 0 ? game.away : game.home;
    return {
      gameId: game.gameId,
      team,
      edge: Math.abs(gap),
      confidence: confidenceFor(gap),
      rule: "market-move",
      reason:
        `graded ${game.away} ${fmt(graded)} vs market ${fmt(market as number)}; ` +
        `market moved ${Math.abs(gap).toFixed(1)} toward ${team}`,
    };
  }

  // No usable disagreement. Favourites went 51% in the same sample, which is not
  // an edge, but it is the best of the available nothings and it is what the
  // rest of the league is doing anyway.
  if (graded === 0) {
    return { gameId: game.gameId, team: game.home, edge: 0, confidence: 0.5, rule: "coin-flip", reason: "pick'em game, no side" };
  }
  const team = graded > 0 ? game.home : game.away;
  return {
    gameId: game.gameId,
    team,
    edge: 0,
    confidence: 0.51,
    rule: "favourite",
    reason: `no market disagreement; ${team} favoured by ${Math.abs(graded).toFixed(1)}`,
  };
}

function fmt(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}

/** The information-free pick: whoever the graded line favours. Used for the
 *  early safety slate. This matters because the pick'em endpoint that lets us
 *  read rivals' picks lets them read OURS, so anything we submit days ahead is
 *  copyable. Favourites leak nothing (it is what everyone picks anyway) while
 *  still guaranteeing we are never blank if the automation dies. The picks that
 *  actually carry our edge go in inside the final window, too late to copy. */
export function safePick(game: GameLine): Decision | null {
  const graded = game.gradedSpreadAway;
  if (graded === null) return null;
  if (graded === 0) {
    return { gameId: game.gameId, team: game.home, edge: 0, confidence: 0.5, rule: "coin-flip", reason: "provisional: pick'em game, no side" };
  }
  const team = graded > 0 ? game.home : game.away;
  return {
    gameId: game.gameId, team, edge: 0, confidence: 0.51, rule: "favourite",
    reason: `provisional: ${team} favoured by ${Math.abs(graded).toFixed(1)}`,
  };
}

/** How close to kickoff before we commit the real pick. Games lock individually,
 *  so this is measured per game, not per week.
 *
 *  Four hours, not three: the scheduled passes are up to 3.5h apart (12:00 to
 *  15:30), so a three-hour window could let a game kick off having never been
 *  inside the window of any pass. Four hours guarantees overlap. It is still
 *  very late relative to the rivals, who submitted week 1 nine days early. */
export const FINAL_WINDOW_HOURS = Number(process.env.PICKEM_FINAL_WINDOW_HOURS ?? "4");

export function inFinalWindow(game: GameLine, now: number): boolean {
  return game.startTime - now <= FINAL_WINDOW_HOURS * 3_600_000;
}

export function decideSlate(games: GameLine[]): Decision[] {
  return games.map(decide).filter((d): d is Decision => d !== null);
}

/** A pick is only worth submitting while the game can still be picked. Sleeper
 *  flips is_locked per GAME, not per week, and this pool's games run Wednesday
 *  through Monday, so there is no single weekly deadline to aim at. */
export function isPickable(game: GameLine, now: number): boolean {
  if (game.gradedLocked) return false;
  if (game.status && game.status !== "pre_game") return false;
  return game.startTime > now;
}

/** Did a pick cover the graded line?
 *
 *  Do NOT read this off the stored pick's `outcome` field. `outcome: "win"` is
 *  part of the pick INPUT (the API rejects a pick without it), so every stored
 *  pick carries it from the moment it is made, played or not. Treating it as a
 *  result made every rival look 16-for-16 before a ball was kicked, which in
 *  turn flipped the field mode into "differentiate" in week 1. Grade from the
 *  scoreline instead, which is self-sufficient and needs no undocumented field.
 *
 *  Returns null while the game is unplayed, or if the line would push. */
export function gradePick(game: ScoredGame, team: string): "win" | "loss" | null {
  const { awayScore, homeScore, gradedSpreadAway } = game;
  if (awayScore === null || homeScore === null) return null;
  if (game.status !== "complete") return null;
  if (gradedSpreadAway === null) return null;
  const margin = awayScore + gradedSpreadAway - homeScore;
  if (margin === 0) return null; // a true push; the .5 hook normally prevents it
  const winner = margin > 0 ? game.away : game.home;
  if (team !== game.away && team !== game.home) return null;
  return team === winner ? "win" : "loss";
}

export interface ScoredGame extends GameLine {
  awayScore: number | null;
  homeScore: number | null;
}

/** Correct picks out of a set, grading each against its game. */
export function scorePicks(
  games: ScoredGame[], picks: Record<string, { team: string }>,
): { correct: number; graded: number } {
  let correct = 0, graded = 0;
  for (const g of games) {
    const p = picks[g.gameId];
    if (!p) continue;
    const r = gradePick(g, p.team);
    if (r === null) continue;
    graded++;
    if (r === "win") correct++;
  }
  return { correct, graded };
}

// ---------------------------------------------------------------------------
// Tiebreaker
// ---------------------------------------------------------------------------

/** Empirical distribution of total points over 1088 completed 2022-2025 games
 *  (mean 44.8, median 44, sd 13.7 — `bun run pickem-backtest` reprints these).
 *  Spread magnitude does not predict the total, 45.8 for spreads >= 7 against
 *  45.5 for <= 3, so there is nothing cleverer to condition on and the prior is
 *  just the distribution. It barely matters anyway: where we sit is driven by
 *  the rivals' visible guesses, not by our estimate of the mode. */
export const TOTAL_POINTS_MEAN = 44.8;
export const TOTAL_POINTS_SD = 13.7;

function normalPdf(x: number, mu: number, sd: number): number {
  const z = (x - mu) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

/** Tiebreakers in a pool are a positioning game, not a forecasting one. Everyone
 *  else's guess is visible, so pick the integer that maximises the share of
 *  likely totals for which WE are closest, rather than the most likely total.
 *  With rivals clustered at 47 and 50, sitting on 45 wins a wider band than
 *  guessing the mode would. */
export function bestTiebreaker(rivalGuesses: number[], lo = 20, hi = 75): number {
  const rivals = rivalGuesses.filter((v) => Number.isFinite(v));
  let best = Math.round(TOTAL_POINTS_MEAN);
  let bestScore = -Infinity;
  for (let guess = lo; guess <= hi; guess++) {
    let mass = 0;
    let absErr = 0;
    for (let total = 0; total <= 120; total++) {
      const pdf = normalPdf(total, TOTAL_POINTS_MEAN, TOTAL_POINTS_SD);
      absErr += pdf * Math.abs(total - guess);
      const ourDist = Math.abs(total - guess);
      // Ties on the tiebreaker go to nobody in particular, so count a shared
      // win as a fractional one rather than assuming we take it.
      let better = 0, equal = 0;
      for (const r of rivals) {
        const d = Math.abs(total - r);
        if (d < ourDist) better++;
        else if (d === ourDist) equal++;
      }
      if (better > 0) continue;
      mass += pdf / (1 + equal);
    }
    // With no rivals every guess claims the whole distribution, so the mass term
    // ties across the entire range and the tie-break is what actually decides:
    // fall back to the guess that minimises expected error. It is scaled far
    // below any real difference in win mass so it never overrides one.
    const score = mass - 1e-6 * absErr;
    if (score > bestScore) { bestScore = score; best = guess; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Field awareness
// ---------------------------------------------------------------------------

export type FieldMode = "accuracy" | "differentiate" | "mirror";

/** This pool is cumulative over 18 weeks, so for most of the season the entrant
 *  with the best accuracy wins and copying the field just ties the field. Field
 *  awareness only pays at the end, when the remaining picks can no longer close
 *  (or protect) a specific gap. Trailing late, we need variance: pick AGAINST
 *  the leaders so their correct picks stop being ours too. Leading late, mirror
 *  them so the gap cannot close.
 *
 *  deficit is our score minus the best rival's: negative means we are behind. */
export function fieldMode(deficit: number, gamesRemaining: number): FieldMode {
  // With this much left, ordinary accuracy still swamps any positioning play.
  // One standard deviation of a 50/50 pick difference over n games is sqrt(n)/2,
  // so a gap only matters once it is comparable to that.
  const swing = Math.sqrt(Math.max(gamesRemaining, 0)) / 2;
  if (gamesRemaining <= 0) return "accuracy";
  if (deficit < -swing) return "differentiate";
  if (deficit > swing * 2) return "mirror";
  return "accuracy";
}

/** Apply the endgame mode to one game. Only ever overrides a pick with NO market
 *  edge: a measured 60% signal is never thrown away for a positioning play.
 *  rivalPicks holds the teams the relevant rivals picked for THIS game. */
export function applyFieldMode(
  d: Decision, game: GameLine, mode: FieldMode, rivalPicks: string[],
): Decision {
  if (mode === "accuracy" || d.edge > 0 || rivalPicks.length === 0) return d;
  const withUs = rivalPicks.filter((t) => t === d.team).length / rivalPicks.length;

  if (mode === "differentiate" && withUs > 0.5) {
    const other = d.team === game.away ? game.home : game.away;
    return {
      ...d,
      team: other,
      rule: "coin-flip",
      confidence: 0.49,
      reason: `${d.reason}; flipped to ${other} to differentiate from the field while trailing`,
    };
  }

  if (mode === "mirror" && withUs < 0.5) {
    const field = rivalPicks[0] as string;
    return {
      ...d,
      team: field,
      rule: "coin-flip",
      confidence: 0.5,
      reason: `${d.reason}; matched the field on ${field} to protect the lead`,
    };
  }
  return d;
}
