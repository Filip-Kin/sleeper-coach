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
import { tokenGql, myRosterView, addFreeAgent, submitWaiverClaim, dropPlayers, updateReserve, currentStarters } from "../league/api.ts";
import { loadValues, liveStatusFromRosters, toRail, cutOrder, type PlayerValue } from "../analysis/value.ts";
import { canDrop, DEFAULT_RAILS } from "../analysis/rails.ts";
import { irEligible, staleReserve } from "../sleeper/rules.ts";
import { logEvent } from "../log.ts";
import { recordDrop } from "../league/drop-ledger.ts";
import { pendingClaimPlayers } from "./pending-claims.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const WRITE = args.includes("--write");
const opt = (k: string): string | undefined => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const OVERRIDE = opt("override");
const name = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]?.startsWith("--")) ).join(" ").trim();
const dropName = opt("drop");

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
const pending = await pendingClaimPlayers(gql, week).catch(() => ({ adds: [], drops: [], slotsNeeded: 0 }));
const taken = new Set(rosters.flatMap((r) => r.players ?? []));

const byName = (n: string): PlayerValue | undefined => {
  const q = n.toLowerCase();
  return [...values.values()].find((v) => v.name.toLowerCase() === q) ?? [...values.values()].find((v) => v.name.toLowerCase().includes(q));
};
const fmt = (v: PlayerValue | undefined, id: string): string => v
  ? `${v.name.padEnd(24)} ${v.position.padEnd(3)} ${String(v.valueAvg).padStart(5)}/wk  ROS ${String(Math.round(v.value)).padStart(4)}  season ${String(Math.round(v.seasonPoints)).padStart(4)} (${v.position}${v.seasonRank})  ${v.injuryStatus ?? "healthy"}${v.stash ? "  STASH" : ""}`
  : `${id.padEnd(24)} (no value)`;

// The picture, live.
const rail = view.active.map((e) => { const v = values.get(e.playerId); return v ? toRail(v) : { playerId: e.playerId, name: e.name, position: e.position, points: 0 }; });
const pendingDrops: string[] = pending.drops;
const legalCuts = cutOrder(rail.filter((p) => !starters.has(p.playerId!) && !pendingDrops.includes(p.playerId!) && canDrop(p.name, rail, { ...DEFAULT_RAILS, protectTopN: 0 }).allowed));
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
function checkCut(leaving: PlayerValue): void {
  const cheapest = legalCuts[0];
  if (!cheapest) { console.error("no legal cut exists"); process.exit(2); }
  const rank = legalCuts.findIndex((p) => p.playerId === leaving.playerId);
  if (rank < 0) {
    console.error(`\n${leaving.name} is not a legal cut (starter this week, pending claim's drop, never-drop, or a protected stash).`);
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
    recordDrop(target.name, "manual");
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
      checkCut(drop);
      const gainWk = Math.round(((target.value - drop.value) / target.weeksLeft) * 10) / 10;
      console.log(`swap value: ${target.name} ${target.valueAvg}/wk for ${drop.name} ${drop.valueAvg}/wk = ${gainWk >= 0 ? "+" : ""}${gainWk}/wk`);
      if (gainWk < 1 && !OVERRIDE) { console.error("under 1.0 points per week: not a swap worth a drop. --override to insist."); process.exit(2); }
    }
    if (!WRITE) { console.log(`\n(dry) would ${cmd} him${drop ? ` dropping ${drop.name}` : ""}. Add --write.`); break; }
    let r: { transactionId: string; status: string };
    try {
      r = cmd === "add"
        ? await addFreeAgent(gql, target.playerId, drop?.playerId ?? null)
        : await submitWaiverClaim(gql, target.playerId, drop?.playerId ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/on waivers/i.test(msg)) { console.error("Sleeper: he is on waivers. Re-run with `claim`."); process.exit(2); }
      throw err;
    }
    if (drop) recordDrop(drop.name, "manual");
    logEvent("coach", "manual-move", `Manual ${cmd}: ${target.name}${drop ? `, dropping ${drop.name}` : ""}.`, { cmd, add: target.playerId, drop: drop?.playerId ?? null, values: { add: target, drop }, override: OVERRIDE ?? null, status: r.status, transactionId: r.transactionId });
    console.log(`${cmd} [${r.status}] ${r.transactionId}`);
    break;
  }
  case "activate": {
    if (!view.reserveIds.has(target.playerId)) { console.error("not on our IR"); process.exit(2); }
    const stale = staleReserve(view, league.settings).some((e) => e.playerId === target.playerId);
    console.log(stale ? "he is no longer IR-eligible (must move)" : "he is still IR-eligible");
    const full = view.active.length + pending.slotsNeeded >= cap;
    if (full) {
      if (!drop) { console.error(`roster full; name a --drop. Cheapest legal cut: ${legalCuts[0]?.name}${legalCuts[0] && target.value < legalCuts[0].points ? ` (he is worth less than that himself: release him instead)` : ""}`); process.exit(2); }
      checkCut(drop);
    }
    if (!WRITE) { console.log(`\n(dry) would ${full ? `drop ${drop!.name} and ` : ""}activate him. Add --write.`); break; }
    if (full) { await dropPlayers(gql, [drop!.playerId], config.rosterId, config.leagueId, "manual"); recordDrop(drop!.name, "manual"); }
    const back = await updateReserve(gql, view.reserve.map((e) => e.playerId).filter((id) => id !== target.playerId));
    logEvent("coach", "manual-move", `Manual activation of ${target.name}${drop ? `, dropping ${drop.name}` : ""}.`, { activate: target.playerId, drop: drop?.playerId ?? null, reserve: back, override: OVERRIDE ?? null });
    console.log(`activated; IR now [${back.join(", ")}]`);
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
