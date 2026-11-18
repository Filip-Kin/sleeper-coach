import { describe, expect, test } from "bun:test";
import { impossibleRow, normaliseWeek, byPlayerId, weekPointsThisWeek, SINGLE_GAME_RECORD } from "./week-projections.ts";
import { sumWeeks } from "./ros-projections.ts";
import { buildValues, toRail } from "./value.ts";
import { canDrop, DEFAULT_RAILS, type RailPlayer } from "./rails.ts";
import type { ProjectionRecord, ScoringSettings } from "../sleeper/types.ts";

// Replay of Tue 2026-11-17 20:00 ET, week 11. The feed's week 15 row for
// Harrison Butker (KC at NE) read 17.22 field goals and 75.2 points; his
// other six weeks read 6.85 to 7.29. Summed he was 117 for the rest of the
// season, 16.7 a week, against Evan McPherson's 61, and the claim run
// recorded "claim Harrison Butker costing Wan'Dale Robinson (+55.7)". The
// stat lines below are the cached rows of weeks 11 to 17, as fetched.

const SCORING = { fgm: 3, xpm: 1, fgmiss: -1, xpmiss: -1, rec: 1, rec_yd: 0.1 } as unknown as ScoringSettings;
type Raw = ProjectionRecord & { game_id?: string | null; opponent?: string | null };

const BUTKER: Record<number, Record<string, number>> = {
  11: { fga: 1.96, fgm: 1.67, xpa: 2.42, xpm: 2.3, xpmiss: 0.12, gp: 1, pts_ppr: 7.29 },
  12: { fga: 1.84, fgm: 1.57, xpa: 2.27, xpm: 2.16, xpmiss: 0.11, gp: 1, pts_ppr: 6.85 },
  13: { fga: 1.91, fgm: 1.63, xpa: 2.36, xpm: 2.25, xpmiss: 0.11, gp: 1, pts_ppr: 7.12 },
  14: { fga: 1.87, fgm: 1.6, xpa: 2.31, xpm: 2.2, xpmiss: 0.11, gp: 1, pts_ppr: 6.97 },
  15: { fga: 20.19, fgm: 17.22, fgm_yds: 598.72, xpa: 24.94, xpm: 23.75, xpmiss: 1.19, gp: 1, pts_ppr: 75.2 },
  16: { fga: 1.85, fgm: 1.58, xpa: 2.28, xpm: 2.17, xpmiss: 0.11, gp: 1, pts_ppr: 6.89 },
  17: { fga: 1.96, fgm: 1.67, xpa: 2.42, xpm: 2.3, xpmiss: 0.11, gp: 1, pts_ppr: 7.28 },
};
const MCPHERSON: Record<number, Record<string, number>> = {
  11: { fgm: 2.04, xpm: 2.96, xpmiss: 0.14, gp: 1, pts_ppr: 9.01 },
  12: { fgm: 2.19, xpm: 3.17, xpmiss: 0.15, gp: 1, pts_ppr: 9.64 },
  13: { fgm: 1.87, xpm: 2.7, xpmiss: 0.13, gp: 1, pts_ppr: 8.23 },
  14: { fgm: 1.87, xpm: 2.7, xpmiss: 0.13, gp: 1, pts_ppr: 8.23 },
  15: { fgm: 1.94, xpm: 2.81, xpmiss: 0.13, gp: 1, pts_ppr: 8.55 },
  16: { fgm: 2.12, xpm: 3.07, xpmiss: 0.15, gp: 1, pts_ppr: 9.35 },
  17: { fgm: 1.85, xpm: 2.68, xpmiss: 0.13, gp: 1, pts_ppr: 8.15 },
};
const kicker = (id: string, last: string, team: string, week: number, stats: Record<string, number>): Raw => ({
  player_id: id, week, season: "2026", team, stats,
  player: { first_name: "K", last_name: last, position: "K", fantasy_positions: ["K"], team, injury_status: null },
  game_id: `2026${week}01`, opponent: "NE",
});
const WEEKS = [11, 12, 13, 14, 15, 16, 17];
const tables = WEEKS.map((week) => ({
  week,
  table: normaliseWeek([kicker("4227", "Butker", "KC", week, BUTKER[week]!), kicker("7839", "McPherson", "CIN", week, MCPHERSON[week]!)], week, SCORING),
}));

describe("a one-game projection over the NFL single-game record is not a projection", () => {
  test("Butker's week 15 row is refused on its field goals; his other weeks and McPherson's are rows", () => {
    expect(impossibleRow(BUTKER[15]!)).toBe("fgm 17.22 projected for one game, over the NFL single-game record of 8");
    for (const w of WEEKS.filter((x) => x !== 15)) expect(impossibleRow(BUTKER[w]!)).toBeNull();
    for (const w of WEEKS) expect(impossibleRow(MCPHERSON[w]!)).toBeNull();
  });
  test("the highest real rows of the cached weeks 10 to 17 are rows, and a record itself is one", () => {
    // Smith-Njigba week 13, Gibbs week 14, Prescott and Burrow week 11, Fairbairn week 11.
    expect(impossibleRow({ rec: 7.69, rec_yd: 123.5, rec_td: 1.02 })).toBeNull();
    expect(impossibleRow({ rush_yd: 108.72, rush_td: 1.32, rec: 5.1 })).toBeNull();
    expect(impossibleRow({ pass_yd: 327.23, pass_td: 2.82 })).toBeNull();
    expect(impossibleRow({ fgm: 2.36 })).toBeNull();
    expect(impossibleRow({ ...SINGLE_GAME_RECORD })).toBeNull();
    expect(impossibleRow({})).toBeNull();
  });
  test("every stat on the list is checked", () => {
    for (const [stat, record] of Object.entries(SINGLE_GAME_RECORD)) expect(impossibleRow({ [stat]: record + 0.01 })).toContain(stat);
  });
  test("the week table marks the row and leaves its points as the feed gave them", () => {
    const wk15 = byPlayerId(tables.find((t) => t.week === 15)!.table);
    expect(wk15.get("4227")!.impossible).toContain("fgm 17.22");
    expect(wk15.get("4227")!.points).toBeGreaterThan(70);
    expect(wk15.get("7839")!.impossible).toBeNull();
  });
});

describe("rest-of-season value leaves the impossible week out: a floor", () => {
  const ros = sumWeeks(tables);
  const season = [{ playerId: "4227", position: "K" as const, points: 40 }, { playerId: "7839", position: "K" as const, points: 42 }];
  const values = buildValues(ros.values(), season, 11);
  const butker = values.get("4227")!;
  const mcpherson = values.get("7839")!;
  test("as it ran that night the sum made Butker the better kicker by half again", () => {
    const raw = tables.reduce((n, t) => n + byPlayerId(t.table).get("4227")!.points, 0);
    expect(raw).toBeGreaterThan(110);
    expect(raw).toBeGreaterThan(mcpherson.value + 50);
  });
  test("without the week he is six weeks of a seven-point kicker, under McPherson", () => {
    expect(ros.get("4227")!.weeksCounted).toBe(6);
    expect(butker.value).toBeGreaterThan(40);
    expect(butker.value).toBeLessThan(46);
    expect(butker.value).toBeLessThan(mcpherson.value);
    expect(butker.suspect).toBe("week 15: fgm 17.22 projected for one game, over the NFL single-game record of 8");
    expect(mcpherson.suspect).toBeNull();
    expect(ros.get("7839")!.weeksCounted).toBe(7);
  });
  test("the mark reaches the rail player every cut path reads", () => {
    expect(toRail(butker).suspect).toContain("week 15");
    expect(toRail(mcpherson).suspect).toBeUndefined();
  });
});

describe("a player of ours with an impossible week is never the cut or a trade leg", () => {
  // The incident roster's bottom: Etienne and Meyers (68), McPherson (61),
  // Seattle (42), and a kicker of ours carrying the floor.
  const roster: RailPlayer[] = [
    { name: "Christian McCaffrey", position: "RB", points: 147 }, { name: "Kenneth Walker III", position: "RB", points: 145 },
    { name: "Patrick Mahomes", position: "QB", points: 140 }, { name: "Nico Collins", position: "WR", points: 113 },
    { name: "Dak Prescott", position: "QB", points: 111 }, { name: "Mike Evans", position: "WR", points: 106 },
    { name: "Jonah Coleman", position: "RB", points: 104 }, { name: "Chase Brown", position: "RB", points: 102 },
    { name: "DeVonta Smith", position: "WR", points: 94 }, { name: "Sam LaPorta", position: "TE", points: 88 },
    { name: "Stefon Diggs", position: "WR", points: 88 }, { name: "Ladd McConkey", position: "WR", points: 83 },
    { name: "Travis Etienne Jr.", position: "RB", points: 68 }, { name: "Jakobi Meyers", position: "WR", points: 68 },
    { name: "Seattle Seahawks", position: "DEF", points: 42 },
    { name: "Harrison Butker", position: "K", points: 42, suspect: "week 15: fgm 17.22 projected for one game, over the NFL single-game record of 8" },
  ];
  test("last on the roster by the floor and still not a cut", () => {
    const v = canDrop("Harrison Butker", roster, DEFAULT_RAILS);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("no usable projection");
    expect(v.reason).not.toContain("fgm"); // the reason can reach a rival in a DM
  });
  test("with his numbers back he is a cut like anyone outside the protected twelve", () => {
    const healed = roster.map((p) => (p.name === "Harrison Butker" ? { ...p, suspect: undefined } : p));
    expect(canDrop("Harrison Butker", healed, DEFAULT_RAILS).allowed).toBe(true);
    expect(canDrop("Seattle Seahawks", roster, DEFAULT_RAILS).allowed).toBe(true);
  });
});

describe("this week's points: a pool body is not picked on an impossible row, a man of ours keeps the feed's number", () => {
  const wk15 = byPlayerId(tables.find((t) => t.week === 15)!.table);
  const facts = weekPointsThisWeek(wk15, [], Date.UTC(2026, 11, 16));
  test("pool zero, ours as given, a real row unchanged either way", () => {
    expect(facts.points({ playerId: "4227" }, "KC", true)).toBe(0);
    expect(facts.points({ playerId: "4227" }, "KC")).toBeGreaterThan(70);
    expect(facts.points({ playerId: "7839" }, "CIN", true)).toBe(facts.points({ playerId: "7839" }, "CIN"));
    expect(facts.points({ playerId: "7839" }, "CIN", true)).toBeGreaterThan(8);
  });
});
