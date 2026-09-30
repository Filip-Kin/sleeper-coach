import { describe, expect, test } from "bun:test";
import { unfilledNotice } from "./lineup-run.ts";

// An unfillable slot no longer refuses the whole write. The notice is keyed
// per week so sendAlertOnce says it once, whichever lock runs first.
describe("unfilledNotice", () => {
  test("no holes, no notice", () => {
    expect(unfilledNotice({ unfilled: [], changed: true }, "2026", 5)).toBeNull();
  });
  test("a hole names the slot, is keyed per season and week, and says the rest was written", () => {
    const n = unfilledNotice({ unfilled: ["TE"], changed: true }, "2026", 5)!;
    expect(n.key).toBe("lineup-unfilled:2026:5");
    expect(n.message).toContain("TE");
    expect(n.message).toContain("was written");
  });
  test("an unchanged plan with a hole says the rest is already set", () => {
    expect(unfilledNotice({ unfilled: ["K", "DEF"], changed: false }, "2026", 5)!.message).toContain("is already set");
  });
});
