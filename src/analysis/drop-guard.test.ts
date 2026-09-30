import { describe, expect, test } from "bun:test";
import { mayDrop, automaticDrops, countsTowardBreaker, COOLDOWN_MS, DAILY_LIMIT, type DropRecord } from "./drop-guard.ts";

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const at = (minsAgo: number, name = "Someone", via?: string): DropRecord => ({ name, at: NOW - minsAgo * MIN, ...(via ? { via } : {}) });

describe("drop circuit breaker", () => {
  test("the first drop is allowed", () => {
    expect(mayDrop([], NOW).allowed).toBe(true);
  });

  test("a second drop inside the cooldown is deferred, not frozen", () => {
    const v = mayDrop([at(1.5, "Jayden Reed")], NOW);
    expect(v.allowed).toBe(false);
    expect(v.freeze).toBe(false);
    expect(v.reason).toContain("Jayden Reed");
    expect(v.reason).toContain("deferred");
    expect(v.retryAt).toBe(NOW - 1.5 * MIN + COOLDOWN_MS);
  });

  // The exact production cascade: three drops, 90 seconds apart.
  test("the 2026-09-19 cascade is stopped at the first drop", () => {
    const history: DropRecord[] = [];
    const taken: string[] = [];
    for (const [i, name] of ["Jayden Reed", "Nico Collins", "Josh Downs"].entries()) {
      const t = NOW + i * 1.5 * MIN;
      if (mayDrop(history, t).allowed) {
        taken.push(name);
        history.push({ name, at: t });
      }
    }
    expect(taken).toEqual(["Jayden Reed"]);
  });

  // 2026-09-30: two IR activations two minutes apart. The second waits an
  // hour and then goes; nothing else stops.
  test("the deferred drop is allowed again once the cooldown has passed", () => {
    const first = { name: "IR drop 1", at: NOW, via: "ir-activate" };
    expect(mayDrop([first], NOW + 2 * MIN).allowed).toBe(false);
    expect(mayDrop([first], NOW + 2 * MIN).freeze).toBe(false);
    expect(mayDrop([first], NOW + COOLDOWN_MS + MIN).allowed).toBe(true);
  });

  test("the daily limit freezes a slow drip", () => {
    const spread = Array.from({ length: DAILY_LIMIT }, (_, i) => at((i + 1) * (COOLDOWN_MS / MIN + 10), `P${i}`));
    const v = mayDrop(spread, NOW);
    expect(v.allowed).toBe(false);
    expect(v.freeze).toBe(true);
    expect(v.reason).toContain("24h");
  });

  test("the daily limit wins over the cooldown when both apply", () => {
    const spread = Array.from({ length: DAILY_LIMIT }, (_, i) => at(5 + i * 90, `P${i}`));
    expect(mayDrop(spread, NOW).freeze).toBe(true);
  });

  test("drops older than a day do not count", () => {
    const old = Array.from({ length: DAILY_LIMIT + 2 }, (_, i) => at(25 * 60 + i, `P${i}`));
    expect(mayDrop(old, NOW).allowed).toBe(true);
  });

  test("trade gives, filed claims and manual drops are history, not budget", () => {
    const week = [at(2, "T1", "trade"), at(3, "T2", "trade"), at(4, "C1", "claim"), at(5, "M1", "manual")];
    expect(mayDrop(week, NOW).allowed).toBe(true);
    expect(automaticDrops(week)).toEqual([]);
  });

  test("reconcile, ir-activate, free-add and stream count; a row without via counts", () => {
    for (const via of ["reconcile", "ir-activate", "free-add", "stream", undefined]) {
      expect(countsTowardBreaker(via)).toBe(true);
      expect(mayDrop([at(2, "X", via)], NOW).allowed).toBe(false);
    }
  });
});
