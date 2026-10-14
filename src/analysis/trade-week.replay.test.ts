// Replay of 2026-10-14 on the league as captured at 03:28 ET
// (incidents/league-2026-10-14.json) with the week-6 slate
// (schedule-2026-week6.json). At 09:19 ET the Wednesday proposer's dry run
// chose Carnell Tate for Colston Loveland + Jacksonville: Loveland the only
// tight end of ours playing in week 6 (LaPorta on bye), Jacksonville the
// defense on the matchup leg with Seattle kicking off Thursday night. Under
// the league's two review days an accepted offer processes Friday, before
// HOU@JAX (Sunday 09:30 ET) and CHI@ATL (13:00): two empty slots on Sunday
// for +9.8 season points. The night before, the coach had floated RJ Harvey
// and Loveland for Trevor Lawrence in a DM.
//
// The rule (trade-week.ts): a starter on the leg who plays this week, whose
// slot nobody on the roster can take, is not given away while the trade
// would process before his kickoff. Harvey plays Thursday night: a Wednesday
// offer processes after his game, so he is givable; Loveland and JAX are not.
import { describe, expect, test } from "bun:test";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-14.json";
import slate from "./incidents/schedule-2026-week6.json";
import { weekLockedIds, tradeProcessesAt, kickoffOf } from "./trade-week.ts";
import { markWeekLocked, type LeagueSnapshot } from "./trade-wire.ts";
import { proposeTrades, evaluateTradeTwoSided, giveEligibleForProposal, DEFAULT_FAIRNESS } from "./trade-fair.ts";
import { canDrop, DEFAULT_RAILS } from "./rails.ts";
import { tradeReplyText } from "../league/trade-watch.ts";
import type { WeekProjection } from "./week-projections.ts";
import type { TradePlayer } from "./trade.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const games = (slate as { games: { away: string; home: string; startTime: number }[] }).games;
const teams = new Set(games.flatMap((g) => [g.away, g.home]));
// The week-6 table as the capture carries it: each player's week-6 points,
// zero on bye or with no game, the live injury status.
const table = new Map<string, WeekProjection>();
for (const p of Object.values(LEAGUE.players)) {
  table.set(p.playerId, {
    playerId: p.playerId, name: p.name, position: p.position as WeekProjection["position"], team: p.team, opponent: null, gameId: null,
    points: p.weekly["6"] ?? 0, ptsPpr: 0, injuryStatus: p.injuryStatus, onBye: p.bye === 6, hasGame: teams.has(p.team), stats: {},
  });
}
const rosterOf = (rid: number): TradePlayer[] => {
  const r = LEAGUE.rosters.find((x) => x.rosterId === rid)!;
  const ir = new Set(r.reserve);
  return r.players.map((id) => tradePlayer(id, { onIr: ir.has(id) }));
};
const snapshot = (): LeagueSnapshot => ({
  playerById: new Map(Object.keys(LEAGUE.players).map((id) => [id, tradePlayer(id)])),
  rosterOf: new Map(LEAGUE.rosters.map((r) => [r.rosterId, rosterOf(r.rosterId)])),
  ourRosterId: LEAGUE.ourRosterId, idByName: new Map(), ownerIdOf: new Map(), week: 6, capacity: 16,
});
const mine = ourRoster();
const REVIEW_DAYS = 2; // league settings trade_review_days, 2026-10-14
const WED_0919 = Date.UTC(2026, 9, 14, 13, 19); // the dry run
const FRI_0100Z = Date.UTC(2026, 9, 16, 1); // SEA@DEN kicked off Thu 20:15 ET
const SUN_1100 = Date.UTC(2026, 9, 18, 15); // HOU@JAX (09:30 ET) under way, the 13:00 games not
const MON_0800 = Date.UTC(2026, 9, 19, 12);
const names = (ids: Iterable<string>): string[] => [...ids].map((id) => fx(id).name).sort();
const locked = (now: number, reviewDays = REVIEW_DAYS, t: typeof table | null = table, g: typeof games | null = games) =>
  weekLockedIds({ roster: rosterOf(LEAGUE.ourRosterId), starterIds: mine.starters, table: t, games: g, now, reviewDays });
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15], remainingWeeks: 10, headToHeadRemaining: 1, rosterCapacity: 16 };
const LOVELAND = idOf("Colston Loveland"), HARVEY = idOf("RJ Harvey"), BATES = idOf("Jake Bates"), LAPORTA = idOf("Sam LaPorta");

describe("2026-10-14: the week-6 leg and slate as captured", () => {
  test("Loveland is the only tight end playing, JAX the defense on the leg, Seattle behind him plays Thursday, Harvey starts at FLEX and plays Thursday", () => {
    expect(mine.starters).toContain(LOVELAND);
    expect(mine.starters).toContain("JAX");
    expect(mine.starters).toContain(HARVEY);
    expect(mine.starters).toContain(BATES);
    expect(fx(LAPORTA).weekly["6"]).toBe(0); // bye
    expect(fx(BATES).weekly["6"]).toBe(0); // bye, on the leg with nothing to score
    expect(kickoffOf("SEA", games)).toBe(Date.UTC(2026, 9, 16, 0, 15));
    expect(kickoffOf("DEN", games)).toBe(Date.UTC(2026, 9, 16, 0, 15));
    expect(kickoffOf("JAX", games)).toBe(Date.UTC(2026, 9, 18, 13, 30));
    expect(kickoffOf("CHI", games)).toBe(Date.UTC(2026, 9, 18, 17));
    expect(fx("SEA").value).toBeGreaterThan(fx("JAX").value); // 86.4 > 78.4: the better defense sits
  });
  test("a Wednesday offer processes Friday under two review days, before every game but Thursday's", () => {
    const at = tradeProcessesAt(WED_0919, REVIEW_DAYS);
    expect(at).toBe(Date.UTC(2026, 9, 16, 13, 19));
    expect(at).toBeGreaterThan(kickoffOf("DEN", games)!);
    expect(at).toBeLessThan(kickoffOf("JAX", games)!);
  });
});

describe("weekLockedIds on the Wednesday of week 6", () => {
  test("locks the Sunday and Monday starters: Loveland (no other TE plays), JAX (Seattle has kicked off by Friday), and the six skill starters; not Harvey (Thursday), not Bates (bye), nobody on the bench or IR", () => {
    expect(names(locked(WED_0919))).toEqual([
      "Christian McCaffrey", "Colston Loveland", "Dak Prescott", "Jacksonville Jaguars", "Josh Downs", "Kenneth Walker", "Mike Evans", "Nico Collins",
    ]);
  });
  test("with no review period (processes at once) Harvey is locked too and JAX is not: Seattle can still take the slot before Thursday night", () => {
    const l = names(locked(WED_0919, 0));
    expect(l).toContain("RJ Harvey");
    expect(l).not.toContain("Jacksonville Jaguars");
    expect(l).toContain("Colston Loveland");
  });
  test("Friday morning, Seattle played: JAX stays locked, the set is unchanged", () => {
    expect(names(locked(FRI_0100Z))).toEqual(names(locked(WED_0919)));
  });
  test("Sunday 11:00 ET with instant processing: JAX and Collins have kicked off and are free, the 13:00 starters are not", () => {
    const l = names(locked(SUN_1100, 0));
    expect(l).not.toContain("Jacksonville Jaguars");
    expect(l).not.toContain("Nico Collins");
    expect(l).toContain("Colston Loveland");
    expect(l).toContain("Dak Prescott");
  });
  test("Sunday under two review days, and Monday morning: every game is played before the trade would process, nobody is locked", () => {
    expect(locked(SUN_1100).size).toBe(0);
    expect(locked(MON_0800).size).toBe(0);
  });
  test("no table or no slate: every active starter on the leg is locked, Bates included, IR never", () => {
    const l = names(locked(WED_0919, REVIEW_DAYS, null, games));
    expect(l).toContain("Jake Bates");
    expect(l).toContain("RJ Harvey");
    expect(l).toHaveLength(10);
    expect(names(locked(WED_0919, REVIEW_DAYS, table, null))).toHaveLength(10);
    expect(l).not.toContain("DeVonta Smith");
  });
  test("an empty leg locks nobody", () => {
    expect(weekLockedIds({ roster: rosterOf(LEAGUE.ourRosterId), starterIds: ["0"], table, games, now: WED_0919, reviewDays: REVIEW_DAYS }).size).toBe(0);
  });
});

describe("the flag on the trade snapshot", () => {
  const base = snapshot();
  const snapW = markWeekLocked(base, locked(WED_0919));
  const oursW = snapW.rosterOf.get(LEAGUE.ourRosterId)!;
  const oursPlain = snapshot().rosterOf.get(LEAGUE.ourRosterId)!;
  const r1 = snapshot().rosterOf.get(1)!;
  const tate = r1.find((p) => p.name === "Carnell Tate")!;
  const by = (roster: TradePlayer[], name: string): TradePlayer => roster.find((p) => p.name === name)!;

  test("markWeekLocked flags only our locked players and leaves every other roster alone", () => {
    expect(by(oursW, "Colston Loveland").weekLocked).toBe(true);
    expect(by(oursW, "Jacksonville Jaguars").weekLocked).toBe(true);
    expect(by(oursW, "RJ Harvey").weekLocked).toBeUndefined();
    expect(by(oursW, "Jakobi Meyers").weekLocked).toBeUndefined();
    expect(snapW.rosterOf.get(1)).toBe(base.rosterOf.get(1));
    expect(markWeekLocked(base, new Set())).toBe(base);
  });
  test("canDrop and giveEligibleForProposal refuse a locked man, in words a rival may read", () => {
    const v = canDrop("Colston Loveland", oursW, DEFAULT_RAILS);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/starting lineup this week/);
    expect(v.reason).not.toMatch(/slot|kept|cut/);
    expect(giveEligibleForProposal(by(oursW, "Jacksonville Jaguars"), oursW, cfg).ok).toBe(false);
    expect(giveEligibleForProposal(by(oursW, "Jakobi Meyers"), oursW, cfg).ok).toBe(true);
    expect(giveEligibleForProposal(by(oursW, "RJ Harvey"), oursW, cfg).ok).toBe(true);
  });
  test("the Tate deal: accepted by the evaluator without the flag, rail-rejected with it", () => {
    const deal = { receive: [tate], give: [by(oursPlain, "Colston Loveland"), by(oursPlain, "Jacksonville Jaguars")] };
    expect(evaluateTradeTwoSided(deal, oursPlain, r1, cfg).verdict).toBe("accept");
    const ev = evaluateTradeTwoSided(deal, oursW, r1, cfg);
    expect(ev.verdict).toBe("reject");
    expect(ev.railBlocks).toHaveLength(2);
    expect(ev.railBlocks[0]).toContain("Colston Loveland");
  });
  test("the Wednesday proposer never offers a locked man: the Tate deal is gone, the Harvey deals (he plays Thursday) remain", () => {
    const lockedNames = new Set(names(locked(WED_0919)));
    const allPlain: string[] = [], allLocked: string[] = [];
    for (const [rid, roster] of snapshot().rosterOf) {
      if (rid === LEAGUE.ourRosterId) continue;
      const rival = { managerId: String(rid), teamName: `roster ${rid}`, roster };
      allPlain.push(...proposeTrades(oursPlain, [rival], cfg, 5).map((p) => p.why));
      for (const p of proposeTrades(oursW, [rival], cfg, 5)) {
        allLocked.push(p.why);
        for (const g of p.offer.give) expect(lockedNames.has(g.name)).toBe(false);
      }
    }
    expect(allPlain.some((w) => w.startsWith("we get Carnell Tate (WR) for Colston Loveland (TE) + Jacksonville Jaguars (DEF)"))).toBe(true);
    expect(allLocked.some((w) => w.includes("Colston Loveland") || w.includes("Jacksonville Jaguars"))).toBe(false);
    expect(allLocked.some((w) => w.startsWith("we get Jameson Williams (WR) for RJ Harvey (RB)"))).toBe(true);
    expect(allLocked.length).toBeGreaterThan(0);
  }, 60_000);
  test("an inbound offer for Loveland mid-week is refused with the week in the reply, and is a deal again once the week is played", () => {
    // Isaiah Likely (TE, 137.8) for Loveland (112.3): +4.6 to us, -2.6 to
    // roster 4, clears the acceptor's bar on the capture.
    const r4 = snapshot().rosterOf.get(4)!;
    const kraft = r4.find((p) => p.name === "Isaiah Likely")!;
    const offer = { receive: [kraft], give: [by(oursPlain, "Colston Loveland")] };
    expect(evaluateTradeTwoSided(offer, oursPlain, r4, cfg).verdict).toBe("accept");
    const ev = evaluateTradeTwoSided({ receive: [kraft], give: [by(oursW, "Colston Loveland")] }, oursW, r4, cfg);
    expect(ev.verdict).toBe("reject");
    const reply = tradeReplyText(ev, { receive: ["Isaiah Likely"], give: ["Colston Loveland"] }, null);
    expect(reply).toMatch(/^Rejected: "Colston Loveland" is in my starting lineup this week/);
    // Monday: nothing locked, the same offer clears.
    const oursMon = markWeekLocked(snapshot(), locked(MON_0800)).rosterOf.get(LEAGUE.ourRosterId)!;
    expect(evaluateTradeTwoSided({ receive: [kraft], give: [by(oursMon, "Colston Loveland")] }, oursMon, r4, cfg).verdict).toBe("accept");
  });
});
