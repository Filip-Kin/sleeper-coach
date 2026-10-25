// Replay of Saturday 2026-10-24 16:44 ET (week 7) on the league as captured
// the next morning (incidents/league-2026-10-25.json), rolled back one move:
// Colston Loveland (TE, 101 ROS) still ours, Chris Godwin Jr. (WR, 104 ROS)
// still free, DeVonta Smith on the leg at WR. Smith had been ruled Out
// (hamstring) with Evans Out and Diggs and Meyers on bye, so the week-7 WR2
// slot was empty and the stream covered it by a cut: Loveland, the cheapest
// legal cut, was right. The pick was not. The branch ranked the fillers on
// the need week's points and took Godwin (11.4 that week) over Wan'Dale
// Robinson (10.2 that week, 113.5 ROS): 0.9 a week for the season given
// away for 1.1 points once, and the add bar (1.0/wk) then kept the planner
// from undoing it.
//
// The rule now (streaming.ts planStream): a streamed skill-position body
// stays by the ONE value, so he is picked on rest-of-season value among the
// men who play the need week, week points the tie-break. Kicker and defense
// are unchanged (swapped back out the week after, picked on the week). The
// values here are the 10-25 09:24 table; the 10-24 run saw Godwin 104,
// Robinson 113.5, Loveland 101, the same order.
import { describe, expect, test } from "bun:test";
import { buildRosterView } from "./roster-view.ts";
import { DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { DEFAULT_RAILS, type RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-25.json";
import { keptStarters } from "./roster-fit.ts";
import { activeRailRoster, chooseLegalForcedDrops } from "./reconcile-plan.ts";
import { planStream, streamNeeds, pickStreamer, type StreamNeed, type StreamPoolPlayer } from "./streaming.ts";
import { planWaivers, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { weeksLeft } from "./value.ts";
import type { Roster } from "../sleeper/types.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const WEEK = 7;
const mine = ourRoster();
const GODWIN = idOf("Chris Godwin Jr.");
const LOVELAND = idOf("Colston Loveland");
const SMITH = idOf("DeVonta Smith");
const ROBINSON = idOf("Wan'Dale Robinson");

// The roster at 16:44: Loveland in Godwin's seat; Smith on the leg where the
// lineup guard put Godwin at 17:16.
const players = mine.players.map((id) => (id === GODWIN ? LOVELAND : id));
const starterIds = mine.starters.map((id) => (id === GODWIN ? SMITH : id));
const starters = starterIds.map((id) => fx(id).name);

function roster(ids: string[], reserve: string[]): Roster {
  const player_map: NonNullable<Roster["player_map"]> = {};
  for (const id of ids) {
    const p = fx(id);
    if (p.position === "DEF") continue;
    const [first, ...rest] = p.name.split(" ");
    player_map[id] = { player_id: id, first_name: first ?? "", last_name: rest.join(" "), position: p.position, fantasy_positions: [p.position], team: p.team, status: "Active", injury_status: p.injuryStatus, news_updated: null };
  }
  return { roster_id: 3, owner_id: "u", players: ids, starters: starterIds, reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}
const rail = (ids: string[], reserve: string[]): RailPlayer[] => ids.map((id) => tradePlayer(id, { onIr: reserve.includes(id) }));
const view = buildRosterView(roster(players, mine.reserve));
// waiver-run.ts: the analysis roster is the ACTIVE set.
const active = activeRailRoster(view, rail(players, mine.reserve));
const wk = (p: { playerId?: string }, week = WEEK): number => (p.playerId ? (fx(p.playerId).weekly[String(week)] ?? 0) : 0);
const plays = (b: RailPlayer): boolean => wk(b) > 0;
const kept = keptStarters(starters, active, plays);
// waiver-run.ts streamCfg.
const cfg = { ...DEFAULT_FAIRNESS, rails: DEFAULT_RAILS, upcomingWeeks: Array.from({ length: 15 - WEEK + 1 }, (_, i) => WEEK + i) };
const priorityFree = (LEAGUE.waiverPositions?.[String(LEAGUE.ourRosterId)] ?? 0) >= LEAGUE.rosters.length;

// The free pool that afternoon: every unrostered man, Godwin back in it.
// Nobody was on waivers or locked (Saturday, the Thursday teams' men aside,
// none of them a WR above Robinson).
const taken = new Set(LEAGUE.rosters.flatMap((r) => r.players).filter((id) => id !== GODWIN).concat(LOVELAND));
const unrostered = Object.values(LEAGUE.players).filter((p) => !taken.has(p.playerId) && p.value > 0);
const poolFor = (need: StreamNeed, only?: (p: StreamPoolPlayer) => boolean): StreamPoolPlayer[] => unrostered
  .filter((p) => p.position === need.position)
  .map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly[String(need.week)] ?? 0, onWaivers: false, locked: false, value: p.value }))
  .filter((p) => !only || only(p));
const forcedDrop = (need: StreamNeed) => (): string | null => chooseLegalForcedDrops(view, active, 1, cfg, DEFAULT_RAILS, [...need.coveringFor, ...kept])[0]?.name ?? null;
const stream = (need: StreamNeed, openBenchSlots: number, pool = poolFor(need)) =>
  planStream({ need, week: WEEK, openBenchSlots, pool, roster: active, mayLeave: () => true, forcedDrop: forcedDrop(need), currentStarters: starters, kept, priorityFree, claimTaken: false });

describe("2026-10-24 16:44 ET, Saturday of week 7: the WR2 slot is empty and the stream covers it by a cut", () => {
  const needs = streamNeeds(active, WEEK, 3);
  const need = needs.find((n) => n.week === WEEK && n.position === "WR")!;

  test("the fixture is the case as filed", () => {
    expect(LEAGUE.week).toBe(WEEK);
    expect(priorityFree).toBe(true);
    expect(active).toHaveLength(16);
    expect(active.map((p) => p.name)).toContain("Colston Loveland");
    expect(active.map((p) => p.name)).not.toContain("Chris Godwin Jr.");
    expect(starters).toContain("DeVonta Smith");
    expect(fx(SMITH).injuryStatus).toBe("Out");
    expect(fx(idOf("Mike Evans")).injuryStatus).toBe("Out");
    expect(fx(idOf("Stefon Diggs")).bye).toBe(WEEK);
    expect(fx(idOf("Jakobi Meyers")).bye).toBe(WEEK);
    expect(need).toBeDefined();
    expect(need.coveringFor.sort()).toEqual(["DeVonta Smith", "Jakobi Meyers", "Mike Evans", "Stefon Diggs"]);
    // Godwin: more that week; Robinson: more for the season. Both free.
    expect(wk({ playerId: GODWIN })).toBeGreaterThan(wk({ playerId: ROBINSON }));
    expect(fx(ROBINSON).value).toBeGreaterThan(fx(GODWIN).value);
    const pool = poolFor(need);
    expect(pool.map((p) => p.name)).toContain("Chris Godwin Jr.");
    expect(pool.map((p) => p.name)).toContain("Wan'Dale Robinson");
  });

  test("the cut was right: Loveland is the cheapest legal cut, no starter, stash or covered man", () => {
    expect(forcedDrop(need)()).toBe("Colston Loveland");
    // Every starter is kept, Smith too: nobody on the bench can fill his slot.
    expect(kept).toEqual(starters);
    expect(starters).not.toContain("Colston Loveland");
  });

  test("as filed: on the need week's points the pick was Godwin", () => {
    expect(pickStreamer(need, poolFor(need))?.add).toBe("Chris Godwin Jr.");
  });

  test("the rule: the filler stays, so he is Robinson, the best rest-of-season WR who plays week 7; Loveland leaves", () => {
    const d = stream(need, 0);
    expect(d).toMatchObject({ how: "cut", add: "Wan'Dale Robinson", drop: "Colston Loveland", onWaivers: false });
    expect(d.points).toBe(wk({ playerId: ROBINSON }));
    expect(d.reason).toContain("best rest-of-season WR");
    expect(d.reason).toContain("cheapest legal cut");
    expect(d.reason).not.toContain("given up");
  });

  test("into an open bench slot the same man is taken: he stays there too", () => {
    const d = stream(need, 1);
    expect(d).toMatchObject({ how: "open-slot", add: "Wan'Dale Robinson", drop: null });
  });

  test("week points break a tie on the one value only", () => {
    const pool = poolFor(need).map((p) => (p.name === "Chris Godwin Jr." ? { ...p, value: fx(ROBINSON).value } : p));
    expect(stream(need, 0, pool).add).toBe("Chris Godwin Jr.");
  });

  test("a cut that gives up more season value than the week gains still goes, and says so", () => {
    // Only the fringe: the best of them is well under Loveland's value.
    const fringe = poolFor(need, (p) => p.value < 90);
    const d = stream(need, 0, fringe);
    expect(d.how).toBe("cut");
    expect(d.drop).toBe("Colston Loveland");
    const best = fringe.filter((p) => p.weekPoints > 0 && p.bye !== WEEK).sort((a, b) => b.value - a.value)[0]!;
    expect(d.add).toBe(best.name);
    expect(fx(LOVELAND).value - best.value).toBeGreaterThan(best.weekPoints);
    expect(d.reason).toContain("season value given up");
  });

  test("kicker and defense are still picked on the need week: the week-8 kicker hole waits for week 8 itself", () => {
    const k8 = needs.find((n) => n.week === 8 && n.position === "K")!;
    expect(k8).toBeDefined();
    const d = stream(k8, 0);
    expect(d.how).toBe("wait");
    expect(d.reason).toContain("week 8 itself");
  });

  test("no roster move follows: on the roster as it stands Robinson for Godwin is under the add bar", () => {
    const now = activeRailRoster(buildRosterView({ ...roster(mine.players, mine.reserve), starters: mine.starters }), rail(mine.players, mine.reserve));
    const ours = new Set(now.map((p) => p.name));
    const available: AvailablePlayer[] = Object.values(LEAGUE.players)
      .filter((p) => !LEAGUE.rosters.some((r) => r.players.includes(p.playerId)) && !ours.has(p.name) && p.value > 0)
      .map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false, locked: false }));
    const weekPoints = new Map<string, number>();
    for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, p.weekly[String(WEEK)] ?? 0);
    const state: RosterState = {
      roster: now, reserve: mine.reserve.map((id) => tradePlayer(id, { onIr: true })), openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS,
      irEligible: (s) => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase()),
      currentStarters: mine.starters.map((id) => fx(id).name), weeksLeft: weeksLeft(WEEK), priorityFree, weekPoints, canFill: plays,
    };
    const moves = planWaivers(available, state, DEFAULT_WAIVERS);
    // Not held back by Godwin being a starter with no drop path: Robinson is
    // planned, his drop path through Godwin found, and refused on the bar.
    expect(moves.filter((m) => m.add === "Wan'Dale Robinson")).toEqual([]);
    // 0.9 a week over the rest of the season: under the 1.0/wk bar the planner
    // holds a free add to (the review's `add` dry run said the same).
    expect((fx(ROBINSON).value - fx(GODWIN).value) / weeksLeft(WEEK)).toBeLessThan(1.0);
  });
});
