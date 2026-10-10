// Replay of the week-6 waiver board on the league as captured on 2026-10-07
// (incidents/league-2026-10-07.json), for the defect filed 2026-10-09: Zach
// Charbonnet (SEA RB, on PUP after ACL surgery, no game played in 2026) read
// as a bench upgrade over Rico Dowdle (PIT RB, played, 161 on the season)
// once the Tuesday feed re-rate took Dowdle's week-5 game out: 118 against
// 104 ROS, 1.2 a week, over the bar by 0.2. Charbonnet's rest-of-season feed
// assumes he plays from week 6; on the stable number he is 67 (RB55) against
// 161 (RB28). Filip, 2026-09-30: a cut uses a number that does not swing.
// The rule now: a newcomer who is not playing now (value.ts NOT_PLAYING)
// must clear the bench bar on the full-season projection too, by the same
// per-week margin over the season. A newcomer who plays is judged on the one
// value as before, so Golden for Downs (170 against 172 season) stands.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-07.json";
import { weeksLeft, notPlaying } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
/** The week-6 leg as the guard sets it (starter-swap.replay.test.ts). */
const leg6 = ["Dak Prescott", "Christian McCaffrey", "Kenneth Walker", "Nico Collins", "Mike Evans", "Mark Andrews", "RJ Harvey", "Josh Downs", "Jake Bates", "Jacksonville Jaguars"];
const week6 = (p: { playerId?: string }): number => (p.playerId ? (fx(p.playerId).weekly["6"] ?? 0) : 0);
const plays6 = (body: RailPlayer): boolean => week6(body) > 0 && !notPlaying(body.injuryStatus);
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, notPlaying(p.injuryStatus) ? 0 : p.weekly["6"] ?? 0);
const state: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: leg6, weeksLeft: weeksLeft(6), priorityFree: false, weekPoints, canFill: plays6,
};
const dowdle = active.find((p) => p.name === "Rico Dowdle")!;
/** Charbonnet after the week-6 re-rate, as the live shadow of 2026-10-09 read him: 13.9 ROS over Dowdle (1.2 a week). */
const charbonnet = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer =>
  ({ ...tradePlayer(idOf("Zach Charbonnet")), points: Math.round((dowdle.points + 13.9) * 10) / 10, onWaivers: false, ...extra });
const wire = (): AvailablePlayer[] => ["QB", "RB", "WR", "TE"].flatMap((pos) => availableAt(pos)).map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }))
  .map((p) => (p.name === "Zach Charbonnet" ? charbonnet() : p));

describe("2026-10-13, week 6: Charbonnet on PUP reads 1.2 a week over Dowdle on the feed", () => {
  test("the fixture is the case as filed", () => {
    const z = fx(idOf("Zach Charbonnet"));
    expect(z.injuryStatus).toBe("PUP");
    expect(notPlaying(z.injuryStatus)).toBe(true);
    expect(z.seasonPoints).toBeLessThan(fx(idOf("Rico Dowdle")).seasonPoints - 17);
    expect(dowdle.position).toBe("RB");
    expect(leg6).not.toContain("Rico Dowdle");
    // The one value clears the bar on its own: this is the move the deployed planner made.
    const c = charbonnet();
    expect((c.points - dowdle.points) / weeksLeft(6)).toBeGreaterThanOrEqual(DEFAULT_WAIVERS.benchSwapMarginPerWeek);
  });

  test("no swap: the feed clears the bar, the season projection does not, and he is not playing now", () => {
    const m = planOne(charbonnet(), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.drop).toBeNull();
    expect(m.reason).toContain("not playing now (PUP)");
    expect(m.reason).toContain("season projection");
    expect(m.reason).toContain("Rico Dowdle");
  });

  test("on waivers he is no claim either, whatever the feed gap", () => {
    const m = planOne(charbonnet({ onWaivers: true, points: dowdle.points + 40 }), state, DEFAULT_WAIVERS);
    expect(m.kind).not.toBe("waiver-claim");
    expect(m.kind).not.toBe("free-add");
  });

  test("the same man marked Active with a season projection above Dowdle's is the swap again", () => {
    const back = charbonnet({ injuryStatus: undefined, seasonPoints: dowdle.seasonPoints! + 20 });
    const m = planOne(back, { ...state, weekPoints: new Map([...weekPoints, ["Zach Charbonnet", 9]]) }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Rico Dowdle");
    expect(m.benchGainPts).toBe(13.9);
  });

  test("a healthy newcomer is judged on the one value alone: Active with a season projection under Dowdle's is still the swap", () => {
    const back = charbonnet({ injuryStatus: undefined });
    const m = planOne(back, { ...state, weekPoints: new Map([...weekPoints, ["Zach Charbonnet", 9]]) }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Rico Dowdle");
  });

  test("a newcomer not playing now who beats the dropped man on both numbers is a swap: an injured back worth stashing", () => {
    const star = charbonnet({ injuryStatus: "IR", seasonPoints: dowdle.seasonPoints! + 17, points: dowdle.points + 13.9 });
    const m = planOne(star, state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Rico Dowdle");
    // Under the season bar by a point: no.
    const under = charbonnet({ injuryStatus: "IR", seasonPoints: dowdle.seasonPoints! + 16 });
    expect(planOne(under, state, DEFAULT_WAIVERS).kind).toBe("skip");
  });

  test("the lineup path is held to the same number: a PUP newcomer whose feed starts him for us cuts nobody on the feed alone", () => {
    // 220 on the feed starts him at FLEX for the rest of the season (+60 lineup); 60 on the season says RB55.
    const flash = charbonnet({ points: 220, seasonPoints: 60 });
    const m = planOne(flash, state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.reason).toContain("season projection the lineup gains");
    // On waivers, no claim either.
    expect(planOne({ ...flash, onWaivers: true }, state, DEFAULT_WAIVERS).kind).not.toBe("waiver-claim");
    // The same man at 240 on the season starts on both numbers: the add goes, costing the cheapest legal cut.
    const star = charbonnet({ points: 220, seasonPoints: 240 });
    const s = planOne(star, state, DEFAULT_WAIVERS);
    expect(s.kind).toBe("free-add");
    expect(s.gainPts).toBeGreaterThan(0);
  });

  test("a man the season table does not list is unknown, not zero: a PUP newcomer never beats him on the stable number", () => {
    const unlisted = { ...state, roster: state.roster.map((p) => (p.name === "Rico Dowdle" ? { ...p, seasonPoints: 0 } : p)) };
    expect(planOne(charbonnet(), unlisted, DEFAULT_WAIVERS).kind).toBe("skip");
    // The same on the lineup path: a season starter with no season row (both quarterbacks here) makes the season
    // lineup unknown, and a held newcomer with 240 on the season gains nothing on it; with Dowdle unlisted as well the
    // bench route is unknown too, so nothing carries him.
    const thin = { ...unlisted, roster: unlisted.roster.map((p) => (p.position === "QB" ? { ...p, seasonPoints: 0 } : p)) };
    expect(planOne(charbonnet({ points: 220, seasonPoints: 240 }), thin, DEFAULT_WAIVERS).kind).toBe("skip");
    // Quarterbacks listed, Dowdle not: he goes, on the season lineup (starts for us on both numbers).
    expect(planOne(charbonnet({ points: 220, seasonPoints: 240 }), unlisted, DEFAULT_WAIVERS).kind).toBe("free-add");
  });

  test("a held newcomer on waivers worth a claim on the feed alone waits with the season lineup named, never the claim bar", () => {
    const m = planOne(charbonnet({ onWaivers: true, points: 220, seasonPoints: 60 }), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.reason).toContain("season-projection lineup");
    expect(m.reason).not.toContain("under the 15pt claim bar");
  });

  test("Golden for Downs stands: he plays, so 170 against 172 on the season is not his number", () => {
    const golden: AvailablePlayer = { ...tradePlayer(idOf("Matthew Golden")), onWaivers: false };
    expect(golden.seasonPoints!).toBeLessThan(fx(idOf("Josh Downs")).seasonPoints);
    const m = planOne(golden, { ...state, openIrSlots: 1 }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Josh Downs");
    expect(m.benchGainPts).toBe(18.1);
  });

  test("the whole board with Charbonnet re-rated: Golden for Downs is the one free add, Dowdle is nobody's drop", () => {
    const moves = planWaivers(wire(), { ...state, openIrSlots: 1 }, DEFAULT_WAIVERS);
    const adds = moves.filter((m) => m.kind === "free-add");
    expect(adds.map((m) => `${m.add} / ${m.drop}`)).toEqual(["Matthew Golden / Josh Downs"]);
    expect(moves.some((m) => m.add === "Zach Charbonnet")).toBe(false);
  });
});
