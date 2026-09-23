import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { evaluateInvariants, runInvariants, alertDue, lastInvariantAlert, markInvariantAlert, type InvariantInput, type InvariantCheck } from "./invariants.ts";
import { buildRosterView } from "./analysis/roster-view.ts";
import type { League, Roster } from "./sleeper/types.ts";
import type { Job } from "./schedule.ts";
import { DAILY_LIMIT } from "./analysis/drop-guard.ts";

// Real league shape: 10 starters, 6 bench, 2 IR in settings only.
const POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"];
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const LEAGUE = { league_id: "L", name: "t", season: "2026", status: "in_season", total_rosters: 8, draft_id: "D", previous_league_id: null, scoring_settings: {}, roster_positions: POSITIONS, settings: S } as League;
const STATE = { season: "2026", season_type: "regular", week: 3, display_week: 3 };
const NOW = Date.UTC(2026, 8, 23, 15, 0, 0); // Wed 2026-09-23 11:00 ET

const POS_OF = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "K", "DEF", "WR", "RB", "TE", "QB", "WR", "RB"];
const mini = (id: string, pos: string, injury: string | null) => ({ player_id: id, first_name: "P", last_name: id, position: pos, fantasy_positions: [pos], team: "HOU", status: "Active", injury_status: injury, news_updated: null });

function roster(opts: { n?: number; reserve?: string[]; starters?: string[]; injuries?: Record<string, string> } = {}): Roster {
  const n = opts.n ?? 16;
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const reserve = opts.reserve ?? [];
  const active = ids.filter((id) => !reserve.includes(id));
  return {
    roster_id: 3, owner_id: "u", players: ids, starters: opts.starters ?? active.slice(0, 10), reserve: reserve.length ? reserve : null, keepers: null,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 },
    player_map: Object.fromEntries(ids.map((id, i) => [id, mini(id, POS_OF[i] ?? "WR", opts.injuries?.[id] ?? null)])),
  };
}

const JOBS_FIXTURE: Job[] = [
  { name: "daily-9", dow: -1, hour: 9, minute: 0, maxLateMs: 60 * 60 * 1000, why: "t" },
  { name: "sun-11", dow: 0, hour: 11, minute: 0, maxLateMs: 2 * 60 * 60 * 1000, why: "t" },
];

function input(over: Partial<InvariantInput> = {}, r: Roster = roster()): InvariantInput {
  const occDaily = Date.UTC(2026, 8, 23, 13, 0, 0); // today 09:00 ET
  const occSun = Date.UTC(2026, 8, 20, 15, 0, 0); // Sun 11:00 ET
  return {
    db: new Database(":memory:"),
    league: LEAGUE, rosters: [r], state: STATE, view: buildRosterView(r),
    token: { kind: "ok", expMs: NOW + 200 * 86_400_000 },
    pendingClaims: { count: 0, adds: [] },
    outstandingOffers: [], proposalsDb: [],
    scheduledRuns: { "daily-9": occDaily, "sun-11": occSun },
    dropHistory: [], alertsLastHour: 0, now: NOW, jobs: JOBS_FIXTURE,
    ...over,
  };
}
const byName = (checks: InvariantCheck[]): Record<string, InvariantCheck> => Object.fromEntries(checks.map((c) => [c.name, c]));

describe("a healthy world passes every invariant", () => {
  test("all nine ok", () => {
    const c = evaluateInvariants(input());
    expect(c.length).toBe(9);
    expect(c.filter((x) => !x.ok).map((x) => x.name)).toEqual([]);
  });
});

describe("roster-legal", () => {
  test("over cap fails", () => {
    const r = roster({ n: 17 });
    expect(byName(evaluateInvariants(input({}, r)))["roster-legal"]!.ok).toBe(false);
    expect(byName(evaluateInvariants(input({}, r)))["roster-legal"]!.detail).toContain("over the 16-man cap");
  });
  test("IR does not count toward the cap", () => {
    const r = roster({ n: 17, reserve: ["p16"], injuries: { p16: "Out" } });
    expect(byName(evaluateInvariants(input({}, r)))["roster-legal"]!.ok).toBe(true);
  });
  test("a healed man on IR fails", () => {
    const r = roster({ n: 17, reserve: ["p16"], injuries: { p16: "Questionable" } });
    const c = byName(evaluateInvariants(input({}, r)))["roster-legal"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("no longer IR-eligible: P p16");
  });
});

describe("starter-on-reserve", () => {
  test("an IR player in the starters fails", () => {
    const r = roster({ n: 17, reserve: ["p16"], injuries: { p16: "Out" } });
    r.starters = ["p16", ...r.starters!.slice(1)];
    const c = byName(evaluateInvariants(input({}, r)))["starter-on-reserve"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("P p16");
  });
});

describe("empty-slot", () => {
  test("a 0 in FLEX with an RB on the bench fails", () => {
    const r = roster();
    r.starters![6] = "0"; // FLEX
    const c = byName(evaluateInvariants(input({}, r)))["empty-slot"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("FLEX empty");
  });
  test("a 0 in K with no kicker anywhere active is fine", () => {
    // p8 is the only K; park him on IR so the bench has no kicker.
    const r = roster({ reserve: ["p8"], injuries: { p8: "Out" } });
    r.starters = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "0", "p9"];
    expect(byName(evaluateInvariants(input({}, r)))["empty-slot"]!.ok).toBe(true);
  });
  test("a 0 in QB with the spare quarterback on IR is fine (IR is not bench)", () => {
    // p0 and p13 are the two QBs; both on IR, so nobody active can fill QB.
    const r = roster({ reserve: ["p0", "p13"], injuries: { p0: "Out", p13: "Out" } });
    r.starters = ["0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
    expect(byName(evaluateInvariants(input({}, r)))["empty-slot"]!.ok).toBe(true);
  });
  test("a 0 in QB with a healthy spare on the bench fails", () => {
    const r = roster();
    r.starters = ["0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
    expect(byName(evaluateInvariants(input({}, r)))["empty-slot"]!.detail).toContain("QB empty with P p0/P p13");
  });
});

describe("token", () => {
  test("inside the warning window fails", () => {
    expect(byName(evaluateInvariants(input({ token: { kind: "ok", expMs: NOW + 5 * 86_400_000 } })))["token"]!.ok).toBe(false);
  });
  test("unauthorized fails", () => {
    expect(byName(evaluateInvariants(input({ token: { kind: "unauthorized" } })))["token"]!.ok).toBe(false);
  });
  test("a network error is inconclusive, not a failure", () => {
    expect(byName(evaluateInvariants(input({ token: { kind: "error", message: "ECONNRESET" } })))["token"]!.ok).toBe(true);
  });
});

describe("proposals", () => {
  test("a row marked proposed that Sleeper no longer lists fails", () => {
    const c = byName(evaluateInvariants(input({ proposalsDb: [{ transactionId: "t1", status: "proposed", at: NOW }], outstandingOffers: [] })))["proposals"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("t1");
  });
  test("a row that is on Sleeper passes", () => {
    expect(byName(evaluateInvariants(input({ proposalsDb: [{ transactionId: "t1", status: "proposed", at: NOW }], outstandingOffers: [{ transactionId: "t1" }] })))["proposals"]!.ok).toBe(true);
  });
  test("rows without a status are not checked", () => {
    expect(byName(evaluateInvariants(input({ proposalsDb: [{ transactionId: "old", at: NOW - 86_400_000 }] })))["proposals"]!.ok).toBe(true);
  });
});

describe("claim-slots", () => {
  test("two claims with one open slot fails", () => {
    const r = roster({ n: 15 });
    const c = byName(evaluateInvariants(input({ pendingClaims: { count: 2, adds: ["a", "b"] } }, r)))["claim-slots"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("only 1 open");
  });
  test("one claim with one open slot passes", () => {
    expect(byName(evaluateInvariants(input({ pendingClaims: { count: 1, adds: ["a"] } }, roster({ n: 15 }))))["claim-slots"]!.ok).toBe(true);
  });
});

describe("schedule", () => {
  test("a job past its window and never marked fails", () => {
    const c = byName(evaluateInvariants(input({ scheduledRuns: { "sun-11": 0, "daily-9": Date.UTC(2026, 8, 23, 13, 0, 0) } })))["schedule"]!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("sun-11");
  });
  test("a job still inside its window is not late yet", () => {
    // 09:30 ET: daily-9 occurred 30 min ago with a 60 min window.
    const c = byName(evaluateInvariants(input({ now: Date.UTC(2026, 8, 23, 13, 30, 0), scheduledRuns: { "daily-9": 0, "sun-11": Date.UTC(2026, 8, 20, 15, 0, 0) } })))["schedule"]!;
    expect(c.ok).toBe(true);
  });
});

describe("drops", () => {
  test("over the daily limit fails with action freeze", () => {
    const hist = Array.from({ length: DAILY_LIMIT + 1 }, (_, i) => ({ name: `d${i}`, at: NOW - i * 60_000 }));
    const c = byName(evaluateInvariants(input({ dropHistory: hist })))["drops"]!;
    expect(c.ok).toBe(false);
    expect(c.action).toBe("freeze");
  });
  test("old drops do not count", () => {
    const hist = Array.from({ length: DAILY_LIMIT + 1 }, (_, i) => ({ name: `d${i}`, at: NOW - 2 * 86_400_000 }));
    expect(byName(evaluateInvariants(input({ dropHistory: hist })))["drops"]!.ok).toBe(true);
  });
});

describe("alert-storm", () => {
  test("eleven in an hour fails", () => {
    expect(byName(evaluateInvariants(input({ alertsLastHour: 11 })))["alert-storm"]!.ok).toBe(false);
  });
  test("ten is the limit", () => {
    expect(byName(evaluateInvariants(input({ alertsLastHour: 10 })))["alert-storm"]!.ok).toBe(true);
  });
});

describe("runInvariants: dedupe and freeze", () => {
  test("alertDue is a 24 h gate", () => {
    expect(alertDue(0, NOW)).toBe(true);
    expect(alertDue(NOW - 23 * 3_600_000, NOW)).toBe(false);
    expect(alertDue(NOW - 25 * 3_600_000, NOW)).toBe(true);
  });
  test("the table round-trips", () => {
    const db = new Database(":memory:");
    expect(lastInvariantAlert(db, "x")).toBe(0);
    markInvariantAlert(db, "x", 5);
    expect(lastInvariantAlert(db, "x")).toBe(5);
  });
  test("one push per invariant per day, freeze once, nothing on a clean run", async () => {
    const db = new Database(":memory:");
    const alerts: string[] = [];
    let frozen = false;
    const deps = {
      alert: async (title: string) => { alerts.push(title); },
      freeze: async () => { frozen = true; },
      frozen: () => frozen,
      log: () => {},
    };
    const hist = Array.from({ length: DAILY_LIMIT + 1 }, (_, i) => ({ name: `d${i}`, at: NOW - i * 60_000 }));
    const bad = input({ db, dropHistory: hist, alertsLastHour: 11 });
    const r1 = await runInvariants(bad, deps);
    expect(r1.ok).toBe(false);
    expect(r1.frozen).toEqual(["drops"]);
    expect(r1.alerted.sort()).toEqual(["alert-storm", "drops"]);
    expect(alerts.some((t) => t.startsWith("Coach froze itself: drops"))).toBe(true);
    // Same failure a minute later: nothing new goes out, no second freeze.
    const r2 = await runInvariants({ ...bad, now: NOW + 60_000 }, deps);
    expect(r2.alerted).toEqual([]);
    expect(r2.frozen).toEqual([]);
    expect(alerts.length).toBe(2);
    // A day later it repeats once (the daily job is marked for its new occurrence).
    const later = NOW + 25 * 3_600_000;
    const r3 = await runInvariants({
      ...bad, now: later,
      dropHistory: hist.map((d) => ({ ...d, at: d.at + 25 * 3_600_000 })),
      scheduledRuns: { ...bad.scheduledRuns, "daily-9": Date.UTC(2026, 8, 24, 13, 0, 0) },
    }, deps);
    expect(r3.alerted.sort()).toEqual(["alert-storm", "drops"]);
    // A clean world does nothing.
    const r4 = await runInvariants(input({ db }), deps);
    expect(r4.ok).toBe(true);
    expect(r4.alerted).toEqual([]);
  });
});
