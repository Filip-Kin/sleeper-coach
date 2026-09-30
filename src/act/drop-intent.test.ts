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
