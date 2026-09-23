import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { dropPlayers, addFreeAgent, submitWaiverClaim, acceptTrade, pendingTrades, completedTrades, type Gql } from "./api.ts";
import { DropRefused, dropHistory, resetLedgerForTests } from "./drop-ledger.ts";
import { DB_PATH, FREEZE_FILE } from "../paths.ts";
import { existsSync } from "node:fs";
import { recentEvents } from "../log.ts";

// The rails live INSIDE the write, so every caller gets them: the daemon, a
// scheduled job, the CLI, and a one-off script. 2026-09-23: a script dropped a
// real player with no event and no breaker consultation.
const L = "1399830848848592896";
const ok = (field: string): Gql => async () => ({ data: { [field]: { transaction_id: "t1", status: "complete" } } });
const recorder = (rows: Record<string, unknown>[]) => { const asked: string[] = []; const gql: Gql = async (q) => { asked.push(q); return { data: { league_transactions_by_status: rows } }; }; return { gql, asked }; };

beforeEach(() => { resetLedgerForTests(); for (const f of [DB_PATH, FREEZE_FILE]) { try { rmSync(f); } catch { /* fresh */ } } });

describe("drop chokepoint", () => {
  test("dropPlayers records the drop and logs an event", async () => {
    await dropPlayers(ok("league_create_transaction"), ["7021"], 1, L, "test");
    expect(dropHistory().map((d) => d.name)).toEqual(["7021"]);
    expect(recentEvents(5).some((e) => e.type === "write-drop")).toBe(true);
  });
  test("a second drop inside the cooldown is refused with DropRefused, before any request", async () => {
    await dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "test");
    let sent = 0; const gql: Gql = async () => { sent++; return { data: {} }; };
    await expect(dropPlayers(gql, ["2"], 1, L, "test")).rejects.toBeInstanceOf(DropRefused);
    expect(sent).toBe(0);
    expect(recentEvents(5).some((e) => e.type === "drop-blocked")).toBe(true);
    // A cascade freezes the coach at the chokepoint itself.
    await Bun.sleep(20);
    expect(existsSync(FREEZE_FILE)).toBe(true);
  });
  test("a free add with a drop and a claim with a drop are counted", async () => {
    await addFreeAgent(ok("league_create_transaction"), "10", "11", 1, L);
    await expect(submitWaiverClaim(ok("submit_waiver_claim"), "12", "13", 1, L)).rejects.toBeInstanceOf(DropRefused);
  });
  test("a free add with NO drop is never blocked by the breaker", async () => {
    await dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "test");
    await expect(addFreeAgent(ok("league_create_transaction"), "10", null, 1, L)).resolves.toBeTruthy();
  });
  test("accepting a trade counts what we give", async () => {
    await acceptTrade(ok("accept_trade"), "100", 3, ["5012", "3294"], L);
    expect(dropHistory().map((d) => d.name).sort()).toEqual(["3294", "5012"]);
    await expect(acceptTrade(ok("accept_trade"), "101", 3, ["1"], L)).rejects.toBeInstanceOf(DropRefused);
  });
});

describe("transaction reads look one leg back", () => {
  test("pendingTrades sees an offer filed under the previous leg, once", async () => {
    const row = { transaction_id: "a", status: "proposed", type: "trade", roster_ids: [1, 3], consenter_ids: [1], adds: {}, drops: {}, created: 1 };
    const { gql, asked } = recorder([row]);
    const out = await pendingTrades(gql, 3, L);
    expect(out.length).toBe(1);
    expect(asked.some((q) => q.includes("leg:2"))).toBe(true);
  });
  test("completedTrades dedupes across legs", async () => {
    const row = { transaction_id: "c", status: "complete", type: "trade", roster_ids: [1, 3], consenter_ids: [1, 3], adds: {}, drops: {}, created: 1 };
    const { gql } = recorder([row]);
    expect((await completedTrades(gql, 3, L)).length).toBe(1);
  });
});
