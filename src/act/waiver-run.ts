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
import { leagueRosters, weekSchedule } from "../sleeper/graphql.ts";
import { rankByVor } from "../analysis/vor.ts";
import { buildRosterView, takenAcrossLeague } from "../analysis/roster-view.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { tokenGql, addFreeAgent, submitWaiverClaim, pendingRosterDelta, applyRosterDelta, updateReserve, currentStarters as legStarters } from "../league/api.ts";
import { streamNeeds, planStream, SWAP_POSITIONS, type StreamPoolPlayer, type StreamDecision } from "../analysis/streaming.ts";
import { canDrop } from "../analysis/rails.ts";
import { chooseLegalForcedDrops } from "../analysis/reconcile-plan.ts";
import { keptStarters } from "../analysis/roster-fit.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { loadValues, liveStatusFromRosters, toRail, weeksLeft } from "../analysis/value.ts";
import { DropIntentStore, decideIntent } from "./drop-intent.ts";
import { DropRefused } from "../league/drop-ledger.ts";
import { loadWeekProjections, byPlayerId, startableThisWeek } from "../analysis/week-projections.ts";
import { startingSlots, availabilityOf } from "../analysis/lineup.ts";
import {
  planWaivers, bestClaim, upcomingByeCrunch, crowdedByeWeeks, irOpportunities, stashCandidates, claimFallbackAllowed,
  DEFAULT_WAIVERS, type AvailablePlayer, type RosterState,
} from "../analysis/waivers.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { byeWeek } from "../data/byes.ts";
import { assertWritesAllowed, freezeState, failureExitCode } from "../killswitch.ts";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";
import { irEligible as ruleIrEligible, legsToScan, RESERVE_LOCKED_RE, reserveWritable } from "../sleeper/rules.ts";
import { overlayRosterStatus } from "./lineup-guard.ts";
import { pendingClaimPlayers, withoutPendingAdds, railsWithPendingDrops } from "./pending-claims.ts";
import { droppedAtFromTransactions, onWaiversNow, recentTeamKickoffs } from "./waiver-status.ts";
import { fileClaim, moveCost } from "./claim-exec.ts";
import { weekGames } from "../blog/auto.ts";

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

  // THE value (value.ts): rest-of-season points from the raw weekly tables,
  // live injury status from the roster read, one stash rule. Every keep, drop,
  // add and claim below reads it and nothing else.
  const ros = await loadValues(season, week, league.scoring_settings, liveStatusFromRosters(rosters));
  const liveStatus = overlayRosterStatus(players, mine);
  const roster: RailPlayer[] = myPlayerIds.map((id) => {
    const v = ros.get(id);
    const dump = liveStatus[id];
    const name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : v?.name ?? id);
    const position = dump?.position ?? v?.position ?? (/^[A-Z]{2,4}$/.test(id) ? "DEF" : "?");
    const team = dump?.team ?? v?.team ?? (/^[A-Z]{2,4}$/.test(id) ? id : undefined);
    const base: RailPlayer = v ? toRail(v) : { playerId: id, name, position, points: 0 };
    return { ...base, name, position, onIr: false, injuryStatus: dump?.injury_status ?? base.injuryStatus, bye: byeWeek(team) ?? undefined };
  });
  // Players spoken for by our own pending claims (R6): the adds leave the
  // candidate pool, the drops leave the drop table. The adds are planned
  // WITH as ours (RailPlayer.claimAdd: never a drop, a stash or a trade
  // give), so a second claim this cycle measures its gain against a roster
  // with the first one landed and cannot count the same seat twice.
  const pending = await pendingClaimPlayers(tokenGql(), week, rosterId, leagueId).catch(() => ({ adds: [], drops: [], slotsNeeded: 0 }));
  if (pending.adds.length || pending.drops.length) {
    console.log(`  pending claims: +${pending.adds.length} add(s) held out of the pool, ${pending.drops.length} drop(s) held off the table`);
  }
  for (const id of pending.adds) {
    if (roster.some((p) => p.playerId === id)) continue;
    const v = ros.get(id);
    const dump = players[id];
    const name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : v?.name ?? id);
    const position = dump?.position ?? v?.position ?? (/^[A-Z]{2,4}$/.test(id) ? "DEF" : "?");
    const team = dump?.team ?? v?.team ?? (/^[A-Z]{2,4}$/.test(id) ? id : undefined);
    const base: RailPlayer = v ? toRail(v) : { playerId: id, name, position, points: 0 };
    roster.push({ ...base, name, position, onIr: false, claimAdd: true, injuryStatus: dump?.injury_status ?? base.injuryStatus, bye: byeWeek(team) ?? undefined });
  }
  const nameOf = new Map(roster.map((p) => [p.playerId ?? "", p.name]));
  // This week's starters as the site has them. Never dropped, never stashed,
  // before their games lock (R7). The lineup guard owns who starts.
  // The starters Sleeper will score this week are the matchup leg's, not the
  // roster array's (api.ts matchupLegStarters).
  const starterIds = await legStarters(tokenGql(), week, mine.starters ?? [], rosterId, leagueId).catch(() => mine.starters ?? []);
  const currentStarters = starterIds.map((id) => nameOf.get(id)).filter((n): n is string => !!n);

  const rails = railsWithPendingDrops(DEFAULT_WAIVERS.rails, roster, pending.drops);
  const waiverCfg = { ...DEFAULT_WAIVERS, rails };

  // Available = fantasy players on no roster in the league. Rank by ROS, take the
  // top slice.
  // The global "taken" set is NOT adjusted by our pending trade: a player we are
  // trading away is still rostered by the team receiving him, and one we are
  // acquiring is still rostered (by them) until it processes. A trade frees
  // nobody to waivers. Only OUR roster view (above) reflects the delta.
  const rostered = takenAcrossLeague(rosters); // IR included: a stashed player is not a free agent
  const unrostered = withoutPendingAdds(Array.from(ros.values()).filter((p) => !rostered.has(p.playerId) && p.value > 0), pending.adds);

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
      points: p.value, ptsPpr: p.value, adp: 999, injuryStatus: p.injuryStatus, stats: {},
    })),
    league,
  )) vorOf.set(r.playerId, r.vor);

  const availableRos = unrostered
    .sort((a, b) => (vorOf.get(b.playerId) ?? 0) - (vorOf.get(a.playerId) ?? 0) || b.value - a.value)
    .slice(0, MAX_CANDIDATES);

  // On waivers, PER PLAYER (R5): dropped inside waiver_clear_days, or his team
  // has kicked off since the last Wednesday run. Drops are read from this leg
  // and the last (a Tuesday drop lives under last week's leg on Wednesday).
  // This decides whether a move is planned as a claim or a free add, and the
  // two are run by different jobs (--claims-only, --adds-only), so it has to
  // be right here: the write-time fallback below only helps a combined run.
  // Neither half may turn "could not read" into "free agent": a failed read
  // of the drops or of the schedule fails the run before any write, and the
  // scheduler runs it again. (Until 2026-10-06 a failed transactions read
  // made a player dropped an hour ago a free add, and the drop reaction then
  // marked that drop as handled.)
  const txns: TransactionLike[] = [];
  for (const l of legsToScan(week)) txns.push(...((await sleeper.transactions(leagueId, l)) as TransactionLike[]));
  const droppedAt = droppedAtFromTransactions(txns);
  const clearDays = (league.settings as { waiver_clear_days?: number }).waiver_clear_days ?? 2;
  const nowMs = Date.now();
  // Kickoffs of the NFL week as it is NOW and the one before, from the
  // schedule (waiver-status.ts): on a Tuesday it is last week's games that
  // hold a player on waivers. Never the --week planning override, and not
  // the pick'em cache, which knows one week.
  const kickoffs = await recentTeamKickoffs(state.week || week, nowMs, (w) => weekSchedule(season, w));
  const isOnWaivers = (id: string, team: string | null | undefined): boolean =>
    onWaiversNow({ playerId: id, team, droppedAt, kickoffs, now: nowMs, clearDays });

  // Name -> player_id, for both the available pool and our own roster. The
  // analysis reasons in names, but every write needs an id: the GraphQL roster
  // mutations take player ids, not display names.
  const idByName = new Map<string, string>();
  for (const p of ros.values()) if (p.name) idByName.set(p.name, p.playerId);

  const available: AvailablePlayer[] = availableRos.map((p) => ({
    ...toRail(p),
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
  // THIS week's projection by name, for a one-week rental (waivers.ts
  // weekLineupGain): zero for a player on bye, not playing, or whose game
  // this week has kicked off. The week is the planning week; kickoffs are
  // only known for the week as it is now.
  const weekTable = byPlayerId(await loadWeekProjections(season, week, league.scoring_settings).catch(() => []));
  // A failed schedule read must not read as "nobody has kicked off" for the
  // starter a cut keeps (canFill below): with no schedule nobody fills a slot.
  let scheduleKnown = true;
  const thisWeekGames = week === (state.week || week) ? await weekSchedule(season, week).catch(() => { scheduleKnown = false; return []; }) : [];
  const kickedOff = new Set<string>();
  for (const g of thisWeekGames) if (g.startTime > 0 && g.startTime <= nowMs) { kickedOff.add(g.away); kickedOff.add(g.home); }
  // A kicked-off team is zero for the POOL only: a starter of ours whose
  // game has begun is pinned in his slot by the guard, not an open seat.
  const weekPointsOf = (id: string, status: string | null | undefined, team: string | null | undefined, pool = false): number => {
    const r = weekTable.get(id);
    if (!r || !r.hasGame || r.onBye || (pool && team && kickedOff.has(team))) return 0;
    return availabilityOf({ playerId: id, name: r.name, position: r.position, points: r.points, injuryStatus: status ?? r.injuryStatus }).available ? r.points : 0;
  };
  const weekPoints = new Map<string, number>();
  for (const p of roster) weekPoints.set(p.name, weekPointsOf(p.playerId ?? "", p.injuryStatus, liveStatus[p.playerId ?? ""]?.team ?? ros.get(p.playerId ?? "")?.team));
  for (const p of availableRos) weekPoints.set(p.name, weekPointsOf(p.playerId, p.injuryStatus, p.team, true));
  // Who can be moved INTO the lineup this week, for the starter a cut keeps
  // (roster-fit.ts keptStarters): plays, his game not begun, not the drop of
  // a pending claim. A starting rental with a better kicker or defense
  // behind him who can fill the slot is the cut, not the better body.
  const startable = startableThisWeek(weekTable, thisWeekGames, nowMs);
  const pendingDropIds = new Set<string>(pending.drops);
  const canFill = (body: RailPlayer, starter: RailPlayer): boolean => scheduleKnown && startable(body, starter) && !pendingDropIds.has(body.playerId ?? "");
  // Last in the rolling waiver order: a successful claim moves us nowhere,
  // so a claim costs nothing (waivers.ts).
  const waiverPosition = Number((mine.settings as { waiver_position?: number }).waiver_position ?? 0);
  const priorityFree = waiverPosition > 0 && waiverPosition >= rosters.length;
  if (priorityFree) console.log(`  waiver priority ${waiverPosition} of ${rosters.length}: last, so a claim costs nothing (at most one rung, if a rival ahead wins a claim first on Wednesday)`);
  // Players already on IR, for the return forecast (waivers.ts
  // returnsAcceptable): an add into their open seat is checked against
  // whoever the activation would cut when each comes back.
  const reserve: RailPlayer[] = view.reserve.map((e) => {
    const v = ros.get(e.playerId);
    const base: RailPlayer = v ? toRail(v) : { playerId: e.playerId, name: e.name, position: e.position, points: 0 };
    return { ...base, name: e.name, position: e.position, onIr: true, injuryStatus: e.injuryStatus ?? base.injuryStatus, bye: byeWeek(e.team) ?? undefined };
  });
  const rosterState: RosterState = {
    roster,
    reserve,
    openBenchSlots: Math.max(0, slots.length + benchCap - activePlayers - pending.slotsNeeded),
    openIrSlots,
    startingSlots: slots,
    irEligible,
    currentStarters,
    weeksLeft: weeksLeft(week),
    priorityFree,
    weekPoints,
    canFill,
  };

  // Look ahead for a crowded STARTER bye we still have time to relieve (the
  // week-8 hole is a week-7 job), and feed the crowded weeks into the move
  // ranking so a relieving add edges ahead of an equal one that ignores it.
  const byeCrunch = upcomingByeCrunch(roster, slots, week, waiverCfg);
  const crowdedByes = crowdedByeWeeks(byeCrunch);
  const irOpps = irOpportunities(roster, openIrSlots, irEligible, currentStarters);

  let moves = planWaivers(available, rosterState, waiverCfg, crowdedByes);
  let claim = bestClaim(moves);
  let freeAdds = moves.filter((m) => m.kind === "free-add");
  const froze = freezeState();
  // After a move lands the plan is stale: the seat is taken, the stashed
  // man is on IR, the newcomer is ours. Apply it and plan again, so two
  // open seats get two pickups in one run (Filip, 2026-10-06: "two players
  // injured means we can pick up two players"). A claim's add is counted
  // as ours (claimAdd) and his seat held; a free add is simply ours.
  const applyLanded = (m: { add: string; drop: string | null; irStash: string | null; dropPath: string }, asClaim: boolean): void => {
    const inc = available.find((p) => p.name === m.add);
    available.splice(0, available.length, ...available.filter((p) => p.name !== m.add));
    if (inc) rosterState.roster.push(asClaim ? { ...inc, claimAdd: true } : { ...inc });
    if (m.drop) rosterState.roster.splice(0, rosterState.roster.length, ...rosterState.roster.filter((p) => p.name !== m.drop));
    if (m.dropPath === "ir-stash" && m.irStash) {
      const stashed = rosterState.roster.find((p) => p.name === m.irStash);
      rosterState.roster.splice(0, rosterState.roster.length, ...rosterState.roster.filter((p) => p.name !== m.irStash));
      if (stashed) (rosterState.reserve ??= []).push({ ...stashed, onIr: true });
      rosterState.openIrSlots = Math.max(0, rosterState.openIrSlots - 1);
    } else if (!m.drop) {
      rosterState.openBenchSlots = Math.max(0, rosterState.openBenchSlots - 1);
    }
    moves = planWaivers(available, rosterState, waiverCfg, crowdedByes);
    claim = bestClaim(moves);
    freeAdds = moves.filter((x) => x.kind === "free-add");
  };

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
  const streamBase = unrostered.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team, bye: byeWeek(p.team), value: p.value }));
  const needs = streamNeeds(roster, week, DEFAULT_WAIVERS.byeLookaheadWeeks ?? 3);
  let stream: { add: string; drop: string | null; position: string; forWeek: number; onWaivers: boolean; points: number; coveringFor: string[]; how: StreamDecision["how"] } | null = null;
  // Needs the run is not acting on: a swap that is not due yet, or a slot
  // with no legal way to fill it. Reported, never passed over in silence:
  // before 2026-09-30 a need with no legal cut printed "no upcoming empty
  // starting slot".
  const streamNotes: StreamDecision[] = [];
  // May a rostered player leave at all: the never-drop list and the drop of
  // a pending claim say no; the protected top-N does not apply to a swap,
  // which replaces him at his own position.
  const leaveRails = { ...rails, protectTopN: 0 };
  // The starters a cut keeps this week (roster-fit.ts keptStarters): a
  // starting rental with a better kicker or defense behind him who can fill
  // the slot is not kept, so he is the streamer's spare in the need week
  // and never protected from the scarce-position cut.
  const kept = keptStarters(currentStarters, roster, canFill);
  for (const need of needs) {
    const table = byPlayerId(await loadWeekProjections(season, need.week, league.scoring_settings).catch(() => []));
    const pool: StreamPoolPlayer[] = streamBase
      .filter((p) => p.position === need.position)
      .map((p) => ({ ...p, weekPoints: table.get(p.playerId)?.points ?? 0, onWaivers: isOnWaivers(p.playerId, p.team) }));
    // Kicker and defense: the covered player is swapped in his bye week
    // (streaming.ts planStream). A scarce position: the cheapest legal cut,
    // never the player being covered for (he returns) nor a kept starter (a
    // starting rental with a better body behind him is not kept);
    // chooseForcedDrops refuses to empty a mandatory slot or cut a stash.
    // No schedule, no decision: with this week's kickoffs unknown nobody
    // fills a slot, every starter is kept, and the swap due this week
    // would take the covered kicker while a spare rental starts. It waits
    // for a run that has the schedule; a body added Wednesday still plays
    // Sunday.
    if (!scheduleKnown && need.week === week && SWAP_POSITIONS.has(need.position)) {
      streamNotes.push({ need, how: "wait", add: null, drop: null, onWaivers: false, points: 0, reason: `this week's schedule could not be read, so whether a starting ${need.position} or DEF is the spare is unknown; the swap waits for a run that has it` });
      continue;
    }
    const d = planStream({
      need, week, openBenchSlots: rosterState.openBenchSlots, pool, roster,
      mayLeave: (n) => canDrop(n, roster, leaveRails).allowed,
      forcedDrop: () => chooseLegalForcedDrops(view, roster, 1, streamCfg, rails, [...need.coveringFor, ...kept])[0]?.name ?? null,
      currentStarters, kept, priorityFree,
    });
    if (!d.add || d.how === "wait" || d.how === "stuck") { streamNotes.push(d); continue; }
    stream = { add: d.add, drop: d.drop, position: need.position, forWeek: need.week, onWaivers: d.onWaivers, points: d.points, coveringFor: need.coveringFor, how: d.how };
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
    // A free agent into an open slot is judged on what the body is worth to
    // the team (depthPts), not against a bench player he is not replacing.
    const worth = m.rental ? `this week +${m.weekGainPts}` : m.kind === "free-add" && !m.drop && m.depthPts > 0 ? `team +${m.depthPts}` : `bench ${m.benchGainPts >= 0 ? "+" : ""}${m.benchGainPts} ROS`;
    console.log(`  [${m.kind}] ${m.add} (${m.position}, lineup +${m.gainPts}, ${worth})${drop}${bye} — ${m.reason}`);
  }
  console.log(`  single best claim: ${claim ? `${claim.add} (lineup +${claim.gainPts}, bench +${claim.benchGainPts} ROS${claim.drop ? `, drop ${claim.drop}` : claim.irStash ? `, ${claim.irStash} to IR first` : ""})` : "none worth a priority burn"}`);

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
    console.log(`    STREAM: week ${stream.forWeek} would leave ${stream.position} empty (${stream.coveringFor.join(", ")} out); grab ${stream.add} now${stream.drop ? `, drop ${stream.drop}` : ""} [${stream.how}, ${stream.onWaivers ? "claim" : "free add"}]`);
  }
  for (const n of streamNotes) console.log(`    stream ${n.how === "stuck" ? "STUCK" : "waiting"} (week ${n.need.week} ${n.need.position}): ${n.reason}`);
  if (!stream && !streamNotes.length) console.log("    no upcoming empty starting slot to stream for.");

  logEvent("coach", live ? "waiver-run" : "waiver-shadow", `Week ${week} waivers: ${freeAdds.length} free adds, ${claim ? "1 claim" : "no claim"}${live ? "" : " (shadow)"}${byeCrunch.length ? `; watching week ${byeCrunch.map((b) => b.week).join("/")} bye` : ""}${irOpps.length ? `; ${irOpps.length} IR opportunity` : ""}`, {
    week, leagueId, shadow: !live,
    freeAdds: freeAdds.map((m) => ({ add: m.add, drop: m.drop, stash: m.irStash, gain: m.gainPts, benchGain: m.benchGainPts, depth: m.depthPts, rental: m.rental, weekGain: m.weekGainPts })),
    claim: claim ? { add: claim.add, drop: claim.drop, stash: claim.irStash, gain: claim.gainPts, benchGain: claim.benchGainPts, rental: claim.rental, weekGain: claim.weekGainPts } : null,
    priorityFree,
    byeCrunch: byeCrunch.map((b) => ({ week: b.week, starters: b.count, names: b.names })),
    irOpportunities: irOpps.map((o) => ({ name: o.name, status: o.injuryStatus, isStash: o.isStash })),
    stream: stream ? { add: stream.add, drop: stream.drop, position: stream.position, forWeek: stream.forWeek, how: stream.how, via: stream.onWaivers ? "claim" : "free-add" } : null,
    streamNotes: streamNotes.map((n) => ({ week: n.need.week, position: n.need.position, how: n.how, reason: n.reason })),
  });
  // A starting slot that will be empty with no legal way to fill it is for
  // the review to see, from the live runs only (a shadow run is a look).
  if (live) {
    for (const n of streamNotes.filter((x) => x.how === "stuck")) {
      logEvent("coach", "waiver-stream-stuck", n.reason, { week, forWeek: n.need.week, position: n.need.position, coveringFor: n.need.coveringFor });
    }
    // A swap due THIS week that is still waiting (every candidate on
    // waivers) is an empty slot on Sunday if it never clears. Logged each
    // live run so the review can see how long it has waited.
    for (const n of streamNotes.filter((x) => x.how === "wait" && x.need.week === week)) {
      logEvent("coach", "waiver-stream-waiting", n.reason, { week, forWeek: n.need.week, position: n.need.position, coveringFor: n.need.coveringFor });
    }
  }

  // Surface a live IR opportunity: it is a costless roster expansion and the one
  // move that can genuinely help a crowded bye, but the IR-move DOM flow is not
  // built or staging-verified yet, so it is alerted for manual action rather than
  // issued blind (the same discipline as waiver claims and trades).
  // No "IR opportunity, do it in Sleeper" alert any more: the coach performs
  // the IR move itself when a slot is needed, and alerts only if Sleeper
  // refuses. The old alert also fired on every dry run, which is how a
  // read-only check spammed Filip's phone on 2026-09-20.

  // No "recommended" pushes: the bot files its own claims and streams. What it
  // did is in the activity log; what it could not do raises a failure event.

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

  // TWO LOOKS before any move that costs a player (a drop or an IR stash). The
  // first live run records the exact move; a later run, at least 30 minutes on,
  // must plan the same move from fresh data before it is written. A move into
  // an open slot costs nobody and goes at once. (drop-intent.ts; the schedule
  // runs each job twice for this.) Filip, 2026-09-30: no rushing.
  const intents = new DropIntentStore();
  const nowMs2 = Date.now();
  const confirmed = (kind: string, add: string, cost: string | null): boolean => {
    if (!cost) return true;
    const prefix = `waiver:${kind}:${add}:`;
    const key = `${prefix}${cost}`;
    intents.settle(prefix, key, nowMs2);
    const gate = decideIntent(intents.get(key), nowMs2);
    if (gate.action === "go") { intents.delete(key); return true; }
    if (gate.action === "record") {
      intents.put({ key, firstSeen: nowMs2, note: `${kind} ${add} costing ${cost}` });
      console.log(`  ${kind} ${add} (costs ${cost}): recorded, confirming on the next run`);
      logEvent("coach", "waiver-intent", `Would ${kind} ${add} costing ${cost}; confirming on a later run.`, { week, leagueId, kind, add, cost });
    } else {
      console.log(`  ${kind} ${add} (costs ${cost}): waiting for the confirmation window`);
    }
    return false;
  };

  // Streaming first: it covers a slot that would otherwise score zero, which is
  // worth more than any marginal ROS upgrade. A stream claim takes the single
  // per-cycle claim; a stream free-add costs no priority.
  let claimUsed = false;
  // Only a run that can perform the stream may confirm it. confirmed()
  // consumes the recorded intent when it says go, so a claims-only run
  // confirming a free add (or the reverse) used the intent up and wrote
  // nothing.
  if (stream && !(stream.onWaivers ? doClaims : doAdds)) {
    console.log(`  stream ${stream.add}: left for the ${stream.onWaivers ? "claim" : "free-agent"} run`);
    stream = null;
  }
  if (stream && !confirmed("stream", stream.add, stream.drop)) stream = null;
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
      intents.settle("waiver:", "", nowMs2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DropRefused) {
        logEvent("coach", "waiver-stream-deferred", `Stream ${stream.add} deferred by the breaker: ${err.verdict.reason}`, { week, add: stream.add });
      } else {
        logEvent("coach", "waiver-stream-failed", `Stream ${stream.add} failed: ${msg}`, { week, add: stream.add });
        if (live) await sendAlert("Stream pickup failed", `Week ${stream.forWeek}: ${stream.add} — ${msg}`);
      }
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
    stashedThisRun = id;
    console.log(`  moved ${name} to IR, freeing an active slot`);
    logEvent("coach", "ir-stash", `Moved ${name} to injured reserve, freeing an active slot.`, { week, leagueId, player: name, reserve: back });
    return true;
  };
  // Sleeper refuses reserve writes while a game is in progress. Asked once,
  // before the first write, so a routine Sunday is one "deferred" line and
  // not a refused write logged as a failure. A failed read is not a lock:
  // the write decides.
  let lockChecked = false;
  const reserveOpen = async (): Promise<boolean> => {
    if (!lockChecked) {
      lockChecked = true;
      const games = await weekGames(week).catch(() => []);
      if (games.length && !reserveWritable(games)) {
        stashLocked = true;
        console.log("  IR is locked while this week's games are in progress; IR moves wait for a later run");
        logEvent("coach", "ir-stash-deferred", "IR moves wait: Sleeper locks reserve while a game is in progress.", { week, leagueId });
      }
    }
    return !stashLocked;
  };
  // The id this run moved to IR, so a refused add or claim can put him back.
  let stashedThisRun: string | null = null;
  const undoStash = async (why: string): Promise<void> => {
    const id = stashedThisRun;
    if (!id) return;
    try {
      const mine = (await leagueRosters(leagueId)).find((r) => r.roster_id === rosterId);
      if (!mine) throw new Error("our roster is not in the live read");
      // Only into a slot that is really empty. If the add landed after all
      // (an error after the write), putting him back makes seventeen active
      // and the over-cap path cuts somebody.
      const fresh = buildRosterView(mine);
      const held = (await pendingClaimPlayers(gql, week, rosterId, leagueId).catch(() => ({ adds: [], drops: [], slotsNeeded: 1 }))).slotsNeeded;
      if (!fresh.reserveIds.has(id)) { stashedThisRun = null; return; }
      if (fresh.active.length + held >= slots.length + benchCap) throw new Error(`no empty active slot (${fresh.active.length} active, ${held} held)`);
      const back = await updateReserve(gql, (mine.reserve ?? []).filter((x) => x !== id), rosterId, leagueId);
      if (back.includes(id)) throw new Error(`read-back has ${JSON.stringify(back)}`);
      stashedThisRun = null;
      console.log(`  moved ${nameOf.get(id) ?? id} back off IR (${why})`);
      logEvent("coach", "ir-unstash", `Moved ${nameOf.get(id) ?? id} back to the active roster: ${why}.`, { week, leagueId, player: id, reserve: back });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // He stays on IR with his slot empty; the next run plans into it.
      console.error(`  could not move ${nameOf.get(id) ?? id} back off IR: ${msg}`);
      logEvent("coach", "ir-unstash-failed", `Could not move ${nameOf.get(id) ?? id} back off IR (${why}): ${msg}`, { week, leagueId, player: id });
    }
  };
  // `allowNext` false = exactly this player or nobody (a claim's two looks
  // confirmed him by name).
  const stashToIr = async (name: string, allowNext = true): Promise<boolean> => {
    if (!(await reserveOpen())) return false;
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
      if (allowNext && next && !retried) {
        retried = true;
        console.log(`  trying the next IR candidate: ${next}`);
        return stashToIr(next);
      }
      return false;
    }
  };

  // Only the BEST current move is ever written, and only when it is the same
  // move a previous run recorded (two looks). A lesser move is not written
  // just because its own record aged: the second look must agree with the
  // first about what the best move is.
  // Up to three moves a run, each from a fresh plan over the roster as the
  // last one left it; a move that needs its second look ends the run.
  adds: for (let round = 0; round < 3 && doAdds && freeAdds[0]; round++) {
    const m = freeAdds[0]!;
    if (!confirmed("add", m.add, moveCost(m))) break;
    try {
      if (m.dropPath === "ir-stash" && m.irStash && !(await stashToIr(m.irStash))) {
        // No slot was freed, so the add cannot land. Not an error: a failed
        // IR move is not a failed waiver run.
        break;
      }
      let res: { transactionId: string; status: string };
      let via: "free-add" | "claim" = "free-add";
      try {
        res = await addFreeAgent(gql, resolve(m.add), m.drop ? resolve(m.drop) : null);
        stashedThisRun = null; // the add landed in his slot: nothing to undo from here on
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
          await undoStash(`${m.add} is on waivers and was not added`);
          break adds;
        }
        // A claim costs our waiver position, so the move must be one the
        // planner would have claimed had it known he was on waivers. A bench
        // swap of a point a week, or a depth body into an open slot, waits
        // for him to clear.
        const incoming = available.find((p) => p.name === m.add);
        if (!incoming || !claimFallbackAllowed(m, incoming, rosterState, waiverCfg, crowdedByes)) {
          console.log(`  ${m.add} is on waivers and not worth a claim; waiting for him to clear.`);
          logEvent("coach", "waiver-window", `${m.add} is on waivers; the move is not worth our waiver position, waiting for him to clear.`, { week, leagueId, add: m.add, drop: m.drop });
          await undoStash(`${m.add} is on waivers and was not added`);
          break adds;
        }
        res = await submitWaiverClaim(gql, resolve(m.add), m.drop ? resolve(m.drop) : null);
        stashedThisRun = null; // the claim holds his slot
        via = "claim";
        claimUsed = true;
      }
      console.log(`  ${via === "claim" ? "claimed (was on waivers)" : "added"} ${m.add}${m.drop ? ` (dropping ${m.drop})` : ""} [${res.status}]${m.rental ? " (one-week rental)" : ""}`);
      logEvent("coach", via === "claim" ? "waiver-claim" : "waiver-add", `${via === "claim" ? "Claimed" : "Added free agent"} ${m.add}${m.drop ? `, dropping ${m.drop}` : m.irStash ? `, ${m.irStash} moved to IR` : ""}${m.rental ? ` (one-week rental, +${m.weekGainPts} this week)` : ""}.`, {
        week, leagueId, add: m.add, drop: m.drop, stash: m.irStash, rental: m.rental, weekGain: m.weekGainPts, transaction_id: res.transactionId, status: res.status, via,
      });
      // Every other recorded waiver intent is stale now: the next move is
      // planned afresh over the roster as this one left it.
      intents.settle("waiver:", "", nowMs2);
      applyLanded(m, via === "claim");
      stashedThisRun = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DropRefused) {
        // The breaker decided; the next confirming run after the cooldown tries again.
        console.log(`  ${m.add}: drop deferred by the breaker (${err.verdict.reason})`);
        logEvent("coach", "waiver-add-deferred", `Free-agent add ${m.add} deferred by the breaker: ${err.verdict.reason}`, { week, leagueId, add: m.add });
        break;
      }
      logEvent("coach", "waiver-add-failed", `Free-agent add ${m.add} failed: ${msg}`, { week, leagueId, add: m.add });
      await undoStash(`the add of ${m.add} failed`);
      if (live) await sendAlert("Free-agent add failed", `Week ${week}: ${m.add} — ${msg}`);
      throw err;
    }
  }

  // Claims, up to three a run on the same terms: after one is filed the
  // plan is made again with that add counted as ours and his seat held.
  for (let round = 0; round < 3 && claim && doClaims && !claimUsed; round++) {
    const cur = claim;
    try {
      // A claim through an IR slot parks the injured player first, and that
      // costs a look like any drop (claim-exec.ts). Before 2026-10-02 such a
      // claim was filed with no drop into a full roster.
      const out = await fileClaim(cur, {
        stashReady: () => reserveOpen(),
        confirmed,
        stash: (name) => stashToIr(name, false),
        submit: (add, drop) => submitWaiverClaim(gql, resolve(add), drop ? resolve(drop) : null),
        undoStash: () => undoStash(`the claim for ${cur.add} was refused`),
      });
      if (out.status === "held") {
        const why = stashLocked ? "IR is locked while a game is in progress" : `${cur.irStash ?? "nobody"} could not be moved to IR`;
        console.log(`  claim ${cur.add}: not filed (${why})`);
        logEvent("coach", "waiver-claim-held", `Claim for ${cur.add} not filed: ${why}. The next waiver run plans it again.`, { week, leagueId, add: cur.add, stash: cur.irStash });
        break;
      } else if (out.status === "filed") {
        const cost = cur.drop ? ` (dropping ${cur.drop})` : cur.irStash ? ` (${cur.irStash} moved to IR, no drop)` : "";
        console.log(`  claimed ${cur.add}${cost} [${out.submitStatus}]${cur.rental ? " (one-week rental)" : ""}`);
        logEvent("coach", "waiver-claim", `Submitted waiver claim for ${cur.add}${cur.drop ? `, dropping ${cur.drop}` : cur.irStash ? `, ${cur.irStash} moved to IR` : ""} (${cur.rental ? `one-week rental, +${cur.weekGainPts} this week` : `lineup +${cur.gainPts}, bench +${cur.benchGainPts} ROS`}).`, {
          week, leagueId, add: cur.add, drop: cur.drop, stash: cur.irStash, gainPts: cur.gainPts, benchGainPts: cur.benchGainPts, rental: cur.rental, weekGain: cur.weekGainPts,
          transaction_id: out.transactionId, status: out.submitStatus,
        });
        intents.settle("waiver:", "", nowMs2);
        applyLanded(cur, true);
        stashedThisRun = null;
      } else {
        break; // waiting on its second look
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DropRefused) {
        logEvent("coach", "waiver-claim-deferred", `Waiver claim ${cur.add} deferred by the breaker: ${err.verdict.reason}`, { week, leagueId, add: cur.add });
        return;
      }
      logEvent("coach", "waiver-claim-failed", `Waiver claim ${cur.add} failed: ${msg}`, { week, leagueId, add: cur.add });
      if (live) await sendAlert("Waiver claim failed", `Week ${week}: ${cur.add} — ${msg}`);
      throw err;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`waiver-run failed: ${err instanceof Error ? err.message : String(err)}`);
    // Before the write gate nothing changed on the site, and the scheduler
    // may run this again. After it, a plain failure.
    process.exit(failureExitCode());
  });
