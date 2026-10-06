// The executor half of a waiver claim (2026-10-02 review).
//
// The planner can answer "claim him, park Travis Etienne on IR, drop nobody".
// Until this file the claim block of waiver-run.ts filed that claim with no
// drop and never moved anyone: a claim into a full roster. It also skipped
// the two looks, because a move that names no drop was taken to cost nobody.
import { describe, expect, test } from "bun:test";
import { fileClaim, moveCost, type ClaimDeps } from "./claim-exec.ts";

const stashClaim = { add: "Star Receiver", drop: null, dropPath: "ir-stash" as const, irStash: "Travis Etienne" };
const dropClaim = { add: "Star Receiver", drop: "Josh Downs", dropPath: "drop" as const, irStash: null };
const slotClaim = { add: "Star Receiver", drop: null, dropPath: "bench-slot" as const, irStash: null };

function deps(over: Partial<ClaimDeps> = {}): { d: ClaimDeps; calls: string[] } {
  const calls: string[] = [];
  const d: ClaimDeps = {
    claimPending: () => false,
    stashReady: async () => { calls.push("ready?"); return true; },
    confirmed: (kind, add, cost) => { calls.push(`confirmed ${kind} ${add} ${cost}`); return true; },
    stash: async (name) => { calls.push(`stash ${name}`); return true; },
    submit: async (add, drop) => { calls.push(`submit ${add} ${drop}`); return { transactionId: "t1", status: "pending" }; },
    undoStash: async (name) => { calls.push(`undo ${name}`); },
    ...over,
  };
  return { d, calls };
}

describe("what a move costs the roster", () => {
  test("a drop costs the dropped player", () => expect(moveCost(dropClaim)).toBe("Josh Downs"));
  test("an IR stash costs the stashed player: he comes back and somebody makes room", () => expect(moveCost(stashClaim)).toBe("stash Travis Etienne"));
  test("an open slot costs nobody", () => expect(moveCost(slotClaim)).toBeNull());
  test("the open slot of a player on IR is a cost: an add into it takes two looks", () => expect(moveCost({ ...slotClaim, owedSlot: true })).toBe("the slot of a player on IR"));
});

describe("filing a claim", () => {
  test("a stash claim: the two looks on its cost, then the IR move, then the claim with no drop", async () => {
    const { d, calls } = deps();
    const r = await fileClaim(stashClaim, d);
    expect(r.status).toBe("filed");
    expect(calls).toEqual(["ready?", "confirmed claim Star Receiver stash Travis Etienne", "stash Travis Etienne", "submit Star Receiver null"]);
  });
  test("first look: nothing is moved and nothing is filed", async () => {
    const { d, calls } = deps({ confirmed: () => false });
    const r = await fileClaim(stashClaim, d);
    expect(r.status).toBe("waiting");
    expect(calls).toEqual(["ready?"]);
  });
  test("IR locked by a game, or a claim of ours already pending: held BEFORE the looks, so the recorded look is not used up", async () => {
    const { d, calls } = deps({ stashReady: async () => false });
    const r = await fileClaim(stashClaim, d);
    expect(r.status).toBe("held");
    expect(calls).toEqual([]);
  });
  test("Sleeper refuses the IR move: no claim into a full roster", async () => {
    const { d, calls } = deps({ stash: async (name) => { calls.push(`stash ${name}`); return false; } });
    const r = await fileClaim(stashClaim, d);
    expect(r.status).toBe("held");
    expect(calls.some((c) => c.startsWith("submit"))).toBe(false);
  });
  test("a stash path that names nobody is held, never filed", async () => {
    const { d, calls } = deps();
    const r = await fileClaim({ ...stashClaim, irStash: null }, d);
    expect(r.status).toBe("held");
    expect(calls).toEqual([]);
  });
  test("Sleeper refuses the claim after the IR move: he is put back, and the failure surfaces", async () => {
    const { d, calls } = deps({ submit: async () => { throw new Error("roster invalid"); } });
    await expect(fileClaim(stashClaim, d)).rejects.toThrow("roster invalid");
    expect(calls.at(-1)).toBe("undo Travis Etienne");
  });
  test("a claim of ours already pending: a drop claim is held before the looks, nothing recorded, nothing filed", async () => {
    // 2026-10-06 review. One claim per cycle was a per-run rule; Tuesday has
    // several claim runs and each names its own drop.
    const { d, calls } = deps({ claimPending: () => true });
    expect((await fileClaim(dropClaim, d)).status).toBe("held");
    expect((await fileClaim(stashClaim, d)).status).toBe("held");
    expect((await fileClaim(slotClaim, d)).status).toBe("held");
    expect(calls).toEqual([]);
  });
  test("a claim with a drop asks nothing about IR and moves nobody", async () => {
    const { d, calls } = deps();
    const r = await fileClaim(dropClaim, d);
    expect(r).toEqual({ status: "filed", transactionId: "t1", submitStatus: "pending" });
    expect(calls).toEqual(["confirmed claim Star Receiver Josh Downs", "submit Star Receiver Josh Downs"]);
  });
  test("a refused claim with a drop surfaces and undoes nothing", async () => {
    const { d, calls } = deps({ submit: async () => { throw new Error("roster invalid"); } });
    await expect(fileClaim(dropClaim, d)).rejects.toThrow("roster invalid");
    expect(calls.some((c) => c.startsWith("undo"))).toBe(false);
  });
});
