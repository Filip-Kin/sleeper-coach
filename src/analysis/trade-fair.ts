// Two-sided trade valuation, and outgoing proposals a rival would plausibly take.
//
// WHY THIS EXISTS. src/analysis/trade.ts values an offer only from OUR side: it
// asks "does this improve our starting lineup by enough". Filip identified the
// exploit on 2026-08-30, and it is not a threshold-tuning problem:
//
//   "They will play dirty, they will try to give you shitty trades to see if
//    you'll take it. And if you don't take the really shitty ones, they'll just
//    turn the knob until they find what the minimum threshold is."
//
// He is right, and three properties made it cheap to exploit. Rejections are
// free and informative, so binary search finds the accept boundary in a handful
// of offers. evaluateTrade is deterministic, so there is no noise to average
// out. And most importantly it never asked how much the OTHER side gains, so a
// trade gaining us 26 points and gaining them 90 was accepted.
//
// The fix is structural rather than a bigger number, because a bigger number is
// just a boundary they binary-search to instead. Every rival roster is public
// (/league/<id>/rosters returns all eight with full player lists) and we have
// projections for everyone, so we can score BOTH sides. Filip's rule, verbatim:
// "Only accept trades that at minimum have equal value to both parties."
//
// That single rail kills the whole probing class, because a prober is by
// definition hunting for a trade that barely helps us while helping them a lot.
// Such a trade now fails regardless of where any threshold sits.
//
// THE INSIGHT THAT MAKES OUTGOING PROPOSALS POSSIBLE. Requiring our gain to be
// at least theirs does not mean nobody will ever accept. Positional surplus is
// ASYMMETRIC: we hold seven receivers and four running backs, so a manager thin
// at WR and deep at RB gains from the very trade we gain from, because each side
// converts a bench player into a starter. Both deltas are genuinely positive.
// That asymmetry, not generosity, is what makes a proposal acceptable.

import { bestLineup, evaluateTrade, STARTING_SLOTS, DEFAULT_TRADE_CONFIG, type TradeConfig, type TradeOffer, type TradePlayer, type TradeEvaluation, type TradeVerdict } from "./trade.ts";

function norm(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// #region live injury refusal
// Trade value rests on projections plus the hand-curated news dossier, which was
// last updated the night of the draft and which nobody will maintain weekly. By
// October a manager can offload a player whose projection has not caught up to
// his injury. So refuse anyone Sleeper currently flags as not playing,
// regardless of how good the projection still looks. Questionable is NOT here on
// purpose: Sleeper tagged 33 of the top 150 Questionable in late preseason, so
// treating it as disqualifying would refuse half the league.
const REFUSE_STATUSES = new Set(["out", "ir", "doubtful", "pup", "sus", "suspended", "na"]);

/** A projection that the depth chart contradicts is the classic scam shape.
 *
 *  Projections are the engine's only eyes, and they lag. A rival who knows a
 *  player is about to lose his job, serve a suspension, or sit for a legal case
 *  can offer him while his season projection still says "starter" and the model
 *  will pay starter value. cookieeater45 spelled the exploit out: "anyone who is
 *  forecasted to score more points could be traded for a sleeper and it would be
 *  a smash accept". Owen tried it the same day with Josh Jacobs: projecting like
 *  an RB1, listed FOURTH on Green Bay's depth chart. The injury flag happened to
 *  catch him; this catches the ones it would not.
 *
 *  Skill positions only: K and DEF have no meaningful depth chart, and a missing
 *  value never blocks anything. */
export const DEPTH_REFUSE_AT = 3;
export function refusedForDepth(p: TradePlayer): string | null {
  if (!["QB", "RB", "WR", "TE"].includes(p.position)) return null;
  if (p.depthChartOrder === undefined || p.depthChartOrder < DEPTH_REFUSE_AT) return null;
  return `${p.name} is listed ${ordinal(p.depthChartOrder)} on his team's depth chart at ${p.position}; his projection has not caught up and I am not buying it`;
}
function ordinal(n: number): string {
  return `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
}

export function refusedForInjury(p: TradePlayer): string | null {
  const s = (p.injuryStatus ?? "").trim().toLowerCase();
  if (!s) return null;
  return REFUSE_STATUSES.has(s)
    ? `${p.name} is currently flagged ${p.injuryStatus} and would be acquired on a projection that has not caught up`
    : null;
}
// #endregion

// #region two-sided valuation
export interface FairnessConfig extends TradeConfig {
  // A bye week carrying this many of our players or more is "crowded" and worth
  // relieving. Four of our starters share week 8, which costs about 10.7 points
  // in that week, so a move that thins it is worth more than its raw points.
  crowdedByeAt: number;
  // Points of credit for removing one player from a crowded bye. Deliberately
  // modest: a bye hits one week of seventeen, so it breaks ties between similar
  // trades rather than justifying a bad one.
  byeReliefPts: number;
  // DEPRECATED as a veto, kept so callers do not break. It is no longer a reject
  // rail. A trade that helps them more than us can still be clearly correct to
  // take, and refusing those costs real points. See opponentWeight below.
  requireOurEdgePts: number;
  // Their gain is real but DILUTED by the schedule: our gain applies in every
  // remaining week, theirs only hurts us head to head. With seven rivals over
  // fifteen regular weeks that is about 2/15. Passed per evaluation because it
  // changes through the season, and rises exactly when protecting a lead matters.
  remainingWeeks: number;
  headToHeadRemaining: number;
  // A rival contending for the same playoff place costs more than the raw
  // schedule says, because their seeding is our seeding. 1 = no extra weight.
  rivalThreatMultiplier: number;
  // The edge must beat projection NOISE, not merely be positive. Required edge
  // is max(flatMarginPts, stake * errorFraction), where STAKE is what our lineup
  // actually loses without the players we give up, NOT their raw projections.
  //
  // This was wrong twice. First it summed every player's raw points, so a swap
  // of two 230-point receivers demanded a 37-point edge. Then it took the
  // biggest single raw projection, which still demanded 17 points on a
  // bench-for-bench swap where the player we gave up was worth ZERO to our
  // lineup, and cookieeater45 correctly called that out in a DM. A projection
  // error on a player who never starts cannot move our score, so it cannot be
  // the reason to refuse. The stake is the marginal lineup value at risk.
  flatMarginPts: number;
  errorFraction: number;
  // Positions whose bench is priced as injury cover (see depthInsurance). A
  // roster with one tight end starts NOBODY if he is hurt; a WR4 is who starts
  // when a WR1 goes down in week 10. cookieeater45: "you sell short the upside
  // these players have, and that injuries happen". injuryRate is roughly the
  // share of games an NFL skill player misses.
  depthPositions: string[];
  injuryRate: number;
  // A missing starter is not replaced by NOBODY, he is replaced by a waiver
  // streamer. Only the part of a backup above that floor is insurance. 0.4
  // means a streamer recovers about 40% of a decent backup's value, so a
  // 162-point TE2 is worth 162 x 0.12 x 0.6 = 11.7 season points of cover.
  replacementFraction: number;
  // Every trade is irreversible and priced on noisy projections, so volume
  // multiplies model error rather than averaging it out.
  maxTradesPerWeek: number;
  // Our own lineup must not get WORSE, whatever the trade does to them. This is
  // the floor that stops a trade being accepted purely because it hurts a rival.
  // 0 means "must not lose ground"; a positive value demands we actually improve.
  minOwnGainPts: number;
  // Cost of a bench slot consumed when a trade grows our roster.
  rosterSlotCostPts: number;
  // A player is OFFERABLE when the lineup barely notices him going. Raw
  // projection is the wrong currency for this and gets a deep roster exactly
  // backwards: Dak Prescott is our #2 by projection and worth ZERO to a one-QB
  // lineup, while our RB3 is mid-table by projection and a real FLEX starter.
  // Credit for this idea goes to the tradesv2 agent, whose version of this module
  // I clobbered by editing it while it worked. Its modelling was better than mine.
  surplusMaxLineupPts: number;
  /** Remaining week numbers, for bye-aware lineup valuation. Empty = season totals. */
  upcomingWeeks: number[];
  /** Hard cap on the other side's gain, regardless of schedule dilution. */
  maxTheirGainPts: number;
}

export const DEFAULT_FAIRNESS: FairnessConfig = {
  ...DEFAULT_TRADE_CONFIG,
  requireOurEdgePts: 0,
  crowdedByeAt: 3,
  byeReliefPts: 4,
  remainingWeeks: 15,
  headToHeadRemaining: 2,
  rivalThreatMultiplier: 1,
  // Recalibrated with the stake change. 3 flat: a bench-for-bench swap risks
  // nothing, so it needs to clear only rounding and the bother of the move.
  // 0.25 of the marginal value we give up: trading away a 60-point starter
  // demands a 15-point edge, which is where the old 8%-of-raw landed for
  // starters, so decisions on real starters are unchanged.
  flatMarginPts: 3,
  errorFraction: 0.25,
  depthPositions: ["QB", "RB", "WR", "TE"],
  injuryRate: 0.12,
  replacementFraction: 0.4,
  maxTradesPerWeek: 2,
  minOwnGainPts: 0,
  rosterSlotCostPts: 5,
  surplusMaxLineupPts: 15,
  // Weeks still to play. When present, lineup value is measured week by week
  // with bye players removed, which is the only way to see a position dropping
  // to ZERO eligible players. Absent, the old season-total behaviour is kept.
  upcomingWeeks: [],
  // A hard ceiling on how much the other side may gain, however little it is
  // diluted by the schedule. Filip: "why not right, but of course in moderation,
  // do not accept a plus 15 to them or something". Even a rival we never play
  // again can knock us out of the playoffs or beat the teams we need to lose.
  maxTheirGainPts: 15,
};

// How much a rival's gain actually costs us. Rises as the season shortens.
export function opponentWeight(cfg: FairnessConfig): number {
  const weeks = Math.max(1, cfg.remainingWeeks);
  const h2h = Math.max(0, Math.min(cfg.headToHeadRemaining, weeks));
  return (h2h / weeks) * Math.max(1, cfg.rivalThreatMultiplier);
}

// Required edge, scaled by the BIGGEST single player involved rather than the
// gross sum. Scaling by the sum was wrong: swapping two similar 230-point
// receivers moves 460 gross and demanded a 37-point edge, which blocks every
// sensible upgrade. What we are actually uncertain about is the NET, and the net
// uncertainty tracks the size of the largest piece, not the total changing hands.
export function requiredEdge(offer: TradeOffer, cfg: FairnessConfig, ourRoster?: TradePlayer[]): number {
  // What we put at risk is what our lineup loses without the players we give.
  // Without a roster (unit tests of the formula itself) fall back to raw points.
  const stake = ourRoster
    ? offer.give.reduce((m, p) => Math.max(m, marginalLineupValue(p.name, ourRoster)), 0)
    : [...offer.receive, ...offer.give].reduce((m, p) => Math.max(m, Math.abs(p.points)), 0);
  return Math.max(cfg.flatMarginPts, stake * cfg.errorFraction);
}

/** SEASON-scale expected value of the bench as injury cover, at every position.
 *
 *  Filip: "just because you don't start a player right now doesn't mean you
 *  might not in the future ... last year I had my star QB get injured in like
 *  wk 10 and was out for the rest of the season." The first version priced
 *  cover at QB and TE only, on the theory that FLEX gives RB/WR natural depth.
 *  FLEX only helps if you have the bodies: a WR4 is precisely who starts when a
 *  WR1 goes down.
 *
 *  Model: at each position, the starters (dedicated and flex slots both) each
 *  miss a week with probability injuryRate. Holes are filled in order by the
 *  best remaining backups, and only the part of a backup above a waiver
 *  streamer is insurance. Expected season points of cover is therefore
 *      sum over k of P(at least k starters out) x backup_k x (1 - replacement)
 *  which has the two properties that matter: a backup with a good backup behind
 *  him is worth little (his marginal value is the gap to the next man), and a
 *  third or fourth backup is worth almost nothing (P(3 holes) is tiny), so this
 *  cannot reward hoarding. Units match byeAwareLineupTotal, which averages
 *  season-total lineups. (First draft was per week and added to a season
 *  number; the test caught the 17x.) */
export function depthInsurance(
  roster: TradePlayer[], cfg: FairnessConfig = DEFAULT_FAIRNESS, slots: readonly string[] = STARTING_SLOTS,
): number {
  const lineup = bestLineup(roster, slots).starters;
  const starting = new Set(lineup.map((s) => s.player?.name.toLowerCase()).filter(Boolean));
  let total = 0;
  for (const pos of cfg.depthPositions) {
    const n = lineup.filter((s) => s.player?.position === pos).length; // starters at pos, flex included
    if (!n) continue;
    const backups = roster
      .filter((p) => p.position === pos && !starting.has(p.name.toLowerCase()))
      .sort((a, b) => b.points - a.points);
    backups.forEach((b, i) => {
      total += atLeastKOut(n, i + 1, cfg.injuryRate) * b.points * (1 - cfg.replacementFraction);
    });
  }
  return Math.round(total * 10) / 10;
}

/** P(at least k of n starters miss a given week), each independently at rate p. */
export function atLeastKOut(n: number, k: number, p: number): number {
  if (k > n) return 0;
  let below = 0;
  for (let j = 0; j < k; j++) below += binom(n, j) * p ** j * (1 - p) ** (n - j);
  return Math.max(0, 1 - below);
}
function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// How many of our players sit on each bye week.
export function byeLoad(roster: TradePlayer[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of roster) {
    if (typeof p.bye !== "number") continue;
    m.set(p.bye, (m.get(p.bye) ?? 0) + 1);
  }
  return m;
}

// Net players removed from CROWDED bye weeks by this swap. Positive means the
// trade relieves a pile-up; negative means it makes one worse.
export function byeRelief(offer: TradeOffer, roster: TradePlayer[], cfg: FairnessConfig = DEFAULT_FAIRNESS): number {
  const before = byeLoad(roster);
  let relief = 0;
  for (const g of offer.give) {
    if (typeof g.bye === "number" && (before.get(g.bye) ?? 0) >= cfg.crowdedByeAt) relief += 1;
  }
  for (const r of offer.receive) {
    if (typeof r.bye === "number" && (before.get(r.bye) ?? 0) >= cfg.crowdedByeAt) relief -= 1;
  }
  return relief;
}

export interface TwoSidedEvaluation extends TradeEvaluation {
  ourGain: number; // our starting-lineup delta
  theirGain: number; // the counterparty's starting-lineup delta
  edge: number; // ourGain - theirGain, kept for reporting
  netValue: number; // ourGain - theirGain * opponentWeight; the number that decides
  requiredEdge: number; // the noise-scaled margin netValue had to beat
  fairnessBlocks: string[]; // non-empty forces a reject no matter how good ours looks
}

// Score an offer from BOTH sides. `theirRoster` is the counterparty's current
// roster; the same offer is applied in mirror to them (they receive what we
// give, and give what we receive).
/** Lineup value that knows about bye weeks.
 *
 *  WHY THE SEASON TOTAL IS NOT ENOUGH. bestLineup() picks the best ten players
 *  and sums their rest-of-season projections, which quietly assumes everybody is
 *  available every week. Our roster carried exactly one tight end, so in his bye
 *  week the TE slot started NOBODY and scored zero, and no season-total model can
 *  see that: the same 196.5 points are in the sum either way. cookieeater45
 *  offered Mark Andrews for Parker Washington, worth +9.28 in that week alone,
 *  and the engine read it as a flat zero.
 *
 *  Measuring per week with bye players removed prices the hole directly. For a
 *  roster with no byes in the window this returns exactly what bestLineup does,
 *  so it is a strict generalisation rather than a different metric. */
export function byeAwareLineupTotal(
  roster: TradePlayer[], weeks: readonly number[], slots: readonly string[] = STARTING_SLOTS,
): number {
  if (!weeks.length) return bestLineup(roster, slots).total;
  let sum = 0;
  for (const w of weeks) sum += bestLineup(roster.filter((p) => p.bye !== w), slots).total;
  return Math.round((sum / weeks.length) * 10) / 10;
}

/** The same swap, valued week by week rather than in season totals. */
export function byeAwareGain(
  roster: TradePlayer[], offer: TradeOffer, weeks: readonly number[], slots: readonly string[] = STARTING_SLOTS,
): number {
  const goneNames = new Set(offer.give.map((p) => p.name.toLowerCase()));
  const before = byeAwareLineupTotal(roster, weeks, slots);
  const after = byeAwareLineupTotal(
    [...roster.filter((p) => !goneNames.has(p.name.toLowerCase())), ...offer.receive], weeks, slots);
  return Math.round((after - before) * 10) / 10;
}

export function evaluateTradeTwoSided(
  offer: TradeOffer,
  ourRoster: TradePlayer[],
  theirRoster: TradePlayer[],
  cfg: FairnessConfig = DEFAULT_FAIRNESS,
): TwoSidedEvaluation {
  // A TRADE IS NOT A DROP, so it does not get the drop rails wholesale.
  // protectTopN exists to stop us dropping a good player for a streamer, where we
  // receive nothing. In a trade we receive value back, and the lineup delta plus
  // the unfillable-slot check below already measure whether we come out ahead.
  // Tested against our real roster shape, protectTopN=12 on a 16-man roster left
  // only our worst four players tradeable, which is no trading at all.
  //
  // The rails that DO still apply: the never-drop list, and the injured stash due
  // back before the playoffs, because a stash's low current projection makes the
  // lineup delta undervalue him and that is exactly the player a rival will try
  // to buy cheaply.
  const tradeCfg: FairnessConfig = {
    ...cfg,
    rails: { ...cfg.rails, protectTopN: 0 },
  };
  const ours = evaluateTrade(offer, ourRoster, tradeCfg);

  // Their side is the mirror image of the same swap.
  const theirBefore = bestLineup(theirRoster).total;
  const theirNames = new Set(offer.receive.map((p) => p.name.toLowerCase()));
  const theirAfter = bestLineup([
    ...theirRoster.filter((p) => !theirNames.has(p.name.toLowerCase())),
    ...offer.give,
  ]).total;
  // Bye-aware where we know the remaining weeks, season totals otherwise. Both
  // sides get the same treatment: their bye structure is as real as ours.
  const weeks = cfg.upcomingWeeks ?? [];
  const theirGain = weeks.length
    ? byeAwareGain(theirRoster, { receive: offer.give, give: offer.receive }, weeks)
    : Math.round((theirAfter - theirBefore) * 10) / 10;
  const ourGainLineup = weeks.length ? byeAwareGain(ourRoster, offer, weeks) : ours.lineupDelta;
  // Depth and the bye-aware lineup are both season-scale (the bye-aware total
  // averages season-total lineups across weeks). Only applied on the bye-aware
  // path, which is the live path; the legacy season-total path stays as it was.
  const afterOurs = [
    ...ourRoster.filter((p) => !offer.give.some((g) => g.name.toLowerCase() === p.name.toLowerCase())),
    ...offer.receive,
  ];
  const depthDelta = weeks.length
    ? Math.round((depthInsurance(afterOurs, cfg) - depthInsurance(ourRoster, cfg)) * 10) / 10
    : 0;
  const ourGain = Math.round((ourGainLineup + depthDelta) * 10) / 10;
  const edge = Math.round((ourGain - theirGain) * 10) / 10;

  const w = opponentWeight(cfg);
  // Taking on a player we do not need is not free: he occupies a bench slot that
  // a waiver add might have wanted. Only charged when the trade grows our roster.
  const slotCost = Math.max(0, offer.receive.length - offer.give.length) * cfg.rosterSlotCostPts;
  // SYMMETRIC in their delta: their gain counts against us and their LOSS counts
  // for us, both at the schedule weight. Filip pushed back on an earlier clamp
  // that ignored their loss entirely, and he is right that "we lose nothing and
  // they lose real points" is a good trade in a competition where their record
  // affects our seeding and we meet them head to head.
  //
  // What the clamp was actually protecting against was a different failure: a
  // swap of our worthless backup QB for a receiver we would never start scored
  // +25 net purely because it cost them 190, and was accepted while doing nothing
  // whatsoever for us. That is fixed properly below by a floor on OUR OWN gain,
  // which is the real requirement, rather than by pretending their loss is worth
  // nothing.
  const netValue = Math.round((ourGain - theirGain * w - slotCost) * 10) / 10;
  const need = Math.round(requiredEdge(offer, cfg, ourRoster) * 10) / 10;

  const fairnessBlocks: string[] = [];
  // A ceiling on their gain that dilution cannot argue away. Head-to-head
  // weighting already discounts a rival we rarely play, and correctly drops to
  // zero for one we never play again, but "we never play them" is not a licence
  // to hand somebody a monster: they still take games off the teams we need to
  // lose, and they can meet us in the playoffs where the schedule weight is
  // irrelevant by construction.
  if (theirGain > cfg.maxTheirGainPts) {
    fairnessBlocks.push(
      `it hands roster ${theirGain} points, past the ${cfg.maxTheirGainPts} ceiling on how strong we will make somebody else`);
  }
  for (const p of offer.receive) {
    const why = refusedForInjury(p) ?? refusedForDepth(p);
    if (why) fairnessBlocks.push(why);
  }
  // Never accept a trade that leaves a mandatory slot unfillable. Points are
  // recoverable; an empty starting slot every week is not.
  const afterRoster = [
    ...ourRoster.filter((p) => !offer.give.some((g) => g.name.toLowerCase() === p.name.toLowerCase())),
    ...offer.receive,
  ];
  const unfilled = bestLineup(afterRoster).starters.filter((x) => x.player === null).map((x) => x.slot);
  if (unfilled.length) fairnessBlocks.push(`would leave ${unfilled.join(", ")} unfillable`);

  // The one-sided reasons are written in SEASON TOTALS. Once the bye-aware
  // numbers are in play they contradict the decision (they said "lineup gain 0"
  // for a trade now worth +7.2), so drop the numeric ones and restate. Stale
  // reporting next to a live number is how a good decision gets mistrusted, and
  // how I misread the draft postmortem.
  const numeric = /lineup gain|starting-lineup projection|reject margin|does not improve our lineup|already deep at/i;
  const reasons = [
    ...ours.reasons.filter((r) => !weeks.length || !numeric.test(r)),
    ...(weeks.length
      ? [
          `valued across weeks ${weeks[0]}-${weeks[weeks.length - 1]} with bye players removed, ` +
          `so a week where a position has nobody eligible costs what it really costs`,
          `our lineup ${ourGainLineup >= 0 ? "+" : ""}${ourGainLineup} per week averaged over that run` +
            (depthDelta ? `, ${depthDelta >= 0 ? "+" : ""}${depthDelta} for injury cover at ${cfg.depthPositions.join("/")}` : ""),
        ]
      : [`starting-lineup projection ${ours.before.toFixed(1)} -> ${ours.after.toFixed(1)} (${ourGain >= 0 ? "+" : ""}${ourGain})`]),
    `their lineup ${theirGain >= 0 ? "+" : ""}${theirGain}` +
      (weeks.length ? " on the same bye-aware basis" : ` (${theirBefore.toFixed(1)} -> ${theirAfter.toFixed(1)})`),
    `net of schedule: ${ourGain} - ${theirGain} x ${w.toFixed(2)} = ${netValue}, need ${need}`,
  ];

  // BINARY, because Claude is the manager. Filip wants no involvement in
  // accepting or rejecting, so there is no surface-for-a-human band: a trade is
  // taken when it clears the rails and beats the noise margin, refused otherwise.
  //
  // Deliberately NOT secret. A manager who probes until they find this boundary
  // can only execute trades that are genuinely good for us, because the boundary
  // sits at true indifference plus a noise margin. A CORRECT threshold is safe to
  // leak, which is what makes probing pointless rather than merely difficult.
  // Our own lineup must not go backwards, no matter how much it hurts them.
  if (ourGain < cfg.minOwnGainPts) {
    fairnessBlocks.push(`our own lineup gains only ${ourGain}, below the floor of ${cfg.minOwnGainPts}`);
  }

  let verdict: TradeVerdict = "reject";
  if (!ours.railBlocks.length && !fairnessBlocks.length && netValue >= need) verdict = "accept";
  if (fairnessBlocks.length) reasons.unshift(...fairnessBlocks);

  return { ...ours, verdict, reasons, ourGain, theirGain, edge, netValue, requiredEdge: need, fairnessBlocks };
}
// #endregion

// #region probing defence
export interface OfferRecord {
  managerId: string;
  at: number; // epoch ms
}

export interface ProbeConfig {
  // Offers from one manager inside the window that are still auto-decided.
  // Beyond this, everything from them is surfaced for a human instead. Probing
  // needs volume, so a budget defeats the binary search directly.
  autoDecideBudget: number;
  windowMs: number;
}

export const DEFAULT_PROBE: ProbeConfig = {
  autoDecideBudget: 2,
  windowMs: 7 * 24 * 60 * 60 * 1000, // one week
};

// Should this manager's offer still be auto-decided, or has their own volume
// marked them out as probing? Repeated offers are the detection signal: a
// manager hunting for our threshold has to send several, and honest managers
// rarely do.
export function autoDecideAllowed(
  managerId: string,
  history: OfferRecord[],
  now: number,
  cfg: ProbeConfig = DEFAULT_PROBE,
): { allowed: boolean; reason: string } {
  const recent = history.filter((r) => r.managerId === managerId && now - r.at <= cfg.windowMs);
  if (recent.length >= cfg.autoDecideBudget) {
    return {
      allowed: false,
      reason: `${managerId} has sent ${recent.length} offers in the last ${Math.round(cfg.windowMs / 86400000)} days, at or over the auto-decide budget of ${cfg.autoDecideBudget}; treating further offers as threshold probing and surfacing them`,
    };
  }
  return { allowed: true, reason: `${managerId} has sent ${recent.length} offers in the window, under the budget` };
}
// #endregion

// #region outgoing proposals
export function marginalLineupValue(name: string, roster: TradePlayer[], slots: readonly string[] = STARTING_SLOTS): number {
  const withHim = bestLineup(roster, slots).total;
  const withoutHim = bestLineup(roster.filter((p) => norm(p.name) !== norm(name)), slots).total;
  return Math.round((withHim - withoutHim) * 10) / 10;
}

function dedicatedSlotsFor(position: string, slots: readonly string[] = STARTING_SLOTS): number {
  return slots.filter((s) => s === position).length;
}

export function giveEligibleForProposal(
  player: TradePlayer,
  roster: TradePlayer[],
  cfg: FairnessConfig = DEFAULT_FAIRNESS,
  slots: readonly string[] = STARTING_SLOTS,
): { ok: boolean; reason: string } {
  const present = roster.find((p) => norm(p.name) === norm(player.name));
  if (!present) return { ok: false, reason: `"${player.name}" is not on our roster as read back` };
  if (cfg.rails.neverDrop.some((n) => norm(n) === norm(present.name))) {
    return { ok: false, reason: `"${present.name}" is on the never-drop list` };
  }
  if (present.returnsBeforePlayoffs) {
    return { ok: false, reason: `"${present.name}" is an injured stash due back before the playoffs; his depressed projection would undervalue him in a trade` };
  }
  const dedicated = dedicatedSlotsFor(present.position, slots);
  const samePos = roster.filter((p) => p.position === present.position).sort((a, b) => b.points - a.points);
  const rankAtPos = samePos.findIndex((p) => norm(p.name) === norm(present.name)) + 1;
  if (rankAtPos > 0 && rankAtPos <= dedicated) {
    return { ok: false, reason: `"${present.name}" is our #${rankAtPos} ${present.position}, a dedicated-slot starter; a proposal never ships one` };
  }
  const marg = marginalLineupValue(present.name, roster, slots);
  if (marg > cfg.surplusMaxLineupPts) {
    return { ok: false, reason: `"${present.name}" is worth ${marg} starting-lineup points to us, above the ${cfg.surplusMaxLineupPts}pt surplus line; he is core, not surplus` };
  }
  return { ok: true, reason: `"${present.name}" is surplus (our #${rankAtPos} ${present.position}, ${marg} lineup pts), so a fair return is a genuine upgrade` };
}

export interface RivalRoster {
  managerId: string;
  teamName: string;
  roster: TradePlayer[];
}

export interface Proposal {
  managerId: string;
  teamName: string;
  offer: TradeOffer; // from OUR perspective: receive / give
  ourGain: number;
  theirGain: number;
  edge: number;
  byeRelief: number; // players taken off a crowded bye; negative makes one worse
  score: number; // ourGain plus bye credit, the ranking key
  why: string;
}

/** All subsets of `xs` with between 1 and `maxSize` members. */
export function combinations<T>(xs: T[], maxSize: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, picked: T[]): void => {
    if (picked.length) out.push([...picked]);
    if (picked.length === maxSize) return;
    for (let i = start; i < xs.length; i++) {
      picked.push(xs[i] as T);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/** Package size limits. Filip asked for many-to-many, which is right: the deal
 *  that helps both sides is often two of our spare receivers for one back they
 *  can spare, and a one-for-one search simply cannot see it.
 *
 *  The cost is combinatorial, so the search is bounded rather than exhaustive:
 *  only the best PACKAGE_POOL players on each side are considered, in packages
 *  of at most PACKAGE_MAX. That is 2^k-ish rather than 2^16, and it keeps the
 *  weekly run to a few seconds while still covering every shape a human would
 *  actually offer: 1-for-1, 1-for-2, 2-for-1, 2-for-2, up to 3 a side. */
export const PACKAGE_MAX = Number(process.env.TRADE_PACKAGE_MAX ?? "3");
export const PACKAGE_POOL = Number(process.env.TRADE_PACKAGE_POOL ?? "9");

// Generate proposals worth sending: ones the rival would plausibly accept
// because their lineup genuinely improves, that still satisfy Filip's rule that
// we gain at least as much.
export function proposeTrades(
  ourRoster: TradePlayer[],
  rivals: RivalRoster[],
  cfg: FairnessConfig = DEFAULT_FAIRNESS,
  limit = 10,
  maxPackage = PACKAGE_MAX,
): Proposal[] {
  const out: Proposal[] = [];

  // Only pieces our lineup can genuinely spare, measured by what it loses
  // without them rather than by raw projection. Taking the most valuable
  // surplus first keeps the bounded pool the useful one.
  const givable = ourRoster
    .filter((p) => giveEligibleForProposal(p, ourRoster, cfg).ok)
    .sort((a, b) => b.points - a.points)
    .slice(0, PACKAGE_POOL);
  const giveSets = combinations(givable, maxPackage);

  for (const rival of rivals) {
    const gettable = rival.roster
      .filter((p) => !refusedForInjury(p) && !refusedForDepth(p))
      .sort((a, b) => b.points - a.points)
      .slice(0, PACKAGE_POOL);
    const receiveSets = combinations(gettable, maxPackage);

    for (const give of giveSets) {
      for (const receive of receiveSets) {
        const offer: TradeOffer = { receive, give };
        const ev = evaluateTradeTwoSided(offer, ourRoster, rival.roster, cfg);
        // THE PROPOSER MUST USE THE ACCEPTOR'S BAR. This previously filtered on
        // its own weaker conditions (no blocks, theirGain > 0, ourGain above the
        // noise floor) and never asked whether the deal would actually be
        // ACCEPTED. It generated Mike Evans plus Travis Etienne for Rashee Rice,
        // which the accept path rejects: +7.1 to us against +26.3 to them, a net
        // of 3.6 against the 18.3 it needs. Offering a deal we would then refuse
        // is incoherent, and worse, the coach had already said so in a DM.
        if (ev.verdict !== "accept") continue;
        // They must actually gain too, or there is no reason for them to say
        // yes. This is the ONLY condition the proposer adds beyond acceptance.
        if (ev.theirGain <= 0) continue;
        const relief = byeRelief(offer, ourRoster, cfg);
        const names = (ps: TradePlayer[]) => ps.map((p) => `${p.name} (${p.position})`).join(" + ");
        out.push({
          managerId: rival.managerId,
          teamName: rival.teamName,
          offer,
          ourGain: ev.ourGain,
          theirGain: ev.theirGain,
          edge: ev.edge,
          byeRelief: relief,
          // Prefer the SMALLEST package that achieves the gain. A two-for-two is
          // harder for a human to say yes to than a one-for-one worth the same,
          // and it churns more of the roster for the same result.
          score: ev.ourGain + relief * cfg.byeReliefPts - (give.length + receive.length) * 0.5,
          why:
            `we get ${names(receive)} for ${names(give)}: ` +
            `our lineup +${ev.ourGain}, theirs +${ev.theirGain}` +
            (relief > 0 ? `, and it takes ${relief} off a crowded bye` : relief < 0 ? `, but it adds ${-relief} to a crowded bye` : ""),
        });
      }
    }
  }
  // Best for us first (bye relief and package-size penalty included), then by
  // how attractive it is to them, since among equally good trades the one they
  // are likeliest to accept is the one worth sending.
  out.sort((a, b) => b.score - a.score || b.theirGain - a.theirGain);
  return out.slice(0, limit);
}
// #endregion
