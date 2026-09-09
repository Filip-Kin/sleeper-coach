import { describe, expect, test } from "bun:test";
import { planLineup, parseTeamKickoffs, overlayRosterStatus } from "./lineup-guard.ts";
import type { LineupPlayer } from "../analysis/lineup.ts";
import type { PlayersMap } from "../sleeper/types.ts";

const P = (playerId: string, position: string, points: number, injuryStatus: string | null = null, extra: Partial<LineupPlayer> = {}): LineupPlayer =>
  ({ playerId, name: `P${playerId}`, position, points, injuryStatus, onBye: false, inactive: false, ...extra }) as LineupPlayer;

const SLOTS = ["QB", "RB", "RB", "WR", "FLEX", "K", "DEF"];
const roster = () => [
  P("q1", "QB", 20), P("q2", "QB", 15),
  P("r1", "RB", 14), P("r2", "RB", 12), P("r3", "RB", 9),
  P("w1", "WR", 13), P("w2", "WR", 10),
  P("k1", "K", 8), P("SEA", "DEF", 7),
];
const CURRENT = ["q1", "r1", "r2", "w1", "w2", "k1", "SEA"];

describe("planLineup", () => {
  test("optimal lineup already set means no change", () => {
    const plan = planLineup(CURRENT, roster(), SLOTS, new Set());
    expect(plan.changed).toBe(false);
    expect(plan.ids).toEqual(CURRENT);
  });

  test("a starter who goes Out is replaced by the best bench body", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids).not.toContain("r1");
    expect(plan.ids).toContain("r3");
    expect(plan.swaps[0]?.why).toContain("Out");
  });

  test("a player back from Out who outscores his fill-in is restored", () => {
    // Site currently has r3 in for r1 (r1 was Out last lock); now r1 is healthy.
    const current = ["q1", "r3", "r2", "w1", "w2", "k1", "SEA"];
    const plan = planLineup(current, roster(), SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids).toContain("r1");
    expect(plan.ids).not.toContain("r3");
  });

  test("Questionable still starts", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Questionable" } : p));
    expect(planLineup(CURRENT, rs, SLOTS, new Set()).changed).toBe(false);
  });

  test("a locked Out starter stays; a locked bench player never comes in", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    // r1's game has kicked off, and so has r3's.
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(["r1", "r3"]));
    expect(plan.changed).toBe(false);
    expect(plan.ids[1]).toBe("r1");
  });

  test("locked starter pinned while an unlocked slot still gets fixed", () => {
    const rs = roster().map((p) => (p.playerId === "w1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(["q1"]));
    expect(plan.changed).toBe(true);
    expect(plan.ids[0]).toBe("q1");
    expect(plan.ids).not.toContain("w1");
    expect(plan.ids).toContain("r3"); // r3 fills FLEX, w2 moves to WR
  });

  test("permuting two like slots is not a change", () => {
    const slots = ["RB", "RB"];
    const plan = planLineup(["r2", "r1"], [P("r1", "RB", 14), P("r2", "RB", 12)], slots, new Set());
    expect(plan.changed).toBe(false);
  });

  test("an Out kicker with no replacement keeps his slot rather than emptying it", () => {
    const rs = roster().map((p) => (p.playerId === "k1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.changed).toBe(false);
    expect(plan.ids[5]).toBe("k1");
    expect(plan.unfilled).toEqual(["K"]);
  });

  test("never writes an empty slot where the site has a player", () => {
    const rs = roster().filter((p) => p.playerId !== "SEA");
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.ids[6]).toBe("SEA");
  });
});

describe("parseTeamKickoffs", () => {
  test("maps both teams of each game to its kickoff", () => {
    const m = parseTeamKickoffs({ games: [{ startTime: 100, label: "CHI@CAR" }, { startTime: 200, label: "LAR@SF" }, { startTime: 0, label: "X@Y" }, { label: "bad" }] });
    expect(m.get("CHI")).toBe(100);
    expect(m.get("CAR")).toBe(100);
    expect(m.get("SF")).toBe(200);
    expect(m.size).toBe(4);
  });
  test("tolerates a missing cache", () => {
    expect(parseTeamKickoffs(null).size).toBe(0);
  });
});

describe("overlayRosterStatus", () => {
  const dump: PlayersMap = {
    "1": { player_id: "1", first_name: "A", last_name: "B", position: "WR", fantasy_positions: ["WR"], team: "GB", age: 1, years_exp: 1, status: "Active", injury_status: "Questionable", injury_notes: null, search_rank: 5 },
  };
  test("live null status beats the dump's stale Questionable", () => {
    const out = overlayRosterStatus(dump, { player_map: { "1": { player_id: "1", first_name: "A", last_name: "B", position: "WR", fantasy_positions: ["WR"], team: "GB", status: "Active", injury_status: null, news_updated: 1 } } });
    expect(out["1"]?.injury_status).toBeNull();
    expect(out["1"]?.search_rank).toBe(5); // dump fields kept
    expect(dump["1"]?.injury_status).toBe("Questionable"); // pure
  });
  test("a player missing from the dump is built from the map", () => {
    const out = overlayRosterStatus({}, { player_map: { "9": { player_id: "9", first_name: "New", last_name: "Guy", position: "RB", fantasy_positions: ["RB"], team: "DET", status: "Active", injury_status: "Out", news_updated: null } } });
    expect(out["9"]?.position).toBe("RB");
    expect(out["9"]?.full_name).toBe("New Guy");
    expect(out["9"]?.injury_status).toBe("Out");
  });
  test("no player_map means the dump is returned as is", () => {
    expect(overlayRosterStatus(dump, {})).toBe(dump);
  });
});
