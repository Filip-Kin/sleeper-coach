import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lastWaiverRunAt, nextWaiverRunAt, droppedAtFromTransactions, onWaiversNow, waiverStateNow, lastKickoffByTeam, waiverInstantsByTeam, byeTeamsNow, recentTeamKickoffs, recentWaiverInstants, type ScheduledGame } from "./waiver-status.ts";
import { zonedInstant } from "../schedule.ts";
import { planStream, type StreamPoolPlayer } from "../analysis/streaming.ts";

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
  test("a team with no game last week (its bye) is on waivers on Tuesday like everyone (2026-10-13)", async () => {
    // Until 2026-10-13 this read false: see "bye week" below.
    expect(await status("BUF", ET(2026, 10, 6, 9, 45))).toBe(true);
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

// 2026-10-13, a Tuesday, 15:54 ET. Jake Bates (DET) is on bye in week 6 and
// the K slot of the week-6 leg is empty. The free-agent job planned Harrison
// Butker (KC) as the swap for the spare Jacksonville defense, as a FREE ADD;
// the confirming run asked Sleeper and was refused: "At least one of the
// players being added in is on waivers." KC had its bye in week 5, Butker
// had never been dropped, so the kickoff rule found nothing of his since the
// last run and read him as a free agent. Will Reichard (MIN, played Sunday)
// read as on waivers the same minute. Real slates from the scores feed as the
// run read them: 15 games in week 5 (no KC), 14 in week 6 (no MIN).
describe("bye week: a team with no game is on waivers from that week's first kickoff", () => {
  const WEEK5: ScheduledGame[] = [
    { away: "TB", home: "DAL", startTime: ET(2026, 10, 8, 20, 15) },
    { away: "MIN", home: "NO", startTime: ET(2026, 10, 11, 13) },
    { away: "NYG", home: "WAS", startTime: ET(2026, 10, 11, 13) },
    { away: "DEN", home: "LAC", startTime: ET(2026, 10, 11, 16, 5) },
    { away: "DET", home: "JAX", startTime: ET(2026, 10, 11, 16, 25) },
    { away: "BUF", home: "LAR", startTime: ET(2026, 10, 12, 20, 15) },
  ];
  const WEEK6: ScheduledGame[] = [
    { away: "SEA", home: "DEN", startTime: ET(2026, 10, 15, 20, 15) },
    { away: "NYG", home: "BUF", startTime: ET(2026, 10, 18, 13) },
    { away: "LAC", home: "KC", startTime: ET(2026, 10, 18, 16, 25) },
    { away: "TB", home: "LAR", startTime: ET(2026, 10, 19, 20, 15) },
  ];
  const slate = async (w: number): Promise<ScheduledGame[]> => (w === 5 ? WEEK5 : w === 6 ? WEEK6 : []);
  const status = async (team: string, now: number): Promise<boolean> =>
    onWaiversNow({ playerId: "p", team, droppedAt: new Map(), kickoffs: await recentTeamKickoffs(6, now, slate), now, clearDays: 2 });
  const TUESDAY = ET(2026, 10, 13, 15, 54);

  test("Butker-shaped: KC on bye in week 5, never dropped, is on waivers on Tuesday", async () => {
    expect(await status("KC", TUESDAY)).toBe(true);
    expect(await status("MIN", TUESDAY)).toBe(true); // Reichard, played Sunday, as before
  });
  test("the instant is the bye week's first kickoff", () => {
    const m = waiverInstantsByTeam([WEEK6, WEEK5], TUESDAY);
    expect(m.get("KC")).toBe(ET(2026, 10, 8, 20, 15));
    expect(m.get("MIN")).toBe(ET(2026, 10, 11, 13)); // his own game, not the week's first
    expect(m.get("DET")).toBe(ET(2026, 10, 11, 16, 25));
    // Week 6 has not kicked off on Tuesday: its bye teams get nothing from it yet.
    expect(m.has("JAX")).toBe(true);
    expect(m.get("JAX")).toBe(ET(2026, 10, 11, 16, 25));
  });
  test("Wednesday after the run he has cleared, and a bye team of THIS week goes on waivers at Thursday's kickoff", async () => {
    expect(await status("KC", ET(2026, 10, 14, 9))).toBe(false); // the free-add swap lands Wednesday
    expect(await status("MIN", ET(2026, 10, 14, 9))).toBe(false);
    expect(await status("MIN", ET(2026, 10, 15, 21))).toBe(true); // MIN on bye in week 6, TNF has kicked off
    expect(await status("KC", ET(2026, 10, 15, 21))).toBe(false); // KC plays Sunday 16:25
    expect(await status("KC", ET(2026, 10, 18, 17))).toBe(true);
  });
  test("lastKickoffByTeam alone is the defect: on Tuesday KC has no kickoff", () => {
    const own = lastKickoffByTeam([...WEEK6, ...WEEK5], TUESDAY);
    expect(own.has("KC")).toBe(false);
    expect(onWaiversNow({ playerId: "butker", team: "KC", droppedAt: new Map(), kickoffs: own, now: TUESDAY, clearDays: 2 })).toBe(false);
  });
  test("a single slate (week 1, no byes) marks nobody absent", () => {
    const m = waiverInstantsByTeam([WEEK5], ET(2026, 10, 13, 10));
    expect(m.size).toBe(12);
    expect(m.get("TB")).toBe(ET(2026, 10, 8, 20, 15));
  });
  test("the stream planner then waits for Wednesday instead of asking for a refused add", async () => {
    const kickoffs = await recentTeamKickoffs(6, TUESDAY, slate);
    const k = (name: string, playerId: string, team: string, weekPoints: number, value: number): StreamPoolPlayer =>
      ({ name, playerId, position: "K", weekPoints, value, bye: null, onWaivers: onWaiversNow({ playerId, team, droppedAt: new Map(), kickoffs, now: TUESDAY, clearDays: 2 }) });
    const pool = [k("Harrison Butker", "4227", "KC", 8.4, 95), k("Will Reichard", "11792", "MIN", 8.1, 92)];
    const roster = [
      { name: "Jake Bates", position: "K", points: 90, seasonPoints: 45 },
      { name: "Seattle Seahawks", position: "DEF", points: 86, seasonPoints: 103 },
      { name: "Jacksonville Jaguars", position: "DEF", points: 78, seasonPoints: 91 },
    ] as Parameters<typeof planStream>[0]["roster"];
    const d = planStream({
      need: { week: 6, position: "K", coveringFor: ["Jake Bates"] }, week: 6, openBenchSlots: 0, pool, roster,
      mayLeave: () => true, forcedDrop: () => null,
      currentStarters: ["Jake Bates", "Jacksonville Jaguars"], kept: ["Jake Bates"], priorityFree: false,
    });
    expect(d.how).toBe("wait");
    expect(d.add).toBeNull();
    expect(d.reason).toContain("on waivers until the run clears");
  });
});

describe("the waiver run is wired to the two-week schedule", () => {
  // The helpers above can all pass while waiver-run.ts still reads the
  // one-week pick'em cache: main() has no test seam. So the wiring is pinned
  // on the source, as chokepoint.test.ts does for the write paths.
  const src = readFileSync(new URL("./waiver-run.ts", import.meta.url), "utf8");
  test("kickoffs come from recentTeamKickoffs on the NFL week as it is now", () => {
    expect(src).toContain("recentWaiverInstants(state.week || week, nowMs, (w) => weekSchedule(season, w))");
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

describe("a bye team's man is locked: neither addable nor claimable until the clear (Reichard, 2026-10-16)", () => {
  // The slates above: MIN plays Sunday of week 5 and has no game in week 6
  // (its bye); KC has no game in week 5 and plays Sunday 16:25 of week 6.
  const WEEK5: ScheduledGame[] = [
    { away: "TB", home: "DAL", startTime: ET(2026, 10, 8, 20, 15) },
    { away: "MIN", home: "NO", startTime: ET(2026, 10, 11, 13) },
    { away: "DET", home: "JAX", startTime: ET(2026, 10, 11, 16, 25) },
    { away: "BUF", home: "LAR", startTime: ET(2026, 10, 12, 20, 15) },
  ];
  const WEEK6: ScheduledGame[] = [
    { away: "SEA", home: "DEN", startTime: ET(2026, 10, 15, 20, 15) },
    { away: "NYG", home: "BUF", startTime: ET(2026, 10, 18, 13) },
    { away: "LAC", home: "KC", startTime: ET(2026, 10, 18, 16, 25) },
    { away: "TB", home: "LAR", startTime: ET(2026, 10, 19, 20, 15) },
  ];
  const slate = async (w: number): Promise<ScheduledGame[]> => (w === 5 ? WEEK5 : w === 6 ? WEEK6 : []);
  const state = async (team: string, now: number, extra: { dropped?: number; lockedUntil?: number } = {}) => {
    const { kickoffs, onBye } = await recentWaiverInstants(6, now, slate);
    return waiverStateNow({ playerId: "p", team, droppedAt: new Map(extra.dropped ? [["p", extra.dropped]] : []), kickoffs, onBye, now, clearDays: 2, lockedUntil: extra.lockedUntil ?? null });
  };
  const FRI = ET(2026, 10, 16, 14, 2); // the first refused claim
  const SUN = ET(2026, 10, 18, 12, 26); // the sixth
  const WED = ET(2026, 10, 21, 9); // after the clear

  test("byeTeamsNow: the latest slate that has kicked off decides", () => {
    expect([...byeTeamsNow([WEEK6, WEEK5], ET(2026, 10, 13, 15, 54))].sort()).toEqual(["DEN", "KC", "LAC", "NYG", "SEA"]); // Tuesday: week 5's byes
    expect([...byeTeamsNow([WEEK6, WEEK5], FRI)].sort()).toEqual(["DAL", "DET", "JAX", "MIN", "NO"]); // Friday: week 6's
    expect(byeTeamsNow([WEEK6, WEEK5], ET(2026, 10, 15, 19)).has("MIN")).toBe(false); // before TNF week 6 has not kicked off
  });
  test("Reichard-shaped: MIN on bye in week 6 is locked from Thursday's kickoff through Sunday, free on Wednesday", async () => {
    expect(await state("MIN", FRI)).toBe("locked");
    expect(await state("MIN", SUN)).toBe("locked");
    expect(await state("MIN", WED)).toBe("free");
    expect(await state("MIN", ET(2026, 10, 15, 19))).toBe("free"); // Thursday before kickoff
  });
  test("a team that played is on waivers (claimable), one that has not kicked off is free", async () => {
    expect(await state("SEA", FRI)).toBe("waivers");
    expect(await state("KC", FRI)).toBe("free");
    expect(await state("KC", ET(2026, 10, 18, 17))).toBe("waivers"); // after his 16:25 kickoff
  });
  test("a dropped man is claimable whatever his team is doing; the boolean view is unchanged", async () => {
    expect(await state("MIN", FRI, { dropped: FRI - 3_600_000 })).toBe("waivers");
    const { kickoffs } = await recentWaiverInstants(6, FRI, slate);
    expect(onWaiversNow({ playerId: "p", team: "MIN", droppedAt: new Map(), kickoffs, now: FRI, clearDays: 2 })).toBe(true);
  });
  test("Sleeper's own refusal locks him until the clear whatever the schedule says", async () => {
    expect(await state("KC", FRI, { lockedUntil: nextWaiverRunAt(FRI) })).toBe("locked");
    expect(await state("KC", WED, { lockedUntil: nextWaiverRunAt(FRI) })).toBe("free");
  });
  test("nextWaiverRunAt is the Wednesday 03:00 ET after now", () => {
    expect(nextWaiverRunAt(FRI)).toBe(ET(2026, 10, 21, 3));
    expect(nextWaiverRunAt(ET(2026, 10, 13, 15, 54))).toBe(ET(2026, 10, 14, 3));
    expect(nextWaiverRunAt(ET(2026, 10, 14, 4))).toBe(ET(2026, 10, 21, 3));
  });
  test("replay on the real schedules (incidents/schedule-2026-week6.json, kickoffs-2026-week5.json): CIN, DET, MIA, MIN locked on Friday", () => {
    const week6 = (JSON.parse(readFileSync(new URL("../analysis/incidents/schedule-2026-week6.json", import.meta.url), "utf8")) as { games: ScheduledGame[] }).games;
    const week5 = (JSON.parse(readFileSync(new URL("../analysis/incidents/kickoffs-2026-week5.json", import.meta.url), "utf8")) as { games: { startTime: number; label: string }[] }).games
      .map((g) => ({ away: g.label.split("@")[0]!, home: g.label.split("@")[1]!, startTime: g.startTime }));
    const slates = [week6, week5];
    const byes = byeTeamsNow(slates, FRI);
    expect([...byes].sort()).toEqual(["CIN", "DET", "MIA", "MIN"]);
    const kickoffs = waiverInstantsByTeam(slates, FRI);
    const at = (team: string, now: number) => waiverStateNow({ playerId: "p", team, droppedAt: new Map(), kickoffs: waiverInstantsByTeam(slates, now), onBye: byeTeamsNow(slates, now), now, clearDays: 2 });
    expect(kickoffs.get("MIN")).toBe(ET(2026, 10, 15, 20, 15));
    expect(at("MIN", FRI)).toBe("locked");
    expect(at("MIN", SUN)).toBe("locked");
    expect(at("MIN", WED)).toBe("free");
    expect(at("HOU", FRI)).toBe("free"); // Fairbairn's team plays Sunday
  });
});
