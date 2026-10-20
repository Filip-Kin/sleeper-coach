// Replay of Tuesday 2026-10-20 (week 7) on the league as captured that
// morning (incidents/league-2026-10-20.json), read as it stood BEFORE the
// hand claim of 09:24: the Jaguars (DEF, bye week 7, the spare behind
// Seattle) still ours, Bo Nix on waivers (DEN played Sunday), the week-6
// bye teams' men locked until the clear, and we last in the order so a
// claim costs nothing.
//
// Two moves wanted the Jaguars' seat. The planner's claim: Nix for the
// Jaguars, a one-week rental (+3.7 at QB over Prescott in week 7). The
// stream: Butker for the Jaguars, a swap for the week-8 kicker hole
// (Fairbairn on bye), via a claim because Butker was on waivers. The live
// run filed the stream first and marked the cycle's single claim used, so
// Butker would have been claimed tonight and Nix never: nothing gained (four
// free kickers play week 8 after Wednesday's clear) and 3.7 points lost.
//
// The rule now (streaming.ts planStream `claimTaken`): a stream for a need
// in a LATER week yields the cycle's claim to any this-week move and takes a
// free body or waits for the free-agent run after the clear. It claims only
// in the need week itself, or when nothing else wants the claim.
import { describe, expect, test } from "bun:test";
import { planWaivers, bestClaim, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { planStream, streamNeeds, type StreamPoolPlayer, type StreamNeed } from "./streaming.ts";
import { keptStarters } from "./roster-fit.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-20.json";
import { weeksLeft } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
const starters = mine.starters.map((id) => fx(id).name);
// Before the hand claim: the pool is everyone on no roster, the pending
// claim's add included (openFixture's availableAt holds him out).
const taken = new Set(LEAGUE.rosters.flatMap((r) => r.players));
const unrostered = Object.values(LEAGUE.players).filter((p) => !taken.has(p.playerId) && p.value > 0);
const wk = (p: { playerId?: string }, week = "7"): number => (p.playerId ? (fx(p.playerId).weekly[week] ?? 0) : 0);
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, p.weekly["7"] ?? 0);
const canFill = (b: RailPlayer): boolean => wk(b) > 0;
// Tuesday: every man whose team played week 6 is on waivers until the
// Wednesday clear; a week-6 bye team's man is locked (waiverState).
interface Day { onWaivers: (bye: number | null) => boolean; locked: (bye: number | null) => boolean }
const tuesday: Day = { onWaivers: (bye) => bye !== 6, locked: (bye) => bye === 6 };
const wednesday: Day = { onWaivers: () => false, locked: () => false };
// Tuesday of week 8: the week-7 slate has played, its bye teams are locked.
const tuesdayWeek8: Day = { onWaivers: (bye) => bye !== 7, locked: (bye) => bye === 7 };
// We are last in the rolling order, so a claim costs nothing.
const priorityFree = (LEAGUE.waiverPositions?.[String(LEAGUE.ourRosterId)] ?? 0) >= LEAGUE.rosters.length;
const stateFor = (roster: RailPlayer[], week: number): RosterState => ({
  roster, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: starters, weeksLeft: weeksLeft(week), priorityFree, weekPoints, canFill,
});
const availableFor = (roster: RailPlayer[], day: Day): AvailablePlayer[] => {
  const ours = new Set(roster.map((p) => p.name));
  return unrostered.filter((p) => !ours.has(p.name)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: day.onWaivers(p.bye), locked: day.locked(p.bye) }));
};
const poolFor = (roster: RailPlayer[], need: StreamNeed, day: Day): StreamPoolPlayer[] => {
  const ours = new Set(roster.map((p) => p.name));
  return unrostered.filter((p) => p.position === need.position && !ours.has(p.name)).map((p) => ({
    playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly[String(need.week)] ?? 0,
    onWaivers: day.onWaivers(p.bye), locked: day.locked(p.bye), value: p.value,
  }));
};
const never = (): string | null => { throw new Error("a swap position must not ask for a forced drop"); };
const K8: StreamNeed = { week: 8, position: "K", coveringFor: ["Ka'imi Fairbairn"] };
const stream = (roster: RailPlayer[], week: number, day: Day, claimTaken: boolean) =>
  planStream({ need: K8, week, openBenchSlots: 0, pool: poolFor(roster, K8, day), roster, mayLeave: () => true, forcedDrop: never, currentStarters: starters, kept: keptStarters(starters, roster, canFill), priorityFree, claimTaken });

describe("2026-10-20, Tuesday of week 7: the week-8 kicker stream and the Nix rental both want the Jaguars' seat", () => {
  test("the fixture is the case as filed", () => {
    expect(LEAGUE.week).toBe(7);
    expect(LEAGUE.waiverPositions?.["3"]).toBe(8);
    expect(priorityFree).toBe(true);
    expect(active).toHaveLength(16);
    expect(active.map((p) => p.name)).toContain("Jacksonville Jaguars");
    expect(fx("JAX").bye).toBe(7);
    expect(fx(idOf("Bo Nix")).weekly["7"]).toBeGreaterThan(fx(idOf("Dak Prescott")).weekly["7"]!);
    expect(fx(idOf("Ka'imi Fairbairn")).bye).toBe(8);
    expect(streamNeeds(active, 7, 2)).toEqual([K8]);
    // Butker (KC played) is on waivers; Reichard, McPherson and Bates (bye 6) are locked.
    const pool = poolFor(active, K8, tuesday);
    expect(pool.find((p) => p.name === "Harrison Butker")).toMatchObject({ onWaivers: true, locked: false });
    expect(pool.filter((p) => p.locked).map((p) => p.name).sort()).toEqual(["Evan McPherson", "Jake Bates", "Will Reichard"]);
  });

  test("the planner's claim is this week's move: Nix for the Jaguars, a rental", () => {
    const claim = bestClaim(planWaivers(availableFor(active, tuesday), stateFor(active, 7), DEFAULT_WAIVERS));
    expect(claim).not.toBeNull();
    expect(claim!.add).toBe("Bo Nix");
    expect(claim!.drop).toBe("Jacksonville Jaguars");
    expect(claim!.rental).toBe(true);
    expect(claim!.weekGainPts).toBeGreaterThanOrEqual(DEFAULT_WAIVERS.weekRentalMinPts);
  });

  test("as filed: with the claim unspoken for, the stream swaps the Jaguars for Butker by a claim, a week early", () => {
    const d = stream(active, 7, tuesday, false);
    expect(d).toMatchObject({ how: "swap", add: "Harrison Butker", drop: "Jacksonville Jaguars", onWaivers: true });
  });

  test("the rule: the cycle's claim is Nix's, so the week-8 stream waits for the clear and files nothing", () => {
    const d = stream(active, 7, tuesday, true);
    expect(d.how).toBe("wait");
    expect(d.add).toBeNull();
    expect(d.drop).toBeNull();
    expect(d.onWaivers).toBe(false);
    expect(d.reason).toContain("this week's claim");
    expect(d.reason).toContain("free-agent run");
  });

  test("a free kicker who plays week 8 would still be swapped in for the spare, claim or no claim", () => {
    const pool = poolFor(active, K8, tuesday).map((p) => (p.name === "Cairo Santos" ? { ...p, onWaivers: false } : p));
    const d = planStream({ need: K8, week: 7, openBenchSlots: 0, pool, roster: active, mayLeave: () => true, forcedDrop: never, currentStarters: starters, kept: keptStarters(starters, active, canFill), priorityFree, claimTaken: true });
    expect(d).toMatchObject({ how: "swap", add: "Cairo Santos", drop: "Jacksonville Jaguars", onWaivers: false });
  });

  const nix = tradePlayer(idOf("Bo Nix"));
  const afterNix: RailPlayer[] = [...active.filter((p) => p.name !== "Jacksonville Jaguars"), nix];

  test("Wednesday, Nix landed: no claim, and the week-8 swap waits for the need week (Fairbairn plays week 7)", () => {
    expect(bestClaim(planWaivers(availableFor(afterNix, wednesday), stateFor(afterNix, 7), DEFAULT_WAIVERS))).toBeNull();
    const d = stream(afterNix, 7, wednesday, false);
    expect(d.how).toBe("wait");
    expect(d.reason).toContain("week 8 itself");
  });

  test("week 8's run: Fairbairn is swapped for the best free kicker who plays, Reichard, as a free add", () => {
    const d = stream(afterNix, 8, wednesday, false);
    expect(d).toMatchObject({ how: "swap", add: "Will Reichard", drop: "Ka'imi Fairbairn", onWaivers: false });
    expect(fx(idOf("Will Reichard")).weekly["8"]).toBeGreaterThan(0);
  });

  test("Tuesday of week 8, the need week: the stream claims even with this week's claim spoken for; an empty slot outranks it", () => {
    const d = stream(afterNix, 8, tuesdayWeek8, true);
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Ka'imi Fairbairn");
    expect(d.onWaivers).toBe(true);
  });
});
