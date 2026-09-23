import { describe, expect, test } from "bun:test";
import { FailureLedger, classifyLineupRefusal } from "./failure-ledger.ts";

// R9. A lineup write that Sleeper refuses is retried with exponential backoff
// per distinct plan, capped at an hour, and alerted once per plan per day.
const MIN = 60_000;

describe("FailureLedger", () => {
  test("first failure alerts and backs off 15 minutes", () => {
    const l = new FailureLedger();
    const r = l.recordFailure("k", 0);
    expect(r.alert).toBe(true);
    expect(l.shouldAttempt("k", 10 * MIN)).toBe(false);
    expect(l.shouldAttempt("k", 16 * MIN)).toBe(true);
  });
  test("second identical failure backs off longer and does not alert", () => {
    const l = new FailureLedger();
    l.recordFailure("k", 0);
    const r = l.recordFailure("k", 16 * MIN);
    expect(r.alert).toBe(false);
    expect(l.shouldAttempt("k", 16 * MIN + 29 * MIN)).toBe(false);
    expect(l.shouldAttempt("k", 16 * MIN + 31 * MIN)).toBe(true);
  });
  test("backoff caps at an hour", () => {
    const l = new FailureLedger();
    let t = 0;
    for (let i = 0; i < 6; i++) { l.recordFailure("k", t); t += 24 * 60 * MIN; }
    const r = l.recordFailure("k", t);
    expect(r.retryInMs).toBe(60 * MIN);
  });
  test("a different key alerts on its own", () => {
    const l = new FailureLedger();
    l.recordFailure("k", 0);
    expect(l.recordFailure("j", 0).alert).toBe(true);
  });
  test("the same key alerts again the next day", () => {
    const l = new FailureLedger();
    l.recordFailure("k", 0);
    expect(l.recordFailure("k", 25 * 60 * MIN).alert).toBe(true);
  });
  test("success clears the key", () => {
    const l = new FailureLedger();
    l.recordFailure("k", 0);
    l.clear("k");
    expect(l.shouldAttempt("k", 1)).toBe(true);
  });
});

describe("classifyLineupRefusal", () => {
  test("a stale reserve player", () => {
    expect(classifyLineupRefusal("graphql roster_update_starters: invalid Nico Collins is no longer IR eligible").kind).toBe("reserve-ineligible");
  });
  test("a locked player, with his id when the message carries one", () => {
    const c = classifyLineupRefusal("player 7569 is locked and cannot be moved");
    expect(c).toEqual({ kind: "locked", playerId: "7569" });
  });
  test("a locked message without an id", () => {
    const c = classifyLineupRefusal("Cannot change a locked player");
    expect(c).toEqual({ kind: "locked", playerId: null });
  });
  test("anything else", () => {
    expect(classifyLineupRefusal("HTTP 500").kind).toBe("other");
  });
});
