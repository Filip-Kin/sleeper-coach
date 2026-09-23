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
import { leagueRosters } from "../sleeper/graphql.ts";
import { rankByVor } from "../analysis/vor.ts";
import { buildRosterView, takenAcrossLeague } from "../analysis/roster-view.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { tokenGql, addFreeAgent, submitWaiverClaim, pendingRosterDelta, applyRosterDelta, updateReserve } from "../league/api.ts";
import { streamNeeds, pickStreamer, type StreamCandidate } from "../analysis/streaming.ts";
import { chooseForcedDrops } from "../analysis/roster-fit.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { loadRestOfSeason } from "../analysis/ros-projections.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { startingSlots } from "../analysis/lineup.ts";
import {
  planWaivers, bestClaim, upcomingByeCrunch, crowdedByeWeeks, irOpportunities, stashCandidates,
  DEFAULT_WAIVERS, type AvailablePlayer, type RosterState,
} from "../analysis/waivers.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { byeWeek } from "../data/byes.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";
import { irEligible as ruleIrEligible, legsToScan, RESERVE_LOCKED_RE } from "../sleeper/rules.ts";
import { overlayRosterStatus, cachedTeamKickoffs } from "./lineup-guard.ts";
import { pendingClaimPlayers, withoutPendingAdds, railsWithPendingDrops } from "./pending-claims.ts";
import { droppedAtFromTransactions, onWaiversNow } from "./waiver-status.ts";

const MAX_CANDIDATES = 40; // consider the top-40 available by ROS; the tail is noise

function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface TransactionLike { drops?: Record<string, number> | null; created?: number; status_updated?: number }

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
    leagueRosters(leagueId),
    loadPlayers(),
  ]);
  const slots = startingSlots(league.roster_positions);
  const mine = rosters.find((r) => r.roster_id === rosterId);
  if (!mine || !mine.players?.length) throw new Error(`no roster ${rosterId} in league ${leagueId}`);

  // Reflect trades we have already agreed to but that are still processing, so
  // we do not, say, claim a tight end off waivers while a traded-for tight end
  // sits in commish review. Failure here degrades to the current roster, never
  // blocks the run.
  const delta = await pendingRosterDelta(tokenGql(), week).catch(() => ({ incoming: [], outgoing: [] }));
  // Reserve is excluded from the ANALYSIS roster: an IR player is not startable
  // and must never appear in the drop table, because cutting him frees no
  // active slot and just loses the player. The capacity maths below subtracts
  // onReserve separately. reconcileRoster got this wrong on 2026-09-19 and cut
  // Nico Collins straight off IR.
  const view = buildRosterView(mine);
  // The analysis roster (drop table, lineup deltas) is the ACTIVE set. A man on
  // IR cannot be started and must never be a drop candidate.
  const myPlayerIds = applyRosterDelta([...view.activeIds], delta);
  if (delta.incoming.length || delta.outgoing.length) {
    console.log(`  in-flight trade: +${delta.incoming.length} incoming, -${delta.outgoing.length} outgoing already reflected in the roster`);
  }

  // Rest-of-season is the right currency for a keep/drop decision (a weekly
  // number makes a hurt starter look worthless).
  const ros = await loadRestOfSeason(season, week, league.scoring_settings);

  // Our roster as RailPlayers, on ROS points, carrying the stash flag the rails
  // depend on. Injury status is LIVE from the roster read's player_map laid
  // over the daily dump (R10): the dump is up to 24 h stale, which is how a
  // player ruled Out on Saturday was still "Questionable" to Sunday's run.
  const liveStatus = overlayRosterStatus(players, mine);
  const roster: RailPlayer[] = myPlayerIds.map((id) => {
    const r = ros.get(id);
    const dump = liveStatus[id];
    const name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : r?.name ?? id);
    const position = dump?.position ?? r?.position ?? (/^[A-Z]{2,4}$/.test(id) ? "DEF" : "?");
    // team drives the bye lookup; a DEF's team abbreviation IS its id.
    const team = dump?.team ?? r?.team ?? (/^[A-Z]{2,4}$/.test(id) ? id : undefined);
    return {
      playerId: id,
      onIr: false, // the analysis roster is the ACTIVE set; reserve was excluded above
      name,
      position,
      points: r?.points ?? 0,
      injuryStatus: dump?.injury_status ?? r?.injuryStatus ?? undefined,
      returnsBeforePlayoffs: r?.returnsBeforePlayoffs ?? false,
      bye: byeWeek(team) ?? undefined, // for the upcoming-bye lookahead and tie-break
    };
  });
  const nameOf = new Map(roster.map((p) => [p.playerId ?? "", p.name]));
  // This week's starters as the site has them. Never dropped, never stashed,
  // before their games lock (R7). The lineup guard owns who starts.
  const currentStarters = (mine.starters ?? []).map((id) => nameOf.get(id)).filter((n): n is string => !!n);

  // Players spoken for by our own pending claims (R6): the adds leave the
  // candidate pool, the drops leave the drop table.
  const pending = await pendingClaimPlayers(tokenGql(), week, rosterId, leagueId).catch(() => ({ adds: [], drops: [], slotsNeeded: 0 }));
  if (pending.adds.length || pending.drops.length) {
    console.log(`  pending claims: +${pending.adds.length} add(s) held out of the pool, ${pending.drops.length} drop(s) held off the table`);
  }
  const rails = railsWithPendingDrops(DEFAULT_WAIVERS.rails, roster, pending.drops);
  const waiverCfg = { ...DEFAULT_WAIVERS, rails };

  // Available = fantasy players on no roster in the league. Rank by ROS, take the
  // top slice.
  // The global "taken" set is NOT adjusted by our pending trade: a player we are
  // trading away is still rostered by the team receiving him, and one we are
  // acquiring is still rostered (by them) until it processes. A trade frees
  // nobody to waivers. Only OUR roster view (above) reflects the delta.
  const rostered = takenAcrossLeague(rosters); // IR included: a stashed player is not a free agent
  const unrostered = withoutPendingAdds(Array.from(ros.values()).filter((p) => !rostered.has(p.playerId) && p.points > 0), pending.adds);

  // Rank by VALUE OVER REPLACEMENT, not raw points. Raw rest-of-season points
  // always put quarterbacks on top, because a starting QB outscores a starting
  // running back in every format. On 2026-09-19 that made every one of the 40
  // planned free adds a quarterback at +0 lineup value, behind Hurts and
  // Prescott, while the costless path happily took the top of that list. VOR
  // asks the question that matters instead: how far does this player clear the
  // guy anyone could pick up at his position. A third QB clears replacement by
  // almost nothing; a startable receiver clears it by a lot.
  const vorOf = new Map<string, number>();
  for (const r of rankByVor(
    unrostered.map((p) => ({
      playerId: p.playerId, name: p.name, position: p.position, team: p.team,
      points: p.points, ptsPpr: p.points, adp: 999, injuryStatus: p.injuryStatus, stats: {},
    })),
    league,
  )) vorOf.set(r.playerId, r.vor);

  const availableRos = unrostered
    .sort((a, b) => (vorOf.get(b.playerId) ?? 0) - (vorOf.get(a.playerId) ?? 0) || b.points - a.points)
    .slice(0, MAX_CANDIDATES);

  // On waivers, PER PLAYER (R5): dropped inside waiver_clear_days, or his team
  // has kicked off since the last Wednesday run. Drops are read from this leg
  // and the last (a Tuesday drop lives under last week's leg on Wednesday).
  // This only ever decides whether a move is filed as a claim or a free add;
  // the write-time fallback below takes Sleeper's word when it disagrees.
  const txns: TransactionLike[] = [];
  for (const l of legsToScan(week)) txns.push(...((await sleeper.transactions(leagueId, l).catch(() => [])) as TransactionLike[]));
  const droppedAt = droppedAtFromTransactions(txns);
  const kickoffs = await cachedTeamKickoffs();
  const clearDays = (league.settings as { waiver_clear_days?: number }).waiver_clear_days ?? 2;
  const nowMs = Date.now();
  const isOnWaivers = (id: string, team: string | null | undefined): boolean =>
    onWaiversNow({ playerId: id, team, droppedAt, kickoffs, now: nowMs, clearDays });

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
    onWaivers: isOnWaivers(p.playerId, p.team),
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
  const onReserve = view.reserve.length;
  // IR-eligibility is the league's reserve_allow_* flags, encoded once in
  // sleeper/rules.ts. Nothing else decides it.
  const irEligible = (status?: string | null): boolean => ruleIrEligible(status, league.settings);
  const openIrSlots = Math.max(0, irCap - onReserve);
  const activePlayers = view.active.length;
  // Slots already promised to our own pending waiver claims are NOT open. A
  // claim with no drop needs a free slot on Wednesday, and a free add made on
  // Sunday morning takes it, which quietly kills the claim.
  if (pending.slotsNeeded) console.log(`  holding ${pending.slotsNeeded} slot(s) for pending waiver claim(s)`);
  const rosterState: RosterState = {
    roster,
    openBenchSlots: Math.max(0, slots.length + benchCap - activePlayers - pending.slotsNeeded),
    openIrSlots,
    startingSlots: slots,
    irEligible,
    currentStarters,
  };

  // Look ahead for a crowded STARTER bye we still have time to relieve (the
  // week-8 hole is a week-7 job), and feed the crowded weeks into the move
  // ranking so a relieving add edges ahead of an equal one that ignores it.
  const byeCrunch = upcomingByeCrunch(roster, slots, week, waiverCfg);
  const crowdedByes = crowdedByeWeeks(byeCrunch);
  const irOpps = irOpportunities(roster, openIrSlots, irEligible, currentStarters);

  const moves = planWaivers(available, rosterState, waiverCfg, crowdedByes);
  const claim = bestClaim(moves);
  const freeAdds = moves.filter((m) => m.kind === "free-add");
  const froze = freezeState();

  // STREAMING. Cover an upcoming week where a starting slot would otherwise be
  // EMPTY (our kicker or defense on bye, nobody behind them). Plan ahead: scan
  // this week and the next few, act on the earliest hole, because waivers clear
  // once a week and the week-6 kicker bye is a week-5 claim. Filip: "gets the
  // waiver on the best player in by the deadline." This is separate from the
  // upgrade logic above, which would skip a streamer since he does not beat our
  // rostered starter rest-of-season; the trigger here is an empty slot, not an
  // upgrade.
  const streamCfg = { ...DEFAULT_FAIRNESS, rails, upcomingWeeks: Array.from({ length: Math.max(1, 15 - week + 1) }, (_, i) => week + i) };
  // Streaming candidates come from the FULL unrostered pool, not `available`,
  // which is sliced to the top skill players by points and so contains no
  // kickers or defenses (they score far less), the very positions we stream.
  // Each candidate carries the NEED WEEK's projection and his bye (R4): a
  // rest-of-season number put a kicker on his own bye at the top of the list.
  const streamBase = unrostered.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team, bye: byeWeek(p.team) }));
  const needs = streamNeeds(roster, week, DEFAULT_WAIVERS.byeLookaheadWeeks ?? 3);
  let stream: { add: string; drop: string | null; position: string; forWeek: number; onWaivers: boolean; points: number; coveringFor: string[] } | null = null;
  for (const need of needs) {
    const table = byPlayerId(await loadWeekProjections(season, need.week, league.scoring_settings).catch(() => []));
    const pool: (StreamCandidate & { playerId: string; team: string })[] = streamBase.map((p) => ({ ...p, weekPoints: table.get(p.playerId)?.points ?? 0 }));
    const pick = pickStreamer(need, pool);
    if (!pick) continue;
    // A drop is only needed if we are full; never drop the player we are
    // covering for (he returns from his bye) nor a current starter, and
    // chooseForcedDrops already refuses to empty a mandatory slot or cut a stash.
    const drop = rosterState.openBenchSlots > 0
      ? null
      : chooseForcedDrops(roster, 1, streamCfg, [...need.coveringFor, ...currentStarters], rails)[0]?.name ?? null;
    if (rosterState.openBenchSlots <= 0 && !drop) continue; // no legal way to make room
    const picked = pool.find((a) => a.name === pick.add);
    const onWaivers = picked ? isOnWaivers(picked.playerId, picked.team) : true;
    stream = { add: pick.add, drop, position: need.position, forWeek: need.week, onWaivers, points: pick.points, coveringFor: need.coveringFor };
    break; // earliest actionable need only
  }

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
  console.log(`    best available overall: ${topCandidate ? `${topCandidate.name} (${topCandidate.position}, ${topCandidate.points} ROS, VOR ${Math.round(vorOf.get(idByName.get(topCandidate.name) ?? "") ?? 0)})` : "none"}`);
  if (stream) {
    console.log(`    STREAM: week ${stream.forWeek} would leave ${stream.position} empty (${stream.coveringFor.join(", ")} out); grab ${stream.add} now${stream.drop ? `, drop ${stream.drop}` : ""} [${stream.onWaivers ? "claim" : "free add"}]`);
  } else {
    console.log("    no upcoming empty starting slot to stream for.");
  }

  logEvent("coach", live ? "waiver-run" : "waiver-shadow", `Week ${week} waivers: ${freeAdds.length} free adds, ${claim ? "1 claim" : "no claim"}${live ? "" : " (shadow)"}${byeCrunch.length ? `; watching week ${byeCrunch.map((b) => b.week).join("/")} bye` : ""}${irOpps.length ? `; ${irOpps.length} IR opportunity` : ""}`, {
    week, leagueId, shadow: !live,
    freeAdds: freeAdds.map((m) => ({ add: m.add, drop: m.drop, gain: m.gainPts })),
    claim: claim ? { add: claim.add, drop: claim.drop, gain: claim.gainPts } : null,
    byeCrunch: byeCrunch.map((b) => ({ week: b.week, starters: b.count, names: b.names })),
    irOpportunities: irOpps.map((o) => ({ name: o.name, status: o.injuryStatus, isStash: o.isStash })),
    stream: stream ? { add: stream.add, drop: stream.drop, position: stream.position, forWeek: stream.forWeek, via: stream.onWaivers ? "claim" : "free-add" } : null,
  });

  // Surface a live IR opportunity: it is a costless roster expansion and the one
  // move that can genuinely help a crowded bye, but the IR-move DOM flow is not
  // built or staging-verified yet, so it is alerted for manual action rather than
  // issued blind (the same discipline as waiver claims and trades).
  // No "IR opportunity, do it in Sleeper" alert any more: the coach performs
  // the IR move itself when a slot is needed, and alerts only if Sleeper
  // refuses. The old alert also fired on every dry run, which is how a
  // read-only check spammed Filip's phone on 2026-09-20.

  if (stream) {
    if (live) await sendAlert("Streaming pickup",
      `Week ${stream.forWeek} would leave ${stream.position} empty (${stream.coveringFor.join(", ")} on bye/out). ${stream.onWaivers ? "Claim" : "Add"} ${stream.add}${stream.drop ? `, drop ${stream.drop}` : ""} before the deadline.`).catch(() => {});
  }
  // A claim is never auto-submitted (unverified write path). Surface it.
  if (claim) {
    if (live) await sendAlert(
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
  const gql = tokenGql();
  const resolve = (name: string): string => {
    const id = idByName.get(name);
    if (!id) throw new Error(`no player id for "${name}"; refusing to guess on a roster write`);
    return id;
  };

  // Streaming first: it covers a slot that would otherwise score zero, which is
  // worth more than any marginal ROS upgrade. A stream claim takes the single
  // per-cycle claim; a stream free-add costs no priority.
  let claimUsed = false;
  if (stream) {
    try {
      if (stream.onWaivers && doClaims) {
        const res = await submitWaiverClaim(gql, resolve(stream.add), stream.drop ? resolve(stream.drop) : null);
        claimUsed = true;
        console.log(`  streamed (claim) ${stream.add} for week ${stream.forWeek}${stream.drop ? ` (dropping ${stream.drop})` : ""} [${res.status}]`);
        logEvent("coach", "waiver-stream", `Claimed ${stream.add} to cover week ${stream.forWeek} ${stream.position}${stream.drop ? `, dropping ${stream.drop}` : ""}.`, { week, forWeek: stream.forWeek, add: stream.add, drop: stream.drop, position: stream.position, via: "claim", transaction_id: res.transactionId, status: res.status });
      } else if (!stream.onWaivers && doAdds) {
        const res = await addFreeAgent(gql, resolve(stream.add), stream.drop ? resolve(stream.drop) : null);
        console.log(`  streamed (free add) ${stream.add} for week ${stream.forWeek}${stream.drop ? ` (dropping ${stream.drop})` : ""} [${res.status}]`);
        logEvent("coach", "waiver-stream", `Added ${stream.add} to cover week ${stream.forWeek} ${stream.position}${stream.drop ? `, dropping ${stream.drop}` : ""}.`, { week, forWeek: stream.forWeek, add: stream.add, drop: stream.drop, position: stream.position, via: "free-add", transaction_id: res.transactionId, status: res.status });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "waiver-stream-failed", `Stream ${stream.add} failed: ${msg}`, { week, add: stream.add });
      if (live) await sendAlert("Stream pickup failed", `Week ${stream.forWeek}: ${stream.add} — ${msg}`);
    }
  }

  // An "ir-stash" add goes into the slot an injured player vacates, so the IR
  // move has to happen FIRST and has to be confirmed. Submitting the add on its
  // own is what produced "Your roster is either invalid or will be invalid
  // after this move" on 2026-09-19: the planner had picked the path, but
  // nothing ever performed it, and the alert told Filip to do it by hand.
  // Sleeper's lock refusal ("wait until this week's games are complete")
  // applies to every candidate equally, so it ends IR moves for this run:
  // trying it once per candidate produced five failures and five alerts in
  // one second. Any OTHER refusal is about that one player (R3), so the next
  // best candidate gets one try.
  const stashRanked = stashCandidates({ roster, irEligible, currentStarters }, waiverCfg).map((p) => p.name);
  let stashLocked = false;
  const stashRefusedNames = new Set<string>();
  let retried = false;
  const stashOnce = async (name: string): Promise<boolean> => {
    const id = resolve(name);
    const mine = (await leagueRosters(leagueId)).find((r) => r.roster_id === rosterId);
    const current = mine?.reserve ?? [];
    if (current.includes(id)) return true; // already there
    const back = await updateReserve(gql, [...current, id], rosterId, leagueId);
    if (!back.includes(id)) throw new Error(`read-back has ${JSON.stringify(back)}`);
    console.log(`  moved ${name} to IR, freeing an active slot`);
    logEvent("coach", "ir-stash", `Moved ${name} to injured reserve, freeing an active slot.`, { week, leagueId, player: name, reserve: back });
    return true;
  };
  const stashToIr = async (name: string): Promise<boolean> => {
    if (stashLocked || stashRefusedNames.has(name)) return false;
    try {
      return await stashOnce(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  could not move ${name} to IR: ${msg}`);
      logEvent("coach", "ir-stash-failed", `Could not move ${name} to IR: ${msg}`, { week, leagueId, player: name });
      if (RESERVE_LOCKED_RE.test(msg)) {
        // Routine, not an incident: the next run after Monday night will do it.
        stashLocked = true;
        return false;
      }
      stashRefusedNames.add(name);
      if (live) await sendAlert("IR move failed", `Week ${week}: ${name} could not be moved to IR. ${msg}`);
      const next = stashRanked.find((n) => n !== name && !stashRefusedNames.has(n));
      if (next && !retried) {
        retried = true;
        console.log(`  trying the next IR candidate: ${next}`);
        return stashToIr(next);
      }
      return false;
    }
  };

  for (const m of doAdds ? freeAdds : []) {
    try {
      if (m.dropPath === "ir-stash" && m.irStash && !(await stashToIr(m.irStash))) {
        // No slot was freed, so the add cannot land. Try the next candidate
        // rather than throwing: a failed IR move is not a failed waiver run.
        continue;
      }
      let res: { transactionId: string; status: string };
      let via: "free-add" | "claim" = "free-add";
      try {
        res = await addFreeAgent(gql, resolve(m.add), m.drop ? resolve(m.drop) : null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // From Sunday kickoff until the waiver run clears, every unrostered
        // player is on waivers and Sleeper refuses free adds. The onWaivers
        // heuristic (dropped this week) cannot know that, so the answer is
        // to take Sleeper's word for it and file the same move as a claim.
        // Before 2026-09-22 this threw, the whole job exited 1, and two
        // alerts went out for a routine Tuesday.
        if (!/on waivers/i.test(msg)) throw err;
        if (!doClaims || claimUsed) {
          // An adds-only run has no business filing claims; the Tuesday claim
          // job owns that. Everyone else in the list is on waivers too.
          console.log(`  ${m.add} is on waivers; free adds are closed until the waiver run clears. Left for the claim job.`);
          logEvent("coach", "waiver-window", `Free adds closed (waiver window); ${m.add} left for the claim job.`, { week, leagueId, add: m.add });
          break;
        }
        res = await submitWaiverClaim(gql, resolve(m.add), m.drop ? resolve(m.drop) : null);
        via = "claim";
        claimUsed = true;
      }
      console.log(`  ${via === "claim" ? "claimed (was on waivers)" : "added"} ${m.add}${m.drop ? ` (dropping ${m.drop})` : ""} [${res.status}]`);
      logEvent("coach", via === "claim" ? "waiver-claim" : "waiver-add", `${via === "claim" ? "Claimed" : "Added free agent"} ${m.add}${m.drop ? `, dropping ${m.drop}` : ""}.`, {
        week, leagueId, add: m.add, drop: m.drop, transaction_id: res.transactionId, status: res.status, via,
      });
      // One transaction per pass, so a batch cannot leave a half-applied roster.
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("coach", "waiver-add-failed", `Free-agent add ${m.add} failed: ${msg}`, { week, leagueId, add: m.add });
      if (live) await sendAlert("Free-agent add failed", `Week ${week}: ${m.add} — ${msg}`);
      throw err;
    }
  }

  if (claim && doClaims && !claimUsed) {
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
      if (live) await sendAlert("Waiver claim failed", `Week ${week}: ${claim.add} — ${msg}`);
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
