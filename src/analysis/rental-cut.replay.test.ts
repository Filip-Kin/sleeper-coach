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
import type { Roster, League } from "../sleeper/types.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
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
