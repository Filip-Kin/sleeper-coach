import { solveLineup, startingSlots, type LineupPlayer } from "./lineup.ts";

// Offline replay harness for the lineup solver.
//
// The idea: take a week that has already happened, feed the solver only what it
// would have known at lock time (the roster and that week's PROJECTIONS, plus
// injury/bye state), let it pick a lineup, then score that lineup against what
// each player ACTUALLY did. The measure is "points left on the bench versus
// perfect hindsight": how many real points a perfectly clairvoyant manager would
// have scored, minus how many the solver's projection-based lineup scored.
//
// This is the regression test for the part of the system most likely to be
// subtly wrong, and it needs no live writes and no live network: a fixture is a
// frozen snapshot of one real week (see fixtures/ and scripts/build-replay-fixture.ts).
//
// A note on the metric, learned the hard way on draft night: only ever compare
// STARTING-LINEUP totals, never a cross-position "value" gap. A defence being 40
// points "better" than a receiver is not a 40-point cost when defence is capped
// at one starter. Scoring the assembled starting lineup sidesteps that entirely,
// because both the solver lineup and the hindsight lineup are complete, legal
// ten-player lineups scored the same way.

export interface FixturePlayer {
  playerId: string;
  name: string;
  position: string;
  projPoints: number; // what the solver saw at lock time, under league scoring
  actualPoints: number; // what he actually scored that week, under league scoring
  injuryStatus?: string | null; // status known at lock time
  onBye?: boolean;
  inactive?: boolean; // known-inactive at lock time (rare in historical data)
}

export interface WeekFixture {
  season: string;
  week: number;
  leagueId: string;
  rosterId: number;
  slots: string[]; // starting slots in roster_positions order (BN/IR removed)
  players: FixturePlayer[];
  // What the manager ACTUALLY started that week, for reference/comparison. Not
  // used in scoring the solver, but handy to show whether the solver would have
  // beaten the human.
  actualStarters?: string[];
}

export interface ReplayResult {
  season: string;
  week: number;
  solverStarters: { playerId: string; name: string; slot: string; proj: number; actual: number }[];
  solverProjTotal: number; // what the solver expected to score
  solverActualTotal: number; // what the solver's lineup actually scored
  perfectActualTotal: number; // best possible actual lineup (perfect hindsight)
  pointsLeftOnBench: number; // perfectActual - solverActual, >= 0
  humanActualTotal: number | null; // what the real manager scored, if known
  benchedStarter: { name: string; actual: number } | null; // biggest actual scorer the solver benched
  startedNonPlayer: { name: string; proj: number } | null; // any zero-actual player the solver started (a real miss)
}

// Score one fixture week. Pure: no IO.
export function replayWeek(fx: WeekFixture): ReplayResult {
  const slots = fx.slots.length ? fx.slots : startingSlots(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"]);

  // The solver sees PROJECTIONS and the availability state known at lock time.
  const asProjected: LineupPlayer[] = fx.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    points: p.projPoints,
    injuryStatus: p.injuryStatus,
    onBye: p.onBye,
    inactive: p.inactive,
  }));
  const solved = solveLineup(asProjected, slots);

  // Perfect hindsight sees ACTUAL points and no availability flags: a player who
  // did not play simply scored ~0 and will not be chosen over a real scorer, so
  // the best-actual lineup falls out of the same solver run on actual points.
  const asActual: LineupPlayer[] = fx.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    points: p.actualPoints,
  }));
  const perfect = solveLineup(asActual, slots);

  const actualById = new Map(fx.players.map((p) => [p.playerId, p.actualPoints]));

  const solverStarters = solved.slots.map((s) => ({
    playerId: s.player?.playerId ?? "",
    name: s.player?.name ?? "(empty)",
    slot: s.slot,
    proj: s.player?.points ?? 0,
    actual: s.player ? (actualById.get(s.player.playerId) ?? 0) : 0,
  }));

  const solverActualTotal = round(solverStarters.reduce((t, s) => t + s.actual, 0));
  const perfectActualTotal = round(perfect.starters.reduce((t, p) => t + p.points, 0));

  // Biggest actual scorer the solver left on the bench, versus what it started
  // at that player's slot family. A useful "what did we miss" pointer, not a cost.
  const startedIds = new Set(solved.starters.map((p) => p.playerId));
  let benchedStarter: { name: string; actual: number } | null = null;
  for (const p of fx.players) {
    if (startedIds.has(p.playerId)) continue;
    if (!benchedStarter || p.actualPoints > benchedStarter.actual) benchedStarter = { name: p.name, actual: p.actualPoints };
  }

  // Did the solver start anyone who scored ~0 (a player who did not really play)?
  // This is the expensive mistake the availability zeroing exists to prevent, so
  // surface it explicitly.
  let startedNonPlayer: { name: string; proj: number } | null = null;
  for (const s of solverStarters) {
    if (s.playerId && s.actual <= 0.01) {
      if (!startedNonPlayer || s.proj > startedNonPlayer.proj) startedNonPlayer = { name: s.name, proj: s.proj };
    }
  }

  const humanActualTotal = fx.actualStarters
    ? round(fx.actualStarters.reduce((t, id) => t + (actualById.get(id) ?? 0), 0))
    : null;

  return {
    season: fx.season,
    week: fx.week,
    solverStarters,
    solverProjTotal: round(solved.total),
    solverActualTotal,
    perfectActualTotal,
    pointsLeftOnBench: round(perfectActualTotal - solverActualTotal),
    humanActualTotal,
    benchedStarter,
    startedNonPlayer,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// A one-line human summary for logs and the CLI.
export function summariseReplay(r: ReplayResult): string {
  const vsHuman = r.humanActualTotal != null ? `, human ${r.humanActualTotal}` : "";
  const miss = r.startedNonPlayer ? ` [STARTED A NON-PLAYER: ${r.startedNonPlayer.name}]` : "";
  return (
    `${r.season} wk${r.week}: solver actual ${r.solverActualTotal}, perfect ${r.perfectActualTotal}, ` +
    `left on bench ${r.pointsLeftOnBench}${vsHuman}${miss}`
  );
}
