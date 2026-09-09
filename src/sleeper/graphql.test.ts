import { describe, expect, test } from "bun:test";
import { toRoster, toNflState, toLeague, toMatchup, withRestFallback } from "./graphql.ts";

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
  test("toMatchup keeps roster_id and matchup_id", () => {
    expect(toMatchup({ roster_id: 2, matchup_id: 4, starters: ["a"], players: ["a", "b"], points: null })).toEqual({ roster_id: 2, matchup_id: 4, starters: ["a"], players: ["a", "b"], points: null });
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
