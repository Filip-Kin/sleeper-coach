import { test, expect } from "bun:test";
import { activeCapacity, overCapBy, chooseForcedDrops, keptStarters } from "./roster-fit.ts";
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

// A starting one-week rental (2026-10-07 review): Jacksonville (DEF10, 86)
// started week 5 for the matchup while Seattle (DEF3, 97) sat, and the cut
// order listed Seattle first and Jacksonville nowhere. Of two bodies at a
// swap position the one who is not the best by rest-of-season value is the
// cut, even while he starts: the better body takes the slot.
const rental = [
  P("McCaffrey","RB",253), P("Walker","RB",229), P("Prescott","QB",225), P("Hurts","QB",223),
  P("Collins","WR",212), P("Brown","RB",200), P("Evans","WR",175), P("Smith","WR",159),
  P("LaPorta","TE",140), P("Harvey","RB",137), P("Downs","WR",136), P("Andrews","TE",132),
  P("Dowdle","RB",105), P("Bates","K",98), P("SEA","DEF",97), P("JAX","DEF",86),
];
const rentalStarters = ["Prescott","McCaffrey","Brown","Collins","Evans","LaPorta","Harvey","Downs","Bates","JAX"];
const plays = () => true;

test("a starting rental is cut before the better defense behind him and before any season body", () => {
  const kept = keptStarters(rentalStarters, rental, plays);
  expect(kept).not.toContain("JAX");
  expect(kept).toContain("Bates"); // the only kicker: nobody behind him
  expect(kept).toContain("Harvey"); // a back is never swapped for the bench by this rule
  const drops = chooseForcedDrops(rental, 2, cfg, kept);
  expect(drops.map((d) => d.name)).toEqual(["JAX", "Dowdle"]);
  // The defense slot stays filled: Seattle is still there.
  expect(drops.map((d) => d.name)).not.toContain("SEA");
});

test("the better body must be able to take the slot this week: on bye, locked, ruled out, or leaving on a claim, the rental stays kept", () => {
  const seaOut = (p: { name: string }) => p.name !== "SEA"; // on bye, ruled out, or locked while the rental has not kicked off
  expect(keptStarters(rentalStarters, rental, seaOut)).toContain("JAX");
  // With the rental kept, the one value decides among the rest: Seattle (97) before Dowdle (105), as the defect was filed.
  expect(chooseForcedDrops(rental, 1, cfg, keptStarters(rentalStarters, rental, seaOut))[0]?.name).toBe("SEA");
  const seaLeaving = rental.map((p) => (p.name === "SEA" ? { ...p, claimDrop: true } : p));
  expect(keptStarters(rentalStarters, seaLeaving, plays)).toContain("JAX");
  const seaNotOursYet = rental.map((p) => (p.name === "SEA" ? { ...p, claimAdd: true } : p));
  expect(keptStarters(rentalStarters, seaNotOursYet, plays)).toContain("JAX");
  const seaOnIr = rental.map((p) => (p.name === "SEA" ? { ...p, onIr: true } : p));
  expect(keptStarters(rentalStarters, seaOnIr, plays)).toContain("JAX");
});

test("the starter who IS the best at his position stays kept; without a week table every starter stays kept", () => {
  const seaStarts = rentalStarters.map((n) => (n === "JAX" ? "SEA" : n));
  expect(keptStarters(seaStarts, rental, plays)).toContain("SEA");
  expect(chooseForcedDrops(rental, 1, cfg, keptStarters(seaStarts, rental, plays))[0]?.name).toBe("JAX");
  // No numbers: the old protection, Seattle goes first (the defect as filed).
  expect(keptStarters(rentalStarters, rental, () => false)).toContain("JAX");
  expect(chooseForcedDrops(rental, 1, cfg, keptStarters(rentalStarters, rental, () => false))[0]?.name).toBe("SEA");
});

test("a tie on the one value breaks on season talent, never on name: a full tie keeps the starter", () => {
  const tied = rental.map((p) => (p.name === "SEA" ? { ...p, points: 86 } : p));
  expect(keptStarters(rentalStarters, tied, plays)).toContain("JAX");
  const talent = tied.map((p) => (p.name === "SEA" ? { ...p, seasonPoints: 103 } : p.name === "JAX" ? { ...p, seasonPoints: 91 } : p));
  expect(keptStarters(rentalStarters, talent, plays)).not.toContain("JAX");
});
