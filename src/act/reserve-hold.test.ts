// The instant a forced cut for a stale IR man may be made: his final injury
// report (reserve-hold.ts), on the week-6 slate captured 2026-10-14
// (analysis/incidents/schedule-2026-week6.json): Thursday SEA@DEN, a Sunday
// 09:30 London game (HOU@JAX), the Sunday slate, Monday WAS@SF; CIN, DET,
// MIA, MIN on bye.
import { describe, expect, test } from "bun:test";
import { forcedCutNotBefore, fmtZoned } from "./reserve-hold.ts";
import slate from "../analysis/incidents/schedule-2026-week6.json";

const ET = "America/New_York";
const games = (slate as { games: { away: string; home: string; startTime: number }[] }).games;
const et = (y: number, m: number, d: number, hh: number, mm = 0): number => Date.UTC(y, m - 1, d, hh + 4, mm); // EDT

describe("the final injury report is 18:00 ET two days before kickoff, never before the week's Wednesday", () => {
  test("Sunday 13:00 (PHI, Smith): Friday 18:00 ET", () => {
    const h = forcedCutNotBefore("PHI", games, ET)!;
    expect(h.kickoff).toBe(et(2026, 10, 18, 13));
    expect(h.until).toBe(et(2026, 10, 16, 18));
    expect(fmtZoned(h.until, ET)).toBe("Fri Oct 16 18:00 ET");
  });
  test("Sunday 16:25 (KC) and 20:20 (GB): the same Friday 18:00 ET", () => {
    expect(forcedCutNotBefore("KC", games, ET)!.until).toBe(et(2026, 10, 16, 18));
    expect(forcedCutNotBefore("gb", games, ET)!.until).toBe(et(2026, 10, 16, 18));
  });
  test("a Sunday 09:30 London game (JAX): Friday 18:00 ET too", () => {
    expect(forcedCutNotBefore("JAX", games, ET)!.until).toBe(et(2026, 10, 16, 18));
  });
  test("Thursday 20:15 (SEA): two days before is Tuesday, so the Wednesday 18:00 ET floor", () => {
    const h = forcedCutNotBefore("SEA", games, ET)!;
    expect(h.kickoff).toBe(et(2026, 10, 15, 20, 15));
    expect(h.until).toBe(et(2026, 10, 14, 18));
  });
  test("Monday 20:15 (WAS): Saturday 18:00 ET, before Sunday's reserve lock", () => {
    expect(forcedCutNotBefore("WAS", games, ET)!.until).toBe(et(2026, 10, 17, 18));
  });
  test("a team on bye (DET) or no team: no report is coming, no hold", () => {
    expect(forcedCutNotBefore("DET", games, ET)).toBeNull();
    expect(forcedCutNotBefore(null, games, ET)).toBeNull();
    expect(forcedCutNotBefore("PHI", [], ET)).toBeNull();
  });
  test("the hold never passes the kickoff itself", () => {
    const h = forcedCutNotBefore("X", [{ away: "X", home: "Y", startTime: et(2026, 10, 14, 12) }], ET)!; // a Wednesday noon game
    expect(h.until).toBeLessThanOrEqual(h.kickoff);
  });
});
