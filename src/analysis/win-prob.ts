// Win probability and the "earned versus still to come" split for a head-to-head
// matchup. Pure functions of a few numbers per starter, so the honest part of the
// model is testable offline and the fetch/assembly around it stays dumb.
//
// The model is deliberately simple and stated plainly in the UI, because a made-up
// precise number dressed as a real model is worse than an honest rough one. For
// each side we take the points already banked plus the projected remainder of the
// starters who have not finished, and treat the final margin as normally
// distributed.
//
// THE MODEL, in full.
//
//  1. A side's final score is (points already on the board) + (projected points
//     still to come from starters whose games are not over).
//  2. A starter yet to kick off contributes his whole projection, with a standard
//     deviation proportional to it: sigma = max(MIN_SIGMA, VOLATILITY * projection).
//     Weekly fantasy scoring is genuinely noisy (a 12-point projection routinely
//     lands between 3 and 25) so this is large on purpose. It is PROPORTIONAL
//     rather than flat because a kicker projected for 7 and a back projected for
//     22 plainly do not carry the same spread, and MIN_SIGMA stops a low
//     projection being treated as a near-certainty.
//  3. A starter whose game is IN PROGRESS has banked part of his score already.
//     Only the unplayed fraction is still random, so his remaining mean is
//     projection * fracRemaining and his remaining sigma is sigma * sqrt(frac).
//     The square root is the point: variance accumulates roughly linearly with
//     playing time, so a player with a quarter left carries half the uncertainty
//     of one who has not started, not a quarter of it.
//  4. Starters are assumed to score INDEPENDENTLY, so variances add. This is the
//     model's biggest simplification and the UI says so: a quarterback and his own
//     receiver score together, so the true spread is a little wider and a very
//     high or very low number is slightly overconfident.
//
// When nothing is left to play the matchup is DECIDED and the model is not used at
// all: the answer is read straight off the scoreboard.
//
// Live game state is OPTIONAL throughout. Without it (the ESPN scoreboard is
// unreachable, or the caller does not supply it) every in-progress starter simply
// counts at his live total with nothing extrapolated, which is the conservative
// behaviour this module shipped with: it understates a team mid-drive but never
// invents a game state we cannot see.

// Ratio of a weekly score's standard deviation to its projection.
export const VOLATILITY = 0.55;
// Floor on one starter's standard deviation, in points. Nobody is a certainty.
export const MIN_SIGMA = 3;

export type StarterStatus =
  | "banked" // finished, or has no game left to play; whatever he scored is final
  | "live" // game in progress: some points banked, some of the game still to run
  | "toplay" // yet to take the field, full projection still to come
  | "bye" // on a bye this week, contributes nothing
  | "out"; // ruled out / on reserve, contributes nothing

export type MatchupPhase = "past" | "live" | "future";

// The three states a real game can be in, as reported by src/data/nfl-games.ts.
export type GamePhase = "pre" | "in" | "post";

// Decide a starter's contribution state. `phase` gates the interpretation of a
// zero: in a finished week a zero is a final score (a player who did not play), so
// nothing is "yet to come"; in a live week a zero on a healthy starter with a game
// still ahead is the single most useful signal we have (points still to bank).
//
// `gameState` is optional. When the live scoreboard IS available it is
// authoritative and answers the question directly, which is the only way to tell a
// player who has finished and been shut out from one who kicks off in four hours.
// When it is absent we fall back to inferring from the phase and the live total.
export function classifyStarter(
  live: number,
  opts: {
    onBye: boolean;
    unavailable: boolean;
    hasGame: boolean;
    phase: MatchupPhase;
    gameState?: GamePhase | null;
  },
): StarterStatus {
  if (opts.onBye) return "bye";
  if (opts.unavailable) return "out";

  // Authoritative path: we know what his game is actually doing.
  if (opts.gameState) {
    if (opts.gameState === "post") return "banked";
    if (opts.gameState === "in") return "live";
    return "toplay"; // "pre": has not kicked off
  }

  if (opts.phase === "past") return "banked"; // week is final: nothing to come
  if (live > 0) return "banked"; // already contributing
  if (opts.phase === "future") return "toplay"; // no games played yet this week
  // Live week, zero so far: yet to play if he has a game still, otherwise treat as
  // banked-at-zero rather than inventing upside for a player with no game.
  return opts.hasGame ? "toplay" : "banked";
}

export interface StarterLine {
  banked: number; // points already on the board
  projection: number; // this week's projection under league scoring
  status: StarterStatus;
  // Fraction of his game still unplayed, 0..1. Only read for a "live" starter.
  // Absent means we have no clock, so nothing is extrapolated for him.
  fracRemaining?: number;
}

export interface SideOutlook {
  banked: number; // points already earned
  toCome: number; // projected points still to come
  expected: number; // banked + toCome, the point estimate of the final score
  yetToPlay: number; // starters who have not kicked off
  inPlay: number; // starters whose game is running right now
  played: number; // starters who are finished
  // Variance of this side's remaining points. Exposed so winProbability can add
  // the two sides without recomputing, and so a test can pin it.
  variance: number;
}

// One starter's standard deviation around his projection, before any game-clock
// scaling.
export function sigmaFor(projection: number): number {
  return Math.max(MIN_SIGMA, VOLATILITY * Math.max(0, projection));
}

// Roll a side's starters into the numbers the scoreboard and the win-prob model
// both need. A "bye" or "out" starter contributes nothing at all; a "banked" one
// contributes his points and no uncertainty; "toplay" contributes his whole
// projection; "live" contributes the unplayed fraction of it.
export function sideOutlook(starters: StarterLine[]): SideOutlook {
  let banked = 0, toCome = 0, variance = 0, yetToPlay = 0, inPlay = 0, played = 0;
  for (const s of starters) {
    banked += s.banked;
    const projection = Math.max(0, s.projection);
    if (s.status === "toplay") {
      toCome += projection;
      const sd = sigmaFor(projection);
      variance += sd * sd;
      yetToPlay += 1;
    } else if (s.status === "live") {
      inPlay += 1;
      // No clock supplied means no extrapolation: he counts at his live total.
      const frac = Math.max(0, Math.min(1, s.fracRemaining ?? 0));
      if (frac > 0) {
        toCome += projection * frac;
        const sd = sigmaFor(projection) * Math.sqrt(frac);
        variance += sd * sd;
      }
    } else if (s.status === "banked") {
      played += 1;
    }
  }
  return {
    banked: round1(banked),
    toCome: round1(toCome),
    expected: round1(banked + toCome),
    yetToPlay,
    inPlay,
    played,
    variance,
  };
}

export interface WinProb {
  prob: number; // our probability of winning, 0..1
  percent: number; // whole percent; the only precision we are entitled to claim
  meanDiff: number; // our expected final minus theirs
  sd: number; // standard deviation of the margin
  yetToPlay: number; // starters not yet finished across BOTH sides
  decided: boolean; // nobody left to play: the margin is final
  // Rendered verbatim in the UI. Do not summarise these away.
  assumptions: string[];
  basis: string; // the one-line honest claim shown under the number
}

// Our probability of outscoring the opponent. When nobody is left to play the
// margin is final and the probability collapses to 0, 0.5 (an exact tie) or 1.
export function winProbability(us: SideOutlook, opp: SideOutlook): WinProb {
  const meanDiff = round1(us.expected - opp.expected);
  // Var(A - B) = Var(A) + Var(B) for independent A and B.
  const variance = us.variance + opp.variance;
  const yetToPlay = us.yetToPlay + opp.yetToPlay + us.inPlay + opp.inPlay;

  if (variance === 0) {
    const prob = meanDiff > 0 ? 1 : meanDiff < 0 ? 0 : 0.5;
    return {
      prob,
      percent: Math.round(prob * 100),
      meanDiff,
      sd: 0,
      yetToPlay: 0,
      decided: true,
      assumptions: ["Every starter on both sides has finished, so this is the final result rather than an estimate."],
      basis: meanDiff > 0 ? "Won. Every starter has finished." : meanDiff < 0 ? "Lost. Every starter has finished." : "Tied. Every starter has finished.",
    };
  }

  const sd = Math.sqrt(variance);
  const prob = normalCdf(meanDiff / sd);
  const percent = Math.round(prob * 100);
  return {
    prob,
    percent,
    meanDiff,
    sd: round1(sd),
    yetToPlay,
    decided: false,
    assumptions: [
      `Each starter still to play is assumed to score around his projection, with a standard deviation of ${Math.round(VOLATILITY * 100)}% of it (minimum ${MIN_SIGMA} points).`,
      "A starter already in a live game carries only the uncertainty of the part of his game still to be played.",
      "Starters are assumed to score independently. A quarterback and his own receiver actually score together, so the real spread is a little wider and a very high or very low number is slightly overconfident.",
      "Projections are Sleeper's weekly numbers scored under this league's rules, not adjusted for matchup or weather.",
    ],
    basis: `${percent}%, based on projected remaining points and ${yetToPlay} starter${yetToPlay === 1 ? "" : "s"} yet to finish`,
  };
}

// Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation. Accurate
// to about 1e-7, which is far finer than the model's own honesty warrants, but it
// keeps the maths self-contained with no dependency.
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
