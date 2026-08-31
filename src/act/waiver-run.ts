#!/usr/bin/env bun
// Compute waiver / free-agent moves for the week and, by default, SHADOW them:
// log exactly what the coach would do and change nothing. This is the Tuesday
// evening entry point (before Wednesday 07:00 GMT waivers clear).
//
//   bun run src/act/waiver-run.ts                # shadow: log proposals, no write
//   bun run src/act/waiver-run.ts --live         # perform costless free-agent ADDS only
//   bun run src/act/waiver-run.ts --week 3
//
// Per the in-season plan, waivers run in shadow for the first cycle and go live
// only after a human has reviewed a cycle. Two hard safety facts shape --live:
//
//  1. A costless free-agent ADD (a player who has already cleared waivers) uses
//     the verified addPlayer path and can be automated. Free adds are preferred
//     anyway under rolling priority.
//  2. A waiver CLAIM (an on-waivers player, processed Wednesday) is submitted
//     through a DIFFERENT, not-yet-verified DOM flow. Like trades, an unverified
//     write is never issued blind: --live SHADOWS every claim and alerts Filip to
//     submit it (or waits for the claim flow to be built and staging-verified).
//
// Rolling waiver priority, NOT FAAB: a successful claim sends us to the back of
// the queue, so at most ONE claim is ever proposed per cycle - the best one.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { loadRestOfSeason } from "../analysis/ros-projections.ts";
import { startingSlots } from "../analysis/lineup.ts";
import { planWaivers, bestClaim, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "../analysis/waivers.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";

const BROWSER_API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const MAX_CANDIDATES = 40; // consider the top-40 available by ROS; the tail is noise

function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface TransactionLike { drops?: Record<string, number> | null; }

async function main(): Promise<void> {
  const live = flag("live");
  const leagueId = opt("league") ?? config.leagueId;

  const state = await sleeper.nflState();
  const week = Number(opt("week")) || state.week || 1;
  const season = state.season || config.season;

  const [league, rosters, players] = await Promise.all([
    sleeper.league(leagueId),
    sleeper.rosters(leagueId),
    loadPlayers(),
  ]);
  const slots = startingSlots(league.roster_positions);
  const mine = rosters.find((r) => r.roster_id === config.rosterId);
  if (!mine || !mine.players?.length) throw new Error(`no roster ${config.rosterId} in league ${leagueId}`);

  // Rest-of-season is the right currency for a keep/drop decision (a weekly
  // number makes a hurt starter look worthless).
  const ros = await loadRestOfSeason(season, week, league.scoring_settings);

  // Our roster as RailPlayers, on ROS points, carrying the stash flag the rails
  // depend on.
  const roster: RailPlayer[] = mine.players.map((id) => {
    const r = ros.get(id);
    const dump = players[id];
    const name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : r?.name ?? id);
    const position = dump?.position ?? r?.position ?? (/^[A-Z]{2,4}$/.test(id) ? "DEF" : "?");
    return {
      name,
      position,
      points: r?.points ?? 0,
      injuryStatus: dump?.injury_status ?? r?.injuryStatus ?? undefined,
      returnsBeforePlayoffs: r?.returnsBeforePlayoffs ?? false,
    };
  });

  // Available = fantasy players on no roster in the league. Rank by ROS, take the
  // top slice.
  const rostered = new Set(rosters.flatMap((r) => r.players ?? []));
  const availableRos = Array.from(ros.values())
    .filter((p) => !rostered.has(p.playerId) && p.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_CANDIDATES);

  // onWaivers heuristic: a player DROPPED in the current scoring period is still
  // on waivers (a two-day hold); anyone else long-available is a free agent.
  // This is an approximation, clearly labelled, and it only ever affects whether
  // a move is called a claim or a free-add - not whether the rails permit it.
  const round = Math.max(1, week);
  const txns = (await sleeper.transactions(leagueId, round).catch(() => [])) as TransactionLike[];
  const recentlyDropped = new Set<string>();
  for (const tx of txns) for (const id of Object.keys(tx.drops ?? {})) recentlyDropped.add(id);

  const available: AvailablePlayer[] = availableRos.map((p) => ({
    name: p.name,
    position: p.position,
    points: p.points,
    injuryStatus: p.injuryStatus ?? undefined,
    returnsBeforePlayoffs: p.returnsBeforePlayoffs,
    onWaivers: recentlyDropped.has(p.playerId),
  }));

  // Roster capacity, from membership/reserve counts (not the stale starters array).
  const benchCap = league.roster_positions.filter((s) => s === "BN").length;
  const irCap = league.roster_positions.filter((s) => s === "IR").length;
  const onReserve = mine.reserve?.length ?? 0;
  const activePlayers = mine.players.length - onReserve;
  const rosterState: RosterState = {
    roster,
    openBenchSlots: Math.max(0, slots.length + benchCap - activePlayers),
    openIrSlots: Math.max(0, irCap - onReserve),
    startingSlots: slots,
  };

  const moves = planWaivers(available, rosterState, DEFAULT_WAIVERS);
  const claim = bestClaim(moves);
  const freeAdds = moves.filter((m) => m.kind === "free-add");
  const froze = freezeState();

  // Report.
  console.log(`\nWaivers for ${season} week ${week} — league ${leagueId}${leagueId === config.leagueId ? "" : " (override)"}`);
  console.log(`  mode: ${live ? "LIVE (free adds only; claims shadowed)" : "SHADOW (no write)"}${froze.frozen ? `  [FROZEN: ${froze.reason}]` : ""}`);
  console.log(`  open slots: bench ${rosterState.openBenchSlots}, IR ${rosterState.openIrSlots}`);
  if (!moves.length) console.log("  no rails-legal upgrades available this week.");
  for (const m of moves.slice(0, 12)) {
    const drop = m.drop ? ` / drop ${m.drop}` : "";
    console.log(`  [${m.kind}] ${m.add} (${m.position}, +${m.gainPts} ROS)${drop} — ${m.reason}`);
  }
  console.log(`  single best claim: ${claim ? `${claim.add} (+${claim.gainPts} ROS)` : "none worth a priority burn"}`);

  logEvent("coach", live ? "waiver-run" : "waiver-shadow", `Week ${week} waivers: ${freeAdds.length} free adds, ${claim ? "1 claim" : "no claim"}${live ? "" : " (shadow)"}`, {
    week, leagueId, shadow: !live,
    freeAdds: freeAdds.map((m) => ({ add: m.add, drop: m.drop, gain: m.gainPts })),
    claim: claim ? { add: claim.add, drop: claim.drop, gain: claim.gainPts } : null,
  });

  // A claim is never auto-submitted (unverified write path). Surface it.
  if (claim) {
    await sendAlert(
      "Waiver claim recommended",
      `Week ${week}: claim ${claim.add} (+${claim.gainPts} ROS)${claim.drop ? `, drop ${claim.drop}` : ""}. ${claim.reason}. Submit it in Sleeper before Wednesday 07:00 GMT.`,
    ).catch(() => {});
  }

  if (!live) {
    console.log("\n(shadow — pass --live to perform the costless free-agent adds; claims are always surfaced, never auto-submitted)");
    return;
  }

  // --live: perform only the costless free-agent adds (verified addPlayer path).
  assertWritesAllowed(`perform week ${week} free-agent adds`);
  for (const m of freeAdds) {
    try {
      const res = await fetch(`${BROWSER_API}/add`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: m.add, drop: m.drop ?? undefined, leagueId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || j.error) throw new Error(String(j.error ?? res.statusText));
      console.log(`  added ${m.add}${m.drop ? ` (dropped ${m.drop})` : ""}`);
      logEvent("coach", "waiver-add", `Added free agent ${m.add}${m.drop ? `, dropped ${m.drop}` : ""}.`, { week, leagueId, add: m.add, drop: m.drop });
      // One transaction per pass is the rails' rule; re-reading is done inside
      // addPlayer. Stop after the first successful add so a batch cannot leave a
      // half-applied state that is hard to reason about.
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "waiver-add-failed", `Free-agent add ${m.add} failed: ${msg}`, { week, leagueId, add: m.add });
      await sendAlert("Free-agent add failed", `Week ${week}: ${m.add} — ${msg}`);
      throw err;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`waiver-run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
