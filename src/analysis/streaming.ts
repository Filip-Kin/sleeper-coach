// Streaming: cover an upcoming week where a starting slot would otherwise be
// EMPTY, by claiming the best available player at that position before the
// waiver deadline. Filip, in plain terms: "gets the waiver on the best player
// in by the deadline" so we never field a hole.
//
// This is separate from the normal waiver logic, which only adds a player who
// improves our REST-OF-SEASON lineup. A streamer does not: our own kicker is
// better rest-of-season, he is just on bye this one week. So the trigger here is
// "a mandatory starting slot has NOBODY eligible in week N", not "this guy is an
// upgrade". Kicker and defense are the usual cases (one-deep, and they take a
// bye like everyone else), but the check is position-agnostic.
//
// Planning ahead matters because waivers clear once a week: if our kicker is on
// bye in week 6, the claim has to go in during the week-5 waiver run, or the
// slot is already locked empty by the time we look. So we scan THIS week and the
// next couple, and act on the earliest hole whose waiver window is open now.

import { bestLineup, STARTING_SLOTS, type TradePlayer } from "./trade.ts";

/** Positions where, in the given week, the optimal lineup leaves a dedicated
 *  starting slot with nobody (every rostered player there is on bye or out).
 *  FLEX is not counted: it is fillable from three positions, so it is only truly
 *  empty if the whole skill corps is gone, which the per-position check catches
 *  upstream anyway. */
export function emptyStarterPositions(
  roster: TradePlayer[], week: number, slots: readonly string[] = STARTING_SLOTS,
): string[] {
  const available = roster.filter((p) => p.bye !== week && !isOut(p));
  const lineup = bestLineup(available, slots);
  const empty = new Set<string>();
  for (const s of lineup.starters) {
    if (s.player === null && s.slot !== "FLEX") empty.add(s.slot);
  }
  return [...empty];
}

function isOut(p: TradePlayer): boolean {
  const s = (p.injuryStatus ?? "").trim().toLowerCase();
  return ["out", "ir", "pup", "sus", "na", "doubtful"].includes(s);
}

export interface StreamNeed {
  week: number;
  position: string;
  /** Whichever of our players at that position is on bye/out that week, so the
   *  streamer is a temporary cover for HIM and we must not drop him to fit. */
  coveringFor: string[];
}

/** Every upcoming empty-slot need across a window of weeks, earliest first. The
 *  caller acts on the first one whose waiver window is open (i.e. current week),
 *  since a claim placed now clears before that week's games. */
export function streamNeeds(
  roster: TradePlayer[], fromWeek: number, lookaheadWeeks: number, slots: readonly string[] = STARTING_SLOTS,
): StreamNeed[] {
  const needs: StreamNeed[] = [];
  for (let w = fromWeek; w < fromWeek + lookaheadWeeks; w++) {
    for (const pos of emptyStarterPositions(roster, w, slots)) {
      const coveringFor = roster.filter((p) => p.position === pos && (p.bye === w || isOut(p))).map((p) => p.name);
      needs.push({ week: w, position: pos, coveringFor });
    }
  }
  return needs;
}

export interface StreamPick {
  need: StreamNeed;
  add: string;      // best available player at the needed position
  points: number;   // his projection for the need week
}

/** A streaming candidate carries the NEED WEEK's projection and his bye. A
 *  rest-of-season number is the wrong currency for a one-week fill: on
 *  2026-09-22 it ranked a kicker on his own bye at the top of the list. */
export interface StreamCandidate {
  name: string;
  position: string;
  weekPoints: number;
  bye?: number | null;
}

/** The best available body for a need: most projected points in THAT week at
 *  that position, never a player who is himself on bye then, never one with no
 *  game. At kicker/defense the spread between startable options is small, so
 *  nothing cleverer is needed without live matchup data. */
export function pickStreamer(need: StreamNeed, available: StreamCandidate[]): StreamPick | null {
  const best = available
    .filter((p) => p.position === need.position && p.bye !== need.week && p.weekPoints > 0)
    .sort((a, b) => b.weekPoints - a.weekPoints)[0];
  if (!best) return null;
  return { need, add: best.name, points: best.weekPoints };
}

// #region the stream decision
/** Positions where a rostered player is interchangeable with a free agent.
 *  Every startable kicker projects within about a point a week of every
 *  other, and so does every startable defense. A bye there is covered by
 *  SWAPPING the player for one who plays, not by cutting a bench body to
 *  carry two: the value rule says the kicker is the least valuable player on
 *  the roster, and a second kicker is a dead slot the week after. */
export const SWAP_POSITIONS: ReadonlySet<string> = new Set(["K", "DEF"]);

/** A free agent as the stream decision needs him: the need week's projection,
 *  his rest-of-season value (a swapped-in player stays), and whether adding
 *  him today would have to be a claim. */
export interface StreamPoolPlayer extends StreamCandidate {
  playerId: string;
  onWaivers: boolean;
  value: number;
}

/** open-slot: added into a free bench slot, nobody leaves.
 *  swap:      kicker or defense; the covered player leaves for the streamer.
 *  cut:       a scarce position; the cheapest legal bench body leaves.
 *  wait:      a swap that is not due yet (not his bye week, or every
 *             candidate is still on waivers). Nothing to do this run.
 *  stuck:     the slot will be empty and there is no legal way to fill it. */
export type StreamHow = "open-slot" | "swap" | "cut" | "wait" | "stuck";

export interface StreamDecision {
  need: StreamNeed;
  how: StreamHow;
  add: string | null;
  drop: string | null;
  onWaivers: boolean;
  /** The add's projection for the need week. */
  points: number;
  reason: string;
}

/** What to do about one empty-slot need. Pure.
 *
 *  `week` is the current NFL week. `mayLeave` answers whether a rostered
 *  player may be dropped at all (never-drop list, the drop of a pending
 *  claim). `forcedDrop` is the cheapest legal cut for a scarce position, or
 *  null when the rails allow none; it is only asked when a cut is the path.
 *  `currentStarters` are this week's starters on the site; a spare kicker
 *  or defense who is starting this week is not a spare. `priorityFree`:
 *  we are last in the waiver order, so a claim costs nothing. */
export function planStream(args: {
  need: StreamNeed;
  week: number;
  openBenchSlots: number;
  pool: StreamPoolPlayer[];
  roster: TradePlayer[];
  mayLeave: (name: string) => boolean;
  forcedDrop: () => string | null;
  currentStarters?: string[];
  priorityFree?: boolean;
}): StreamDecision {
  const { need, week, openBenchSlots, pool, roster, mayLeave, forcedDrop } = args;
  const priorityFree = !!args.priorityFree;
  const starters = new Set((args.currentStarters ?? []).map((n) => n.toLowerCase()));
  const out = (how: StreamHow, add: StreamPoolPlayer | null, drop: string | null, reason: string): StreamDecision =>
    ({ need, how, add: add?.name ?? null, drop, onWaivers: add?.onWaivers ?? false, points: add?.weekPoints ?? 0, reason });
  const plays = pool.filter((p) => p.position === need.position && p.bye !== need.week && p.weekPoints > 0);
  // Best for the need week: the one-week fill (pickStreamer's order).
  const byWeek = plays.slice().sort((a, b) => b.weekPoints - a.weekPoints);
  const best = byWeek[0];
  if (!best) return out("stuck", null, null, `week ${need.week} would start nobody at ${need.position} and no free ${need.position} plays that week`);

  if (openBenchSlots > 0) {
    // A kicker or a defense is never worth waiver priority, open slot or
    // not: every one of them clears on Wednesday and the next free one is
    // within a point a week. Unless the priority is free (we are last),
    // when the claim costs nothing and gets him a day sooner. Before
    // 2026-10-06 this branch took the best by projection whatever his
    // status, and the claim job would have filed for him with no second
    // look, using up the run's one claim.
    const pick = SWAP_POSITIONS.has(need.position) && !priorityFree ? byWeek.find((p) => !p.onWaivers) : best;
    if (!pick) return out("wait", null, null, `every ${need.position} who plays week ${need.week} is on waivers until the run clears; a ${need.position} is not worth a claim`);
    return out("open-slot", pick, null, `into an open bench slot, covering ${need.coveringFor.join(", ")} in week ${need.week}`);
  }

  if (SWAP_POSITIONS.has(need.position)) {
    const covered = roster
      .filter((p) => p.position === need.position && need.coveringFor.includes(p.name) && mayLeave(p.name))
      .sort((a, b) => a.points - b.points)[0];
    // A SPARE kicker or defense (Filip, 2026-10-06: "keep our starters"):
    // a second body at either streamable position who is not starting
    // this week, usually last week's one-week rental, worth less for the
    // rest of the season than the player on bye. He leaves instead, now,
    // and the starter stays. Kicker and defense are compared on the one
    // value (they are the two interchangeable positions).
    const bestAt = (pos: string): TradePlayer | undefined => roster.filter((p) => p.position === pos).sort((a, b) => b.points - a.points)[0];
    const spare = roster
      .filter((p) => SWAP_POSITIONS.has(p.position) && !need.coveringFor.includes(p.name) && !starters.has(p.name.toLowerCase()) && mayLeave(p.name))
      // The extra body at his position only: never our one kicker or our
      // one defense, never the better of two.
      .filter((p) => bestAt(p.position)?.name !== p.name)
      .filter((p) => !covered || p.points <= covered.points)
      .sort((a, b) => a.points - b.points)[0];
    // He stays, so rank on rest-of-season value; and a swap is never worth
    // waiver priority, so only a player who can be added for free now,
    // unless the priority is free (we are last).
    const free = plays.filter((p) => priorityFree || !p.onWaivers).sort((a, b) => b.value - a.value || b.weekPoints - a.weekPoints)[0];
    if (spare) {
      // He is not playing for us this week either way, so the swap may
      // happen before the need week; but only for a free body, as below.
      if (!free) return out("wait", null, null, `every ${need.position} who plays week ${need.week} is on waivers until the run clears`);
      return out("swap", free, spare.name, `${spare.name} is a spare ${spare.position} worth less than ${covered?.name ?? "the starter"}; ${free.name} plays week ${need.week} and takes his slot`);
    }
    if (covered) {
      // In his bye week he is not playing, so the swap costs this week
      // nothing. A week early it would take a kicker who plays out of the
      // lineup, and the streamer's own game may already be over.
      if (need.week !== week) {
        return out("wait", null, null, `${covered.name} is swapped for a ${need.position} who plays in week ${need.week} itself, not before`);
      }
      if (!free) return out("wait", null, null, `every ${need.position} who plays week ${need.week} is on waivers until the run clears`);
      return out("swap", free, covered.name, `${covered.name} is off in week ${need.week}; ${free.name} plays it and replaces him`);
    }
  }

  const drop = forcedDrop();
  if (!drop) return out("stuck", null, null, `week ${need.week} would start nobody at ${need.position} (${need.coveringFor.join(", ") || "nobody rostered"} out) and the rails allow no cut to make room`);
  return out("cut", best, drop, `covering ${need.coveringFor.join(", ")} in week ${need.week}; ${drop} is the cheapest legal cut`);
}
// #endregion
