// Replay of the morning of 2026-10-07 on the league as captured the evening
// before (analysis/incidents/league-2026-10-06.json): fourteen active, Travis
// Etienne (NFL IR) and Rico Dowdle (Out) on injured reserve, claims for RJ
// Harvey and the Cincinnati Bengals pending with no drop, last in the waiver
// order. At 03:07 ET Dowdle was listed Questionable. The deployed code
// recorded "drop Jacory Croskey-Merritt and activate Rico Dowdle" for a second
// look at 03:37; the waiver run at 03:15 landed Harvey, lost the Bengals, and
// the second look found a free seat, so nobody was cut. Had the run been late
// the cut would have gone out for a claim that failed anyway.
import { describe, expect, test } from "bun:test";
import { buildRosterView } from "../analysis/roster-view.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS } from "../analysis/rails.ts";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-10-06.json";
import { planReserveActivation, type HeldClaim } from "./reserve-reconcile.ts";
import type { Roster, League } from "../sleeper/types.ts";
import type { RailPlayer } from "../analysis/rails.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const CAP = LEAGUE.rosterPositions.filter((s) => s !== "IR").length; // 16
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [5, 6, 7, 8], remainingWeeks: 13, headToHeadRemaining: 1 };
const mine = ourRoster();
const DOWDLE = idOf("Rico Dowdle");
const JCM = idOf("Jacory Croskey-Merritt");
const HARVEY = idOf("RJ Harvey");
const CIN = "CIN";

/** The roster as Sleeper's GraphQL read carries it, with live statuses. */
function roster(players: string[], reserve: string[], status: Record<string, string | null> = {}): Roster {
  const player_map: NonNullable<Roster["player_map"]> = {};
  for (const id of players) {
    const p = fx(id);
    if (p.position === "DEF") continue; // a defense has no player_map row; the id is the team
    const [first, ...rest] = p.name.split(" ");
    player_map[id] = { player_id: id, first_name: first ?? "", last_name: rest.join(" "), position: p.position, fantasy_positions: [p.position], team: p.team, status: "Active", injury_status: id in status ? status[id] ?? null : p.injuryStatus, news_updated: null };
  }
  return { roster_id: 3, owner_id: "u", players, starters: mine.starters, reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}
function rail(players: string[], reserve: string[], status: Record<string, string | null> = {}): RailPlayer[] {
  return players.map((id) => tradePlayer(id, { onIr: reserve.includes(id), injuryStatus: id in status ? status[id] ?? undefined : fx(id).injuryStatus ?? undefined }));
}
const held = (ids: string[]): HeldClaim[] => ids.map((id) => ({ transactionId: `tx-${id}`, leg: 4, adds: [id], drops: [], seats: 1, value: fx(id).value, names: [fx(id).name] }));
const starters = mine.starters.map((id) => fx(id).name);
const flip = { [DOWDLE]: "Questionable" };

describe("2026-10-07 03:07 ET: Dowdle Questionable on IR, two no-drop claims pending into the two free seats", () => {
  const view = buildRosterView(roster(mine.players, mine.reserve, flip));
  const plan = planReserveActivation({ view, settings: S, cap: CAP, railRoster: rail(mine.players, mine.reserve, flip), cfg, rails: DEFAULT_RAILS, keep: starters, heldClaims: held([CIN, HARVEY]) })[0]!;
  test("fourteen active and Dowdle is the stale reserve player", () => {
    expect(view.active.length).toBe(14);
    expect(plan.playerId).toBe(DOWDLE);
  });
  test("he takes a seat and nobody is dropped: Croskey-Merritt (96 for the season) stays", () => {
    expect(plan.action).toBe("activate");
    expect(plan.drop).toBeNull();
    expect(plan.reserveAfter).toEqual([idOf("Travis Etienne")]);
  });
  test("the Bengals claim (71, a one-week rental) is cancelled; the Harvey claim (137) keeps the last seat", () => {
    expect(plan.cancel.map((c) => c.adds[0])).toEqual([CIN]);
    expect(fx(CIN).value).toBeLessThan(fx(HARVEY).value);
    expect(plan.reason).toContain("Cincinnati Bengals");
    expect(plan.reason).not.toContain("Croskey-Merritt");
  });
});

describe("2026-10-07 03:16 ET, as it happened: Harvey landed, the Bengals lost, fifteen active", () => {
  const players = [...mine.players, HARVEY];
  const view = buildRosterView(roster(players, mine.reserve, flip));
  const plan = planReserveActivation({ view, settings: S, cap: CAP, railRoster: rail(players, mine.reserve, flip), cfg, rails: DEFAULT_RAILS, keep: starters, heldClaims: [] })[0]!;
  test("a seat is free: activated, no drop, nothing to cancel", () => {
    expect(view.active.length).toBe(15);
    expect(plan.action).toBe("activate");
    expect(plan.drop).toBeNull();
    expect(plan.cancel).toEqual([]);
  });
});

describe("had both claims landed before the flip: sixteen active, Etienne on IR, Dowdle stale", () => {
  const players = [...mine.players, HARVEY, CIN];
  const view = buildRosterView(roster(players, mine.reserve, flip));
  test("physically full: one forced drop, the Bengals (71, not starting) go, no season body is cut", () => {
    const plan = planReserveActivation({ view, settings: S, cap: CAP, railRoster: rail(players, mine.reserve, flip), cfg, rails: DEFAULT_RAILS, keep: starters, heldClaims: [] })[0]!;
    expect(view.active.length).toBe(16);
    expect(plan.action).toBe("activate");
    expect(plan.drop?.playerId).toBe(CIN);
    expect(plan.drop?.playerId).not.toBe(JCM);
  });
});
