import { describe, expect, test } from "bun:test";
import { toRoster, toNflState, toLeague, withRestFallback, toScheduleGame } from "./graphql.ts";

describe("mappers", () => {
  test("toRoster keeps the REST shape and adds player_map", () => {
    const r = toRoster({
      roster_id: 3, owner_id: "u", players: ["1", "SEA"], starters: ["1", "SEA"], reserve: null, keepers: null,
      settings: { wins: 1, losses: 0, fpts: 100 },
      player_map: { "1": { player_id: "1", first_name: "A", last_name: "B", position: "WR", fantasy_positions: ["WR"], team: "GB", status: "Active", injury_status: "Out", news_updated: 5 }, "SEA": null },
    });
    expect(r.roster_id).toBe(3);
    expect(r.starters).toEqual(["1", "SEA"]);
    expect(r.settings.wins).toBe(1);
    expect(r.player_map?.["1"]?.injury_status).toBe("Out");
    expect(r.player_map?.["SEA"]).toBeUndefined();
  });
  test("toRoster without player_map leaves the key absent", () => {
    expect("player_map" in toRoster({ roster_id: 1 })).toBe(false);
  });
  test("toNflState from sport_info", () => {
    const s = toNflState({ week: 3, display_week: 3, season: "2026", season_type: "regular", leg: 3 });
    expect(s).toEqual({ week: 3, display_week: 3, season: "2026", season_type: "regular" });
  });
  test("toLeague carries slots and scoring", () => {
    const l = toLeague({ league_id: "L", name: "x", season: "2026", status: "in_season", total_rosters: 8, draft_id: "D", previous_league_id: null, scoring_settings: { rec: 1 }, roster_positions: ["QB", "BN"], settings: { playoff_week_start: 15 } });
    expect(l.roster_positions).toEqual(["QB", "BN"]);
    expect(l.scoring_settings.rec).toBe(1);
    expect(l.settings.playoff_week_start).toBe(15);
  });
});

describe("schedule rows", () => {
  test("a scores row becomes a game with both teams and the kickoff", () => {
    // Shape read from the live feed on 2026-10-06 (week 4, DEN at SF).
    const g = toScheduleGame({ game_id: "202610431", status: "complete", start_time: 1791145500000, metadata: { away_team: "DEN", home_team: "SF", away_score: 20 } });
    expect(g).toEqual({ gameId: "202610431", away: "DEN", home: "SF", startTime: 1791145500000, status: "complete" });
  });
  test("a canceled row is dropped: SEA@DAL, week 6, must not kick Dallas off on Thursday", () => {
    expect(toScheduleGame({ game_id: "202610609", status: "canceled", start_time: 1792109700000, metadata: { away_team: "SEA", home_team: "DAL", canceled: false } })).toBeNull();
    expect(toScheduleGame({ game_id: "202610612", status: "pre_game", start_time: 1792369200000, metadata: { away_team: "DAL", home_team: "GB" } })?.away).toBe("DAL");
  });
  test("a row with no teams or no kickoff is dropped, not half read", () => {
    expect(toScheduleGame({ game_id: "x", start_time: 5, metadata: {} })).toBeNull();
    expect(toScheduleGame({ game_id: "x", start_time: 0, metadata: { away_team: "DEN", home_team: "SF" } })).toBeNull();
    expect(toScheduleGame({ game_id: "x", start_time: 5, metadata: null })).toBeNull();
    expect(toScheduleGame({ game_id: "x", start_time: "soon", metadata: { away_team: "DEN", home_team: "SF" } })).toBeNull();
  });
});

describe("withRestFallback", () => {
  test("uses graphql when it works", async () => {
    let rest = 0;
    const v = await withRestFallback("x", async () => "gql", async () => { rest++; return "rest"; }, true);
    expect(v).toBe("gql");
    expect(rest).toBe(0);
  });
  test("falls back to REST when graphql throws", async () => {
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (m: string) => { logged.push(m); };
    try {
      const v = await withRestFallback("x", async () => { throw new Error("boom"); }, async () => "rest", true);
      expect(v).toBe("rest");
      expect(logged[0]).toContain("boom");
    } finally {
      console.warn = warn;
    }
  });
  test("disabled means REST only", async () => {
    let gql = 0;
    const v = await withRestFallback("x", async () => { gql++; return "gql"; }, async () => "rest", false);
    expect(v).toBe("rest");
    expect(gql).toBe(0);
  });
});
