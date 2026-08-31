import { readdirSync } from "node:fs";
import { replayWeek, type WeekFixture, type ReplayResult } from "./replay.ts";
import { SLOT_ELIGIBILITY } from "./lineup.ts";
import type { Position } from "../sleeper/types.ts";

// Committed, hermetic regression test for the lineup solver, run against frozen
// snapshots of real completed weeks (fixtures/, built by
// scripts/build-replay-fixture.ts from the 2025 previous-season league). No
// network, no live writes: the fixtures ARE the data. The 2026 season has not
// started, so a completed season is the only honest source of "what actually
// scored", and these fixtures carry real per-week scores from that league.
//
// The measure is points-left-on-bench versus perfect hindsight, scored on
// complete STARTING LINEUPS only (never a cross-position value gap), which is
// the metric that does not lie about capped positions like K and DEF.

const FIX_DIR = new URL("./fixtures/", import.meta.url).pathname;

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

const files = readdirSync(FIX_DIR).filter((f) => f.endsWith(".json")).sort();
t("there is at least one committed fixture to replay", files.length > 0, `${files.length} found`);

const results: ReplayResult[] = [];
for (const file of files) {
  const fx = JSON.parse(await Bun.file(FIX_DIR + file).text()) as WeekFixture;
  const r = replayWeek(fx);
  results.push(r);
  const tag = `${fx.season} wk${fx.week}`;

  // 1. Every starting slot is filled from a full roster: no empty starters.
  const emptySlots = r.solverStarters.filter((s) => s.playerId === "").map((s) => s.slot);
  t(`${tag}: fills every starting slot`, emptySlots.length === 0, `empty: ${emptySlots.join(",")}`);

  // 2. Perfect hindsight can never score less than the solver's lineup. A
  //    negative "points left on bench" means the hindsight solve is broken.
  t(`${tag}: points-left-on-bench is non-negative`, r.pointsLeftOnBench >= -0.01, String(r.pointsLeftOnBench));
  t(`${tag}: solver actual <= perfect actual`, r.solverActualTotal <= r.perfectActualTotal + 0.01);

  // 3. Local-swap optimality: the solver must never leave a higher-projection,
  //    slot-eligible player on the bench in favour of a lower one it started.
  //    (A 0-projection starter is fine and does happen in bye/injury weeks when
  //    the roster simply has no positive body left for a FLEX slot; what would be
  //    a bug is a positive bench player who should have been swapped in. The
  //    explicit OUT/bye/inactive zeroing is exercised directly in lineup.test.ts.)
  const projOf = new Map(fx.players.map((p) => [p.playerId, { pos: p.position as Position, proj: p.projPoints, name: p.name }]));
  const startedIds = new Set(r.solverStarters.map((s) => s.playerId).filter(Boolean));
  const missedSwaps: string[] = [];
  for (const s of r.solverStarters) {
    if (!s.playerId) continue;
    const accept = SLOT_ELIGIBILITY[s.slot];
    if (!accept) continue;
    for (const [id, b] of projOf) {
      if (startedIds.has(id)) continue; // only benched players
      if (accept.has(b.pos) && b.proj > s.proj + 0.01) {
        missedSwaps.push(`${b.name}(${b.proj}) should beat ${s.name}(${s.proj}) at ${s.slot}`);
      }
    }
  }
  t(`${tag}: no better bench player was left out (local-swap optimal)`, missedSwaps.length === 0, missedSwaps.slice(0, 3).join(" | "));

  // 4. The solver should be at least as good as the human's real lineup on the
  //    frozen actuals of these weeks. This is a deterministic fact about the
  //    committed data (it holds on every fixture), so it is a strong regression
  //    guard: a change that makes the solver lose to the human it beat is a bug.
  //    If a genuinely unlucky week is ever added where a correct solver still
  //    trails the human, relax THIS assertion for that week, not the ones above.
  if (r.humanActualTotal != null) {
    t(
      `${tag}: solver at least matches the human's actual lineup`,
      r.solverActualTotal >= r.humanActualTotal - 0.01,
      `solver ${r.solverActualTotal} < human ${r.humanActualTotal}`,
    );
  }
}

// Report card. Points left on bench is expected to be positive (projections are
// not hindsight); this prints it so a regression that inflates it is visible.
console.log("\n  replay report:");
console.log(`  ${"week".padEnd(10)} ${"solver".padStart(8)} ${"perfect".padStart(8)} ${"bench".padStart(7)} ${"human".padStart(8)}`);
for (const r of results) {
  // A started player who scored ~0 is a projection miss (active at lock, then
  // hurt / benched in-game), not a solver bug. Surface it, do not fail on it.
  const miss = r.startedNonPlayer ? `  (proj miss: started ${r.startedNonPlayer.name}, ~0 actual)` : "";
  console.log(
    `  ${`${r.season} w${r.week}`.padEnd(10)} ${r.solverActualTotal.toFixed(2).padStart(8)} ${r.perfectActualTotal.toFixed(2).padStart(8)} ` +
    `${r.pointsLeftOnBench.toFixed(2).padStart(7)} ${(r.humanActualTotal ?? 0).toFixed(2).padStart(8)}${miss}`,
  );
}
if (results.length) {
  const avgBench = results.reduce((s, r) => s + r.pointsLeftOnBench, 0) / results.length;
  const beatOrTiedHuman = results.filter((r) => r.humanActualTotal != null && r.solverActualTotal >= r.humanActualTotal - 0.01).length;
  const withHuman = results.filter((r) => r.humanActualTotal != null).length;
  console.log(`\n  avg points left on bench: ${avgBench.toFixed(2)}`);
  console.log(`  solver matched-or-beat the human in ${beatOrTiedHuman}/${withHuman} weeks`);
  // A sanity ceiling: if the solver is ever leaving an average of 40+ points a
  // week on the bench, something upstream is badly wrong, not just imperfect.
  t("average points left on bench is within a sane ceiling", avgBench < 40, avgBench.toFixed(2));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
