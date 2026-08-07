#!/usr/bin/env bun
// Deterministic proof of the draft turn-detection and roster-construction rules.
// No browser, no network — pure logic.  bun run src/draft/selftest.ts

import { slotOnClock, positionCap } from "./logic.ts";

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

console.log(fail === 0 ? "\nALL PASS ✓" : `\n${fail} FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
