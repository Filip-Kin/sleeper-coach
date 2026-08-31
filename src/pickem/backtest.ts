#!/usr/bin/env bun
// Regenerates every number quoted in strategy.ts. Run this before trusting the
// rule, and again if Sleeper changes how it sources lines.
//
//   bun run pickem-backtest              use the cache, or fetch if absent
//   bun run pickem-backtest --refresh    re-fetch history from Sleeper
//
// The validity check that matters: a game only counts if Sleeper's market line
// was provably last updated BEFORE kickoff. Without that filter the result is
// look-ahead bias, because a line stamped after the game started could contain
// the result. That filter drops about 3% of games and the edge survives it.

import { browserGql, fetchWeek, type PickemGame } from "./client.ts";

const CACHE = `${process.env.STATE_DIR ?? "/data/sleeper-coach"}/pickem-history.json`;
const SEASONS = (process.env.PICKEM_BACKTEST_SEASONS ?? "2024,2025").split(",");
const REFRESH = process.argv.includes("--refresh");

async function load(): Promise<PickemGame[]> {
  if (!REFRESH) {
    const f = Bun.file(CACHE);
    if (await f.exists()) {
      const rows = (await f.json()) as PickemGame[];
      console.log(`[backtest] ${rows.length} games from cache ${CACHE}`);
      return rows;
    }
  }
  const gql = browserGql();
  const out: PickemGame[] = [];
  for (const season of SEASONS) {
    for (let week = 1; week <= 18; week++) {
      out.push(...(await fetchWeek(gql, week, season)));
    }
    console.log(`[backtest] fetched ${season} (${out.length} games so far)`);
  }
  await Bun.write(CACHE, JSON.stringify(out));
  return out;
}

interface Graded extends PickemGame { gap: number }

function usable(rows: PickemGame[]): Graded[] {
  return rows.flatMap((g) => {
    if (g.status !== "complete") return [];
    if (g.awayScore === null || g.homeScore === null) return [];
    if (g.gradedSpreadAway === null || g.marketSpreadAway === null) return [];
    // Provably knowable before kickoff, or it is look-ahead bias.
    if (g.marketUpdatedAt === null || g.marketUpdatedAt >= g.startTime) return [];
    const gap = g.gradedSpreadAway - g.marketSpreadAway;
    if (Math.abs(gap) > 10) return []; // data errors, not line moves
    return [{ ...g, gap }];
  });
}

/** Did the away team cover the GRADED line? No pushes: the line always ends .5. */
function awayCovered(g: Graded): boolean {
  return g.awayScore! + g.gradedSpreadAway! > g.homeScore!;
}
function staleSidePick(g: Graded): boolean {
  return g.gap > 0 ? awayCovered(g) : !awayCovered(g);
}
function favouritePick(g: Graded): boolean {
  return g.gradedSpreadAway! > 0 ? !awayCovered(g) : awayCovered(g);
}

function logChoose(n: number, k: number): number {
  let r = 0;
  for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
  return r;
}
/** P(X >= w) for n fair coin flips. Exact enough via logs to avoid overflow. */
function pValue(w: number, n: number): number {
  if (!n) return 1;
  let p = 0;
  for (let k = w; k <= n; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, p);
}

function report(label: string, wins: boolean[]): void {
  const n = wins.length;
  const w = wins.filter(Boolean).length;
  if (!n) { console.log(`  ${label.padEnd(46)} n=0`); return; }
  console.log(`  ${label.padEnd(46)} ${String(w).padStart(4)}/${String(n).padEnd(4)} = ` +
    `${((100 * w) / n).toFixed(2).padStart(6)}%  p=${pValue(w, n).toFixed(4)}`);
}

const rows = await load();
const games = usable(rows);
console.log(`\n[backtest] ${games.length} usable games (complete, both lines, market line pre-kickoff)`);
const bySeason: Record<string, number> = {};
for (const g of games) bySeason[g.gameId.slice(0, 4)] = (bySeason[g.gameId.slice(0, 4)] ?? 0) + 1;
console.log(`[backtest] by season: ${JSON.stringify(bySeason)}\n`);

console.log("gap buckets in isolation (does a disagreement of this size pay?):");
for (const [lo, hi] of [[0.5, 0.5], [1.0, 1.0], [1.5, 1.5], [2.0, 3.0], [3.5, 10]] as [number, number][]) {
  const sub = games.filter((g) => Math.abs(g.gap) >= lo - 1e-9 && Math.abs(g.gap) <= hi + 1e-9);
  report(`gap ${lo}-${hi}, take the market side`, sub.map(staleSidePick));
}
report("gap 0 (no signal), take the favourite", games.filter((g) => Math.abs(g.gap) < 1e-9).map(favouritePick));

console.log("\nfull slate (we must pick every game):");
for (const thr of [0.5, 1.0, 1.5, 2.0]) {
  report(`market rule when gap>=${thr}, else favourite`,
    games.map((g) => (Math.abs(g.gap) >= thr - 1e-9 ? staleSidePick(g) : favouritePick(g))));
}
report("favourite every time (the baseline to beat)", games.map(favouritePick));
report("CONTROL: opposite of the market move", games.filter((g) => Math.abs(g.gap) >= 1).map((g) => !staleSidePick(g)));

const totals = rows.filter((g) => g.status === "complete" && g.awayScore !== null)
  .map((g) => g.awayScore! + g.homeScore!).sort((a, b) => a - b);
if (totals.length) {
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
  console.log(`\ntiebreaker prior from ${totals.length} games: mean ${mean.toFixed(1)}, ` +
    `median ${totals[Math.floor(totals.length / 2)]}, sd ${sd.toFixed(1)}`);
  console.log("  (strategy.ts holds TOTAL_POINTS_MEAN / TOTAL_POINTS_SD — update them if these moved)");
}
