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
  test("open slot, some kickers on waivers: the best FREE one is taken, never a claim for a kicker", () => {
    // 2026-10-06 review: with the waiver status right on a Tuesday, this
    // branch handed the claim job a kicker to claim, with no second look.
    const all = pool("K", 6).filter((p) => p.bye !== 6 && p.weekPoints > 0).sort((a, b) => b.weekPoints - a.weekPoints);
    const mixed = all.map((p, i) => ({ ...p, onWaivers: i === 0 })); // the best one played on Sunday
    const d = planStream({ need: K6, week: 6, openBenchSlots: 1, pool: mixed, roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("open-slot");
    expect(d.add).toBe(all[1]!.name);
    expect(d.onWaivers).toBe(false);
  });
  test("open slot, every kicker on waivers: wait for Wednesday, no claim", () => {
    const d = planStream({ need: K6, week: 6, openBenchSlots: 1, pool: pool("K", 6, true), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("wait");
    expect(d.add).toBeNull();
    expect(d.reason).toMatch(/not worth a claim/);
  });
  test("a kicker who may not leave (never-drop, a pending claim's drop) falls back to the cheapest legal cut", () => {
    const d = planStream({ need: K6, week: 6, openBenchSlots: 0, pool: pool("K", 6), roster, mayLeave: (n) => n !== "Jake Bates", forcedDrop: () => "Rico Dowdle" });
    expect(d.how).toBe("cut");
    expect(d.drop).toBe("Rico Dowdle");
  });
});

describe("a kicker ruled out this week", () => {
  test("is swapped like a bye: Doubtful or Out, he is not kicking and kickers are interchangeable", () => {
    const need: StreamNeed = { week: 4, position: "K", coveringFor: ["Jake Bates"] };
    const d = planStream({ need, week: 4, openBenchSlots: 0, pool: pool("K", 4), roster, mayLeave: () => true, forcedDrop: never });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
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
  test("the filler stays, so he is picked on the one value: the lower week projection with the higher rest-of-season value", () => {
    // 2026-10-24: Godwin (104 ROS, 11.4 wk 7) was taken over Robinson (113.5
    // ROS, 10.3) for the week-7 WR hole; the season replay is
    // stream-cut-value.replay.test.ts.
    const two: StreamPoolPlayer[] = [
      { playerId: "a", name: "Week Man", position: "TE", bye: 9, weekPoints: 11.4, onWaivers: false, value: 104 },
      { playerId: "b", name: "Season Man", position: "TE", bye: 9, weekPoints: 10.3, onWaivers: false, value: 113.5 },
    ];
    const cut = planStream({ need, week: 5, openBenchSlots: 0, pool: two, roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle" });
    expect(cut).toMatchObject({ how: "cut", add: "Season Man", drop: "Rico Dowdle", points: 10.3 });
    const open = planStream({ need, week: 5, openBenchSlots: 1, pool: two, roster: thin, mayLeave: () => true, forcedDrop: () => null });
    expect(open).toMatchObject({ how: "open-slot", add: "Season Man", drop: null });
    // Equal on the one value: the week decides.
    const tie = two.map((p) => ({ ...p, value: 110 }));
    expect(planStream({ need, week: 5, openBenchSlots: 0, pool: tie, roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle" }).add).toBe("Week Man");
  });
  test("a kicker is still picked on the need week: he is swapped back out the week after", () => {
    const two: StreamPoolPlayer[] = [
      { playerId: "a", name: "Week Kicker", position: "K", bye: 9, weekPoints: 9.5, onWaivers: false, value: 80 },
      { playerId: "b", name: "Season Kicker", position: "K", bye: 9, weekPoints: 8.0, onWaivers: false, value: 95 },
    ];
    const open = planStream({ need: K6, week: 5, openBenchSlots: 1, pool: two, roster, mayLeave: () => true, forcedDrop: never });
    expect(open).toMatchObject({ how: "open-slot", add: "Week Kicker" });
  });
  test("no legal cut is reported as stuck, never passed over in silence", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool("TE", 6), roster: thin, mayLeave: () => true, forcedDrop: () => null });
    expect(d.how).toBe("stuck");
    expect(d.reason).toMatch(/TE/);
  });
  test("a scarce position into an open slot may still be a claim: the best body, whatever his status", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 1, pool: pool("TE", 6, true), roster: thin, mayLeave: () => true, forcedDrop: () => null });
    expect(d.how).toBe("open-slot");
    expect(d.onWaivers).toBe(true);
  });
  test("nobody available who plays that week is stuck too", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 1, pool: [], roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle" });
    expect(d.how).toBe("stuck");
  });
});

// A stream for a LATER week that can only go by a claim yields the cycle's
// single claim to this week's move (2026-10-20: the week-8 Butker claim
// would have taken the one claim ahead of the Nix rental, for no gain). It
// takes a free body if one plays, or waits for the free-agent run after
// the clear; in the need week itself it claims, since an empty slot
// outranks any upgrade.
describe("a later week's stream claim yields to this week's claim", () => {
  const K7: StreamNeed = { week: 7, position: "K", coveringFor: ["Jake Bates"] };
  test("priority free, claim spoken for, every kicker on waivers: wait, not a claim", () => {
    const d = planStream({ need: K7, week: 6, openBenchSlots: 0, pool: pool("K", 7, true), roster, mayLeave: () => true, forcedDrop: never, priorityFree: true, claimTaken: true });
    expect(d.how).toBe("wait");
    expect(d.add).toBeNull();
    expect(d.reason).toContain("this week's claim");
  });
  test("the same with an open bench slot: the open-slot add waits too", () => {
    const d = planStream({ need: K7, week: 6, openBenchSlots: 1, pool: pool("K", 7, true), roster, mayLeave: () => true, forcedDrop: never, priorityFree: true, claimTaken: true });
    expect(d.how).toBe("wait");
  });
  test("a free kicker who plays is taken over a better one on waivers", () => {
    const all = pool("K", 7, true);
    const free = all.filter((p) => p.bye !== 7 && p.weekPoints > 0).sort((a, b) => a.value - b.value)[0]!;
    const mixed = all.map((p) => (p.name === free.name ? { ...p, onWaivers: false } : p));
    const d = planStream({ need: K7, week: 6, openBenchSlots: 1, pool: mixed, roster, mayLeave: () => true, forcedDrop: never, priorityFree: true, claimTaken: true });
    expect(d).toMatchObject({ how: "open-slot", add: free.name, onWaivers: false });
  });
  test("nothing else wants the claim: the later week's stream claims as before", () => {
    const d = planStream({ need: K7, week: 6, openBenchSlots: 1, pool: pool("K", 7, true), roster, mayLeave: () => true, forcedDrop: never, priorityFree: true, claimTaken: false });
    expect(d.how).toBe("open-slot");
    expect(d.onWaivers).toBe(true);
  });
  test("in the need week the claim goes, spoken for or not", () => {
    const d = planStream({ need: K7, week: 7, openBenchSlots: 1, pool: pool("K", 7, true), roster, mayLeave: () => true, forcedDrop: never, priorityFree: true, claimTaken: true });
    expect(d.how).toBe("open-slot");
    expect(d.onWaivers).toBe(true);
  });
  test("a scarce position's cut for a later week yields the same way", () => {
    const need: StreamNeed = { week: 6, position: "TE", coveringFor: ["Sam LaPorta"] };
    const thin = roster.filter((p) => p.position !== "TE" || p.name === "Sam LaPorta");
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool("TE", 6, true), roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle", claimTaken: true });
    expect(d.how).toBe("wait");
    const now = planStream({ need, week: 6, openBenchSlots: 0, pool: pool("TE", 6, true), roster: thin, mayLeave: () => true, forcedDrop: () => "Rico Dowdle", claimTaken: true });
    expect(now.how).toBe("cut");
  });
});
