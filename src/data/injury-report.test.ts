import { describe, expect, test } from "bun:test";
import { validateReports, factsFor, needsResearch, type InjuryReport } from "./injury-report.ts";
import { canDrop } from "../analysis/rails.ts";
import { planSeasonOverRelease } from "../act/reserve-reconcile.ts";
import { buildRosterView } from "../analysis/roster-view.ts";
import type { Roster } from "../sleeper/types.ts";

const W = 10;
const rep = (over: Partial<InjuryReport>): InjuryReport => ({
  playerId: "6904", name: "Jalen Hurts", sleeperStatus: "IR", injury: "blood clots", returnWeek: null, seasonOver: true,
  confirmedBy: "doctor", confidence: "high", summary: "out for 2026", sources: ["https://x"], researchedAt: new Date().toISOString(), ...over,
});

describe("only a certain report ends a season (Filip, 2026-11-16)", () => {
  test("team or doctor, high confidence, still listed out: season over", () => {
    expect(factsFor(rep({}), "IR", W).seasonOver).toBe(true);
    expect(factsFor(rep({ confirmedBy: "team" }), "Out", W).seasonOver).toBe(true);
  });
  test("a reporter's 'might miss the season' is not season over", () => {
    expect(factsFor(rep({ confirmedBy: "report" }), "IR", W).seasonOver).toBe(false);
    expect(factsFor(rep({ confidence: "medium" }), "IR", W).seasonOver).toBe(false);
  });
  test("a player listed as playing is never season over, whatever an article says", () => {
    expect(factsFor(rep({}), null, W).seasonOver).toBe(false);
    expect(factsFor(rep({}), "Questionable", W).seasonOver).toBe(false);
  });
  test("a return week that has come while he is still out reads as unknown", () => {
    expect(factsFor(rep({ seasonOver: false, returnWeek: 10, confidence: "medium" }), "Out", W).returnWeek).toBeNull();
    expect(factsFor(rep({ seasonOver: false, returnWeek: 13, confidence: "medium" }), "IR", W).returnWeek).toBe(13);
    expect(factsFor(rep({ seasonOver: false, returnWeek: 13, confidence: "low" }), "IR", W).returnWeek).toBeNull();
  });
});

describe("validation", () => {
  const wanted = new Map([["Jalen Hurts", { playerId: "6904", status: "IR" }]]);
  test("an unsourced entry is dropped; a sourced one kept with its confirmation", () => {
    const now = new Date().toISOString();
    expect(validateReports({ players: [{ name: "Jalen Hurts", summary: "x", seasonOver: true, confirmedBy: "doctor", confidence: "high", sources: [] }] }, wanted, W, now)).toEqual({});
    const r = validateReports({ players: [{ name: "Jalen Hurts", injury: "clots", summary: "out", seasonOver: true, confirmedBy: "doctor", confidence: "high", sources: ["https://a"] }] }, wanted, W, now);
    expect(r["6904"]?.confirmedBy).toBe("doctor");
  });
  test("a stale or changed report is researched again", () => {
    const old = rep({ researchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    expect(needsResearch([{ playerId: "6904", status: "IR" }], { "6904": old }, Date.now())).toEqual(["6904"]);
    expect(needsResearch([{ playerId: "6904", status: "IR" }], { "6904": rep({}) }, Date.now())).toEqual([]);
    expect(needsResearch([{ playerId: "6904", status: "Out" }], { "6904": rep({}) }, Date.now())).toEqual(["6904"]);
  });
});

describe("release", () => {
  const mini = (id: string, pos: string, inj: string | null) => ({ player_id: id, first_name: "P", last_name: id, position: pos, fantasy_positions: [pos], team: "PHI", status: "Active", injury_status: inj, news_updated: null });
  const roster: Roster = { roster_id: 3, owner_id: "u", players: ["6904", "7525", "a"], starters: ["a"], reserve: ["6904", "7525"], keepers: null,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 },
    player_map: { "6904": mini("6904", "QB", "IR"), "7525": mini("7525", "WR", "Out"), a: mini("a", "QB", null) } };
  const view = buildRosterView(roster);
  test("only the season-over IR player is released; an unknown one is held", () => {
    const rail = [
      { playerId: "6904", name: "Jalen Hurts", position: "QB", points: 0, onIr: true, seasonOver: true },
      { playerId: "7525", name: "DeVonta Smith", position: "WR", points: 96, onIr: true },
    ];
    expect(planSeasonOverRelease(view, rail).map((p) => p.name)).toEqual(["Jalen Hurts"]);
    expect(canDrop("Jalen Hurts", rail).allowed).toBe(true);
    expect(canDrop("DeVonta Smith", rail).allowed).toBe(false);
  });
});
