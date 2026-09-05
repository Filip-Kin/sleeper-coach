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

  // A package a one-for-one search cannot see. We are WR-rich with a hole at RB2;
  // they are RB-rich and WR-poor. Two spare receivers for a back helps us a lot
  // and them a little, which is exactly the shape a human offers and a
  // single-player search can never construct.
  const P = (name: string, position: string, points: number) => ({ name, position, points });
  const ours = [
    P("QB1","QB",300), P("RB1","RB",280), P("RBbad","RB",60),
    P("WRa","WR",250), P("WRb","WR",245), P("WRc","WR",240), P("WRd","WR",235), P("WRe","WR",230),
    P("TE1","TE",190), P("K1","K",44), P("DEF1","DEF",10),
  ];
  const theirs = [
    P("tQB","QB",290), P("tRB1","RB",270), P("tRB2","RB",265), P("tRB3","RB",260),
    P("tWRa","WR",90), P("tWRb","WR",80),
    P("tTE","TE",185), P("tK","K",42), P("tDEF","DEF",8),
  ];
  const rival = [{ managerId: "2", teamName: "them", roster: theirs }];
  const onlySingles = proposeTrades(ours, rival, undefined, 20, 1);
  const withPackages = proposeTrades(ours, rival, undefined, 20, 3);
  t("packages find offers a one-for-one search cannot",
    withPackages.length > onlySingles.length,
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

// --- bye-aware valuation ----------------------------------------------------
// A season total cannot see a position with nobody eligible in some week. Our
// roster carried exactly one tight end, so his bye week started NOBODY at TE and
// scored zero, and the engine read a trade fixing that as a flat +0.
{
  const { byeAwareLineupTotal, byeAwareGain, evaluateTradeTwoSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number, bye?: number) => ({ name, position, points, bye });
  const oneTE = [
    P("QB1","QB",300), P("RB1","RB",290), P("RB2","RB",255), P("RB3","RB",240),
    P("WR1","WR",262), P("WR2","WR",229), P("WR3","WR",222), P("WR4","WR",212,7),
    P("TE1","TE",196,6), P("K1","K",44), P("DEF1","DEF",10),
  ];
  const weeks = [5,6,7,8];

  t("with no weeks given it matches the season total exactly",
    byeAwareLineupTotal(oneTE, []) === (await import("./trade.ts")).bestLineup(oneTE).total);

  t("a roster with no byes in the window is valued the same either way",
    byeAwareLineupTotal(oneTE.map((p) => ({ ...p, bye: undefined })), weeks)
      === byeAwareLineupTotal(oneTE.map((p) => ({ ...p, bye: undefined })), []));

  const withTE2 = byeAwareGain(oneTE, { receive: [P("TE2","TE",162,13)], give: [P("WR4","WR",212,7)] }, weeks);
  t("adding a second TE is worth real points when the only TE has a bye",
    withTE2 > 0, `${withTE2}`);

  // The same swap with no bye conflict anywhere is a wash, since neither player
  // cracks the lineup: this is what the season-total model always said.
  const noBye = oneTE.map((p) => ({ ...p, bye: undefined }));
  const flat = byeAwareGain(noBye, { receive: [P("TE2","TE",162)], give: [P("WR4","WR",212)] }, weeks);
  t("without a bye hole the same swap stays a wash", Math.abs(flat) < 0.05, `${flat}`);
}

// --- a ceiling on how strong we make somebody else ---------------------------
{
  const { evaluateTradeTwoSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number) => ({ name, position, points });
  const ours = [
    P("QB1","QB",300), P("RB1","RB",290), P("RB2","RB",255), P("WR1","WR",262),
    P("WR2","WR",229), P("TE1","TE",196), P("K1","K",44), P("DEF1","DEF",10), P("SPARE","WR",120),
  ];
  const theirs = [
    P("tQB","QB",100), P("tRB1","RB",90), P("tRB2","RB",80), P("tWR1","WR",70),
    P("tWR2","WR",60), P("tTE","TE",50), P("tK","K",20), P("tDEF","DEF",5), P("GEM","WR",55),
  ];
  // Never play them again, so dilution would otherwise wave anything through.
  const cfg = { ...DEFAULT_FAIRNESS, headToHeadRemaining: 0, maxTheirGainPts: 15 };
  const ev = evaluateTradeTwoSided({ receive: [P("GEM","WR",55)], give: [P("WR1","WR",262)] }, ours, theirs, cfg);
  t("a huge gift to a rival is blocked even with no head-to-head left",
    ev.fairnessBlocks.some((b) => /ceiling/i.test(b)) || ev.verdict === "reject",
    `${ev.verdict} theirGain ${ev.theirGain}`);
}

// --- the margin is the value at RISK, not raw projection -------------------
// cookieeater45 offered Andrews for Washington, bench for bench. Washington is
// worth 0 to our lineup, yet the margin was scaled off his 212 raw points and
// demanded 17. A projection error on a player who never starts cannot move our
// score, so it cannot be the reason to refuse.
{
  const { requiredEdge, depthInsurance, evaluateTradeTwoSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number, bye?: number) => ({ name, position, points, bye });
  const ours = [
    P("QB1","QB",310), P("QB2","QB",300), P("RB1","RB",291), P("RB2","RB",255), P("RB3","RB",244), P("RB4","RB",208),
    P("WR1","WR",262), P("WR2","WR",229), P("WR3","WR",222), P("WR4bench","WR",212,7), P("WR5","WR",198),
    P("TE1","TE",196,6), P("K1","K",44), P("DEF1","DEF",0),
  ];
  // Their receivers are strong so our bench WR does not crack their lineup:
  // this mirrors the real Andrews offer, where their gain was negative.
  // A FULL roster, or an empty FLEX makes any bench player look like a 46-point
  // upgrade for them and the rival-gain ceiling fires. That first fixture was
  // ten men; the engine was right to reject it.
  const theirs = [
    P("tQB","QB",280), P("tRB1","RB",240), P("tRB2","RB",230), P("tRB3","RB",225), P("tRB4","RB",190),
    P("tWR1","WR",250), P("tWR2","WR",240), P("tWR3","WR",235), P("tWR4","WR",228), P("tWR5","WR",150),
    P("tTE1","TE",185), P("tTE2","TE",162,13), P("tK","K",40), P("tDEF","DEF",0),
  ];
  const benchSwap = { receive: [P("tTE2","TE",162,13)], give: [P("WR4bench","WR",212,7)] };
  const starterSwap = { receive: [P("tWR1","WR",229)], give: [P("WR1","WR",262)] };

  const benchNeed = requiredEdge(benchSwap, DEFAULT_FAIRNESS, ours);
  const starterNeed = requiredEdge(starterSwap, DEFAULT_FAIRNESS, ours);
  t("giving up a bench player needs only the flat floor", benchNeed === DEFAULT_FAIRNESS.flatMarginPts, `${benchNeed}`);
  t("giving up a starter still needs a real margin", starterNeed > benchNeed * 3, `${starterNeed} vs ${benchNeed}`);

  // Depth: one TE is a single point of failure; a second one is insurance.
  const teOnly = { ...DEFAULT_FAIRNESS, depthPositions: ["TE"] };
  const noBackup = depthInsurance(ours, teOnly);
  const withBackup = depthInsurance([...ours, P("TE2","TE",162)], teOnly);
  t("a lone TE carries no insurance value", noBackup === 0, `${noBackup}`);
  // 162 x 0.12 x 0.6 = 11.7 season points: real, but well under a starter upgrade.
  t("a second TE is worth a modest season-scale amount", withBackup > 5 && withBackup < 20, `${withBackup}`);
  t("a third TE adds nothing more", depthInsurance([...ours, P("TE2","TE",162), P("TE3","TE",150)], teOnly) === withBackup);
  t("QB2 is insurance too", depthInsurance(ours, { ...DEFAULT_FAIRNESS, depthPositions: ["QB"] }) > 5);
  // Filip's week-10 QB: the cover is worth the most where there is exactly one
  // starter and one backup, and it is the gap to the NEXT man that matters.
  const wrOnly = { ...DEFAULT_FAIRNESS, depthPositions: ["WR"] };
  const deepBench = [...ours, P("WR6","WR",205), P("WR7","WR",200)];
  const loseWR4 = depthInsurance(deepBench, wrOnly) - depthInsurance(deepBench.filter((p) => p.name !== "WR4bench"), wrOnly);
  const loseLastWR = depthInsurance(ours, wrOnly) - depthInsurance(ours.filter((p) => p.name !== "WR4bench" && p.name !== "WR5"), wrOnly);
  t("a bench WR is worth something as cover", loseWR4 > 0, `${loseWR4}`);
  t("losing him costs less when a good WR5 stands behind him than losing the whole bench", loseWR4 < loseLastWR, `${loseWR4} vs ${loseLastWR}`);
  t("a fourth backup adds almost nothing", depthInsurance([...deepBench, P("WR8","WR",195)], wrOnly) - depthInsurance(deepBench, wrOnly) < 1);
  const { atLeastKOut } = await import("./trade-fair.ts");
  t("P(at least one of three starters out) is about 1-(1-p)^3", Math.abs(atLeastKOut(3, 1, 0.12) - (1 - 0.88 ** 3)) < 1e-9);
  t("P(more holes than starters) is zero", atLeastKOut(1, 2, 0.12) === 0);

  // Put together: the bench-for-bench swap that fixes a bye hole AND adds cover
  // is now accepted, and a starter-for-downgrade is still refused.
  const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], headToHeadRemaining: 2, remainingWeeks: 15 };
  const good = evaluateTradeTwoSided(benchSwap, ours, theirs, cfg);
  t("a free bye fix plus insurance is accepted", good.verdict === "accept", `${good.verdict} our ${good.ourGain} need ${good.requiredEdge}`);
  t("its reasons mention the injury cover", good.reasons.some((r) => /injury cover/.test(r)), good.reasons.join(" | ").slice(0, 200));
  const bad = evaluateTradeTwoSided(starterSwap, ours, theirs, cfg);
  t("a starter for a downgrade is still refused", bad.verdict === "reject", `${bad.verdict} our ${bad.ourGain}`);
}

// --- the depth chart contradicts the projection ------------------------------
// The Jacobs shape: projects like a starter, listed 4th on his own team. The
// injury flag happened to catch him; this catches the ones it would not.
{
  const { refusedForDepth, evaluateTradeTwoSided, proposeTrades, DEFAULT_FAIRNESS, DEPTH_REFUSE_AT } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number, depth?: number) => ({ name, position, points, depthChartOrder: depth });
  t("a skill player buried on the depth chart is refused", refusedForDepth(P("Jacobs","RB",250,4)) !== null);
  t("the refusal names the depth chart, so a rival hears the real reason",
    /depth chart/.test(refusedForDepth(P("Jacobs","RB",250,4)) ?? ""));
  t("a starter is not refused", refusedForDepth(P("CMC","RB",291,1)) === null);
  t("a clear number two is not refused either", refusedForDepth(P("RB2","RB",200,2)) === null);
  t("the line is at " + DEPTH_REFUSE_AT, refusedForDepth(P("x","WR",200,DEPTH_REFUSE_AT)) !== null && refusedForDepth(P("x","WR",200,DEPTH_REFUSE_AT-1)) === null);
  t("a missing depth value never blocks", refusedForDepth(P("unknown","WR",200)) === null);
  t("kickers and defences are ignored", refusedForDepth(P("K","K",44,3)) === null && refusedForDepth(P("SEA","DEF",0,3)) === null);

  const ours = [P("QB1","QB",310,1), P("RB1","RB",291,1), P("RB2","RB",255,1), P("WR1","WR",262,1), P("WR2","WR",229,1),
    P("WR3","WR",222,2), P("TE1","TE",196,1), P("K1","K",44), P("DEF1","DEF",0), P("WRbench","WR",150,3)];
  const theirs = [P("tQB","QB",280,1), P("tRB1","RB",240,1), P("tRB2","RB",230,2), P("tWR1","WR",250,1), P("tWR2","WR",240,1),
    P("tTE","TE",185,1), P("tK","K",40), P("tDEF","DEF",0), P("SCAM","RB",300,4)];
  const ev = evaluateTradeTwoSided({ receive: [P("SCAM","RB",300,4)], give: [P("WR3","WR",222,2)] }, ours, theirs, DEFAULT_FAIRNESS);
  t("a tempting projection buried on the depth chart is refused in a real offer", ev.verdict === "reject" && ev.fairnessBlocks.some((b) => /depth chart/.test(b)), ev.verdict);
  const props = proposeTrades(ours, [{ managerId: "1", teamName: "t", roster: theirs }], DEFAULT_FAIRNESS, 20, 2);
  t("and the proposer never asks for him either", props.every((p) => !p.offer.receive.some((r) => r.name === "SCAM")));
}

// --- three-way trades --------------------------------------------------------
// A real proposal on 2026-09-04 gave up McCaffrey and Hurts to roster 1 for
// NOTHING, bundled with a fairer-looking Collins-and-Brown-for-Johnston leg
// against roster 2. The old two-sided path only ever looked at the FIRST other
// roster, so the second leg was invisible. These pin that every leg is seen.
{
  const { evaluateTradeMultiSided, evaluateTradeTwoSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number) => ({ name, position, points, depthChartOrder: 1 });

  const ours = [
    P("McCaffrey","RB",291), P("Hurts","QB",310), P("Collins","WR",262), P("Brown","RB",255),
    P("Walker","RB",244), P("Smith","WR",229), P("Evans","WR",222), P("LaPorta","TE",196),
    P("Prescott","QB",303), P("Bates","K",44), P("SEA","DEF",10),
  ];
  const r1 = [P("r1qb","QB",250), P("r1rb","RB",240), P("r1wr","WR",230), P("r1te","TE",180), P("r1k","K",40), P("r1d","DEF",8)];
  const r2 = [P("Johnston","WR",150), P("r2qb","QB",260), P("r2rb","RB",245), P("r2wr","WR",235), P("r2te","TE",185), P("r2k","K",42), P("r2d","DEF",9)];

  // Our side of the whole tangle: give McCaffrey, Hurts, Collins, Brown; get Johnston.
  const ourOffer = { receive: [P("Johnston","WR",150)], give: [P("McCaffrey","RB",291), P("Hurts","QB",310), P("Collins","WR",262), P("Brown","RB",255)] };
  // roster 1 receives McCaffrey + Hurts, gives NOTHING to us (the free rider).
  const r1side = { rosterId: 1, roster: r1, offer: { receive: [P("McCaffrey","RB",291), P("Hurts","QB",310)], give: [] as ReturnType<typeof P>[] } };
  // roster 2 receives Collins + Brown, gives Johnston.
  const r2side = { rosterId: 2, roster: r2, offer: { receive: [P("Collins","WR",262), P("Brown","RB",255)], give: [P("Johnston","WR",150)] } };

  const multi = evaluateTradeMultiSided(ourOffer, ours, [r1side, r2side], DEFAULT_FAIRNESS);
  t("the three-way fleece is rejected", multi.verdict === "reject", multi.verdict);
  t("both opponents' gains are computed, not just the first",
    multi.opponents.length === 2 && multi.opponents.every((o) => typeof o.theirGain === "number"),
    JSON.stringify(multi.opponents));
  t("the free-rider roster's gain is seen and it is large",
    (multi.opponents.find((o) => o.rosterId === 1)?.theirGain ?? 0) > 15,
    `${multi.opponents.find((o) => o.rosterId === 1)?.theirGain}`);
  t("the per-opponent ceiling names the free rider specifically",
    multi.fairnessBlocks.some((b) => /roster 1/.test(b)), multi.fairnessBlocks.join(" | "));

  // A single-opponent multi call must match the two-sided result exactly, so the
  // new path is a strict generalisation, not a second opinion.
  const soloOffer = { receive: [P("r1wr","WR",230)], give: [P("Evans","WR",222)] };
  const two = evaluateTradeTwoSided(soloOffer, ours, r1, DEFAULT_FAIRNESS);
  const one = evaluateTradeMultiSided(soloOffer, ours, [{ rosterId: 1, roster: r1, offer: { receive: [P("Evans","WR",222)], give: [P("r1wr","WR",230)] } }], DEFAULT_FAIRNESS);
  t("a one-opponent multi call matches the two-sided verdict", two.verdict === one.verdict, `${two.verdict} vs ${one.verdict}`);
  t("a one-opponent multi call matches the two-sided ourGain", Math.abs(two.ourGain - one.ourGain) < 0.05, `${two.ourGain} vs ${one.ourGain}`);

  // A GENUINELY FAIR three-way (everyone roughly even, we come out ahead) is
  // accepted, so this is not just a blanket "reject all three-ways".
  const fairOurs = [...ours];
  const fairOffer = { receive: [P("r2rb","RB",245)], give: [P("Evans","WR",222)] };
  const fairMulti = evaluateTradeMultiSided(
    fairOffer, fairOurs,
    [
      { rosterId: 1, roster: r1, offer: { receive: [P("Evans","WR",222)], give: [P("r1rb","RB",240)] } },
      { rosterId: 2, roster: r2, offer: { receive: [P("r1rb","RB",240)], give: [P("r2rb","RB",245)] } },
    ],
    { ...DEFAULT_FAIRNESS, minOwnGainPts: -999, maxTheirGainPts: 999 },
  );
  t("a balanced three-way is not blanket-rejected", fairMulti.verdict === "accept" || fairMulti.ourGain >= 0, `${fairMulti.verdict} our ${fairMulti.ourGain}`);
}

// --- streamable K/DEF cannot be used to fleece us --------------------------
// 2026-09-04: the coach ACCEPTED two backup kickers for nothing (+2.8 by the old
// math), which at a full roster means dropping two real players so a rival can
// scoop them. The +2.8 was a phantom: crediting a Jake-Bates-bye-week hole we
// would have streamed, plus crediting us for the rivals shedding their only
// kickers (also streamable). An empty K/DEF slot is worth a streamer, not zero.
{
  const { bestLineup } = await import("./trade.ts");
  const { evaluateTradeMultiSided, DEFAULT_FAIRNESS } = await import("./trade-fair.ts");
  const P = (name: string, position: string, points: number, bye?: number) => ({ name, position, points, bye, depthChartOrder: 1 });

  // An empty kicker slot scores replacement, not 0.
  const noK = [P("QB1","QB",300), P("RB1","RB",280), P("RB2","RB",250), P("WR1","WR",260), P("WR2","WR",230),
    P("WR3","WR",220), P("TE1","TE",190), P("DEF1","DEF",30)];
  const withK = [...noK, P("Bates","K",44)];
  const emptyKtotal = bestLineup(noK).total;
  const filledKtotal = bestLineup(withK).total;
  t("an empty kicker slot scores a streamer, not zero", emptyKtotal > 30, `${emptyKtotal}`);
  t("a real kicker is only marginally better than a streamer", filledKtotal - emptyKtotal < 10, `${filledKtotal - emptyKtotal}`);

  // The full roster, mirroring ours: one kicker (Bates, bye 6), one defense.
  const ours = [
    P("Hurts","QB",310), P("McCaffrey","RB",291), P("Brown","RB",255), P("Collins","WR",262),
    P("Smith","WR",229), P("Evans","WR",222), P("LaPorta","TE",196,6), P("Walker","RB",244),
    P("Prescott","QB",303), P("Bates","K",44,6), P("SEA","DEF",10), P("Washington","WR",212),
    P("Reed","WR",197), P("Metcalf","WR",183), P("Downs","WR",172), P("Etienne","RB",207),
  ];
  const r1 = [P("Myers","K",41), P("r1qb","QB",250), P("r1rb","RB",240), P("r1wr","WR",230), P("r1te","TE",180), P("r1d","DEF",8)];
  const r2 = [P("Fairbairn","K",40), P("r2qb","QB",255), P("r2rb","RB",245), P("r2wr","WR",235), P("r2te","TE",185), P("r2d","DEF",9)];

  // We receive both kickers, give nothing; each rival gives a kicker for nothing.
  const ourOffer = { receive: [P("Myers","K",41), P("Fairbairn","K",40)], give: [] as ReturnType<typeof P>[] };
  const multi = evaluateTradeMultiSided(ourOffer, ours, [
    { rosterId: 1, roster: r1, offer: { receive: [], give: [P("Myers","K",41)] } },
    { rosterId: 2, roster: r2, offer: { receive: [], give: [P("Fairbairn","K",40)] } },
  ], { ...DEFAULT_FAIRNESS, upcomingWeeks: Array.from({length:15},(_,i)=>i+1), headToHeadRemaining: 2, remainingWeeks: 15 });
  t("two backup kickers for nothing is REJECTED now", multi.verdict === "reject", `${multi.verdict} ourGain ${multi.ourGain}`);
  t("our gain from two streamable kickers is ~zero", Math.abs(multi.ourGain) < 3, `${multi.ourGain}`);
  t("the rivals are not credited a real loss for shedding streamable kickers",
    multi.opponents.every((o) => Math.abs(o.theirGain) < 5), JSON.stringify(multi.opponents));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);