import { describe, expect, test } from "bun:test";
import { decideIntent, intentsToConfirm, DropIntentStore, MIN_AGE_MS, MAX_AGE_MS } from "./drop-intent.ts";

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

describe("the confirming run's throttle holds a failing write, never a new decision", () => {
  const THROTTLE = 20 * 60_000;
  const MIN = 60_000;
  test("an intent past its age with no recent confirm goes", () => {
    const i = { key: "waiver:add:X:Y", firstSeen: 0, note: "" };
    expect(intentsToConfirm([i], MIN_AGE_MS, 0 - 3 * 3_600_000, THROTTLE)).toEqual([i]);
    expect(intentsToConfirm([i], MIN_AGE_MS - 1, 0 - 3 * 3_600_000, THROTTLE)).toEqual([]);
  });
  test("an intent already due at the last confirm is held for the throttle", () => {
    // Due at 30; a confirm ran at 31 and could not write it; at 40 it waits.
    const i = { key: "waiver:claim:X:Y", firstSeen: 0, note: "" };
    expect(intentsToConfirm([i], 40 * MIN, 31 * MIN, THROTTLE)).toEqual([]);
    expect(intentsToConfirm([i], 52 * MIN, 31 * MIN, THROTTLE)).toEqual([i]);
  });
  test("the Sunday case: a free add recorded at 11:40 is not held by a claim confirmed at 11:50", () => {
    // Recorded at 11:40 (first look 12:15 at the latest), due 12:10; a
    // rival's drop had a claim confirmed at 11:50. Under a plain throttle the
    // add would wait until 12:10 + 20 = 12:30 or later, past a 13:00 kickoff
    // once the slot is nearer 12:15. It became due after the last confirm, so
    // it goes at 12:10, and the claim that was due then goes with it.
    const T = Date.UTC(2026, 9, 11, 15, 40, 0); // 11:40 ET
    const add = { key: "waiver:add:Loveland:Andrews", firstSeen: T, note: "" };
    const claim = { key: "waiver:claim:A:B", firstSeen: T - 40 * MIN, note: "" };
    const lastConfirm = T + 10 * MIN; // 11:50
    expect(intentsToConfirm([add, claim], T + 29 * MIN, lastConfirm, THROTTLE)).toEqual([]);
    expect(intentsToConfirm([add, claim], T + 30 * MIN, lastConfirm, THROTTLE)).toEqual([add, claim]);
  });
  test("a lastConfirm far in the past never holds a due intent", () => {
    // The daemon's two-hour backoff after three failures is its own hold
    // (daemon.ts waiverConfirmHoldUntil), checked before this is asked, so a
    // future lastConfirm is never passed here; this only pins the plain path.
    const now = 100 * MIN;
    const old = { key: "waiver:add:X:Y", firstSeen: 0, note: "" };
    const fresh = { key: "waiver:add:P:Q", firstSeen: now - MIN_AGE_MS, note: "" };
    expect(intentsToConfirm([old, fresh], now, 0, THROTTLE)).toEqual([old, fresh]);
  });
});

describe("a breaker cooldown is a hold, not a changed decision (2026-10-16 Strange)", () => {
  // Replay, ET: 12:23:06 the confirming run streamed Fairbairn for Bates and
  // re-recorded "add Strange costing Loveland"; 12:53:40 the next confirm said
  // go, deleted the record, and the breaker refused the drop (Bates cut 31
  // min ago) until 13:23:06. Nothing was re-recorded, so the confirm loop
  // never ran an adds-capable job again; roster 6 added Strange at 15:54.
  const KEY = "waiver:add:Brenton Strange:Colston Loveland";
  const FIRST = 1792167786469; // 2026-10-16T16:23:06.469Z
  const GO = 1792169620661; // 2026-10-16T16:53:40.661Z
  const RETRY = 1792171386569; // 2026-10-16T17:23:06.569Z
  const THROTTLE = 20 * 60_000;
  const store = () => new DropIntentStore(`/tmp/sleeper-coach-test/intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const taken = { key: KEY, firstSeen: FIRST, note: "add Brenton Strange costing Colston Loveland" };

  test("defer puts the record back with its first look and the retry instant", () => {
    const s = store();
    s.put(taken);
    expect(decideIntent(s.get(KEY), GO).action).toBe("go");
    s.delete(KEY); // the confirming run took it
    s.defer(taken, RETRY);
    expect(s.get(KEY)).toEqual({ ...taken, retryAt: RETRY });
    // settle under the same decision keeps it, retryAt and all
    s.settle("waiver:add:Brenton Strange:", KEY, GO + 60_000);
    expect(s.get(KEY)?.retryAt).toBe(RETRY);
    // a landed move clears it like any other record
    s.settle("waiver:", "", GO + 60_000);
    expect(s.get(KEY)).toBeNull();
  });
  test("a deferred intent waits for the retry instant, then goes with no third look", () => {
    const d = { ...taken, retryAt: RETRY };
    expect(decideIntent(d, GO + 1000)).toEqual({ action: "wait", readyAt: RETRY });
    expect(decideIntent(d, RETRY - 1)).toEqual({ action: "wait", readyAt: RETRY });
    expect(decideIntent(d, RETRY)).toEqual({ action: "go", firstSeen: FIRST });
    // past the maximum age it is forgotten like any record
    expect(decideIntent(d, FIRST + MAX_AGE_MS + 1).action).toBe("record");
  });
  test("the confirm loop takes it at the retry instant, even after a claim confirmed in between", () => {
    const d = { ...taken, retryAt: RETRY };
    expect(intentsToConfirm([d], RETRY - 60_000, GO, THROTTLE)).toEqual([]);
    expect(intentsToConfirm([d], RETRY + 90_000, GO, THROTTLE)).toEqual([d]);
    // A claim confirmed at 13:10 (lastConfirm inside the throttle): the add
    // came due after it, at 13:23, so it goes at once.
    const claimConfirm = RETRY - 13 * 60_000;
    expect(intentsToConfirm([d], RETRY + 90_000, claimConfirm, THROTTLE)).toEqual([d]);
    // The daemon derives the job's flag from the key: an add alone is adds-only.
    expect(d.key.split(":")[1]).toBe("add");
  });
  test("a retry instant earlier than the second look changes nothing", () => {
    const early = { key: "reconcile:a", firstSeen: 0, note: "", retryAt: MIN_AGE_MS - 1 };
    expect(decideIntent(early, MIN_AGE_MS - 1).action).toBe("wait");
    expect(decideIntent(early, MIN_AGE_MS).action).toBe("go");
  });
});
