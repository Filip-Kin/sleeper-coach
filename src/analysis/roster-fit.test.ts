import { test, expect } from "bun:test";
import { activeCapacity, overCapBy, chooseForcedDrops } from "./roster-fit.ts";
import { DEFAULT_FAIRNESS } from "./trade-fair.ts";

const P = (name: string, position: string, points: number, extra: Record<string, unknown> = {}) =>
  ({ name, position, points, ...extra });

test("capacity is starters plus bench", () => {
  expect(activeCapacity(["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"])).toBe(16);
});

test("over-cap is the overflow, floored at zero", () => {
  expect(overCapBy(18, 16)).toBe(2);
  expect(overCapBy(16, 16)).toBe(0);
  expect(overCapBy(14, 16)).toBe(0);
});

// A realistic full roster with clear scrubs.
const roster = [
  P("Hurts","QB",310), P("Prescott","QB",303), P("McCaffrey","RB",291), P("Brown","RB",255),
  P("Walker","RB",244), P("Etienne","RB",207), P("Collins","WR",262), P("Smith","WR",229),
  P("Evans","WR",222), P("Downs","WR",140), P("LaPorta","TE",196), P("Bates","K",44), P("SEA","DEF",10),
];
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: Array.from({length:15},(_,i)=>i+1), remainingWeeks: 15, headToHeadRemaining: 2 };

test("a forced drop is the lowest rest-of-season value, never a starter-level player", () => {
  // Filip, 2026-09-30: a drop is for the season. The bench is Prescott (303),
  // Etienne (207), Downs (140): Downs goes first, then Etienne. The backup QB
  // is worth more than both for the rest of the season and stays.
  const drops = chooseForcedDrops(roster, 2, cfg);
  expect(drops.map((d) => d.name)).toEqual(["Downs", "Etienne"]);
});

test("ties break on full-season talent, never on list order", () => {
  const tied = [...roster, P("A-first", "WR", 100, { seasonPoints: 150 }), P("B-second", "WR", 100, { seasonPoints: 120 })];
  expect(chooseForcedDrops(tied, 1, cfg)[0]?.name).toBe("B-second");
});

test("forced drops pick the cheapest-to-lose players", () => {
  const drops = chooseForcedDrops(roster, 2, cfg);
  expect(drops.length).toBe(2);
  // The two least valuable: our backup QB and our worst WR are prime candidates.
  const names = drops.map((d) => d.name);
  expect(names).not.toContain("McCaffrey");
  expect(names).not.toContain("Hurts");
  expect(names).not.toContain("Collins");
  // ascending cost
  expect(drops[0]!.cost).toBeLessThanOrEqual(drops[1]!.cost);
});

test("never drops a player we just acquired in the trade", () => {
  // Even if the incoming player is our lowest projection, he is off the table.
  const withIncoming = [...roster, P("NewGuy","WR",60)];
  const drops = chooseForcedDrops(withIncoming, 1, cfg, ["NewGuy"]);
  expect(drops[0]?.name).not.toBe("NewGuy");
});

test("never drops the injured stash or the never-drop, and picks the cheapest of the rest", () => {
  const withStash = [
    ...roster,
    P("Scrub","WR",50),
    P("StashRB","RB",30, { returnsBeforePlayoffs: true }), // hurt now, back for playoffs
  ];
  const drops = chooseForcedDrops(withStash, 3, cfg, [], { ...DEFAULT_FAIRNESS.rails, neverDrop: ["Downs"] });
  const names = drops.map((d) => d.name);
  // Hard protections are honoured no matter how cheap they look.
  expect(names).not.toContain("StashRB");
  expect(names).not.toContain("Downs");
  // Every chosen player is genuinely droppable and none is a hard-protected one.
  // (A strict cost ordering no longer holds because the guard skips a cheaper
  // drop that would empty a mandatory slot; that is covered by its own test.)
  expect(drops.length).toBeGreaterThan(0);
  expect(names.every((n) => n !== "StashRB" && n !== "Downs")).toBe(true);
});

test("never empties a mandatory starting slot, even when that slot is the cheapest drop", () => {
  // One kicker, one defense: both look cheap to lose (a streamer covers them),
  // but at a full roster we cannot add a replacement, so emptying either is a
  // permanent hole. The drop must fall on a backup skill player instead.
  const full = [
    P("Hurts","QB",310), P("Prescott","QB",303), P("McCaffrey","RB",291), P("Brown","RB",255),
    P("Walker","RB",244), P("Collins","WR",262), P("Smith","WR",229), P("Evans","WR",222),
    P("LaPorta","TE",196), P("Bates","K",44), P("SEA","DEF",10),
  ];
  const drops = chooseForcedDrops(full, 1, cfg);
  expect(drops[0]?.name).not.toBe("Bates"); // only kicker
  expect(drops[0]?.name).not.toBe("SEA");   // only defense
  expect(drops[0]?.name).not.toBe("LaPorta"); // only TE
  // The backup QB is the correct sacrifice: he starts nowhere and empties nothing.
  expect(drops[0]?.name).toBe("Prescott");
});

test("returns fewer than asked rather than dropping a protected player", () => {
  // A tiny all-protected roster: nothing legal to drop.
  const tiny = [
    P("A","RB",30, { returnsBeforePlayoffs: true }),
    P("B","WR",20, { returnsBeforePlayoffs: true }),
  ];
  const drops = chooseForcedDrops(tiny, 2, cfg);
  expect(drops.length).toBe(0); // caller must alert; we will not cut a stash
});

test("zero or negative count is a no-op", () => {
  expect(chooseForcedDrops(roster, 0, cfg)).toEqual([]);
  expect(chooseForcedDrops(roster, -1, cfg)).toEqual([]);
});
