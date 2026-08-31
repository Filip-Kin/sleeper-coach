import {
  classifyStarter,
  sideOutlook,
  winProbability,
  normalCdf,
  sigmaFor,
  VOLATILITY,
  MIN_SIGMA,
  type StarterLine,
} from "./win-prob.ts";

// Offline tests for the win-probability core. No network, no live data. These pin
// the properties the model MUST hold so a refactor cannot quietly change what the
// scoreboard tells Filip on a Sunday: the earned/to-come split, the way phase
// gates a zero, and that the probability is decided once nobody is left to play.

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

// --- classifyStarter: phase gates the meaning of a zero -----------------------
t("bye beats everything", classifyStarter(0, { onBye: true, unavailable: false, hasGame: true, phase: "live" }) === "bye");
t("ruled out is out", classifyStarter(0, { onBye: false, unavailable: true, hasGame: true, phase: "live" }) === "out");
t("live zero with a game is yet to play",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: true, phase: "live" }) === "toplay");
t("live positive is banked",
  classifyStarter(6.4, { onBye: false, unavailable: false, hasGame: true, phase: "live" }) === "banked");
t("past zero is banked, never counted as still to come",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: true, phase: "past" }) === "banked");
t("future healthy starter is yet to play",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: true, phase: "future" }) === "toplay");
t("live zero with no game is not invented upside",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: false, phase: "live" }) === "banked");

// --- sideOutlook: earned vs still to come -------------------------------------
const mixed: StarterLine[] = [
  { banked: 20, projection: 18, status: "banked" }, // playing, count at live, no extra
  { banked: 0, projection: 14, status: "toplay" }, // full projection to come
  { banked: 0, projection: 12, status: "toplay" },
  { banked: 0, projection: 8, status: "bye" }, // contributes nothing
  { banked: 0, projection: 9, status: "out" }, // contributes nothing
];
const out = sideOutlook(mixed);
t("banked sums only live points", near(out.banked, 20), `got ${out.banked}`);
t("toCome sums only yet-to-play projections", near(out.toCome, 26), `got ${out.toCome}`);
t("expected is banked + toCome", near(out.expected, 46), `got ${out.expected}`);
t("yetToPlay counts only toplay", out.yetToPlay === 2, `got ${out.yetToPlay}`);
t("played counts only banked", out.played === 1, `got ${out.played}`);

// --- winProbability -----------------------------------------------------------
// A finished matchup is decided: no starters left, probability collapses to 0/1.
const finalUs = sideOutlook([{ banked: 120, projection: 0, status: "banked" }]);
const finalOppWin = sideOutlook([{ banked: 110, projection: 0, status: "banked" }]);
const finalOppLose = sideOutlook([{ banked: 130, projection: 0, status: "banked" }]);
t("won game is prob 1 and decided", (() => { const w = winProbability(finalUs, finalOppWin); return w.prob === 1 && w.decided; })());
t("lost game is prob 0 and decided", winProbability(finalUs, finalOppLose).prob === 0);
t("exact tie with nobody left is 0.5", winProbability(finalUs, sideOutlook([{ banked: 120, projection: 0, status: "banked" }])).prob === 0.5);

// A dead-even projected matchup with players still to play is a coin flip.
const even = sideOutlook([{ banked: 0, projection: 100, status: "toplay" }]);
t("even expected totals give ~50%", near(winProbability(even, even).prob, 0.5, 0.001));

// A lead is worth more when fewer players remain to erase it: same 12-point edge is
// a higher win probability with two starters left than with eighteen.
const leadFew = winProbability(
  sideOutlook([{ banked: 62, projection: 12, status: "toplay" }]),
  sideOutlook([{ banked: 62, projection: 0, status: "banked" }]),
);
const many: StarterLine[] = Array.from({ length: 9 }, () => ({ banked: 0, projection: 12, status: "toplay" as const }));
const manyPlusLead: StarterLine[] = [...many, { banked: 12, projection: 12, status: "banked" }];
const leadMany = winProbability(sideOutlook(manyPlusLead), sideOutlook(many));
t("a 12pt edge is stronger with fewer players left", leadFew.prob > leadMany.prob, `few ${leadFew.prob} many ${leadMany.prob}`);
t("win prob for a real lead is above half", leadFew.prob > 0.5 && leadMany.prob > 0.5);

// --- normalCdf sanity ---------------------------------------------------------
t("normalCdf(0) = 0.5", near(normalCdf(0), 0.5, 1e-6));
t("normalCdf(1.645) ~ 0.95", near(normalCdf(1.645), 0.95, 0.005));
t("normalCdf is symmetric", near(normalCdf(-1) + normalCdf(1), 1, 1e-6));

// --- live game state is authoritative when present ---------------------------
// The whole reason src/data/nfl-games.ts exists: a zero means opposite things
// before and after kickoff, and only the real game state can tell them apart.
t("gameState post makes a zero banked, not still-to-come",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: true, phase: "live", gameState: "post" }) === "banked");
t("gameState pre keeps a starter as yet to play",
  classifyStarter(0, { onBye: false, unavailable: false, hasGame: true, phase: "live", gameState: "pre" }) === "toplay");
t("gameState in marks a starter live",
  classifyStarter(6.4, { onBye: false, unavailable: false, hasGame: true, phase: "live", gameState: "in" }) === "live");
t("bye still outranks a live game state",
  classifyStarter(0, { onBye: true, unavailable: false, hasGame: true, phase: "live", gameState: "in" }) === "bye");
t("ruled out still outranks a live game state",
  classifyStarter(0, { onBye: false, unavailable: true, hasGame: true, phase: "live", gameState: "in" }) === "out");

// --- a live starter extrapolates only the unplayed part of his game ----------
const halfLeft = sideOutlook([{ banked: 10, projection: 20, status: "live", fracRemaining: 0.5 }]);
t("live starter banks his real points", near(halfLeft.banked, 10), `got ${halfLeft.banked}`);
t("live starter contributes projection * fracRemaining", near(halfLeft.toCome, 10), `got ${halfLeft.toCome}`);
t("live starter counts in inPlay, not yetToPlay",
  halfLeft.inPlay === 1 && halfLeft.yetToPlay === 0, `inPlay ${halfLeft.inPlay} yetToPlay ${halfLeft.yetToPlay}`);

// With no clock supplied we must NOT invent one: he counts at his live total only.
const noClock = sideOutlook([{ banked: 10, projection: 20, status: "live" }]);
t("live starter with no clock extrapolates nothing", near(noClock.toCome, 0), `got ${noClock.toCome}`);
t("live starter with no clock adds no variance", noClock.variance === 0, `got ${noClock.variance}`);

// A finished game leaves nothing to come even if a projection is still attached.
const done = sideOutlook([{ banked: 14, projection: 20, status: "live", fracRemaining: 0 }]);
t("fracRemaining 0 leaves nothing to come", near(done.toCome, 0) && done.variance === 0);

// --- sigma is proportional, with a floor -------------------------------------
t("sigma is proportional above the floor", near(sigmaFor(20), VOLATILITY * 20, 1e-9), `got ${sigmaFor(20)}`);
t("sigma floors for a low projection", sigmaFor(1) === MIN_SIGMA, `got ${sigmaFor(1)}`);
t("a big projection carries more spread than a small one", sigmaFor(24) > sigmaFor(8));

// Variance shrinks as a game runs down, so the same lead is safer later. Half a
// game left must carry MORE uncertainty than a quarter, and less than all of it.
const varAt = (frac: number) => sideOutlook([{ banked: 0, projection: 20, status: "live", fracRemaining: frac }]).variance;
t("uncertainty falls as the game runs down", varAt(1) > varAt(0.5) && varAt(0.5) > varAt(0.25));
// sqrt scaling: variance is linear in the fraction remaining.
t("variance is linear in the fraction remaining", near(varAt(0.5), varAt(1) * 0.5, 1e-6), `${varAt(0.5)} vs ${varAt(1) * 0.5}`);

// --- bye and out contribute nothing to either total -------------------------
const dead = sideOutlook([
  { banked: 0, projection: 18, status: "bye" },
  { banked: 0, projection: 15, status: "out" },
]);
t("bye and out add no points and no variance",
  dead.toCome === 0 && dead.expected === 0 && dead.variance === 0);

// --- the reported number is honest about its own precision -------------------
const live = winProbability(
  sideOutlook([{ banked: 40, projection: 12, status: "toplay" }]),
  sideOutlook([{ banked: 30, projection: 12, status: "toplay" }]),
);
t("percent is a whole number", Number.isInteger(live.percent), `got ${live.percent}`);
t("percent matches prob", live.percent === Math.round(live.prob * 100));
t("a live matchup states its assumptions", live.assumptions.length >= 3 && !live.decided);
t("basis names the players yet to finish", live.basis.includes("yet to finish"), live.basis);
t("a decided matchup says so instead of modelling",
  winProbability(sideOutlook([{ banked: 100, projection: 0, status: "banked" }]),
                 sideOutlook([{ banked: 90, projection: 0, status: "banked" }])).basis.startsWith("Won"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
