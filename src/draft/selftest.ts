#!/usr/bin/env bun
// Deterministic proof of the draft turn-detection and roster-construction rules.
// No browser, no network — pure logic.  bun run src/draft/selftest.ts

import { slotOnClock, positionCap, ownPickNo, nextOwnPickNo } from "./logic.ts";
import { survivalProb, expectedBestLaterVor, rankByVona } from "../analysis/vona.ts";
import type { RankedPlayer } from "../analysis/vor.ts";
import { rankByVor } from "../analysis/vor.ts";
import { byeWeek, byeCounts, BYE_WEEKS } from "../data/byes.ts";
import { applyNews, newsMultiplier, newsFor, type NewsEntry } from "../data/news.ts";

let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!cond) fail++;
}

const teams = 8;

// Snake order: R1 1..8, R2 8..1, R3 1..8
const seq = Array.from({ length: 24 }, (_, i) => slotOnClock(i + 1, teams));
check("snake order, 24 picks", JSON.stringify(seq) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 7, 8]), seq.join(","));

// Which overall picks belong to slot 2 (the turn-detection the coach uses)
const mine = Array.from({ length: teams * 15 }, (_, i) => i + 1).filter((p) => slotOnClock(p, teams) === 2);
check("slot 2 pick numbers", JSON.stringify(mine.slice(0, 4)) === JSON.stringify([2, 15, 18, 31]), mine.slice(0, 6).join(","));

// Roster caps encode Filip's rules
check("no TE in rounds 1-4", positionCap("TE", 2) === 0 && positionCap("TE", 4) === 0);
check("one TE from round 5", positionCap("TE", 5) === 1);
check("no QB in rounds 1-4", positionCap("QB", 3) === 0);
check("one QB mid-draft, no backup until the last round",
  positionCap("QB", 6) === 1 && positionCap("QB", 11) === 1 && positionCap("QB", 15) === 2);
check("K only from round 14", positionCap("K", 13) === 0 && positionCap("K", 14) === 1);
check("DEF only from round 13", positionCap("DEF", 12) === 0 && positionCap("DEF", 13) === 1);

// Rounds 1-4 must allow ONLY RB and WR
for (const r of [1, 2, 3, 4]) {
  const allowed = ["QB", "RB", "WR", "TE", "K", "DEF"].filter((pos) => positionCap(pos, r) > 0).sort();
  check(`round ${r} allows only RB,WR`, JSON.stringify(allowed) === JSON.stringify(["RB", "WR"]), allowed.join(","));
}

// #region VONA
// Snake pick numbers for our slot (slot 4 in an 8-team draft): R1=4, R2=13, R3=20, R4=29
check("ownPickNo snake, slot 4", [1, 2, 3, 4].map((r) => ownPickNo(r, 4, teams)).join(",") === "4,13,20,29");
check("ownPickNo snake, slot 1", [1, 2, 3].map((r) => ownPickNo(r, 1, teams)).join(",") === "1,16,17");
check("nextOwnPickNo after our R1 (slot 4)", nextOwnPickNo(ownPickNo(1, 4, teams), 4, teams, 15) === 13);
check("nextOwnPickNo null in final round", nextOwnPickNo(ownPickNo(15, 4, teams), 4, teams, 15) === null);

// Survival: an ADP far after our next pick is near-certain; far before, near-zero; unknown = 1.
check("survival high when ADP well past next pick", survivalProb(60, 20, 8) > 0.95);
check("survival low when ADP well before next pick", survivalProb(5, 25, 8) < 0.1, survivalProb(5, 25, 8).toFixed(3));
check("survival ~0.5 at the pick", Math.abs(survivalProb(20, 20, 8) - 0.5) < 1e-9);
check("survival = 1 for unknown ADP (999)", survivalProb(999, 20, 8) === 1);
check("wider spread is humbler (closer to 0.5)", survivalProb(5, 20, 20) > survivalProb(5, 20, 4));

// Expected best-available-later: with a certain survivor it equals that survivor's VOR;
// with the top guy certainly gone it drops to the next survivor.
check("expBestLater = top when top certain to survive",
  expectedBestLaterVor([{ vor: 40, pSurvive: 1 }, { vor: 30, pSurvive: 1 }]) === 40);
check("expBestLater drops when top certainly gone",
  expectedBestLaterVor([{ vor: 40, pSurvive: 0 }, { vor: 30, pSurvive: 1 }]) === 30);

// VONA end-to-end: two positions, equal top raw value, but RB is a cliff (steep
// drop + all likely gone) while WR is deep + likely to fall back. VONA must
// prefer the RB even though raw VOR is tied.
const mkP = (name: string, position: string, points: number) =>
  ({ playerId: name, name, position, team: "X", points, ptsPpr: points, adp: 999, injuryStatus: null, stats: {} } as never);
const mk = (name: string, position: string, vor: number, adp: number): RankedPlayer =>
  ({ playerId: name, name, position, team: "X", points: vor, ptsPpr: vor, adp, injuryStatus: null, stats: {}, vor, tier: 1, posRank: 1 } as RankedPlayer);
const nextPick = 20;
const scarceRB = mk("Cliff RB", "RB", 50, 8);   // elite, will be long gone by pick 20
const deepWR1 = mk("Deep WR1", "WR", 50, 8);     // same value, but...
const deepWR2 = mk("Deep WR2", "WR", 48, 60);    // a near-equal WR falls back to us
const ranked = rankByVona([scarceRB, deepWR1, deepWR2], { nextPickNo: nextPick, adpSpread: 8 });
check("VONA drafts the scarce RB over the equal-value deep WR", ranked[0]!.name === "Cliff RB", ranked.map((r) => `${r.name}:${r.vona}`).join(" "));
check("deep WR VONA is small (it falls back)", ranked.find((r) => r.name === "Deep WR1")!.vona < ranked[0]!.vona);

// Opponent nudge only ever lowers survival (never raises it), and is bounded.
const base = rankByVona([mk("TE1", "TE", 30, 25)], { nextPickNo: 20, adpSpread: 8 })[0]!;
const nudged = rankByVona([mk("TE1", "TE", 30, 25)], { nextPickNo: 20, adpSpread: 8, gapDemand: { TE: 1 }, oppNudge: 0.15 })[0]!;
check("opponent nudge lowers TE survival", nudged.pSurvive < base.pSurvive);
// #endregion


// #region byes + news layer
check("all 32 teams have a bye", Object.keys(BYE_WEEKS).length === 32, String(Object.keys(BYE_WEEKS).length));
check("byes fall in weeks 5-14", Object.values(BYE_WEEKS).every((w) => w >= 5 && w <= 14));
check("Sleeper spells Washington WAS, not WSH", byeWeek("WAS") === 7 && byeWeek("WSH") === null);
check("unknown team has no bye", byeWeek("ZZZ") === null && byeWeek(null) === null);
const bc = byeCounts(["CHI", "CHI", "DET", null, "ZZZ"]);
check("byeCounts groups by week", bc.get(10) === 2 && bc.get(6) === 1, [...bc.entries()].map(([w, n]) => `${w}:${n}`).join(" "));

const newsMap = new Map<string, NewsEntry>([
  ["out man", { status: "out", note: "done" }],
  ["risk man", { status: "risk", note: "maybe" }],
  ["soft man", { status: "soft", note: "noise" }],
  ["watch man", { status: "watch", note: "knock" }],
  ["exact man", { status: "risk", note: "half", multiplier: 0.5 }],
]);
check("out is near-zeroed", newsMultiplier(newsMap.get("out man")) < 0.1);
check("risk takes a haircut", newsMultiplier(newsMap.get("risk man")) === 0.85);
check("soft and watch do NOT change value", newsMultiplier(newsMap.get("soft man")) === 1 && newsMultiplier(newsMap.get("watch man")) === 1);
check("explicit multiplier wins", newsMultiplier(newsMap.get("exact man")) === 0.5);
check("no entry means no change", newsMultiplier(undefined) === 1);
// Loose name matching: punctuation, case and generational suffixes.
const looseMap = new Map<string, NewsEntry>([["jamarr chase", { status: "soft", note: "n" }]]);
check("name match ignores punctuation/case", !!newsFor(looseMap, "Ja'Marr Chase"));
check("name match ignores Jr/III", !!newsFor(new Map([["brian thomas", { status: "soft", note: "n" } as NewsEntry]]), "Brian Thomas Jr."));

// The baseline trap: devaluing fringe players must NOT move anyone else's VOR.
const league = { settings: { num_teams: 8 }, roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN"] } as never;
const rbs = Array.from({ length: 30 }, (_, i) => mkP(`RB${i + 1}`, "RB", 300 - i * 5));
const rawRank = rankByVor(rbs, league);
const starVorRaw = rawRank.find((r) => r.name === "RB1")!.vor;
// Dock four backs sitting right around the replacement line (RB23 in this league).
const hurt = new Map<string, NewsEntry>([21, 22, 23, 24].map((n) => [`rb${n}`, { status: "risk", note: "hurt" } as NewsEntry]));
const { adjusted } = applyNews(rbs, hurt);
const naive = rankByVor(adjusted, league).find((r) => r.name === "RB1")!.vor;
const fixed = rankByVor(adjusted, league, rbs).find((r) => r.name === "RB1")!.vor;
check("naive re-rank INFLATES the healthy star (the bug)", naive > starVorRaw, `${starVorRaw} -> ${naive}`);
check("baselineFrom keeps the healthy star unchanged", fixed === starVorRaw, `${starVorRaw} -> ${fixed}`);
check("the devalued player still drops", rankByVor(adjusted, league, rbs).find((r) => r.name === "RB21")!.vor < rawRank.find((r) => r.name === "RB21")!.vor);
// #endregion

console.log(fail === 0 ? "\nALL PASS ✓" : `\n${fail} FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
