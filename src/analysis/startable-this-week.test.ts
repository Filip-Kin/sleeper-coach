// The lock half of "can this body take the starter's slot this week"
// (week-projections.ts startableThisWeek). The 2026-10-07 review: the first
// cut read only the bench body's kickoff, so on a Monday or a Tuesday before
// the week flips, with both defenses played, the rental was kept and the
// better defense headed the cut order again.
import { describe, expect, test } from "bun:test";
import { startableThisWeek, type WeekProjection } from "./week-projections.ts";

const row = (playerId: string, team: string, extra: Partial<WeekProjection> = {}): WeekProjection => ({
  playerId, name: playerId, position: "DEF", team, opponent: "X", gameId: `g-${team}`, points: 7, ptsPpr: 7,
  injuryStatus: null, onBye: false, hasGame: true, stats: {}, ...extra,
});
const table = new Map([["SEA", row("SEA", "SEA")], ["JAX", row("JAX", "JAX")], ["BYE", row("BYE", "BYE", { onBye: true, hasGame: false, points: 0 })], ["OUT", row("OUT", "OUT", { injuryStatus: "Out" })]]);
const T0 = 1_000_000;
const games = [
  { away: "SEA", home: "X1", startTime: T0 + 100 }, // Sunday late
  { away: "JAX", home: "X2", startTime: T0 + 50 },  // Sunday early
  { away: "OUT", home: "X3", startTime: T0 + 100 },
];
const sea = { playerId: "SEA" };
const jax = { playerId: "JAX" };

describe("a bench body fills a starter's slot", () => {
  test("before either game: yes", () => {
    expect(startableThisWeek(table, games, T0)(sea, jax)).toBe(true);
  });
  test("the body has kicked off while the starter has not: no, he is locked out of the lineup", () => {
    const seaFirst = [{ away: "SEA", home: "X1", startTime: T0 + 50 }, { away: "JAX", home: "X2", startTime: T0 + 100 }];
    expect(startableThisWeek(table, seaFirst, T0 + 60)(sea, jax)).toBe(false);
  });
  test("the starter has kicked off, the body has not: yes, the week's slot is settled by the starter", () => {
    expect(startableThisWeek(table, games, T0 + 60)(sea, jax)).toBe(true);
  });
  test("both have played (Monday, Tuesday before the week flips): yes", () => {
    expect(startableThisWeek(table, games, T0 + 500)(sea, jax)).toBe(true);
  });
  test("on bye, ruled out, missing from the table, no points: never", () => {
    const f = startableThisWeek(table, games, T0);
    expect(f({ playerId: "BYE" }, jax)).toBe(false);
    expect(f({ playerId: "OUT" }, jax)).toBe(false);
    expect(f({ playerId: "SEA", injuryStatus: "Out" }, jax)).toBe(false); // the live status wins
    expect(f({ playerId: "NOPE" }, jax)).toBe(false);
    expect(f({}, jax)).toBe(false);
  });
  test("a starter with no row counts as not kicked off, so a started body cannot fill his slot", () => {
    expect(startableThisWeek(table, games, T0 + 500)(sea, { playerId: "NOPE" })).toBe(false);
  });
  test("no schedule: nothing has kicked off, every playing body fills", () => {
    expect(startableThisWeek(table, [], T0 + 500)(sea, jax)).toBe(true);
  });
});
