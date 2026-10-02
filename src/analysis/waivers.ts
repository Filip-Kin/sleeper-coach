import { canDrop, DEFAULT_RAILS, type RailPlayer, type RailConfig } from "./rails.ts";
import { solveLineup, type LineupPlayer } from "./lineup.ts";
import { irEligible as ruleIrEligible, type Settings } from "../sleeper/rules.ts";
import { LAST_WEEK, notPlaying } from "./value.ts";
import { byeAwareLineupTotal, depthInsurance, DEFAULT_FAIRNESS } from "./trade-fair.ts";

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
  /** How many of those open slots are open only because one of ours sits on
   *  IR. Such a slot is his: he comes back, and whoever took it forces a cut.
   *  So it is not a free seat for a depth body; it takes an add the lineup
   *  justifies, like the stash itself. Absent = 0. (2026-10-02 review: after
   *  a lost stash claim the empty slot went to a depth receiver and Travis
   *  Etienne's return cut Mark Andrews, team -12.2 on the captured league.) */
  owedBenchSlots?: number;
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
  /** Weeks left in the fantasy season, to turn a per-week margin into points. */
  weeksLeft?: number;
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
  /** The add goes into an open slot owed to a player of ours on IR
   *  (RosterState.owedBenchSlots): a cost, so it takes two looks. */
  owedSlot: boolean;
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
  const dropped = dropName ? state.roster.find((p) => p.name === dropName) ?? null : cheapestSwappable(incoming.position, state, rails);
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

function cheapestSwappable(position: string, state: RosterState, rails: RailConfig): RailPlayer | null {
  const starters = new Set((state.currentStarters ?? []).map((n) => n.toLowerCase()));
  // Same-position comparison, so the top-N rail is off here as it is for the
  // same-position drop path in evalPaths; every other rail holds.
  const swapRails: RailConfig = { ...rails, protectTopN: 0 };
  let best: RailPlayer | null = null;
  for (const p of state.roster) {
    if (starters.has(p.name.toLowerCase()) || !swappable(position, p.position)) continue;
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
  /** An open bench slot that is owed to a player of ours on IR (RosterState.owedBenchSlots). */
  owed?: boolean;
  gain: number; // starting-lineup ROS delta of taking this path
  benchGain: number; // incoming minus dropped at a swappable position, else 0
  benchPerGame: number; // the same gap per game played, so a bye still to come is not an upgrade
  /** A drop only the same-position upgrade rule allows (the top-N rail
   *  protects him). It may serve a bench upgrade, never a lineup-gain add. */
  upgradeOnly?: boolean;
  starts: boolean; // does the add start after it
  reason: string;
  irStash?: string; // set only on the "ir-stash" path
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
  const paths: { path: DropPath; drop: string | null; reason: string; irStash?: string; upgradeOnly?: boolean; owed?: boolean }[] = [];

  if (state.openBenchSlots > (state.owedBenchSlots ?? 0)) {
    paths.push({ path: "bench-slot", drop: null, reason: "into an open bench slot (no drop)" });
  } else if (state.openBenchSlots > 0) {
    paths.push({ path: "bench-slot", drop: null, owed: true, reason: "into the open slot of a player on IR (no drop now; he returns)" });
  }
  // An IR slot with a genuinely injured incumbent to stash frees a bench slot
  // without dropping anyone. Eligibility is the league's flags and nothing
  // else: a playoff-return stash who is merely Questionable is not IR-eligible,
  // and Sleeper refused exactly that write on 2026-09-22. Highest value first,
  // as irOpportunities ranks them, never a current starter.
  const stashable = stashCandidates(state, cfg);
  const irStashable = stashable[0];
  if (state.openIrSlots > 0 && irStashable && worthStashing(irStashable, state, cfg)) {
    paths.push({ path: "ir-stash", drop: null, irStash: irStashable.name, reason: `stash ${irStashable.name} (${irStashable.injuryStatus ?? "injured"}) on IR (no drop)` });
  }
  // Every canDrop-ALLOWED player is a candidate drop. canDrop is the authority on
  // what may leave the roster; we pick among the allowed ones by lineup delta.
  // A current-week starter is never on the table (R7).
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
  const starters = new Set((state.currentStarters ?? []).map((n) => n.toLowerCase()));
  const upgradeRails: RailConfig = { ...cfg.rails, protectTopN: 0 };
  for (const p of state.roster) {
    if (starters.has(p.name.toLowerCase())) continue;
    if (canDrop(p.name, state.roster, cfg.rails).allowed) {
      paths.push({ path: "drop", drop: p.name, reason: `drop ${p.name}` });
      continue;
    }
    const upgrade = UPGRADE_POSITIONS.has(p.position) && swappable(incoming.position, p.position) && incoming.points > p.points;
    if (upgrade && canDrop(p.name, state.roster, upgradeRails).allowed) {
      paths.push({ path: "drop", drop: p.name, reason: `drop ${p.name}`, upgradeOnly: true });
    }
  }

  const evals = paths.map((p) => {
    const { gain, starts, benchGain, benchPerGame } = lineupDelta(incoming, p.drop, state, cfg.rails);
    return { ...p, gain, starts, benchGain, benchPerGame };
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
  const order = (a: PathEval, b: PathEval): number => {
    const d = b.gain - a.gain || PATH_RANK[a.path] - PATH_RANK[b.path] || b.benchGain - a.benchGain;
    if (d) return d;
    const [ap, as, an] = cutKey(a); const [bp, bs, bn] = cutKey(b);
    return ap - bp || as - bs || an.localeCompare(bn);
  };
  // When the lineup gain alone justifies the add (he starts, by enough), the
  // ordinary rails decide who leaves, exactly as before the widening: a
  // top-N-protected player is never cut to make room for a starter while an
  // unprotected body exists. Only an add that can count as nothing but a
  // bench upgrade may reach past the top-N rail.
  const lineupEnough = (e: { gain: number; starts: boolean }): boolean => incoming.onWaivers
    ? e.gain >= cfg.claimMarginPts && (e.starts || !cfg.claimMustStart)
    : e.gain >= cfg.freeAddMarginPts;
  const ordinary = evals.filter((e) => !e.upgradeOnly).sort(order);
  if (ordinary[0] && lineupEnough(ordinary[0])) return ordinary;
  // What is left can only be a bench upgrade, and a bench upgrade is a swap:
  // the body he beats is the one who leaves. The IR stash is not offered for
  // it (2026-10-02 review). On the stash path nobody leaves now; the bench
  // gain was still measured against the cheapest same-position body, and
  // when the stashed man returned the cut was the lowest value on the bench,
  // somebody else. Replayed on the captured league: a receiver worth 2.3 a
  // week more than Josh Downs, taken by parking Travis Etienne, ended with
  // Mark Andrews cut and the team +1.2; the direct swap for Downs is +12.5.
  // It also made an open IR slot turn that claim into "wait", because the
  // stash path names no drop (claim-stash.test.ts).
  // An open slot owed to a player on IR is the same thing one step later.
  return evals.filter((e) => e.path !== "ir-stash" && !e.owed).sort(order);
}

/** Parking a player on IR is not free: he comes back, and then somebody has
 *  to make room. So an automatic stash is for a player worth keeping: a
 *  protected stash (hurt, startable-tier talent), a multi-week designation
 *  (IR, PUP), or at least more rest-of-season value than the cheapest body
 *  we could drop instead. On 2026-09-27 a day-to-day Out Rico Dowdle was
 *  stashed to add Tyjae Spears; when he flipped to Questionable the
 *  activation cut Travis Etienne. */
export function worthStashing(p: RailPlayer, state: Pick<RosterState, "roster" | "currentStarters">, cfg: Pick<WaiverConfig, "rails">): boolean {
  if (p.returnsBeforePlayoffs) return true;
  const st = (p.injuryStatus ?? "").toUpperCase();
  if (st === "IR" || st === "PUP") return true;
  const starters = new Set((state.currentStarters ?? []).map((n) => n.toLowerCase()));
  const cheapest = state.roster
    .filter((q) => q.name !== p.name && !starters.has(q.name.toLowerCase()) && canDrop(q.name, state.roster, cfg.rails).allowed)
    .reduce<number | null>((m, q) => (m === null || q.points < m ? q.points : m), null);
  return cheapest === null || p.points > cheapest; // nobody else may be cut: the stash is the only room there is
}

// With no league flags only IR and PUP qualify. The live run always passes the
// league's real flags through RosterState.irEligible.
const NO_FLAGS: Settings = { num_teams: 0, playoff_teams: 0, playoff_week_start: 0, trade_deadline: 0, waiver_budget: 0, max_keepers: 0, disable_trades: 0 };
function defaultIrEligible(status?: string | null): boolean {
  return ruleIrEligible(status, NO_FLAGS);
}

/** Rostered players who may go to IR, best first: eligible under the league's
 *  flags, not on the never-drop list, not a current starter. Stashes (hurt but
 *  back for the playoffs) first, then by rest-of-season value, so a genuine
 *  asset is parked before a fringe body when slots are scarce. */
export function stashCandidates(state: Pick<RosterState, "roster" | "irEligible" | "currentStarters">, cfg: Pick<WaiverConfig, "rails">): RailPlayer[] {
  const irEligible = state.irEligible ?? defaultIrEligible;
  const starters = new Set((state.currentStarters ?? []).map((n) => n.toLowerCase()));
  const never = new Set((cfg.rails.neverDrop ?? []).map((n) => n.toLowerCase()));
  return state.roster
    .filter((p) => irEligible(p.injuryStatus) && !never.has(p.name.toLowerCase()) && !starters.has(p.name.toLowerCase()))
    .sort((a, b) => Number(b.returnsBeforePlayoffs ?? false) - Number(a.returnsBeforePlayoffs ?? false) || b.points - a.points);
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
    ({ ...base, kind: "skip", drop: null, dropPath: "none", irStash: null, owedSlot: false, gainPts: 0, benchGainPts: 0, startsForUs: false, priorityWorthy: false, byeCredit: 0, depthPts: 0, score: 0, reason });

  const best = evalPaths(incoming, state, cfg)[0];
  if (!best) return skip("no legal path: nothing on the roster may be dropped and no slot is open");

  const { gain, starts, path, drop, benchGain, benchPerGame } = best;
  const irStash = best.irStash ?? null;
  const weeks = Math.max(1, state.weeksLeft ?? 14);
  const swapBar = cfg.benchSwapMarginPerWeek * weeks;
  const claimSwapBar = cfg.benchClaimMarginPerWeek * weeks;
  // Both in total and per game played (lineupDelta): a bye still to come is
  // not an upgrade.
  const benchUpgrade = (drop !== null || path === "ir-stash") && benchGain >= swapBar && benchPerGame >= cfg.benchSwapMarginPerWeek;
  const droppedPlayer = drop ? state.roster.find((p) => p.name === drop) ?? null : null;
  const byeCredit = byeCreditFor(incoming, droppedPlayer, crowdedByes, cfg);
  const byeNote =
    byeCredit > 0 ? " [plays through a crowded upcoming bye]" : byeCredit < 0 ? " [on a crowded upcoming bye]" : "";

  const needsDrop = drop !== null;
  // An IR stash is a deferred drop (he comes back), so it clears the same bar
  // as one. That holds for a player on NFL injured reserve too (2026-10-01
  // review): when he returns, the cut is the lowest rest-of-season value on
  // the bench, which need not be the body that took his slot. On the roster
  // of that day, parking Travis Etienne to add Malik Washington ended, weeks
  // later, with Mark Andrews cut: a swap this planner refuses when asked
  // directly (open-slot.test.ts).
  const costsSomething = needsDrop || path === "ir-stash" || !!best.owed;
  // A free agent into an open bench slot is judged, and ranked, on what the
  // extra body is worth to the team. Claims and waits keep the lineup gain:
  // they are priced in waiver priority, not in a slot.
  const costless = !costsSomething && !incoming.onWaivers;
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
  const move = (kind: MoveKind, priorityWorthy: boolean, reason: string): WaiverMove =>
    ({ ...base, kind, drop, dropPath: path, irStash, owedSlot: !!best.owed, gainPts: gain, benchGainPts: benchGain, startsForUs: starts, priorityWorthy, byeCredit, depthPts,
      score: costless ? depthPts : Math.round((gain + byeCredit) * 10) / 10, reason: reason + byeNote });

  // A move that would LOWER our starting lineup is never made, whatever the raw
  // point gap suggests. This is the guard against dropping a needed player (our
  // only kicker, say) to roster a higher-scoring but redundant position.
  if (needsDrop && gain < 0) {
    return skip(`no add improves the lineup without weakening it (best option ${describe(best)} nets ${gain} ROS)`);
  }

  if (!incoming.onWaivers) {
    // Cleared waivers: costless. Into an open bench slot, take the body
    // only if he is worth something to the team (depthGain): a player
    // who would start in no week and cover nobody is a wasted slot, and a
    // high-scoring one (a third quarterback) also takes a place in the
    // protected top N from a real player. If it entails a drop, require a
    // real lineup improvement, OR a real bench upgrade at a swappable
    // position (the 2026-09-30 rule).
    if (costsSomething && gain < cfg.freeAddMarginPts && !benchUpgrade) {
      return skip(`free agent, but ${describe(best)} lifts the lineup just +${gain} ROS and the bench ${benchGain >= 0 ? "+" : ""}${benchGain} (${benchPerGame >= 0 ? "+" : ""}${benchPerGame} a game; needs ${cfg.freeAddMarginPts} lineup or ${cfg.benchSwapMarginPerWeek}/week bench, in total and per game)`);
    }
    if (costless && (depthPts <= 0 || depthPts < depthFloor)) {
      return skip(DEPTH_POSITIONS.has(incoming.position)
        ? `free agent and a bench slot is open, but he adds only ${depthPts} to the team over the season (needs ${cfg.openSlotMinPts}): no week he would start, nobody he would cover`
        : `free agent and a bench slot is open, but a second ${incoming.position} is not depth and he lifts the lineup just +${gain} ROS (needs ${cfg.freeAddMarginPts})`);
    }
    const how = drop ? `drop ${drop}` : path === "ir-stash" || best.owed ? best.reason : "open bench slot, no drop";
    const why = starts ? `; starts for us (+${gain} ROS)` : benchUpgrade ? `; bench upgrade +${benchGain} ROS (${(benchGain / weeks).toFixed(1)}/week)` : `; +${depthPts} to the team over the season (bye weeks and cover)`;
    return move("free-add", false, `free agent, costless — ${how}${why}`);
  }

  // On waivers: burning a queue position. High bar: a real LINEUP improvement
  // from a player who starts, or a bench upgrade of claim size.
  const bigEnough = gain >= cfg.claimMarginPts;
  const startsOk = starts || !cfg.claimMustStart;
  const benchClaim = drop !== null && benchGain >= claimSwapBar && benchPerGame >= cfg.benchClaimMarginPerWeek;
  if ((bigEnough && startsOk) || benchClaim) {
    // Name the stash: "no drop" on a full roster reads as a free move, and
    // the executor has to park him before it files (act/claim-exec.ts).
    const how = drop ? `drop ${drop}` : path === "ir-stash" || best.owed ? best.reason : "no drop";
    const why = bigEnough && startsOk ? `+${gain} ROS to the lineup${starts ? " (he starts)" : ""}` : `bench upgrade +${benchGain} ROS (${(benchGain / weeks).toFixed(1)}/week)`;
    return move("waiver-claim", true, `worth a priority burn: ${why} — ${how}`);
  }
  // Not worth going last: wait for him to clear, then free-add for nothing.
  const why = !bigEnough
    ? `only +${gain} ROS to the lineup, under the ${cfg.claimMarginPts}pt claim bar`
    : "would not start for us";
  return move("wait", false, `do NOT claim (${why}); wait for him to clear and free-add at no priority cost`);
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
  return moves.sort((a, b) => rank[a.kind] - rank[b.kind] || b.score - a.score || b.benchGainPts - a.benchGainPts);
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
