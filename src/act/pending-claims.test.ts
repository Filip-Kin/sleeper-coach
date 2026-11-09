import { describe, expect, test } from "bun:test";
import { parsePendingClaims, withoutPendingAdds, railsWithPendingDrops, NO_PENDING } from "./pending-claims.ts";
import { planOne, DEFAULT_WAIVERS, type RosterState } from "../analysis/waivers.ts";
import { canDrop } from "../analysis/rails.ts";

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
  test("each claim is kept whole with the leg it was read under, so it can be cancelled (2026-10-07)", () => {
    const p = parsePendingClaims([
      { transaction_id: "t9", type: "waiver", roster_ids: [1], adds: { Z: 1 }, drops: null, leg: 4 },
      ...rows.map((r) => ({ ...r, leg: 5 })),
    ], 1);
    expect(p.claims).toEqual([
      { transactionId: "t9", leg: 4, adds: ["Z"], drops: [], seats: 1 },
      { transactionId: "t1", leg: 5, adds: ["A"], drops: ["B"], seats: 0 },
    ]);
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
    const rails = railsWithPendingDrops({ ...DEFAULT_WAIVERS.rails, protectTopN: 3 }, roster, { ...NO_PENDING, drops: ["B"] });
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: ["QB", "RB", "WR"], currentStarters: ["QB Guy", "RB Guy", "WR Guy"] };
    const m = planOne({ name: "Good WR", position: "WR", points: 140, onWaivers: false }, state, { ...DEFAULT_WAIVERS, rails });
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Other Bench");
  });
});

// 2026-11-09: the legs we give in a live trade of ours are committed the same
// way. The offer 1425359907405783040 (DJ Moore for Prescott + Meyers + Shakir)
// was live while Shakir, Meyers and Prescott were cuts #2 to #4.
describe("the legs of a live trade of ours are held with the claim drops", () => {
  const NOW = 1_794_200_000_000; // 2026-11-08 ~22:53 ET, the offer an hour old
  const US = 3;
  const offer = (over: Record<string, unknown> = {}) => ({
    transaction_id: "1425359907405783040", type: "trade", status: "proposed", roster_ids: [1, US], consenter_ids: [US],
    adds: { "4983": US, "3294": 1, "5947": 1, "8134": 1 }, drops: { "4983": 1, "3294": US, "5947": US, "8134": US },
    created: NOW - 3_600_000, settings: { expires_at: Math.floor(NOW / 1000) + 3 * 86_400 - 3_600 }, leg: 9, ...over,
  });
  test("an offer we sent (we the lone consenter) holds every leg we give, by transaction", () => {
    const p = parsePendingClaims([offer()], US, NOW);
    expect(p.drops.sort()).toEqual(["3294", "5947", "8134"]);
    expect(p.tradeGives.map((g) => g.transactionId)).toEqual(["1425359907405783040", "1425359907405783040", "1425359907405783040"]);
    expect(p.tradeGives[0]).toEqual({ playerId: "3294", transactionId: "1425359907405783040", status: "proposed", leg: 9 });
    expect(p.adds).toEqual([]); // what we receive is theirs until it processes
    expect(p.claims).toEqual([]);
    expect(p.slotsNeeded).toBe(0);
  });
  test("an inbound offer we have not answered holds nothing", () => {
    const p = parsePendingClaims([offer({ consenter_ids: [1] })], US, NOW);
    expect(p.drops).toEqual([]);
    expect(p.tradeGives).toEqual([]);
  });
  test("a trade we accepted, in review (every roster consented, status pending), holds its legs", () => {
    const p = parsePendingClaims([offer({ status: "pending", consenter_ids: [1, US] })], US, NOW);
    expect(p.drops.sort()).toEqual(["3294", "5947", "8134"]);
    expect(p.tradeGives[0]!.status).toBe("pending");
  });
  test("a trade in review outlives the offer's expiry: held by status alone until it processes or dies", () => {
    const past = { expires_at: Math.floor(NOW / 1000) - 3_600 };
    expect(parsePendingClaims([offer({ status: "pending", consenter_ids: [1, US], settings: past })], US, NOW).drops.length).toBe(3);
    expect(parsePendingClaims([offer({ status: "pending", consenter_ids: [1, US], settings: null, created: NOW - 5 * 86_400_000 })], US, NOW).drops.length).toBe(3);
    expect(parsePendingClaims([offer({ status: "failed", consenter_ids: [1, US], settings: past })], US, NOW).drops).toEqual([]);
    expect(parsePendingClaims([offer({ status: "proposed", settings: past })], US, NOW).drops).toEqual([]);
  });
  test("a rejected or expired offer frees them the same read", () => {
    expect(parsePendingClaims([offer({ status: "rejected" })], US, NOW).drops).toEqual([]);
    expect(parsePendingClaims([offer({ settings: { expires_at: Math.floor(NOW / 1000) - 1 } })], US, NOW).drops).toEqual([]);
    // No expiry read back: dead three days after it was sent, the TTL we send.
    expect(parsePendingClaims([offer({ settings: null })], US, NOW).drops.length).toBe(3);
    expect(parsePendingClaims([offer({ settings: null, created: NOW - 3 * 86_400_000 - 1000 })], US, NOW).drops).toEqual([]);
  });
  test("a claim's drop and a trade's leg sit on one list; the rails refuse each with its reason", () => {
    const roster = [
      { name: "QB Guy", position: "QB", points: 300, playerId: "q" },
      { name: "Dak Prescott", position: "QB", points: 144, playerId: "3294" },
      { name: "Khalil Shakir", position: "WR", points: 93, playerId: "8134" },
      { name: "Claim Drop", position: "WR", points: 20, playerId: "B" },
      { name: "Other Bench", position: "WR", points: 30, playerId: "o" },
    ];
    const p = parsePendingClaims([offer(), { transaction_id: "c1", type: "waiver", roster_ids: [US], adds: { A: US }, drops: { B: US }, leg: 9 }], US, NOW);
    const rails = railsWithPendingDrops({ ...DEFAULT_WAIVERS.rails, protectTopN: 0 }, roster, p);
    expect(rails.neverDrop.sort()).toEqual(["Claim Drop", "Dak Prescott", "Khalil Shakir"]);
    const shakir = canDrop("Khalil Shakir", roster, rails);
    expect(shakir.allowed).toBe(false);
    expect(shakir.reason).toContain("1425359907405783040");
    const claim = canDrop("Claim Drop", roster, rails);
    expect(claim.allowed).toBe(false);
    expect(claim.reason).toContain("pending waiver claim");
    expect(canDrop("Other Bench", roster, rails).allowed).toBe(true);
  });
});
