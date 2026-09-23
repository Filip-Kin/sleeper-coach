import { describe, expect, test } from "bun:test";
import { lastWaiverRunAt, droppedAtFromTransactions, onWaiversNow } from "./waiver-status.ts";
import { zonedInstant } from "../schedule.ts";

// R5. Whether a free add is refused depends on the PLAYER, not on the league:
// dropped inside waiver_clear_days, or his team has kicked off since the last
// waiver run. On Sunday evening 2026-09-20 J.K. Dobbins (Monday night team) was
// a free add while Jacory Croskey-Merritt (played Sunday) was refused on Tuesday.

const ET = (y: number, m: number, d: number, hh: number, mm = 0) => zonedInstant(y, m, d, hh, mm, "America/New_York");

describe("lastWaiverRunAt", () => {
  test("Tuesday points at the previous Wednesday 03:00 ET", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 22, 15))).toBe(ET(2026, 9, 16, 3));
  });
  test("Wednesday 04:00 ET is after this morning's run", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 23, 4))).toBe(ET(2026, 9, 23, 3));
  });
  test("Wednesday 02:00 ET is still before this morning's run", () => {
    expect(lastWaiverRunAt(ET(2026, 9, 23, 2))).toBe(ET(2026, 9, 16, 3));
  });
});

describe("per-player waiver status", () => {
  const kickoffs = new Map([["WAS", ET(2026, 9, 20, 13)], ["LV", ET(2026, 9, 21, 20, 15)]]);
  test("Dobbins-shaped: team not kicked off on Sunday evening is a free agent", () => {
    const now = ET(2026, 9, 20, 18);
    expect(onWaiversNow({ playerId: "dob", team: "LV", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(false);
  });
  test("Croskey-Merritt-shaped: played Sunday, Tuesday means on waivers", () => {
    const now = ET(2026, 9, 22, 10);
    expect(onWaiversNow({ playerId: "jcm", team: "WAS", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(true);
  });
  test("after Wednesday's run the same player has cleared", () => {
    const now = ET(2026, 9, 23, 9);
    expect(onWaiversNow({ playerId: "jcm", team: "WAS", droppedAt: new Map(), kickoffs, now, clearDays: 2 })).toBe(false);
  });
  test("dropped yesterday is on waivers whatever his team did", () => {
    const now = ET(2026, 9, 23, 9);
    const droppedAt = new Map([["x", now - 20 * 3_600_000]]);
    expect(onWaiversNow({ playerId: "x", team: "LV", droppedAt, kickoffs, now, clearDays: 2 })).toBe(true);
  });
  test("droppedAtFromTransactions keeps the latest drop per player", () => {
    const m = droppedAtFromTransactions([
      { drops: { a: 1 }, created: 100, status_updated: 100 },
      { drops: { a: 2, b: 3 }, created: 200, status_updated: 250 },
      { drops: null, created: 999 },
    ]);
    expect(m.get("a")).toBe(250);
    expect(m.get("b")).toBe(250);
    expect(m.size).toBe(2);
  });
});
