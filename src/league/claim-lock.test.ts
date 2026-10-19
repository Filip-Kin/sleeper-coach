import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DB_PATH } from "../paths.ts";
import { lockClaim, claimLockedUntil, claimLocks, resetClaimLocksForTests, CLAIM_LOCKED_RE } from "./claim-lock.ts";

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
