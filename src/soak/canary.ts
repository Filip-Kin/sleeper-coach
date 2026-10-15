// The boot canary. A fresh container starts FROZEN (entrypoint.sh writes
// `boot-canary <sha>` into the kill-switch file before it execs the daemon) and
// the daemon lifts that freeze only when every read-only check here passes.
// A deploy that cannot read its own token, its own roster or a scored week
// stays frozen and alerts, instead of acting on data it cannot see. The
// 2026-09-09 deploy blanked every score on the dashboard for a day and nothing
// noticed; the 2026-09-19 one dropped three receivers in four minutes off a
// roster read that could not tell IR from active.
//
// A human freeze always wins: entrypoint leaves a FREEZE with other content
// alone, and releaseCanaryFreeze removes the file only while it still starts
// with `boot-canary`. Filip touching the file mid-canary is respected.
//
// Pure verdict (canaryVerdict) over observations, so the decision has a table
// of tests; bootCanary gathers the observations with live reads and nothing
// else. Nothing in this file writes to Sleeper.

import { existsSync, readFileSync, unlinkSync, accessSync, constants, openSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { config, isStagingTarget, REAL_LEAGUE_ID } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { leagueRosters, weekSchedule } from "../sleeper/graphql.ts";
import { buildRosterView, RosterSourceError } from "../analysis/roster-view.ts";
import { rosterLegal, staleReserve, type Legality } from "../sleeper/rules.ts";
import { forcedCutNotBefore, fmtZoned } from "../act/reserve-hold.ts";
import { currentReserveIntents } from "../act/reserve-reconcile.ts";
import { MAX_AGE_MS as INTENT_MAX_AGE_MS } from "../act/drop-intent.ts";
import { activeCapacity } from "../analysis/roster-fit.ts";
import { probeToken } from "../league/api.ts";
import { assessToken, type TokenProbe } from "../league/token.ts";
import { JOBS, lateDeadline, lastOccurrence, type Job } from "../schedule.ts";
import { ACTIVITY_LOG, DB_PATH, FREEZE_FILE, KICKOFF_CACHE } from "../paths.ts";
import { logEvent } from "../log.ts";

/** The git SHA baked into the image (Dockerfile ARG COACH_SHA, which Coolify
 *  fills from SOURCE_COMMIT). "unknown" outside a built image. */
const shaEnv = [process.env.COACH_SHA, process.env.SOURCE_COMMIT].map((s) => (s ?? "").trim()).find((s) => s && s !== "unknown");
export const COACH_SHA = shaEnv ?? "unknown";
export const CANARY_MARK = "boot-canary";
export function canaryFreezeContent(sha = COACH_SHA): string {
  return `${CANARY_MARK} ${sha}\n`;
}
export function isCanaryFreeze(content: string): boolean {
  return content.trimStart().startsWith(CANARY_MARK);
}

export interface CanaryObservations {
  token: TokenProbe;
  /** league_id the API answered with, or null when the read failed. */
  leagueId: string | null;
  expectedLeagueId: string;
  /** True in production: the league must be THE league. */
  requireReal: boolean;
  rosterHasPlayerMap: boolean;
  legality: Legality | null;
  /** Sum of every roster's points for the week that should be scored, or
   *  null when no week qualifies (preseason, week 1 before kickoff). */
  matchupPoints: number | null;
  matchupWeek: number | null;
  /** job -> last_run, or null when the table could not be read. */
  scheduledRuns: Record<string, number> | null;
  activityAppendable: boolean;
  haConfigured: boolean;
  now: number;
  jobs?: Job[];
  /** This week's kickoff instants from the public scores feed, the list the
   *  daemon's due check reads (daemon.ts kickoffsForSchedule), for the
   *  jittered jobs' windows (schedule.ts jitterWindow). The pick'em cache is
   *  not used here: it is refreshed once a day (pickem-slate, 09:00), so a
   *  game postponed since then would give the canary a shorter window than
   *  the daemon's and a false "overdue" that holds the boot freeze. An
   *  unreadable feed reads as the full window, which can only delay this
   *  check, never fail it wrongly. */
  kickoffs?: number[];
  /** Stale IR men whose forced cut the coach holds for their final injury
   *  report (act/reserve-hold.ts, 2026-10-14), with the hold's end. A deploy
   *  during such a hold must not freeze on the stale IR: the reconciler
   *  cannot cut while frozen, and the canary re-checks every poll, so the
   *  two would hold each other until the man's tag changed. Held is a chosen
   *  state; past `until` it is the fault it was. Also a stale man whose
   *  activation is recorded for its confirming look (reserve-reconcile.ts
   *  currentReserveIntents, 2026-10-15): the intent lives on disk across
   *  the boot, and a freeze would stop the look that writes it. `why`
   *  names that case; absent, it is the report hold. */
  staleHeld?: { name: string; until: number; why?: string }[];
}

export interface CanaryVerdict {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

// #region pure
export function canaryVerdict(o: CanaryObservations): CanaryVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const jobs = o.jobs ?? JOBS;

  const t = assessToken(o.token, o.now);
  if (!t.usable) failures.push(`token: ${t.summary}`);

  if (o.leagueId === null) failures.push("league: read failed");
  else if (o.leagueId !== o.expectedLeagueId) failures.push(`league: API returned ${o.leagueId}, expected ${o.expectedLeagueId}`);
  else if (o.requireReal && o.leagueId !== REAL_LEAGUE_ID) failures.push(`league: ${o.leagueId} is not the real league ${REAL_LEAGUE_ID}`);

  if (!o.rosterHasPlayerMap) failures.push("roster: no player_map (REST source; IR cannot be told from active)");
  else if (o.legality === null) failures.push("roster: read failed");
  else if (!o.legality.ok) {
    const held = (o.staleHeld ?? []).filter((h) => h.until > o.now);
    const unheld = o.legality.staleIr.filter((n) => !held.some((h) => h.name === n));
    const bits: string[] = [];
    if (o.legality.overBy) bits.push(`${o.legality.overBy} over cap`);
    if (unheld.length) bits.push(`stale IR: ${unheld.join(", ")}`);
    if (o.legality.reserveNotOwned.length) bits.push(`reserve not owned: ${o.legality.reserveNotOwned.join(", ")}`);
    if (bits.length) failures.push(`roster: ${bits.join("; ")}`);
    for (const h of held) if (o.legality.staleIr.includes(h.name)) warnings.push(`roster: ${h.name} stale on IR, ${h.why ?? `cut held for his final injury report until ${fmtZoned(h.until)}`}`);
  }

  if (o.matchupWeek !== null) {
    if (o.matchupPoints === null) failures.push(`matchups: week ${o.matchupWeek} read failed`);
    else if (o.matchupPoints <= 0) failures.push(`matchups: week ${o.matchupWeek} scores sum to 0 (the dashboard-zeros failure)`);
  }

  if (o.scheduledRuns === null) failures.push("scheduled_runs: unreadable");
  else {
    const late: string[] = [];
    for (const job of jobs) {
      const occ = lastOccurrence(job, o.now);
      if (occ === null) continue;
      if (o.now <= lateDeadline(job, occ, o.kickoffs ?? [])) continue;
      if ((o.scheduledRuns[job.name] ?? 0) < occ) late.push(job.name);
    }
    if (late.length) failures.push(`schedule: overdue and never marked: ${late.join(", ")}`);
  }

  if (!o.activityAppendable) failures.push(`activity log: not appendable`);
  if (!o.haConfigured) warnings.push("HA_NOTIFY_URL unset: alerts will only log");

  return { ok: failures.length === 0, failures, warnings };
}

/** Which week's matchups must carry points. The current week once any cached
 *  kickoff of it has passed; otherwise the previous week, which is always
 *  fully scored; null before week 1 has kicked off or outside the regular
 *  season. */
export function weekToScore(state: { week: number; season_type: string }, cache: { week?: number; games?: { startTime?: number }[] } | null, now: number): number | null {
  if (state.season_type !== "regular") return null;
  const week = Math.max(0, state.week | 0);
  const kicked = cache?.week === week && (cache.games ?? []).some((g) => typeof g.startTime === "number" && g.startTime <= now);
  if (kicked && week >= 1) return week;
  return week - 1 >= 1 ? week - 1 : null;
}

export function sumMatchupPoints(rows: unknown[]): number {
  let s = 0;
  for (const r of rows) {
    const p = (r as { points?: unknown }).points;
    if (typeof p === "number" && Number.isFinite(p)) s += p;
  }
  return s;
}
// #endregion

// #region observations (IO)
async function readScheduledRuns(): Promise<Record<string, number> | null> {
  try {
    if (!existsSync(DB_PATH)) return {}; // first boot: nothing has run, nothing is overdue
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const has = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_runs'").get();
      if (!has?.n) return {};
      const out: Record<string, number> = {};
      for (const r of db.query<{ job: string; last_run: number }, []>("SELECT job, last_run FROM scheduled_runs").all()) out[r.job] = r.last_run;
      return out;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function activityAppendable(): boolean {
  try {
    mkdirSync(dirname(ACTIVITY_LOG), { recursive: true });
    if (existsSync(ACTIVITY_LOG)) {
      accessSync(ACTIVITY_LOG, constants.W_OK);
    } else {
      // Create-and-close: an empty log is the correct state on a fresh volume.
      closeSync(openSync(ACTIVITY_LOG, "a"));
    }
    return true;
  } catch {
    return false;
  }
}

async function readKickoffCache(): Promise<{ week?: number; games?: { startTime?: number }[] } | null> {
  try {
    const f = Bun.file(KICKOFF_CACHE);
    if (!(await f.exists())) return null;
    return (await f.json()) as { week?: number; games?: { startTime?: number }[] };
  } catch {
    return null;
  }
}

export async function observe(now = Date.now()): Promise<CanaryObservations> {
  const token = await probeToken();
  let leagueId: string | null = null;
  let rosterPositions: string[] = [];
  let settings: Parameters<typeof rosterLegal>[2] | null = null;
  try {
    const league = await sleeper.league(config.leagueId);
    leagueId = league.league_id;
    rosterPositions = league.roster_positions;
    settings = league.settings;
  } catch (err) {
    console.error(`[canary] league read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let rosterHasPlayerMap = false;
  let legality: Legality | null = null;
  let staleMen: { playerId: string; name: string; team: string | null }[] = [];
  try {
    const mine = (await leagueRosters(config.leagueId)).find((r) => r.roster_id === config.rosterId);
    if (mine) {
      rosterHasPlayerMap = !!mine.player_map;
      if (rosterHasPlayerMap && settings) {
        const view = buildRosterView(mine);
        legality = rosterLegal(view, activeCapacity(rosterPositions), settings);
        staleMen = staleReserve(view, settings).map((e) => ({ playerId: e.playerId, name: e.name, team: e.team }));
      }
    }
  } catch (err) {
    if (!(err instanceof RosterSourceError)) console.error(`[canary] roster read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let matchupWeek: number | null = null;
  let matchupPoints: number | null = null;
  const kickoffCache = await readKickoffCache();
  let kickoffs: number[] = [];
  const staleHeld: { name: string; until: number; why?: string }[] = [];
  // The reconciler's recorded activation of a stale man, waiting for its
  // second look (on disk, so it survives this boot).
  for (const i of currentReserveIntents(now)) {
    const m = staleMen.find((x) => x.playerId === i.playerId);
    if (m) staleHeld.push({ name: m.name, until: i.firstSeen + INTENT_MAX_AGE_MS, why: `his activation recorded ${fmtZoned(i.firstSeen)} and confirming on a second look` });
  }
  try {
    const state = await sleeper.nflState();
    if (state.season_type === "regular" && state.week > 0) {
      try {
        const slate = await weekSchedule(state.season, state.week);
        kickoffs = slate.map((g) => g.startTime);
        // The reconciler's hold on a stale IR man's cut (reserve-hold.ts).
        for (const m of staleMen) {
          const h = forcedCutNotBefore(m.team, slate);
          if (h) staleHeld.push({ name: m.name, until: h.until });
        }
      } catch (err) {
        console.error(`[canary] week ${state.week} kickoffs unreadable (${err instanceof Error ? err.message : String(err)}); the schedule check reads the full window`);
      }
    }
    matchupWeek = weekToScore(state, kickoffCache, now);
    if (matchupWeek !== null) matchupPoints = sumMatchupPoints(await sleeper.matchups(config.leagueId, matchupWeek));
  } catch (err) {
    console.error(`[canary] matchup read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    token, leagueId, expectedLeagueId: config.leagueId, requireReal: !isStagingTarget,
    rosterHasPlayerMap, legality, matchupPoints, matchupWeek,
    scheduledRuns: await readScheduledRuns(),
    activityAppendable: activityAppendable(),
    haConfigured: !!process.env.HA_NOTIFY_URL && !!process.env.HA_TOKEN,
    now, kickoffs, staleHeld,
  };
}
// #endregion

/** The daemon's boot check. Read-only. Logs what it found; the caller decides
 *  what to do with the freeze (see releaseCanaryFreeze). */
export async function bootCanary(): Promise<{ ok: boolean; failures: string[] }> {
  const v = canaryVerdict(await observe());
  for (const w of v.warnings) console.log(`[canary] warn: ${w}`);
  if (v.ok) {
    console.log(`[canary] pass (sha ${COACH_SHA})`);
  } else {
    for (const f of v.failures) console.error(`[canary] FAIL ${f}`);
  }
  return { ok: v.ok, failures: v.failures };
}

/** Remove the kill-switch file if, and only if, it is the boot canary's own.
 *  Returns what happened so the daemon can log it. */
export function releaseCanaryFreeze(file = FREEZE_FILE): "released" | "human-freeze" | "absent" {
  if (!existsSync(file)) return "absent";
  let content = "";
  try { content = readFileSync(file, "utf8"); } catch { return "human-freeze"; }
  if (!isCanaryFreeze(content)) return "human-freeze";
  unlinkSync(file);
  return "released";
}

/** Is the current freeze the canary's (as opposed to a human's or an
 *  auto-freeze)? */
export function canaryFreezeActive(file = FREEZE_FILE): boolean {
  try { return existsSync(file) && isCanaryFreeze(readFileSync(file, "utf8")); } catch { return false; }
}

/** One `deploy` activity event per boot, carrying the baked SHA so the
 *  dashboard and the runbook agree on what is running. */
export function logDeploy(): void {
  logEvent("system", "deploy", `Daemon booted at ${COACH_SHA}.`, { sha: COACH_SHA, leagueId: config.leagueId, staging: isStagingTarget });
}
