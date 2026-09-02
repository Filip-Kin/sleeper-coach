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
  // The edge must beat projection NOISE, not merely be positive. Required edge is
  // max(flatMarginPts, valueMoved * errorFraction): a +6 edge on a blockbuster is
  // inside the error bars and is a coin flip with transaction risk attached,
  // while the same +6 on two fringe players is real.
  flatMarginPts: number;
  errorFraction: number;
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
}

export const DEFAULT_FAIRNESS: FairnessConfig = {
  ...DEFAULT_TRADE_CONFIG,
  requireOurEdgePts: 0,
  crowdedByeAt: 3,
  byeReliefPts: 4,
  remainingWeeks: 15,
  headToHeadRemaining: 2,
  rivalThreatMultiplier: 1,
  flatMarginPts: 12, // about 0.7 pts/week of real edge before it is worth the churn
  errorFraction: 0.08, // 8% of the value changing hands
  maxTradesPerWeek: 2,
  minOwnGainPts: 0,
  rosterSlotCostPts: 5,
  surplusMaxLineupPts: 15,
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
export function requiredEdge(offer: TradeOffer, cfg: FairnessConfig): number {
  const biggest = [...offer.receive, ...offer.give].reduce((m, p) => Math.max(m, Math.abs(p.points)), 0);
  return Math.max(cfg.flatMarginPts, biggest * cfg.errorFraction);
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
  const theirGain = Math.round((theirAfter - theirBefore) * 10) / 10;
  const ourGain = ours.lineupDelta;
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
  const need = Math.round(requiredEdge(offer, cfg) * 10) / 10;

  const fairnessBlocks: string[] = [];
  for (const p of offer.receive) {
    const why = refusedForInjury(p);
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

  const reasons = [
    ...ours.reasons,
    `their lineup ${theirBefore.toFixed(1)} -> ${theirAfter.toFixed(1)} (${theirGain >= 0 ? "+" : ""}${theirGain})`,
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
      .filter((p) => !refusedForInjury(p))
      .sort((a, b) => b.points - a.points)
      .slice(0, PACKAGE_POOL);
    const receiveSets = combinations(gettable, maxPackage);

    for (const give of giveSets) {
      for (const receive of receiveSets) {
        const offer: TradeOffer = { receive, give };
        const ev = evaluateTradeTwoSided(offer, ourRoster, rival.roster, cfg);
        if (ev.railBlocks.length || ev.fairnessBlocks.length) continue;
        // They must actually gain, or there is no reason for them to say yes.
        if (ev.theirGain <= 0) continue;
        // And it must be worth our while beyond noise.
        if (ev.ourGain < cfg.rejectBelowPts) continue;
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
