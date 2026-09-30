// Covering a bye at kicker or defense: swap the player, never cut a bench
// body to carry two.
//
// Found by the 2026-09-30 review, looking two weeks ahead on the live roster
// (incidents/league.ts). Jake Bates is on bye in week 6 and is our only
// kicker. The stream path was going to keep him ("never drop the player we
// are covering for") and make room for a second kicker by cutting the
// cheapest legal bench player, which with both pending claims processed is
// Mark Andrews: the tight end who covers Sam LaPorta's bye the same week.
// That opens a tight end hole, which costs a second bench player, and leaves
// a second kicker on the roster that no later rule can turn back into a
// useful slot.
//
// The value rule already says who is worth least: the kicker. Every startable
// kicker projects within a point a week of every other, and the same is true
// of defenses. So at those two positions the player on bye is the one who
// leaves, in his bye week, for a free agent who plays.
import { describe, expect, test } from "bun:test";
import { planStream, SWAP_POSITIONS, type StreamPoolPlayer, type StreamNeed } from "./streaming.ts";
import type { TradePlayer } from "./trade.ts";
import { LEAGUE, OURS, fx, idOf, availableAt, tradePlayer } from "./incidents/league.ts";

// Our roster once both pending claims have processed.
const swapIn: Record<string, string> = { [idOf("Tyjae Spears")]: idOf("Travis Etienne"), [idOf("Kenny Gainwell")]: idOf("Jacory Croskey-Merritt") };
const roster: TradePlayer[] = LEAGUE.rosters.find((r) => r.rosterId === OURS)!.players.map((id) => tradePlayer(swapIn[id] ?? id, { onIr: false }));
const pool = (position: string, week: number, onWaivers = false): StreamPoolPlayer[] =>
  availableAt(position).map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly[String(week)] ?? 0, onWaivers, value: p.value }));
const K6: StreamNeed = { week: 6, position: "K", coveringFor: ["Jake Bates"] };
const never = (): string | null => { throw new Error("a swap position must not ask for a forced drop"); };

describe("kicker on bye in week 6, roster full", () => {
  test("the positions that swap are kicker and defense", () => {
    expect([...SWAP_POSITIONS].sort()).toEqual(["DEF", "K"]);
  });
  test("in week 5 nothing is cut: the swap waits for the bye week", () => {
    const d = planStream({ need: K6, week: 5, openBenchSlots: 0, pool: pool("K", 6), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("wait");
    expect(d.add).toBeNull();
    expect(d.drop).toBeNull();
  });
  test("in week 6 Bates is swapped for a free kicker who plays, and no bench player leaves", () => {
    const d = planStream({ need: K6, week: 6, openBenchSlots: 0, pool: pool("K", 6), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
    const added = availableAt("K").find((p) => p.name === d.add)!;
    expect(added.bye).not.toBe(6);
    expect(added.weekly["6"]).toBeGreaterThan(0);
    // He stays as our kicker, so he is the best rest-of-season free kicker who plays this week.
    const best = availableAt("K").filter((p) => p.bye !== 6 && (p.weekly["6"] ?? 0) > 0).sort((a, b) => b.value - a.value)[0]!;
    expect(d.add).toBe(best.name);
    expect(d.onWaivers).toBe(false);
  });
  test("a swap is never a claim: with every kicker on waivers it waits for them to clear", () => {
    const d = planStream({ need: K6, week: 6, openBenchSlots: 0, pool: pool("K", 6, true), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("wait");
    expect(d.drop).toBeNull();
  });
  test("with an open bench slot the streamer is just added, a week ahead, and nobody leaves", () => {
    const d = planStream({ need: K6, week: 5, openBenchSlots: 1, pool: pool("K", 6), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("open-slot");
    expect(d.drop).toBeNull();
    expect(d.add).not.toBeNull();
  });
  test("a kicker who may not leave (never-drop, a pending claim's drop) falls back to the cheapest legal cut", () => {
    const d = planStream({ need: K6, week: 6, openBenchSlots: 0, pool: pool("K", 6), roster, mayLeave: (n) => n !== "Jake Bates", forcedDrop: () => "Rico Dowdle" });
    expect(d.how).toBe("cut");
    expect(d.drop).toBe("Rico Dowdle");
  });
});

describe("defense on bye in week 11", () => {
  const need: StreamNeed = { week: 11, position: "DEF", coveringFor: [fx("SEA").name] };
  test("Seattle is swapped for a free defense that plays", () => {
    const d = planStream({ need, week: 11, openBenchSlots: 0, pool: pool("DEF", 11), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe(fx("SEA").name);
    expect(availableAt("DEF").find((p) => p.name === d.add)!.bye).not.toBe(11);
  });
});

describe("a skill position is scarce: it is covered by a cut, not a swap", () => {
  // No Andrews: LaPorta's bye leaves tight end empty in week 6.
  const thin = roster.filter((p) => p.name !== "Mark Andrews");
  const need: StreamNeed = { week: 6, position: "TE", coveringFor: ["Sam LaPorta"] };
  test("the cheapest legal bench body goes and LaPorta stays", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool("TE", 6), roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle" });
    expect(d.how).toBe("cut");
    expect(d.drop).toBe("Rico Dowdle");
    expect(d.add).not.toBeNull();
  });
  test("no legal cut is reported as stuck, never passed over in silence", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool("TE", 6), roster: thin, mayLeave: () => true, forcedDrop: () => null });
    expect(d.how).toBe("stuck");
    expect(d.reason).toMatch(/TE/);
  });
  test("nobody available who plays that week is stuck too", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 1, pool: [], roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle" });
    expect(d.how).toBe("stuck");
  });
});
