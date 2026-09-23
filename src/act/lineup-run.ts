#!/usr/bin/env bun
// Compute and (optionally) set the optimal starting lineup for a week. This is
// the entry point the Thursday and Sunday lock timers invoke.
//
//   bun run src/act/lineup-run.ts               # dry run: compute + print, no write
//   bun run src/act/lineup-run.ts --live        # set the lineup and verify it by reading it back
//   bun run src/act/lineup-run.ts --week 3      # a specific week (default: the current NFL week)
//   bun run src/act/lineup-run.ts --live --refresh   # force-refresh caches first (inactive checks)
//
// Dry run touches only the read-only public API and writes nothing. --live sends
// the ordered starter ids with roster_update_starters over GraphQL and verifies
// the result by reading it back through the uncached GraphQL league_rosters
// (never the REST rosters API, which served a stale starters array for minutes
// on 2026-08-30). The kill switch (src/killswitch.ts) can freeze all writes
// with a single file on the volume.
//
// Lineups are pure upside and reversible until kickoff, so they automate first
// and without a shadow phase (per the in-season plan). The one expensive mistake
// - starting a player who is not playing - is prevented in the solver, which
// zeroes out anyone OUT/IR/on-bye/inactive before assigning a single slot.

import { config } from "../config.ts";
import { buildRosterView } from "../analysis/roster-view.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { buildRosterWeek } from "../analysis/roster-week.ts";
import { startingSlots, availabilityOf } from "../analysis/lineup.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import { tokenGql, updateStarters } from "../league/api.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import { overlayRosterStatus, lockedPlayerIds, cachedTeamKickoffs, planLineup } from "./lineup-guard.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The write. GraphQL roster_update_starters (one request, ~60 ms), verified by
// an uncached league_rosters read-back. Verified live 2026-09-09: the mutation
// echoed the array and the read-back matched. The DOM fallback that used to sit
// behind this went with the browser; a failed write now alerts and exits
// non-zero, and the daemon's lineup guard retries on its own schedule.
async function writeStarters(ids: string[], leagueId: string, rosterId: number): Promise<void> {
  await updateStarters(tokenGql(), ids, rosterId, leagueId);
  const back = (await leagueRosters(leagueId)).find((r) => r.roster_id === rosterId)?.starters ?? [];
  if (back.join(",") !== ids.join(",")) throw new Error(`read-back mismatch: site has ${back.join(",")}`);
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
  // the `starters` array, and the write is verified by a GraphQL read-back regardless.
  const rosters = await leagueRosters(leagueId);
  const mine = rosters.find((r) => r.roster_id === rosterId);
  if (!mine || !mine.players?.length) {
    throw new Error(`no roster ${rosterId} in league ${leagueId}, or it is empty`);
  }

  // --refresh used to force the 14 MB player dump for fresh injury statuses.
  // The rosters read above is GraphQL now and carries player_map, a live
  // injury_status per rostered player, so the dump is only names and
  // positions and the cached copy is fine. Projections are still refreshed.
  const [dump, weekProj] = await Promise.all([
    loadPlayers(),
    loadWeekProjections(season, week, league.scoring_settings, { forceRefresh: refresh }),
  ]);
  const players = overlayRosterStatus(dump, mine);
  const idx = byPlayerId(weekProj);
  // IR players are not startable, so they are not candidates. See lineup-guard.
  // Startable players come from the view's ACTIVE set; the solver applies its
  // own availability rules on top. IR is excluded structurally, not by a filter.
  const candidates = buildRosterWeek([...buildRosterView(mine).activeIds], players, idx, week);

  // Players whose game has already kicked off are PINNED where they are.
  // Without this the scheduled locks solve as though the whole roster were
  // still movable: a Thursday player who banked 20 points and picked up an
  // injury designation on Friday would be "benched" by the 11:00 Sunday lock,
  // either throwing his score away or having Sleeper reject the whole write and
  // leave the rest of the lineup unset. The 90-second guard has always pinned
  // them; the locks did not, which was the last asymmetry between the two
  // writers. planLineup also refuses to empty a slot the site has filled.
  const locked = lockedPlayerIds(candidates, await cachedTeamKickoffs(), Date.now());
  const plan = planLineup(mine.starters ?? [], candidates, slots, locked);
  const byId = new Map(candidates.map((p) => [p.playerId, p]));
  const chosen = plan.ids.map((id) => byId.get(id) ?? null);
  const total = chosen.reduce((sum, p) => sum + (p?.points ?? 0), 0);
  const excluded = candidates
    .filter((p) => !plan.ids.includes(p.playerId))
    .map((p) => ({ player: p, reason: availabilityOf(p).reason }))
    .filter((e) => e.reason !== "");

  // Report, always.
  const froze = freezeState();
  console.log(`\nLineup for ${season} week ${week} — league ${leagueId}${leagueId === config.leagueId ? "" : " (override)"}`);
  console.log(`  mode: ${live ? "LIVE (will write)" : "dry run (no write)"}${froze.frozen ? `  [FROZEN: ${froze.reason}]` : ""}`);
  console.log(`  slots: ${slots.join(", ")}`);
  console.log("  starters:");
  chosen.forEach((p, i) => {
    const pin = p && locked.has(p.playerId) ? "  (locked, game started)" : "";
    console.log(`    ${slots[i]?.padEnd(5)} ${(p?.name ?? "(EMPTY)").padEnd(22)} ${p ? p.points.toFixed(1).padStart(6) : "     -"}${pin}`);
  });
  console.log(`  projected total: ${total.toFixed(1)}`);
  if (excluded.length) {
    console.log("  zeroed out (not playing):");
    for (const e of excluded) console.log(`    ${e.player.name}: ${e.reason}`);
  }
  if (plan.unfilled.length) {
    console.log(`  UNFILLED SLOTS: ${plan.unfilled.join(", ")} (not enough healthy bodies)`);
  }
  if (!plan.changed) console.log("  already set on the site; nothing to write.");

  logEvent("coach", "lineup-plan", `Week ${week} lineup, ${total.toFixed(1)} projected${live ? "" : " (dry run)"}`, {
    week, leagueId, total,
    starters: chosen.map((p, i) => ({ slot: slots[i] ?? "", name: p?.name ?? null, pts: p?.points ?? 0, locked: p ? locked.has(p.playerId) : false })),
    excluded: excluded.map((e) => ({ name: e.player.name, reason: e.reason })),
    unfilled: plan.unfilled,
    changed: plan.changed,
  });

  if (!live) {
    console.log("\n(dry run — pass --live to set this lineup)");
    return;
  }

  // A partial lineup must never be written: an empty slot in-season is a real
  // problem for a human, not the coach.
  if (plan.unfilled.length) {
    await sendAlert("Lineup has an unfillable slot", `Week ${week}: ${plan.unfilled.join(", ")} could not be filled from the roster. No lineup was set.`);
    throw new Error(`refusing to set a partial lineup (unfilled: ${plan.unfilled.join(", ")})`);
  }

  // Nothing to do beats a pointless mutation on a live roster.
  if (!plan.changed) {
    console.log(`\nWeek ${week} lineup already correct; no write.`);
    logEvent("coach", "lineup-unchanged", `Week ${week} lineup already correct, no write.`, { week, leagueId });
    return;
  }

  assertWritesAllowed(`set the week ${week} lineup`);
  const ids = plan.ids;
  try {
    await writeStarters(ids, leagueId, rosterId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A throw here means the write did not take as intended (or the read-back
    // disagreed). Change nothing further, log loudly, alert.
    logEvent("coach", "lineup-failed", `Week ${week} lineup write failed: ${msg}`, { week, leagueId, ids });
    await sendAlert("Lineup write failed", `Week ${week}, league ${leagueId}: ${msg}`);
    throw err;
  }
  const moved = plan.swaps.map((sw) => `${sw.slot}: ${sw.out} -> ${sw.in} (${sw.why})`).join("; ");
  console.log(`\nLINEUP SET and verified for week ${week} (league ${leagueId}).${moved ? ` Changes: ${moved}` : ""}`);
  logEvent("coach", "lineup-set", `Week ${week} lineup set and verified, ${total.toFixed(1)} projected.`, { week, leagueId, ids, swaps: plan.swaps });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`lineup-run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
