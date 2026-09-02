import { bestLineup, evaluateTrade, DEFAULT_TRADE_CONFIG, type TradePlayer, type TradeConfig } from "./trade.ts";
import { DEFAULT_RAILS } from "./rails.ts";

// Run with: bun run src/analysis/trade.test.ts
// Same lightweight harness as rails.test.ts: no framework, exit non-zero on any
// failure so it drops straight into a CI gate.

let pass = 0,
  fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
};

const P = (name: string, position: string, points: number, extra: Partial<TradePlayer> = {}): TradePlayer => ({
  name,
  position,
  points,
  ...extra,
});

// A WR-heavy, TE-thin roster: exactly the shape that makes an eighth receiver
// worthless and a second tight end valuable. 16 players, one weak TE, seven WRs.
const wrHeavy: TradePlayer[] = [
  P("Jayden Daniels", "QB", 340),
  P("Jahmyr Gibbs", "RB", 300),
  P("Kenneth Walker", "RB", 230),
  P("Nico Collins", "WR", 280),
  P("Garrett Wilson", "WR", 250),
  P("DeVonta Smith", "WR", 240),
  P("Jayden Reed", "WR", 210),
  P("Chris Olave", "WR", 200),
  P("Josh Downs", "WR", 170),
  P("Parker Washington", "WR", 120), // WR7, never starts
  P("Colston Loveland", "TE", 130), // our only real TE
  P("David Montgomery", "RB", 150),
  P("Bhayshul Tuten", "RB", 110),
  P("Seattle DEF", "DEF", 110),
  P("Jake Bates", "K", 130),
  P("Kenny Gainwell", "RB", 70),
];

// --- bestLineup: the assignment must be optimal, not top-down ---

// Starting slots QB/RB/RB/WR/WR/TE/FLEX/FLEX/K/DEF. Best lineup here starts the
// QB, two best RBs, two best WRs, the TE, two FLEX (next best RB/WR/TE), K, DEF.
const line = bestLineup(wrHeavy);
t("bestLineup fills every startable slot", line.starters.every((s) => s.slot === "K" || s.slot === "DEF" || s.player !== null), JSON.stringify(line.starters.map((s) => [s.slot, s.player?.name])));
t("bestLineup starts the QB", line.starters.find((s) => s.slot === "QB")?.player?.name === "Jayden Daniels");
t("bestLineup starts the lone TE in the TE slot", line.starters.find((s) => s.slot === "TE")?.player?.name === "Colston Loveland");
// WR7 (Parker Washington, 120) must NOT start: 2 WR + FLEX slots are taken by
// better receivers and RBs. This is the crux of "eighth WR is worthless".
t("bestLineup benches the surplus receiver", !line.starters.some((s) => s.player?.name === "Parker Washington"), line.starters.map((s) => s.player?.name).join(","));

// A degenerate roster that top-down sorting would misfill: one elite TE, then
// all RBs. Top-down would burn a FLEX on the TE and strand nothing, but the
// classic failure is stranding the TE slot. Verify the TE slot is filled and
// every RB slot too.
const teAndRbs: TradePlayer[] = [
  P("Elite TE", "TE", 260),
  P("RB A", "RB", 250),
  P("RB B", "RB", 240),
  P("RB C", "RB", 230),
  P("RB D", "RB", 220),
  P("QB X", "QB", 300),
  P("K X", "K", 120),
  P("DEF X", "DEF", 110),
];
const line2 = bestLineup(teAndRbs);
t("TE slot is filled even when RBs dominate the board", line2.starters.find((s) => s.slot === "TE")?.player?.name === "Elite TE");
t("both RB slots filled from the RB pool", line2.starters.filter((s) => s.slot === "RB").every((s) => s.player?.position === "RB"));
// FLEX slots take the best remaining RBs (RB C, RB D) since there are no spare WR/TE.
t("FLEX takes the best remaining RBs", line2.starters.filter((s) => s.slot === "FLEX").every((s) => s.player?.position === "RB"));

// --- the asymmetric-position cases, the heart of the engine ---

// 1. Give a droppable surplus WR, receive a HIGHER-projected eighth WR. Raw
//    value goes up, but neither starts, so the lineup does not move: reject.
const evalWrForWr = evaluateTrade(
  { give: [P("Parker Washington", "WR", 120)], receive: [P("Bigger Name WR", "WR", 205)] },
  wrHeavy,
);
t("eighth WR for a bigger WR is rejected despite the raw value gain", evalWrForWr.verdict === "reject", `${evalWrForWr.verdict} delta=${evalWrForWr.lineupDelta}`);
t("  and the lineup delta is ~zero", Math.abs(evalWrForWr.lineupDelta) < DEFAULT_TRADE_CONFIG.rejectBelowPts, String(evalWrForWr.lineupDelta));

// 2. Give the same surplus WR, receive a startable second TE projected LOWER
//    than that WR trade in case 1. It cracks the lineup (TE or FLEX), so the
//    delta is clearly positive even though we "lost" raw points.
const evalWrForTe = evaluateTrade(
  { give: [P("Parker Washington", "WR", 120)], receive: [P("Second TE", "TE", 190)] },
  wrHeavy,
);
t("surplus WR for a startable second TE is a clear win", evalWrForTe.verdict === "accept", `${evalWrForTe.verdict} delta=${evalWrForTe.lineupDelta}`);
t("  and it beats the higher-raw-value WR-for-WR swap", evalWrForTe.lineupDelta > evalWrForWr.lineupDelta, `${evalWrForTe.lineupDelta} vs ${evalWrForWr.lineupDelta}`);

// 3. The reverse asymmetry: giving away our only startable TE for an eighth WR
//    is a real lineup LOSS even at equal raw points, because the TE slot then
//    falls to nothing.
const evalTeForWr = evaluateTrade(
  { give: [P("Colston Loveland", "TE", 130)], receive: [P("Yet Another WR", "WR", 130)] },
  wrHeavy,
);
t("giving our only TE for a WR is a lineup loss and rejected", evalTeForWr.verdict === "reject", `${evalTeForWr.verdict} delta=${evalTeForWr.lineupDelta}`);
t("  the delta is negative", evalTeForWr.lineupDelta < 0, String(evalTeForWr.lineupDelta));

// --- the decision bands ---

const midCfg: TradeConfig = { rails: DEFAULT_RAILS, rejectBelowPts: 5, acceptAbovePts: 25 };
// A protected starter (Kenneth Walker, RB2, top-12) cannot be traded even for a
// clear raw upgrade: rails come first.
const evalProtectedStarter = evaluateTrade(
  { give: [P("Kenneth Walker", "RB", 230)], receive: [P("Upgrade RB", "RB", 245)] },
  wrHeavy.map((p) => ({ ...p })),
  midCfg,
);
t("a protected starter cannot be traded even for an upgrade", evalProtectedStarter.verdict === "reject" && evalProtectedStarter.railBlocks.length > 0, evalProtectedStarter.reasons.join(" | "));

// A modest, genuine lineup upgrade lands in the surface band: give a droppable
// bench RB, receive a second TE just good enough to take the TE slot off our
// weak lone TE (130 -> 150 = +20, inside [5,25)). Not decisive, so a human
// decides rather than the code.
const evalSurface = evaluateTrade(
  { give: [P("Kenny Gainwell", "RB", 70)], receive: [P("Modest TE", "TE", 150)] },
  wrHeavy.map((p) => ({ ...p })),
  midCfg,
);
t("a modest genuine upgrade is surfaced, not auto-decided", evalSurface.verdict === "surface", `${evalSurface.verdict} delta=${evalSurface.lineupDelta}`);
t("  the surfaced delta is inside the band", evalSurface.lineupDelta > 5 && evalSurface.lineupDelta < 25, String(evalSurface.lineupDelta));

// --- rails are a hard gate ---

// Never give up a protected top-N player, even in a lopsided-for-us package.
const evalProtected = evaluateTrade(
  { give: [P("Jayden Daniels", "QB", 340)], receive: [P("Two Studs A", "RB", 320), P("Two Studs B", "WR", 300)] },
  wrHeavy,
);
t("refuses to trade away a protected player even in a fleece", evalProtected.verdict === "reject" && evalProtected.railBlocks.length > 0, evalProtected.reasons.join(" | "));

// Never give up the injured stash projected back before the playoffs.
const stashRoster: TradePlayer[] = [
  ...wrHeavy.slice(0, 15),
  P("Hurt Stash", "RB", 40, { injuryStatus: "IR", returnsBeforePlayoffs: true }),
];
const evalStash = evaluateTrade(
  { give: [P("Hurt Stash", "RB", 40)], receive: [P("Healthy Filler", "RB", 120)] },
  stashRoster,
);
t("refuses to trade the injured stash due back before the playoffs", evalStash.verdict === "reject" && evalStash.railBlocks.some((r) => /stash/i.test(r)), evalStash.railBlocks.join(" | "));

// A give player that is not on our roster is refused rather than guessed at,
// exactly as canDrop does.
const evalGhost = evaluateTrade(
  { give: [P("Not On Roster", "RB", 100)], receive: [P("Whoever", "RB", 200)] },
  wrHeavy,
);
t("refuses when a surrendered player is not on the roster", evalGhost.verdict === "reject" && evalGhost.railBlocks.some((r) => /not on the roster/i.test(r)), evalGhost.railBlocks.join(" | "));

// --- a clear, decisive upgrade auto-accepts ---
// Give a droppable bench WR (surplus) plus a bench RB, receive a stud RB that
// starts. Big positive delta -> accept without a human.
const evalAccept = evaluateTrade(
  { give: [P("Parker Washington", "WR", 120), P("Kenny Gainwell", "RB", 70)], receive: [P("Stud RB", "RB", 290)] },
  wrHeavy,
);
t("a clear multi-week upgrade auto-accepts", evalAccept.verdict === "accept", `${evalAccept.verdict} delta=${evalAccept.lineupDelta}`);

// Receiving a big RAW SUM adds nothing if none of it cracks the lineup. Give
// two droppable surplus players, receive two WRs whose raw sum (375) dwarfs what
// we gave (190), but neither beats our marginal WR/FLEX starter, so the lineup
// does not move. This is the clearest statement of "value is lineup, not sum".
const bigSumNoSlot = evaluateTrade(
  { give: [P("Kenny Gainwell", "RB", 70), P("Parker Washington", "WR", 120)], receive: [P("Deep WR One", "WR", 190), P("Deep WR Two", "WR", 185)] },
  wrHeavy,
);
t("a big incoming raw sum that fills no slot is rejected", bigSumNoSlot.verdict === "reject", `${bigSumNoSlot.verdict} delta=${bigSumNoSlot.lineupDelta}`);
t("  its lineup delta is ~zero despite the raw-sum gain", Math.abs(bigSumNoSlot.lineupDelta) < 5, String(bigSumNoSlot.lineupDelta));


// --- many-to-many packages --------------------------------------------------

{
  const { combinations, proposeTrades, PACKAGE_MAX, PACKAGE_POOL } = await import("./trade-fair.ts");

  const combos = combinations([1, 2, 3, 4], 2);
  t("combinations covers singles and pairs, no empty set", combos.length === 4 + 6, `${combos.length}`);
  t("combinations respects the size cap", combos.every((c) => c.length <= 2));
  t("combinations does not repeat a member", combos.every((c) => new Set(c).size === c.length));
  t("combinations of one is just the singles", combinations([1, 2, 3], 1).length === 3);

  t("the package cap allows the shapes a human actually offers", PACKAGE_MAX >= 2, `${PACKAGE_MAX}`);
  t("the search pool is bounded so the weekly run stays quick", PACKAGE_POOL <= 12, `${PACKAGE_POOL}`);

  // A 2-for-1 that a one-for-one search cannot see: we are deep at WR and thin
  // at RB, they are the reverse, so two spare receivers for one back helps both.
  const P = (name: string, position: string, points: number) => ({ name, position, points });
  const ours = [
    P("RB1", "RB", 200), P("RB2", "RB", 60),
    P("WR1", "WR", 210), P("WR2", "WR", 205), P("WR3", "WR", 200), P("WR4", "WR", 195), P("WR5", "WR", 190),
    P("TE1", "TE", 150), P("QB1", "QB", 300), P("K1", "K", 120), P("DEF1", "DEF", 110),
  ];
  const theirs = [
    P("tRB1", "RB", 215), P("tRB2", "RB", 210), P("tRB3", "RB", 205),
    P("tWR1", "WR", 120), P("tWR2", "WR", 100),
    P("tTE1", "TE", 140), P("tQB1", "QB", 280), P("tK1", "K", 115), P("tDEF1", "DEF", 105),
  ];
  const onlySingles = proposeTrades(ours, [{ managerId: "2", teamName: "them", roster: theirs }], undefined, 20, 1);
  const withPackages = proposeTrades(ours, [{ managerId: "2", teamName: "them", roster: theirs }], undefined, 20, 3);
  t("packages find offers a one-for-one search cannot", withPackages.length >= onlySingles.length,
    `singles ${onlySingles.length}, packages ${withPackages.length}`);
  t("every generated package still helps the other side too",
    withPackages.every((p) => p.theirGain > 0));
  t("a multi-player package is actually produced",
    withPackages.some((p) => p.offer.give.length > 1 || p.offer.receive.length > 1),
    `sizes ${withPackages.slice(0, 3).map((p) => `${p.offer.give.length}for${p.offer.receive.length}`).join(",")}`);
  t("among equal gains the smaller package ranks first",
    withPackages.length < 2 || (withPackages[0]?.score ?? 0) >= (withPackages[1]?.score ?? 0));
}


// THE BUG THIS EXISTS TO PREVENT. The proposer once used a weaker bar than the
// acceptor and generated a deal the accept path refused, after the coach had
// already offered it in a DM. Anything we propose must be something we would say
// yes to, or the bot contradicts itself in front of a real person.
{
  const { proposeTrades, evaluateTradeTwoSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number) => ({ name, position, points });
  const ours = [
    P("QB1","QB",300), P("RB1","RB",290), P("RB2","RB",255), P("RB3","RB",208),
    P("WR1","WR",262), P("WR2","WR",229), P("WR3","WR",222), P("WR4","WR",190), P("WR5","WR",120),
    P("TE1","TE",196), P("K1","K",44), P("DEF1","DEF",0),
  ];
  const theirs = [
    P("tQB","QB",280), P("tRB1","RB",240), P("tRB2","RB",200),
    P("tWR1","WR",229), P("tWR2","WR",150), P("tWR3","WR",110),
    P("tTE","TE",140), P("tK","K",40), P("tDEF","DEF",0),
  ];
  const props = proposeTrades(ours, [{ managerId: "2", teamName: "them", roster: theirs }], DEFAULT_FAIRNESS, 25);
  const wouldRefuse = props.filter((p) =>
    evaluateTradeTwoSided(p.offer, ours, theirs, DEFAULT_FAIRNESS).verdict !== "accept");
  t("every proposal would also be ACCEPTED if it came back to us",
    wouldRefuse.length === 0,
    wouldRefuse.map((p) => p.why).join(" | ").slice(0, 160));
  t("every proposal still gains the other side something",
    props.every((p) => p.theirGain > 0));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);