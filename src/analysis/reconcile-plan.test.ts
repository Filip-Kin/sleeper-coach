import { describe, expect, test } from "bun:test";
import { buildRosterView, droppable } from "./roster-view.ts";
import { chooseForcedDrops } from "./roster-fit.ts";
import { DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { activeRailRoster, chooseLegalForcedDrops } from "./reconcile-plan.ts";
import type { Roster } from "../sleeper/types.ts";
import type { RailPlayer } from "./rails.ts";

// R2, the audit fixture of 2026-09-23. reconcileRoster handed chooseForcedDrops
// the droppable() SUBSET (the five bodies outside the protected top twelve).
// chooseForcedDrops runs bestLineup on whatever it is given, and a lineup built
// from four fringe players has an empty QB slot, so every candidate "would
// empty a mandatory slot" and the function returned []. The daemon then alerted
// "cannot auto-fix" every poll. The fix is to hand it the FULL active roster.

const mini = (id: string, pos: string) => ({ player_id: id, first_name: "P", last_name: id, position: pos, fantasy_positions: [pos], team: "HOU", status: "Active", injury_status: null, news_updated: null });
const SPEC: [string, string, number][] = [
  ["qb1", "QB", 300], ["rb1", "RB", 250], ["rb2", "RB", 240], ["wr1", "WR", 230], ["wr2", "WR", 220],
  ["te1", "TE", 180], ["rb3", "RB", 200], ["wr3", "WR", 190], ["k1", "K", 120], ["DET", "DEF", 100],
  ["qb2", "QB", 150], ["wr4", "WR", 110],
  ["rb4", "RB", 60], ["wr5", "WR", 55], ["rb5", "RB", 50], ["wr6", "WR", 45], ["te2", "TE", 40],
];
const roster: Roster = {
  roster_id: 3, owner_id: "u", players: SPEC.map((s) => s[0]), starters: SPEC.slice(0, 10).map((s) => s[0]), reserve: null, keepers: null,
  settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 },
  player_map: Object.fromEntries(SPEC.map(([id, pos]) => [id, mini(id, pos)])),
};
const rail: RailPlayer[] = SPEC.map(([id, pos, pts]) => ({ playerId: id, name: `P ${id}`, position: pos, points: pts, onIr: false }));
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [3, 4, 5, 6], remainingWeeks: 13, headToHeadRemaining: 1 };

describe("R2: the dead over-cap path", () => {
  const view = buildRosterView(roster);
  test("17 active is over a 16 cap by one", () => {
    expect(view.active.length).toBe(17);
  });
  test("the subset path returns nothing (the bug, preserved)", () => {
    const subset = droppable(view, rail, DEFAULT_FAIRNESS.rails);
    expect(subset.length).toBe(5);
    expect(chooseForcedDrops(subset, 1, cfg)).toEqual([]);
  });
  test("the full active roster yields exactly one drop", () => {
    const full = activeRailRoster(view, rail);
    expect(full.length).toBe(17);
    const drops = chooseLegalForcedDrops(view, full, 1, cfg, DEFAULT_FAIRNESS.rails);
    expect(drops.length).toBe(1);
  });
  test("every chosen name passes the droppable post-check", () => {
    const full = activeRailRoster(view, rail);
    const allowed = new Set(droppable(view, full, DEFAULT_FAIRNESS.rails).map((p) => p.name));
    for (const d of chooseLegalForcedDrops(view, full, 1, cfg, DEFAULT_FAIRNESS.rails)) expect(allowed.has(d.name)).toBe(true);
  });
  test("a player on IR is never in the active rail roster", () => {
    const withIr: Roster = { ...roster, reserve: ["wr6"] };
    const v = buildRosterView(withIr);
    const full = activeRailRoster(v, rail.map((p) => (p.playerId === "wr6" ? { ...p, onIr: true } : p)));
    expect(full.some((p) => p.playerId === "wr6")).toBe(false);
    expect(full.length).toBe(16);
  });
});
