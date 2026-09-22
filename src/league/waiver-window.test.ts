import { describe, expect, test } from "bun:test";
import { waiverWindowOpen, pendingClaimSlots, type Gql } from "./api.ts";

// 2026-09-22, NFL week 3, Tuesday. Our Reed and Downs claims from Saturday sat
// pending under leg 2. The slot hold read leg 3 only, saw nothing, and the
// free-agent job tried to spend both slots; Sleeper refused because every
// unrostered player was on waivers, the job exited 1, two alerts went out.
const L = "1389357604773322752";
function gqlWith(byLeg: Record<number, Record<string, unknown>[]>): { gql: Gql; legsAsked: number[] } {
  const legsAsked: number[] = [];
  const gql: Gql = async (q) => {
    const leg = Number(/leg:(\d+)/.exec(q)?.[1]);
    legsAsked.push(leg);
    return { data: { league_transactions_by_status: byLeg[leg] ?? [] } };
  };
  return { gql, legsAsked };
}

describe("pendingClaimSlots looks one leg back", () => {
  test("claims filed under leg 2 still hold slots when the NFL is in week 3", async () => {
    const { gql } = gqlWith({ 2: [
      { transaction_id: "a", type: "waiver", roster_ids: [3], adds: { "9500": 3 }, drops: null },
      { transaction_id: "b", type: "waiver", roster_ids: [3], adds: { "10222": 3 }, drops: null },
    ] });
    const r = await pendingClaimSlots(gql, 3, 3, L);
    expect(r.count).toBe(2);
    expect(r.adds.sort()).toEqual(["10222", "9500"]);
  });
  test("a claim with a drop attached needs no slot", async () => {
    const { gql } = gqlWith({ 3: [{ transaction_id: "c", type: "waiver", roster_ids: [3], adds: { "1": 3 }, drops: { "2": 3 } }] });
    expect((await pendingClaimSlots(gql, 3, 3, L)).count).toBe(0);
  });
  test("the same transaction seen under both legs counts once", async () => {
    const row = { transaction_id: "dup", type: "waiver", roster_ids: [3], adds: { "1": 3 }, drops: null };
    const { gql } = gqlWith({ 2: [row], 3: [row] });
    expect((await pendingClaimSlots(gql, 3, 3, L)).count).toBe(1);
  });
  test("other rosters' claims do not hold our slots", async () => {
    const { gql } = gqlWith({ 3: [{ transaction_id: "x", type: "waiver", roster_ids: [5], adds: { "1": 5 }, drops: null }] });
    expect((await pendingClaimSlots(gql, 3, 3, L)).count).toBe(0);
  });
});

describe("waiverWindowOpen", () => {
  test("anyone's pending claim under the previous leg means the window is open", async () => {
    const { gql, legsAsked } = gqlWith({ 2: [{ transaction_id: "x", type: "waiver", roster_ids: [5] }] });
    expect(await waiverWindowOpen(gql, 3, L)).toBe(true);
    expect(legsAsked).toContain(2);
  });
  test("no pending waivers anywhere means free agency is open", async () => {
    const { gql } = gqlWith({});
    expect(await waiverWindowOpen(gql, 3, L)).toBe(false);
  });
  test("a pending trade is not a waiver", async () => {
    const { gql } = gqlWith({ 3: [{ transaction_id: "t", type: "trade", roster_ids: [1, 2] }] });
    expect(await waiverWindowOpen(gql, 3, L)).toBe(false);
  });
});
