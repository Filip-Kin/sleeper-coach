#!/usr/bin/env bun
// The ONLY way a hand-made roster move happens.
//
// On 2026-09-30 I recommended, and Filip approved, cutting Jacory
// Croskey-Merritt to activate Nico Collins, working from values I had read on
// Monday. By Wednesday he was the best running back on the bench and Tyjae
// Spears was the right cut. The numbers were two days old and nobody re-read
// them at the moment of the write. This script exists so that cannot happen
// again: it reads live values at the moment it runs, prints the whole picture,
// and refuses a cut that is not the cheapest legal one unless told, in
// writing, why.
//
//   bun run src/act/roster-move.ts drop     <name>                       # release a player
//   bun run src/act/roster-move.ts add      <name> [--drop <name>]       # free-agent add
//   bun run src/act/roster-move.ts claim    <name> [--drop <name>]       # waiver claim
//   bun run src/act/roster-move.ts activate <name> [--drop <name>]       # off IR
//   bun run src/act/roster-move.ts stash    <name>                       # onto IR
//
// Nothing is written without --write. A cut that is not the lowest-valued
// legal candidate needs --override "<reason>". Every write is recorded in the
// drop ledger as "manual" and in the activity log with the values it saw.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import { tokenGql, myRosterView, addFreeAgent, submitWaiverClaim, dropPlayers, updateReserve, currentStarters, cancelWaiverClaim } from "../league/api.ts";
import { loadValues, liveStatusFromRosters, toRail, cutOrder, notPlaying, LAST_WEEK, type PlayerValue } from "../analysis/value.ts";
import { canDrop, DEFAULT_RAILS } from "../analysis/rails.ts";
import { keptStarters } from "../analysis/roster-fit.ts";
import { bestLineup } from "../analysis/trade.ts";
import { loadWeekFacts } from "../analysis/week-projections.ts";
import { weekLineupGain } from "../analysis/waivers.ts";
import { irEligible, staleReserve } from "../sleeper/rules.ts";
import { logEvent } from "../log.ts";
import { pendingClaimPlayers, claimsToCancel, type PendingClaim, type HeldClaim } from "./pending-claims.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const WRITE = args.includes("--write");
const opt = (k: string): string | undefined => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const OVERRIDE = opt("override");
// Words up to the first flag are the target; the words after --drop up to the
// next flag are the drop. Quoting is optional either way.
const rest = args.slice(1);
const firstFlag = rest.findIndex((a) => a.startsWith("--"));
const name = (firstFlag < 0 ? rest : rest.slice(0, firstFlag)).join(" ").trim();
const dropIdx = rest.indexOf("--drop");
const dropWords = dropIdx < 0 ? [] : rest.slice(dropIdx + 1, (() => { const n = rest.slice(dropIdx + 1).findIndex((a) => a.startsWith("--")); return n < 0 ? rest.length : dropIdx + 1 + n; })());
const dropName = dropWords.length ? dropWords.join(" ") : undefined;

if (!cmd || !name) {
  console.log("usage: roster-move.ts <drop|add|claim|activate|stash> <player name> [--drop <name>] [--write] [--override <reason>]");
  process.exit(2);
}

const gql = tokenGql();
const state = await sleeper.nflState();
const week = Math.max(1, state.week || 1);
const league = await sleeper.league(config.leagueId);
const rosters = await leagueRosters(config.leagueId);
const values = await loadValues(state.season || config.season, week, league.scoring_settings, liveStatusFromRosters(rosters), { forceRefresh: true });
const view = await myRosterView();
const starters = new Set(await currentStarters(gql, week, []).catch(() => [] as string[]));
const pending = await pendingClaimPlayers(gql, week).catch(() => ({ adds: [], drops: [], slotsNeeded: 0, claims: [] as PendingClaim[] }));
const weekFacts = await loadWeekFacts(state.season || config.season, week, league.scoring_settings);
const startable = weekFacts.startable;
const SLOTS = league.roster_positions.filter((s) => s !== "BN" && s !== "IR");
const taken = new Set(rosters.flatMap((r) => r.players ?? []));

const byName = (n: string): PlayerValue | undefined => {
  const q = n.toLowerCase();
  const exact = [...values.values()].find((v) => v.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = [...values.values()].filter((v) => v.name.toLowerCase().includes(q));
  if (partial.length > 1) { console.error(`"${n}" matches ${partial.map((v) => v.name).join(", ")}; be exact`); process.exit(2); }
  return partial[0];
};
const fmt = (v: PlayerValue | undefined, id: string): string => v
  ? `${v.name.padEnd(24)} ${v.position.padEnd(3)} ${String(v.valueAvg).padStart(5)}/wk  ROS ${String(Math.round(v.value)).padStart(4)}  season ${String(Math.round(v.seasonPoints)).padStart(4)} (${v.position}${v.seasonRank})  ${v.injuryStatus ?? "healthy"}${v.stash ? "  STASH" : ""}`
  : `${id.padEnd(24)} (no value)`;

// The picture, live.
const rail = view.active.map((e) => { const v = values.get(e.playerId); return v ? toRail(v) : { playerId: e.playerId, name: e.name, position: e.position, points: 0 }; });
const pendingDrops: string[] = pending.drops;
// A starter is kept from the cut unless he is a kicker or defense with a
// better body behind him who can take the slot this week (roster-fit.ts
// keptStarters): a starting one-week rental is cut before the better one.
// For an add, the target counts as a body who can take a slot: a starting
// back, receiver or tight end he beats at his own position and can replace
// this week is a legal cut for him (the engine's same-position upgrade).
const newcomer = (cmd === "add" || cmd === "claim") && name ? values.get(byName(name)?.playerId ?? "") : undefined;
const kept = new Set(keptStarters(rail.filter((p) => starters.has(p.playerId!)).map((p) => p.name), rail,
  (body, starter) => startable(body, starter) && !pendingDrops.includes(body.playerId ?? ""), newcomer ? toRail(newcomer) : undefined).map((n) => n.toLowerCase()));
const legalCuts = cutOrder(rail.filter((p) => !kept.has(p.name.toLowerCase()) && !pendingDrops.includes(p.playerId!) && canDrop(p.name, rail, { ...DEFAULT_RAILS, protectTopN: 0 }).allowed));
console.log(`\nWeek ${week}. Active ${view.active.length}/${league.roster_positions.length}, IR ${view.reserve.map((e) => e.name).join(", ") || "empty"}. Pending claims: +${pending.adds.length} / -${pending.drops.length}.`);
console.log("\nOUR ROSTER (live values; * = starts this week; cut order among legal cuts shown)");
for (const e of [...view.active].sort((a, b) => (values.get(b.playerId)?.value ?? 0) - (values.get(a.playerId)?.value ?? 0))) {
  const idx = legalCuts.findIndex((p) => p.playerId === e.playerId);
  console.log(`  ${starters.has(e.playerId) ? "*" : " "} ${fmt(values.get(e.playerId), e.playerId)}${idx >= 0 ? `   cut #${idx + 1}` : ""}`);
}
for (const e of view.reserve) console.log(`  IR ${fmt(values.get(e.playerId), e.playerId)}`);

const target = byName(name);
if (!target) { console.error(`\nno player named "${name}" in the value table`); process.exit(2); }
console.log(`\nTARGET  ${fmt(target, target.playerId)}`);
const drop = dropName ? byName(dropName) : undefined;
if (dropName && !drop) { console.error(`no player named "${dropName}"`); process.exit(2); }

// The cut check: whoever leaves must be the cheapest legal cut, or say why not.
// A swap at the target's own position by a target who would NOT start in
// the rest-of-season lineup is the engine's bench upgrade (waivers.ts
// evalPaths: the cheapest same-position body goes, whatever a cheaper body
// at another position is worth), so the order is among that position's
// legal cuts. A target who starts costs the cheapest cut overall, as the
// engine charges him.
function checkCut(leaving: PlayerValue, target?: PlayerValue): void {
  const slots = league.roster_positions.filter((s) => s !== "BN" && s !== "IR");
  const targetStarts = !!target && bestLineup([...rail, toRail(target)], slots).starters.some((s) => s.player?.playerId === target.playerId);
  const order = target && !targetStarts && target.position === leaving.position ? legalCuts.filter((p) => p.position === leaving.position) : legalCuts;
  const cheapest = order[0];
  if (!cheapest) { console.error("no legal cut exists"); process.exit(2); }
  const rank = order.findIndex((p) => p.playerId === leaving.playerId);
  if (rank < 0) {
    console.error(`\n${leaving.name} is not a legal cut (a kept starter this week, pending claim's drop, never-drop, or a protected stash).`);
    if (!OVERRIDE) process.exit(2);
    console.error(`override given: ${OVERRIDE}`);
  } else if (rank > 0) {
    console.error(`\n${leaving.name} is cut #${rank + 1}; the cheapest legal cut is ${cheapest.name} (${Math.round(cheapest.points)} ROS vs ${Math.round(leaving.value)}).`);
    if (!OVERRIDE) { console.error("refusing without --override \"<reason>\""); process.exit(2); }
    console.error(`override given: ${OVERRIDE}`);
  } else {
    console.log(`\n${leaving.name} is the cheapest legal cut.`);
  }
}

const cap = league.roster_positions.length;
switch (cmd) {
  case "drop": {
    if (!view.ownedIds.has(target.playerId)) { console.error("not ours"); process.exit(2); }
    checkCut(target);
    if (!WRITE) { console.log("\n(dry) would drop him. Add --write."); break; }
    const r = await dropPlayers(gql, [target.playerId], config.rosterId, config.leagueId, "manual");
    logEvent("coach", "manual-move", `Manual drop of ${target.name}.`, { drop: target.playerId, values: { drop: target }, override: OVERRIDE ?? null, status: r.status });
    console.log(`dropped [${r.status}]`);
    break;
  }
  case "add":
  case "claim": {
    if (taken.has(target.playerId)) { console.error("he is on a roster"); process.exit(2); }
    const full = view.active.length + pending.slotsNeeded >= cap;
    if (full && !drop) { console.error(`roster full (${view.active.length} + ${pending.slotsNeeded} held); name a --drop. Cheapest legal cut: ${legalCuts[0]?.name}`); process.exit(2); }
    if (drop) {
      checkCut(drop, target);
      const gainWk = Math.round(((target.value - drop.value) / target.weeksLeft) * 10) / 10;
      console.log(`swap value: ${target.name} ${target.valueAvg}/wk for ${drop.name} ${drop.valueAvg}/wk = ${gainWk >= 0 ? "+" : ""}${gainWk}/wk`);
      // The stable check (waivers.ts verdict): a target who is not playing
      // now carries a rest-of-season feed built on an assumed return, so the
      // swap must hold on the full-season projection too, by the same bar.
      const seasonWk = Math.round(((target.seasonPoints - drop.seasonPoints) / LAST_WEEK) * 10) / 10;
      // An unlisted drop (season 0) is unknown, not zero: the check fails (waivers.ts lineupDelta).
      const stableFails = notPlaying(target.injuryStatus) && (seasonWk < 1 || drop.seasonPoints <= 0);
      if (notPlaying(target.injuryStatus)) console.log(`stable check: ${target.name} is ${target.injuryStatus}; season ${Math.round(target.seasonPoints)} vs ${Math.round(drop.seasonPoints)} = ${seasonWk >= 0 ? "+" : ""}${seasonWk}/wk over the season`);
      // The week wait (waivers.ts verdict): a swap that lowers this week's
      // lineup by cutting a man who plays for us this week waits for the week.
      const weekPoints = new Map<string, number>();
      for (const p of rail) weekPoints.set(p.name, weekFacts.points(p, weekFacts.teamOf(p.playerId ?? "")));
      weekPoints.set(target.name, weekFacts.points({ playerId: target.playerId, injuryStatus: target.injuryStatus }, target.team, true));
      const weekGain = weekLineupGain({ ...toRail(target), onWaivers: false }, drop.name, { roster: rail, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, weekPoints });
      const playsThisWeek = (weekPoints.get(drop.name) ?? 0) > 0;
      console.log(`this week: lineup ${weekGain >= 0 ? "+" : ""}${weekGain} with the swap${weekFacts.known ? "" : " (no week table: taken as 0)"}${playsThisWeek ? `; ${drop.name} plays this week (${weekPoints.get(drop.name)})` : ""}`);
      if (gainWk < 1 && !OVERRIDE) { console.error("under 1.0 points per week: not a swap worth a drop. --override to insist."); process.exit(2); }
      if (stableFails && !OVERRIDE) { console.error("not playing now and under 1.0 points per week on the season projection: the feed assumes his return, and a cut is for the season. --override to insist."); process.exit(2); }
      // An add only: a claim's drop lands at the clear, after the week for the weekly run, and the engine never holds one.
      if (cmd === "add" && weekGain < 0 && playsThisWeek && !OVERRIDE) { console.error(`lowers this week's lineup while ${drop.name} plays for us: wait for the week, the drop costs it nothing once it is over. --override to insist.`); process.exit(2); }
    }
    if (!WRITE) { console.log(`\n(dry) would ${cmd} him${drop ? ` dropping ${drop.name}` : ""}. Add --write.`); break; }
    let r: { transactionId: string; status: string };
    try {
      r = cmd === "add"
        ? await addFreeAgent(gql, target.playerId, drop?.playerId ?? null, config.rosterId, config.leagueId, "manual")
        : await submitWaiverClaim(gql, target.playerId, drop?.playerId ?? null, config.rosterId, config.leagueId, "manual");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/on waivers/i.test(msg)) { console.error("Sleeper: he is on waivers. Re-run with `claim`."); process.exit(2); }
      throw err;
    }
    logEvent("coach", "manual-move", `Manual ${cmd}: ${target.name}${drop ? `, dropping ${drop.name}` : ""}.`, { cmd, add: target.playerId, drop: drop?.playerId ?? null, values: { add: target, drop }, override: OVERRIDE ?? null, status: r.status, transactionId: r.transactionId });
    console.log(`${cmd} [${r.status}] ${r.transactionId}`);
    break;
  }
  case "activate": {
    if (!view.reserveIds.has(target.playerId)) { console.error("not on our IR"); process.exit(2); }
    const stale = staleReserve(view, league.settings).some((e) => e.playerId === target.playerId);
    console.log(stale ? "he is no longer IR-eligible (must move)" : "he is still IR-eligible");
    // Same rule as the daemon (reserve-reconcile.ts, 2026-10-07): a seat held
    // for a pending no-drop claim is still a seat for him; the claims left
    // without one are cancelled, cheapest first, never traded for a cut.
    const full = view.active.length >= cap;
    const held: HeldClaim[] = pending.claims.filter((c) => c.seats > 0).map((c) => ({
      ...c, value: Math.max(0, ...c.adds.map((id) => values.get(id)?.value ?? 0)), names: c.adds.map((id) => values.get(id)?.name ?? id),
    }));
    const cancel = claimsToCancel(held, full ? 0 : cap - view.active.length - 1);
    if (full) {
      if (!drop) { console.error(`roster full; name a --drop. Cheapest legal cut: ${legalCuts[0]?.name}${legalCuts[0] && target.value < legalCuts[0].points ? ` (he is worth less than that himself: release him instead)` : ""}`); process.exit(2); }
      checkCut(drop);
    } else if (drop) { console.error(`a seat is free (${view.active.length} active${pending.slotsNeeded ? `, ${pending.slotsNeeded} held by pending claims` : ""}); no --drop for an activation`); process.exit(2); }
    for (const c of cancel) console.log(`the pending claim for ${c.names.join(" + ")} (${Math.round(c.value)} ROS) has no seat once he is active: cancelled`);
    if (!WRITE) { console.log(`\n(dry) would ${full ? `drop ${drop!.name} and ` : ""}activate him${cancel.length ? ` and cancel ${cancel.length} claim(s)` : ""}. Add --write.`); break; }
    if (full) await dropPlayers(gql, [drop!.playerId], config.rosterId, config.leagueId, "manual");
    const back = await updateReserve(gql, view.reserve.map((e) => e.playerId).filter((id) => id !== target.playerId));
    logEvent("coach", "manual-move", `Manual activation of ${target.name}${drop ? `, dropping ${drop.name}` : ""}.`, { activate: target.playerId, drop: drop?.playerId ?? null, reserve: back, override: OVERRIDE ?? null, cancel: cancel.map((c) => c.transactionId) });
    console.log(`activated; IR now [${back.join(", ")}]`);
    for (const c of cancel) {
      try {
        const status = await cancelWaiverClaim(gql, c.transactionId, c.leg);
        logEvent("coach", "claim-cancelled", `Waiver claim for ${c.names.join(" + ")} cancelled: no seat once ${target.name} is off injured reserve.`, { transactionId: c.transactionId, leg: c.leg, adds: c.adds, value: c.value, status, player: target.playerId });
        console.log(`cancelled claim ${c.transactionId} [${status}]`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEvent("coach", "claim-cancel-failed", `Could not cancel the waiver claim for ${c.names.join(" + ")}: ${msg}. It has no seat; if it is still pending it fails at processing.`, { transactionId: c.transactionId, leg: c.leg, adds: c.adds, player: target.playerId });
        console.error(`cancel of claim ${c.transactionId} failed: ${msg} (it has no seat and fails at processing on its own)`);
      }
    }
    break;
  }
  case "stash": {
    if (!view.activeIds.has(target.playerId)) { console.error("not on our active roster"); process.exit(2); }
    if (!irEligible(target.injuryStatus, league.settings)) { console.error(`${target.injuryStatus ?? "healthy"} is not IR-eligible in this league`); process.exit(2); }
    if (view.reserve.length >= (league.settings.reserve_slots ?? 0)) { console.error("IR is full"); process.exit(2); }
    if (!WRITE) { console.log("\n(dry) would move him to IR. Add --write."); break; }
    const back = await updateReserve(gql, [...view.reserve.map((e) => e.playerId), target.playerId]);
    logEvent("coach", "manual-move", `Manual IR stash of ${target.name}.`, { stash: target.playerId, reserve: back });
    console.log(`stashed; IR now [${back.join(", ")}]`);
    break;
  }
  default:
    console.error(`unknown command ${cmd}`); process.exit(2);
}
