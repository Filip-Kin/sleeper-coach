import { describe, expect, test } from "bun:test";
import { mayDrop, COOLDOWN_MS, DAILY_LIMIT, type DropRecord } from "./drop-guard.ts";

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const at = (minsAgo: number, name = "Someone"): DropRecord => ({ name, at: NOW - minsAgo * MIN });

describe("drop circuit breaker", () => {
  test("the first drop is allowed", () => {
    expect(mayDrop([], NOW).allowed).toBe(true);
  });

  test("a second drop inside the cooldown is refused and freezes", () => {
    const v = mayDrop([at(1.5, "Jayden Reed")], NOW);
    expect(v.allowed).toBe(false);
    expect(v.freeze).toBe(true);
    expect(v.reason).toContain("Jayden Reed");
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

  test("a drop is allowed again once the cooldown has passed", () => {
    expect(mayDrop([at(COOLDOWN_MS / MIN + 1)], NOW).allowed).toBe(true);
  });

  test("the daily limit still caps a slow drip", () => {
    const spread = Array.from({ length: DAILY_LIMIT }, (_, i) => at((i + 1) * (COOLDOWN_MS / MIN + 10), `P${i}`));
    const v = mayDrop(spread, NOW);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("24h");
  });

  test("drops older than a day do not count", () => {
    const old = Array.from({ length: DAILY_LIMIT + 2 }, (_, i) => at(25 * 60 + i, `P${i}`));
    expect(mayDrop(old, NOW).allowed).toBe(true);
  });
});
