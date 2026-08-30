import { solveLineup, availabilityOf, startingSlots, starterIds, type LineupPlayer } from "./lineup.ts";

// Offline, synthetic tests for the lineup solver. No network, no live writes.
// These pin the properties the solver MUST hold: it never strands a slot, it
// never starts a player who is not playing, and greedy-by-restrictiveness really
// does return the optimal total on the cases designed to break a naive top-down
// fill.

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

// This league's starting slots.
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
const p = (playerId: string, position: string, points: number, extra: Partial<LineupPlayer> = {}): LineupPlayer =>
  ({ playerId, name: playerId, position, points, ...extra });

// 1. startingSlots strips BN and IR but keeps the ten starting slots in order.
t(
  "startingSlots drops BN/IR and keeps starting order",
  JSON.stringify(startingSlots([...SLOTS, "BN", "BN", "IR"])) === JSON.stringify(SLOTS),
);

// 2. The naive top-down trap: the two best players overall are WRs, but a naive
//    "best 10 by points" fill would put three WRs in WR+WR+FLEX and still need a
//    QB. The solver must fill every slot and never leave QB empty.
const trap: LineupPlayer[] = [
  p("wr1", "WR", 30), p("wr2", "WR", 29), p("wr3", "WR", 28), p("wr4", "WR", 12),
  p("qb1", "QB", 18), p("rb1", "RB", 20), p("rb2", "RB", 15), p("rb3", "RB", 8),
  p("te1", "TE", 10), p("k1", "K", 9), p("def1", "DEF", 7),
];
const trapLineup = solveLineup(trap, SLOTS);
t("fills every slot (no stranded QB)", trapLineup.unfilled.length === 0, trapLineup.unfilled.join(","));
t("QB slot holds the only QB", trapLineup.slots[0]?.player?.playerId === "qb1");
// Optimal: QB18 + RB20 + RB15 + WR30 + WR29 + TE10 + FLEX(WR28) + FLEX(WR12) + K9 + DEF7 = 178.
// (Both FLEX go to the leftover WRs, not the weaker RB3 — the point of the trap.)
t("returns the optimal total on the trap case", trapLineup.total === 178, String(trapLineup.total));

// 3. Brute-force check: on a random-ish roster the greedy total equals the true
//    optimum found by exhaustive assignment. This is the real proof that
//    restrictiveness-ordering is optimal, not just plausible.
function bruteForceBest(players: LineupPlayer[], slots: string[]): number {
  const elig: Record<string, Set<string>> = {
    QB: new Set(["QB"]), RB: new Set(["RB"]), WR: new Set(["WR"]), TE: new Set(["TE"]),
    K: new Set(["K"]), DEF: new Set(["DEF"]), FLEX: new Set(["RB", "WR", "TE"]),
  };
  let best = 0;
  const used = new Array(players.length).fill(false);
  const rec = (slotIdx: number, sum: number): void => {
    if (slotIdx === slots.length) { best = Math.max(best, sum); return; }
    const accept = elig[slots[slotIdx]!]!;
    let filledAny = false;
    for (let i = 0; i < players.length; i++) {
      if (used[i] || !accept.has(players[i]!.position)) continue;
      filledAny = true;
      used[i] = true;
      rec(slotIdx + 1, sum + players[i]!.points);
      used[i] = false;
    }
    if (!filledAny) rec(slotIdx + 1, sum); // slot left empty
  };
  rec(0, 0);
  return Math.round(best * 100) / 100;
}

let matched = 0;
for (let seed = 0; seed < 40; seed++) {
  // Deterministic pseudo-random roster.
  let s = seed * 2654435761 % 2 ** 31;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const roster: LineupPlayer[] = [];
  for (let i = 0; i < 14; i++) {
    const pos = positions[Math.floor(rnd() * positions.length)]!;
    roster.push(p(`p${i}`, pos, Math.round(rnd() * 300) / 10));
  }
  // Guarantee at least one of each mandatory single-slot position so a full
  // lineup is possible and the totals are comparable.
  roster.push(p("mq", "QB", 5), p("mk", "K", 4), p("md", "DEF", 3), p("mt", "TE", 2), p("mr", "RB", 2), p("mw", "WR", 2));
  const greedy = solveLineup(roster, SLOTS).total;
  const brute = bruteForceBest(roster, SLOTS);
  if (Math.abs(greedy - brute) < 0.01) matched++;
  else console.log(`        seed ${seed}: greedy ${greedy} != brute ${brute}`);
}
t("greedy equals brute-force optimum on 40 random rosters", matched === 40, `${matched}/40`);

// 4. A player who is OUT / on bye / inactive is NEVER started, even when he is
//    the highest projection at his slot. This is the single most expensive
//    avoidable mistake, so it is the sharpest test here.
const withHurt: LineupPlayer[] = [
  p("qbA", "QB", 40, { injuryStatus: "Out" }), // huge projection but OUT
  p("qbB", "QB", 12),
  p("rb1", "RB", 20, { onBye: true }), // best RB but on bye
  p("rb2", "RB", 14), p("rb3", "RB", 10),
  p("wr1", "WR", 18, { inactive: true }), // scratched
  p("wr2", "WR", 16), p("wr3", "WR", 11),
  p("te1", "TE", 9), p("k1", "K", 8), p("def1", "DEF", 6),
];
const hurtLineup = solveLineup(withHurt, SLOTS);
const startedIds = new Set(hurtLineup.starters.map((x) => x.playerId));
t("never starts an OUT player", !startedIds.has("qbA"));
t("never starts a bye player", !startedIds.has("rb1"));
t("never starts an inactive player", !startedIds.has("wr1"));
t("QB slot falls through to the healthy QB", hurtLineup.slots[0]?.player?.playerId === "qbB");
t("excluded list records the three zeroed-out players", hurtLineup.excluded.length === 3, String(hurtLineup.excluded.length));

// 5. Questionable is NOT treated as out (Sleeper blanket-tags half the league Q).
t("Questionable stays available", availabilityOf(p("x", "WR", 10, { injuryStatus: "Questionable" })).available);
t("Out is unavailable", !availabilityOf(p("x", "WR", 10, { injuryStatus: "Out" })).available);
t("IR is unavailable", !availabilityOf(p("x", "WR", 10, { injuryStatus: "IR" })).available);

// 6. The elite/mediocre TE non-issue: the same two players start whether the
//    elite TE sits in TE or FLEX, and the total is identical either way.
const twoTe: LineupPlayer[] = [
  p("teElite", "TE", 22), p("teMeh", "TE", 6),
  p("qb", "QB", 18), p("rb1", "RB", 16), p("rb2", "RB", 14),
  p("wr1", "WR", 15), p("wr2", "WR", 13), p("wr3", "WR", 11), p("rb3", "RB", 12),
  p("k", "K", 8), p("def", "DEF", 7),
];
const teLineup = solveLineup(twoTe, SLOTS);
t("elite TE is started (slot placement is irrelevant to total)", new Set(teLineup.starters.map((x) => x.playerId)).has("teElite"));

// 7. starterIds returns one id per slot in order, and throws on an unfillable slot.
t("starterIds yields one id per starting slot", starterIds(trapLineup).length === SLOTS.length);
let threw = false;
try {
  // A roster with no kicker leaves the K slot unfilled.
  starterIds(solveLineup([p("qb", "QB", 10), p("rb1", "RB", 9), p("rb2", "RB", 8), p("wr1", "WR", 7), p("wr2", "WR", 6), p("te", "TE", 5), p("rb3", "RB", 4), p("wr3", "WR", 3), p("def", "DEF", 2)], SLOTS));
} catch { threw = true; }
t("starterIds throws rather than set a partial lineup", threw);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
