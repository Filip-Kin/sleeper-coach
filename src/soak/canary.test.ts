import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryVerdict, weekToScore, sumMatchupPoints, isCanaryFreeze, canaryFreezeContent, releaseCanaryFreeze, canaryFreezeActive, type CanaryObservations } from "./canary.ts";
import { REAL_LEAGUE_ID } from "../config.ts";
import type { Job } from "../schedule.ts";

const NOW = Date.UTC(2026, 8, 23, 15, 0, 0); // Wed 11:00 ET
const JOBS_FIXTURE: Job[] = [
  { name: "daily-9", dow: -1, hour: 9, minute: 0, maxLateMs: 60 * 60 * 1000, why: "t" },
  { name: "sun-11", dow: 0, hour: 11, minute: 0, maxLateMs: 2 * 60 * 60 * 1000, why: "t" },
];
const OCC_DAILY = Date.UTC(2026, 8, 23, 13, 0, 0);
const OCC_SUN = Date.UTC(2026, 8, 20, 15, 0, 0);

function healthy(over: Partial<CanaryObservations> = {}): CanaryObservations {
  return {
    token: { kind: "ok", expMs: NOW + 300 * 86_400_000 },
    leagueId: REAL_LEAGUE_ID, expectedLeagueId: REAL_LEAGUE_ID, requireReal: true,
    rosterHasPlayerMap: true, legality: { ok: true, overBy: 0, staleIr: [], reserveNotOwned: [] },
    matchupPoints: 1039.34, matchupWeek: 2,
    scheduledRuns: { "daily-9": OCC_DAILY, "sun-11": OCC_SUN },
    activityAppendable: true, haConfigured: true, now: NOW, jobs: JOBS_FIXTURE,
    ...over,
  };
}

describe("canaryVerdict", () => {
  test("a healthy boot passes with no warnings", () => {
    const v = canaryVerdict(healthy());
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  test("token: missing, unauthorized and inconclusive all fail; near-expiry passes", () => {
    expect(canaryVerdict(healthy({ token: { kind: "missing" } })).failures[0]).toContain("token: missing");
    expect(canaryVerdict(healthy({ token: { kind: "unauthorized" } })).ok).toBe(false);
    expect(canaryVerdict(healthy({ token: { kind: "error", message: "ECONNRESET" } })).ok).toBe(false);
    expect(canaryVerdict(healthy({ token: { kind: "ok", expMs: NOW + 3 * 86_400_000 } })).ok).toBe(true);
  });
  test("league: read failure, wrong id, and staging-in-production all fail", () => {
    expect(canaryVerdict(healthy({ leagueId: null })).failures).toEqual(["league: read failed"]);
    expect(canaryVerdict(healthy({ leagueId: "999" })).failures[0]).toContain("expected");
    expect(canaryVerdict(healthy({ leagueId: "1399830848848592896", expectedLeagueId: "1399830848848592896", requireReal: true })).failures[0]).toContain("not the real league");
    expect(canaryVerdict(healthy({ leagueId: "1399830848848592896", expectedLeagueId: "1399830848848592896", requireReal: false })).ok).toBe(true);
  });
  test("roster: REST source, read failure and illegality fail", () => {
    expect(canaryVerdict(healthy({ rosterHasPlayerMap: false })).failures[0]).toContain("no player_map");
    expect(canaryVerdict(healthy({ legality: null })).failures[0]).toContain("roster: read failed");
    const v = canaryVerdict(healthy({ legality: { ok: false, overBy: 1, staleIr: ["Nico Collins"], reserveNotOwned: [] } }));
    expect(v.failures[0]).toContain("1 over cap");
    expect(v.failures[0]).toContain("Nico Collins");
  });
  test("matchups: zero points on a scored week fails, no scored week skips", () => {
    expect(canaryVerdict(healthy({ matchupPoints: 0 })).failures[0]).toContain("dashboard-zeros");
    expect(canaryVerdict(healthy({ matchupPoints: null })).failures[0]).toContain("read failed");
    expect(canaryVerdict(healthy({ matchupWeek: null, matchupPoints: null })).ok).toBe(true);
  });
  test("schedule: unreadable fails, overdue-and-unmarked fails, inside the window passes", () => {
    expect(canaryVerdict(healthy({ scheduledRuns: null })).failures[0]).toContain("unreadable");
    expect(canaryVerdict(healthy({ scheduledRuns: { "daily-9": OCC_DAILY } })).failures[0]).toContain("sun-11");
    expect(canaryVerdict(healthy({ scheduledRuns: {} , now: Date.UTC(2026, 8, 23, 13, 30, 0) })).failures[0]).toContain("sun-11");
    expect(canaryVerdict(healthy({ scheduledRuns: { "sun-11": OCC_SUN }, now: Date.UTC(2026, 8, 23, 13, 30, 0) })).ok).toBe(true);
  });
  test("activity log not appendable fails; HA unset only warns", () => {
    expect(canaryVerdict(healthy({ activityAppendable: false })).ok).toBe(false);
    const v = canaryVerdict(healthy({ haConfigured: false }));
    expect(v.ok).toBe(true);
    expect(v.warnings[0]).toContain("HA_NOTIFY_URL");
  });
});

describe("weekToScore", () => {
  test("preseason: nothing to score", () => {
    expect(weekToScore({ week: 1, season_type: "pre" }, null, NOW)).toBeNull();
  });
  test("week 1 before kickoff: nothing; after kickoff: week 1", () => {
    expect(weekToScore({ week: 1, season_type: "regular" }, { week: 1, games: [{ startTime: NOW + 1 }] }, NOW)).toBeNull();
    expect(weekToScore({ week: 1, season_type: "regular" }, { week: 1, games: [{ startTime: NOW - 1 }] }, NOW)).toBe(1);
  });
  test("week 3 midweek: the previous week; once a game kicked off: week 3", () => {
    expect(weekToScore({ week: 3, season_type: "regular" }, { week: 3, games: [{ startTime: NOW + 1 }] }, NOW)).toBe(2);
    expect(weekToScore({ week: 3, season_type: "regular" }, null, NOW)).toBe(2);
    expect(weekToScore({ week: 3, season_type: "regular" }, { week: 3, games: [{ startTime: NOW - 1 }] }, NOW)).toBe(3);
    // A stale cache from another week never counts as this week's kickoff.
    expect(weekToScore({ week: 3, season_type: "regular" }, { week: 2, games: [{ startTime: NOW - 1 }] }, NOW)).toBe(2);
  });
  test("sumMatchupPoints ignores junk", () => {
    expect(sumMatchupPoints([{ points: 10.5 }, { points: null }, {}, { points: "x" }, { points: 2 }])).toBe(12.5);
  });
});

describe("the freeze marker", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "canary-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("content shape", () => {
    expect(canaryFreezeContent("abc123")).toBe("boot-canary abc123\n");
    expect(isCanaryFreeze("boot-canary abc123\n")).toBe(true);
    expect(isCanaryFreeze("")).toBe(false);
    expect(isCanaryFreeze("2026-09-23T15:02:47Z frozen by Filip")).toBe(false);
  });
  test("releases only its own freeze", () => {
    const f = join(dir, "FREEZE");
    expect(releaseCanaryFreeze(f)).toBe("absent");
    writeFileSync(f, canaryFreezeContent("abc"));
    expect(canaryFreezeActive(f)).toBe(true);
    expect(releaseCanaryFreeze(f)).toBe("released");
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "frozen by Filip\n");
    expect(canaryFreezeActive(f)).toBe(false);
    expect(releaseCanaryFreeze(f)).toBe("human-freeze");
    expect(existsSync(f)).toBe(true);
    writeFileSync(f, ""); // a bare `touch` is a human freeze too
    expect(releaseCanaryFreeze(f)).toBe("human-freeze");
    expect(existsSync(f)).toBe(true);
  });
});
