// Trade evaluation, as pure functions of a roster and rest-of-season
// projections. No browser, no writes, no live data: this is the part of the
// trade system that CAN be tested exhaustively offline, so it is where all the
// judgement lives. The write path (src/act/sleeper.ts respondTrade/sendTrade)
// is a dumb pair of hands; the decision is made here.
//
// The single idea that makes this correct is that a trade's value to us is the
// change in our best STARTING LINEUP, not the sum of the player values that
// change hands. We already hold seven receivers. An eighth receiver never
// cracks the lineup (we start at most WR, WR and two FLEX, all filled by better
// players), so he is worth almost nothing to us however high his raw
// projection. A second startable tight end, by contrast, displaces a weaker
// FLEX starter and is worth a lot. Measuring lineup impact captures that for
// free; summing player values gets it exactly backwards.
//
// This respects src/analysis/rails.ts rather than reimplementing it: a trade
// that gives up a protected player, an injured stash projected back before the
// week 16 playoffs, or a name we cannot find on the roster fails the same way a
// waiver drop would. Rails are a hard gate; no lineup gain overrides them.

import { canDrop, DEFAULT_RAILS, type RailPlayer, type RailConfig } from "./rails.ts";

// A player as the trade engine sees him. Identical to RailPlayer on purpose, so
// the projection currency (rest-of-season points) is the same one the rails
// judge drops in. `points` is rest-of-season, not weekly.
export type TradePlayer = RailPlayer;

// This league's starting slots, in roster_positions order. FLEX takes RB/WR/TE.
// Read live from the league elsewhere; hard-coded here only as the default so
// the pure functions have no I/O.
export const STARTING_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"] as const;
const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);

function norm(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// #region identity
/** The key a player is matched on everywhere in the trade engine. The Sleeper
 *  id when the record carries one, the normalised name only for hand-built
 *  fixtures that do not. Matching on names was how a give of one "Josh Allen"
 *  removed both of them from the post-trade roster (audit 2026-09-23, T10). */
export function playerKey(p: Pick<TradePlayer, "name" | "playerId">): string {
  return p.playerId ? `id:${p.playerId}` : `name:${norm(p.name)}`;
}
export function samePlayer(a: Pick<TradePlayer, "name" | "playerId">, b: Pick<TradePlayer, "name" | "playerId">): boolean {
  if (a.playerId && b.playerId) return a.playerId === b.playerId;
  return norm(a.name) === norm(b.name);
}
/** The roster with these players removed, matched by id. */
export function without(roster: TradePlayer[], gone: readonly TradePlayer[]): TradePlayer[] {
  return roster.filter((p) => !gone.some((g) => samePlayer(g, p)));
}
/** The roster after a swap: gives out, receives in. */
export function afterTrade(roster: TradePlayer[], offer: TradeOffer): TradePlayer[] {
  return [...without(roster, offer.give), ...offer.receive];
}
// #endregion

function eligible(slot: string, position: string): boolean {
  return slot === "FLEX" ? FLEX_ELIGIBLE.has(position) : slot === position;
}

// How many positions a slot can hold. Used only to order the greedy fill from
// most restrictive to least.
function slotWidth(slot: string): number {
  return slot === "FLEX" ? FLEX_ELIGIBLE.size : 1;
}

export interface LineupResult {
  total: number; // summed rest-of-season projection of the chosen starters
  starters: { slot: string; player: TradePlayer | null }[]; // in slot order
}

// The best legal starting lineup from a roster, by total rest-of-season points.
//
// Greedy, filling slots from most restrictive to least (QB/RB/WR/TE/K/DEF, then
// FLEX). This is OPTIMAL for these slots, not merely a heuristic: QB, K and DEF
// never compete with the RB/WR/TE pool at all, and every dedicated RB/WR/TE
// slot's eligibility set is a strict subset of FLEX's, so taking each dedicated
// slot's best available player and letting FLEX mop up the leftovers maximises
// the total. The naive "sort everyone by points and fill top down" is what gets
// this wrong, by stranding a required slot. (See docs/in-season-plan.md, "The
// lineup assignment, precisely".)
// STREAMABLE POSITIONS. Kicker and defense are not scarce: any league has dozens
// of each sitting on waivers, and the worst startable one scores about the same
// as the best. So an EMPTY K or DEF slot is not worth zero points, it is worth
// what a waiver streamer scores, because that is exactly what you would do.
//
// This matters because the whole trade engine is built on lineup deltas. Without
// it, a rival can hand you a backup kicker and the model credits the points it
// would fill a bye-week hole with (a hole you would have streamed for free), and
// worse, credits YOU for making THEM give up their only kicker (a "loss" they
// would also just stream away). On 2026-09-04 that produced an accepted trade
// where we took two useless kickers for nothing, dropping two real players to do
// it. Replacement level here collapses both phantom numbers to ~zero.
//
// Per-week season projections: a streamed kicker is ~38 over a season, a streamed
// defense ~30. Deliberately a touch below a rostered starter so keeping your own
// K/DEF is still marginally better, but nowhere near a full slot of value.
const REPLACEMENT_POINTS: Record<string, number> = {
  K: Number(process.env.REPLACEMENT_K ?? "38"),
  DEF: Number(process.env.REPLACEMENT_DEF ?? "30"),
};

export function bestLineup(roster: TradePlayer[], slots: readonly string[] = STARTING_SLOTS): LineupResult {
  // A player on injured reserve cannot be started, so he is not in the pool
  // whatever his season number says. Before 2026-09-23 he was, and a trade
  // giving him away was priced as if it emptied a starting slot (T6).
  // Players best-first; ties are broken by original order, which is irrelevant
  // to the total.
  const ranked = roster.filter((p) => !p.onIr).map((p, i) => ({ p, i })).sort((a, b) => b.p.points - a.p.points);
  const used = new Set<number>();
  const filled: (TradePlayer | null)[] = slots.map(() => null);

  const order = slots
    .map((slot, slotIdx) => ({ slot, slotIdx }))
    .sort((a, b) => slotWidth(a.slot) - slotWidth(b.slot));

  for (const { slot, slotIdx } of order) {
    for (const { p, i } of ranked) {
      if (used.has(i)) continue;
      if (!eligible(slot, p.position)) continue;
      filled[slotIdx] = p;
      used.add(i);
      break;
    }
  }

  const starters = slots.map((slot, idx) => ({ slot, player: filled[idx] ?? null }));
  // An unfilled K/DEF slot scores replacement (a streamer), not zero. An unfilled
  // skill slot still scores zero: those are NOT freely replaceable, and an empty
  // one is a real weekly hole, which the rest of the engine depends on seeing.
  const total = Math.round(
    slots.reduce((sum, slot, idx) => {
      const p = filled[idx];
      if (p) return sum + p.points;
      return sum + (REPLACEMENT_POINTS[slot] ?? 0);
    }, 0) * 10,
  ) / 10;
  return { total, starters };
}

export type TradeVerdict = "accept" | "reject" | "surface";

export interface TradeConfig {
  rails: RailConfig;
  // Bands on the rest-of-season starting-lineup delta (after minus before, in
  // projected points). At or below `rejectBelowPts` the offer is a wash or a
  // loss and is auto-rejected; ties keep what we have. At or above
  // `acceptAbovePts` it is a clear, multi-week lineup upgrade and auto-accepts.
  // Between the two it is a real but not decisive change, so it is left pending
  // and surfaced for a human rather than guessed at.
  //
  // These are SEASON-point deltas. Early in the season rest-of-season is nearly
  // the whole season, so the same real per-week edge shows up as a larger
  // number than it will in week 10. A caller that wants constant sensitivity
  // across the season should scale these by weeks remaining; the defaults are
  // sized for a full rest-of-season and are deliberately conservative.
  rejectBelowPts: number;
  acceptAbovePts: number;
}

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  rails: DEFAULT_RAILS,
  // ~0.3 pts/week over a 17-week season: below this it is noise, keep what we
  // have and do not even ping Filip about it.
  rejectBelowPts: 5,
  // ~1.5 pts/week of guaranteed starting-lineup gain: a clear win worth taking
  // without a human in the loop.
  acceptAbovePts: 25,
};

// An offer from OUR perspective: `receive` are players coming to us, `give` are
// players leaving us (which must be on our roster and pass the drop rails).
export interface TradeOffer {
  receive: TradePlayer[];
  give: TradePlayer[];
}

export interface TradeEvaluation {
  verdict: TradeVerdict;
  lineupDelta: number; // after - before, rest-of-season points
  before: number; // best starting lineup total now
  after: number; // best starting lineup total if the trade goes through
  railBlocks: string[]; // reasons a give player is untouchable; non-empty forces reject
  reasons: string[]; // human-readable explanation for the log / the surfaced alert
}

// Evaluate an incoming (or hypothetical) offer. Pure: same inputs, same verdict.
export function evaluateTrade(
  offer: TradeOffer,
  roster: TradePlayer[],
  cfg: TradeConfig = DEFAULT_TRADE_CONFIG,
): TradeEvaluation {
  const reasons: string[] = [];
  const railBlocks: string[] = [];

  // 1. Rails first. Every player we give up must be droppable under exactly the
  //    same rules as a waiver drop: not protected (top-N by projection), not the
  //    injured stash due back before the playoffs, not on the never-drop list,
  //    and actually present on the roster we read back. A rail block is fatal no
  //    matter how good the lineup maths looks; that is the whole point of rails.
  //    The roster entry is found by id first, so a namesake cannot stand in
  //    for the player actually leaving, and the IR rail reads the entry's own
  //    onIr flag rather than whatever the offer object happened to carry.
  for (const g of offer.give) {
    const present = roster.find((p) => samePlayer(g, p));
    if (!present) { railBlocks.push(`"${g.name}" is not on the roster as read back from Sleeper`); continue; }
    if (present.onIr) { railBlocks.push(`"${present.name}" is on injured reserve; a stash is not cut or traded away automatically`); continue; }
    const v = canDrop(present.name, roster, cfg.rails);
    if (!v.allowed) railBlocks.push(v.reason);
  }

  // 2. Lineup impact. Build the post-trade roster and compare best lineups.
  const postRoster = afterTrade(roster, offer);

  const beforeLineup = bestLineup(roster);
  const afterLineup = bestLineup(postRoster);
  const before = beforeLineup.total;
  const after = afterLineup.total;
  const lineupDelta = Math.round((after - before) * 10) / 10;

  // 3. Explain it in lineup terms, since the delta alone hides the asymmetry
  //    that makes trades counter-intuitive (an eighth WR adding nothing, a
  //    second TE adding a lot). Name which received players actually start and
  //    which surrendered players were starters we are giving up.
  const startsAfter = new Set(afterLineup.starters.flatMap((s) => (s.player ? [playerKey(s.player)] : [])));
  const startsBefore = new Set(beforeLineup.starters.flatMap((s) => (s.player ? [playerKey(s.player)] : [])));
  for (const r of offer.receive) {
    reasons.push(
      startsAfter.has(playerKey(r))
        ? `${r.name} (${r.position}) cracks our starting lineup`
        : `${r.name} (${r.position}) does not improve our lineup (we are already deep at ${r.position})`,
    );
  }
  for (const g of offer.give) {
    if (startsBefore.has(playerKey(g))) reasons.push(`we give up ${g.name} (${g.position}), currently a starter`);
  }
  reasons.push(`starting-lineup projection ${before} -> ${after} (${lineupDelta >= 0 ? "+" : ""}${lineupDelta})`);

  // 4. Verdict.
  let verdict: TradeVerdict;
  if (railBlocks.length > 0) {
    verdict = "reject";
    reasons.unshift(`rails forbid this trade: ${railBlocks.join("; ")}`);
  } else if (lineupDelta <= cfg.rejectBelowPts) {
    verdict = "reject";
    reasons.unshift(`lineup gain ${lineupDelta} is at or below the ${cfg.rejectBelowPts}pt reject margin (a wash keeps what we have)`);
  } else if (lineupDelta >= cfg.acceptAbovePts) {
    verdict = "accept";
    reasons.unshift(`lineup gain ${lineupDelta} clears the ${cfg.acceptAbovePts}pt auto-accept threshold`);
  } else {
    verdict = "surface";
    reasons.unshift(`lineup gain ${lineupDelta} is real but between the ${cfg.rejectBelowPts}pt and ${cfg.acceptAbovePts}pt thresholds: leave pending for a human`);
  }

  return { verdict, lineupDelta, before, after, railBlocks, reasons };
}
