// The lineup write reaches the matchup leg, which is what Sleeper scores.
// 2026-09-23: roster_update_starters alone changed the roster array and left
// the week-3 leg (and the app) showing the old lineup.
import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { FREEZE_FILE } from "../paths.ts";
import { updateStarters, matchupLegStarters, currentStarters, type Gql } from "./api.ts";

const L = "1399830848848592896", R = 1;
const A = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "SEA"];
const B = ["1", "2", "3", "5", "4", "6", "7", "8", "9", "SEA"];

/** A Sleeper that keeps the roster array and the leg separately, like the real one. */
function fakeSleeper(opts: { legFollows?: boolean; noLeg?: boolean } = {}) {
  const state = { roster: A.slice(), leg: A.slice() };
  const calls: string[] = [];
  const gql: Gql = async (q) => {
    calls.push(q);
    const ids = (q.match(/starters:\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.replace(/"/g, "")).filter(Boolean);
    if (q.includes("roster_update_starters")) { state.roster = ids; if (opts.legFollows) state.leg = ids; return { data: { roster_update_starters: { roster_id: R, starters: ids } } }; }
    if (q.includes("update_matchup_leg")) { state.leg = ids; return { data: { update_matchup_leg: { roster_id: R, starters: ids } } }; }
    if (q.includes("matchup_legs")) return { data: { matchup_legs: opts.noLeg ? [] : [{ leg: 3, roster_id: R, starters: state.leg }, { leg: 3, roster_id: 2, starters: [] }] } };
    return { data: {} };
  };
  return { gql, state, calls };
}

beforeEach(() => { rmSync(FREEZE_FILE, { force: true }); });

describe("updateStarters writes the leg and verifies it", () => {
  test("both mutations go out, in order, and the leg is read back", async () => {
    const s = fakeSleeper();
    const back = await updateStarters(s.gql, B, R, L, 3);
    expect(back).toEqual(B);
    expect(s.state.roster).toEqual(B);
    expect(s.state.leg).toEqual(B);
    const kinds = s.calls.map((q) => q.includes("roster_update_starters") ? "roster" : q.includes("update_matchup_leg") ? "leg" : "read");
    expect(kinds).toEqual(["roster", "read", "leg", "read"]);
    expect(s.calls[2]).toContain("round:3");
    expect(s.calls[2]).toContain("leg:3");
  });
  test("a leg that does not echo the write is a thrown mismatch, never a silent success", async () => {
    const s = fakeSleeper();
    const stubborn: Gql = async (q) => {
      if (q.includes("update_matchup_leg")) return { data: { update_matchup_leg: { roster_id: R, starters: A } } }; // accepted but not applied
      return s.gql(q);
    };
    await expect(updateStarters(stubborn, B, R, L, 3)).rejects.toThrow(/matchup leg read-back mismatch/);
  });
  test("no leg for the week (pre-season): the roster write alone is fine", async () => {
    const s = fakeSleeper({ noLeg: true });
    const back = await updateStarters(s.gql, B, R, L, 3);
    expect(back).toEqual(B);
    expect(s.calls.some((q) => q.includes("update_matchup_leg"))).toBe(false);
  });
});

describe("planners start from the leg, not the roster array", () => {
  test("matchupLegStarters finds our leg", async () => {
    const s = fakeSleeper();
    s.state.leg = B;
    expect(await matchupLegStarters(s.gql, 3, R, L)).toEqual({ leg: 3, starters: B });
  });
  test("currentStarters prefers the leg and falls back to the roster array", async () => {
    const s = fakeSleeper();
    s.state.leg = B;
    expect(await currentStarters(s.gql, 3, A, R, L)).toEqual(B);
    const none = fakeSleeper({ noLeg: true });
    expect(await currentStarters(none.gql, 3, A, R, L)).toEqual(A);
  });
});
