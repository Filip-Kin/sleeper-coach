import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DB_PATH } from "../paths.ts";
import { lockClaim, claimLockedUntil, claimLocks, resetClaimLocksForTests, CLAIM_LOCKED_RE, noteCancelRefused, cancelRefusals, cancelRefusedFor, CANCEL_REFUSED_FOR_MS } from "./claim-lock.ts";

beforeEach(() => { resetClaimLocksForTests(); try { rmSync(DB_PATH); } catch { /* fresh */ } });

describe("a claim Sleeper refused as past its time locks the man until the clear", () => {
  const FRI = Date.UTC(2026, 9, 16, 18, 2); // 2026-10-16 14:02 ET, the first Reichard refusal
  const CLEAR = Date.UTC(2026, 9, 21, 7); // Wed 10-21 03:00 ET
  test("the message Sleeper sent is the one matched", () => {
    expect(CLAIM_LOCKED_RE.test("graphql submit_waiver_claim:  The time to claim this player has passed.  Please wait for waivers to clear in a few minutes.")).toBe(true);
    expect(CLAIM_LOCKED_RE.test("At least one of the players being added in is on waivers.")).toBe(false);
  });
  test("locked until the instant given, free after it", () => {
    lockClaim("11792", CLEAR, "time to claim has passed", FRI);
    expect(claimLockedUntil("11792", FRI)).toBe(CLEAR);
    expect(claimLockedUntil("11792", Date.UTC(2026, 9, 18, 16, 26))).toBe(CLEAR); // Sunday, the sixth refusal
    expect(claimLockedUntil("11792", CLEAR)).toBeNull();
    expect(claimLockedUntil("4227", FRI)).toBeNull();
    expect(claimLocks(FRI).map((l) => l.playerId)).toEqual(["11792"]);
    expect(claimLocks(CLEAR + 1)).toEqual([]);
  });
  test("a second refusal replaces the lock", () => {
    lockClaim("11792", CLEAR, "first", FRI);
    lockClaim("11792", CLEAR + 7 * 86_400_000, "second", CLEAR + 60_000);
    expect(claimLockedUntil("11792", CLEAR + 120_000)).toBe(CLEAR + 7 * 86_400_000);
  });
});

describe("a cancel Sleeper refused as past its time is a known seatless claim for an hour (2026-11-18)", () => {
  const MSG = "graphql cancel_waiver_claim:  The time to claim this player has passed.  Please wait for waivers to clear in a few minutes.";
  const AT = Date.UTC(2026, 10, 18, 8, 7, 1); // Wed 03:07:01 ET, the reconciler's cancel of the Gesicki claim
  test("nothing recorded reads as none", () => {
    expect(cancelRefusals(AT)).toEqual([]);
  });
  test("recorded with its adds until an hour on", () => {
    expect(noteCancelRefused("1428119853583077376", ["4993"], MSG, AT)).toBe(true);
    expect(cancelRefusals(AT + 99_000)).toEqual([{ transactionId: "1428119853583077376", adds: ["4993"], until: AT + CANCEL_REFUSED_FOR_MS, reason: MSG, at: AT }]);
    expect(cancelRefusals(AT + CANCEL_REFUSED_FOR_MS)).toEqual([]);
  });
  test("the hand tool's second refusal at 03:11 does not extend the hour", () => {
    noteCancelRefused("1428119853583077376", ["4993"], MSG, AT);
    expect(noteCancelRefused("1428119853583077376", ["4993"], MSG, AT + 239_000)).toBe(true);
    expect(cancelRefusals(AT + 240_000)[0]!.until).toBe(AT + CANCEL_REFUSED_FOR_MS);
  });
  test("the refusal is remembered for the claim's result after the hour has run out", () => {
    expect(cancelRefusedFor("1428119853583077376")).toBe(false);
    noteCancelRefused("1428119853583077376", ["4993"], MSG, AT);
    expect(cancelRefusals(AT + 2 * CANCEL_REFUSED_FOR_MS)).toEqual([]);
    expect(cancelRefusedFor("1428119853583077376")).toBe(true);
    expect(cancelRefusedFor("1428127663901401088")).toBe(false);
  });
  test("any other failure is not recorded: that claim stays a fault", () => {
    expect(noteCancelRefused("1428119853583077376", ["4993"], "graphql cancel_waiver_claim: fetch failed", AT)).toBe(false);
    expect(cancelRefusals(AT + 1)).toEqual([]);
  });
});
