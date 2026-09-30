// "If an available player's rest-of-season average beats a bench player's,
// make that swap." (Filip, 2026-09-30.)
//
// The bench swap is same-position, and it could only ever reach the two
// cheapest bench bodies: canDrop protects the top twelve by rest-of-season
// points, two quarterbacks sit near the top of that list, and the kicker and
// the defense sit at the bottom of it. On the live roster of 2026-09-30, with
// both pending claims processed (incidents/league.ts), that left Rico Dowdle
// and Mark Andrews as the only players any add could replace. Josh Downs, the
// one receiver on the bench, ranked tenth: no free-agent receiver, however
// good, could take his place unless he was good enough to start.
//
// The top-N rail exists so a good player is not dropped for a streamer. A
// better player at the same position is not that. Every other rail still
// holds: never-drop, a stash, a pending claim's drop, this week's starters.
import { describe, expect, test } from "bun:test";
import { planOne, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { LEAGUE, OURS, fx, idOf, tradePlayer } from "./incidents/league.ts";

const swapIn: Record<string, string> = { [idOf("Tyjae Spears")]: idOf("Travis Etienne"), [idOf("Kenny Gainwell")]: idOf("Jacory Croskey-Merritt") };
const mine = LEAGUE.rosters.find((r) => r.rosterId === OURS)!;
const roster: RailPlayer[] = mine.players.map((id) => tradePlayer(swapIn[id] ?? id, { onIr: false }));
const starters = mine.starters.map((id) => fx(id).name);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN");
const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, currentStarters: starters, weeksLeft: 14 };
/** A real free agent with his value set for the case. */
const fa = (name: string, value: number, onWaivers = false): AvailablePlayer => ({ ...tradePlayer(idOf(name)), points: value, onWaivers });

describe("a same-position upgrade may replace a top-twelve bench player", () => {
  test("the roster of the day: Downs is tenth by rest-of-season points, inside the protected twelve", () => {
    const rank = roster.slice().sort((a, b) => b.points - a.points).findIndex((p) => p.name === "Josh Downs") + 1;
    expect(rank).toBe(10);
  });
  test("a free receiver 1.6 a week better than Downs replaces him", () => {
    const m = planOne(fa("Malik Washington", 170), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Josh Downs");
    expect(m.benchGainPts).toBeCloseTo(170 - 148.4, 0);
  });
  test("under a point a week he does not: a drop is for a real gap", () => {
    const m = planOne(fa("Malik Washington", 155), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
  });
  test("the real Malik Washington (143) is below Downs (148): nothing", () => {
    const m = planOne(fa("Malik Washington", fx(idOf("Malik Washington")).value), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
  });
  test("on waivers the same upgrade needs two points a week before it is a claim", () => {
    expect(planOne(fa("Malik Washington", 170, true), state, DEFAULT_WAIVERS).kind).toBe("wait");
    const big = planOne(fa("Malik Washington", 180, true), state, DEFAULT_WAIVERS);
    expect(big.kind).toBe("waiver-claim");
    expect(big.drop).toBe("Josh Downs");
  });
});

describe("what the upgrade path must not loosen", () => {
  test("a better running back takes the cheapest back, not a protected one", () => {
    const m = planOne(fa("RJ Harvey", 150), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Rico Dowdle");
  });
  test("a stash is never the drop, even for a better player at his position", () => {
    const noDowdle = { ...state, roster: roster.filter((p) => p.name !== "Rico Dowdle") };
    expect(roster.find((p) => p.name === "Travis Etienne")!.returnsBeforePlayoffs).toBe(true);
    const m = planOne(fa("RJ Harvey", 160), noDowdle, DEFAULT_WAIVERS);
    expect(m.drop).not.toBe("Travis Etienne");
    expect(m.drop).toBe("Jacory Croskey-Merritt");
  });
  test("a pending claim's drop is never the drop", () => {
    const held = { ...DEFAULT_WAIVERS, rails: { ...DEFAULT_WAIVERS.rails, neverDrop: ["Josh Downs"] } };
    expect(planOne(fa("Malik Washington", 170), state, held).drop).not.toBe("Josh Downs");
  });
  test("this week's starter is never the drop", () => {
    const m = planOne(fa("Malik Washington", 170), { ...state, currentStarters: [...starters, "Josh Downs"] }, DEFAULT_WAIVERS);
    expect(m.drop).not.toBe("Josh Downs");
  });
  test("a receiver good enough to START costs the cheapest body on the roster, not the bench receiver", () => {
    // He starts whoever leaves, so every bench drop gains the lineup the
    // same. The value rule picks: Andrews (120) before Dowdle (121) before
    // Downs (148). Ranking by bench gain would have cut Downs.
    const m = planOne(fa("Malik Washington", 215), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.startsForUs).toBe(true);
    expect(m.drop).toBe("Mark Andrews");
  });
  test("a running back good enough to start costs the cheapest BACK; the tight end covering LaPorta's bye stays", () => {
    // Andrews (119.8) is a point cheaper than Dowdle (120.9) and is the only
    // cover for LaPorta's week-6 bye. Cutting him for a back opens a tight
    // end hole that costs a second bench player the next run (review finding).
    const m = planOne(fa("RJ Harvey", 200), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.startsForUs).toBe(true);
    expect(m.drop).toBe("Rico Dowdle");
  });
  test("the bench quarterback is not in the widening", () => {
    // A quarterback's bench value is not his raw points: he plays only when
    // he beats the starter. Prescott starts this week, so Hurts (250) is the
    // "bench" quarterback of the day. A free quarterback at 272 would start
    // for the season, which is a lineup add and costs the cheapest ordinary
    // body; it never costs us Hurts or Prescott.
    const m = planOne(fa("Matthew Stafford", 272), state, DEFAULT_WAIVERS);
    expect(["Jalen Hurts", "Dak Prescott"]).not.toContain(m.drop);
    // And with Hurts' number dipped below a free quarterback who would not
    // start (Prescott 249 still does), nothing happens at all.
    const dipped = { ...state, roster: roster.map((p) => (p.name === "Jalen Hurts" ? { ...p, points: 228 } : p)) };
    expect(planOne(fa("Matthew Stafford", 243), dipped, DEFAULT_WAIVERS).kind).toBe("skip");
  });
  test("a player at another position does not get past the top twelve", () => {
    // A tight end worth more than Downs on paper: the receiver stays.
    const m = planOne(fa("Hunter Henry", 170), state, DEFAULT_WAIVERS);
    expect(m.drop).not.toBe("Josh Downs");
  });
});

// Rest-of-season sums count games, so late in the year a bench player whose
// bye is still to come trails an equal player whose bye has passed by one
// game, and one game clears a bar that shrinks with the weeks left. The
// reviewer replayed the captured weekly tables forward: in weeks 12 and 13
// the swap took Brenton Strange for Mark Andrews on nothing but Andrews'
// week-13 bye. "He averages ten and ours averages eight: swap them" is about
// the average, so the swap must hold per game as well as in total.
describe("a bye still to come is not an upgrade", () => {
  const from = (id: string, week: number): number => {
    let sum = 0;
    for (let w = week; w <= 17; w++) sum += fx(id).weekly[String(w)] ?? 0;
    return Math.round(sum * 10) / 10;
  };
  const asOf = (week: number): RosterState => ({
    ...state, weeksLeft: 17 - week + 1,
    roster: roster.map((p) => ({ ...p, points: from(p.playerId!, week) })),
  });
  const faAsOf = (name: string, week: number): AvailablePlayer => ({ ...tradePlayer(idOf(name)), points: from(idOf(name), week), onWaivers: false });
  test("week 12: Strange has six games left, Andrews five; per game they are half a point apart", () => {
    const s = asOf(12);
    const strange = faAsOf("Brenton Strange", 12);
    const andrews = s.roster.find((p) => p.name === "Mark Andrews")!;
    expect(andrews.bye).toBe(13);
    expect(strange.points - andrews.points).toBeGreaterThan(6); // clears the 1.0 x 6 weeks total bar
    expect(strange.points / 6 - andrews.points / 5).toBeLessThan(1);
    expect(planOne(strange, s, DEFAULT_WAIVERS).kind).toBe("skip");
  });
  test("the same check does not stop a real gap: Croskey-Merritt over Gainwell today", () => {
    const today: RosterState = { ...state, roster: mine.players.map((id) => tradePlayer(id, { onIr: false })) };
    const m = planOne({ ...tradePlayer(idOf("Jacory Croskey-Merritt")), onWaivers: true }, today, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.drop).toBe("Kenny Gainwell");
  });
});
