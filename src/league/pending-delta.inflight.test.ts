import { describe, expect, test } from "bun:test";
import { tradeInFlight, pendingRosterDelta, type Gql } from "./api.ts";

// 2026-09-23. Our outgoing offer to Cloud Nine (rosters [1,3], consenters [3])
// was applied to our roster as though it had happened. The brief then listed
// Harold Fannin as ours and the DM bot argued the trade with the sides
// reversed. A proposal carries only the proposer's consent.
const L = "1389357604773322752";
const tx = (roster_ids: number[], consenter_ids: number[], adds: Record<string, number>, drops: Record<string, number>) =>
  ({ transaction_id: `${roster_ids.join("")}${consenter_ids.join("")}`, status: "proposed", type: "trade", roster_ids, consenter_ids, adds, drops });
const gqlWith = (rows: Record<string, unknown>[]): Gql => async () => ({ data: { league_transactions_by_status: rows } });

describe("tradeInFlight", () => {
  test("our own unanswered proposal is not in flight", () => {
    expect(tradeInFlight({ roster_ids: [1, 3], consenter_ids: [3] })).toBe(false);
  });
  test("a rival's unanswered proposal to us is not in flight", () => {
    expect(tradeInFlight({ roster_ids: [1, 3], consenter_ids: [1] })).toBe(false);
  });
  test("both sides consented is in flight", () => {
    expect(tradeInFlight({ roster_ids: [1, 3], consenter_ids: [3, 1] })).toBe(true);
  });
  test("a three-way trade needs all three", () => {
    expect(tradeInFlight({ roster_ids: [1, 3, 5], consenter_ids: [1, 3] })).toBe(false);
    expect(tradeInFlight({ roster_ids: [1, 3, 5], consenter_ids: [5, 1, 3] })).toBe(true);
  });
  test("no rosters is never in flight", () => {
    expect(tradeInFlight({ roster_ids: [], consenter_ids: [] })).toBe(false);
  });
});

describe("pendingRosterDelta applies only fully-consented trades", () => {
  const ours = tx([1, 3], [3], { "7564": 3, "12506": 3, "3294": 1 }, { "7564": 1, "12506": 1, "3294": 3 });
  test("the Cloud Nine offer changes nothing about what we hold", async () => {
    const d = await pendingRosterDelta(gqlWith([ours]), 3, 3, L);
    expect(d.incoming).toEqual([]);
    expect(d.outgoing).toEqual([]);
  });
  test("once Cookie accepts, the same trade is applied", async () => {
    const accepted = { ...ours, consenter_ids: [3, 1] };
    const d = await pendingRosterDelta(gqlWith([accepted]), 3, 3, L);
    expect(d.incoming.sort()).toEqual(["12506", "7564"]);
    expect(d.outgoing).toEqual(["3294"]);
  });
  test("a rival's bare offer to us is ignored", async () => {
    const theirs = tx([1, 3], [1], { "1": 3 }, { "1": 1 });
    const d = await pendingRosterDelta(gqlWith([theirs]), 3, 3, L);
    expect(d.incoming).toEqual([]);
  });
});
