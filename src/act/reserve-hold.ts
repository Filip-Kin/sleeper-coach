// When a forced cut for a man stuck on injured reserve may be made.
//
// 2026-10-14, Wednesday 03:07 ET: the week's injury-report reset flipped
// DeVonta Smith (hamstring, no practice since week 3) and Rico Dowdle (toe)
// Out -> Questionable in the same minute. Smith was on IR, so the roster was
// illegal; Dowdle was the only bench man who could have taken his seat and
// now did not qualify either; so the reconciler recorded "drop Dowdle (77
// rest-of-season) and activate Smith" for its second look, thirty minutes
// on. A Wednesday Questionable is the reset, not news: a man who sat out
// last week is Out again on the final report more often than not, and then
// he is IR-eligible again and nobody is cut at all. A cut is for the
// season. Nothing that needs the roster legal in the meantime (Sleeper
// refuses lineup writes and adds while a reserve man no longer qualifies)
// is worth a season body, so those paths hold with a reason instead.
//
// The hold ends at the man's FINAL injury report, which the NFL issues on
// the last practice day: two days before kickoff (Friday for a Sunday game,
// Saturday for a Monday game), and Wednesday for a Thursday game. Said as
// one instant: 18:00 ET two days before his kickoff, never before Wednesday
// 18:00 ET of that NFL week. His team not on the week's slate (bye): no
// report is coming, no hold. The stash and the free seat are never held:
// they cost nobody.
//
// Pure. The reconciler, the roster-legal invariant and the hand tool all
// read this one function, so the three never disagree on when a cut is due.

import { partsInZone, zonedInstant, ZONE } from "../schedule.ts";

const DAY_MS = 24 * 3_600_000;
/** Wall-clock hour (ET) of the final injury report's release. */
export const FINAL_REPORT_HOUR = 18;

export interface CutHold {
  /** The instant from which the cut may be made. */
  until: number;
  /** His team's kickoff this week. */
  kickoff: number;
}

export interface SlateGame { away: string; home: string; startTime: number }

/** The calendar day `days` before the day `at` falls on in `zone`, at `hh:00`. */
function dayBeforeAt(at: number, days: number, hh: number, zone: string): number {
  const p = partsInZone(at, zone);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d) - days * DAY_MS);
  return zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, 0, zone);
}

/** The forced cut for `team`'s man is not made before his final injury
 *  report. Null when his team has no game on the slate (no report is coming)
 *  or no team is known. */
export function forcedCutNotBefore(team: string | null | undefined, games: SlateGame[], zone = ZONE): CutHold | null {
  if (!team) return null;
  const t = team.trim().toUpperCase();
  const game = games.find((g) => g.away.toUpperCase() === t || g.home.toUpperCase() === t);
  if (!game || !(Number(game.startTime) > 0)) return null;
  const kickoff = Number(game.startTime);
  const p = partsInZone(kickoff, zone);
  // Wednesday of the kickoff's NFL week (Thursday to Monday): the Wednesday
  // on or before the kickoff's day.
  const backToWednesday = (p.dow - 3 + 7) % 7;
  const wednesday = dayBeforeAt(kickoff, backToWednesday, FINAL_REPORT_HOUR, zone);
  const twoDaysBefore = dayBeforeAt(kickoff, 2, FINAL_REPORT_HOUR, zone);
  return { until: Math.min(Math.max(twoDaysBefore, wednesday), kickoff), kickoff };
}

/** "Fri Oct 16 18:00 ET", for reasons and log lines. */
export function fmtZoned(at: number, zone = ZONE): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const got: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(at))) got[x.type] = x.value;
  const hh = got.hour === "24" ? "00" : got.hour;
  return `${got.weekday} ${got.month} ${got.day} ${hh}:${got.minute} ${zone === "America/New_York" ? "ET" : zone}`;
}
