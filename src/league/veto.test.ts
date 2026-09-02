import { test, expect } from "bun:test";
import { assessVeto, DEFAULT_VETO, type ReviewTrade } from "./veto.ts";
import type { TradePlayer } from "../analysis/trade.ts";

const P = (name: string, position: string, points: number): TradePlayer => ({ name, position, points });
// Two rival rosters. Roster 2 is a contender we are chasing; roster 4 is not.
function rosters(): Map<number, TradePlayer[]> {
  const base = () => [P("QB","QB",280), P("RB1","RB",240), P("RB2","RB",210), P("WR1","WR",250), P("WR2","WR",230), P("TE","TE",180), P("K","K",40), P("DEF","DEF",10)];
  return new Map([[2, [...base(), P("STAR","RB",300), P("junk2","WR",50)]], [4, [...base(), P("junk4","WR",55)]]]);
}
const players = new Map<string, TradePlayer>([["star", P("STAR","RB",300)], ["junk4", P("junk4","WR",55)]]);
const playerOf = (id: string) => players.get(id) ?? P(id, "", 0);

test("a fair trade is allowed, and allowing needs no action", () => {
  // roster 4 sends junk4, roster 2 sends junk2: nobody's lineup really moves.
  const tx: ReviewTrade = { transactionId: "t", rosterIds: [2, 4], adds: { junk4: 2 }, drops: { junk4: 4 } };
  expect(assessVeto(tx, rosters(), playerOf).verdict).toBe("allow");
});

test("a blatant dump TO a team we are chasing is flagged, not vetoed", () => {
  // roster 4 hands STAR to roster 2 for nothing. Roster 2 is a threat.
  const tx: ReviewTrade = { transactionId: "t", rosterIds: [2, 4], adds: { star: 2 }, drops: { star: 4 } };
  const cfg = { ...DEFAULT_VETO, threats: [2] };
  const a = assessVeto(tx, new Map([[2, rosters().get(2)!], [4, [...rosters().get(4)!, P("STAR","RB",300)]]]), playerOf, cfg);
  expect(a.verdict).toBe("flag");
  expect(a.reason).toMatch(/dump|chasing/);
});

test("the same dump to a NON-threat is left alone: not our fight", () => {
  const tx: ReviewTrade = { transactionId: "t", rosterIds: [2, 4], adds: { star: 4 }, drops: { star: 4 } };
  const start = new Map([[2, rosters().get(2)!], [4, [...rosters().get(4)!, P("STAR","RB",300)]]]);
  const a = assessVeto({ ...tx, adds: { star: 4 }, drops: { star: 2 } }, start, playerOf, { ...DEFAULT_VETO, threats: [2] });
  expect(a.verdict).toBe("allow");
});

test("verdict is never veto: the coach only ever allows or flags", () => {
  const tx: ReviewTrade = { transactionId: "t", rosterIds: [2, 4], adds: { star: 2 }, drops: { star: 4 } };
  const v = assessVeto(tx, new Map([[2, rosters().get(2)!], [4, [...rosters().get(4)!, P("STAR","RB",300)]]]), playerOf, { ...DEFAULT_VETO, threats: [2] }).verdict;
  expect(["allow", "flag"]).toContain(v);
});
