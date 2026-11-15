// Replay of Sunday 2026-11-15 09:15 ET (week 10) on the league as captured
// at 09:21 ET (incidents/league-2026-11-15.json), for the defect the daily
// review filed at 09:20. The shadow planner wanted Zach Charbonnet (SEA RB,
// 86 ROS, 12.4 that week) as a one-week rental for Travis Etienne (79 ROS,
// bench): "+2.2 this week". The 2.2 was Charbonnet against Stefon Diggs
// (10.2), who had played on Thursday and was locked in his WR slot. The only
// slot Charbonnet could still take was a FLEX, over Wan'Dale Robinson
// (11.4): +1.0, under the rental bar of 2.0; and the season swap was +0.8 a
// week, under the bench-swap bar of 1.0. The rule calls for no move.
// The rule now (waivers.ts weekLineupGain): a starter whose game has kicked
// off holds his slot in both solves, a kicked-off bench body cannot come
// in, and the newcomer counts only in a slot still open.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, weekLineupGain, weekLockOf, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-11-15.json";
import { weeksLeft } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
const starters = mine.starters.map((id) => fx(id).name);
const out = (p: { injuryStatus: string | null }): boolean => ["OUT", "IR", "DOUBTFUL"].includes((p.injuryStatus ?? "").toUpperCase());
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, out(p) ? 0 : p.weekly["10"] ?? 0);
const plays = (body: RailPlayer): boolean => (weekPoints.get(body.name) ?? 0) > 0;
/** Sunday 09:15 ET: of ours only WAS has played (Thursday). */
const thursday = weekLockOf(mine.starters, SLOTS.length, active, (p) => p.name === "Stefon Diggs");
/** The state the old code saw: the same roster and numbers, no lock. */
const free: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: starters, weeksLeft: weeksLeft(10), priorityFree: true, weekPoints, canFill: plays,
};
const sunday: RosterState = { ...free, weekLock: thursday };
const charbonnet = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer => ({ ...tradePlayer(idOf("Zach Charbonnet")), onWaivers: false, ...extra });
const ETIENNE = "Travis Etienne Jr.";

describe("2026-11-15 09:15 ET: Charbonnet on the wire, Diggs locked at WR since Thursday", () => {
  test("the fixture is the case as filed", () => {
    expect(active).toHaveLength(16);
    expect(reserve.map((p) => p.name).sort()).toEqual(["DeVonta Smith", "Jalen Hurts"]);
    expect(SLOTS[4]).toBe("WR");
    expect(starters[4]).toBe("Stefon Diggs");
    expect(starters.slice(6, 8)).toEqual(["Ladd McConkey", "Wan'Dale Robinson"]);
    expect(weekPoints.get("Stefon Diggs")).toBe(10.2);
    expect(weekPoints.get("Wan'Dale Robinson")).toBe(11.4);
    expect(weekPoints.get("Zach Charbonnet")).toBe(12.4);
    expect(starters).not.toContain(ETIENNE);
    // The season swap is under the bench-swap bar: no swap worth a drop.
    const perWeek = (fx(idOf("Zach Charbonnet")).value - fx(idOf(ETIENNE)).value) / weeksLeft(10);
    expect(perWeek).toBeGreaterThan(0);
    expect(perWeek).toBeLessThan(DEFAULT_WAIVERS.benchSwapMarginPerWeek);
    expect(thursday.slots).toEqual(starters);
    expect([...thursday.begun]).toEqual(["Stefon Diggs"]);
  });

  test("the defect: with no lock the free solve benches Diggs and reads +2.2, a rental for Etienne", () => {
    expect(weekLineupGain(charbonnet(), ETIENNE, free)).toBe(2.2);
    const m = planOne(charbonnet(), free, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.rental).toBe(true);
    expect(m.drop).toBe(ETIENNE);
  });

  test("Diggs holds his slot: Charbonnet takes the open FLEX over Robinson, +1.0", () => {
    expect(weekLineupGain(charbonnet(), ETIENNE, sunday)).toBe(1);
    expect(weekLineupGain(charbonnet(), null, sunday)).toBe(1);
  });

  test("the move the rule calls for: none. Not a rental (+1.0 < 2.0), not a bench swap (+0.8/wk < 1.0)", () => {
    const m = planOne(charbonnet(), sunday, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.rental).toBe(false);
    // On waivers (his team kicked off) and last in the order: the same answer.
    expect(planOne(charbonnet({ onWaivers: true }), sunday, DEFAULT_WAIVERS).kind).toBe("skip");
    // With a priority to lose it is no claim either (a wait under the claim bar, nothing filed).
    const paid = planOne(charbonnet({ onWaivers: true }), { ...sunday, priorityFree: false }, DEFAULT_WAIVERS);
    expect(paid.kind).toBe("wait");
    expect(paid.priorityWorthy).toBe(false);
    expect(paid.rental).toBe(false);
  });

  test("the whole board that morning: nobody is rented in against a locked starter", () => {
    const wire = ["QB", "RB", "WR", "TE"].flatMap((pos) => availableAt(pos)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }));
    const moves = planWaivers(wire, sunday, DEFAULT_WAIVERS);
    expect(moves.filter((m) => m.rental)).toEqual([]);
    expect(moves.filter((m) => m.kind === "free-add" || m.kind === "waiver-claim").map((m) => m.add)).toEqual([]);
  });

  test("a rental that clears the bar in an open slot still goes: Charbonnet at 13.5 is +2.1 over Robinson", () => {
    const hot = { ...sunday, weekPoints: new Map([...weekPoints, ["Zach Charbonnet", 13.5]]) };
    expect(weekLineupGain(charbonnet(), ETIENNE, hot)).toBe(2.1);
    const m = planOne(charbonnet(), hot, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.rental).toBe(true);
    expect(m.drop).toBe(ETIENNE);
    expect(m.weekGainPts).toBe(2.1);
  });
});

describe("the week wait under the lock", () => {
  // A newcomer the season justifies: Charbonnet at 110 ROS, 30 over Etienne.
  const strong = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer => charbonnet({ points: 110, seasonPoints: 240, ...extra });

  test("the cut is a bench man whose week is open and who would not start: the swap goes", () => {
    const m = planOne(strong(), sunday, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe(ETIENNE);
    expect(m.rental).toBe(false);
    expect(m.weekGainPts).toBe(1);
  });

  test("the cut of a starter who has played is still held for his week, as before the lock", () => {
    // Robinson (FLEX, TEN) has played and is the cheapest cut the newcomer is given.
    const lock = weekLockOf(mine.starters, SLOTS.length, active, (p) => p.name === "Stefon Diggs" || p.name === "Wan'Dale Robinson");
    const state = { ...sunday, weekLock: lock };
    expect(weekLineupGain(strong(), "Wan'Dale Robinson", state)).toBe(Math.round((12.4 - 11.6 - 11.4) * 10) / 10);
    expect(weekLineupGain(strong(), "Wan'Dale Robinson", state)).toBeLessThan(0);
  });

  test("a newcomer with nothing this week who costs an open starter: negative, the wait holds", () => {
    const zero = { ...sunday, weekPoints: new Map([...weekPoints, ["Zach Charbonnet", 0]]) };
    expect(weekLineupGain(strong(), "Wan'Dale Robinson", zero)).toBe(-1.6);
  });
});

describe("the lock in the week solve", () => {
  test("before any kickoff the lock changes nothing", () => {
    const none = weekLockOf(mine.starters, SLOTS.length, active, () => false);
    expect(none.begun.size).toBe(0);
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, weekLock: none })).toBe(weekLineupGain(charbonnet(), ETIENNE, free));
  });

  test("Monday: every starter but McConkey (Monday night) has played; the one open FLEX is his, 12.4 over 11.6 = +0.8", () => {
    const monday = weekLockOf(mine.starters, SLOTS.length, active, (p) => p.name !== "Ladd McConkey");
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, weekLock: monday })).toBe(0.8);
  });

  test("no open slot takes him: every starter has played, the gain is 0", () => {
    const all = weekLockOf(mine.starters, SLOTS.length, active, () => true);
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, weekLock: all })).toBe(0);
    // A kicker's and a defense's slots are open, the skill slots are not: a back gains nothing.
    const skill = weekLockOf(mine.starters, SLOTS.length, active, (p) => !["K", "DEF"].includes(p.position));
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, weekLock: skill })).toBe(0);
  });

  test("a bench body whose game has kicked off cannot come in: he is not the baseline's FLEX", () => {
    // Meyers at 14, were he free to move, takes a FLEX from Robinson and cuts the gain to 12.4 - 11.6 = 0.8.
    const wp = new Map([...weekPoints, ["Jakobi Meyers", 14]]);
    const lock = weekLockOf(mine.starters, SLOTS.length, active, (p) => p.name === "Stefon Diggs" || p.name === "Jakobi Meyers");
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...sunday, weekPoints: wp })).toBe(0.8);
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, weekPoints: wp, weekLock: lock })).toBe(1);
    // Dropping him costs the week nothing: his points were never coming in.
    expect(weekLineupGain(charbonnet(), "Jakobi Meyers", { ...free, weekPoints: wp, weekLock: lock })).toBe(1);
  });

  test("the drop of a starter who has played still costs the week his points, and nobody takes his slot: the week wait holds it", () => {
    // Charbonnet +1.0 in the open FLEX, Diggs's 10.2 gone with his slot.
    expect(weekLineupGain(charbonnet(), "Stefon Diggs", sunday)).toBe(-9.2);
    // The free solve let Charbonnet stand in for him: the same 2.2 as for any bench drop.
    expect(weekLineupGain(charbonnet(), "Stefon Diggs", free)).toBe(2.2);
  });

  test("an open starter's drop still costs the week: Charbonnet for Robinson is 12.4 in, 11.4 out, Meyers 9.8 up", () => {
    // FLEX after: Charbonnet 12.4, McConkey 11.6; before: McConkey 11.6, Robinson 11.4.
    expect(weekLineupGain(charbonnet(), "Wan'Dale Robinson", sunday)).toBe(1);
    // A newcomer with nothing this week: Robinson out, Meyers in, 9.8 - 11.4.
    expect(weekLineupGain(charbonnet(), "Wan'Dale Robinson", { ...sunday, weekPoints: new Map([...weekPoints, ["Zach Charbonnet", 0]]) })).toBe(-1.6);
  });

  test("weekLockOf: an empty slot, a man no longer on the active roster and a short leg are open slots", () => {
    const ids = [...mine.starters];
    ids[4] = "0";
    ids[5] = "not-ours";
    const lock = weekLockOf(ids.slice(0, 9), SLOTS.length, active, () => true);
    expect(lock.slots).toHaveLength(SLOTS.length);
    expect(lock.slots[4]).toBeNull();
    expect(lock.slots[5]).toBeNull();
    expect(lock.slots[9]).toBeNull();
    expect(lock.slots[0]).toBe(starters[0]);
  });

  test("a played starter off the planning roster (given in a trade under review) still holds his slot on the leg", () => {
    const gone = active.filter((p) => p.name !== "Stefon Diggs");
    // Free, his WR slot went to McConkey and Meyers (9.8) was the FLEX to beat: +2.6.
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, roster: gone })).toBe(2.6);
    // The lock is named from the live roster as well as the planning one.
    const lock = weekLockOf(mine.starters, SLOTS.length, [...gone, { playerId: idOf("Stefon Diggs"), name: "Stefon Diggs" }], (p) => p.name === "Stefon Diggs");
    expect(lock.slots[4]).toBe("Stefon Diggs");
    expect(weekLineupGain(charbonnet(), ETIENNE, { ...free, roster: gone, weekLock: lock })).toBe(1);
    expect(planOne(charbonnet(), { ...free, roster: gone, weekLock: lock }, DEFAULT_WAIVERS).kind).toBe("skip");
  });

  test("a defense is locked by its team code, and a slot named twice is closed twice and charged once", () => {
    const def = weekLockOf(mine.starters, SLOTS.length, active, (p) => p.playerId === "SEA");
    expect([...def.begun]).toEqual(["Seattle Seahawks"]);
    expect(weekLineupGain(charbonnet(), "Seattle Seahawks", { ...free, weekLock: def })).toBe(Math.round((2.2 - weekPoints.get("Seattle Seahawks")!) * 10) / 10);
    const ids = [...mine.starters];
    ids[6] = ids[4]!;
    const twice = weekLockOf(ids, SLOTS.length, active, (p) => p.name === "Stefon Diggs");
    // One FLEX left: Charbonnet 12.4 over McConkey 11.6, less Diggs's 10.2 once.
    expect(weekLineupGain(charbonnet(), "Stefon Diggs", { ...free, weekLock: twice })).toBe(-9.4);
  });
});
