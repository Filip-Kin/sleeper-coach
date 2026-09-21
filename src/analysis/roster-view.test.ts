import { describe, expect, test } from "bun:test";
import { buildRosterView, overCap, droppable, takenAcrossLeague } from "./roster-view.ts";
import { tradeRostersFrom } from "./trade-wire.ts";
import { depthInsurance, evaluateTradeTwoSided, DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { canDrop } from "./rails.ts";
import type { Roster } from "../sleeper/types.ts";
import type { TradePlayer } from "./trade.ts";

// Every test here maps to a bug that shipped between 2026-09-19 and 09-20.
// Each one is named for the bug, and each was run against the code as it stood
// before the migration to prove it detects the class, not just the instance.

const mini = (id: string, first: string, last: string, position: string, team: string, injury: string | null = null) =>
  ({ player_id: id, first_name: first, last_name: last, position, fantasy_positions: [position], team, status: "Active", injury_status: injury, news_updated: null });

function roster(n: number, reserve: string[] = [], rosterId = 3): Roster {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const player_map = Object.fromEntries(ids.map((id, i) => [id, mini(id, "P", id, i === 0 ? "QB" : i < 6 ? "RB" : "WR", "DAL", reserve.includes(id) ? "Out" : null)]));
  return { roster_id: rosterId, owner_id: "u", players: ids, starters: ids.slice(0, 10), reserve: reserve.length ? reserve : null, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}

describe("1. the cascade: reserve never counts against the cap", () => {
  test("17 owned with 1 on IR is 16 active and 0 over", () => {
    const v = buildRosterView(roster(17, ["p16"]));
    expect(v.owned.length).toBe(17);
    expect(v.active.length).toBe(16);
    expect(overCap(v, 16)).toBe(0);
  });
  test("a genuine 17 active is still 1 over", () => {
    expect(overCap(buildRosterView(roster(18, ["p17"])), 16)).toBe(1);
  });
});

describe("2. the dead filter: droppable never contains a reserve player, by id", () => {
  const v = buildRosterView(roster(17, ["p16"]));
  const rail = v.owned.map((e) => ({ name: e.name, position: e.position, points: 10, playerId: e.playerId, onIr: e.onIr }));
  test("p16 is on IR and is not droppable", () => {
    const ids = new Set(droppable(v, rail).map((p) => p.playerId));
    expect(ids.has("p16")).toBe(false);
    // The rails also protect starters and stashes, so fewer than 16 come back.
    // The invariant is that every one of them is active.
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(v.activeIds.has(id!)).toBe(true);
  });
  test("an entry with no id falls back to the onIr flag", () => {
    const noIds = rail.map(({ playerId: _drop, ...rest }) => rest);
    expect(droppable(v, noIds).some((p) => p.name === "P p16")).toBe(false);
  });
});

describe("3. the invisibility bug: the trade engine values what we own, IR included", () => {
  test("tradeRostersFrom keeps a reserve player and flags him onIr", () => {
    const r = roster(17, ["p16"]);
    const byId = new Map<string, TradePlayer>(r.players!.map((id) => [id, { name: `P ${id}`, position: "WR", points: 100 }]));
    const ours = tradeRostersFrom([r], byId).get(3)!;
    expect(ours.length).toBe(17);
    expect(ours.find((p) => p.name === "P p16")?.onIr).toBe(true);
  });
});

describe("4. startable: the active set has nobody on IR", () => {
  test("no active entry is flagged onIr", () => {
    const v = buildRosterView(roster(17, ["p16", "p15"]));
    expect(v.active.some((e) => e.onIr)).toBe(false);
    expect(v.activeIds.has("p16")).toBe(false);
    expect(v.reserveIds.size).toBe(2);
  });
});

describe("5. free agency: a player on somebody's IR is not available", () => {
  test("takenAcrossLeague includes reserve ids", () => {
    const taken = takenAcrossLeague([roster(16, ["p15"], 1), roster(16, [], 2)]);
    expect(taken.has("p15")).toBe(true);
    expect(taken.size).toBe(16); // same ids on both fixtures
  });
});

describe("6. depth cover: a man on IR covers nobody this week", () => {
  const P = (name: string, position: string, points: number, onIr = false): TradePlayer => ({ name, position, points, onIr });
  const base: TradePlayer[] = [
    P("QB1", "QB", 300), P("RB1", "RB", 200), P("RB2", "RB", 180), P("WR1", "WR", 190), P("WR2", "WR", 170),
    P("TE1", "TE", 120), P("F1", "WR", 150), P("F2", "RB", 140), P("K", "K", 90), P("DEF", "DEF", 80),
  ];
  test("depth insurance is unchanged by an IR backup", () => {
    const withIrBackup = [...base, P("RB3 hurt", "RB", 160, true)];
    expect(depthInsurance(withIrBackup, DEFAULT_FAIRNESS)).toBe(depthInsurance(base, DEFAULT_FAIRNESS));
  });
  test("but the same backup healthy does add cover", () => {
    const healthy = [...base, P("RB3", "RB", 160, false)];
    expect(depthInsurance(healthy, DEFAULT_FAIRNESS)).toBeGreaterThan(depthInsurance(base, DEFAULT_FAIRNESS));
  });
  test("and giving away the IR player still costs his season value", () => {
    const stash = P("Stash", "WR", 200, true);
    const offer = { receive: [P("Meh", "WR", 60)], give: [stash] };
    const withHim = evaluateTradeTwoSided(offer, [...base, stash], base, DEFAULT_FAIRNESS).ourGain;
    const without = evaluateTradeTwoSided(offer, base, base, DEFAULT_FAIRNESS).ourGain;
    expect(withHim).toBeLessThan(without);
  });
});

describe("7. the stale read: a REST-shaped roster degrades, never throws", () => {
  test("reserve null and no player_map means everyone is active", () => {
    const rest: Roster = { roster_id: 3, owner_id: "u", players: ["1", "SEA"], starters: ["1", "SEA"], reserve: null, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 } };
    const v = buildRosterView(rest);
    expect(v.active.length).toBe(2);
    expect(v.reserve.length).toBe(0);
    expect(v.owned.find((e) => e.playerId === "SEA")?.position).toBe("DEF");
  });
});

describe("8. a stash is never traded away by the robot", () => {
  const P = (name: string, position: string, points: number, onIr = false): TradePlayer => ({ name, position, points, onIr });
  // A bench-tier IR player: behind two better receivers, so his season-lineup
  // contribution is zero and depth cover skips him. The value model prices him
  // at nothing, which is why a rail has to exist.
  const base: TradePlayer[] = [
    P("QB1", "QB", 300), P("RB1", "RB", 200), P("RB2", "RB", 180), P("WR1", "WR", 230), P("WR2", "WR", 220),
    P("TE1", "TE", 120), P("F1", "WR", 210), P("F2", "RB", 140), P("K", "K", 90), P("DEF", "DEF", 80),
  ];
  const stash = P("Bench Stash", "WR", 130, true);
  test("canDrop refuses a player on IR", () => {
    const v = canDrop("Bench Stash", [...base, stash]);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("injured reserve");
  });
  test("a trade giving him away is blocked by that rail, whatever the value says", () => {
    const ev = evaluateTradeTwoSided({ receive: [P("Any", "WR", 60)], give: [stash] }, [...base, stash], base, DEFAULT_FAIRNESS);
    expect(ev.verdict).not.toBe("accept");
    expect(ev.railBlocks.some((b) => b.includes("injured reserve"))).toBe(true);
  });
  test("the same player, healthy, is not blocked by this rail", () => {
    const v = canDrop("Bench Stash", [...base, { ...stash, onIr: false }]);
    expect(v.reason).not.toContain("injured reserve");
  });
});
