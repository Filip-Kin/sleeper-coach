import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { freezeState, dropFreezeState, breakerState, assertWritesAllowed, dropFreezeNow, freezeNow, FREEZE_FILE, DROP_FREEZE_FILE } from "./killswitch.ts";

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
  // 2026-09-30 12:23Z: the daemon booted under Filip's FREEZE and the
  // drop-freeze invariant, reading dropFreezeState(), called a deliberate
  // human stop an invariant failure. The breaker question is DROP_FREEZE only.
  test("breakerState is DROP_FREEZE only: a human FREEZE is not a tripped breaker", async () => {
    writeFileSync(FREEZE_FILE, "2026-09-30T07:03:47.649Z auto-frozen: dropped 7543 2 min ago\n");
    expect(freezeState().frozen).toBe(true);
    expect(dropFreezeState().frozen).toBe(true);
    expect(breakerState().frozen).toBe(false);
    await dropFreezeNow("4 automatic drops in the last 24h");
    const b = breakerState();
    expect(b.frozen).toBe(true);
    expect(b.reason).toContain("circuit breaker");
    rmSync(FREEZE_FILE);
    expect(breakerState().frozen).toBe(true);
    expect(dropFreezeState().reason).toBe(b.reason);
    rmSync(DROP_FREEZE_FILE); // later test files share the scratch state dir
  });
});
