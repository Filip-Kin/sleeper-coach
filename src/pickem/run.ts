#!/usr/bin/env bun
// Plays the pick'em pool. Fetches the week's lines, decides every game, and
// submits. Safe to run as often as we like: it is idempotent (it only writes a
// pick that differs from what is already stored) and it never touches a game
// that has locked or started.
//
//   bun run pickem                 decide + submit the current leg (live)
//   bun run pickem --dry           decide and print, write nothing
//   bun run pickem --week 3        target a specific week's leg
//
// Deliberately run MANY times per week rather than once. The graded line is
// frozen but the market line keeps moving, so the gap we trade on is widest
// close to kickoff, and games in this pool kick off Wednesday through Monday
// with per-game locks rather than one weekly deadline.

import { config } from "../config.ts";
import { logEvent } from "../log.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import {
  browserGql, fetchWeek, fetchMyLegs, fetchLeaguePicks, submitPick, setTiebreaker,
  currentLegId, type PickemGame, type Gql,
} from "./client.ts";
import {
  decideSlate, isPickable, bestTiebreaker, fieldMode, applyFieldMode, safePick, inFinalWindow,
  FINAL_WINDOW_HOURS, type Decision,
} from "./strategy.ts";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const weekArg = args.indexOf("--week");
const forcedWeek = weekArg >= 0 ? Number(args[weekArg + 1]) : null;

function legWeek(legId: string): number {
  const m = /:(\d+)$/.exec(legId);
  return m ? Number(m[1]) : 0;
}

/** The tiebreaker game is the one Sleeper designates per leg. Every rival's
 *  entry in week 1 pointed at the same game (the Monday night finale), so read
 *  it off the league rather than guessing; fall back to the last kickoff. */
function tiebreakerGame(games: PickemGame[], rivalGameIds: string[]): PickemGame | null {
  const byId = new Map(games.map((g) => [g.gameId, g]));
  for (const id of rivalGameIds) {
    const g = byId.get(id);
    if (g) return g;
  }
  return games.slice().sort((a, b) => b.startTime - a.startTime)[0] ?? null;
}

async function main(): Promise<void> {
  const gql: Gql = browserGql();
  const leagueId = config.pickemLeagueId;
  const rosterId = config.pickemRosterId;

  const legId = forcedWeek ? `v1:regular:${forcedWeek}` : await currentLegId(leagueId);
  const week = legWeek(legId);
  if (!week) throw new Error(`cannot read a week out of leg ${legId}`);

  const [games, myLegs, leaguePicks] = await Promise.all([
    fetchWeek(gql, week),
    fetchMyLegs(gql, leagueId, rosterId),
    fetchLeaguePicks(gql, leagueId, legId),
  ]);

  const mine = myLegs.find((l) => l.legId === legId) ?? { legId, status: "?", picks: {}, tiebreaker: null };
  const now = Date.now();

  // Where we stand. Rivals' picks for finished games are graded by Sleeper, so
  // the running score comes straight off their own outcomes.
  const scoreOf = (picks: Record<string, { outcome: string | null }>) =>
    Object.values(picks).filter((p) => p.outcome === "win").length;
  const rivalIds = Object.keys(leaguePicks).map(Number).filter((r) => r !== rosterId);
  const ourScore = scoreOf(mine.picks);
  const bestRival = Math.max(0, ...rivalIds.map((r) => scoreOf(leaguePicks[r]?.picks ?? {})));

  const pickable = games.filter((g) => isPickable(g, now));
  const mode = fieldMode(ourScore - bestRival, pickable.length);

  let decisions: Decision[] = decideSlate(pickable);
  if (mode !== "accuracy") {
    const byId = new Map(pickable.map((g) => [g.gameId, g]));
    decisions = decisions.map((d) => {
      const g = byId.get(d.gameId);
      if (!g) return d;
      const rivalPicks = rivalIds
        .map((r) => leaguePicks[r]?.picks?.[d.gameId]?.team)
        .filter((t): t is string => Boolean(t));
      return applyFieldMode(d, g, mode, rivalPicks);
    });
  }

  console.log(`[pickem] leg ${legId} (week ${week}), status ${mine.status}, mode ${mode}`);
  console.log(`[pickem] ${games.length} games, ${pickable.length} still pickable, we hold ${Object.keys(mine.picks).length} picks`);
  console.log(`[pickem] score: us ${ourScore}, best rival ${bestRival}`);

  // TWO-STAGE SUBMISSION. Rivals can read our picks through the same endpoint we
  // read theirs, so anything submitted days early is copyable. Far from kickoff
  // we therefore only fill BLANK games, and only with the favourite, which leaks
  // nothing because it is what everyone picks anyway. The picks that carry our
  // actual edge go in inside the final window, too late to be copied, and we
  // never sit blank in between.
  const frozen = freezeState();
  const byId = new Map(games.map((g) => [g.gameId, g]));
  const writes: { gameId: string; team: string; was: string | null; reason: string }[] = [];
  for (const d of decisions) {
    const g = byId.get(d.gameId)!;
    const held = mine.picks[d.gameId]?.team ?? null;
    const label = `${g.away}@${g.home}`;
    const final = inFinalWindow(g, now);
    const hrs = ((g.startTime - now) / 3_600_000).toFixed(1);

    if (!final) {
      // Provisional stage: hold the line, only cover a blank.
      if (held) {
        console.log(`  = ${label.padEnd(11)} ${held.padEnd(4)} holding, ${hrs}h out (final pick at T-${FINAL_WINDOW_HOURS}h)`);
        continue;
      }
      const safe = safePick(g);
      if (!safe) continue;
      console.log(`  + ${label.padEnd(11)} ${safe.team.padEnd(4)} ${safe.reason}, ${hrs}h out`);
      writes.push({ gameId: d.gameId, team: safe.team, was: null, reason: safe.reason });
      continue;
    }

    const edge = d.edge > 0 ? ` EDGE ${d.edge.toFixed(1)}pt` : "";
    if (held === d.team) {
      console.log(`  = ${label.padEnd(11)} ${d.team.padEnd(4)} already final${edge}`);
      continue;
    }
    console.log(`  ${held ? "~" : "+"} ${label.padEnd(11)} ${d.team.padEnd(4)}${edge}  ${d.reason}`);
    writes.push({ gameId: d.gameId, team: d.team, was: held, reason: d.reason });
  }

  // Tiebreaker: everyone's guess is visible, so this is a positioning problem.
  // Safe to set early — it reveals nothing about our picks, and being closest is
  // decided by where the rivals sat, which is already fixed.
  const rivalTbs = rivalIds.map((r) => leaguePicks[r]?.tiebreaker).filter((t) => t);
  const tbGame = tiebreakerGame(games, rivalTbs.map((t) => t!.gameId));
  const wantTb = bestTiebreaker(rivalTbs.map((t) => t!.value));
  const tbNeedsWrite = tbGame !== null && mine.tiebreaker?.value !== wantTb;
  if (tbGame) {
    console.log(`[pickem] tiebreaker ${tbGame.away}@${tbGame.home}: want ${wantTb}` +
      ` (held ${mine.tiebreaker?.value ?? "none"}; rivals ${rivalTbs.map((t) => t!.value).join(", ") || "none"})`);
  }

  if (DRY) {
    console.log(`[pickem] --dry: would write ${writes.length} picks${tbNeedsWrite ? " + tiebreaker" : ""}`);
    return;
  }
  if (frozen.frozen) {
    console.log(`[pickem] FROZEN (${frozen.reason ?? "no reason given"}) — no writes`);
    logEvent("coach", "pickem-frozen", `pick'em skipped: frozen`, { legId, wanted: writes.length });
    return;
  }
  if (!writes.length && !tbNeedsWrite) {
    console.log("[pickem] nothing to change");
    return;
  }

  assertWritesAllowed("pickem submit");
  let ok = 0;
  for (const w of writes) {
    try {
      const leg = await submitPick(gql, leagueId, rosterId, legId, w.gameId, w.team);
      // Read-back verification: the mutation returns the whole leg, so a silent
      // no-op is detectable rather than assumed successful.
      if (leg.picks[w.gameId]?.team !== w.team) throw new Error(`read-back shows ${leg.picks[w.gameId]?.team ?? "nothing"}`);
      ok++;
    } catch (e) {
      console.log(`  !! ${w.gameId} ${w.team} FAILED: ${(e as Error).message}`);
      logEvent("coach", "pickem-error", `pick'em write failed for ${w.gameId}`, { team: w.team, error: String(e) });
    }
  }
  if (tbNeedsWrite && tbGame) {
    try {
      const leg = await setTiebreaker(gql, leagueId, rosterId, legId, tbGame.gameId, wantTb);
      if (leg.tiebreaker?.value !== wantTb) throw new Error(`read-back shows ${leg.tiebreaker?.value ?? "nothing"}`);
    } catch (e) {
      console.log(`  !! tiebreaker FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`[pickem] wrote ${ok}/${writes.length} picks`);
  logEvent("coach", "pickem-picks", `week ${week}: set ${ok} pick${ok === 1 ? "" : "s"} (mode ${mode})`, {
    legId, week, mode, ourScore, bestRival,
    picks: writes.map((w) => ({ game: w.gameId, team: w.team, was: w.was, why: w.reason })),
    tiebreaker: tbNeedsWrite ? wantTb : undefined,
  });
}

main().catch((e) => {
  console.error(`[pickem] ${(e as Error).message}`);
  logEvent("coach", "pickem-error", `pick'em run failed`, { error: String(e) });
  process.exit(1);
});
