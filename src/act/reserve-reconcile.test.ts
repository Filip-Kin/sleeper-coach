import { describe, expect, test } from "bun:test";
import { buildRosterView } from "../analysis/roster-view.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { planReserveActivation, claimsToCancel, ReserveDeferrals, type HeldClaim } from "./reserve-reconcile.ts";
import type { Roster, League } from "../sleeper/types.ts";
import type { RailPlayer } from "../analysis/rails.ts";

// R1. A player parked on IR whose designation no longer qualifies (Questionable
// after Out) makes the whole roster invalid and Sleeper refuses every lineup
// write. The daemon has to take him off reserve, and when the active roster is
// full that means one forced drop first.

const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const mini = (id: string, pos: string, injury: string | null) => ({ player_id: id, first_name: "P", last_name: id, position: pos, fantasy_positions: [pos], team: "HOU", status: "Active", injury_status: injury, news_updated: null });
const SPEC: [string, string, number][] = [
  ["qb1", "QB", 300], ["rb1", "RB", 250], ["rb2", "RB", 240], ["wr1", "WR", 230], ["wr2", "WR", 220],
  ["te1", "TE", 180], ["rb3", "RB", 200], ["wr3", "WR", 190], ["k1", "K", 120], ["DET", "DEF", 100],
  ["qb2", "QB", 150], ["wr4", "WR", 110], ["rb4", "RB", 60], ["wr5", "WR", 55], ["rb5", "RB", 50], ["wr6", "WR", 45],
];
function fixture(activeCount: number, irStatus: string): { view: ReturnType<typeof buildRosterView>; rail: RailPlayer[] } {
  const active = SPEC.slice(0, activeCount);
  const ids = [...active.map((s) => s[0]), "collins"];
  const roster: Roster = {
    roster_id: 3, owner_id: "u", players: ids, starters: ids.slice(0, 10), reserve: ["collins"], keepers: null,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 },
    player_map: { ...Object.fromEntries(active.map(([id, pos]) => [id, mini(id, pos, null)])), collins: mini("collins", "WR", irStatus) },
  };
  const rail: RailPlayer[] = [
    ...active.map(([id, pos, pts]) => ({ playerId: id, name: `P ${id}`, position: pos, points: pts, onIr: false })),
    { playerId: "collins", name: "P collins", position: "WR", points: 260, onIr: true, injuryStatus: irStatus },
  ];
  return { view: buildRosterView(roster), rail };
}
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [3, 4, 5, 6], remainingWeeks: 13, headToHeadRemaining: 1 };

describe("R1: activating a stale reserve player", () => {
  test("a still-Out player on IR needs nothing", () => {
    const { view, rail } = fixture(15, "Out");
    expect(planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg })).toEqual([]);
  });
  test("with a free slot he is activated and nobody is dropped", () => {
    const { view, rail } = fixture(15, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg });
    expect(plan.length).toBe(1);
    expect(plan[0]?.action).toBe("activate");
    expect(plan[0]?.playerId).toBe("collins");
    expect(plan[0]?.drop).toBeNull();
    expect(plan[0]?.reserveAfter).toEqual([]);
  });
  test("with a full roster exactly one forced drop is chosen from the full active roster", () => {
    const { view, rail } = fixture(16, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg });
    expect(plan.length).toBe(1);
    expect(plan[0]?.action).toBe("activate");
    expect(plan[0]?.drop).not.toBeNull();
    expect(plan[0]?.drop?.playerId).not.toBe("collins");
    expect(view.activeIds.has(plan[0]?.drop?.playerId ?? "")).toBe(true);
  });
  test("a second stale player waits for the next poll", () => {
    const { view, rail } = fixture(15, "Questionable");
    const two = { ...view, reserve: [...view.reserve, { ...view.reserve[0]!, playerId: "x2", name: "P x2" }] };
    const plan = planReserveActivation({ view: two, settings: S, cap: 16, railRoster: rail, cfg });
    expect(plan.length).toBe(1);
  });
});

describe("R1: deferral and alert throttling", () => {
  test("a locked refusal defers silently until after the week's last game", () => {
    const d = new ReserveDeferrals();
    const now = 1_000_000;
    d.deferLocked("collins", now, [now + 5_000, now + 90_000]);
    expect(d.deferred("collins", now + 10_000)).toBe(true);
    expect(d.deferred("collins", now + 90_000 + 4 * 3_600_000 + 1)).toBe(false);
  });
  test("no kickoff cache defers one hour", () => {
    const d = new ReserveDeferrals();
    d.deferLocked("collins", 0, []);
    expect(d.deferred("collins", 30 * 60_000)).toBe(true);
    expect(d.deferred("collins", 61 * 60_000)).toBe(false);
  });
  test("one alert per player per day", () => {
    const d = new ReserveDeferrals();
    expect(d.mayAlert("collins", 0)).toBe(true);
    expect(d.mayAlert("collins", 3_600_000)).toBe(false);
    expect(d.mayAlert("other", 3_600_000)).toBe(true);
    expect(d.mayAlert("collins", 25 * 3_600_000)).toBe(true);
  });
});

describe("the IR player is himself a cut candidate (Filip, 2026-09-30)", () => {
  test("a stale IR player worth less than every bench body is released, nobody else is cut", () => {
    const { view, rail } = fixture(16, "Questionable");
    const cheap = rail.map((p) => (p.playerId === "collins" ? { ...p, points: 20 } : p));
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: cheap, cfg })[0]!;
    expect(plan.action).toBe("release");
    expect(plan.drop?.playerId).toBe("collins");
  });
  test("this week's starters and a pending claim's drop are never the cut", () => {
    const { view, rail } = fixture(16, "Questionable");
    // wr6 (45) is the cheapest; pinned as a starter it must be skipped, then rb5 (50)
    // is pinned as a pending claim's drop, so wr5 (55) goes.
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg, keep: ["P wr6", "P rb5"] })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.drop?.playerId).toBe("wr5");
  });
});

// 2026-10-07, 03:07 ET: fourteen active, two on IR, two no-drop claims pending,
// Dowdle flips Out -> Questionable eight minutes before the waiver run. The
// old rule counted the held seats as taken and recorded "drop Croskey-Merritt
// (96 for the season) and activate Dowdle". A claim is a maybe (we were last
// in the order and the Bengals claim did lose); a drop is for the season.
const claim = (transactionId: string, value: number, seats = 1): HeldClaim => ({ transactionId, leg: 5, adds: [`add-${transactionId}`], drops: [], seats, value, names: [`Add ${transactionId}`] });
describe("a seat held for a pending no-drop claim is still a seat for the returning man (2026-10-07)", () => {
  test("one free seat, one held claim: he takes it, nobody is dropped, the claim is cancelled", () => {
    const { view, rail } = fixture(15, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg, heldClaims: [claim("t1", 137)] })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.drop).toBeNull();
    expect(plan.cancel.map((c) => c.transactionId)).toEqual(["t1"]);
    expect(plan.reason).toContain("cancelled");
  });
  test("two free seats, two held claims: he takes one, the cheaper claim is cancelled, the dearer keeps its seat", () => {
    const { view, rail } = fixture(14, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg, heldClaims: [claim("harvey", 137.4), claim("cin", 71.3)] })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.drop).toBeNull();
    expect(plan.cancel.map((c) => c.transactionId)).toEqual(["cin"]);
  });
  test("two free seats, one held claim: nothing is cancelled", () => {
    const { view, rail } = fixture(14, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg, heldClaims: [claim("harvey", 137.4)] })[0]!;
    expect(plan.drop).toBeNull();
    expect(plan.cancel).toEqual([]);
  });
  test("physically full: the forced drop as before, and every held claim is cancelled because no seat survives the move", () => {
    const { view, rail } = fixture(16, "Questionable");
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: rail, cfg, heldClaims: [claim("t1", 50)] })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.drop).not.toBeNull();
    expect(plan.cancel.map((c) => c.transactionId)).toEqual(["t1"]);
  });
  test("a release (he is the cheapest body himself) also cancels the seatless claims", () => {
    const { view, rail } = fixture(16, "Questionable");
    const cheap = rail.map((p) => (p.playerId === "collins" ? { ...p, points: 20 } : p));
    const plan = planReserveActivation({ view, settings: S, cap: 16, railRoster: cheap, cfg, heldClaims: [claim("t1", 50)] })[0]!;
    expect(plan.action).toBe("release");
    expect(plan.cancel.map((c) => c.transactionId)).toEqual(["t1"]);
  });
  test("claimsToCancel: cheapest first, whole claims, only as many as the overflow needs", () => {
    const held = [claim("a", 100), claim("b", 30), claim("c", 60, 2)];
    expect(claimsToCancel(held, 4).map((c) => c.transactionId)).toEqual([]);
    expect(claimsToCancel(held, 3).map((c) => c.transactionId)).toEqual(["b"]);
    expect(claimsToCancel(held, 2).map((c) => c.transactionId)).toEqual(["b", "c"]);
    expect(claimsToCancel(held, 0).map((c) => c.transactionId)).toEqual(["b", "c", "a"]);
    expect(claimsToCancel([], 0)).toEqual([]);
    // A self-financing claim (a drop named) holds no seat and is never cancelled.
    expect(claimsToCancel([claim("swap", 10, 0)], 0)).toEqual([]);
  });
});
