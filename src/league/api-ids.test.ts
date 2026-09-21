import { describe, expect, test } from "bun:test";
import { addFreeAgent, submitWaiverClaim, dropPlayers, updateReserve, type Gql } from "./api.ts";

// A defense's player id is its team code. Every write helper used to run the
// numeric-only safeId on it and throw "unsafe id: SEA" before sending anything,
// which would have failed the week-11 DEF stream after it was correctly planned.
function recorder(reply: Record<string, unknown>): { gql: Gql; sent: string[] } {
  const sent: string[] = [];
  const gql: Gql = async (q) => { sent.push(q); return { data: reply }; };
  return { gql, sent };
}

describe("write helpers accept a team-code player id", () => {
  test("addFreeAgent sends SEA", async () => {
    const { gql, sent } = recorder({ league_create_transaction: { transaction_id: "1", status: "complete" } });
    await addFreeAgent(gql, "SEA", null, 3, "1389357604773322752");
    expect(sent[0]).toContain('k_adds:["SEA"]');
  });
  test("submitWaiverClaim sends KC and drops a numeric id", async () => {
    const { gql, sent } = recorder({ submit_waiver_claim: { transaction_id: "2", status: "pending" } });
    await submitWaiverClaim(gql, "KC", "7021", 3, "1389357604773322752");
    expect(sent[0]).toContain('k_adds:["KC"]');
    expect(sent[0]).toContain('k_drops:["7021"]');
  });
  test("dropPlayers accepts a defense", async () => {
    const { gql, sent } = recorder({ league_create_transaction: { transaction_id: "3", status: "complete" } });
    await dropPlayers(gql, ["SEA"], 3, "1389357604773322752");
    expect(sent[0]).toContain('k_drops:["SEA"]');
  });
  test("updateReserve accepts a defense id", async () => {
    const { gql } = recorder({ roster_update_reserve: { roster_id: 3, reserve: ["SEA"] } });
    await expect(updateReserve(gql, ["SEA"], 3, "1389357604773322752")).resolves.toEqual(["SEA"]);
  });
});

describe("injection-shaped ids are still refused before any request", () => {
  for (const bad of ['SEA"]}', "sea", "S", "TOOLONG", "12a", '1"){x}']) {
    test(`rejects ${JSON.stringify(bad)}`, async () => {
      const { gql, sent } = recorder({});
      await expect(addFreeAgent(gql, bad, null, 3, "1389357604773322752")).rejects.toThrow(/unsafe player id/);
      expect(sent.length).toBe(0);
    });
  }
  test("a league id is still numeric-only", async () => {
    const { gql, sent } = recorder({});
    await expect(addFreeAgent(gql, "SEA", null, 3, "SEA")).rejects.toThrow(/unsafe id/);
    expect(sent.length).toBe(0);
  });
});
