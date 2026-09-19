import { describe, expect, test } from "bun:test";
import { overCapBy, activeCapacity } from "./roster-fit.ts";

// 2026-09-19. Moving Nico Collins to IR took Sleeper's `players` array to 17
// against a 16-man cap. reconcileRoster passed that raw length here, read "over
// by 1", and dropped the cheapest body every 90 seconds: Jayden Reed, then
// Collins straight off IR, then Josh Downs. The cap never counted reserve; the
// caller did. These pin the arithmetic that let it happen.
const SIXTEEN = Array(16).fill("BN");

describe("roster cap excludes injured reserve", () => {
  const cap = activeCapacity(SIXTEEN);

  test("a full active roster is not over cap", () => {
    expect(overCapBy(16, cap)).toBe(0);
  });

  test("17 entries with one on IR is 16 active, which is legal", () => {
    const players = Array.from({ length: 17 }, (_, i) => `p${i}`);
    const reserve = new Set(["p16"]);
    const active = players.filter((p) => !reserve.has(p));
    expect(active.length).toBe(16);
    expect(overCapBy(active.length, cap)).toBe(0);
  });

  test("counting the IR player is what produced the phantom over-cap", () => {
    expect(overCapBy(17, cap)).toBe(1); // the bug, preserved as the thing not to do
  });

  test("two on IR still leaves a legal roster at 18 entries", () => {
    const players = Array.from({ length: 18 }, (_, i) => `p${i}`);
    const reserve = new Set(["p16", "p17"]);
    expect(overCapBy(players.filter((p) => !reserve.has(p)).length, cap)).toBe(0);
  });

  test("a genuinely over-cap active roster is still caught", () => {
    const players = Array.from({ length: 18 }, (_, i) => `p${i}`);
    const reserve = new Set(["p17"]);
    expect(overCapBy(players.filter((p) => !reserve.has(p)).length, cap)).toBe(1);
  });
});
