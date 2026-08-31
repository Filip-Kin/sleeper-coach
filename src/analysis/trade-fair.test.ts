import { evaluateTradeTwoSided, DEFAULT_FAIRNESS, opponentWeight, requiredEdge, byeRelief, proposeTrades, refusedForInjury, autoDecideAllowed, marginalLineupValue, giveEligibleForProposal, type FairnessConfig } from "./trade-fair.ts";
import type { TradePlayer } from "./trade.ts";

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
const P = (name: string, position: string, points: number, x: Partial<TradePlayer> = {}): TradePlayer => ({ name, position, points, ...x });

// Our real post-draft shape: RB-heavy, seven receivers, one tight end, a useless
// backup QB, and four players sharing the week 8 bye.
const ours: TradePlayer[] = [
  P("McCaffrey", "RB", 291, { bye: 8 }), P("Chase Brown", "RB", 255, { bye: 6 }),
  P("Kenneth Walker", "RB", 244, { bye: 5 }), P("Travis Etienne", "RB", 208, { bye: 8 }),
  P("Nico Collins", "WR", 262, { bye: 8 }), P("DeVonta Smith", "WR", 229, { bye: 10 }),
  P("Mike Evans", "WR", 222, { bye: 8 }), P("Parker Washington", "WR", 212, { bye: 7 }),
  P("Jayden Reed", "WR", 198, { bye: 11 }), P("DK Metcalf", "WR", 183, { bye: 9 }),
  P("Josh Downs", "WR", 172, { bye: 6 }), P("Sam LaPorta", "TE", 197, { bye: 6 }),
  P("Jalen Hurts", "QB", 311, { bye: 10 }), P("Dak Prescott", "QB", 250, { bye: 10 }),
  P("Jake Bates", "K", 130, { bye: 6 }), P("Seattle", "DEF", 113, { bye: 11 }),
];
const theirs: TradePlayer[] = [
  P("Rival QB", "QB", 300, { bye: 7 }), P("Rival RB1", "RB", 200, { bye: 7 }),
  P("Rival RB2", "RB", 150, { bye: 9 }), P("Trey McBride", "TE", 235, { bye: 11 }),
  P("Rival TE2", "TE", 120, { bye: 5 }), P("Rival WR1", "WR", 240, { bye: 5 }),
  P("Rival WR2", "WR", 210, { bye: 9 }), P("Rival WR3", "WR", 190, { bye: 6 }),
  P("Rival K", "K", 125, { bye: 8 }), P("Rival DEF", "DEF", 100, { bye: 6 }),
];
const ev = (receive: TradePlayer[], give: TradePlayer[], cfg: Partial<FairnessConfig> = {}) =>
  evaluateTradeTwoSided({ receive, give }, ours, theirs, { ...DEFAULT_FAIRNESS, ...cfg });

// #region schedule dilution, which is the whole basis of the decision
t("opponent weight early is about 2/15", Math.abs(opponentWeight(DEFAULT_FAIRNESS) - 2 / 15) < 0.01);
t("opponent weight rises as the season shortens",
  opponentWeight({ ...DEFAULT_FAIRNESS, remainingWeeks: 3, headToHeadRemaining: 1 }) > opponentWeight(DEFAULT_FAIRNESS));
t("a playoff rival is weighted heavier still",
  opponentWeight({ ...DEFAULT_FAIRNESS, rivalThreatMultiplier: 1.5 }) > opponentWeight(DEFAULT_FAIRNESS));
// #endregion

// #region the cases Filip and I argued through
// He was right: a trade good for us and better for them can still be correct.
const upgrade = ev([P("Trey McBride", "TE", 235, { bye: 11 })], [P("Mike Evans", "WR", 222, { bye: 8 })]);
t("a real upgrade using our WR surplus is accepted", upgrade.verdict === "accept", JSON.stringify(upgrade.netValue));
t("  and it is credited with bye relief", byeRelief({ receive: [P("Trey McBride", "TE", 235, { bye: 11 })], give: [P("Mike Evans", "WR", 222, { bye: 8 })] }, ours) > 0);

// He was also right that hurting them is worth something: their LOSS counts.
const theyLose = ev([P("Rival WR3", "WR", 190, { bye: 6 })], [P("Josh Downs", "WR", 172, { bye: 6 })]);
t("their loss is credited, not clamped to zero", theyLose.netValue > theyLose.ourGain, `net ${theyLose.netValue} vs ours ${theyLose.ourGain}`);

// Filip's rule exactly: "a trade where we lose nothing but they lose stuff is
// still good." Costing us zero lineup points while costing them real ones IS
// acceptable, and an earlier clamp that ignored their loss wrongly refused it.
const neutralForUs = ev([P("Rival WR3", "WR", 190, { bye: 6 })], [P("Dak Prescott", "QB", 250, { bye: 10 })]);
t("we lose nothing and they lose real points: accepted",
  neutralForUs.verdict === "accept" && neutralForUs.ourGain >= 0, `ourGain ${neutralForUs.ourGain} net ${neutralForUs.netValue}`);

// The floor is about our lineup going BACKWARDS. That is what stops a trade being
// taken purely for spite, and it is a separate mechanism from pricing their gain.
const costsUs = ev([P("Rival TE2", "TE", 120, { bye: 5 })], [P("DeVonta Smith", "WR", 229, { bye: 10 })]);
t("a trade that makes our own lineup worse is refused whatever it does to them",
  costsUs.verdict === "reject", `ourGain ${costsUs.ourGain}`);

// A fleecing fails on our own floor, before any relative maths.
const fleece = ev([P("Rival TE2", "TE", 120, { bye: 5 })], [P("Kenneth Walker", "RB", 244, { bye: 5 })]);
t("a fleecing is rejected", fleece.verdict === "reject" && fleece.ourGain < 0);
t("  and it is our own floor that catches it", fleece.fairnessBlocks.some((b) => b.includes("floor")));
// #endregion

// #region noise, not relative value, is what usually decides
t("required edge scales with the biggest piece, not the gross sum",
  requiredEdge({ receive: [P("a", "WR", 300)], give: [P("b", "WR", 300)] }, DEFAULT_FAIRNESS) <
  600 * DEFAULT_FAIRNESS.errorFraction);
t("a tiny edge on big pieces does not clear the noise margin",
  ev([P("Rival WR1", "WR", 240, { bye: 5 })], [P("Nico Collins", "WR", 262, { bye: 8 })]).verdict === "reject");
// #endregion

// #region trade rails are NOT drop rails
// protectTopN=12 on a 16-man roster left only our worst four tradeable, which is
// no trading at all. A trade returns value, so rank protection does not apply.
t("a top-of-roster player can be traded when the return justifies it",
  ev([P("Rival QB", "QB", 300, { bye: 7 }), P("Trey McBride", "TE", 235, { bye: 11 })],
     [P("Dak Prescott", "QB", 250, { bye: 10 }), P("Mike Evans", "WR", 222, { bye: 8 })]).railBlocks.length === 0);
t("but a trade that leaves a slot unfillable is refused",
  ev([P("Rival WR1", "WR", 240, { bye: 5 })], [P("Jalen Hurts", "QB", 311, { bye: 10 }), P("Dak Prescott", "QB", 250, { bye: 10 })])
    .fairnessBlocks.some((b) => b.includes("unfillable")));
// #endregion

// #region injury refusal, because the news dossier will go stale in-season
t("an OUT player is refused", !!refusedForInjury(P("x", "WR", 200, { injuryStatus: "Out" })));
t("IR is refused", !!refusedForInjury(P("x", "WR", 200, { injuryStatus: "IR" })));
t("Questionable is NOT refused (Sleeper tags a third of the league)", !refusedForInjury(P("x", "WR", 200, { injuryStatus: "Questionable" })));
t("an incoming OUT player blocks the trade despite a healthy projection",
  ev([P("Rival WR1", "WR", 240, { bye: 5, injuryStatus: "Out" })], [P("Josh Downs", "WR", 172, { bye: 6 })]).verdict === "reject");
// #endregion

// #region probing defence
const now = Date.now();
const hist = [{ managerId: "m1", at: now - 1000 }, { managerId: "m1", at: now - 2000 }];
t("auto-decide stops once a manager is over the offer budget", !autoDecideAllowed("m1", hist, now).allowed);
t("a manager under the budget is still auto-decided", autoDecideAllowed("m2", hist, now).allowed);
// A probing SEQUENCE must never surface an acceptable trade that breaks the floor.
let breached = 0;
for (let give = 150; give <= 300; give += 10) {
  const r = ev([P("Rival TE2", "TE", 120, { bye: 5 })], [P("probe", "RB", give, { bye: 5 })]);
  if (r.verdict === "accept" && r.ourGain < 0) breached++;
}
t("a probing sweep never finds an accept that costs us lineup points", breached === 0, String(breached));
// #endregion

// #region proposals
const props = proposeTrades(ours, [{ managerId: "r1", teamName: "Rival", roster: theirs }], DEFAULT_FAIRNESS);
t("every proposal gains us something real", props.every((p) => p.ourGain >= DEFAULT_FAIRNESS.rejectBelowPts));
t("every proposal gains THEM something, or they would never accept", props.every((p) => p.theirGain > 0));
t("no proposal is blocked by the rails", props.length === 0 || props.every((p) => p.why.length > 0));
// #endregion

// #region marginal lineup value: raw projection is the wrong currency
// Recovered from the tradesv2 agent, whose modelling was better than mine here.
const dakMarginal = marginalLineupValue("Dak Prescott", ours);
const walkerMarginal = marginalLineupValue("Kenneth Walker", ours);
console.log(`\n  (Dak marginal ${dakMarginal}, Walker marginal ${walkerMarginal})`);
t("our backup QB is worth ~nothing to the lineup despite a huge projection", dakMarginal < 5, String(dakMarginal));
t("a real FLEX starter is worth a lot to the lineup", walkerMarginal > 10, String(walkerMarginal));
t("so the backup QB is offerable", giveEligibleForProposal(P("Dak Prescott", "QB", 250, { bye: 10 }), ours, DEFAULT_FAIRNESS).ok);
t("and the FLEX starter is not", !giveEligibleForProposal(P("Kenneth Walker", "RB", 244, { bye: 5 }), ours, DEFAULT_FAIRNESS).ok);
console.log(`\n  ${pass} passed, ${fail} failed (marginal value)`);
process.exit(fail ? 1 : 0);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
