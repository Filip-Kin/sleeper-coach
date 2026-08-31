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

import { safePick, inFinalWindow, pickemTriggerDue, FINAL_WINDOW_MIN } from "./strategy.ts";

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
  const min = 60_000;
  expect(FINAL_WINDOW_MIN).toBe(20);
  expect(inFinalWindow(game({ startTime: now + 10 * min }), now)).toBe(true);
  expect(inFinalWindow(game({ startTime: now + 19 * min }), now)).toBe(true);
  expect(inFinalWindow(game({ startTime: now + 25 * min }), now)).toBe(false);
  expect(inFinalWindow(game({ startTime: now + 4 * 60 * min }), now)).toBe(false);
});

// --- the kickoff-driven trigger --------------------------------------------

test("the trigger fires only when a kickoff is inside the window", () => {
  const now = 1_000_000_000_000;
  const min = 60_000;
  const long_ago = now - 60 * min;
  expect(pickemTriggerDue([now + 10 * min], now, long_ago)).toBe(true);
  expect(pickemTriggerDue([now + 45 * min], now, long_ago)).toBe(false);
  expect(pickemTriggerDue([], now, long_ago)).toBe(false);
});

test("the trigger ignores a game that has already kicked off", () => {
  const now = 1_000_000_000_000;
  const min = 60_000;
  expect(pickemTriggerDue([now - 5 * min], now, now - 60 * min)).toBe(false);
});

test("the trigger is rate-limited so a kickoff cluster does not spawn a pass every poll", () => {
  const now = 1_000_000_000_000;
  const min = 60_000;
  const kicks = [now + 5 * min, now + 6 * min, now + 7 * min];
  expect(pickemTriggerDue(kicks, now, now - 30_000)).toBe(false);  // ran 30s ago
  expect(pickemTriggerDue(kicks, now, now - 3 * min)).toBe(true);  // ran 3min ago
});

test("a 20 minute window still gives seven attempts at the daemon's poll rate", () => {
  // The point of a tight window: a missed pass must not be a single point of
  // failure. Count the passes the daemon would actually spawn before kickoff.
  // Polls land every 90s and the retry floor is 2min, so a run at t makes the
  // next eligible poll t+180s, not t+120s: effective spacing is 3 minutes, so a
  // 20 minute window is 7 attempts rather than the 10 the floor suggests.
  const kickoff = 1_000_000_000_000;
  const retryMs = 2 * 60_000;
  let last = kickoff - 6 * 60 * 60_000; // last ran hours ago
  let attempts = 0;
  for (let t = kickoff - FINAL_WINDOW_MIN * 60_000; t < kickoff; t += 90_000) {
    if (pickemTriggerDue([kickoff], t, last, retryMs)) { attempts++; last = t; }
  }
  expect(attempts).toBe(7);
});

// --- grading ----------------------------------------------------------------

import { gradePick, scorePicks, type ScoredGame } from "./strategy.ts";

const scored = (over: Partial<ScoredGame> = {}): ScoredGame => ({
  gameId: "1", away: "CHI", home: "CAR", startTime: 1, status: "complete",
  gradedSpreadAway: 2.5, marketSpreadAway: 2.5, awayScore: 20, homeScore: 21, ...over,
});

test("a pick is graded off the scoreline, not the stored outcome field", () => {
  // CHI +2.5 losing 20-21 still covers: 20 + 2.5 > 21.
  expect(gradePick(scored(), "CHI")).toBe("win");
  expect(gradePick(scored(), "CAR")).toBe("loss");
});

test("the favourite covering is graded correctly", () => {
  // CAR by 10 comfortably covers -2.5.
  const g = scored({ awayScore: 10, homeScore: 20 });
  expect(gradePick(g, "CAR")).toBe("win");
  expect(gradePick(g, "CHI")).toBe("loss");
});

test("an unplayed or in-progress game grades to nothing, never a win", () => {
  expect(gradePick(scored({ status: "pre_game" }), "CHI")).toBeNull();
  expect(gradePick(scored({ awayScore: null, homeScore: null }), "CHI")).toBeNull();
});

test("a team not in the game grades to nothing", () => {
  expect(gradePick(scored(), "SEA")).toBeNull();
});

test("scorePicks counts only games that have actually been graded", () => {
  const games = [
    scored({ gameId: "a", awayScore: 20, homeScore: 21 }),                    // CHI covers
    scored({ gameId: "b", awayScore: 10, homeScore: 20 }),                    // CAR covers
    scored({ gameId: "c", status: "pre_game", awayScore: null, homeScore: null }),
  ];
  const picks = { a: { team: "CHI" }, b: { team: "CHI" }, c: { team: "CHI" } };
  expect(scorePicks(games, picks)).toEqual({ correct: 1, graded: 2 });
});

test("a full unplayed slate scores zero, so field mode cannot be fooled", () => {
  // This is the bug that mattered: every stored pick carries outcome:"win" from
  // the moment it is made, so a naive read showed rivals 16-for-16 in week 1.
  const games = Array.from({ length: 16 }, (_, i) =>
    scored({ gameId: String(i), status: "pre_game", awayScore: null, homeScore: null }));
  const picks = Object.fromEntries(games.map((g) => [g.gameId, { team: "CHI" }]));
  expect(scorePicks(games, picks)).toEqual({ correct: 0, graded: 0 });
});

// --- tiebreaker centred on the market total ---------------------------------

test("the tiebreaker centres on the market total when we have one", () => {
  // A 38.5 game and a 51.5 game must not get the same answer. With no rivals,
  // the guess should track the market total, not the league-wide prior.
  const low = bestTiebreaker([], 38.5);
  const high = bestTiebreaker([], 51.5);
  expect(low).toBeLessThan(high);
  expect(Math.abs(low - 38.5)).toBeLessThanOrEqual(2);
  expect(Math.abs(high - 51.5)).toBeLessThanOrEqual(2);
});

test("the tiebreaker still avoids rivals when centred on a market total", () => {
  const t = bestTiebreaker([44, 45, 46], 45);
  expect([44, 45, 46]).not.toContain(t);
});

test("without a market total the tiebreaker falls back to the global prior", () => {
  const t = bestTiebreaker([]);
  expect(t).toBeGreaterThanOrEqual(43);
  expect(t).toBeLessThanOrEqual(47);
});

// --- degradation detection --------------------------------------------------

import { missedFinalPasses } from "./strategy.ts";

const gk = (gameId: string, startTime: number) => ({ gameId, startTime });

test("flags a game that kicked off with no final pass applied", () => {
  const now = 1_000_000_000_000;
  const hour = 3_600_000;
  const games = [gk("a", now - 2 * hour), gk("b", now + 2 * hour)];
  expect(missedFinalPasses(games, {}, now).map((g) => g.gameId)).toEqual(["a"]);
});

test("does not flag a game the rule was applied to", () => {
  const now = 1_000_000_000_000;
  const games = [gk("a", now - 2 * 3_600_000)];
  expect(missedFinalPasses(games, { a: now - 3_600_000 }, now)).toEqual([]);
});

test("reports once, not every pass", () => {
  // A negative marker means already reported. Without this the alert repeats.
  const now = 1_000_000_000_000;
  const games = [gk("a", now - 2 * 3_600_000)];
  expect(missedFinalPasses(games, { a: -1 }, now)).toEqual([]);
});

test("does not re-report the whole season from a fresh state file", () => {
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  const games = [gk("old", now - 30 * day), gk("recent", now - 2 * 3_600_000)];
  expect(missedFinalPasses(games, {}, now).map((g) => g.gameId)).toEqual(["recent"]);
});
