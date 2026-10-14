// Replay of 2026-10-14 on the league as captured at 03:28 ET
// (analysis/incidents/league-2026-10-14.json) with the week-6 slate
// (schedule-2026-week6.json). The Wednesday report reset flipped DeVonta
// Smith (on IR, hamstring) AND Rico Dowdle (bench, toe) Out -> Questionable
// at 03:07 ET. Sixteen active, nobody qualifies for the seat, and the
// deployed code recorded "drop Rico Dowdle (77) and activate DeVonta Smith"
// at 03:08 for its second look at 03:38. A Wednesday Questionable is the
// reset, not news: the cut waits for Smith's final injury report, Friday
// 18:00 ET for Sunday's CAR@PHI; Out again on it means nobody is cut.
import { describe, expect, test } from "bun:test";
import { buildRosterView } from "../analysis/roster-view.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS } from "../analysis/rails.ts";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-10-14.json";
import slate from "../analysis/incidents/schedule-2026-week6.json";
import { planReserveActivation } from "./reserve-reconcile.ts";
import { forcedCutNotBefore } from "./reserve-hold.ts";
import type { Roster, League } from "../sleeper/types.ts";
import type { RailPlayer } from "../analysis/rails.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const CAP = LEAGUE.rosterPositions.filter((s) => s !== "IR").length; // 16
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [6, 7, 8, 9], remainingWeeks: 12, headToHeadRemaining: 1 };
const mine = ourRoster();
const SMITH = idOf("DeVonta Smith");
const ETIENNE = idOf("Travis Etienne");
const DOWDLE = idOf("Rico Dowdle");
const JAX = "JAX";
const games = (slate as { games: { away: string; home: string; startTime: number }[] }).games;
const ET = "America/New_York";
const et = (y: number, m: number, d: number, hh: number, mm = 0): number => Date.UTC(y, m - 1, d, hh + 4, mm); // EDT
const WED_0308 = et(2026, 10, 14, 3, 8); // the intent
const FRI_1800 = et(2026, 10, 16, 18); // Smith's final report (CAR@PHI Sunday 13:00)
const FRI_1830 = et(2026, 10, 16, 18, 30);

function roster(players: string[], reserve: string[], starters: string[], status: Record<string, string | null> = {}): Roster {
  const player_map: NonNullable<Roster["player_map"]> = {};
  for (const id of players) {
    const p = fx(id);
    if (p.position === "DEF") continue;
    const [first, ...rest] = p.name.split(" ");
    player_map[id] = { player_id: id, first_name: first ?? "", last_name: rest.join(" "), position: p.position, fantasy_positions: [p.position], team: p.team, status: "Active", injury_status: id in status ? status[id] ?? null : p.injuryStatus, news_updated: null };
  }
  return { roster_id: 3, owner_id: "u", players, starters, reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}
function rail(players: string[], reserve: string[], status: Record<string, string | null> = {}, extra: Record<string, Partial<RailPlayer>> = {}): RailPlayer[] {
  return players.map((id) => tradePlayer(id, {
    onIr: reserve.includes(id),
    injuryStatus: id in status ? status[id] ?? undefined : fx(id).injuryStatus ?? undefined,
    ...(id in status && status[id] === null ? { returnsBeforePlayoffs: false } : {}),
    ...(extra[id] ?? {}),
  }));
}
const names = (ids: string[]): string[] => ids.map((id) => fx(id).name);
const canFillIn = (week: number) => (body: RailPlayer, starter: RailPlayer): boolean =>
  body.position === starter.position && (fx(body.playerId ?? "").weekly[String(week)] ?? 0) > 0;
const hold = forcedCutNotBefore("PHI", games, ET)!;
const plan = (args: { players?: string[]; reserve?: string[]; starters?: string[]; status?: Record<string, string | null>; now?: number; cutNotBefore?: number | null; holdWhy?: string; extra?: Record<string, Partial<RailPlayer>> }) => {
  const players = args.players ?? mine.players, reserve = args.reserve ?? mine.reserve, starters = args.starters ?? mine.starters, status = args.status ?? {};
  return planReserveActivation({
    view: buildRosterView(roster(players, reserve, starters, status)), settings: S, cap: CAP, railRoster: rail(players, reserve, status, args.extra), cfg, rails: DEFAULT_RAILS,
    keep: names(starters), heldClaims: [], canFill: canFillIn(LEAGUE.week), now: args.now ?? WED_0308, cutNotBefore: "cutNotBefore" in args ? args.cutNotBefore : hold.until, holdWhy: args.holdWhy,
  })[0];
};

describe("2026-10-14 03:08 ET: Smith and Dowdle both flipped to Questionable by the Wednesday reset", () => {
  test("the capture is the morning's state: 16 active, Smith (Questionable) and Etienne (IR) on reserve, Dowdle Questionable, no claim", () => {
    expect(mine.players.length - mine.reserve.length).toBe(16);
    expect(mine.reserve.sort()).toEqual([SMITH, ETIENNE].sort());
    expect(fx(SMITH).injuryStatus).toBe("Questionable");
    expect(fx(DOWDLE).injuryStatus).toBe("Questionable");
    expect(fx(SMITH).team).toBe("PHI");
    expect(LEAGUE.pendingClaims.adds).toEqual([]);
    expect(fx(DOWDLE).value).toBeLessThan(fx(JAX).value); // 77 < 78.4: Dowdle is the cheapest legal cut
  });
  test("with no hold (the deployed rule) the cut is Dowdle: nobody qualifies for the seat and he is cheapest on the one value", () => {
    const p = plan({ cutNotBefore: null })!;
    expect(p.action).toBe("activate");
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(DOWDLE);
  });
  test("Smith's final injury report is Friday 18:00 ET (CAR@PHI Sunday 13:00)", () => {
    expect(hold.until).toBe(FRI_1800);
  });
  test("at 03:08 Wednesday the same cut is HELD for the report: nothing recorded, nobody cut", () => {
    const p = plan({})!;
    expect(p.action).toBe("hold");
    expect(p.holdUntil).toBe(FRI_1800);
    expect(p.drop?.playerId).toBe(DOWDLE);
    expect(p.stash).toBeNull();
    expect(p.reason).toContain("Rico Dowdle");
    expect(p.reason).toContain("final injury report");
    expect(p.reason).toContain("Fri Oct 16 18:00");
  });
  test("Friday 18:30, still Questionable: the hold is over and the cut goes (two looks follow)", () => {
    const p = plan({ now: FRI_1830 })!;
    expect(p.action).toBe("activate");
    expect(p.drop?.playerId).toBe(DOWDLE);
  });
  test("Smith Out again on the report: IR-eligible, nothing to do, nobody cut", () => {
    expect(plan({ status: { [SMITH]: "Out" }, now: FRI_1830 })).toBeUndefined();
  });
  test("Dowdle Out again during the hold: the stash is never held; he takes the seat and nobody is cut", () => {
    const p = plan({ status: { [DOWDLE]: "Out" } })!;
    expect(p.action).toBe("activate");
    expect(p.drop).toBeNull();
    expect(p.stash?.playerId).toBe(DOWDLE);
    expect(p.reserveAfter.sort()).toEqual([ETIENNE, DOWDLE].sort());
  });
  test("a free seat during the hold is never held either: he is activated at once", () => {
    const players = mine.players.filter((id) => id !== JAX);
    const starters = mine.starters.filter((id) => id !== JAX);
    const p = plan({ players, starters })!;
    expect(p.action).toBe("activate");
    expect(p.drop).toBeNull();
    expect(p.stash).toBeNull();
  });
  test("a release (he is himself the cheapest body) is held the same way", () => {
    const extra = { [SMITH]: { points: 5, seasonPoints: 5 } };
    const now = plan({ extra, cutNotBefore: null })!;
    expect(now.action).toBe("release");
    const held = plan({ extra })!;
    expect(held.action).toBe("hold");
    expect(held.drop?.playerId).toBe(SMITH);
    expect(held.reason).toContain("released");
  });
  test("the slate unreadable: the cut waits an hour with the reason, the seat and the stash do not", () => {
    const p = plan({ cutNotBefore: WED_0308 + 3_600_000, holdWhy: "this week's schedule could not be read" })!;
    expect(p.action).toBe("hold");
    expect(p.holdUntil).toBe(WED_0308 + 3_600_000);
    expect(p.reason).toContain("schedule could not be read");
    expect(plan({ status: { [DOWDLE]: "Out" }, cutNotBefore: WED_0308 + 3_600_000 })!.stash?.playerId).toBe(DOWDLE);
  });
  test("a team on bye has no report coming: no hold, the cut after two looks as before", () => {
    const p = plan({ cutNotBefore: forcedCutNotBefore("DET", games, ET)?.until ?? null })!;
    expect(p.action).toBe("activate");
    expect(p.drop?.playerId).toBe(DOWDLE);
  });
});
