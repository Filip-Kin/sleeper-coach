// Replay of the free add of 2026-10-30 12:17 ET (week 8) on the league as
// captured on 2026-10-31 (incidents/league-2026-10-31.json), for the defect
// filed 2026-10-31: Jonah Coleman (DEN RB, healthy, 64 on the season, RB59)
// was added for RJ Harvey (DEN RB, 144 on the season, RB37) the day Harvey
// was ruled Out with a knee the Denver Post called "not believed to be
// severe". Harvey's ONE value went 94 -> 82 -> 74 on that one designation
// (his week came out of the feed) and Coleman's, his own backup, rose to
// 100; the gap cleared the bench bar (1.0 a week, ~10 ROS) on a number that
// swung on a news feed. Filip, 2026-09-30: "If the numbers you are checking
// can swing, a player is the weakest one day and the strongest the next day,
// then you're checking the wrong numbers." A drop is for the season.
// The rule now, symmetric with the newcomer's stable check (pup-newcomer):
// a swap whose CUT is a man not playing this week (value.ts NOT_PLAYING)
// holds on the full-season projection too, by the same per-week bar over
// the season; otherwise it waits for the Tuesday re-rate, like the week
// wait. A kicker or defense is never held: his swap is the stream's.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-31.json";
import { weeksLeft, notPlaying, LAST_WEEK } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
/** The roster of the evening of 2026-10-29: Harvey still ours, Coleman on the wire. */
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id))
  .map((id) => (id === idOf("Jonah Coleman") ? tradePlayer(idOf("RJ Harvey"), { onIr: false }) : tradePlayer(id, { onIr: false })));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
/** The week-8 leg as the guard had set it on 10-28 (Harvey benched for Smith). */
const leg8 = ["Dak Prescott", "Kenneth Walker III", "Chase Brown", "Stefon Diggs", "Chris Godwin Jr.", "Sam LaPorta", "DeVonta Smith", "Jakobi Meyers", "Evan McPherson", "Seattle Seahawks"];
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, notPlaying(p.injuryStatus) ? 0 : p.weekly["8"] ?? 0);
/** Plays this week: by name, so a made-up newcomer in a test reads from the map a test extends. */
const plays8 = (body: RailPlayer): boolean => (weekPoints.get(body.name) ?? 0) > 0 && !notPlaying(body.injuryStatus);
const state: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: leg8, weeksLeft: weeksLeft(8), priorityFree: false, weekPoints, canFill: plays8,
};
const harvey = active.find((p) => p.name === "RJ Harvey")!;
const coleman = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer => ({ ...tradePlayer(idOf("Jonah Coleman")), onWaivers: false, ...extra });
const bar = DEFAULT_WAIVERS.benchSwapMarginPerWeek;

describe("2026-10-30, week 8: Coleman for Harvey on a value that moved on one knee designation", () => {
  test("the fixture is the case as filed", () => {
    expect(harvey.injuryStatus).toBe("Out");
    expect(notPlaying(harvey.injuryStatus)).toBe(true);
    expect(harvey.returnsBeforePlayoffs).toBe(false); // RB37, one rank outside the stash tier
    expect(weekPoints.get("RJ Harvey")).toBe(0); // so the week wait never applies
    expect(leg8).not.toContain("RJ Harvey");
    const c = coleman();
    // The one value clears the bar on its own: this is the move the deployed planner made.
    expect((c.points - harvey.points) / weeksLeft(8)).toBeGreaterThanOrEqual(bar);
    // The stable number says the opposite, by far more than the bar.
    expect(harvey.seasonPoints! - c.seasonPoints!).toBeGreaterThan(bar * LAST_WEEK);
  });

  test("no swap: the cut is not playing now and the season projection says he is the better man; it waits for the re-rate", () => {
    const m = planOne(coleman(), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.reason).toContain("RJ Harvey");
    expect(m.reason).toContain("not playing now (Out)");
    expect(m.reason).toContain("season projection");
    expect(m.reason).toContain("re-rate");
  });

  test("the board files no free add that cuts him", () => {
    const wire = ["QB", "RB", "WR", "TE"].flatMap((pos) => availableAt(pos)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }))
      .filter((p) => p.name !== "RJ Harvey");
    const moves = planWaivers(wire, state, DEFAULT_WAIVERS);
    expect(moves.filter((m) => m.kind === "free-add" && m.drop === "RJ Harvey")).toEqual([]);
  });

  test("on waivers he is no claim either", () => {
    const m = planOne(coleman({ onWaivers: true, points: harvey.points + 40 }), state, DEFAULT_WAIVERS);
    expect(m.kind).not.toBe("waiver-claim");
    expect(m.kind).not.toBe("free-add");
    expect(m.reason).toContain("RJ Harvey");
  });

  test("the same man healthy at the Thursday value is the swap as before: the one value decides", () => {
    const healthy = { ...harvey, injuryStatus: undefined, points: 82 };
    const st = { ...state, roster: active.map((p) => (p.name === "RJ Harvey" ? healthy : p)), weekPoints: new Map([...weekPoints, ["RJ Harvey", 0]]) };
    const m = planOne(coleman(), st, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("RJ Harvey");
  });

  test("a newcomer the season projection prefers by the bar is the swap, Out cut or not", () => {
    const m = planOne(coleman({ seasonPoints: harvey.seasonPoints! + bar * LAST_WEEK + 0.1 }), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("RJ Harvey");
  });

  test("a man on IR on the active roster is not held: that feed is the real length, nothing is left to re-rate", () => {
    const onIr = { ...harvey, injuryStatus: "IR", points: 0 };
    const st = { ...state, roster: active.map((p) => (p.name === "RJ Harvey" ? onIr : p)) };
    const m = planOne(coleman(), st, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("RJ Harvey");
  });

  test("a lineup-gain newcomer whose season beats the Out cut's by the bar goes: the gap to the cut is the quantity, not the season lineup", () => {
    // A back under the starting backs' value (so no starter is his drop path) who starts at FLEX on the feed.
    const vet = coleman({ name: "Vet Receiver", playerId: "999003", position: "RB", points: 135, seasonPoints: harvey.seasonPoints! + 26, injuryStatus: undefined, bye: 14 });
    const wp = new Map([...weekPoints, ["Vet Receiver", 14]]);
    const st = { ...state, weekPoints: wp, canFill: (b: RailPlayer) => (wp.get(b.name) ?? 0) > 0 && !notPlaying(b.injuryStatus) };
    const m = planOne(vet, st, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("RJ Harvey");
    expect(m.gainPts).toBeGreaterThanOrEqual(DEFAULT_WAIVERS.freeAddMarginPts); // the lineup path, not the bench bar
    expect(m.reason).toContain("starts for us");
  });

  test("an open seat is not held on a comparison body who is not the cut", () => {
    // Godwin, the cheapest receiver and a starter, is Out; the seat is open; the later cut is a healthy Harvey.
    const roster = active.map((p) => (p.name === "Chris Godwin Jr." ? { ...p, injuryStatus: "Out" } : p.name === "RJ Harvey" ? { ...p, injuryStatus: undefined } : p));
    const hot = coleman({ name: "Hot Receiver", playerId: "999002", position: "WR", points: 150, seasonPoints: 90, injuryStatus: undefined, bye: 14 });
    const wp = new Map([...weekPoints, ["Chris Godwin Jr.", 0], ["Hot Receiver", 0]]);
    const st = { ...state, roster, openBenchSlots: 1, currentStarters: leg8.filter((n) => n !== "Chris Godwin Jr."), weekPoints: wp, canFill: (b: RailPlayer) => (wp.get(b.name) ?? 0) > 0 && !notPlaying(b.injuryStatus) };
    const m = planOne(hot, st, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBeNull();
    expect(m.reason).not.toContain("re-rate");
  });

  test("a one-week rental does not take the seat of an Out season body either", () => {
    // A 12-point back worth less than Harvey for the season but more on the swung feed.
    const rental = coleman({ name: "Rental Back", playerId: "999001", points: harvey.points + 2, seasonPoints: 60, injuryStatus: undefined });
    const wp = new Map([...weekPoints, ["Rental Back", 12]]);
    const st = { ...state, weekPoints: wp, canFill: (b: RailPlayer) => (wp.get(b.name) ?? 0) > 0 && !notPlaying(b.injuryStatus) };
    const m = planOne(rental, st, DEFAULT_WAIVERS);
    expect(m.kind === "free-add" && m.drop === "RJ Harvey").toBe(false);
  });
});
