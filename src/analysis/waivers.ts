import { canDrop, DEFAULT_RAILS, type RailPlayer, type RailConfig } from "./rails.ts";
import { solveLineup, type LineupPlayer } from "./lineup.ts";
import { irEligible as ruleIrEligible, type Settings } from "../sleeper/rules.ts";
import { LAST_WEEK, notPlaying } from "./value.ts";
import { byeAwareLineupTotal, depthInsurance, DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { chooseForcedDrops, keptStarters } from "./roster-fit.ts";
import { SWAP_POSITIONS } from "./streaming.ts";

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
  // Starting-lineup improvement (ROS points) required before ANY add that
  // entails a DROP, free agent or not. A costless add into an OPEN slot has no
  // drop and skips this. It was 1 until 2026-09-23, when the planner proposed
  // "add Malik Willis (+2), drop DK Metcalf": a drop is not reversible, the
  // dropped man is claimed by someone else, so the bar is a real gain.
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
  // BENCH SWAPS (Filip, 2026-09-30): "there's a running back we have whose
  // projected average for the rest of the season is eight, and a free agent
  // whose average is ten: swap them." A swap that changes no starter still
  // counts when the incoming player beats the outgoing one at a swappable
  // position by this many points PER REMAINING WEEK. A drop is for the
  // season, so the bar is a real per-week gap, not a rounding error.
  benchSwapMarginPerWeek: number;
  // The same for a claim, which costs our waiver position: higher.
  benchClaimMarginPerWeek: number;
  // A free agent into an OPEN bench slot costs nobody, but a body who would
  // start in no week and cover nobody is a wasted slot. He must add this
  // much to the team over the season (depthGain) to be taken.
  openSlotMinPts: number;
  // ONE-WEEK RENTALS (Filip, 2026-10-06): "If we have two players that are
  // injured that means we can pick up two players. Even if it's just for
  // one week, those players might be better than some of our starters but
  // only for this one week. So we want to keep our starters and just for
  // this week stream that defense." A body who lifts THIS week's lineup by
  // this many points is taken into a slot that costs the season nothing: an
  // open slot, an IR stash whose return cut is the rental himself, or the
  // slot of a body worth no more than him for the rest of the season. Two
  // points, because weekly projections at kicker and defense move by a
  // point on no news at all.
  weekRentalMinPts: number;
}

export const DEFAULT_WAIVERS: WaiverConfig = {
  rails: DEFAULT_RAILS,
  claimMarginPts: 15, // lineup ROS; a genuine multi-week difference, not a streamer
  freeAddMarginPts: 5, // a drop is for a real gain, never for a rounding error
  claimMustStart: true,
  crowdedByeAt: 3, // same threshold as the trade engine's byeRelief
  byeReliefPts: 4, // same modest tie-break weight as trades
  byeLookaheadWeeks: 2,
  benchSwapMarginPerWeek: 1.0,
  benchClaimMarginPerWeek: 2.0,
  openSlotMinPts: 1.0,
  weekRentalMinPts: 2.0,
};

// A player available to add. `onWaivers` is the pricing switch: true means a
// claim would burn our queue position; false means he has cleared and is a
// costless free-agent add.
export interface AvailablePlayer extends RailPlayer {
  onWaivers: boolean;
  rosteredPct?: number; // Sleeper rostered %, a scarcity signal for ranking
}

/** Who leaves when a player parked on IR comes back and the roster is full,
 *  by the same rule the activation uses (roster-fit.ts chooseForcedDrops):
 *  the lowest rest-of-season value that keeps every starting slot filled,
 *  this week's starters kept, the rails respected. The stashed man is back
 *  and healthy, so he is a candidate like anyone. Null when the rails leave
 *  no legal cut. */
export function forecastReturnCut(
  roster: RailPlayer[], returning: RailPlayer, incoming: RailPlayer, currentStarters: string[], rails: RailConfig, slots?: readonly string[],
  canFill: (body: RailPlayer, starter: RailPlayer) => boolean = () => false,
): string | null {
  const back: RailPlayer = { ...returning, onIr: false, claimAdd: false, injuryStatus: undefined, returnsBeforePlayoffs: false };
  // A pending claim's add is ours by then.
  const then = [...roster.filter((p) => p.name !== returning.name).map((p) => ({ ...p, claimAdd: false })), back, { ...incoming, onIr: false, claimAdd: false }];
  // A starting kicker or defense with a better body behind him who plays is
  // not kept (roster-fit.ts keptStarters): the rental is the cut.
  return chooseForcedDrops(then, 1, undefined, keptStarters(currentStarters, then, canFill), rails, slots)[0]?.name ?? null;
}

/** Every return the move leaves to come (the players on IR after it) cuts
 *  somebody this move may cost anyway: the newcomer, the returning man, or
 *  the player the direct path would drop today. Pure. */
export function returnsAcceptable(args: {
  active: RailPlayer[]; reserveAfter: RailPlayer[]; incoming: RailPlayer; directDrop: string | null; currentStarters: string[]; rails: RailConfig; slots?: readonly string[];
  /** The newcomer starts this week: forecast with him kept as well. */
  incomingStarts?: boolean;
  /** Who can take a starter's slot this week (RosterState.canFill). */
  canFill?: (body: RailPlayer, starter: RailPlayer) => boolean;
}): { ok: boolean; cuts: { returning: string; cut: string | null }[] } {
  // Per return: with this week's starters kept, and, for a newcomer who
  // starts this week, with him kept as well, since a rental starts in
  // exactly the weeks it matters and the activation keeps that week's
  // starters (2026-10-06 review: the Bengals starting on a Thursday,
  // Dowdle flipping to Questionable, and the cut landing on
  // Croskey-Merritt instead of the Bengals).
  const cuts = args.reserveAfter.flatMap((r) => [
    { returning: r.name, cut: forecastReturnCut(args.active, r, args.incoming, args.currentStarters, args.rails, args.slots, args.canFill) },
    ...(args.incomingStarts ? [{ returning: r.name, cut: forecastReturnCut(args.active, r, args.incoming, [...args.currentStarters, args.incoming.name], args.rails, args.slots, args.canFill) }] : []),
  ]);
  const ok = cuts.every((c) => c.cut !== null && [args.incoming.name, c.returning, args.directDrop].includes(c.cut));
  return { ok, cuts };
}

// The current roster state the drop-path resolver needs. "Prefer paths that drop
// nobody" (the plan): an empty bench slot first, then an IR slot for a genuinely
// injured incumbent (which opens a bench slot without a drop), and only then a
// straight drop.
export interface RosterState {
  roster: RailPlayer[];
  /** Empty active slots right now, however they arose. A slot opened by
   *  parking a player on IR is a slot (Filip, 2026-10-06: "take advantage of
   *  IR"); his return is priced by forecastReturnCut on the way in, not by
   *  leaving the seat empty. Until 2026-10-06 such a slot was "owed" to him
   *  and took only an add the lineup justified. */
  openBenchSlots: number;
  openIrSlots: number; // empty IR (reserve) slots right now
  startingSlots: string[]; // roster_positions with BN/IR removed, for the "would he start" test
  // Whether a Sleeper injury status makes a player IR-eligible in THIS league.
  // The eligible set is league-configured (reserve_allow_out/sus/cov/... flags),
  // not universal: our league allows OUT and SUS onto IR but not NA or DNR, which
  // the old fixed set got wrong both ways. Absent = IR and PUP only, which every
  // league accepts (sleeper/rules.ts irEligibleSet with no flags).
  irEligible?: (status?: string | null) => boolean;
  /** Names of this week's starters as the site has them. A starter is neither
   *  dropped nor stashed on IR by the waiver run before his game locks: the
   *  lineup guard decides who starts, and a drop table that can name DK
   *  Metcalf is the 2026-09-23 audit's finding R7. */
  currentStarters?: string[];
  /** Whether a body, ours or arriving, can take a starter's slot this week:
   *  projected to play, not locked out of the slot, not leaving on a pending
   *  claim (week-projections.ts startableThisWeek). It decides which starter
   *  a cut keeps (roster-fit.ts keptStarters): a starting kicker or defense
   *  with a better body behind him who can fill the slot is the cut, not the
   *  better body, and a starting back, receiver or tight end the newcomer
   *  beats at his own position and can replace this week is a drop path for
   *  that newcomer. Absent = nobody can, and every starter is kept. */
  canFill?: (body: RailPlayer, starter: RailPlayer) => boolean;
  /** Weeks left in the fantasy season, to turn a per-week margin into points. */
  weeksLeft?: number;
  /** Players of ours already on injured reserve. Each one comes back, and
   *  the activation then cuts the lowest rest-of-season value on the
   *  roster (roster-fit.ts). An add into an open slot is checked against
   *  every return the same way a stash is (forecastReturnCut). Absent =
   *  nobody on IR. */
  reserve?: RailPlayer[];
  /** We are last in the rolling waiver order, so a successful claim moves us
   *  nowhere: a claim costs nothing and is gated like a free add. Absent =
   *  false, the priority has value. */
  priorityFree?: boolean;
  /** THIS week's projection by player name, for our roster and the pool,
   *  already zero for a player on bye, not playing, or whose game this week
   *  has kicked off. The one place a weekly number enters the planner: a
   *  one-week rental is a lineup decision (value.ts). Absent = no rentals. */
  weekPoints?: Map<string, number>;
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
  /** For dropPath "ir-stash": the rostered player who must be moved to IR
   *  BEFORE the add, to free the active slot it goes into. The reason string
   *  named him but nothing could act on prose, so the executor submitted the
   *  add into a full roster and Sleeper rejected it. */
  irStash: string | null;
  /** Justified by THIS week's lineup only (weekRentalMinPts): a one-week
   *  rental into a slot that costs the season nothing. */
  rental: boolean;
  /** This week's lineup gain of the move (weekPoints), 0 when unknown. */
  weekGainPts: number;
  gainPts: number; // ROS points the add clears the player it replaces (or the worst starter, for a slot add)
  benchGainPts: number; // incoming minus the same-position bench body he replaces; the tie-break among equal lineup gains
  startsForUs: boolean; // would the add crack our optimal ROS starting lineup
  priorityWorthy: boolean; // clears the bar to burn a queue position
  // Bye tie-break: + if this add plays through an upcoming crowded starter bye,
  // - if it is itself on that bye. NEVER enters an accept gate; it only ranks
  // moves that already passed the lineup-delta gates (mirrors trade-fair.ts).
  byeCredit: number;
  /** For a free agent into an open bench slot: what the extra body is worth
   *  to the team for the rest of the season (depthGain). 0 for every other
   *  move; those are judged on gainPts and benchGainPts. */
  depthPts: number;
  score: number; // gainPts + byeCredit, or depthPts for a free agent into an open slot; the ranking key
  reason: string;
}

// The rest-of-season lineup. `points` already prices the weeks a hurt player
// misses, so his status is NOT passed: with it, solveLineup benched an Out
// WR1 for the whole rest of the season and any drop of him read as free.
function asLineup(p: RailPlayer): LineupPlayer {
  return { playerId: p.name, name: p.name, position: p.position, points: p.points };
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
  rails: RailConfig = DEFAULT_RAILS,
  /** The drop is a seat (a spare kicker or defense): the bench gain is
   *  measured as for a no-drop path, against the cheapest body at the
   *  newcomer's own position, not against the spare. */
  seat = false,
): { gain: number; starts: boolean; benchGain: number; benchPerGame: number } {
  // The stashed man stays in both sides. `points` is rest-of-season value
  // and already carries nothing for the weeks he misses, so the season
  // lineup with him in it is the honest baseline. Until 2026-10-02 he was
  // taken out, and an add who started only while he was hurt counted his
  // whole season as lineup gain: with Nico Collins Out, a 165-point receiver
  // read as +16.9 and a claim, and as +0 with the IR slots full.
  const base = state.roster;
  const baseline = solveLineup(base.map(asLineup), state.startingSlots).total;
  const kept = base.filter((p) => p.name !== dropName).map(asLineup);
  const after = solveLineup([...kept, asLineup(incoming)], state.startingSlots);
  const starts = after.starters.some((s) => s.playerId === incoming.name);
  // Bench gain: what the add is worth against the man he replaces. For a
  // drop path that is the dropped player; for a no-drop path (open slot, IR
  // stash) it is the cheapest bench body we could otherwise have cut, since
  // that is who the add is really being compared with.
  const dropped = dropName && !seat ? state.roster.find((p) => p.name === dropName) ?? null : cheapestSwappable(incoming, state, rails);
  const benchGain = dropped && swappable(incoming.position, dropped.position)
    ? Math.round((incoming.points - dropped.points) * 10) / 10
    : 0;
  // The same comparison per game played. A rest-of-season sum counts games,
  // so a player whose bye is still to come trails an equal one whose bye has
  // passed by a whole game; late in the season that alone cleared the bar.
  const benchPerGame = dropped && swappable(incoming.position, dropped.position)
    ? Math.round((incoming.points / gamesLeft(incoming, state) - dropped.points / gamesLeft(dropped, state)) * 10) / 10
    : 0;
  return { gain: Math.round((after.total - baseline) * 10) / 10, starts, benchGain, benchPerGame };
}

/** Games a player still has: the weeks left, less his bye if it is still to
 *  come. No bye known means no bye assumed. */
export function gamesLeft(p: { bye?: number }, state: Pick<RosterState, "weeksLeft">): number {
  const weeks = Math.max(1, state.weeksLeft ?? 14);
  const thisWeek = LAST_WEEK - weeks + 1;
  const byeAhead = p.bye != null && p.bye >= thisWeek && p.bye <= LAST_WEEK;
  return Math.max(1, weeks - (byeAhead ? 1 : 0));
}

/** What one more body is worth to the team for the rest of the season, in
 *  the trade engine's currency: the best lineup week by week with the bye
 *  players out, plus the bench as injury cover (trade-fair.ts).
 *
 *  This is the number for a free agent into an OPEN bench slot. Such adds
 *  all tie at a rest-of-season lineup gain of zero, and until 2026-10-01 the
 *  tie broke on points over the cheapest bench body at the newcomer's own
 *  position: a third quarterback, measured against the second, won it. He
 *  covers no bye the second does not and is the third man behind one slot,
 *  so here he is worth nothing; a back or a receiver who fills a flex slot
 *  in a bye week and is next in line behind three starters is worth points.
 *  A newcomer who is not playing now covers nobody, so he gets the lineup
 *  term only. */
export function depthGain(incoming: RailPlayer, state: Pick<RosterState, "roster" | "startingSlots" | "weeksLeft">): number {
  const weeks = Math.max(1, state.weeksLeft ?? 14);
  const first = LAST_WEEK - weeks + 1;
  const upcoming = Array.from({ length: weeks }, (_, i) => first + i);
  const after = [...state.roster, incoming];
  const lineup = byeAwareLineupTotal(after, upcoming, state.startingSlots) - byeAwareLineupTotal(state.roster, upcoming, state.startingSlots);
  const cover = notPlaying(incoming.injuryStatus) ? 0
    : depthInsurance(after, DEFAULT_FAIRNESS, state.startingSlots) - depthInsurance(state.roster, DEFAULT_FAIRNESS, state.startingSlots);
  return Math.round((lineup + cover) * 10) / 10;
}

/** Positions where a bench body is depth: the trade engine's cover positions. */
const DEPTH_POSITIONS: ReadonlySet<string> = new Set(DEFAULT_FAIRNESS.depthPositions);

/** Positions where a better player may replace a top-N-protected bench
 *  player (evalPaths). The flex positions only: there a bench body is depth
 *  and rest-of-season points are what he is. A bench quarterback plays only
 *  when he beats the starter, so his raw points are not his value, and a
 *  kicker or defense is never bench depth at all. */
export const UPGRADE_POSITIONS: ReadonlySet<string> = new Set(["RB", "WR", "TE"]);

/** The starters the newcomer's drop paths may not touch (roster-fit.ts
 *  keptStarters): every name on the leg but a kicker or defense with a
 *  better body behind him who can fill the slot, and a back, receiver or
 *  tight end the newcomer himself beats on the one value and can replace
 *  this week. With no `canFill` nobody fills a slot and every starter is
 *  kept, the 2026-09-23 finding R7 as it stood. */
function keptFrom(incoming: RailPlayer, state: RosterState): Set<string> {
  return new Set(keptStarters(state.currentStarters ?? [], state.roster, state.canFill ?? (() => false), incoming).map((n) => n.toLowerCase()));
}

function cheapestSwappable(incoming: RailPlayer, state: RosterState, rails: RailConfig): RailPlayer | null {
  const kept = keptFrom(incoming, state);
  // Same-position comparison, so the top-N rail is off here as it is for the
  // same-position drop path in evalPaths; every other rail holds.
  const swapRails: RailConfig = { ...rails, protectTopN: 0 };
  let best: RailPlayer | null = null;
  for (const p of state.roster) {
    if (kept.has(p.name.toLowerCase()) || !swappable(incoming.position, p.position)) continue;
    if (!canDrop(p.name, state.roster, swapRails).allowed) continue;
    if (!best || p.points < best.points || (p.points === best.points && (p.seasonPoints ?? 0) < (best.seasonPoints ?? 0))) best = p;
  }
  return best;
}

/** A bench swap is same-position only. A better body at another position is
 *  the lineup delta's business: if he would start, the lineup gain shows it;
 *  if he would not, a third tight end for a fifth running back is a worse
 *  bench whatever the raw points say (2026-09-30 replay: Hunter Henry, TE,
 *  131 points, "beat" Kenny Gainwell, RB, 106, and would never have played). */
export function swappable(a: string, b: string): boolean {
  return a === b;
}

interface PathEval {
  path: DropPath;
  drop: string | null;
  gain: number; // starting-lineup ROS delta of taking this path
  benchGain: number; // incoming minus dropped at a swappable position, else 0
  benchPerGame: number; // the same gap per game played, so a bye still to come is not an upgrade
  /** A drop only the same-position upgrade rule allows (the top-N rail
   *  protects him). It may serve a bench upgrade, never a lineup-gain add. */
  upgradeOnly?: boolean;
  starts: boolean; // does the add start after it
  reason: string;
  irStash?: string; // set only on the "ir-stash" path
  /** The players on IR after the move, and who the forecast says leaves
   *  when each returns (returnsAcceptable), in the same order. planOne
   *  decides whether those cuts are acceptable. */
  returning?: string[];
  returnCuts?: string[];
  /** The drop is a spare kicker or defense: a seat, not a cut (evalPaths). */
  spare?: boolean;
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
  const paths: { path: DropPath; drop: string | null; reason: string; irStash?: string; upgradeOnly?: boolean; returnCut?: string | null }[] = [];

  // Every canDrop-ALLOWED player is a candidate drop. canDrop is the authority on
  // what may leave the roster; we pick among the allowed ones by lineup delta.
  // A current-week starter the cut keeps is never on the table (R7, as
  // narrowed on 2026-10-08: a starter is kept only while nobody better can
  // fill his slot this week, the newcomer included. Josh Downs, a bench
  // receiver on the one value starting a bye week at FLEX, was no path for
  // Matthew Golden, 18 ROS better at his position and playing that week,
  // and the add read as "drop Dowdle, +0").
  //
  // One widening (2026-09-30 review): at a flex position (UPGRADE_POSITIONS)
  // a better player at the SAME position may replace a bench player the
  // top-N rail protects. That rail stops a good player being dropped for a
  // streamer; a same-position upgrade leaves the bench stronger where it
  // stood. Without it the swap could only ever reach the two cheapest bench
  // bodies (two quarterbacks fill the top of the list, kicker and defense
  // the bottom), and no free-agent receiver could replace our one bench
  // receiver. Never-drop, the stash, IR and a pending claim's drop are
  // checked with the top-N rail off and still refuse. Such a path is marked
  // upgradeOnly: it serves a bench upgrade and nothing else (see the sort).
  const kept = keptFrom(incoming, state);
  const upgradeRails: RailConfig = { ...cfg.rails, protectTopN: 0 };
  for (const p of state.roster) {
    if (kept.has(p.name.toLowerCase())) continue;
    if (canDrop(p.name, state.roster, cfg.rails).allowed) {
      paths.push({ path: "drop", drop: p.name, reason: `drop ${p.name}` });
      continue;
    }
    const upgrade = UPGRADE_POSITIONS.has(p.position) && swappable(incoming.position, p.position) && incoming.points > p.points;
    if (upgrade && canDrop(p.name, state.roster, upgradeRails).allowed) {
      paths.push({ path: "drop", drop: p.name, reason: `drop ${p.name}`, upgradeOnly: true });
    }
  }

  // A spare kicker or defense (the extra body at his position, not the
  // best there, not a kept starter this week: a rental whose week is over)
  // is a seat, not a cut. Without this a spent rental blocked his own seat:
  // every depth body read as "drop the Bengals, lifts the lineup +0".
  const bestAt = new Map<string, string>();
  for (const p of state.roster) { const b = bestAt.get(p.position); if (!b || (state.roster.find((q) => q.name === b)?.points ?? 0) < p.points) bestAt.set(p.position, p.name); }
  // A kicker or defense with points this week is not spare either: a
  // rental who starts Thursday is "spare" to the roster read until the
  // lineup guard writes the leg (second review, 2026-10-06).
  const isSpare = (name: string | null): boolean => {
    const p = name ? state.roster.find((q) => q.name === name) : undefined;
    return !!p && SWAP_POSITIONS.has(p.position) && bestAt.get(p.position) !== p.name && !kept.has(p.name.toLowerCase())
      && (state.weekPoints?.get(p.name) ?? 0) === 0;
  };
  const evals = paths.map((p) => {
    const spare = isSpare(p.drop);
    const { gain, starts, benchGain, benchPerGame } = lineupDelta(incoming, p.drop, state, cfg.rails, spare);
    return { ...p, gain, starts, benchGain, benchPerGame, spare } as PathEval;
  });
  // Best lineup gain first; among equals drop nobody; then the bigger bench
  // gain (the cheapest body at the newcomer's own position, so a back
  // arriving costs a back and the one tight end behind the starter stays);
  // and finally, among drops that still tie, the cheapest body by the cut
  // order. Never list order: that is how an 80-point back went before a
  // 5-point second defense.
  const cutKey = (e: { drop: string | null }): [number, number, string] => {
    const p = e.drop ? state.roster.find((r) => r.name === e.drop) : undefined;
    return p ? [p.points, p.seasonPoints ?? 0, p.name] : [Number.POSITIVE_INFINITY, 0, ""];
  };
  // A spare's seat ranks just behind a truly open one: nobody leaves while a slot is open.
  const rank = (e: PathEval): number => (e.spare ? PATH_RANK["bench-slot"] + 0.5 : PATH_RANK[e.path]);
  const order = (a: PathEval, b: PathEval): number => {
    const d = b.gain - a.gain || rank(a) - rank(b) || b.benchGain - a.benchGain;
    if (d) return d;
    const [ap, as, an] = cutKey(a); const [bp, bs, bn] = cutKey(b);
    return ap - bp || as - bs || an.localeCompare(bn);
  };
  // When the lineup gain alone justifies the add (he starts, by enough), the
  // ordinary rails decide who leaves, exactly as before the widening: a
  // top-N-protected player is never cut to make room for a starter while an
  // unprotected body exists. Only an add that can count as nothing but a
  // bench upgrade may reach past the top-N rail.
  const lineupEnough = (e: { gain: number; starts: boolean }): boolean => incoming.onWaivers && !state.priorityFree
    ? e.gain >= cfg.claimMarginPts && (e.starts || !cfg.claimMustStart)
    : e.gain >= cfg.freeAddMarginPts;
  const ordinary = evals.filter((e) => !e.upgradeOnly).sort(order);
  const direct = ordinary[0] && lineupEnough(ordinary[0]) ? ordinary : evals.sort(order);
  const starterNames = state.currentStarters ?? [];
  const noDrop = (): Pick<PathEval, "gain" | "starts" | "benchGain" | "benchPerGame"> => lineupDelta(incoming, null, state, cfg.rails);
  // Who leaves when each player on IR after the move comes back. A return
  // with no legal cut at all is not offered (the activation would be stuck).
  const forecast = (active: RailPlayer[], reserveAfter: RailPlayer[], dropName: string | null = null): { returning: string[]; returnCuts: string[] } | null => {
    const incomingStarts = weekLineupGain(incoming, dropName, state) > 0;
    const r = returnsAcceptable({ active, reserveAfter, incoming, directDrop: null, currentStarters: starterNames, rails: cfg.rails, slots: state.startingSlots, incomingStarts, canFill: state.canFill });
    if (r.cuts.some((c) => c.cut === null)) return null;
    return { returning: r.cuts.map((c) => c.returning), returnCuts: r.cuts.map((c) => c.cut!) };
  };

  // AN OPEN SLOT is a seat, however it arose (Filip, 2026-10-06: "take
  // advantage of IR"). When a player of ours is on IR the seat is checked
  // against his return the same way a stash is: whoever the activation
  // would cut then must be somebody this move may cost anyway (planOne).
  // A drop path is forecast too: the man dropped is allowed as a return
  // cut, nobody else new (2026-10-06 review: seat Tre Tucker by parking
  // Etienne, then drop Tucker for Malik Washington as a bench upgrade, and
  // Etienne's return cut Mark Andrews after all).
  const out: PathEval[] = direct.map((e) => {
    if (!e.drop || !(state.reserve ?? []).length) return e;
    const f = forecast(state.roster.filter((p) => p.name !== e.drop), state.reserve ?? [], e.drop);
    return f ? { ...e, ...f } : { ...e, returning: ["?"], returnCuts: ["?"] };
  });
  if (state.openBenchSlots > 0) {
    const f = forecast(state.roster, state.reserve ?? []);
    if (f) out.push({ path: "bench-slot", drop: null, ...noDrop(), ...f, reason: "into an open bench slot (no drop)" });
  }

  // THE IR STASH (Filip, 2026-10-06: "take advantage of IR"). An IR slot
  // with an injured incumbent frees an active slot without cutting anyone
  // today, for any add. It is a deferred drop: he comes back, and the
  // activation cuts the lowest rest-of-season value then (roster-fit.ts).
  // Eligibility is the league's flags and nothing else: a playoff-return
  // stash who is merely Questionable is not IR-eligible, and Sleeper
  // refused exactly that write on 2026-09-22. Longest absence first
  // (stashCandidates), never a current starter.
  const stashable = stashCandidates(state, cfg)[0];
  if (state.openIrSlots > 0 && stashable) {
    const active = state.roster.filter((p) => p.name !== stashable.name);
    const f = forecast(active, [...(state.reserve ?? []), stashable]);
    if (f) {
      const own = f.returnCuts[f.returning.indexOf(stashable.name)];
      out.push({ path: "ir-stash", drop: null, irStash: stashable.name, ...noDrop(), ...f,
        reason: `stash ${stashable.name} (${stashable.injuryStatus ?? "injured"}) on IR (no drop; on his return ${own === incoming.name ? "the newcomer" : own === stashable.name ? "he himself" : own} goes)` });
    }
  }
  return out.sort(order);
}

/** Statuses that are multi-week by definition: parked by the NFL, not a
 *  game-day designation. */
const LONG_ABSENCE = new Set(["IR", "PUP", "SUS", "COV", "NA", "DNR"]);

// With no league flags only IR and PUP qualify. The live run always passes the
// league's real flags through RosterState.irEligible.
const NO_FLAGS: Settings = { num_teams: 0, playoff_teams: 0, playoff_week_start: 0, trade_deadline: 0, waiver_budget: 0, max_keepers: 0, disable_trades: 0 };
function defaultIrEligible(status?: string | null): boolean {
  return ruleIrEligible(status, NO_FLAGS);
}

/** Rostered players who may go to IR, longest expected absence first:
 *  eligible under the league's flags, not on the never-drop list, not a
 *  current starter, not a pending claim's add (not ours yet). A player the
 *  NFL has parked (IR, PUP, suspended) before a game-day Out; among the
 *  Out, the one with the smaller share of his season left in the
 *  rest-of-season table, since the table already prices the weeks he
 *  misses. A one-week hamstring flips to Questionable by Thursday, the
 *  roster is then invalid and every lineup write is refused until the
 *  activation (reserve-reconcile.ts), which the week's games lock; the
 *  seat is worth most when its man stays away. */
export function stashCandidates(state: Pick<RosterState, "roster" | "irEligible" | "currentStarters">, cfg: Pick<WaiverConfig, "rails">): RailPlayer[] {
  const irEligible = state.irEligible ?? defaultIrEligible;
  const starters = new Set((state.currentStarters ?? []).map((n) => n.toLowerCase()));
  const never = new Set((cfg.rails.neverDrop ?? []).map((n) => n.toLowerCase()));
  const long = (p: RailPlayer): number => (LONG_ABSENCE.has((p.injuryStatus ?? "").toUpperCase()) ? 0 : 1);
  const left = (p: RailPlayer): number => ((p.seasonPoints ?? 0) > 0 ? p.points / p.seasonPoints! : 1);
  return state.roster
    .filter((p) => !p.claimAdd && irEligible(p.injuryStatus) && !never.has(p.name.toLowerCase()) && !starters.has(p.name.toLowerCase()))
    .sort((a, b) => long(a) - long(b) || Number(b.returnsBeforePlayoffs ?? false) - Number(a.returnsBeforePlayoffs ?? false) || left(a) - left(b) || b.points - a.points);
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

/** THIS week's lineup gain of the move, from RosterState.weekPoints: the
 *  best lineup this week with the newcomer in and the drop out, against
 *  today's. Zero when the week table is absent or he has no points this
 *  week (bye, out, or his game has been played). The lineup guard makes the
 *  same choice on the same numbers, so a positive answer here is a starter
 *  this week. */
export function weekLineupGain(incoming: AvailablePlayer, dropName: string | null, state: RosterState): number {
  const wp = state.weekPoints;
  if (!wp) return 0;
  const mine = (wp.get(incoming.name) ?? 0);
  if (mine <= 0) return 0;
  const week = (p: RailPlayer): LineupPlayer => ({ playerId: p.name, name: p.name, position: p.position, points: wp.get(p.name) ?? 0 });
  const baseline = solveLineup(state.roster.map(week), state.startingSlots).total;
  const kept = state.roster.filter((p) => p.name !== dropName).map(week);
  const after = solveLineup([...kept, { playerId: incoming.name, name: incoming.name, position: incoming.position, points: mine }], state.startingSlots).total;
  return Math.round((after - baseline) * 10) / 10;
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
    ({ ...base, kind: "skip", drop: null, dropPath: "none", irStash: null, rental: false, weekGainPts: 0, gainPts: 0, benchGainPts: 0, startsForUs: false, priorityWorthy: false, byeCredit: 0, depthPts: 0, score: 0, reason });

  const paths = evalPaths(incoming, state, cfg);
  if (!paths.length) return skip("no legal path: nothing on the roster may be dropped and no slot is open");
  // A seat that drops nobody today (an open slot, an IR stash) is a deferred
  // drop when a player of ours is on IR: whoever the activation cuts on his
  // return must be somebody this move may cost anyway. The newcomer
  // himself (a rental, or a body who turned out worse), the returning man
  // (a fringe body, released), the man this move drops today ...
  // ... or the man the roster would shed first anyway: the lowest value
  // that is not a starter, who goes on the next return whatever this move
  // does (Croskey-Merritt on 2026-10-06: the direct path's drop for Harvey,
  // and the cut when a rental starts and Dowdle comes back early).
  // The ONE value decides who goes on a return (Filip, 2026-09-30: one
  // number). The forecast refuses a seat only when a return would have no
  // legal cut at all, or would reach somebody this move neither names nor
  // leaves as the first-shed man; it names him in the reason otherwise.
  const shedFirst = (roster: RailPlayer[]): string | null => {
    const then = roster.map((p) => ({ ...p, claimAdd: false }));
    return chooseForcedDrops(then, 1, undefined, keptStarters(state.currentStarters ?? [], then, state.canFill ?? (() => false)), cfg.rails, state.startingSlots)[0]?.name ?? null;
  };
  const cutFirst = shedFirst(state.roster);
  const seatOk = (e: PathEval): boolean => {
    if (!e.returnCuts?.length) return true;
    if (e.returnCuts.includes("?")) return false; // a return with no legal cut: the activation would be stuck
    const afterDrop = e.drop ? shedFirst(state.roster.filter((p) => p.name !== e.drop)) : null;
    const allowed = new Set([incoming.name, ...(e.returning ?? []), e.drop, cutFirst, afterDrop]);
    return e.returnCuts.every((c) => allowed.has(c));
  };
  const best = paths.find(seatOk);
  if (!best) return skip("no seat: every way in leaves a return cut the move does not pay for");
  return verdict(best);

  function verdict(best: PathEval): WaiverMove {
  const { gain, starts, path, drop, benchGain, benchPerGame } = best;
  const irStash = best.irStash ?? null;
  const weeks = Math.max(1, state.weeksLeft ?? 14);
  // Last in the waiver order: a successful claim moves us nowhere, so a
  // claim is gated like a free add (Filip, 2026-10-06, filing a one-week
  // defense from the back of the queue). The priority bars stay for a
  // position worth keeping.
  const free = !incoming.onWaivers || !!state.priorityFree;
  const swapBar = cfg.benchSwapMarginPerWeek * weeks;
  // Who leaves later because of this seat, the newcomer himself aside.
  const laterCost = (best.returnCuts ?? []).filter((c) => c !== incoming.name);
  const claimSwapBar = cfg.benchClaimMarginPerWeek * weeks;
  // Both in total and per game played (lineupDelta): a bye still to come is
  // not an upgrade.
  // Never at kicker or defense: they are not bench depth, and a "better"
  // spare who never plays would churn the seat of a rental who does.
  const benchable = !SWAP_POSITIONS.has(incoming.position);
  // A seat whose later cut is the first-shed man is a deferred swap too.
  const benchUpgrade = benchable && (drop !== null || path === "ir-stash" || laterCost.length > 0) && benchGain >= swapBar && benchPerGame >= cfg.benchSwapMarginPerWeek;
  const droppedPlayer = drop ? state.roster.find((p) => p.name === drop) ?? null : null;
  const byeCredit = byeCreditFor(incoming, droppedPlayer, crowdedByes, cfg);
  const byeNote =
    byeCredit > 0 ? " [plays through a crowded upcoming bye]" : byeCredit < 0 ? " [on a crowded upcoming bye]" : "";

  const needsDrop = drop !== null;
  // A seat that drops nobody today costs the roster whatever the returns
  // cut later, the newcomer himself aside: a seat he keeps only as long as
  // he is worth it costs nobody else anything.
  // A spare kicker or defense is a seat (evalPaths), so dropping him costs
  // nothing; the two looks still apply to the drop (claim-exec moveCost).
  const costsSomething = (needsDrop && !best.spare) || laterCost.length > 0;
  // A free agent into an open bench slot is judged, and ranked, on what the
  // extra body is worth to the team. Claims and waits keep the lineup gain:
  // they are priced in waiver priority, not in a slot.
  const costless = !costsSomething && free;
  // A kicker or a defense is never bench depth: his bye is covered by a swap
  // in the bye week itself (streaming.ts). One is taken into an open slot
  // when we hold nobody at the position (any gain: the slot scores zero),
  // or when he starts and lifts the lineup by the margin an add with a drop
  // must clear. Without this, the week a spare kicker would cover made him
  // worth nearly as much as a fifth receiver (2026-09-30 replay: 4.7
  // against 5.1).
  const noneAtPosition = !state.roster.some((p) => p.position === incoming.position);
  const depthPts = !costless ? 0
    : DEPTH_POSITIONS.has(incoming.position) ? depthGain(incoming, state)
    : starts && gain > 0 && (noneAtPosition || gain >= cfg.freeAddMarginPts) ? gain : 0;
  // Below this an extra body is noise: 27 of the 70 best free agents of
  // 2026-09-30 cleared zero, down to an 83-point back worth 0.1.
  const depthFloor = DEPTH_POSITIONS.has(incoming.position) ? cfg.openSlotMinPts : 0;
  // THE ONE-WEEK RENTAL (Filip, 2026-10-06). This week's lineup gain, into
  // a seat that costs the season nothing: an open slot; a stash whose
  // return cut is the newcomer; or the slot of a body at his own position
  // (kicker and defense count as one, the two streamable positions) worth
  // no more than him for the rest of the season, a rental from an earlier
  // week. Never by cutting a season body: that is a drop for the season
  // against one week of points, the trade the value rule forbids; and
  // never across positions on raw points, the draft-night trap (a receiver
  // for a fifth back is not "worth more", he is depth somewhere else).
  const weekGain = weekLineupGain(incoming, drop, state);
  const likeForLike = (a: string, b: string): boolean => swappable(a, b) || (SWAP_POSITIONS.has(a) && SWAP_POSITIONS.has(b));
  // Later: nobody leaves but the newcomer, a returning fringe man, or the
  // body the roster sheds first anyway (a rental who starts keeps his seat
  // on an early return, and the cut lands on that man; he is the lowest
  // value on the roster and goes on the next move whatever this one does).
  const seatFree = laterCost.every((c) => (best.returning ?? []).includes(c) || c === cutFirst)
    && (!needsDrop || !!best.spare || (!!droppedPlayer && likeForLike(incoming.position, droppedPlayer.position) && droppedPlayer.points <= incoming.points));
  // Never the seat of a body the top-N rail protects (an upgradeOnly path):
  // a starter-tier player is not rented over for one week of points, however
  // small the one-value gap the newcomer clears him by (the 2026-10-08
  // review: a 140-point receiver with an 18-point week would have cut Josh
  // Downs, 136 and starting, as a "rental").
  const rentalOk = weekGain >= cfg.weekRentalMinPts && seatFree && gain >= 0 && !best.upgradeOnly;
  const move = (kind: MoveKind, priorityWorthy: boolean, rental: boolean, reason: string): WaiverMove =>
    ({ ...base, kind, drop, dropPath: path, irStash, rental, weekGainPts: weekGain, gainPts: gain, benchGainPts: benchGain, startsForUs: starts, priorityWorthy, byeCredit, depthPts,
      score: rental ? weekGain : costless ? depthPts : Math.round((gain + byeCredit) * 10) / 10, reason: reason + byeNote });

  // A move that would LOWER our starting lineup is never made, whatever the raw
  // point gap suggests. This is the guard against dropping a needed player (our
  // only kicker, say) to roster a higher-scoring but redundant position.
  if (needsDrop && gain < 0) {
    return skip(`no add improves the lineup without weakening it (best option ${describe(best)} nets ${gain} ROS)`);
  }

  const how = drop ? `drop ${drop}` : path === "ir-stash" ? best.reason : "open bench slot, no drop";
  if (free) {
    // Costless to our waiver position. Into an open bench slot, take the
    // body only if he is worth something to the team (depthGain): a player
    // who would start in no week and cover nobody is a wasted slot, and a
    // high-scoring one (a third quarterback) also takes a place in the
    // protected top N from a real player. If it entails a drop, require a
    // real lineup improvement, OR a real bench upgrade at a swappable
    // position (the 2026-09-30 rule), OR this week's rental.
    const kind: MoveKind = incoming.onWaivers ? "waiver-claim" : "free-add";
    const label = incoming.onWaivers ? "claim at no priority cost (we are last)" : "free agent, costless";
    if (costsSomething && gain < cfg.freeAddMarginPts && !benchUpgrade) {
      if (rentalOk) return move(kind, false, true, `${label} — ${how}; one-week rental, +${weekGain} this week`);
      return skip(`free agent, but ${describe(best)} lifts the lineup just +${gain} ROS and the bench ${benchGain >= 0 ? "+" : ""}${benchGain} (${benchPerGame >= 0 ? "+" : ""}${benchPerGame} a game; needs ${cfg.freeAddMarginPts} lineup or ${cfg.benchSwapMarginPerWeek}/week bench, in total and per game)`);
    }
    if (costless && (depthPts <= 0 || depthPts < depthFloor)) {
      if (rentalOk) return move(kind, false, true, `${label} — ${how}; one-week rental, +${weekGain} this week`);
      return skip(DEPTH_POSITIONS.has(incoming.position)
        ? `free agent and a bench slot is open, but he adds only ${depthPts} to the team over the season (needs ${cfg.openSlotMinPts}): no week he would start, nobody he would cover`
        : `free agent and a bench slot is open, but a second ${incoming.position} is not depth and he lifts the lineup just +${gain} ROS (needs ${cfg.freeAddMarginPts})`);
    }
    const why = starts ? `; starts for us (+${gain} ROS)` : benchUpgrade ? `; bench upgrade +${benchGain} ROS (${(benchGain / weeks).toFixed(1)}/week)` : `; +${depthPts} to the team over the season (bye weeks and cover)`;
    return move(kind, false, false, `${label} — ${how}${why}`);
  }

  // On waivers: burning a queue position. High bar: a real LINEUP improvement
  // from a player who starts, or a bench upgrade of claim size. A one-week
  // rental is never worth the position.
  const bigEnough = gain >= cfg.claimMarginPts;
  const startsOk = starts || !cfg.claimMustStart;
  const benchClaim = benchable && (drop !== null || path === "ir-stash") && benchGain >= claimSwapBar && benchPerGame >= cfg.benchClaimMarginPerWeek;
  if ((bigEnough && startsOk) || benchClaim) {
    // Name the stash: "no drop" on a full roster reads as a free move, and
    // the executor has to park him before it files (act/claim-exec.ts).
    const why = bigEnough && startsOk ? `+${gain} ROS to the lineup${starts ? " (he starts)" : ""}` : `bench upgrade +${benchGain} ROS (${(benchGain / weeks).toFixed(1)}/week)`;
    return move("waiver-claim", true, false, `worth a priority burn: ${why} — ${how}`);
  }
  // Not worth going last: wait for him to clear, then free-add for nothing.
  const why = !bigEnough
    ? `only +${gain} ROS to the lineup, under the ${cfg.claimMarginPts}pt claim bar`
    : "would not start for us";
  return move("wait", false, false, `do NOT claim (${why}); wait for him to clear and free-add at no priority cost`);
  }
}

/** Sleeper refused a free add because the player is on waivers. May the same
 *  move be filed as a claim instead? Only when the planner, told he is on
 *  waivers, would have claimed him anyway, and by the same route: a claim
 *  costs our waiver position, and a free add clears a far lower bar (a point
 *  a week on the bench, or a point of depth into an open slot). Before
 *  2026-10-01 the fallback filed whatever the free add was. */
export function claimFallbackAllowed(freeAdd: WaiverMove, incoming: AvailablePlayer, state: RosterState, cfg: WaiverConfig = DEFAULT_WAIVERS, crowdedByes: Set<number> = new Set()): boolean {
  const asClaim = planOne({ ...incoming, onWaivers: true }, state, cfg, crowdedByes);
  return asClaim.kind === "waiver-claim" && asClaim.drop === freeAdd.drop && asClaim.dropPath === freeAdd.dropPath;
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
  // Lineup gain ranks first; two bench swaps with no lineup gain rank by how
  // much better the incoming player is than the one he replaces.
  // A one-week rental ranks after every move the season justifies, within
  // its kind, and among rentals by this week's gain.
  return moves.sort((a, b) => rank[a.kind] - rank[b.kind] || Number(a.rental) - Number(b.rental) || b.score - a.score || b.benchGainPts - a.benchGainPts);
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
  irEligible: (status?: string | null) => boolean = defaultIrEligible,
  currentStarters: string[] = [],
): IrOpportunity[] {
  if (openIrSlots <= 0) return [];
  // Eligibility is the league's flags only. A stash who is Questionable is not
  // eligible however much we want to keep him; Sleeper refuses the write.
  const eligible = stashCandidates({ roster, irEligible, currentStarters }, { rails: DEFAULT_RAILS });
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
