import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWeekProjections, normaliseWeek, scoredRows, tableIsUsable, MIN_SCORED_ROWS, type WeekSource } from "./week-projections.ts";
import { assertUsableWeek } from "./ros-projections.ts";
import type { ProjectionRecord, ScoringSettings } from "../sleeper/types.ts";

// The 2026-10-07 05:15 ET feed: 200 OK, thousands of rows, every number
// zero. The loader must not cache it over a real table, and must not serve
// it when a real table is on disk.

const SCORING: ScoringSettings = { rec: 1, rec_yd: 0.1 } as ScoringSettings;

function row(i: number, rec: number, game = true): ProjectionRecord & { game_id?: string | null; opponent?: string | null } {
  return {
    player_id: String(1000 + i), week: 5, season: "2026", team: "KC",
    stats: rec > 0 ? { rec, rec_yd: rec * 10, pts_ppr: rec * 2 } : { adp_dd_ppr: 999, gp: 1 },
    player: { first_name: "P", last_name: String(i), position: "WR", fantasy_positions: ["WR"], team: "KC", injury_status: null },
    game_id: game ? "202610501" : null, opponent: game ? "LV" : null,
  };
}
/** `scored` rows with numbers, the rest at zero; 3,000 rows like a real week. */
function table(scored: number): ProjectionRecord[] {
  return Array.from({ length: 3000 }, (_, i) => row(i, i < scored ? 5 : 0));
}

describe("a week is a projection table only when enough rows carry a number", () => {
  test("the live weeks measured on 2026-10-07 clear the floor by four times", () => {
    expect(MIN_SCORED_ROWS).toBe(100);
    expect(scoredRows(normaliseWeek(table(415), 5, SCORING))).toBe(415);
    expect(tableIsUsable(normaliseWeek(table(415), 5, SCORING))).toBe(true);
  });
  test("every row at zero is not a table, however many rows there are", () => {
    const norm = normaliseWeek(table(0), 5, SCORING);
    expect(norm.length).toBe(3000);
    expect(scoredRows(norm)).toBe(0);
    expect(tableIsUsable(norm)).toBe(false);
  });
  test("a handful of numbers is still not a table", () => {
    expect(tableIsUsable(normaliseWeek(table(MIN_SCORED_ROWS - 1), 5, SCORING))).toBe(false);
    expect(tableIsUsable(normaliseWeek(table(MIN_SCORED_ROWS), 5, SCORING))).toBe(true);
  });
});

describe("the loader keeps the last usable table when the feed answers with none", () => {
  let dir = "";
  let fetches: ProjectionRecord[][] = [];
  let clock = 0;
  const src = (): WeekSource => ({ dir: `${dir}/`, now: () => clock, fetch: async () => { const t = fetches.shift(); if (!t) throw new Error("unexpected fetch"); return t; } });
  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "week-proj-"));
    fetches = [];
    clock = 1_000_000;
  });

  test("a good table is cached for 30 minutes", async () => {
    fetches = [table(400)];
    const a = await loadWeekProjections("2026", 5, SCORING, { source: src() });
    expect(scoredRows(a)).toBe(400);
    clock += 29 * 60_000;
    const b = await loadWeekProjections("2026", 5, SCORING, { source: src() });
    expect(scoredRows(b)).toBe(400); // no fetch queued: served from disk
    expect(fetches.length).toBe(0);
  });

  test("a feed of zeros over a good cache serves the good table and retries in five minutes", async () => {
    fetches = [table(400)];
    await loadWeekProjections("2026", 5, SCORING, { source: src() });
    clock += 31 * 60_000;
    fetches = [table(0)];
    const kept = await loadWeekProjections("2026", 5, SCORING, { source: src() });
    expect(scoredRows(kept)).toBe(400);
    expect(fetches.length).toBe(0);
    const meta = await Bun.file(`${dir}/week-proj-2026-5.meta.json`).json();
    expect(meta.degenerate).toBe(true);
    expect(meta.keptFrom).toBe(1_000_000);
    // Four minutes on: still the kept table, no fetch.
    clock += 4 * 60_000;
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src() }))).toBe(400);
    // Six minutes on: refetch; still zeros; still the kept table, keptFrom unchanged.
    clock += 2 * 60_000;
    fetches = [table(0)];
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src() }))).toBe(400);
    expect((await Bun.file(`${dir}/week-proj-2026-5.meta.json`).json()).keptFrom).toBe(1_000_000);
    // The feed recovers: the new table replaces the kept one and the meta is clean.
    clock += 6 * 60_000;
    fetches = [table(450)];
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src() }))).toBe(450);
    const after = await Bun.file(`${dir}/week-proj-2026-5.meta.json`).json();
    expect(after.degenerate).toBeUndefined();
    expect(after.fetchedAt).toBe(clock);
  });

  test("a feed of zeros with nothing on disk is handed over as zeros, cached briefly", async () => {
    fetches = [table(0)];
    const z = await loadWeekProjections("2026", 5, SCORING, { source: src() });
    expect(z.length).toBe(3000);
    expect(scoredRows(z)).toBe(0);
    clock += 4 * 60_000;
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src() }))).toBe(0); // no fetch queued
    clock += 2 * 60_000;
    fetches = [table(420)];
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src() }))).toBe(420);
  });

  test("--refresh past a good cache that meets a feed of zeros still serves the good table", async () => {
    fetches = [table(400)];
    await loadWeekProjections("2026", 5, SCORING, { source: src() });
    fetches = [table(0)];
    expect(scoredRows(await loadWeekProjections("2026", 5, SCORING, { source: src(), forceRefresh: true }))).toBe(400);
  });
});

describe("the rest-of-season sum refuses a week with no numbers", () => {
  test("a usable week passes, a week of zeros throws and names the week", () => {
    expect(() => assertUsableWeek(normaliseWeek(table(415), 5, SCORING), 5)).not.toThrow();
    expect(() => assertUsableWeek(normaliseWeek(table(0), 5, SCORING), 5)).toThrow(/week 5 projection table has no numbers/);
    expect(() => assertUsableWeek([], 9)).toThrow(/week 9/);
  });
});
