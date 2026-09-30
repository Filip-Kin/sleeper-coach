// Replays of the real incidents, on the real numbers.
//
// Every roster below is the roster the coach actually held on the day, with
// the rest-of-season values captured from the live feed on 2026-09-30
// (incidents/values-2026-09-30.json). Each test asserts the NAME the rule must
// choose, not the shape of the answer: the 09-30 test that only checked "the
// drop is not the IR player" passed while Etienne was cut.
import { describe, expect, test } from "bun:test";
import fixture from "./incidents/values-2026-09-30.json";
import { buildValues, isStash, toRail, type PlayerValue } from "./value.ts";
import { chooseForcedDrops } from "./roster-fit.ts";
import { planReserveActivation } from "../act/reserve-reconcile.ts";
import { buildRosterView } from "./roster-view.ts";
import { planWaivers, planOne, DEFAULT_WAIVERS, type RosterState, type AvailablePlayer } from "./waivers.ts";
import { DEFAULT_FAIRNESS } from "./trade-fair.ts";
import type { RailPlayer } from "./rails.ts";
import type { Roster, League } from "../sleeper/types.ts";

type Row = { playerId: string; name: string; position: string; team: string; value: number; seasonPoints: number; seasonRank: number };
const rows = (fixture as { players: Row[] }).players;
const WEEK = 4;
const byName = new Map(rows.map((r) => [r.name, r]));

/** A player as the engine sees him, with the injury status of the day. */
function P(name: string, status: string | null = null, onIr = false): RailPlayer {
  const r = byName.get(name);
  if (!r) throw new Error(`fixture has no ${name}`);
  const v: PlayerValue = {
    playerId: r.playerId, name: r.name, position: r.position as PlayerValue["position"], team: r.team,
    value: r.value, valueAvg: Math.round((r.value / 14) * 10) / 10, weeksLeft: 14,
    seasonPoints: r.seasonPoints, seasonRank: r.seasonRank, injuryStatus: status,
    stash: isStash(r.position, r.seasonRank, status, WEEK),
  };
  return toRail(v, { onIr });
}
const SETTINGS = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], remainingWeeks: 12, headToHeadRemaining: 1 };

function viewOf(active: RailPlayer[], reserve: RailPlayer[], starters: string[]): ReturnType<typeof buildRosterView> {
  const all = [...active, ...reserve];
  const roster: Roster = {
    roster_id: 3, owner_id: "u", players: all.map((p) => p.playerId!), starters: starters.map((n) => byName.get(n)!.playerId), reserve: reserve.map((p) => p.playerId!), keepers: null,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 },
    player_map: Object.fromEntries(all.map((p) => [p.playerId!, { player_id: p.playerId!, first_name: p.name.split(" ")[0]!, last_name: p.name.split(" ").slice(1).join(" "), position: p.position, fantasy_positions: [p.position], team: "X", status: "Active", injury_status: p.injuryStatus ?? null, news_updated: null }])),
  };
  return buildRosterView(roster);
}

// 2026-09-30 03:02 ET. Sixteen active, Dowdle and Collins on IR, both flipped to
// Questionable overnight. Etienne is Out (hamstring). The bot cut Etienne.
const STARTERS_0930 = ["Dak Prescott", "Kenneth Walker", "Christian McCaffrey", "DeVonta Smith", "Mike Evans", "Sam LaPorta", "Chase Brown", "Josh Downs", "Jake Bates", "SEA"];
const active0930: RailPlayer[] = [
  P("Jalen Hurts"), P("Dak Prescott"), P("Christian McCaffrey"), P("Chase Brown"), P("Kenneth Walker"),
  P("DeVonta Smith"), P("Mike Evans", "Out"), P("Sam LaPorta"), P("Josh Downs"), P("Kenny Gainwell"),
  P("Mark Andrews"), P("Jacory Croskey-Merritt"), P("Tyjae Spears"), P("Travis Etienne", "Out"), P("Jake Bates"), P("SEA"),
];
const ir0930: RailPlayer[] = [P("Rico Dowdle", "Questionable", true), P("Nico Collins", "Questionable", true)];

describe("2026-09-30: activating Dowdle off IR", () => {
  test("the cut is Gainwell, the lowest rest-of-season value on the bench; never Etienne or Croskey-Merritt", () => {
    const view = viewOf(active0930, ir0930, STARTERS_0930);
    const plan = planReserveActivation({ view, settings: SETTINGS, cap: 16, railRoster: [...active0930, ...ir0930], cfg, keep: STARTERS_0930 })[0]!;
    expect(plan.name).toBe("Rico Dowdle");
    expect(plan.action).toBe("activate");
    expect(plan.drop?.name).toBe("Kenny Gainwell");
  });
  test("Etienne is a protected stash: Out, but RB18 on the season", () => {
    expect(P("Travis Etienne", "Out").returnsBeforePlayoffs).toBe(true);
  });
  test("then Collins: with Dowdle active and Gainwell gone, the cut is Spears", () => {
    const active = [...active0930.filter((p) => p.name !== "Kenny Gainwell"), P("Rico Dowdle", "Questionable")];
    const ir = [P("Nico Collins", "Questionable", true)];
    const view = viewOf(active, ir, STARTERS_0930);
    const plan = planReserveActivation({ view, settings: SETTINGS, cap: 16, railRoster: [...active, ...ir], cfg, keep: STARTERS_0930 })[0]!;
    expect(plan.name).toBe("Nico Collins");
    expect(plan.drop?.name).toBe("Tyjae Spears");
  });
  test("a starter is never the cut even when he is the cheapest body", () => {
    // Downs (148) starts at FLEX this week and is cheaper than Andrews (120)? No:
    // pin every bench body above him and check the starter still survives.
    const view = viewOf(active0930, ir0930, STARTERS_0930);
    const pricey = [...active0930, ...ir0930].map((p) => (p.name === "Josh Downs" ? { ...p, points: 1, seasonPoints: 1 } : p));
    const plan = planReserveActivation({ view, settings: SETTINGS, cap: 16, railRoster: pricey, cfg, keep: STARTERS_0930 })[0]!;
    expect(plan.drop?.name).not.toBe("Josh Downs");
  });
});

describe("2026-09-30: the wire after the cuts", () => {
  const bench = [P("Jalen Hurts"), P("Rico Dowdle", "Questionable"), P("Kenny Gainwell"), P("Tyjae Spears"), P("Nico Collins", "Questionable"), P("Mark Andrews")];
  const starters = STARTERS_0930.map((n) => P(n, n === "Mike Evans" ? "Out" : null));
  const roster = [...starters, ...bench];
  const state: RosterState = { roster, openBenchSlots: 0, openIrSlots: 2, startingSlots: SLOTS, currentStarters: STARTERS_0930, weeksLeft: 14 };
  const avail = (name: string, onWaivers: boolean, status: string | null = null): AvailablePlayer => ({ ...P(name, status), onWaivers });

  test("Croskey-Merritt (10.2/week) replaces Gainwell (7.6/week): a bench swap, the swap Filip described", () => {
    const m = planOne(avail("Jacory Croskey-Merritt", false), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Kenny Gainwell");
  });
  test("Hunter Henry over Andrews is 0.8/week: not worth a drop", () => {
    expect(planOne(avail("Hunter Henry", false), state, DEFAULT_WAIVERS).kind).toBe("skip");
  });
  test("a bench swap on waivers needs 2.0/week: Croskey-Merritt at 2.6 is a claim, RJ Harvey at 1.7 waits", () => {
    expect(planOne(avail("Jacory Croskey-Merritt", true), state, DEFAULT_WAIVERS).kind).toBe("waiver-claim");
    expect(planOne(avail("RJ Harvey", true), state, DEFAULT_WAIVERS).kind).toBe("wait");
  });
  test("the board ranks Croskey-Merritt first", () => {
    const moves = planWaivers([avail("Hunter Henry", false), avail("RJ Harvey", false), avail("Jacory Croskey-Merritt", false)], state, DEFAULT_WAIVERS);
    expect(moves[0]?.add).toBe("Jacory Croskey-Merritt");
  });
});

describe("2026-09-27: stashing a day-to-day Out player to add Spears", () => {
  test("Spears (7.9/week) is no upgrade on the bench, so nobody is parked on IR for him", () => {
    const bench = [P("Jalen Hurts"), P("Rico Dowdle", "Out"), P("Kenny Gainwell"), P("Nico Collins", "Out"), P("Mark Andrews"), P("Travis Etienne", "Out")];
    const starters = STARTERS_0930.map((n) => P(n));
    const state: RosterState = { roster: [...starters, ...bench], openBenchSlots: 0, openIrSlots: 1, startingSlots: SLOTS, currentStarters: STARTERS_0930, weeksLeft: 14,
      irEligible: (s) => ["OUT", "IR", "PUP", "SUS", "COV"].includes((s ?? "").toUpperCase()) };
    const m = planOne({ ...P("Tyjae Spears"), onWaivers: false }, state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.irStash).toBeNull();
  });
});

describe("2026-09-19: seventeen entries with Collins on IR", () => {
  test("over the cap by one: a bench body goes, never the IR stash, never a starter, never the Doubtful WR28", () => {
    const active = [...active0930.filter((p) => p.name !== "Tyjae Spears"), P("Jayden Reed", "Doubtful"), P("Rico Dowdle")];
    const ir = [P("Nico Collins", "Out", true)];
    expect(active.length).toBe(17);
    const drops = chooseForcedDrops([...active], 1, cfg, STARTERS_0930);
    expect(drops.length).toBe(1);
    expect(["Nico Collins", "Jayden Reed", "Travis Etienne", ...STARTERS_0930]).not.toContain(drops[0]!.name);
    expect(drops[0]!.name).toBe("Kenny Gainwell");
    expect(ir[0]!.returnsBeforePlayoffs).toBe(true);
  });
});
