// Pure draft logic, split out so it can be unit-tested with no browser/network.

// Which team's slot is on the clock at a 1-based overall pick number, in a
// snake draft. Round 1 goes 1..T, round 2 goes T..1, and so on.
export function slotOnClock(pickNo: number, teams: number): number {
  const idx = (pickNo - 1) % teams;
  const round = Math.ceil(pickNo / teams);
  return round % 2 === 1 ? idx + 1 : teams - idx;
}

// The overall (1-based) pick number that a given slot owns in a given round of
// a snake draft. Odd rounds run low→high slot, even rounds high→low.
export function ownPickNo(round: number, slot: number, teams: number): number {
  const base = (round - 1) * teams;
  return round % 2 === 1 ? base + slot : base + (teams - slot + 1);
}

// The next overall pick number after `currentPick` that belongs to `slot`, or
// null if the draft ends first. Used to size the snake gap for VONA survival.
export function nextOwnPickNo(currentPick: number, slot: number, teams: number, rounds: number): number | null {
  for (let p = currentPick + 1; p <= teams * rounds; p++) {
    if (slotOnClock(p, teams) === slot) return p;
  }
  return null;
}

// Roster-construction guardrail for our 8-team, 1QB/2RB/2WR/1TE/2FLEX/K/DEF
// league. Encodes Filip's sense: NO tight end or QB in the early rounds at all
// (RB/WR only), one TE, one QB, K/DEF only at the very end, RB/WR depth. `cap`
// is the max we'll roster at a position by the given round.
// QB: exactly one in a 1-QB league — no backup until the very last round (a
// second QB earlier is a wasted pick vs. RB/WR flex depth; self-critique of a
// mock where it burned round 11 on a backup).
export function positionCap(pos: string, round: number): number {
  switch (pos) {
    case "QB": return round < 6 ? 0 : round >= 15 ? 2 : 1;
    case "TE": return round < 5 ? 0 : round < 13 ? 1 : 2;
    case "K": return round >= 14 ? 1 : 0;
    case "DEF": return round >= 13 ? 1 : 0;
    case "RB": return 7;
    case "WR": return 7;
    default: return 6;
  }
}
