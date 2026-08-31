#!/usr/bin/env bun
// Compute and (optionally) set the optimal starting lineup for a week. This is
// the entry point the Thursday and Sunday lock timers invoke.
//
//   bun run src/act/lineup-run.ts               # dry run: compute + print, no write
//   bun run src/act/lineup-run.ts --live        # set the lineup via the DOM-verified path
//   bun run src/act/lineup-run.ts --week 3      # a specific week (default: the current NFL week)
//   bun run src/act/lineup-run.ts --live --refresh   # force-refresh caches first (inactive checks)
//
// Dry run touches only the read-only public API and writes nothing. --live posts
// the ordered starter ids to the browser-server's /lineup, which drives the DOM
// and verifies the result by reading it back (never from the rosters API, which
// served a stale starters array for minutes on 2026-08-30). The kill switch
// (src/killswitch.ts) can freeze all writes with a single file on the volume.
//
// Lineups are pure upside and reversible until kickoff, so they automate first
// and without a shadow phase (per the in-season plan). The one expensive mistake
// - starting a player who is not playing - is prevented in the solver, which
// zeroes out anyone OUT/IR/on-bye/inactive before assigning a single slot.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { buildRosterWeek } from "../analysis/roster-week.ts";
import { solveLineup, startingSlots, starterIds } from "../analysis/lineup.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";

const BROWSER_API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function postLineup(ids: string[], leagueId: string): Promise<void> {
  const res = await fetch(`${BROWSER_API}/lineup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, leagueId }),
  });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok || j.error) throw new Error(String(j.error ?? res.statusText));
}

async function main(): Promise<void> {
  const live = flag("live");
  const refresh = flag("refresh");
  const leagueId = opt("league") ?? config.leagueId;
  // A league override MUST carry a roster override. Our roster_id is 3 in the
  // real league and 1 in the staging clone, so passing --league alone silently
  // plans for whatever team happens to hold id 3 in the target league. In
  // staging that is an orphan team, which is how this was found: a dry run
  // produced a lineup of players we do not own. Half a guard is worse than none,
  // because it reads as safe.
  const rosterOverride = opt("roster");
  if (opt("league") && !rosterOverride) {
    throw new Error(
      "--league requires --roster. Our roster_id differs per league (3 in the real " +
        "league, 1 in the staging clone), so a league override without a roster " +
        "override plans for a different team. Re-run with --roster <id>.",
    );
  }
  const rosterId = rosterOverride ? Number(rosterOverride) : config.rosterId;
  if (!Number.isFinite(rosterId) || rosterId <= 0) throw new Error(`--roster must be a positive number, got ${rosterOverride}`);

  const state = await sleeper.nflState();
  const week = Number(opt("week")) || state.week || 1;
  const season = state.season || config.season;

  const league = await sleeper.league(leagueId);
  const slots = startingSlots(league.roster_positions);

  // Membership only: which players are on our roster. This reads the rosters API
  // `players` array, which is safe - the stale-cache problem was specifically
  // the `starters` array, and the write is verified against the DOM regardless.
  const rosters = await sleeper.rosters(leagueId);
  const mine = rosters.find((r) => r.roster_id === rosterId);
  if (!mine || !mine.players?.length) {
    throw new Error(`no roster ${rosterId} in league ${leagueId}, or it is empty`);
  }

  const [players, weekProj] = await Promise.all([
    loadPlayers({ forceRefresh: refresh }),
    loadWeekProjections(season, week, league.scoring_settings, { forceRefresh: refresh }),
  ]);
  const idx = byPlayerId(weekProj);
  const candidates = buildRosterWeek(mine.players, players, idx, week);
  const lineup = solveLineup(candidates, slots);

  // Report, always.
  const froze = freezeState();
  console.log(`\nLineup for ${season} week ${week} — league ${leagueId}${leagueId === config.leagueId ? "" : " (override)"}`);
  console.log(`  mode: ${live ? "LIVE (will write)" : "dry run (no write)"}${froze.frozen ? `  [FROZEN: ${froze.reason}]` : ""}`);
  console.log(`  slots: ${slots.join(", ")}`);
  console.log("  starters:");
  for (const s of lineup.slots) {
    const p = s.player;
    console.log(`    ${s.slot.padEnd(5)} ${(p?.name ?? "(EMPTY)").padEnd(22)} ${p ? p.points.toFixed(1).padStart(6) : "     -"}`);
  }
  console.log(`  projected total: ${lineup.total.toFixed(1)}`);
  if (lineup.excluded.length) {
    console.log("  zeroed out (not playing):");
    for (const e of lineup.excluded) console.log(`    ${e.player.name} — ${e.reason}`);
  }
  if (lineup.unfilled.length) {
    console.log(`  UNFILLED SLOTS: ${lineup.unfilled.join(", ")} (not enough healthy bodies)`);
  }

  logEvent("coach", "lineup-plan", `Week ${week} lineup, ${lineup.total.toFixed(1)} projected${live ? "" : " (dry run)"}`, {
    week, leagueId, total: lineup.total,
    starters: lineup.slots.map((s) => ({ slot: s.slot, name: s.player?.name ?? null, pts: s.player?.points ?? 0 })),
    excluded: lineup.excluded.map((e) => ({ name: e.player.name, reason: e.reason })),
    unfilled: lineup.unfilled,
  });

  if (!live) {
    console.log("\n(dry run — pass --live to set this lineup)");
    return;
  }

  // A partial lineup must never be written: setLineup cannot start an empty slot,
  // and an unfilled slot in-season is a real problem for a human, not the coach.
  if (lineup.unfilled.length) {
    await sendAlert("Lineup has an unfillable slot", `Week ${week}: ${lineup.unfilled.join(", ")} could not be filled from the roster. No lineup was set.`);
    throw new Error(`refusing to set a partial lineup (unfilled: ${lineup.unfilled.join(", ")})`);
  }

  assertWritesAllowed(`set the week ${week} lineup`);
  const ids = starterIds(lineup);
  try {
    await postLineup(ids, leagueId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Read-back verification lives inside setLineup; a throw here means the write
    // did not land as intended. Change nothing further, log loudly, alert.
    logEvent("coach", "lineup-failed", `Week ${week} lineup write failed: ${msg}`, { week, leagueId, ids });
    await sendAlert("Lineup write failed", `Week ${week}, league ${leagueId}: ${msg}`);
    throw err;
  }
  console.log(`\nLINEUP SET and verified for week ${week} (league ${leagueId}).`);
  logEvent("coach", "lineup-set", `Week ${week} lineup set and verified, ${lineup.total.toFixed(1)} projected.`, { week, leagueId, ids });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`lineup-run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
