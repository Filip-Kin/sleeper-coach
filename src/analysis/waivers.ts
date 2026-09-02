import { canDrop, DEFAULT_RAILS, type RailPlayer, type RailConfig } from "./rails.ts";
import { solveLineup, type LineupPlayer } from "./lineup.ts";

// The waiver engine, priced in WAIVER PRIORITY, not dollars.
//
// This league is ROLLING WAIVER PRIORITY (waiver_type 0), NOT FAAB. The stored
// waiver_budget of 100 is a Sleeper default that is never used. There is no
// bidding and no budget to pace. Instead we hold a position in a queue, and a
// SUCCESSFUL claim sends us to the BACK of it. So the question on every claim is
// not "what is he worth" but "is he worth going LAST for weeks". That argues for
// claiming rarely and decisively: a genuine starter or a real upside play, never
// a streaming defence you could pick up as a free agent anyway. A player who has
// already CLEARED waivers is a free agent and costs nothing, so a costless add
// is always preferred to a claim for the same player.
//
// canDrop in rails.ts is the AUTHORITY on what may be dropped: it protects our
// top-N by ROS, the never-drop list, and above all the injured-but-returns
// stash. This engine never overrides it — every drop it proposes is a
// canDrop-allowed player. But it does NOT use the rails' raw-points upgrade
// margin to choose or price a move, because raw points ACROSS positions is the
// draft-night trap: a backup QB's 250 ROS "beats" our only kicker's 125, yet
// dropping the kicker to roster a third QB is a disaster (it empties the K slot).
// So the engine chooses the drop that maximises our STARTING-LINEUP delta among
// canDrop-legal candidates, and gates every cut on that delta being positive.

export interface WaiverConfig {
  rails: RailConfig;
  // Starting-lineup improvement (ROS points) required before BURNING waiver
  // priority on a claim. Deliberately high: going to the back of the queue is
  // only worth it for a real, multi-week difference to the lineup we field.
  claimMarginPts: number;
  // Starting-lineup improvement required to justify a costless free-agent add
  // that entails a DROP. Low, because a free add is effectively reversible (worst
  // case a wasted roster spot), but not zero: we never cut a rostered player for
  // no lineup gain. A costless add into an OPEN slot has no drop and skips this.
  freeAddMarginPts: number;
  // A claim is only worth a priority burn if the incoming player would actually
  // START for us. A bench/handcuff upgrade never justifies going last; wait and
  // free-add him once he clears. Set false to allow claiming bench depth too.
  claimMustStart: boolean;
  // A bye week carrying this many of our STARTERS or more is "crowded" and worth
  // relieving. Mirrors trade-fair.ts. Four of our starters share the week 8 bye,
  // which costs about 10.7 points that week and is the worst single-week hole in
  // the league. It could not be fixed on draft night, so the weekly cycle carries
  // it forward as a standing objective (see the lookahead below).
  crowdedByeAt: number;
  // Points of tie-break credit for an add that helps a crowded bye (plays that
  // week) and debit for one that deepens it (is on that bye). Deliberately
  // modest and applied ONLY to the ranking score, never to the accept gates: a
  // bye hits one week of seventeen, so it breaks ties between similar candidates
  // and must never justify a move the lineup delta rejects. Same value as trades.
  byeReliefPts: number;
  // How many weeks ahead the weekly run scans for a crowded-starter bye so it can
  // treat relieving it as an explicit objective while there is still time to act
  // (the week-8 hole is a week-7 job). Default 2.
  byeLookaheadWeeks: number;
}

export const DEFAULT_WAIVERS: WaiverConfig = {
  rails: DEFAULT_RAILS,
  claimMarginPts: 15, // lineup ROS; a genuine multi-week difference, not a streamer
  freeAddMarginPts: 1, // any real lineup improvement justifies a costless swap
  claimMustStart: true,
  crowdedByeAt: 3, // same threshold as the trade engine's byeRelief
  byeReliefPts: 4, // same modest tie-break weight as trades
  byeLookaheadWeeks: 2,
};

// A player available to add. `onWaivers` is the pricing switch: true means a
// claim would burn our queue position; false means he has cleared and is a
// costless free-agent add.
export interface AvailablePlayer extends RailPlayer {
  onWaivers: boolean;
  rosteredPct?: number; // Sleeper rostered %, a scarcity signal for ranking
}

// The current roster state the drop-path resolver needs. "Prefer paths that drop
// nobody" (the plan): an empty bench slot first, then an IR slot for a genuinely
// injured incumbent (which opens a bench slot without a drop), and only then a
// straight drop.
export interface RosterState {
  roster: RailPlayer[];
  openBenchSlots: number; // empty BN slots right now
  openIrSlots: number; // empty IR (reserve) slots right now
  startingSlots: string[]; // roster_positions with BN/IR removed, for the "would he start" test
  // Whether a Sleeper injury status makes a player IR-eligible in THIS league.
  // The eligible set is league-configured (reserve_allow_out/sus/cov/... flags),
  // not universal: our league allows OUT and SUS onto IR but not NA or DNR, which
  // the old fixed set got wrong both ways. Absent = the conservative default set.
  irEligible?: (status?: string | null) => boolean;
}

export type MoveKind = "free-add" | "waiver-claim" | "wait" | "skip";
export type DropPath = "bench-slot" | "ir-stash" | "drop" | "none";

export interface WaiverMove {
  kind: MoveKind;
  add: string;
  position: string;
  onWaivers: boolean;
  drop: string | null; // full name of the player dropped; null when a slot absorbs the add
  dropPath: DropPath;
  gainPts: number; // ROS points the add clears the player it replaces (or the worst starter, for a slot add)
  startsForUs: boolean; // would the add crack our optimal ROS starting lineup
  priorityWorthy: boolean; // clears the bar to burn a queue position
  // Bye tie-break: + if this add plays through an upcoming crowded starter bye,
  // - if it is itself on that bye. NEVER enters an accept gate; it only ranks
  // moves that already passed the lineup-delta gates (mirrors trade-fair.ts).
  byeCredit: number;
  score: number; // gainPts + byeCredit; the ranking key, not a gate
  reason: string;
}

function asLineup(p: RailPlayer): LineupPlayer {
  return { playerId: p.name, name: p.name, position: p.position, points: p.points, injuryStatus: p.injuryStatus };
}

// The true value of a transaction, measured on the STARTING LINEUP: how many ROS
// points our optimal starting lineup gains by making this add (and its drop, if
// any). This is the number the rolling-priority decision must use, NOT the gap
// to whatever fringe body we cut. A streaming kicker who beats our benched
// backup QB by 50 points but only lifts the lineup by 8 is an 8-point add, and
// pricing it any other way is exactly the capped-position trap from draft night:
// cross-position gaps are not costs, only lineup deltas are.
//
// Baseline is the current roster's starting total. Result is the starting total
// of (roster minus the drop, plus the incoming). So dropping a starter correctly
// shrinks the gain, and dropping a bench body correctly costs nothing.
function lineupDelta(
  incoming: AvailablePlayer,
  dropName: string | null,
  state: RosterState,
): { gain: number; starts: boolean } {
  const baseline = solveLineup(state.roster.map(asLineup), state.startingSlots).total;
  const kept = state.roster.filter((p) => p.name !== dropName).map(asLineup);
  const after = solveLineup([...kept, asLineup(incoming)], state.startingSlots);
  const starts = after.starters.some((s) => s.playerId === incoming.name);
  return { gain: Math.round((after.total - baseline) * 10) / 10, starts };
}

interface PathEval {
  path: DropPath;
  drop: string | null;
  gain: number; // starting-lineup ROS delta of taking this path
  starts: boolean; // does the add start after it
  reason: string;
}

// Rank a path family for tie-breaking when deltas are equal: prefer to drop
// NOBODY. An open bench slot or an IR-stash always beats a straight drop at the
// same lineup delta, because it keeps the roster body it would otherwise cut.
const PATH_RANK: Record<DropPath, number> = { "bench-slot": 0, "ir-stash": 1, drop: 2, none: 3 };

// Enumerate every legal way to fit the incoming player, scored by starting-lineup
// delta. A no-drop path (open bench, or IR-stashing an injured incumbent) drops
// nobody. A drop path is considered ONLY for canDrop-allowed players, so the
// protection rails (top-N, never-drop, the injured-returns stash) are never
// bypassed. Returns paths best-delta first, no-drop winning ties.
function evalPaths(incoming: AvailablePlayer, state: RosterState, cfg: WaiverConfig): PathEval[] {
  const paths: { path: DropPath; drop: string | null; reason: string }[] = [];

  if (state.openBenchSlots > 0) {
    paths.push({ path: "bench-slot", drop: null, reason: "into an open bench slot (no drop)" });
  }
  // An IR slot with a genuinely injured incumbent to stash frees a bench slot
  // without dropping anyone. The stash-worthy player is exactly the one the rails
  // protect, so he belongs on IR, never on the drop table.
  const irEligible = state.irEligible ?? isReserveInjury;
  const irStashable = state.roster.find(
    (p) => (p.returnsBeforePlayoffs || irEligible(p.injuryStatus)) && !cfg.rails.neverDrop?.includes(p.name),
  );
  if (state.openIrSlots > 0 && irStashable) {
    paths.push({ path: "ir-stash", drop: null, reason: `stash ${irStashable.name} (injured) on IR (no drop)` });
  }
  // Every canDrop-ALLOWED player is a candidate drop. canDrop is the authority on
  // what may leave the roster; we pick among the allowed ones by lineup delta.
  for (const p of state.roster) {
    if (canDrop(p.name, state.roster, cfg.rails).allowed) {
      paths.push({ path: "drop", drop: p.name, reason: `drop ${p.name}` });
    }
  }

  const evals = paths.map((p) => {
    const { gain, starts } = lineupDelta(incoming, p.drop, state);
    return { ...p, gain, starts };
  });
  evals.sort((a, b) => b.gain - a.gain || PATH_RANK[a.path] - PATH_RANK[b.path]);
  return evals;
}

// Reserve-eligible injury states: a player in one of these can legitimately go
// to IR, freeing a bench slot. "Questionable"/"Doubtful" are weekly game states,
// not reserve states, so they are excluded.
function isReserveInjury(status?: string | null): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "IR" || s === "PUP" || s === "NA" || s === "SUS" || s === "DNR" || s === "COV";
}

// Bye tie-break for one move, in the same spirit as trade-fair.ts byeRelief.
// `crowdedByes` is the set of upcoming weeks where our STARTERS on bye are at or
// over the crowded threshold (computed by upcomingByeCrunch from a lookahead).
// The add earns a credit if it plays through a crowded week and a debit if it is
// itself on one; a drop that thins a crowded week also earns a credit. This is a
// RANKING nudge only and never a gate, so it can reorder two comparable moves but
// can never turn a lineup-negative move into an accepted one (the week-8 lesson:
// a bye relieves one week of seventeen, it is not worth a bad add).
function byeCreditFor(
  incoming: AvailablePlayer,
  dropped: RailPlayer | null,
  crowdedByes: Set<number>,
  cfg: WaiverConfig,
): number {
  if (crowdedByes.size === 0) return 0;
  let credit = 0;
  if (incoming.bye != null && crowdedByes.has(incoming.bye)) credit -= cfg.byeReliefPts; // deepens the hole
  else credit += cfg.byeReliefPts; // an available body through the crowded week
  if (dropped?.bye != null && crowdedByes.has(dropped.bye)) credit += cfg.byeReliefPts; // thinning it out
  return credit;
}

// Plan a single available player into a decisive move. `crowdedByes` is optional
// and defaults to none, so the bye term is inert unless the caller supplies the
// lookahead result; every existing gate is unchanged.
export function planOne(
  incoming: AvailablePlayer,
  state: RosterState,
  cfg: WaiverConfig = DEFAULT_WAIVERS,
  crowdedByes: Set<number> = new Set(),
): WaiverMove {
  const base = { add: incoming.name, position: incoming.position, onWaivers: incoming.onWaivers };
  const skip = (reason: string): WaiverMove =>
    ({ ...base, kind: "skip", drop: null, dropPath: "none", gainPts: 0, startsForUs: false, priorityWorthy: false, byeCredit: 0, score: 0, reason });

  const best = evalPaths(incoming, state, cfg)[0];
  if (!best) return skip("no legal path: nothing on the roster may be dropped and no slot is open");

  const { gain, starts, path, drop } = best;
  const droppedPlayer = drop ? state.roster.find((p) => p.name === drop) ?? null : null;
  const byeCredit = byeCreditFor(incoming, droppedPlayer, crowdedByes, cfg);
  const byeNote =
    byeCredit > 0 ? " [plays through a crowded upcoming bye]" : byeCredit < 0 ? " [on a crowded upcoming bye]" : "";
  const move = (kind: MoveKind, priorityWorthy: boolean, reason: string): WaiverMove =>
    ({ ...base, kind, drop, dropPath: path, gainPts: gain, startsForUs: starts, priorityWorthy, byeCredit, score: Math.round((gain + byeCredit) * 10) / 10, reason: reason + byeNote });

  // A move that would LOWER our starting lineup is never made, whatever the raw
  // point gap suggests. This is the guard against dropping a needed player (our
  // only kicker, say) to roster a higher-scoring but redundant position.
  const needsDrop = drop !== null;
  if (needsDrop && gain <= 0) {
    return skip(`no add improves the lineup without weakening it (best option ${describe(best)} nets ${gain} ROS)`);
  }

  if (!incoming.onWaivers) {
    // Cleared waivers: costless. Into an open slot, take any positive-ROS depth
    // (drops nobody). If it entails a drop, require a real lineup improvement.
    if (needsDrop && gain < cfg.freeAddMarginPts) {
      return skip(`free agent, but the only add lifts the lineup just +${gain} ROS (needs a drop; under the ${cfg.freeAddMarginPts}pt bar)`);
    }
    const how = drop ? `drop ${drop}` : path === "ir-stash" ? best.reason : "open bench slot, no drop";
    return move("free-add", false, `free agent, costless — ${how}${starts ? `; starts for us (+${gain} ROS)` : `; +${gain} ROS depth`}`);
  }

  // On waivers: burning a queue position. High bar, on the LINEUP improvement.
  const bigEnough = gain >= cfg.claimMarginPts;
  const startsOk = starts || !cfg.claimMustStart;
  if (bigEnough && startsOk) {
    const how = drop ? `drop ${drop}` : "no drop";
    return move("waiver-claim", true, `worth a priority burn: +${gain} ROS to the lineup${starts ? " (he starts)" : ""} — ${how}`);
  }
  // Not worth going last: wait for him to clear, then free-add for nothing.
  const why = !bigEnough
    ? `only +${gain} ROS to the lineup, under the ${cfg.claimMarginPts}pt claim bar`
    : "would not start for us";
  return move("wait", false, `do NOT claim (${why}); wait for him to clear and free-add at no priority cost`);
}

function describe(p: PathEval): string {
  return p.drop ? `drop ${p.drop}` : p.path;
}

// Plan the whole waiver board: evaluate every available player, drop the skips,
// and rank the actionable moves. Free costless adds first (do them regardless),
// then priority-worthy claims by gain, then the "wait" notes. This ordering
// reflects the plan: prefer costless adds, claim rarely and decisively.
export function planWaivers(
  available: AvailablePlayer[],
  state: RosterState,
  cfg: WaiverConfig = DEFAULT_WAIVERS,
  crowdedByes: Set<number> = new Set(),
): WaiverMove[] {
  const moves = available.map((p) => planOne(p, state, cfg, crowdedByes)).filter((m) => m.kind !== "skip");
  const rank: Record<MoveKind, number> = { "free-add": 0, "waiver-claim": 1, wait: 2, skip: 3 };
  // Rank on `score` (gain plus the bye tie-break), not raw gain, so a crowded-bye
  // relief edges ahead of an equal-gain move that ignores the bye. The gates that
  // decided each move were pure lineup delta, so this only reorders survivors.
  return moves.sort((a, b) => rank[a.kind] - rank[b.kind] || b.score - a.score);
}

// The single most decisive move for this cycle. Because a successful claim sends
// us to the back of the queue, we submit AT MOST ONE claim per waiver run (the
// best one). Costless free-agent adds are unlimited and separate. This returns
// the one claim to submit, if any is worth it.
export function bestClaim(moves: WaiverMove[]): WaiverMove | null {
  return moves.find((m) => m.kind === "waiver-claim") ?? null;
}

// #region upcoming-bye lookahead
//
// The week-8 hole (four starters: McCaffrey, Nico Collins, Etienne, Evans; about
// 10.7 points, the worst single-week hole in the league) could NOT be fixed on
// draft night: every free agent off that bye was worse than our worst week-8
// starter, and IR cannot park a healthy player. So it is a week-7 job, and the
// system has to remember it rather than rely on a human noticing. Each weekly run
// scans a lookahead and treats relieving a crowded STARTER bye as an objective.
//
// It counts STARTERS on the bye, not roster bodies: four bench players sharing a
// bye costs nothing, so a raw roster count would fire on weeks that do not hurt.
// The starters are our optimal ROS lineup, which is the honest proxy for "who we
// would field" that far out.

export interface ByeWeekLoad {
  week: number;
  count: number; // our optimal-lineup STARTERS on bye that week
  names: string[]; // those starters, for the report
}

// Our optimal-ROS starters that sit on `week`'s bye.
export function startersOnByeAt(roster: RailPlayer[], startingSlots: string[], week: number): ByeWeekLoad {
  const starters = solveLineup(roster.map(asLineup), startingSlots).starters;
  // asLineup carries name as playerId, so map back to the roster to read bye.
  const byeByName = new Map(roster.map((p) => [p.name, p.bye]));
  const names = starters.filter((s) => byeByName.get(s.name) === week).map((s) => s.name);
  return { week, count: names.length, names };
}

// Scan the next `byeLookaheadWeeks` for weeks where our starters-on-bye reaches
// the crowded threshold. Nearest crowded week first, because it is the one there
// is least time left to fix.
export function upcomingByeCrunch(
  roster: RailPlayer[],
  startingSlots: string[],
  fromWeek: number,
  cfg: WaiverConfig = DEFAULT_WAIVERS,
): ByeWeekLoad[] {
  const out: ByeWeekLoad[] = [];
  for (let w = fromWeek + 1; w <= fromWeek + cfg.byeLookaheadWeeks; w++) {
    const load = startersOnByeAt(roster, startingSlots, w);
    if (load.count >= cfg.crowdedByeAt) out.push(load);
  }
  return out.sort((a, b) => a.week - b.week);
}

// The set of crowded upcoming weeks, for the per-move bye tie-break.
export function crowdedByeWeeks(crunch: ByeWeekLoad[]): Set<number> {
  return new Set(crunch.map((c) => c.week));
}
// #endregion

// #region IR opportunity detection
//
// An IR slot is a costless roster expansion: when a rostered player picks up an
// IR-eligible designation we can park him on reserve and carry an extra active
// body for free. This is the one mechanism that can genuinely help a crowded bye
// if someone gets hurt in the weeks before it. It also protects the stash: an
// injured player projected back before the playoffs belongs on IR, kept cheaply,
// never dropped.
//
// IR-eligibility is LEAGUE-CONFIGURED. Our league sets reserve_slots: 2 (which is
// NOT visible in roster_positions, only in settings.reserve_slots, a live-API
// discovery on 2026-08-31) and allows OUT and SUS onto IR but not NA/DNR/DOUBTFUL
// via the reserve_allow_* flags. So the caller passes the real eligibility test
// rather than assuming a fixed status set.

export interface IrOpportunity {
  name: string;
  position: string;
  injuryStatus: string | undefined;
  isStash: boolean; // projected back before the playoffs: the rails keep him regardless
  reason: string;
}

// Rostered players who could move to a free IR slot right now, best stash first.
// Empty when there are no free IR slots (nothing to gain) or nobody is eligible.
export function irOpportunities(
  roster: RailPlayer[],
  openIrSlots: number,
  irEligible: (status?: string | null) => boolean = isReserveInjury,
): IrOpportunity[] {
  if (openIrSlots <= 0) return [];
  const eligible = roster.filter((p) => p.returnsBeforePlayoffs || irEligible(p.injuryStatus));
  // Stashes first (highest value to protect), then by ROS so a genuine asset is
  // parked before a fringe body when slots are scarce.
  eligible.sort((a, b) => Number(b.returnsBeforePlayoffs ?? false) - Number(a.returnsBeforePlayoffs ?? false) || b.points - a.points);
  return eligible.slice(0, openIrSlots).map((p) => ({
    name: p.name,
    position: p.position,
    injuryStatus: p.injuryStatus,
    isStash: !!p.returnsBeforePlayoffs,
    reason: p.returnsBeforePlayoffs
      ? `${p.name} is a playoff-return stash (${p.injuryStatus ?? "injured"}); IR keeps him and frees an active slot for a costless add`
      : `${p.name} is ${p.injuryStatus ?? "injured"} and IR-eligible; moving him to IR frees an active slot for a costless add`,
  }));
}
// #endregion

/** Transactions that dropped somebody and that we have not yet reacted to.
 *
 *  A drop anywhere in the league opens a waiver window on that player, and this
 *  league clears two days after the drop rather than weekly. Computing claims
 *  only on Tuesdays therefore missed anyone dropped mid-week entirely: they
 *  cleared and were gone before the next look. Pure so the awkward cases (an
 *  add with no drop, a repeat poll, a transaction with no id) are tested rather
 *  than discovered by a claim that never happened. */
export function unreactedDrops(
  txns: { transaction_id?: string; drops?: Record<string, number> | null }[],
  alreadyReacted: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const tx of txns) {
    const id = tx.transaction_id;
    if (!id) continue;
    if (!tx.drops || Object.keys(tx.drops).length === 0) continue;
    if (alreadyReacted(id)) continue;
    out.push(id);
  }
  return out;
}
