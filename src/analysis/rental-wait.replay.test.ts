// Replay of Friday 2026-10-09 on the league as captured on 2026-10-07
// (incidents/league-2026-10-07.json), for the defect filed that night. At
// 18:58 ET the bot stashed DeVonta Smith (Out) on IR and rented Romeo Doubs
// (NE WR, 102 ROS) into the seat for +2.3 in week 5; the guard started him
// at FLEX over Josh Downs. In the same run's next round it planned Jakobi
// Meyers (JAX WR, 124 ROS, 8.8 that week) for Doubs as a bench upgrade of
// +20 ROS with a week gain of -2.3, and 31 minutes later it cut Doubs before
// his Sunday game. The Monday run would have made the same swap for nothing.
// The rule now (waivers.ts verdict): a free add that lowers this week's
// lineup by cutting a man who plays for us this week waits for the week;
// once it is over (the week flips, his points no longer count) the drop
// costs the week nothing and goes. Golden for Downs, which lifts the week,
// goes at once. A claim is never held.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, weekLineupGain, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-07.json";
import { weeksLeft } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const SMITH = idOf("DeVonta Smith");
const DOUBS = idOf("Romeo Doubs");
/** Friday evening: Smith (Out) on IR beside Etienne, Doubs rented into his seat. Sixteen active. */
const active: RailPlayer[] = [...mine.players.filter((id) => !mine.reserve.includes(id) && id !== SMITH).map((id) => tradePlayer(id, { onIr: false })), tradePlayer(DOUBS, { onIr: false })];
const reserve: RailPlayer[] = [...mine.reserve.map((id) => tradePlayer(id, { onIr: true })), tradePlayer(SMITH, { onIr: true, injuryStatus: "Out" })];
const starters = mine.starters.map((id) => fx(id).name);
/** The leg as the guard wrote it at 19:00 ET: Doubs at FLEX for Downs. */
const legDoubs = starters.map((n) => (n === "Josh Downs" ? "Romeo Doubs" : n));
const wk = (p: { playerId?: string }, week = "5"): number => (p.playerId ? (fx(p.playerId).weekly[week] ?? 0) : 0);
const plays = (body: RailPlayer): boolean => wk(body) > 0;
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, p.name === "DeVonta Smith" ? 0 : p.weekly["5"] ?? 0);
const before: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: legDoubs, weeksLeft: weeksLeft(5), priorityFree: false, weekPoints, canFill: plays,
};
/** Wednesday: the week has flipped to 6, Doubs's week-5 points are banked; week-6 numbers (Meyers 10.4, Doubs 8.5). */
const wp6 = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) wp6.set(p.name, p.name === "DeVonta Smith" ? 0 : p.weekly["6"] ?? 0);
const leg6 = ["Dak Prescott", "Christian McCaffrey", "Kenneth Walker", "Nico Collins", "Mike Evans", "Mark Andrews", "RJ Harvey", "Romeo Doubs", "Jake Bates", "Jacksonville Jaguars"];
const after: RosterState = { ...before, currentStarters: leg6, weeksLeft: weeksLeft(6), weekPoints: wp6, canFill: (b) => wk(b, "6") > 0 };
const meyers = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer => ({ ...tradePlayer(idOf("Jakobi Meyers")), onWaivers: false, ...extra });

describe("2026-10-09 18:58 ET: Doubs rented and starting, Meyers on the wire", () => {
  test("the fixture is the case as filed", () => {
    expect(active).toHaveLength(16);
    expect(active.map((p) => p.name)).toContain("Romeo Doubs");
    expect(reserve.map((p) => p.name)).toEqual(["Travis Etienne", "DeVonta Smith"]);
    expect(fx(idOf("Jakobi Meyers")).value - fx(DOUBS).value).toBeGreaterThan(DEFAULT_WAIVERS.benchSwapMarginPerWeek * weeksLeft(5));
    expect(wk({ playerId: idOf("Jakobi Meyers") })).toBeLessThan(wk({ playerId: DOUBS }));
    expect(weekLineupGain(meyers(), "Romeo Doubs", before)).toBeLessThan(0);
  });

  test("while Doubs plays for us the swap waits: a wait naming his week, drop Doubs, nothing written", () => {
    const m = planOne(meyers(), before, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Romeo Doubs");
    expect(m.weekGainPts).toBeLessThan(0);
    expect(m.reason).toContain("wait for Romeo Doubs's week");
    expect(m.reason).toContain("by ");
    expect(m.priorityWorthy).toBe(false);
  });

  test("once the week is over the same swap goes: free add Meyers, drop Doubs, bench +22.5", () => {
    const m = planOne(meyers(), after, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Romeo Doubs");
    expect(m.benchGainPts).toBe(22.5);
    expect(m.rental).toBe(false);
    expect(m.weekGainPts).toBeGreaterThanOrEqual(0);
  });

  test("Doubs on the bench but starting on the week plan: the same wait (the 22:58Z round-two plan, before the guard wrote the leg)", () => {
    const m = planOne(meyers(), { ...before, currentStarters: starters }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Romeo Doubs");
  });

  test("a newcomer with nothing this week (bye) still costs the week what the drop costs: the wait holds", () => {
    const bye = meyers({ bye: 5 });
    const m = planOne(bye, { ...before, weekPoints: new Map([...weekPoints, ["Jakobi Meyers", 0]]) }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Romeo Doubs");
    expect(weekLineupGain(bye, "Romeo Doubs", { ...before, weekPoints: new Map([...weekPoints, ["Jakobi Meyers", 0]]) })).toBeLessThan(0);
  });

  test("on waivers the move is a wait either way (under the claim bar); the drop is still Doubs", () => {
    const m = planOne(meyers({ onWaivers: true }), before, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Romeo Doubs");
  });

  test("a claim is never held for the week: a priority-worthy claim with the same drop is filed, since its drop lands at the clear", () => {
    const star = meyers({ onWaivers: true, points: 200, seasonPoints: 240 });
    const m = planOne(star, { ...before, weekPoints: new Map([...weekPoints, ["Jakobi Meyers", 8.8]]) }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.priorityWorthy).toBe(true);
    // The same man off waivers before the week is over: the free add waits.
    const free = planOne({ ...star, onWaivers: false }, { ...before, weekPoints: new Map([...weekPoints, ["Jakobi Meyers", 8.8]]) }, DEFAULT_WAIVERS);
    expect(free.kind === "wait" || free.weekGainPts >= 0).toBe(true);
  });

  test("the whole board before Sunday: no free add drops a man who plays this week for a worse week", () => {
    const wire = ["QB", "RB", "WR", "TE"].flatMap((pos) => availableAt(pos)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }));
    const moves = planWaivers(wire, before, DEFAULT_WAIVERS);
    for (const m of moves.filter((x) => x.kind === "free-add" && x.drop)) {
      expect(m.weekGainPts >= 0 || (weekPoints.get(m.drop!) ?? 0) === 0).toBe(true);
    }
  });
});

describe("week 6: Golden for Downs still goes at once when he lifts the week", () => {
  const active6: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
  const reserve6: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
  const leg6b = ["Dak Prescott", "Christian McCaffrey", "Kenneth Walker", "Nico Collins", "Mike Evans", "Mark Andrews", "RJ Harvey", "Josh Downs", "Jake Bates", "Jacksonville Jaguars"];
  const wp6 = new Map<string, number>();
  for (const p of Object.values(LEAGUE.players)) wp6.set(p.name, p.weekly["6"] ?? 0);
  const state6: RosterState = {
    roster: active6, reserve: reserve6, openBenchSlots: 0, openIrSlots: 1, startingSlots: SLOTS, irEligible,
    currentStarters: leg6b, weeksLeft: weeksLeft(6), priorityFree: false, weekPoints: wp6, canFill: (b) => wk(b, "6") > 0,
  };
  const golden = (): AvailablePlayer => ({ ...tradePlayer(idOf("Matthew Golden")), onWaivers: false });

  test("Golden 14.3 against Downs 12 on the leg: free add now", () => {
    const m = planOne(golden(), state6, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Josh Downs");
    expect(m.weekGainPts).toBeGreaterThan(0);
  });

  test("Golden at 10.0 that week against Downs 12 on the leg: waits for Downs's week; with Downs's week over (no points) it goes", () => {
    const low = { ...state6, weekPoints: new Map([...wp6, ["Matthew Golden", 10]]) };
    const m = planOne(golden(), low, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Josh Downs");
    expect(m.reason).toContain("wait for Josh Downs's week");
    const over = planOne(golden(), { ...low, weekPoints: new Map([...low.weekPoints, ["Josh Downs", 0]]) }, DEFAULT_WAIVERS);
    expect(over.kind).toBe("free-add");
    expect(over.drop).toBe("Josh Downs");
  });
});
