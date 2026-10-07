#!/usr/bin/env bun
// Capture the league as it stands into a replay fixture for the incident
// tests (src/analysis/incidents/league.ts): every roster with its injured
// reserve and matchup-leg starters, every rostered player's rest-of-season
// value with live status, the twelve best unrostered players at each
// position, week-by-week projections from this week on, and our pending
// waiver claims. Read-only. Run inside the container:
//
//   docker exec -i <c> sh -c 'cd /app && bun run -' < scripts/capture-league-fixture.ts > src/analysis/incidents/league-<date>.json
//
// Writes the JSON to stdout; the log goes to stderr.

import { config } from "../src/config.ts";
import { sleeper } from "../src/sleeper/client.ts";
import { leagueRosters } from "../src/sleeper/graphql.ts";
import { loadValues, liveStatusFromRosters } from "../src/analysis/value.ts";
import { loadWeekProjections } from "../src/analysis/week-projections.ts";
import { tokenGql, currentStarters } from "../src/league/api.ts";
import { pendingClaimPlayers } from "../src/act/pending-claims.ts";
import { byeWeek } from "../src/data/byes.ts";
import { LAST_WEEK } from "../src/analysis/value.ts";

const state = await sleeper.nflState();
const week = state.week || 1;
const season = state.season || config.season;
const league = await sleeper.league(config.leagueId);
const rosters = await leagueRosters(config.leagueId);
const values = await loadValues(season, week, league.scoring_settings, liveStatusFromRosters(rosters));
const weekly = new Map<string, Record<string, number>>();
for (let w = week; w <= LAST_WEEK; w++) {
  const table = await loadWeekProjections(season, w, league.scoring_settings);
  for (const p of table) {
    if (!weekly.has(p.playerId)) weekly.set(p.playerId, {});
    weekly.get(p.playerId)![String(w)] = p.hasGame && !p.onBye ? Math.round(p.points * 10) / 10 : 0;
  }
}
const gql = tokenGql();
const pendingClaims = await pendingClaimPlayers(gql, week);
const taken = new Set<string>();
for (const r of rosters) for (const id of r.players ?? []) taken.add(id);
const keep = new Set<string>([...taken, ...pendingClaims.adds, ...pendingClaims.drops]);
for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
  const best = [...values.values()].filter((v) => v.position === pos && !taken.has(v.playerId)).sort((a, b) => b.value - a.value).slice(0, 12);
  for (const v of best) keep.add(v.playerId);
}
const players: Record<string, unknown> = {};
for (const id of keep) {
  const v = values.get(id);
  if (!v) continue;
  players[id] = {
    playerId: id, name: v.name, position: v.position, team: v.team,
    value: v.value, seasonPoints: v.seasonPoints, seasonRank: v.seasonRank,
    injuryStatus: v.injuryStatus, stash: v.stash, bye: byeWeek(v.team) ?? null,
    weekly: weekly.get(id) ?? {},
  };
}
const out = {
  capturedAt: new Date().toISOString(), week, ourRosterId: config.rosterId,
  rosterPositions: league.roster_positions,
  rosters: await Promise.all(rosters.map(async (r) => ({
    rosterId: r.roster_id, players: r.players ?? [], reserve: r.reserve ?? [],
    starters: await currentStarters(gql, week, r.starters ?? [], r.roster_id, config.leagueId).catch(() => r.starters ?? []),
  }))),
  pendingClaims,
  waiverPositions: Object.fromEntries(rosters.map((r) => [r.roster_id, (r.settings as { waiver_position?: number }).waiver_position ?? null])),
  players,
};
console.error(`captured week ${week}: ${Object.keys(players).length} players, ${out.rosters.length} rosters, pending ${JSON.stringify(out.pendingClaims)}`);
console.log(JSON.stringify(out, null, 1));
