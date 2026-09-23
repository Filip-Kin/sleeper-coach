import { describe, expect, test } from "bun:test";
import { reactToDropsCore } from "./drop-react.ts";

// R8. A drop is marked reacted only once the claim run has exited 0. Marking
// first meant a crashed run (or a run skipped inside the cooldown) buried the
// drop forever.

const tx = (id: string) => ({ transaction_id: id, drops: { p: 2 } });

describe("reactToDropsCore", () => {
  test("a failed run leaves the drops unreacted", async () => {
    const marked: string[] = [];
    const r = await reactToDropsCore({
      txns: [tx("a")], alreadyReacted: () => false, markReacted: (id) => { marked.push(id); },
      now: 1_000_000_000, lastReaction: 0, frozen: false, run: async () => 1,
    });
    expect(r.ran).toBe(true);
    expect(marked).toEqual([]);
  });
  test("a successful run marks every fresh drop", async () => {
    const marked: string[] = [];
    await reactToDropsCore({
      txns: [tx("a"), tx("b")], alreadyReacted: () => false, markReacted: (id) => { marked.push(id); },
      now: 1_000_000_000, lastReaction: 0, frozen: false, run: async () => 0,
    });
    expect(marked.sort()).toEqual(["a", "b"]);
  });
  test("inside the cooldown nothing runs and nothing is marked", async () => {
    const marked: string[] = [];
    const r = await reactToDropsCore({
      txns: [tx("a")], alreadyReacted: () => false, markReacted: (id) => { marked.push(id); },
      now: 1_000_000, lastReaction: 900_000, frozen: false, run: async () => 0,
    });
    expect(r.ran).toBe(false);
    expect(marked).toEqual([]);
  });
  test("already reacted drops are ignored", async () => {
    const r = await reactToDropsCore({
      txns: [tx("a")], alreadyReacted: () => true, markReacted: () => {},
      now: 1_000_000_000, lastReaction: 0, frozen: false, run: async () => 0,
    });
    expect(r.ran).toBe(false);
  });
});
