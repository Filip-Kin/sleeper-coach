#!/usr/bin/env bun
// Compute the week's waiver and free-agent moves and, with --live, make them.
//
//   bun run src/act/waiver-run.ts            SHADOW: decide and print, write nothing
//   bun run src/act/waiver-run.ts --live     make the moves
//
// Two facts shape this:
//
//  1. Rolling waiver PRIORITY, not FAAB. A successful claim sends us to the back
//     of the queue, so it is a real cost and at most ONE claim is ever submitted
//     per cycle: the single best one. Costless free-agent adds are preferred
//     wherever the player is not on waivers, because they cost nothing at all.
//  2. Every write goes through GraphQL (submit_waiver_claim,
//     league_create_transaction), not the browser. Claims used to be shadowed
//     unconditionally because the claim flow existed only as unverified
//     trades-page DOM work, which meant the coach could work out the right claim
//     and then not make it. That gap is closed.
//
// One transaction per pass, so a failure cannot leave a half-applied roster.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { browserGql, addFreeAgent, submitWaiverClaim, pendingRosterDelta, applyRosterDelta } from "../league/api.ts";
import { loadRestOfSeason } from "../analysis/ros-projections.ts";
import { startingSlots } from "../analysis/lineup.ts";
import {
  planWaivers, bestClaim, upcomingByeCrunch, crowdedByeWeeks, irOpportunities,
  DEFAULT_WAIVERS, type AvailablePlayer, type RosterState,
} from "../analysis/waivers.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { byeWeek } from "../data/byes.ts";
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
  // Claims and free adds are split because their FAIRNESS differs. A claim is
  // batch-processed at the league's clear time in priority order, so WHEN we
  // submit it changes nothing for anybody. A free-agent add is first come first
  // served and instant, which is the one place a bot is genuinely unfair to the
  // humans, so it runs on its own randomised schedule. See the free-agent job in
  // src/schedule.ts and Filip's condition recorded there.
  const doClaims = !flag("adds-only");
  const doAdds = !flag("claims-only");
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

  const [league, rosters, players] = await Promise.all([
    sleeper.league(leagueId),
    sleeper.rosters(leagueId),
    loadPlayers(),
  ]);
  const slots = startingSlots(league.roster_positions);
  const mine = rosters.find((r) => r.roster_id === rosterId);
  if (!mine || !mine.players?.length) throw new Error(`no roster ${rosterId} in league ${leagueId}`);

  // Reflect trades we have already agreed to but that are still processing, so
  // we do not, say, claim a tight end off waivers while a traded-for tight end
  // sits in commish review. Failure here degrades to the current roster, never
  // blocks the run.
  const delta = await pendingRosterDelta(browserGql(), week).catch(() => ({ incoming: [], outgoing: [] }));
  const myPlayerIds = applyRosterDelta(mine.players, delta);
  if (delta.incoming.length || delta.outgoing.length) {
    console.log(`  in-flight trade: +${delta.incoming.length} incoming, -${delta.outgoing.length} outgoing already reflected in the roster`);
  }

  // Rest-of-season is the right currency for a keep/drop decision (a weekly
  // number makes a hurt starter look worthless).
  const ros = await loadRestOfSeason(season, week, league.scoring_settings);

  // Our roster as RailPlayers, on ROS points, carrying the stash flag the rails
  // depend on.
  const roster: RailPlayer[] = myPlayerIds.map((id) => {
    const r = ros.get(id);
    const dump = players[id];
    const name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : r?.name ?? id);
    const position = dump?.position ?? r?.position ?? (/^[A-Z]{2,4}$/.test(id) ? "DEF" : "?");
    // team drives the bye lookup; a DEF's team abbreviation IS its id.
    const team = dump?.team ?? r?.team ?? (/^[A-Z]{2,4}$/.test(id) ? id : undefined);
    return {
      name,
      position,
      points: r?.points ?? 0,
      injuryStatus: dump?.injury_status ?? r?.injuryStatus ?? undefined,
      returnsBeforePlayoffs: r?.returnsBeforePlayoffs ?? false,
      bye: byeWeek(team) ?? undefined, // for the upcoming-bye lookahead and tie-break
    };
  });

  // Available = fantasy players on no roster in the league. Rank by ROS, take the
  // top slice.
  // The global "taken" set is NOT adjusted by our pending trade: a player we are
  // trading away is still rostered by the team receiving him, and one we are
  // acquiring is still rostered (by them) until it processes. A trade frees
  // nobody to waivers. Only OUR roster view (above) reflects the delta.
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

  // Name -> player_id, for both the available pool and our own roster. The
  // analysis reasons in names, but every write needs an id: the GraphQL roster
  // mutations take player ids, not display names.
  const idByName = new Map<string, string>();
  for (const p of ros.values()) if (p.name) idByName.set(p.name, p.playerId);

  const available: AvailablePlayer[] = availableRos.map((p) => ({
    name: p.name,
    position: p.position,
    points: p.points,
    injuryStatus: p.injuryStatus ?? undefined,
    returnsBeforePlayoffs: p.returnsBeforePlayoffs,
    onWaivers: recentlyDropped.has(p.playerId),
    bye: byeWeek(p.team) ?? undefined, // so a candidate on a crowded bye is debited
  }));

  // Roster capacity, from membership/reserve counts (not the stale starters array).
  const benchCap = league.roster_positions.filter((s) => s === "BN").length;
  // IR (reserve) capacity lives in settings.reserve_slots, NOT roster_positions.
  // Our league has reserve_slots: 2 and zero "IR" entries in roster_positions
  // (verified against the live API on 2026-08-31), so the old
  // roster_positions.filter(IR) read 0 and the IR-stash path never fired. Fall
  // back to the roster_positions count for any league that does list IR there.
  const irCap = league.settings.reserve_slots ?? league.roster_positions.filter((s) => s === "IR").length;
  const onReserve = mine.reserve?.length ?? 0;
  // IR-eligibility is league-configured via the reserve_allow_* flags; IR itself
  // is always eligible. Build the actual eligible set rather than assuming one.
  const irAllow = new Set<string>(["IR"]);
  const s = league.settings;
  if (s.reserve_allow_out) irAllow.add("OUT");
  if (s.reserve_allow_doubtful) irAllow.add("DOUBTFUL");
  if (s.reserve_allow_sus) irAllow.add("SUS");
  if (s.reserve_allow_cov) irAllow.add("COV");
  if (s.reserve_allow_na) irAllow.add("NA");
  if (s.reserve_allow_dnr) irAllow.add("DNR");
  irAllow.add("PUP"); // Sleeper treats PUP as reserve-eligible independently of the flags
  const irEligible = (status?: string | null): boolean => irAllow.has((status ?? "").trim().toUpperCase());
  const openIrSlots = Math.max(0, irCap - onReserve);
  const activePlayers = mine.players.length - onReserve;
  const rosterState: RosterState = {
    roster,
    openBenchSlots: Math.max(0, slots.length + benchCap - activePlayers),
    openIrSlots,
    startingSlots: slots,
    irEligible,
  };

  // Look ahead for a crowded STARTER bye we still have time to relieve (the
  // week-8 hole is a week-7 job), and feed the crowded weeks into the move
  // ranking so a relieving add edges ahead of an equal one that ignores it.
  const byeCrunch = upcomingByeCrunch(roster, slots, week, DEFAULT_WAIVERS);
  const crowdedByes = crowdedByeWeeks(byeCrunch);
  const irOpps = irOpportunities(roster, openIrSlots, irEligible);

  const moves = planWaivers(available, rosterState, DEFAULT_WAIVERS, crowdedByes);
  const claim = bestClaim(moves);
  const freeAdds = moves.filter((m) => m.kind === "free-add");
  const froze = freezeState();

  // Report.
  console.log(`\nWaivers for ${season} week ${week} — league ${leagueId}${leagueId === config.leagueId ? "" : " (override)"}`);
  console.log(`  mode: ${live ? `LIVE (${[doAdds ? "free adds" : null, doClaims ? "one waiver claim" : null].filter(Boolean).join(" + ")})` : "SHADOW (no write)"}${froze.frozen ? `  [FROZEN: ${froze.reason}]` : ""}`);
  console.log(`  open slots: bench ${rosterState.openBenchSlots}, IR ${rosterState.openIrSlots}`);
  if (!moves.length) console.log("  no rails-legal upgrades available this week.");
  for (const m of moves.slice(0, 12)) {
    const drop = m.drop ? ` / drop ${m.drop}` : "";
    const bye = m.byeCredit ? ` {bye ${m.byeCredit > 0 ? "+" : ""}${m.byeCredit}}` : "";
    console.log(`  [${m.kind}] ${m.add} (${m.position}, +${m.gainPts} ROS)${drop}${bye} — ${m.reason}`);
  }
  console.log(`  single best claim: ${claim ? `${claim.add} (+${claim.gainPts} ROS)` : "none worth a priority burn"}`);

  // Say what it is WATCHING, not only what it did. Filip had to ask repeatedly on
  // draft night what the engine was about to do; a run that declines to act must
  // still show the standing objectives are alive, not silently forgotten.
  console.log("\n  watching:");
  if (byeCrunch.length) {
    for (const b of byeCrunch) {
      console.log(`    week ${b.week} bye: ${b.count} of our starters off (${b.names.join(", ")}) — relieving it is an objective for this week's adds`);
    }
    // The best available body that would PLAY through the nearest crowded bye.
    const nearest = byeCrunch[0]!.week;
    const relief = available
      .filter((p) => p.bye !== nearest)
      .sort((a, b) => b.points - a.points)[0];
    console.log(`    best week-${nearest} relief candidate available: ${relief ? `${relief.name} (${relief.position}, ${relief.points} ROS)` : `none in the top ${MAX_CANDIDATES}`}`);
  } else {
    console.log(`    no crowded starter bye in the next ${DEFAULT_WAIVERS.byeLookaheadWeeks} weeks.`);
  }
  if (irOpps.length) {
    for (const o of irOpps) console.log(`    IR opportunity: ${o.reason}`);
  } else if (openIrSlots > 0) {
    console.log(`    ${openIrSlots} IR slot(s) free, but no rostered player is IR-eligible right now.`);
  } else {
    console.log("    no free IR slots.");
  }
  const topCandidate = available[0];
  console.log(`    best available overall: ${topCandidate ? `${topCandidate.name} (${topCandidate.position}, ${topCandidate.points} ROS)` : "none"}`);

  logEvent("coach", live ? "waiver-run" : "waiver-shadow", `Week ${week} waivers: ${freeAdds.length} free adds, ${claim ? "1 claim" : "no claim"}${live ? "" : " (shadow)"}${byeCrunch.length ? `; watching week ${byeCrunch.map((b) => b.week).join("/")} bye` : ""}${irOpps.length ? `; ${irOpps.length} IR opportunity` : ""}`, {
    week, leagueId, shadow: !live,
    freeAdds: freeAdds.map((m) => ({ add: m.add, drop: m.drop, gain: m.gainPts })),
    claim: claim ? { add: claim.add, drop: claim.drop, gain: claim.gainPts } : null,
    byeCrunch: byeCrunch.map((b) => ({ week: b.week, starters: b.count, names: b.names })),
    irOpportunities: irOpps.map((o) => ({ name: o.name, status: o.injuryStatus, isStash: o.isStash })),
  });

  // Surface a live IR opportunity: it is a costless roster expansion and the one
  // move that can genuinely help a crowded bye, but the IR-move DOM flow is not
  // built or staging-verified yet, so it is alerted for manual action rather than
  // issued blind (the same discipline as waiver claims and trades).
  if (irOpps.length) {
    await sendAlert(
      "IR opportunity",
      `Week ${week}: ${irOpps.map((o) => `${o.name} (${o.injuryStatus ?? "injured"})`).join(", ")} can move to IR, freeing an active slot for a costless add. Do it in Sleeper.`,
    ).catch(() => {});
  }

  // A claim is never auto-submitted (unverified write path). Surface it.
  if (claim) {
    await sendAlert(
      "Waiver claim recommended",
      `Week ${week}: claim ${claim.add} (+${claim.gainPts} ROS)${claim.drop ? `, drop ${claim.drop}` : ""}. ${claim.reason}. Submit it in Sleeper before Wednesday 07:00 GMT.`,
    ).catch(() => {});
  }

  if (!live) {
    console.log("\n(shadow — pass --live to perform the free-agent adds and submit the single best claim)");
    return;
  }

  // --live: perform the moves for real.
  //
  // Claims used to be shadowed here no matter what, because the claim flow had
  // only ever existed as unverified trades-page DOM work, so the coach could
  // work out the right claim and then not make it. submit_waiver_claim is a
  // plain GraphQL mutation, so that gap is closed and a claim is submitted like
  // any other move. Still at most ONE per cycle: this league runs rolling
  // priority, not FAAB, so a successful claim costs our place in the queue.
  assertWritesAllowed(`perform week ${week} waiver moves`);
  const gql = browserGql();
  const resolve = (name: string): string => {
    const id = idByName.get(name);
    if (!id) throw new Error(`no player id for "${name}"; refusing to guess on a roster write`);
    return id;
  };

  for (const m of doAdds ? freeAdds : []) {
    try {
      const res = await addFreeAgent(gql, resolve(m.add), m.drop ? resolve(m.drop) : null);
      console.log(`  added ${m.add}${m.drop ? ` (dropped ${m.drop})` : ""} [${res.status}]`);
      logEvent("coach", "waiver-add", `Added free agent ${m.add}${m.drop ? `, dropped ${m.drop}` : ""}.`, {
        week, leagueId, add: m.add, drop: m.drop, transaction_id: res.transactionId, status: res.status,
      });
      // One transaction per pass, so a batch cannot leave a half-applied roster.
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "waiver-add-failed", `Free-agent add ${m.add} failed: ${msg}`, { week, leagueId, add: m.add });
      await sendAlert("Free-agent add failed", `Week ${week}: ${m.add} — ${msg}`);
      throw err;
    }
  }

  if (claim && doClaims) {
    try {
      const res = await submitWaiverClaim(gql, resolve(claim.add), claim.drop ? resolve(claim.drop) : null);
      console.log(`  claimed ${claim.add}${claim.drop ? ` (dropping ${claim.drop})` : ""} [${res.status}]`);
      logEvent("coach", "waiver-claim", `Submitted waiver claim for ${claim.add}${claim.drop ? `, dropping ${claim.drop}` : ""} (+${claim.gainPts} ROS).`, {
        week, leagueId, add: claim.add, drop: claim.drop, gainPts: claim.gainPts,
        transaction_id: res.transactionId, status: res.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "waiver-claim-failed", `Waiver claim ${claim.add} failed: ${msg}`, { week, leagueId, add: claim.add });
      await sendAlert("Waiver claim failed", `Week ${week}: ${claim.add} — ${msg}`);
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
