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
