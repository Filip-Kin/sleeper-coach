import { describe, expect, test } from "bun:test";
import { irEligibleSet, irEligible, staleReserve, rosterLegal, tradeInFlight, tradeDead, legsToScan, pastTradeDeadline, claimAllowed, reserveWritable, lockedAtKickoff, playerOnWaivers } from "./rules.ts";
import { buildRosterView } from "../analysis/roster-view.ts";
import type { Roster, League } from "./types.ts";

// Fixtures are the REAL league settings read on 2026-09-23.
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const mini = (id: string, last: string, injury: string | null) => ({ player_id: id, first_name: "P", last_name: last, position: "WR", fantasy_positions: ["WR"], team: "HOU", status: "Active", injury_status: injury, news_updated: null });
function roster(n: number, reserve: string[], injuries: Record<string, string> = {}): Roster {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  return { roster_id: 3, owner_id: "u", players: ids, starters: ids.slice(0, 10), reserve: reserve.length ? reserve : null, keepers: null,
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map: Object.fromEntries(ids.map((id) => [id, mini(id, id, injuries[id] ?? null)])) };
}

describe("IR eligibility comes from the league flags", () => {
  test("this league: IR, PUP, OUT, SUS, COV and nothing else", () => {
    expect([...irEligibleSet(S)].sort()).toEqual(["COV", "IR", "OUT", "PUP", "SUS"]);
  });
  test("Questionable and Doubtful are not eligible here", () => {
    expect(irEligible("Questionable", S)).toBe(false);
    expect(irEligible("Doubtful", S)).toBe(false);
    expect(irEligible("Out", S)).toBe(true);
    expect(irEligible(null, S)).toBe(false);
  });
  test("a league that allows Doubtful gets it", () => {
    expect(irEligible("Doubtful", { ...S, reserve_allow_doubtful: 1 })).toBe(true);
  });
});

describe("the Collins state: a healed player on IR invalidates the roster", () => {
  test("staleReserve names him", () => {
    const v = buildRosterView(roster(16, ["p15"], { p15: "Questionable" }));
    expect(staleReserve(v, S).map((e) => e.playerId)).toEqual(["p15"]);
  });
  test("a still-Out stash is fine", () => {
    const v = buildRosterView(roster(16, ["p15"], { p15: "Out" }));
    expect(staleReserve(v, S)).toEqual([]);
  });
  test("rosterLegal reports it and the cap together", () => {
    const l = rosterLegal(buildRosterView(roster(17, ["p16"], { p16: "Questionable" })), 16, S);
    expect(l.ok).toBe(false);
    expect(l.overBy).toBe(0);
    expect(l.staleIr).toEqual(["P p16"]);
  });
  test("17 with one valid IR is legal", () => {
    expect(rosterLegal(buildRosterView(roster(17, ["p16"], { p16: "Out" })), 16, S).ok).toBe(true);
  });
});

describe("transactions", () => {
  test("proposer alone is not in flight; all parties is", () => {
    expect(tradeInFlight({ roster_ids: [1, 3], consenter_ids: [3] })).toBe(false);
    expect(tradeInFlight({ roster_ids: [1, 3], consenter_ids: [1, 3] })).toBe(true);
  });
  test("tradeDead on status or on our own expiry", () => {
    const now = 1_800_000_000_000;
    expect(tradeDead({ status: "rejected" }, now)).toBe(true);
    expect(tradeDead({ status: "proposed", settings: { expires_at: now / 1000 - 1 } }, now)).toBe(true);
    expect(tradeDead({ status: "proposed", settings: { expires_at: now / 1000 + 3600 } }, now)).toBe(false);
  });
  test("legsToScan looks one back, never below 1", () => {
    expect(legsToScan(3)).toEqual([3, 2]);
    expect(legsToScan(1)).toEqual([1]);
  });
  test("deadline and claim type", () => {
    expect(pastTradeDeadline(11, S)).toBe(false);
    expect(pastTradeDeadline(12, S)).toBe(true);
    expect(claimAllowed(S)).toBe(true);
    expect(claimAllowed({ ...S, waiver_type: 2 })).toBe(false);
  });
});

describe("game-time rules", () => {
  test("reserve is writable only with no game in progress", () => {
    expect(reserveWritable([{ status: "pre_game" }, { status: "complete" }])).toBe(true);
    expect(reserveWritable([{ status: "in_progress" }])).toBe(false);
  });
  test("locked at own kickoff, unknown team unlocked", () => {
    const k = new Map([["SF", 100]]);
    expect(lockedAtKickoff("SF", k, 150)).toBe(true);
    expect(lockedAtKickoff("SF", k, 50)).toBe(false);
    expect(lockedAtKickoff("ZZZ", k, 150)).toBe(false);
  });
  test("waivers: dropped this week, or own team kicked off since the last run", () => {
    const day = 86_400_000; const run = 1_000 * day; const now = run + 3 * day;
    expect(playerOnWaivers({ droppedAt: now - day, now, lastWaiverRunAt: run, clearDays: 2 })).toBe(true);
    expect(playerOnWaivers({ droppedAt: now - 3 * day, now, lastWaiverRunAt: run, clearDays: 2 })).toBe(false);
    // Dobbins on 2026-09-20: his team had not kicked off yet, so the free add went through.
    expect(playerOnWaivers({ teamKickoff: now + 3_600_000, now, lastWaiverRunAt: run, clearDays: 2 })).toBe(false);
    expect(playerOnWaivers({ teamKickoff: now - 3_600_000, now, lastWaiverRunAt: run, clearDays: 2 })).toBe(true);
    // Kicked off before the last run: that week is processed, he is a free agent again.
    expect(playerOnWaivers({ teamKickoff: run - day, now, lastWaiverRunAt: run, clearDays: 2 })).toBe(false);
  });
});
