#!/usr/bin/env bun
// Build a committed replay fixture from a REAL, completed past week.
//
//   bun run scripts/build-replay-fixture.ts <leagueId> <rosterId> <week> [week...]
//
// Reads (read-only, public API): the league (for scoring + slots), the week's
// matchup for the given roster (the roster AS IT WAS that week, plus each
// player's ACTUAL points scored under the league's real rules and the lineup the
// human actually started), and that week's projections (what the solver would
// have seen at lock). Writes src/analysis/fixtures/<season>-w<week>.json.
//
// This is NOT run by the test. The test reads the committed fixtures offline.
// Regenerate only when you want fresh or additional weeks; then commit the JSON.
//
// The default target is the 2025 previous-season league (1267682977899364352,
// Filip = roster_id 3), the only completed season with real per-week scores.

import { sleeper } from "../src/sleeper/client.ts";
import { normaliseWeek } from "../src/analysis/week-projections.ts";
import { startingSlots } from "../src/analysis/lineup.ts";
import { loadPlayers } from "../src/data/players.ts";
import type { FixturePlayer, WeekFixture } from "../src/analysis/replay.ts";

interface Matchup {
  roster_id: number;
  starters: string[] | null;
  players: string[] | null;
  players_points: Record<string, number> | null;
}

const [leagueId, rosterIdArg, ...weekArgs] = process.argv.slice(2);
if (!leagueId || !rosterIdArg || weekArgs.length === 0) {
  console.error("usage: bun run scripts/build-replay-fixture.ts <leagueId> <rosterId> <week> [week...]");
  process.exit(1);
}
const rosterId = Number(rosterIdArg);

const league = await sleeper.league(leagueId);
const scoring = league.scoring_settings;
const slots = startingSlots(league.roster_positions);
const players = await loadPlayers();
const FIX_DIR = new URL("../src/analysis/fixtures/", import.meta.url).pathname;

function positionOf(playerId: string): string {
  const p = players[playerId];
  if (p?.position) return p.position;
  if (p?.fantasy_positions?.[0]) return p.fantasy_positions[0];
  // Team defences are keyed by the team abbreviation and have no dump entry.
  if (/^[A-Z]{2,4}$/.test(playerId)) return "DEF";
  return "?";
}
function nameOf(playerId: string): string {
  const p = players[playerId];
  if (p?.full_name) return p.full_name;
  if (p?.first_name || p?.last_name) return `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
  if (/^[A-Z]{2,4}$/.test(playerId)) return `${playerId} DEF`;
  return playerId;
}

for (const w of weekArgs) {
  const week = Number(w);
  const [matchups, rawProj] = await Promise.all([
    sleeper.matchups(leagueId, week) as Promise<Matchup[]>,
    sleeper.weeklyProjections(league.season, week),
  ]);
  const mine = matchups.find((m) => m.roster_id === rosterId);
  if (!mine || !mine.players) {
    console.error(`  week ${week}: no matchup for roster ${rosterId}; skipping`);
    continue;
  }
  const proj = new Map(normaliseWeek(rawProj, week, scoring).map((p) => [p.playerId, p]));
  const points = mine.players_points ?? {};

  const fxPlayers: FixturePlayer[] = mine.players.map((id) => {
    const pr = proj.get(id);
    return {
      playerId: id,
      name: nameOf(id),
      position: positionOf(id),
      // No projection row for the week => no projected game (bye / not playing)
      // => the solver would see 0 and never start him. That is the honest input.
      projPoints: pr?.points ?? 0,
      actualPoints: Math.round((points[id] ?? 0) * 100) / 100,
      injuryStatus: pr?.injuryStatus ?? null,
    };
  });

  const fixture: WeekFixture = {
    season: league.season,
    week,
    leagueId,
    rosterId,
    slots,
    players: fxPlayers,
    actualStarters: mine.starters ?? undefined,
  };

  const out = `${FIX_DIR}${league.season}-w${week}.json`;
  await Bun.write(out, JSON.stringify(fixture, null, 2) + "\n");
  const played = fxPlayers.filter((p) => p.actualPoints > 0).length;
  console.log(`  wrote ${out}: ${fxPlayers.length} players, ${played} scored, ${slots.length} slots`);
}
