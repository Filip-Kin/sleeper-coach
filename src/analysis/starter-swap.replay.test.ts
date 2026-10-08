// Replay of the week-6 waiver board on the league as captured on 2026-10-07
// (incidents/league-2026-10-07.json). Matthew Golden (GB WR, 154 ROS) is on
// waivers until Wednesday 14 Oct; Josh Downs (136) is a bench receiver on the
// one value (the rest-of-season lineup starts Brown and Smith at FLEX) who
// starts for us in week 6 only because Brown is on bye. The deployed planner
// read every name on the leg as untouchable (R7), so Golden's only path was
// "drop Dowdle" at +0 lineup and +0 bench, and the swap the value rule calls
// for (Filip, 2026-09-30: "if an available player's rest-of-season average
// beats a bench player's, make that swap") was never offered. The rule now:
// a starter is kept from the newcomer's drop paths only while the newcomer
// cannot fill his slot this week; a same-position body who is better on the
// one value and plays this week may replace him, with every bar unchanged.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-07.json";
import { keptStarters } from "./roster-fit.ts";
import { weeksLeft } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
/** The week-6 leg as the guard sets it: Walker back for Brown (bye), Andrews for LaPorta (bye), Bates (bye, no row) kept in his slot, Downs still at FLEX. */
const leg6 = ["Dak Prescott", "Christian McCaffrey", "Kenneth Walker", "Nico Collins", "Mike Evans", "Mark Andrews", "RJ Harvey", "Josh Downs", "Jake Bates", "Jacksonville Jaguars"];
const week6 = (p: { playerId?: string }): number => (p.playerId ? (fx(p.playerId).weekly["6"] ?? 0) : 0);
/** The week-6 table: a body, ours or arriving, can take a slot when his projection for the week is above zero. */
const plays6 = (body: RailPlayer): boolean => week6(body) > 0;
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, p.weekly["6"] ?? 0);
const state: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 1, startingSlots: SLOTS, irEligible,
  currentStarters: leg6, weeksLeft: weeksLeft(6), priorityFree: false, weekPoints, canFill: plays6,
};
const golden = (onWaivers: boolean): AvailablePlayer => ({ ...tradePlayer(idOf("Matthew Golden")), onWaivers });
/** The wire as the live run slices it (waiver-run.ts MAX_CANDIDATES by value over replacement): skill positions; kickers and defenses are the streamer's. */
const wire = (): AvailablePlayer[] => ["QB", "RB", "WR", "TE"].flatMap((pos) => availableAt(pos)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }));

describe("2026-10-14, week 6: Golden clears, Downs starts at FLEX for Brown", () => {
  test("the fixture is the case as filed", () => {
    expect(fx(idOf("Matthew Golden")).value).toBeGreaterThan(fx(idOf("Josh Downs")).value);
    expect(week6({ playerId: idOf("Matthew Golden") })).toBeGreaterThan(0);
    expect(leg6).toContain("Josh Downs");
    expect(active.filter((p) => p.position === "WR" && p.points < fx(idOf("Matthew Golden")).value).map((p) => p.name)).toEqual(["Josh Downs"]);
  });

  test("Downs is not kept from a receiver who beats him and plays this week; he is kept from a back, a quarterback, or a receiver with no game", () => {
    const g = golden(false);
    expect(keptStarters(leg6, active, plays6, g)).not.toContain("Josh Downs");
    expect(keptStarters(leg6, active, plays6, { ...g, position: "RB" })).toContain("Josh Downs");
    expect(keptStarters(leg6, active, plays6, { ...g, position: "QB" })).toContain("Josh Downs");
    expect(keptStarters(leg6, active, () => false, g)).toContain("Josh Downs");
    expect(keptStarters(leg6, active, plays6, { ...g, points: 130 })).toContain("Josh Downs");
    // Every other starter is kept: nobody on the wire beats them at their position this week but the Jaguars' own rule.
    expect(keptStarters(leg6, active, plays6, g)).toEqual(leg6.filter((n) => n !== "Josh Downs" && n !== "Jacksonville Jaguars"));
  });

  test("off waivers he is a free add for Downs: a bench upgrade of 18 ROS, 1.5 a game", () => {
    const m = planOne(golden(false), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Josh Downs");
    expect(m.dropPath).toBe("drop");
    expect(m.gainPts).toBe(0);
    expect(m.benchGainPts).toBe(18.1);
    expect(m.rental).toBe(false);
  });

  test("on waivers the same move is a wait: 18 ROS is under the claim bar and the priority is not free", () => {
    const m = planOne(golden(true), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBe("Josh Downs");
  });

  test("the defect as filed: with nobody able to fill a slot the only path is Dowdle at +0 and the add is skipped", () => {
    const m = planOne(golden(false), { ...state, canFill: undefined }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.reason).toContain("drop Rico Dowdle");
  });

  test("the whole board: Golden for Downs is the one free add; no starter but Downs is anyone's drop", () => {
    const moves = planWaivers(wire(), state, DEFAULT_WAIVERS);
    const adds = moves.filter((m) => m.kind === "free-add");
    expect(adds.map((m) => `${m.add} / ${m.drop}`)).toEqual(["Matthew Golden / Josh Downs"]);
    for (const m of moves) if (m.drop && leg6.includes(m.drop)) expect(m.drop).toBe("Josh Downs");
  });

  test("the 2026-09-23 finding holds: a quarterback never puts a starting receiver on the table", () => {
    const willis: AvailablePlayer = { playerId: "x-qb", name: "Malik Willis", position: "QB", points: 150, seasonPoints: 160, onWaivers: false };
    const m = planOne(willis, { ...state, canFill: () => true }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.drop).toBeNull();
    // Even a quarterback worth a starter's slot costs the cheapest cut overall (the rental defense, since b248a61),
    // never a back, receiver or tight end on the leg.
    const star: AvailablePlayer = { ...willis, points: 260, seasonPoints: 320 };
    const s = planOne(star, { ...state, canFill: () => true }, DEFAULT_WAIVERS);
    expect(s.drop).toBe("Jacksonville Jaguars");
  });

  test("a one-week body never rents the seat of a protected starter: a receiver 4 ROS over Downs with an 18-point week is no move", () => {
    const flash: AvailablePlayer = { playerId: "x-flash", name: "Flash Receiver", position: "WR", points: 140, seasonPoints: 170, onWaivers: false };
    const m = planOne(flash, { ...state, canFill: () => true, weekPoints: new Map([...weekPoints, ["Flash Receiver", 18]]) }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.rental).toBe(false);
  });

  test("a receiver who starts for us costs the cheapest legal cut, the rental, never the starters he also beats", () => {
    // Better than Evans (175) and Downs: he starts, so every drop gains the lineup the same and the cut order decides
    // (bench-upgrade.test.ts). Since b248a61 that is the Jaguars; Evans and Downs stay.
    const star: AvailablePlayer = { playerId: "x-wr", name: "Some Receiver", position: "WR", points: 180, seasonPoints: 230, onWaivers: false };
    const m = planOne(star, { ...state, canFill: () => true }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.gainPts).toBeGreaterThan(0);
    expect(m.drop).toBe("Jacksonville Jaguars");
  });
});
