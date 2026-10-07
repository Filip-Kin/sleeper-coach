import { describe, expect, test } from "bun:test";
import { decideIntent, DropIntentStore, MIN_AGE_MS, MAX_AGE_MS } from "./drop-intent.ts";

describe("two looks before an automatic drop", () => {
  test("first sight records, too soon waits, after the minimum age goes", () => {
    expect(decideIntent(null, 1000).action).toBe("record");
    const prev = { key: "k", firstSeen: 1000, note: "" };
    expect(decideIntent(prev, 1000 + MIN_AGE_MS - 1).action).toBe("wait");
    expect(decideIntent(prev, 1000 + MIN_AGE_MS).action).toBe("go");
  });
  test("a stale intent is forgotten and recorded afresh", () => {
    expect(decideIntent({ key: "k", firstSeen: 0, note: "" }, MAX_AGE_MS + 1).action).toBe("record");
  });
  test("a changed decision under the same prefix clears the old one", () => {
    const s = new DropIntentStore(`/tmp/sleeper-coach-test/intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    s.put({ key: "ir-activate:7569:drop:7543", firstSeen: 1000, note: "" });
    s.settle("ir-activate:7569:", "ir-activate:7569:drop:9508", 2000);
    expect(s.get("ir-activate:7569:drop:7543")).toBeNull();
  });
});

describe("a decision that keeps changing is counted", () => {
  test("settle returns how many times the prefix restarted inside the window", () => {
    const s = new DropIntentStore(`/tmp/sleeper-coach-test/intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    let n = s.settle("reconcile:", "reconcile:a", 1000); s.put({ key: "reconcile:a", firstSeen: 1000, note: "" });
    expect(n).toBe(0);
    n = s.settle("reconcile:", "reconcile:b", 2000); s.put({ key: "reconcile:b", firstSeen: 2000, note: "" });
    expect(n).toBe(1);
    n = s.settle("reconcile:", "reconcile:c", 3000);
    expect(n).toBe(2);
    expect(s.all().map((i) => i.key)).toEqual([]); // b was removed, c not put yet; bookkeeping rows hidden
  });
});

describe("a moot decision is forgotten, restart row included (2026-10-07)", () => {
  test("forget(prefix) removes every intent under the prefix and its bookkeeping, nothing else", () => {
    const s = new DropIntentStore(`/tmp/sleeper-coach-test/intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    s.settle("ir-activate:7021:", "ir-activate:7021:activate:12533", 1000);
    s.put({ key: "ir-activate:7021:activate:12533", firstSeen: 1000, note: "" });
    s.settle("ir-activate:7021:", "ir-activate:7021:activate:5012", 2000); // a restart row now exists
    s.put({ key: "ir-activate:7021:activate:5012", firstSeen: 2000, note: "" });
    s.put({ key: "reconcile:x", firstSeen: 2000, note: "" });
    s.forget("ir-activate:7021:");
    expect(s.all().map((i) => i.key)).toEqual(["reconcile:x"]);
    // The restart counter starts over: a later decision under the prefix is its first.
    expect(s.settle("ir-activate:7021:", "ir-activate:7021:activate:12533", 3000)).toBe(0);
  });
});
