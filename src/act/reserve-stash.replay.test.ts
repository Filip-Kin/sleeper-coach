// Replay of 2026-10-12 on the league as captured that morning
// (analysis/incidents/league-2026-10-12.json): sixteen active, DeVonta Smith
// (Out, hamstring) and Travis Etienne (NFL IR) on injured reserve, Rico Dowdle
// (Out, dislocated toe) on the bench and IR-eligible, no claim pending. When
// Smith's tag lifts the deployed code went straight to a forced cut: the
// Jaguars (87) that day, Jake Bates (98, K2 on the season) once Tuesday's
// stream had swapped the Jaguars for a week-6 kicker. Filip's rule: an IR
// slot is a roster expansion; a man who qualifies for it takes the seat and
// nobody is cut for the season.
import { describe, expect, test } from "bun:test";
import { buildRosterView } from "../analysis/roster-view.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS } from "../analysis/rails.ts";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-10-12.json";
import { planReserveActivation } from "./reserve-reconcile.ts";
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
const BATES = idOf("Jake Bates");
const JAX = "JAX";
// The capture holds the twelve best unrostered kickers, not Butker; Fairbairn
// stands in for the week-6 streamer the Tuesday run adds for the Jaguars.
const STREAM_K = idOf("Ka'imi Fairbairn");

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
// A status forced to null is a healed man: the value feed then no longer
// marks him a protected stash (value.ts), so the rail flag goes with it.
function rail(players: string[], reserve: string[], status: Record<string, string | null> = {}): RailPlayer[] {
  return players.map((id) => tradePlayer(id, {
    onIr: reserve.includes(id),
    injuryStatus: id in status ? status[id] ?? undefined : fx(id).injuryStatus ?? undefined,
    ...(id in status && status[id] === null ? { returnsBeforePlayoffs: false } : {}),
  }));
}
const names = (ids: string[]): string[] => ids.map((id) => fx(id).name);
/** The live `startable` (week-projections.ts): a same-position body with points in the week's table. */
const canFillIn = (week: number) => (body: RailPlayer, starter: RailPlayer): boolean =>
  body.position === starter.position && (fx(body.playerId ?? "").weekly[String(week)] ?? 0) > 0;
const plan = (players: string[], reserve: string[], starters: string[], status: Record<string, string | null>, week = LEAGUE.week, rails = DEFAULT_RAILS) =>
  planReserveActivation({ view: buildRosterView(roster(players, reserve, starters, status)), settings: S, cap: CAP, railRoster: rail(players, reserve, status), cfg, rails, keep: names(starters), heldClaims: [], canFill: canFillIn(week) })[0]!;

describe("2026-10-12: Smith's tag lifts with sixteen active and Dowdle Out on the bench", () => {
  test("the capture is the morning's state: 16 active, Smith and Etienne on IR, Dowdle Out and IR-eligible, no claim", () => {
    expect(mine.players.length - mine.reserve.length).toBe(16);
    expect(mine.reserve.sort()).toEqual([SMITH, ETIENNE].sort());
    expect(fx(DOWDLE).injuryStatus).toBe("Out");
    expect(LEAGUE.pendingClaims.adds).toEqual([]);
    expect(LEAGUE.pendingClaims.drops).toEqual([]);
  });
  test("Smith Questionable: he is activated, Dowdle takes the IR seat, nobody is cut", () => {
    const p = plan(mine.players, mine.reserve, mine.starters, { [SMITH]: "Questionable" });
    expect(p.playerId).toBe(SMITH);
    expect(p.action).toBe("activate");
    expect(p.drop).toBeNull();
    expect(p.stash?.playerId).toBe(DOWDLE);
    expect(p.reserveAfter.sort()).toEqual([ETIENNE, DOWDLE].sort());
    expect(p.reason).toContain("Rico Dowdle");
    expect(p.reason).not.toContain("Jacksonville");
  });
  test("Smith healthy (no tag): the same stash, no cut", () => {
    const p = plan(mine.players, mine.reserve, mine.starters, { [SMITH]: null });
    expect(p.stash?.playerId).toBe(DOWDLE);
    expect(p.drop).toBeNull();
  });
  test("Dowdle's tag lifted first: nobody qualifies for IR, so the forced cut as before, the Jaguars (87; Seattle can fill their slot, Dowdle 95 is behind them)", () => {
    const p = plan(mine.players, mine.reserve, mine.starters, { [SMITH]: "Questionable", [DOWDLE]: null });
    expect(p.action).toBe("activate");
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(JAX);
    expect(fx(JAX).value).toBeLessThan(fx(DOWDLE).value);
  });
  test("Dowdle Questionable: a game-day tag is not IR-eligible, so he is not the stash and the Jaguars go", () => {
    const p = plan(mine.players, mine.reserve, mine.starters, { [SMITH]: "Questionable", [DOWDLE]: "Questionable" });
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(JAX);
  });
});

describe("after Tuesday's stream (the Jaguars out, a week-6 kicker in, Bates on bye and benched)", () => {
  const players = [...mine.players.filter((id) => id !== JAX), STREAM_K];
  // Week-6 leg: the streamer kicks, Seattle starts at defense, Bates sits on his bye.
  const starters = [...mine.starters.filter((id) => id !== JAX && id !== BATES), STREAM_K, "SEA"];
  test("Smith Questionable: Dowdle takes the seat; Bates (98, K2 on the season) is never the cut", () => {
    const p = plan(players, mine.reserve, starters, { [SMITH]: "Questionable" }, 6);
    expect(p.action).toBe("activate");
    expect(p.drop).toBeNull();
    expect(p.stash?.playerId).toBe(DOWDLE);
    expect(p.reserveAfter).toContain(DOWDLE);
  });
  test("Dowdle Out but still in the week-6 leg (the guard cannot bench him while the roster is illegal): stashed all the same, never Bates", () => {
    const p = plan(players, mine.reserve, [...starters, DOWDLE], { [SMITH]: "Questionable" }, 6);
    expect(p.stash?.playerId).toBe(DOWDLE);
    expect(p.drop).toBeNull();
  });
  test("Dowdle Questionable in the week-6 leg: a starter who can play is never the stash; Bates is the cheapest legal cut", () => {
    const p = plan(players, mine.reserve, [...starters, DOWDLE], { [SMITH]: "Questionable", [DOWDLE]: "Questionable" }, 6);
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(BATES);
  });
  test("with Dowdle healthy nobody qualifies: the forced cut is the cheapest legal body on the one value, Dowdle (95) before Bates (98)", () => {
    const p = plan(players, mine.reserve, starters, { [SMITH]: "Questionable", [DOWDLE]: null }, 6);
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(DOWDLE);
  });
});

describe("the stash never takes a starter who plays, a claim's drop or a man the rails protect", () => {
  test("Dowdle Doubtful in the week's lineup (a starter, not IR-eligible here) is not stashed: the Jaguars go", () => {
    const p = plan(mine.players, mine.reserve, [...mine.starters, DOWDLE], { [SMITH]: "Questionable", [DOWDLE]: "Doubtful" });
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(JAX);
  });
  test("Dowdle as a pending claim's drop (never-drop rail) is not stashed either", () => {
    const p = plan(mine.players, mine.reserve, mine.starters, { [SMITH]: "Questionable" }, LEAGUE.week, { ...DEFAULT_RAILS, neverDrop: ["Rico Dowdle"] });
    expect(p.stash).toBeNull();
    expect(p.drop?.playerId).toBe(JAX);
  });
});
