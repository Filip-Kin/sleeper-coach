import { describe, expect, test } from "bun:test";
import { planOne, irOpportunities, DEFAULT_WAIVERS, type RosterState, type AvailablePlayer } from "./waivers.ts";
import { irEligible } from "../sleeper/rules.ts";
import type { League } from "../sleeper/types.ts";
import { DEFAULT_RAILS, type RailPlayer } from "./rails.ts";

// R3 and R7 from the 2026-09-23 audit.

const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const eligible = (s?: string | null) => irEligible(s, S);
const SMALL = ["QB", "RB", "WR"];
const cleared = (name: string, position: string, points: number): AvailablePlayer => ({ name, position, points, onWaivers: false });

describe("R3: ir-stash eligibility and ranking", () => {
  test("Doubtful is not a stash candidate under this league's flags, even as a playoff stash", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "Doubtful Guy", position: "WR", points: 150, injuryStatus: "Doubtful", returnsBeforePlayoffs: true },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 1, startingSlots: SMALL, irEligible: eligible };
    const m = planOne(cleared("Good WR", "WR", 240), state, DEFAULT_WAIVERS);
    expect(m.irStash).not.toBe("Doubtful Guy");
    expect(m.dropPath).not.toBe("ir-stash");
  });
  test("the highest-value eligible player is stashed first, not the first in roster order", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "Fringe Out", position: "WR", points: 30, injuryStatus: "Out" },
      { name: "Star Out", position: "WR", points: 180, injuryStatus: "Out" },
      { name: "Healthy WR", position: "WR", points: 120 },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 1, startingSlots: SMALL, irEligible: eligible };
    const m = planOne(cleared("Good WR", "WR", 240), state, DEFAULT_WAIVERS);
    expect(m.dropPath).toBe("ir-stash");
    expect(m.irStash).toBe("Star Out");
  });
  test("a current-week starter is never stashed before the games lock", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "Out Starter", position: "WR", points: 180, injuryStatus: "Out" },
      { name: "Fringe Out", position: "WR", points: 30, injuryStatus: "Out" },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 1, startingSlots: SMALL, irEligible: eligible, currentStarters: ["Out Starter"] };
    const m = planOne(cleared("Good WR", "WR", 240), state, DEFAULT_WAIVERS);
    expect(m.irStash).toBe("Fringe Out");
  });
  test("irOpportunities uses the league flags only", () => {
    const roster: RailPlayer[] = [
      { name: "Doubtful Stash", position: "WR", points: 150, injuryStatus: "Doubtful", returnsBeforePlayoffs: true },
      { name: "Out Guy", position: "RB", points: 100, injuryStatus: "Out" },
    ];
    expect(irOpportunities(roster, 2, eligible).map((o) => o.name)).toEqual(["Out Guy"]);
  });
});

describe("R7: an add that needs a drop", () => {
  const starters = ["QB Guy", "RB Guy", "WR Guy"];
  // Small fixtures: protect only the three starters by rank so the bench body
  // is a legal drop and the gate under test is the one that decides.
  const CFG = { ...DEFAULT_WAIVERS, rails: { ...DEFAULT_RAILS, protectTopN: 3 } };
  test("+2 with a starter drop is refused", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "WR Guy", position: "WR", points: 100 },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SMALL, currentStarters: starters };
    const m = planOne(cleared("Malik-shaped WR", "WR", 102), state, { ...DEFAULT_WAIVERS, rails: { ...DEFAULT_RAILS, protectTopN: 0 } });
    expect(m.kind).toBe("skip");
    expect(m.drop).toBeNull();
  });
  test("+6 with a bench drop passes", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "WR Guy", position: "WR", points: 100 },
      { name: "Bench WR", position: "WR", points: 20 },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SMALL, currentStarters: starters };
    const m = planOne(cleared("Good WR", "WR", 106), state, CFG);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Bench WR");
    expect(m.gainPts).toBe(6);
  });
  test("+6 is never taken by dropping a current starter", () => {
    const roster: RailPlayer[] = [
      { name: "QB Guy", position: "QB", points: 300 },
      { name: "RB Guy", position: "RB", points: 200 },
      { name: "WR Guy", position: "WR", points: 100 },
    ];
    const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SMALL, currentStarters: starters };
    const m = planOne(cleared("Good WR", "WR", 106), state, { ...DEFAULT_WAIVERS, rails: { ...DEFAULT_RAILS, protectTopN: 0 } });
    expect(m.drop).not.toBe("WR Guy");
    expect(m.kind).toBe("skip");
  });
  test("the drop bar is five season points", () => {
    expect(DEFAULT_WAIVERS.freeAddMarginPts).toBe(5);
  });
});
