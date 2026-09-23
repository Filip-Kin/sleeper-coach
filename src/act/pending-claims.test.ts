import { describe, expect, test } from "bun:test";
import { parsePendingClaims, withoutPendingAdds, railsWithPendingDrops } from "./pending-claims.ts";
import { planOne, DEFAULT_WAIVERS, type RosterState } from "../analysis/waivers.ts";

// R6. A player named in one of OUR pending claims is spoken for: the add is not
// a candidate again, and the drop is not on the drop table for another move.

const rows = [
  { transaction_id: "t1", type: "waiver", roster_ids: [1], adds: { A: 1 }, drops: { B: 1 } },
  { transaction_id: "t2", type: "waiver", roster_ids: [2], adds: { C: 2 }, drops: null },
  { transaction_id: "t3", type: "trade", roster_ids: [1, 2], adds: { D: 1 }, drops: { E: 1 } },
  { transaction_id: "t1", type: "waiver", roster_ids: [1], adds: { A: 1 }, drops: { B: 1 } },
];

describe("parsePendingClaims", () => {
  test("keeps only our waiver claims, deduplicated", () => {
    const p = parsePendingClaims(rows, 1);
    expect(p.adds).toEqual(["A"]);
    expect(p.drops).toEqual(["B"]);
    expect(p.slotsNeeded).toBe(0);
  });
  test("a claim with no drop needs a slot", () => {
    const p = parsePendingClaims([{ transaction_id: "t9", type: "waiver", roster_ids: [1], adds: { Z: 1 }, drops: null }], 1);
    expect(p.slotsNeeded).toBe(1);
  });
});

describe("the pending players are in neither pool nor drop table", () => {
  const roster = [
    { name: "QB Guy", position: "QB", points: 300, playerId: "q" },
    { name: "RB Guy", position: "RB", points: 200, playerId: "r" },
    { name: "WR Guy", position: "WR", points: 100, playerId: "w" },
    { name: "Pending Drop", position: "WR", points: 10, playerId: "B" },
    { name: "Other Bench", position: "WR", points: 30, playerId: "o" },
  ];
  test("the add is filtered from the pool by id", () => {
    const pool = [{ playerId: "A", name: "A" }, { playerId: "X", name: "X" }];
    expect(withoutPendingAdds(pool, ["A"]).map((p) => p.playerId)).toEqual(["X"]);
  });
  test("the drop is never chosen, the worse bench body is", () => {
    const rails = railsWithPendingDrops({ ...DEFAULT_WAIVERS.rails, protectTopN: 3 }, roster, ["B"]);
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: ["QB", "RB", "WR"], currentStarters: ["QB Guy", "RB Guy", "WR Guy"] };
    const m = planOne({ name: "Good WR", position: "WR", points: 140, onWaivers: false }, state, { ...DEFAULT_WAIVERS, rails });
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Other Bench");
  });
});
