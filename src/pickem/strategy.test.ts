import { test, expect } from "bun:test";
import {
  decide, decideSlate, isPickable, bestTiebreaker, fieldMode, applyFieldMode,
  GAP_THRESHOLD, type GameLine,
} from "./strategy.ts";

const game = (over: Partial<GameLine> = {}): GameLine => ({
  gameId: "1", away: "CHI", home: "CAR", startTime: 2_000,
  gradedSpreadAway: 2.5, marketSpreadAway: 2.5, status: "pre_game", ...over,
});

// --- the core rule: take the side the market moved toward -------------------

test("takes the away team when the graded line gives it more cushion than the market", () => {
  // graded CHI +3.5 but market only +2.0 -> market moved 1.5 toward CHI
  const d = decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 2.0 }))!;
  expect(d.team).toBe("CHI");
  expect(d.rule).toBe("market-move");
  expect(d.edge).toBeCloseTo(1.5, 6);
});

test("takes the home team when the market moved the other way", () => {
  // graded CHI +2.0 but market has CHI +3.5 -> CAR is the value side
  const d = decide(game({ gradedSpreadAway: 2.0, marketSpreadAway: 3.5 }))!;
  expect(d.team).toBe("CAR");
  expect(d.rule).toBe("market-move");
  expect(d.edge).toBeCloseTo(1.5, 6);
});

test("sign convention holds for a negative graded line (away favoured)", () => {
  // graded CHI -2.5 (CHI favoured), market CHI -4.0 -> market moved toward CHI
  const d = decide(game({ gradedSpreadAway: -2.5, marketSpreadAway: -4.0 }))!;
  expect(d.team).toBe("CHI");
});

test("IGNORES a half-point gap, because that bucket measured 48.9% over 90 games", () => {
  const d = decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 3.0 }))!;
  expect(d.rule).toBe("favourite");
  expect(d.edge).toBe(0);
  expect(d.team).toBe("CAR"); // CHI +3.5 means CAR is favoured
});

test("falls back to the favourite when the lines agree", () => {
  expect(decide(game({ gradedSpreadAway: 6.5, marketSpreadAway: 6.5 }))!.team).toBe("CAR");
  expect(decide(game({ gradedSpreadAway: -6.5, marketSpreadAway: -6.5 }))!.team).toBe("CHI");
});

test("falls back to the favourite when there is no market line at all", () => {
  const d = decide(game({ gradedSpreadAway: 6.5, marketSpreadAway: null }))!;
  expect(d.rule).toBe("favourite");
  expect(d.team).toBe("CAR");
});

test("a game with no graded line is unpickable, not a guess", () => {
  expect(decide(game({ gradedSpreadAway: null }))).toBeNull();
  expect(decideSlate([game({ gradedSpreadAway: null }), game()])).toHaveLength(1);
});

test("confidence is ordered by edge and never overclaims", () => {
  const small = decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 2.5 }))!;
  const big = decide(game({ gradedSpreadAway: 5.5, marketSpreadAway: 2.5 }))!;
  const none = decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 3.5 }))!;
  expect(big.confidence).toBeGreaterThan(small.confidence);
  expect(small.confidence).toBeGreaterThan(none.confidence);
  expect(big.confidence).toBeLessThan(0.65); // the raw bucket was 64.6% on 48 games
});

test("threshold is exactly one point, inclusive", () => {
  expect(GAP_THRESHOLD).toBe(1.0);
  expect(decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 2.5 }))!.rule).toBe("market-move");
  expect(decide(game({ gradedSpreadAway: 3.5, marketSpreadAway: 2.6 }))!.rule).toBe("favourite");
});

// --- pickability ------------------------------------------------------------

test("a locked, started or past game is not pickable", () => {
  expect(isPickable(game({ startTime: 5_000 }), 1_000)).toBe(true);
  expect(isPickable(game({ startTime: 500 }), 1_000)).toBe(false);
  expect(isPickable(game({ startTime: 5_000, gradedLocked: true }), 1_000)).toBe(false);
  expect(isPickable(game({ startTime: 5_000, status: "complete" }), 1_000)).toBe(false);
});

// --- tiebreaker -------------------------------------------------------------

test("with no rivals, the tiebreaker sits on the middle of the distribution", () => {
  const t = bestTiebreaker([]);
  expect(t).toBeGreaterThanOrEqual(44);
  expect(t).toBeLessThanOrEqual(47);
});

test("the tiebreaker avoids sitting on top of a rival", () => {
  // real week-1 rival guesses from the league
  const t = bestTiebreaker([47, 50, 31]);
  expect([47, 50, 31]).not.toContain(t);
});

test("the tiebreaker claims the dense side when rivals crowd high", () => {
  // rivals at 55/58/60 leave everything below them; we should sit under, not over
  expect(bestTiebreaker([55, 58, 60])).toBeLessThan(55);
});

test("the tiebreaker claims a whole tail rather than squeezing between rivals", () => {
  // Rivals at 38 and 52 leave a gap worth about 20% of outcomes between them.
  // Sitting just outside either rival claims a whole tail worth about 29%, so
  // that is the play: being closest is positioning, not forecasting. Which tail
  // wins is near enough a coin toss (29.7% low against 28.7% high), so assert
  // the strategy, not the side — otherwise a 1-point shift in the mean flips it.
  const t = bestTiebreaker([38, 52]);
  expect(t < 38 || t > 52).toBe(true);
});

// --- field awareness --------------------------------------------------------

test("field mode stays on accuracy while there is plenty of season left", () => {
  expect(fieldMode(-3, 200)).toBe("accuracy");
  expect(fieldMode(3, 200)).toBe("accuracy");
});

test("field mode differentiates when trailing late", () => {
  expect(fieldMode(-6, 16)).toBe("differentiate");
});

test("field mode mirrors when leading late", () => {
  expect(fieldMode(9, 16)).toBe("mirror");
});

test("a measured market edge is never sacrificed for a positioning play", () => {
  const d = decide(game({ gradedSpreadAway: 5.5, marketSpreadAway: 2.5 }))!;
  const after = applyFieldMode(d, game(), "differentiate", ["CHI", "CHI", "CHI"]);
  expect(after.team).toBe(d.team);
  expect(after.rule).toBe("market-move");
});

test("differentiating flips off the field only on a no-edge game", () => {
  const g = game({ gradedSpreadAway: 6.5, marketSpreadAway: 6.5 }); // favourite = CAR
  const d = decide(g)!;
  expect(d.team).toBe("CAR");
  const after = applyFieldMode(d, g, "differentiate", ["CAR", "CAR", "CAR"]);
  expect(after.team).toBe("CHI");
  expect(after.reason).toContain("differentiate");
});

test("differentiating leaves us alone if we are already off the field", () => {
  const g = game({ gradedSpreadAway: 6.5, marketSpreadAway: 6.5 });
  const d = decide(g)!;
  const after = applyFieldMode(d, g, "differentiate", ["CHI", "CHI", "CHI"]);
  expect(after.team).toBe("CAR");
});

test("mirroring joins the field when we are off it", () => {
  const g = game({ gradedSpreadAway: 6.5, marketSpreadAway: 6.5 });
  const d = decide(g)!;
  const after = applyFieldMode(d, g, "mirror", ["CHI", "CHI", "CHI"]);
  expect(after.team).toBe("CHI");
  expect(after.reason).toContain("protect the lead");
});

// --- two-stage submission ---------------------------------------------------

import { safePick, inFinalWindow, FINAL_WINDOW_HOURS } from "./strategy.ts";

test("the provisional pick is always the favourite, never the edge side", () => {
  // A game with a 3-point market disagreement: the real decision is CHI, but the
  // provisional slate must still show the favourite so nothing is leaked early.
  const g = game({ gradedSpreadAway: 5.5, marketSpreadAway: 2.5 });
  expect(decide(g)!.team).toBe("CHI");
  expect(decide(g)!.rule).toBe("market-move");
  expect(safePick(g)!.team).toBe("CAR");
  expect(safePick(g)!.edge).toBe(0);
});

test("the provisional pick is unavailable without a graded line", () => {
  expect(safePick(game({ gradedSpreadAway: null }))).toBeNull();
});

test("the final window is measured per game against its own kickoff", () => {
  const now = 1_000_000_000_000;
  const hour = 3_600_000;
  expect(FINAL_WINDOW_HOURS).toBe(3);
  expect(inFinalWindow(game({ startTime: now + 2 * hour }), now)).toBe(true);
  expect(inFinalWindow(game({ startTime: now + 4 * hour }), now)).toBe(false);
});
