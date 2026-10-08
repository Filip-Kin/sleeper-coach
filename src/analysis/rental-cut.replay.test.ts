// Replay of the evening of 2026-10-07 on the league as captured that night
// (incidents/league-2026-10-07.json): sixteen active, Travis Etienne (NFL IR)
// on injured reserve, no claim pending, last in the waiver order. Filip had
// added the Jacksonville Jaguars (DEF10, 86 rest-of-season) for week 5 and
// the lineup guard started them over Seattle (DEF3, 97). The deployed code
// kept every starter from the cut, so the cut order ran Seattle, Dowdle: a
// seat needed while a rental starts would have cost the better defense and
// the season. The rule now: of two bodies at a swap position the one who is
// not the best by the one value is the cut, even while he starts, as long as
// the better body can take the slot this week.
import { describe, expect, test } from "bun:test";
import { buildRosterView } from "./roster-view.ts";
import { DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { DEFAULT_RAILS, type RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-07.json";
import { keptStarters } from "./roster-fit.ts";
import { activeRailRoster, chooseLegalForcedDrops } from "./reconcile-plan.ts";
import { planReserveActivation } from "../act/reserve-reconcile.ts";
import { forecastReturnCut, returnsAcceptable } from "./waivers.ts";
import { planStream, emptyStarterPositions, type StreamNeed, type StreamPoolPlayer } from "./streaming.ts";
import type { Roster, League } from "../sleeper/types.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const CAP = LEAGUE.rosterPositions.filter((s) => s !== "IR").length; // 16
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [5, 6, 7, 8], remainingWeeks: 13, headToHeadRemaining: 1 };
const mine = ourRoster();
const WEEK = String(LEAGUE.week);
const ETIENNE = idOf("Travis Etienne");

function roster(players: string[], reserve: string[], status: Record<string, string | null> = {}): Roster {
  const player_map: NonNullable<Roster["player_map"]> = {};
  for (const id of players) {
    const p = fx(id);
    if (p.position === "DEF") continue;
    const [first, ...rest] = p.name.split(" ");
    player_map[id] = { player_id: id, first_name: first ?? "", last_name: rest.join(" "), position: p.position, fantasy_positions: [p.position], team: p.team, status: "Active", injury_status: id in status ? status[id] ?? null : p.injuryStatus, news_updated: null };
  }
  return { roster_id: 3, owner_id: "u", players, starters: mine.starters, reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}
function rail(players: string[], reserve: string[], status: Record<string, string | null> = {}): RailPlayer[] {
  return players.map((id) => tradePlayer(id, { onIr: reserve.includes(id), injuryStatus: id in status ? status[id] ?? undefined : fx(id).injuryStatus ?? undefined }));
}
/** The fixture's week table: a body plays this week when his projection for it is above zero. */
const plays = (p: RailPlayer): boolean => (p.playerId ? (fx(p.playerId).weekly[WEEK] ?? 0) : 0) > 0;
const starters = mine.starters.map((id) => fx(id).name);

describe("2026-10-07 21:15 ET: Jacksonville starts week 5, Seattle sits, Etienne on IR", () => {
  const view = buildRosterView(roster(mine.players, mine.reserve));
  const full = activeRailRoster(view, rail(mine.players, mine.reserve));

  test("the fixture is the roster as filed: Jacksonville starts and is the cheaper defense", () => {
    expect(starters).toContain("Jacksonville Jaguars");
    expect(starters).not.toContain("Seattle Seahawks");
    expect(fx("JAX").value).toBeLessThan(fx("SEA").value);
    expect(fx("SEA").weekly[WEEK]).toBeGreaterThan(0);
  });

  test("the starting rental is not kept; every other starter is", () => {
    const kept = keptStarters(starters, full, plays);
    expect(kept).toEqual(starters.filter((n) => n !== "Jacksonville Jaguars"));
  });

  test("the cut order runs Jacksonville, Dowdle; Seattle is not cut", () => {
    const drops = chooseLegalForcedDrops(view, full, 2, cfg, DEFAULT_RAILS, keptStarters(starters, full, plays));
    expect(drops.map((d) => d.name)).toEqual(["Jacksonville Jaguars", "Rico Dowdle"]);
  });

  test("the defect as filed: with every starter kept the cut was Seattle", () => {
    const drops = chooseLegalForcedDrops(view, full, 1, cfg, DEFAULT_RAILS, starters);
    expect(drops[0]?.name).toBe("Seattle Seahawks");
  });

  test("Etienne coming off IR onto a full roster cuts Jacksonville, not Seattle or Dowdle", () => {
    const flip = { [ETIENNE]: "Questionable" };
    const v = buildRosterView(roster(mine.players, mine.reserve, flip));
    const plan = planReserveActivation({ view: v, settings: S, cap: CAP, railRoster: rail(mine.players, mine.reserve, flip), cfg, rails: DEFAULT_RAILS, keep: starters, canFill: plays })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.drop?.name).toBe("Jacksonville Jaguars");
    const old = planReserveActivation({ view: v, settings: S, cap: CAP, railRoster: rail(mine.players, mine.reserve, flip), cfg, rails: DEFAULT_RAILS, keep: starters })[0]!;
    expect(old.drop?.name).toBe("Seattle Seahawks");
  });

  test("the return forecast names the rental: a seat for a newcomer costs the rental, not the better defense", () => {
    const etienne = full.find((p) => p.playerId === ETIENNE) ?? rail([ETIENNE], [ETIENNE])[0]!;
    const active = full.filter((p) => p.playerId !== ETIENNE);
    const newcomer: RailPlayer = { playerId: "x", name: "Some Back", position: "RB", points: 120, seasonPoints: 150 };
    expect(forecastReturnCut(active, etienne, newcomer, starters, DEFAULT_RAILS, SLOTS, plays)).toBe("Jacksonville Jaguars");
    expect(forecastReturnCut(active, etienne, newcomer, starters, DEFAULT_RAILS, SLOTS)).toBe("Seattle Seahawks");
    const r = returnsAcceptable({ active, reserveAfter: [etienne], incoming: newcomer, directDrop: "Jacksonville Jaguars", currentStarters: starters, rails: DEFAULT_RAILS, slots: SLOTS, canFill: plays });
    expect(r.ok).toBe(true);
  });
});

// 2026-10-08 morning review: the week-6 streamer. Bates is on bye in week 6
// and the guard's 1.0 margin keeps the Jaguars on the week-6 leg over Seattle
// (6.46 + 1.0 > 7.24). planStream read the leg as the kept set, found no
// spare (the Jaguars start, Seattle is the best defense) and swapped Bates,
// K2 at 98, for the free kicker; the Jaguars, 86 and on bye the week after,
// stayed. The cut order's rule applies here too: a starting kicker or
// defense with a better body behind him who can fill the slot is not kept,
// and in the need week he is the spare.
describe("2026-10-13, week 6: Bates on bye, the Jaguars on the leg, Seattle behind them", () => {
  const active = rail(mine.players.filter((id) => !mine.reserve.includes(id)), []);
  const plays6 = (p: RailPlayer): boolean => (p.playerId ? (fx(p.playerId).weekly["6"] ?? 0) : 0) > 0;
  const need: StreamNeed = { week: 6, position: "K", coveringFor: ["Jake Bates"] };
  const leg6 = starters.filter((n) => !["Jake Bates", "Sam LaPorta", "Chase Brown"].includes(n));
  // Tuesday: every kicker who played in week 5 is on waivers until Wednesday; Butker (bye 5) is free.
  const pool = (): StreamPoolPlayer[] => availableAt("K").map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly["6"] ?? 0, onWaivers: p.bye !== 5, value: p.value }));
  const never = (): string | null => { throw new Error("a swap position must not ask for a forced drop"); };

  test("the fixture: the Jaguars start, Seattle plays week 6, Bates has no week-6 row, Butker is free", () => {
    expect(leg6).toContain("Jacksonville Jaguars");
    expect(fx("SEA").weekly["6"]).toBeGreaterThan(0);
    expect(fx(idOf("Jake Bates")).weekly["6"] ?? 0).toBe(0);
    expect(pool().filter((p) => !p.onWaivers).map((p) => p.name)).toEqual(["Harrison Butker"]);
  });

  test("in the need week the starting rental is the spare: Butker in, the Jaguars out, Bates stays", () => {
    const kept = keptStarters(leg6, active, plays6);
    expect(kept).not.toContain("Jacksonville Jaguars");
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(), roster: active, mayLeave: () => true, forcedDrop: never, currentStarters: leg6, kept });
    expect(d.how).toBe("swap");
    expect(d.add).toBe("Harrison Butker");
    expect(d.drop).toBe("Jacksonville Jaguars");
    expect(d.onWaivers).toBe(false);
    // The week-6 lineup after the move fields a kicker and a defense: Seattle takes the slot.
    const after = [...active.filter((p) => p.name !== d.drop), { playerId: "4227", name: "Harrison Butker", position: "K", points: 94.3, bye: 5 }];
    expect(emptyStarterPositions(after, 6, SLOTS)).toEqual([]);
  });

  test("the defect as filed: with the leg as the kept set the swap cut Bates", () => {
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(), roster: active, mayLeave: () => true, forcedDrop: never, currentStarters: leg6 });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
  });

  test("a week early the rental plays for us: nothing moves until the need week", () => {
    const leg5 = starters; // the Jaguars start week 5 too
    const kept = keptStarters(leg5, active, plays);
    expect(kept).not.toContain("Jacksonville Jaguars");
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool(), roster: active, mayLeave: () => true, forcedDrop: never, currentStarters: leg5, kept });
    expect(d.how).toBe("wait");
    expect(d.drop).toBeNull();
  });

  test("when Seattle cannot fill the slot the Jaguars are kept and Bates is swapped as before", () => {
    const kept = keptStarters(leg6, active, () => false);
    expect(kept).toContain("Jacksonville Jaguars");
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(), roster: active, mayLeave: () => true, forcedDrop: never, currentStarters: leg6, kept });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
  });

  test("a released starter worth more than the covered kicker is not the spare: the kicker on bye leaves, as the value rule says", () => {
    const dear = active.map((p) => (p.name === "Jacksonville Jaguars" ? { ...p, points: 120, seasonPoints: 120 } : p));
    const seattleBetter = dear.map((p) => (p.name === "Seattle Seahawks" ? { ...p, points: 130 } : p));
    const kept = keptStarters(leg6, seattleBetter, plays6);
    expect(kept).not.toContain("Jacksonville Jaguars");
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(), roster: seattleBetter, mayLeave: () => true, forcedDrop: never, currentStarters: leg6, kept });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
  });

  test("a non-starting spare worth less still goes first, before the starting rental", () => {
    const extra: RailPlayer = { playerId: "x-def", name: "Spare Defense", position: "DEF", points: 60, seasonPoints: 70 };
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(), roster: [...active, extra], mayLeave: () => true, forcedDrop: never, currentStarters: leg6, kept: keptStarters(leg6, [...active, extra], plays6) });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Spare Defense");
  });
});
