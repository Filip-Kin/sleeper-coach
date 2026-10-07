import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lastWaiverRunAt, droppedAtFromTransactions, onWaiversNow, lastKickoffByTeam, recentTeamKickoffs, type ScheduledGame } from "./waiver-status.ts";
import { zonedInstant } from "../schedule.ts";

// R5. Whether a free add is refused depends on the PLAYER, not on the league:
// dropped inside waiver_clear_days, or his team has kicked off since the last
// waiver run. On Sunday evening 2026-09-20 J.K. Dobbins (Monday night team) was
// a free add while Jacory Croskey-Merritt (played Sunday) was refused on Tuesday.

const ET = (y: number, m: number, d: number, hh: number, mm = 0) => zonedInstant(y, m, d, hh, mm, "America/New_York");

describe("lastWaiverRunAt", () => {
  test("Tuesday points at the previous Wednesday 03:00 ET", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 22, 15))).toBe(ET(2026, 9, 16, 3));
  });
  test("Wednesday 04:00 ET is after this morning's run", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 23, 4))).toBe(ET(2026, 9, 23, 3));
  });
  test("Wednesday 02:00 ET is still before this morning's run", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 23, 2))).toBe(ET(2026, 9, 16, 3));
  });
});

describe("per-player waiver status", () => {
  const kickoffs = new Map([["WAS", ET(2026, 9, 20, 13)], ["LV", ET(2026, 9, 21, 20, 15)]]);
  test("Dobbins-shaped: team not kicked off on Sunday evening is a free agent", () => {
    const now = ET(2026, 9, 20, 18);
    expect(onWaiversNow({ playerId: "dob", team: "LV", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(false);
  });
  test("Croskey-Merritt-shaped: played Sunday, Tuesday means on waivers", () => {
    const now = ET(2026, 9, 22, 10);
    expect(onWaiversNow({ playerId: "jcm", team: "WAS", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(true);
  });
  test("after Wednesday's run the same player has cleared", () => {
    const now = ET(2026, 9, 23, 9);
    expect(onWaiversNow({ playerId: "jcm", team: "WAS", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(false);
  });
  test("dropped yesterday is on waivers whatever his team did", () => {
    const now = ET(2026, 9, 23, 9);
    const droppedAt = new Map([["x", now - 20 * 3_600_000]]);
    expect(onWaiversNow({ playerId: "x", team: "LV", droppedAt, kickoffs, now, clearDays: 2 })).toBe(true);
  });
  test("droppedAtFromTransactions keeps the latest drop per player", () => {
    const m = droppedAtFromTransactions([
      { drops: { a: 1 }, created: 100, status_updated: 100 },
      { drops: { a: 2, b: 3 }, created: 200, status_updated: 250 },
      { drops: null, created: 999 },
    ]);
    expect(m.get("a")).toBe(250);
    expect(m.get("b")).toBe(250);
    expect(m.size).toBe(2);
  });
});

// 2026-10-06, a Tuesday. RJ Harvey (DEN, played Sunday of week 4) was planned
// as a costless free add at 02:00 and again at 09:45, while every Tuesday add
// this league has ever made is a claim processed Wednesday 03:15 ET. The
// kickoffs came from the pick'em cache, which holds ONE week: the NFL week had
// rolled to 5, so the week-4 file was refused as stale and from 09:00 it was
// the week-5 slate, every game in the future. Nobody had "kicked off since the
// last waiver run", so nobody was on waivers. The Tuesday claim job
// (--claims-only) then had no claim to file and the free-agent job
// (--adds-only) would have been refused by Sleeper with no fallback.
describe("kickoffs since the last waiver run: last week's slate counts until Wednesday", () => {
  // Real games from the public scores feed, read 2026-10-06.
  const WEEK4: ScheduledGame[] = [
    { away: "PIT", home: "CLE", startTime: ET(2026, 10, 1, 20, 15) },
    { away: "IND", home: "WAS", startTime: ET(2026, 10, 4, 9, 30) },
    { away: "DEN", home: "SF", startTime: ET(2026, 10, 4, 16, 25) },
    { away: "ATL", home: "NO", startTime: ET(2026, 10, 5, 20, 15) },
  ];
  const WEEK5: ScheduledGame[] = [
    { away: "TB", home: "DAL", startTime: ET(2026, 10, 8, 20, 15) },
    { away: "NYG", home: "WAS", startTime: ET(2026, 10, 11, 13) },
    { away: "DEN", home: "LAC", startTime: ET(2026, 10, 11, 16, 5) },
    { away: "BUF", home: "LAR", startTime: ET(2026, 10, 12, 20, 15) },
  ];
  const WEEK3: ScheduledGame[] = [{ away: "LAR", home: "DEN", startTime: ET(2026, 9, 27, 20, 20) }];
  const slate = async (w: number): Promise<ScheduledGame[]> => (w === 3 ? WEEK3 : w === 4 ? WEEK4 : w === 5 ? WEEK5 : []);
  const status = async (team: string, now: number, week = 5): Promise<boolean> =>
    onWaiversNow({ playerId: "p", team, droppedAt: new Map(), kickoffs: await recentTeamKickoffs(week, now, slate), now, clearDays: 2 });

  test("lastKickoffByTeam keeps each team's latest kickoff at or before now", () => {
    const now = ET(2026, 10, 11, 14);
    const m = lastKickoffByTeam([...WEEK5, ...WEEK4], now);
    expect(m.get("WAS")).toBe(ET(2026, 10, 11, 13)); // this week's game has started
    expect(m.get("DEN")).toBe(ET(2026, 10, 4, 16, 25)); // this week's is still to come
    expect(m.get("TB")).toBe(ET(2026, 10, 8, 20, 15));
    expect(m.has("BUF")).toBe(false); // no kickoff yet in either week
  });
  test("the week-5 slate alone is the defect: on Tuesday nobody has kicked off", () => {
    const now = ET(2026, 10, 6, 9, 45);
    const weekFiveOnly = lastKickoffByTeam(WEEK5, now);
    expect(onWaiversNow({ playerId: "harvey", team: "DEN", droppedAt: new Map(), kickoffs: weekFiveOnly, now, clearDays: 2 })).toBe(false);
  });
  test("Harvey-shaped: Tuesday of week 5, played Sunday of week 4, on waivers", async () => {
    expect(await status("DEN", ET(2026, 10, 6, 9, 45))).toBe(true);
    expect(await status("DEN", ET(2026, 10, 6, 20))).toBe(true); // the Tuesday claim job
    expect(await status("NO", ET(2026, 10, 6, 2))).toBe(true); // Monday night team, Tuesday 02:00
  });
  test("Monday night, before the week rolls: the same answer from weeks 4 and 3", async () => {
    expect(await status("DEN", ET(2026, 10, 5, 22), 4)).toBe(true);
  });
  test("a team with no game last week is a free agent on Tuesday", async () => {
    expect(await status("BUF", ET(2026, 10, 6, 9, 45))).toBe(false);
  });
  test("Wednesday after the run everybody has cleared, until his own kickoff", async () => {
    expect(await status("DEN", ET(2026, 10, 7, 9))).toBe(false);
    expect(await status("TB", ET(2026, 10, 8, 21))).toBe(true); // Thursday night has kicked off
    expect(await status("DEN", ET(2026, 10, 11, 15))).toBe(false); // Sunday, an hour before his game
    expect(await status("DEN", ET(2026, 10, 11, 17))).toBe(true);
    expect(await status("WAS", ET(2026, 10, 12, 10))).toBe(true); // Monday: Sunday teams wait for Wednesday
  });
  test("both weeks are read, the current one first", async () => {
    const asked: number[] = [];
    await recentTeamKickoffs(5, ET(2026, 10, 6, 10), async (w) => { asked.push(w); return slate(w); });
    expect(asked).toEqual([5, 4]);
    asked.length = 0;
    await recentTeamKickoffs(1, ET(2026, 9, 8, 10), async (w) => { asked.push(w); return WEEK4; });
    expect(asked).toEqual([1]);
  });
  test("a schedule that cannot be read is an error, never 'everybody is free'", async () => {
    await expect(recentTeamKickoffs(5, ET(2026, 10, 6, 10), async () => { throw new Error("HTTP 502"); })).rejects.toThrow("502");
    await expect(recentTeamKickoffs(5, ET(2026, 10, 6, 10), async (w) => (w === 5 ? WEEK5 : []))).rejects.toThrow("week 4");
  });
});

describe("the waiver run is wired to the two-week schedule", () => {
  // The helpers above can all pass while waiver-run.ts still reads the
  // one-week pick'em cache: main() has no test seam. So the wiring is pinned
  // on the source, as chokepoint.test.ts does for the write paths.
  const src = readFileSync(new URL("./waiver-run.ts", import.meta.url), "utf8");
  test("kickoffs come from recentTeamKickoffs on the NFL week as it is now", () => {
    expect(src).toContain("recentTeamKickoffs(state.week || week, nowMs, (w) => weekSchedule(season, w))");
    expect(src).not.toContain("cachedTeamKickoffs");
  });
  test("a failed read of the drops is not swallowed into 'nobody was dropped'", () => {
    expect(src).not.toMatch(/sleeper\.transactions\([^)]*\)\.catch/);
  });
  test("a pending claim of ours is planned with as ours, and holds no later claim (2026-10-06)", () => {
    expect(src).not.toContain("claimPending");
    expect(src).toContain("claimAdd: true");
    expect(src).toContain("if (!doClaims || claimUsed) {");
  });
  test("the planner is told when a claim costs nothing and which week table to rent from", () => {
    expect(src).toContain("priorityFree,");
    expect(src).toContain("weekPoints,");
    expect(src).toContain("reserve,");
  });
});

describe("edges of the two-week rule", () => {
  const game = (away: string, home: string, t: number): ScheduledGame => ({ away, home, startTime: t });
  test("across the clock change of 2026-11-01 the Wednesday run is still 03:00 local", async () => {
    // Week 8 Sunday is Nov 1 (EST from 02:00), the run is Wed Nov 4 03:00 EST.
    const wk8 = [game("DEN", "KC", ET(2026, 11, 1, 13))];
    const wk9 = [game("DEN", "LV", ET(2026, 11, 8, 13))];
    const slate = async (w: number) => (w === 8 ? wk8 : wk9);
    const at = async (now: number) => onWaiversNow({ playerId: "p", team: "DEN", droppedAt: new Map(), kickoffs: await recentTeamKickoffs(9, now, slate), now, clearDays: 2 });
    expect(await at(ET(2026, 11, 3, 20))).toBe(true); // Tuesday claim job
    expect(await at(ET(2026, 11, 4, 2, 30))).toBe(true);
    expect(await at(ET(2026, 11, 4, 3, 30))).toBe(false);
  });
  test("past week 18 the last two real weeks are read, not an empty feed", async () => {
    const asked: number[] = [];
    await recentTeamKickoffs(20, ET(2027, 1, 19, 10), async (w) => { asked.push(w); return [game("DEN", "KC", ET(2027, 1, 10, 13))]; });
    expect(asked).toEqual([18, 17]);
  });
});
