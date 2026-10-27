// The hand tool's legal cuts (roster-move.ts), pure, so the rule it refuses
// by can be pinned on a replay. Nothing here is read by the engine: it is
// the engine's own rules composed the way the hand tool asks them, for the
// moment a human stands in for a job that was deferred or failed.
//
// Who may leave: the cut order (value.ts cutOrder) over the active roster,
// less the never-drop list and the protected stashes (rails.ts canDrop, the
// top-N rail off as every forced cut has it), less the drop side of a
// pending claim, less the starters this week's cut keeps (roster-fit.ts
// keptStarters, the newcomer counted at RB/WR/TE as waivers.ts evalPaths
// counts him).
//
// Plus the stream's need-week swap (streaming.ts planStream, the `covered`
// branch): a starting kicker or defense who is off THIS week fills nothing,
// so a newcomer at his position who plays it takes his slot and he is the
// drop. "Off" is the engine's word for it (streamNeeds coveringFor): on bye
// this week or ruled out by his status, never a missing or zero table row,
// which is unknown, not off. And only where the slot would otherwise start
// nobody (emptyStarterPositions): a rostered body at his position who can
// fill it this week is the engine's spare, not a stream, and the starter
// stays kept. keptStarters keeps the covered man by design (a bye there is
// a swap in the bye week, not a cut path), so until 2026-10-27 the hand tool
// refused the very move the 20:00 claim job files: `claim McPherson --drop
// Fairbairn` on Fairbairn's week-8 bye, our only kicker, answered "not a
// legal cut" and needed --override, which skips every rail. Before the need
// week he plays for us and stays kept, as planStream waits; a newcomer who
// does not play this week covers nothing; with no week table nobody fills a
// slot and every starter is kept.
import { cutOrder, notPlaying } from "../analysis/value.ts";
import { canDrop, DEFAULT_RAILS, type RailPlayer } from "../analysis/rails.ts";
import { keptStarters } from "../analysis/roster-fit.ts";
import { SWAP_POSITIONS } from "../analysis/streaming.ts";

export interface HandCutArgs {
  /** The current NFL week: the need week a cover swap is judged in. */
  week: number;
  /** The active roster (IR excluded) on the one value, `bye` set. */
  roster: readonly RailPlayer[];
  /** This week's leg, by name. */
  starters: readonly string[];
  /** Player ids committed as the drop of a pending claim. */
  pendingDrops: readonly string[];
  /** week-projections.ts startableThisWeek over the live week: can `body`
   *  take `starter`'s slot this week. False for everyone when the week is
   *  unknown. */
  canFill: (body: RailPlayer, starter: RailPlayer) => boolean;
  /** The add or claim target; none for a plain drop or an activation. */
  newcomer?: RailPlayer;
}

export interface HandCuts {
  /** The legal cuts, cheapest first. */
  cuts: RailPlayer[];
  /** Starters kept from the cut this week, lower-cased names. */
  kept: Set<string>;
  /** The starting kicker or defense the newcomer covers this week: on bye
   *  or ruled out at the newcomer's position, nobody rostered to fill his
   *  slot, while the newcomer plays it. Legal cuts for the newcomer only,
   *  and never charged the add bar: the slot starts nobody otherwise. */
  covered: RailPlayer[];
}

export function handLegalCuts(a: HandCutArgs): HandCuts {
  const lower = (n: string): string => n.toLowerCase();
  const pendingDrop = (p: RailPlayer): boolean => a.pendingDrops.includes(p.playerId ?? "");
  const canFill = (body: RailPlayer, starter: RailPlayer): boolean => a.canFill(body, starter) && !pendingDrop(body);
  const starting = a.roster.filter((p) => a.starters.some((n) => lower(n) === lower(p.name)));
  const kept = new Set(keptStarters(starting.map((p) => p.name), a.roster, canFill, a.newcomer).map(lower));
  const newcomer = a.newcomer;
  const off = (s: RailPlayer): boolean => s.bye === a.week || notPlaying(s.injuryStatus);
  const spareFor = (s: RailPlayer): boolean => a.roster.some((q) => q !== s && q.position === s.position && !q.onIr && !q.claimAdd && canFill(q, s));
  const covered = newcomer && SWAP_POSITIONS.has(newcomer.position)
    ? starting.filter((s) => s.position === newcomer.position && !pendingDrop(s) && off(s) && !a.canFill(s, s) && !spareFor(s) && canFill(newcomer, s))
    : [];
  for (const c of covered) kept.delete(lower(c.name));
  const cuts = cutOrder(a.roster.filter((p) => !kept.has(lower(p.name)) && !pendingDrop(p) && canDrop(p.name, [...a.roster], { ...DEFAULT_RAILS, protectTopN: 0 }).allowed));
  return { cuts, kept, covered };
}
