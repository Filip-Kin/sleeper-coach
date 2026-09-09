// Draft GraphQL helpers: mappers, the pick_no rule and on-clock detection,
// with fixtures shaped like the live responses. No network.
//
// Fixture facts come from real reads on 2026-09-09: the completed real draft
// (8x16, 128 picks, GraphQL matched REST on every player_id and pick_no) and a
// mock draft where draft_pick_player / react_to_draft_pick / update_draft_queue
// were exercised end to end.

import { describe, expect, test } from "bun:test";
import {
  toDraftInfo, toLivePick, toActivePlayer, nextOpenPickNo, clockState, availableIds, pickRound, pickSlot,
  safeId, safePlayerId, getDraft, draftPicks, draftQueue, updateDraftQueue, draftPickPlayer, reactToDraftPick,
} from "./draft-api.ts";
import type { Gql } from "./api.ts";

const ME = "1267685386142887936";

const draftRow = {
  draft_id: "1389357604773322753",
  league_id: "1389357604773322752",
  status: "drafting",
  type: "snake",
  settings: { teams: 8, rounds: 16, pick_timer: 90, reversal_round: 0, cpu_autopick: 1, slots_bn: 6 },
  draft_order: { "1267685003886604288": 1, "1267685369680236545": 2, "1129924426755289088": 3, [ME]: 4, "1262601728889475072": 5 },
  start_time: 1788127790950,
  last_picked: 1788131930168,
};

const pickRow = {
  draft_id: "1389357604773322753",
  is_keeper: null,
  metadata: { first_name: "Jahmyr", last_name: "Gibbs", position: "RB", team: "DET", player_id: "9221", injury_status: "" },
  pick_no: 1,
  picked_by: "1267685003886604288",
  player_id: "9221",
  reactions: { [ME]: ["crying"] },
};

const picksUpTo = (n: number) => Array.from({ length: n }, (_, i) => ({ pickNo: i + 1 }));

describe("mappers", () => {
  test("toDraftInfo reads settings and the order", () => {
    const d = toDraftInfo(draftRow);
    expect(d.teams).toBe(8);
    expect(d.rounds).toBe(16);
    expect(d.pickTimer).toBe(90);
    expect(d.status).toBe("drafting");
    expect(d.leagueId).toBe("1389357604773322752");
    expect(d.draftOrder?.[ME]).toBe(4);
  });

  test("toDraftInfo tolerates a mock draft with no order and no league", () => {
    const d = toDraftInfo({ draft_id: "1", league_id: null, status: "pre_draft", settings: { teams: 8, rounds: 15 }, draft_order: null });
    expect(d.leagueId).toBeNull();
    expect(d.draftOrder).toBeNull();
    expect(d.startTime).toBeNull();
  });

  test("toLivePick builds the full name and keeps reactions", () => {
    const p = toLivePick(pickRow);
    expect(p.pickNo).toBe(1);
    expect(p.playerId).toBe("9221");
    expect(p.name).toBe("Jahmyr Gibbs");
    expect(p.position).toBe("RB");
    expect(p.team).toBe("DET");
    expect(p.isKeeper).toBe(false);
    expect(p.reactions[ME]).toEqual(["crying"]);
  });

  test("toLivePick handles a CPU pick with null reactions and a DEF", () => {
    const p = toLivePick({ pick_no: 7, picked_by: "0", player_id: "SEA", reactions: null, metadata: { first_name: "Seattle", last_name: "Seahawks", position: "DEF", team: "SEA" } });
    expect(p.pickedBy).toBe("0");
    expect(p.playerId).toBe("SEA");
    expect(p.reactions).toEqual({});
  });

  test("toActivePlayer", () => {
    const a = toActivePlayer({ player_id: "9509", first_name: "Bijan", last_name: "Robinson", position: "RB", team: "ATL", injury_status: null });
    expect(a).toEqual({ playerId: "9509", name: "Bijan Robinson", position: "RB", team: "ATL", injuryStatus: null });
  });
});

describe("pick_no rule", () => {
  test("empty board: pick 1", () => {
    expect(nextOpenPickNo([], 8, 16)).toBe(1);
  });
  test("picks made + 1 when there are no gaps", () => {
    expect(nextOpenPickNo(picksUpTo(12), 8, 16)).toBe(13);
  });
  test("a keeper further down the board does not advance the clock", () => {
    // 3 picks in, plus a keeper already sitting at pick 20: the open pick is 4, not 5.
    expect(nextOpenPickNo([...picksUpTo(3), { pickNo: 20 }], 8, 16)).toBe(4);
  });
  test("full board: null", () => {
    expect(nextOpenPickNo(picksUpTo(128), 8, 16)).toBeNull();
  });
  test("round and slot of a pick number follow the snake", () => {
    // Slot 4 in an 8-team snake owns picks 4, 13, 20, 29 (checked against REST draft_slot for all 128 real picks).
    expect([4, 13, 20, 29].map((n) => pickSlot(n, 8))).toEqual([4, 4, 4, 4]);
    expect([4, 13, 20, 29].map((n) => pickRound(n, 8))).toEqual([1, 2, 3, 4]);
    expect(pickSlot(8, 8)).toBe(8);
    expect(pickSlot(9, 8)).toBe(8);
    expect(pickSlot(16, 8)).toBe(1);
    expect(pickSlot(17, 8)).toBe(1);
  });
});

describe("on-clock detection", () => {
  const live = toDraftInfo(draftRow);

  test("our slot, draft live, open pick is ours", () => {
    const c = clockState(live, picksUpTo(3), ME);
    expect(c).toEqual({ mySlot: 4, pickNo: 4, round: 1, slot: 4, onClock: true });
  });
  test("open pick belongs to someone else", () => {
    const c = clockState(live, picksUpTo(4), ME);
    expect(c.pickNo).toBe(5);
    expect(c.slot).toBe(5);
    expect(c.onClock).toBe(false);
  });
  test("snake turn: pick 13 is ours again in round 2", () => {
    const c = clockState(live, picksUpTo(12), ME);
    expect(c).toEqual({ mySlot: 4, pickNo: 13, round: 2, slot: 4, onClock: true });
  });
  test("paused draft is never our turn", () => {
    const c = clockState({ ...live, status: "paused" }, picksUpTo(3), ME);
    expect(c.pickNo).toBe(4);
    expect(c.onClock).toBe(false);
  });
  test("pre_draft is never our turn", () => {
    expect(clockState({ ...live, status: "pre_draft" }, [], ME).onClock).toBe(false);
  });
  test("no draft order yet: slot unknown, never on clock", () => {
    const c = clockState({ ...live, draftOrder: null }, picksUpTo(3), ME);
    expect(c.mySlot).toBeNull();
    expect(c.onClock).toBe(false);
  });
  test("full board: no pick, not on clock", () => {
    const c = clockState(live, picksUpTo(128), ME);
    expect(c.pickNo).toBeNull();
    expect(c.slot).toBe(0);
    expect(c.onClock).toBe(false);
  });
  test("keeper at our future pick: we still get the current open pick", () => {
    // Keeper parked at pick 13 (our R2). At 3 picks in, pick 4 is open and ours.
    const c = clockState(live, [...picksUpTo(3), { pickNo: 13 }], ME);
    expect(c).toEqual({ mySlot: 4, pickNo: 4, round: 1, slot: 4, onClock: true });
    // Later, 12 picks in with 13 already taken, the open pick is 14 (slot 3): not ours.
    const c2 = clockState(live, [...picksUpTo(12), { pickNo: 13 }], ME);
    expect(c2.pickNo).toBe(14);
    expect(c2.onClock).toBe(false);
  });
});

describe("availability", () => {
  test("board minus drafted, filtered to active, defenses exempt", () => {
    const board = ["9221", "9509", "4046", "SEA", "999999"];
    const drafted = new Set(["9221"]);
    const active = new Set(["9509", "4046"]);
    expect([...availableIds(board, drafted, active)]).toEqual(["9509", "4046", "SEA"]);
  });
  test("no active list: board minus drafted only", () => {
    expect([...availableIds(["1", "2", "3"], new Set(["2"]), null)]).toEqual(["1", "3"]);
  });
});

describe("ids", () => {
  test("safeId accepts snowflakes and rejects everything else", () => {
    expect(safeId("1389357604773322753")).toBe("1389357604773322753");
    expect(() => safeId("1389357604773322753) { x }")).toThrow();
    expect(() => safeId("")).toThrow();
    expect(() => safeId("SEA")).toThrow();
  });
  test("safePlayerId also accepts a defense team code", () => {
    expect(safePlayerId("SEA")).toBe("SEA");
    expect(safePlayerId("KC")).toBe("KC");
    expect(safePlayerId("4046")).toBe("4046");
    expect(() => safePlayerId("sea")).toThrow();
    expect(() => safePlayerId("SEAT")).toThrow();
  });
});

describe("queries and mutations (recorded gql)", () => {
  const recorder = (reply: Record<string, unknown>): { gql: Gql; queries: string[] } => {
    const queries: string[] = [];
    return { queries, gql: async (q: string) => { queries.push(q); return reply; } };
  };

  test("getDraft asks for the draft and maps it", async () => {
    const r = recorder({ data: { get_draft: draftRow } });
    const d = await getDraft(r.gql, "1389357604773322753");
    expect(r.queries[0]).toContain('get_draft(sport:"nfl",draft_id:"1389357604773322753")');
    expect(d.teams).toBe(8);
  });

  test("draftPicks sorts by pick_no", async () => {
    const r = recorder({ data: { draft_picks: [{ ...pickRow, pick_no: 2, player_id: "9509" }, pickRow] } });
    const p = await draftPicks(r.gql, "1389357604773322753");
    expect(p.map((x) => x.pickNo)).toEqual([1, 2]);
  });

  test("a GraphQL error surfaces as a thrown error", async () => {
    const r = recorder({ errors: [{ code: "not_found", message: "We could not find the draft" }] });
    await expect(getDraft(r.gql, "1")).rejects.toThrow(/not_found/);
  });

  test("draftQueue returns ids", async () => {
    const r = recorder({ data: { draft_queue: ["7594", "4199"] } });
    expect(await draftQueue(r.gql, "1389357604773322753")).toEqual(["7594", "4199"]);
  });

  test("updateDraftQueue sends the ids in order and reads the echo", async () => {
    const r = recorder({ data: { update_draft_queue: ["9509", "9221", "4046"] } });
    const q = await updateDraftQueue(r.gql, "1403555294021156864", ["9509", "9221", "4046"]);
    expect(r.queries[0]).toBe('mutation{update_draft_queue(draft_id:"1403555294021156864",player_ids:["9509","9221","4046"])}');
    expect(q).toEqual(["9509", "9221", "4046"]);
  });

  test("draftPickPlayer sends pick_no and maps the answer", async () => {
    const r = recorder({ data: { draft_pick_player: { pick_no: 4, player_id: "4046", picked_by: ME, is_keeper: false, metadata: { first_name: "Patrick", last_name: "Mahomes", position: "QB", team: "KC" }, reactions: null } } });
    const p = await draftPickPlayer(r.gql, "1403555294021156864", "4046", 4);
    expect(r.queries[0]).toContain('draft_pick_player(sport:"nfl",player_id:"4046",draft_id:"1403555294021156864",pick_no:4)');
    expect(p.name).toBe("Patrick Mahomes");
    expect(p.pickedBy).toBe(ME);
  });

  test("draftPickPlayer refuses a bad pick_no or id before sending anything", async () => {
    const r = recorder({ data: {} });
    await expect(draftPickPlayer(r.gql, "1", "4046", 0)).rejects.toThrow(/pick_no/);
    await expect(draftPickPlayer(r.gql, "1", "4046\"", 1)).rejects.toThrow(/unsafe/);
    expect(r.queries).toEqual([]);
  });

  test("reactToDraftPick sends the reaction and reads it back", async () => {
    const r = recorder({ data: { react_to_draft_pick: { ...pickRow, reactions: { [ME]: ["shock"] } } } });
    const p = await reactToDraftPick(r.gql, "1403555294021156864", 1, "shock");
    expect(r.queries[0]).toContain('react_to_draft_pick(sport:"nfl",draft_id:"1403555294021156864",pick_no:1,reaction:"shock")');
    expect(p.reactions[ME]).toEqual(["shock"]);
    await expect(reactToDraftPick(r.gql, "1", 1, "shock\"){x")).rejects.toThrow(/unsafe reaction/);
  });

  test("every write honours the kill switch", async () => {
    process.env.COACH_FREEZE = "1";
    try {
      const r = recorder({ data: {} });
      await expect(updateDraftQueue(r.gql, "1", ["1"])).rejects.toThrow(/FROZEN/);
      await expect(draftPickPlayer(r.gql, "1", "1", 1)).rejects.toThrow(/FROZEN/);
      await expect(reactToDraftPick(r.gql, "1", 1, "shock")).rejects.toThrow(/FROZEN/);
      expect(r.queries).toEqual([]);
    } finally {
      delete process.env.COACH_FREEZE;
    }
  });
});
