import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { dropPlayers, addFreeAgent, submitWaiverClaim, acceptTrade, updateStarters, updateReserve, pendingTrades, completedTrades, type Gql } from "./api.ts";
import { DropRefused, dropHistory, resetLedgerForTests } from "./drop-ledger.ts";
import { DAILY_LIMIT } from "../analysis/drop-guard.ts";
import { DB_PATH, FREEZE_FILE, DROP_FREEZE_FILE } from "../paths.ts";
import { recentEvents } from "../log.ts";

// The rails live INSIDE the write, so every caller gets them: the daemon, a
// scheduled job, the CLI, and a one-off script. 2026-09-23: a script dropped a
// real player with no event and no breaker consultation.
const L = "1399830848848592896";
const ok = (field: string): Gql => async () => ({ data: { [field]: { transaction_id: "t1", status: "complete" } } });
const recorder = (rows: Record<string, unknown>[]) => { const asked: string[] = []; const gql: Gql = async (q) => { asked.push(q); return { data: { league_transactions_by_status: rows } }; }; return { gql, asked }; };
/** A Sleeper whose roster array and matchup leg follow every write, so the
 *  read-back inside updateStarters passes. */
const lineupSleeper = (): Gql => {
  let leg: string[] = [];
  return async (q) => {
    const ids = (q.match(/starters:\[([^\]]*)\]/)?.[1] ?? "").split(",").map((x) => x.replace(/"/g, "")).filter(Boolean);
    if (q.includes("roster_update_starters")) { leg = ids; return { data: { roster_update_starters: { roster_id: 1, starters: ids } } }; }
    if (q.includes("update_matchup_leg")) { leg = ids; return { data: { update_matchup_leg: { roster_id: 1, starters: ids } } }; }
    if (q.includes("matchup_legs")) return { data: { matchup_legs: [{ leg: 3, roster_id: 1, starters: leg }] } };
    if (q.includes("roster_update_reserve")) return { data: { roster_update_reserve: { roster_id: 1, reserve: ["9"] } } };
    return { data: {} };
  };
};

beforeEach(() => { resetLedgerForTests(); for (const f of [DB_PATH, FREEZE_FILE, DROP_FREEZE_FILE]) { try { rmSync(f); } catch { /* fresh */ } } });

describe("drop chokepoint", () => {
  test("dropPlayers records the drop and logs an event", async () => {
    await dropPlayers(ok("league_create_transaction"), ["7021"], 1, L, "reconcile");
    expect(dropHistory().map((d) => [d.name, d.via])).toEqual([["7021", "reconcile"]]);
    expect(recentEvents(5).some((e) => e.type === "write-drop")).toBe(true);
  });
  test("a second drop inside the cooldown is DEFERRED: DropRefused, no request, no freeze of any kind", async () => {
    await dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "reconcile");
    let sent = 0; const gql: Gql = async () => { sent++; return { data: {} }; };
    await expect(dropPlayers(gql, ["2"], 1, L, "ir-activate")).rejects.toBeInstanceOf(DropRefused);
    expect(sent).toBe(0);
    expect(recentEvents(5).some((e) => e.type === "drop-deferred")).toBe(true);
    expect(recentEvents(5).some((e) => e.type === "drop-blocked")).toBe(false);
    await Bun.sleep(20);
    expect(existsSync(FREEZE_FILE)).toBe(false);
    expect(existsSync(DROP_FREEZE_FILE)).toBe(false);
  });
  test("over the daily limit writes DROP_FREEZE, never FREEZE, and logs drop-freeze", async () => {
    const day = 24 * 3_600_000, hour = 3_600_000;
    const { recordDrop } = await import("./drop-ledger.ts");
    for (let i = 0; i < DAILY_LIMIT; i++) recordDrop(`P${i}`, "reconcile", Date.now() - day + (i + 1) * 2 * hour);
    await expect(dropPlayers(ok("league_create_transaction"), ["99"], 1, L, "reconcile")).rejects.toBeInstanceOf(DropRefused);
    await Bun.sleep(20);
    expect(existsSync(DROP_FREEZE_FILE)).toBe(true);
    expect(existsSync(FREEZE_FILE)).toBe(false);
    expect(recentEvents(5).some((e) => e.type === "drop-freeze")).toBe(true);
    expect(recentEvents(5).some((e) => e.type === "drop-blocked")).toBe(true);
  });
  test("DROP_FREEZE refuses every drop path before any request, and a free add with no drop still goes", async () => {
    writeFileSync(DROP_FREEZE_FILE, "test\n");
    let sent = 0; const gql: Gql = async () => { sent++; return { data: {} }; };
    await expect(dropPlayers(gql, ["1"], 1, L, "reconcile")).rejects.toBeInstanceOf(DropRefused);
    await expect(dropPlayers(gql, ["1"], 1, L, "reconcile")).rejects.toThrow(/drops frozen by the circuit breaker/);
    await expect(addFreeAgent(gql, "10", "11", 1, L)).rejects.toBeInstanceOf(DropRefused);
    await expect(submitWaiverClaim(gql, "12", "13", 1, L)).rejects.toBeInstanceOf(DropRefused);
    await expect(acceptTrade(gql, "100", 3, ["5"], L)).rejects.toBeInstanceOf(DropRefused);
    expect(sent).toBe(0);
    await expect(addFreeAgent(ok("league_create_transaction"), "10", null, 1, L)).resolves.toBeTruthy();
  });
  test("DROP_FREEZE does not stop a lineup write or a reserve write", async () => {
    writeFileSync(DROP_FREEZE_FILE, "test\n");
    const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "SEA"];
    await expect(updateStarters(lineupSleeper(), ids, 1, L, 3)).resolves.toEqual(ids);
    await expect(updateReserve(lineupSleeper(), ["9"], 1, L)).resolves.toBeTruthy();
  });
  test("the human FREEZE still stops a lineup write and a drop", async () => {
    writeFileSync(FREEZE_FILE, "frozen by Filip\n");
    const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "SEA"];
    await expect(updateStarters(lineupSleeper(), ids, 1, L, 3)).rejects.toThrow(/writes are FROZEN/);
    await expect(dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "reconcile")).rejects.toThrow(/writes are FROZEN/);
  });
  test("a free add with a drop counts; a filed claim is recorded but is not budget", async () => {
    await addFreeAgent(ok("league_create_transaction"), "10", "11", 1, L);
    // The claim is not refused by the cooldown (it is history-only)...
    await expect(submitWaiverClaim(ok("submit_waiver_claim"), "12", "13", 1, L)).resolves.toBeTruthy();
    expect(dropHistory().map((d) => [d.name, d.via]).sort()).toEqual([["11", "free-add"], ["13", "claim"]]);
    // ...and the free add still occupies the cooldown for the next automatic drop.
    await expect(dropPlayers(ok("league_create_transaction"), ["14"], 1, L, "reconcile")).rejects.toBeInstanceOf(DropRefused);
  });
  test("a free add with NO drop is never blocked by the breaker", async () => {
    await dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "reconcile");
    await expect(addFreeAgent(ok("league_create_transaction"), "10", null, 1, L)).resolves.toBeTruthy();
  });
  test("accepting a trade records what we give and never trips the breaker", async () => {
    await acceptTrade(ok("accept_trade"), "100", 3, ["5012", "3294"], L);
    expect(dropHistory().map((d) => d.name).sort()).toEqual(["3294", "5012"]);
    await expect(acceptTrade(ok("accept_trade"), "101", 3, ["1"], L)).resolves.toBeTruthy();
    // Three trade gives in a minute and the next automatic drop is still allowed.
    await expect(dropPlayers(ok("league_create_transaction"), ["2"], 1, L, "reconcile")).resolves.toBeTruthy();
  });
  test("a manual drop is recorded and is not budget", async () => {
    await dropPlayers(ok("league_create_transaction"), ["1"], 1, L, "manual");
    expect(dropHistory()[0]?.via).toBe("manual");
    await expect(dropPlayers(ok("league_create_transaction"), ["2"], 1, L, "reconcile")).resolves.toBeTruthy();
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
