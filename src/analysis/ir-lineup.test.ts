// A hurt player is worth the same to a SEASON lineup on injured reserve as on
// the bench.
//
// Until 2026-09-30 a player's trade value was his full-season projection, so
// the 09-23 audit (T6) took anyone on IR out of bestLineup: counting a man who
// cannot play at a full season of points overstated the roster. On 09-30 the
// value became rest-of-season points summed from the weekly tables, which are
// zero in the weeks he is projected out. From then on the IR filter counted
// the absence twice: once in the points, once by deleting him for every week
// to the championship.
//
// What that did on the live league that morning (incidents/league.ts):
// cookieeater45 had Caleb Williams on IR, Doubtful, projected back in week 5
// at 245 rest-of-season points. The engine gave his team Sam Darnold (202) at
// quarterback for the whole season, credited them +47 for receiving Dak
// Prescott, and the proposer picked "Darnold + DJ Moore for Prescott + a
// running back" as a deal that helped both sides. It helps them by nothing:
// Williams starts from week 5. Five of seven rivals had someone on IR.
import { describe, expect, test } from "bun:test";
import { bestLineup, type TradePlayer } from "./trade.ts";
import { evaluateTradeTwoSided, proposeTrades, legalityBlocks, depthInsurance, byeAwareLineupTotal, DEFAULT_FAIRNESS, type FairnessConfig } from "./trade-fair.ts";
import { markClaimDrops, SCALED_PTS } from "./trade-wire.ts";
import { scalePts } from "./value.ts";
import { leagueSnapshot, idOf, LEAGUE, OURS } from "./incidents/league.ts";

const weeks = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const cfg: FairnessConfig = { ...scalePts(DEFAULT_FAIRNESS, 4, SCALED_PTS), remainingWeeks: 12, headToHeadRemaining: 2, upcomingWeeks: weeks, rosterCapacity: 16 };
const snap = markClaimDrops(leagueSnapshot(), LEAGUE.pendingClaims.drops);
const ours = snap.rosterOf.get(OURS)!;
const cookie = snap.rosterOf.get(1)!;
const byId = (roster: TradePlayer[], name: string): TradePlayer => roster.find((p) => p.playerId === idOf(name))!;

describe("the season lineup counts a man on IR at his rest-of-season value", () => {
  test("cookieeater45's quarterback for the season is Caleb Williams, not Sam Darnold", () => {
    expect(byId(cookie, "Caleb Williams").onIr).toBe(true);
    const qb = bestLineup(cookie).starters.find((s) => s.slot === "QB")?.player?.name;
    expect(qb).toBe("Caleb Williams");
  });
  test("IR or bench, the same player gives the same season total", () => {
    const benched = cookie.map((p) => ({ ...p, onIr: false }));
    expect(bestLineup(cookie).total).toBe(bestLineup(benched).total);
    expect(byeAwareLineupTotal(cookie, weeks)).toBe(byeAwareLineupTotal(benched, weeks));
  });
  test("a season-ending IR player adds nothing, because his points say so", () => {
    const achane = byId(snap.rosterOf.get(7)!, "De'Von Achane");
    expect(achane.onIr).toBe(true);
    expect(achane.points).toBe(0);
    const r7 = snap.rosterOf.get(7)!;
    expect(bestLineup(r7).total).toBe(bestLineup(r7.filter((p) => !p.onIr)).total);
  });
});

describe("the 09-30 phantom: Prescott to a team whose quarterback is back next week", () => {
  const offer = { give: [byId(ours, "Dak Prescott"), byId(ours, "Rico Dowdle")], receive: [byId(cookie, "Sam Darnold"), byId(cookie, "DJ Moore")] };
  test("they do not gain from it", () => {
    const ev = evaluateTradeTwoSided(offer, ours, cookie, cfg);
    expect(ev.theirGain).toBeLessThan(0);
  });
  test("so the proposer does not pick it, nor any Prescott deal with them", () => {
    const props = proposeTrades(ours, [{ managerId: "1", teamName: "roster 1", roster: cookie }], cfg, 50);
    expect(props.some((p) => p.offer.give.some((g) => g.name === "Dak Prescott"))).toBe(false);
  });
});

describe("this-week questions still leave IR out", () => {
  test("a trade that leaves a slot fillable only from IR is still illegal", () => {
    // LaPorta on IR, Andrews the only active tight end: giving Andrews away
    // leaves nobody who can play tight end until LaPorta is back.
    const roster = ours.map((p) => (p.name === "Sam LaPorta" ? { ...p, onIr: true } : p));
    const after = roster.filter((p) => p.name !== "Mark Andrews");
    expect(legalityBlocks(after, cfg).join(" ")).toMatch(/TE unfillable/);
  });
  test("depth cover ignores a man on IR (he cannot step in this week)", () => {
    const withIr = [...ours, { ...byId(cookie, "A.J. Brown"), onIr: true }];
    expect(depthInsurance(withIr, cfg)).toBe(depthInsurance(ours, cfg));
  });
  test("receiving a player who is on the rival's IR is still refused", () => {
    const ev = evaluateTradeTwoSided({ give: [byId(ours, "Josh Downs")], receive: [byId(cookie, "A.J. Brown")] }, ours, cookie, cfg);
    expect(ev.verdict).toBe("reject");
    expect(ev.fairnessBlocks.join(" ")).toMatch(/injured reserve/i);
  });
  test("giving away our own IR player is still a rail block", () => {
    const roster = ours.map((p) => (p.name === "Nico Collins" ? { ...p, onIr: true } : p));
    const ev = evaluateTradeTwoSided({ give: [byId(roster, "Nico Collins")], receive: [byId(cookie, "Chris Olave")] }, roster, cookie, cfg);
    expect(ev.verdict).toBe("reject");
    expect(ev.railBlocks.join(" ")).toMatch(/injured reserve/i);
  });
});
