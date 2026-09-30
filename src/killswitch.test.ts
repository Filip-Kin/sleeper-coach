import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { freezeState, dropFreezeState, assertWritesAllowed, dropFreezeNow, freezeNow, FREEZE_FILE, DROP_FREEZE_FILE } from "./killswitch.ts";

// Two files, two scopes. 2026-09-30: the breaker wrote FREEZE and stopped the
// lineup guard along with the drops, with the roster left illegal.
beforeEach(() => { for (const f of [FREEZE_FILE, DROP_FREEZE_FILE]) rmSync(f, { force: true }); delete process.env.COACH_FREEZE; });

describe("kill switch scopes", () => {
  test("nothing set: both allowed", () => {
    expect(freezeState().frozen).toBe(false);
    expect(dropFreezeState().frozen).toBe(false);
    expect(() => assertWritesAllowed("x")).not.toThrow();
  });
  test("DROP_FREEZE stops drops and nothing else", async () => {
    await dropFreezeNow("4 automatic drops in the last 24h");
    expect(existsSync(DROP_FREEZE_FILE)).toBe(true);
    expect(existsSync(FREEZE_FILE)).toBe(false);
    expect(freezeState().frozen).toBe(false);
    expect(() => assertWritesAllowed("set starters")).not.toThrow();
    const d = dropFreezeState();
    expect(d.frozen).toBe(true);
    expect(d.reason).toContain("circuit breaker");
    expect(d.reason).toContain("4 automatic drops");
  });
  test("the human FREEZE stops everything, drops included", () => {
    writeFileSync(FREEZE_FILE, "frozen by Filip\n");
    expect(freezeState().frozen).toBe(true);
    expect(dropFreezeState().frozen).toBe(true);
    expect(() => assertWritesAllowed("set starters")).toThrow(/FROZEN/);
  });
  test("freezeNow (the full self-freeze) writes FREEZE, not DROP_FREEZE", async () => {
    await freezeNow("test");
    expect(existsSync(FREEZE_FILE)).toBe(true);
    expect(existsSync(DROP_FREEZE_FILE)).toBe(false);
  });
  test("removing DROP_FREEZE lifts the drop freeze on the next check", async () => {
    await dropFreezeNow("x");
    rmSync(DROP_FREEZE_FILE);
    expect(dropFreezeState().frozen).toBe(false);
  });
});
