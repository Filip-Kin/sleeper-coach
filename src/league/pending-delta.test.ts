import { test, expect } from "bun:test";
import { applyRosterDelta, pendingRosterDelta } from "./api.ts";

test("applyRosterDelta adds incoming and removes outgoing", () => {
  const players = ["a", "b", "c"];
  expect(applyRosterDelta(players, { incoming: ["d"], outgoing: ["b"] }).sort()).toEqual(["a", "c", "d"]);
});

test("applyRosterDelta is a no-op with an empty delta", () => {
  expect(applyRosterDelta(["a", "b"], { incoming: [], outgoing: [] }).sort()).toEqual(["a", "b"]);
});

test("applyRosterDelta does not duplicate an incoming player already present", () => {
  expect(applyRosterDelta(["a", "b"], { incoming: ["a"], outgoing: [] }).sort()).toEqual(["a", "b"]);
});

// pendingRosterDelta against a mocked gql: only trades WE consented to count,
// and only their adds/drops for OUR roster.
function gqlWith(trades: unknown[]) {
  return async (q: string) => {
    if (q.includes('status:"proposed"')) return { data: { league_transactions_by_status: trades } };
    return { data: { league_transactions_by_status: [] } };
  };
}

test("a trade we consented to contributes incoming and outgoing for our roster", async () => {
  const gql = gqlWith([{
    transaction_id: "1", type: "trade", roster_ids: [3, 2], consenter_ids: [3, 2],
    adds: { "100": 3, "200": 2 }, drops: { "100": 2, "200": 3 },
  }]);
  const d = await pendingRosterDelta(gql as never, 1, 3);
  expect(d.incoming).toEqual(["100"]);
  expect(d.outgoing).toEqual(["200"]);
});

test("a proposal we have NOT consented to is ignored", async () => {
  const gql = gqlWith([{
    transaction_id: "1", type: "trade", roster_ids: [3, 2], consenter_ids: [2], // only them
    adds: { "100": 3 }, drops: { "100": 2 },
  }]);
  const d = await pendingRosterDelta(gql as never, 1, 3);
  expect(d.incoming).toEqual([]);
  expect(d.outgoing).toEqual([]);
});

test("a non-trade transaction is ignored", async () => {
  const gql = gqlWith([{
    transaction_id: "1", type: "free_agent", roster_ids: [3], consenter_ids: [3],
    adds: { "100": 3 }, drops: {},
  }]);
  const d = await pendingRosterDelta(gql as never, 1, 3);
  expect(d.incoming).toEqual([]);
});

test("a gql failure yields an empty delta, never throws", async () => {
  const gql = async () => { throw new Error("down"); };
  const d = await pendingRosterDelta(gql as never, 1, 3);
  expect(d).toEqual({ incoming: [], outgoing: [] });
});
