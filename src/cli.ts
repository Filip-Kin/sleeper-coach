#!/usr/bin/env bun
// Read-only command line for inspecting the league. No command here touches the
// account or has any side effect; everything is a public data read.
//
//   bun run coach league        league scoring, roster slots, keeper rules
//   bun run coach managers      the eight teams and who runs them
//   bun run coach draft         draft type, clock, rounds, order (if set)
//   bun run coach board [POS] [N]   top-N value board (optionally one position)
//   bun run coach roster [ID]   a roster's players by name (default: yours)
//   bun run coach players [--refresh]   player cache status / refresh

import { config } from "./config.ts";
import { sleeper } from "./sleeper/client.ts";
import { loadPlayers, cacheStatus } from "./data/players.ts";
import { buildBoard } from "./analysis/board.ts";
import { describeScoring } from "./analysis/scoring.ts";
import { loadSeasonProjections, projectionsCacheStatus } from "./analysis/projections.ts";
import { rankByVor } from "./analysis/vor.ts";
import type { LeagueUser, Position } from "./sleeper/types.ts";

const [command, ...args] = process.argv.slice(2);

function teamLabel(users: LeagueUser[], userId: string | null): string {
  const u = users.find((x) => x.user_id === userId);
  if (!u) return "(empty)";
  const team = u.metadata?.team_name;
  return team ? `${team} — ${u.display_name}` : u.display_name;
}

async function cmdLeague(): Promise<void> {
  const league = await sleeper.league(config.leagueId);
  console.log(`\n${league.name}`);
  console.log(`  season ${league.season} · status ${league.status} · ${league.total_rosters} teams`);
  console.log(`  scoring: ${describeScoring(league.scoring_settings).join(" · ")}`);
  console.log(`  starters: ${league.roster_positions.filter((p) => p !== "BN").join(", ")}`);
  console.log(`  bench slots: ${league.roster_positions.filter((p) => p === "BN").length}`);
  console.log(`  keepers allowed: ${league.settings.max_keepers}`);
  console.log(`  trades: ${league.settings.disable_trades ? "disabled" : "enabled"} · FAAB budget ${league.settings.waiver_budget}`);
  console.log(`  trade deadline: week ${league.settings.trade_deadline} · playoffs start week ${league.settings.playoff_week_start} (${league.settings.playoff_teams} teams)`);
}

async function cmdManagers(): Promise<void> {
  const [users, rosters] = await Promise.all([
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
  ]);
  console.log("\nManagers:");
  for (const r of rosters.sort((a, b) => a.roster_id - b.roster_id)) {
    const you = r.roster_id === config.rosterId ? "  <- you" : "";
    console.log(`  ${r.roster_id}. ${teamLabel(users, r.owner_id)}${you}`);
  }
}

async function cmdDraft(): Promise<void> {
  const [draft, users] = await Promise.all([
    sleeper.draft(config.draftId),
    sleeper.leagueUsers(config.leagueId),
  ]);
  console.log(`\nDraft ${draft.draft_id}`);
  console.log(`  type ${draft.type} · ${draft.settings.rounds} rounds · ${draft.settings.teams} teams`);
  console.log(`  pick clock: ${draft.settings.pick_timer}s · CPU autopick: ${draft.settings.cpu_autopick ? "on" : "off"}`);
  console.log(`  status: ${draft.status}` + (draft.start_time ? ` · starts ${new Date(draft.start_time).toISOString()}` : " · not scheduled"));
  if (draft.draft_order) {
    console.log("  order:");
    const bySlot = Object.entries(draft.draft_order).sort((a, b) => a[1] - b[1]);
    for (const [uid, slot] of bySlot) console.log(`    ${slot}. ${teamLabel(users, uid)}`);
  } else {
    console.log("  order: not set yet");
  }
}

async function cmdBoard(): Promise<void> {
  const posArg = args[0]?.toUpperCase();
  const validPos = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
  const position = posArg && validPos.has(posArg) ? (posArg as Position) : undefined;
  const limit = Number(position ? args[1] : args[0]) || 30;

  const league = await sleeper.league(config.leagueId);
  const projections = await loadSeasonProjections(config.season, league.scoring_settings);

  if (projections.length === 0) {
    // Fall back to the search_rank ordering if projections are unavailable.
    const players = await loadPlayers();
    const board = buildBoard(players, { position, limit });
    console.log(`\nValue board${position ? ` — ${position}` : ""} (fallback, Sleeper rank — no projections):`);
    board.forEach((e, i) => console.log(`  ${String(i + 1).padStart(3)}. ${e.name.padEnd(24)} ${e.position.padEnd(3)} ${e.team}`));
    return;
  }

  const ranked = rankByVor(projections, league);
  const rows = (position ? ranked.filter((r) => r.position === position) : ranked).slice(0, limit);
  console.log(`\nValue board${position ? ` — ${position}` : ""} (top ${rows.length}, by VOR under your scoring):`);
  console.log(`  ${"#".padStart(3)}  ${"player".padEnd(24)} ${"pos".padEnd(4)} ${"tm".padEnd(4)} ${"pts".padStart(6)} ${"vor".padStart(6)} ${"adp".padStart(6)} tier`);
  rows.forEach((e, i) => {
    const inj = e.injuryStatus ? ` [${e.injuryStatus}]` : "";
    const adp = e.adp >= 999 ? "-" : e.adp.toFixed(1);
    console.log(
      `  ${String(i + 1).padStart(3)}. ${e.name.padEnd(24)} ${(`${e.position}${e.posRank}`).padEnd(4)} ${e.team.padEnd(4)} ${e.points.toFixed(1).padStart(6)} ${e.vor.toFixed(1).padStart(6)} ${adp.padStart(6)}  T${e.tier}${inj}`,
    );
  });
}

async function cmdAvailable(): Promise<void> {
  // A draft id is a long number; a bare small number is the row limit.
  const draftId = args.find((a) => /^\d{12,}$/.test(a)) ?? config.draftId;
  const posArg = args.find((a) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(a.toUpperCase()))?.toUpperCase();
  const limit = Number(args.find((a) => /^\d{1,3}$/.test(a))) || 25;

  const [league, picks] = await Promise.all([sleeper.league(config.leagueId), sleeper.draftPicks(draftId)]);
  const drafted = new Set(picks.map((p) => p.player_id));
  const projections = await loadSeasonProjections(config.season, league.scoring_settings);
  const ranked = rankByVor(projections, league).filter((r) => !drafted.has(r.playerId));
  const rows = (posArg ? ranked.filter((r) => r.position === posArg) : ranked).slice(0, limit);

  console.log(`\nBest available${posArg ? ` — ${posArg}` : ""} (${drafted.size} drafted, top ${rows.length} by VOR):`);
  rows.forEach((e, i) => {
    const inj = e.injuryStatus ? ` [${e.injuryStatus}]` : "";
    console.log(`  ${String(i + 1).padStart(3)}. ${e.name.padEnd(24)} ${(`${e.position}${e.posRank}`).padEnd(5)} ${e.team.padEnd(4)} pts ${e.points.toFixed(0).padStart(4)} vor ${e.vor.toFixed(0).padStart(4)} adp ${e.adp >= 999 ? "-" : e.adp.toFixed(0)}  T${e.tier}${inj}`);
  });
}

async function cmdRoster(): Promise<void> {
  const rosterId = Number(args[0]) || config.rosterId;
  const [rosters, players] = await Promise.all([
    sleeper.rosters(config.leagueId),
    loadPlayers(),
  ]);
  const r = rosters.find((x) => x.roster_id === rosterId);
  if (!r) return void console.log(`No roster ${rosterId}`);
  console.log(`\nRoster ${rosterId} — ${(r.players ?? []).length} players, keepers: ${r.keepers?.length ?? 0}`);
  for (const pid of r.players ?? []) {
    const p = players[pid];
    const name = p ? (p.full_name ?? `${p.first_name} ${p.last_name}`) : pid;
    console.log(`  ${name} (${p?.position ?? "?"} ${p?.team ?? "?"})`);
  }
  if (!(r.players ?? []).length) console.log("  (empty — pre-draft, keepers not designated yet)");
}

async function cmdPlayers(): Promise<void> {
  const refresh = args.includes("--refresh");
  const players = await loadPlayers({ forceRefresh: refresh });
  const meta = await cacheStatus();
  console.log(`\nPlayer cache: ${Object.keys(players).length} players`);
  if (meta) console.log(`  fetched ${new Date(meta.fetchedAt).toISOString()}`);

  if (refresh) {
    const league = await sleeper.league(config.leagueId);
    await loadSeasonProjections(config.season, league.scoring_settings, { forceRefresh: true });
  }
  const projMeta = await projectionsCacheStatus(config.season);
  if (projMeta) console.log(`Projections cache (${config.season}): ${projMeta.count} players, fetched ${new Date(projMeta.fetchedAt).toISOString()}`);
}

const commands: Record<string, () => Promise<void>> = {
  league: cmdLeague,
  managers: cmdManagers,
  draft: cmdDraft,
  board: cmdBoard,
  available: cmdAvailable,
  roster: cmdRoster,
  players: cmdPlayers,
};

const run = command ? commands[command] : undefined;
if (!run) {
  console.log("commands: league | managers | draft | board [POS] [N] | roster [ID] | players [--refresh]");
  process.exit(command ? 1 : 0);
}
await run();
