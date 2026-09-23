// Standing invariants: the things that must be true of the coach's world at
// every poll, checked from LIVE reads and independent of whichever code path
// last wrote. Every rail elsewhere guards one write; this is the net under all
// of them. Each one is a fact the 2026-09 incidents violated without any
// single write looking wrong at the time:
//
//   roster-legal        over the cap, or a stale IR (a Questionable man still
//                       on reserve invalidates every lineup write)
//   starter-on-reserve  an IR player in the starters array
//   empty-slot          a "0" starter while an eligible man sits on the bench
//   token               the session JWT inside its 14-day warning window
//   proposals           a trade_proposals row we think is open that Sleeper
//                       no longer has (a phantom that blocks the offer cap)
//   claim-slots         more pending claims than open roster slots
//   schedule            a job whose occurrence is past its late window and was
//                       never marked, which means the loop was not running
//   drops               more automatic drops in 24 h than the daily limit
//   alert-storm         more than ten alerts in an hour
//
// Pure core (evaluateInvariants) over plain inputs, so every branch has a
// fixture test; a thin wrapper (runInvariants) that dedupes the push to one per
// invariant per 24 h through the invariant_alerts table and freezes the coach
// when an invariant says so. The freeze is the point: a coach that is provably
// in a bad state must stop acting before it acts again.

import type { Database } from "bun:sqlite";
import type { League, NflState, Roster } from "./sleeper/types.ts";
import { buildRosterView, type RosterView } from "./analysis/roster-view.ts";
import { rosterLegal } from "./sleeper/rules.ts";
import { sleeper } from "./sleeper/client.ts";
import { leagueRosters } from "./sleeper/graphql.ts";
import { config } from "./config.ts";
import { probeToken, pendingClaimSlots, outstandingOffers, type Gql } from "./league/api.ts";
import { dropHistory } from "./league/drop-ledger.ts";
import { alertsLastHour } from "./alert.ts";
import { activeCapacity } from "./analysis/roster-fit.ts";
import { SLOT_ELIGIBILITY, startingSlots } from "./analysis/lineup.ts";
import { assessToken, type TokenProbe } from "./league/token.ts";
import { JOBS, jitterFor, lastOccurrence, type Job } from "./schedule.ts";
import { DAILY_LIMIT, type DropRecord } from "./analysis/drop-guard.ts";
import { freezeState, freezeNow } from "./killswitch.ts";
import { sendAlert } from "./alert.ts";
import { logEvent } from "./log.ts";

export type InvariantAction = "alert" | "freeze";
export interface InvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
  action: InvariantAction;
}
export interface InvariantResult {
  ok: boolean;
  checks: InvariantCheck[];
  /** Names that produced a push this run (after the 24 h dedupe). */
  alerted: string[];
  /** Names that froze the coach this run. */
  frozen: string[];
}

/** A trade_proposals row as the daemon reads it. `status` is what WE last
 *  recorded for the offer; only rows explicitly marked "proposed" are checked
 *  against Sleeper, so a table without a status column checks nothing rather
 *  than paging about every rejected offer of the last three weeks. */
export interface ProposalRow {
  transactionId: string | null;
  status?: string | null;
  at: number;
}

export interface InvariantInput {
  /** coach.db, for the invariant_alerts dedupe table. The pure core ignores it. */
  db: Database;
  league: League;
  /** Every roster in the league, from the live GraphQL read. */
  rosters: Roster[];
  state: NflState;
  /** Our roster, built from the same live read. */
  view: RosterView;
  token: TokenProbe;
  pendingClaims: { count: number; adds: string[] };
  /** Our offers Sleeper still lists as proposed. */
  outstandingOffers: { transactionId: string }[];
  proposalsDb: ProposalRow[];
  /** job name -> last_run occurrence, from scheduled_runs. */
  scheduledRuns: Record<string, number>;
  dropHistory: DropRecord[];
  alertsLastHour: number;
  now?: number;
  jobs?: Job[];
}

export const ALERT_STORM_LIMIT = 10;
export const DEDUPE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// #region pure
export function evaluateInvariants(input: InvariantInput): InvariantCheck[] {
  const now = input.now ?? Date.now();
  const jobs = input.jobs ?? JOBS;
  const out: InvariantCheck[] = [];
  const capacity = activeCapacity(input.league.roster_positions);
  const ours = input.rosters.find((r) => r.roster_id === input.view.rosterId) ?? null;
  const starters = (ours?.starters ?? []).map(String);
  const starterSet = new Set(starters.filter((s) => s !== "0"));

  // roster-legal
  {
    const l = rosterLegal(input.view, capacity, input.league.settings);
    const bits: string[] = [];
    if (l.overBy) bits.push(`${l.overBy} over the ${capacity}-man cap`);
    if (l.staleIr.length) bits.push(`no longer IR-eligible: ${l.staleIr.join(", ")}`);
    if (l.reserveNotOwned.length) bits.push(`on reserve but not owned: ${l.reserveNotOwned.join(", ")}`);
    out.push({ name: "roster-legal", ok: l.ok, action: "alert", detail: l.ok ? `${input.view.active.length}/${capacity} active, IR clean` : bits.join("; ") });
  }

  // starter-on-reserve
  {
    const bad = starters.filter((s) => input.view.reserveIds.has(s));
    out.push({
      name: "starter-on-reserve", ok: bad.length === 0, action: "alert",
      detail: bad.length ? `starting from IR: ${bad.map((id) => nameOf(input.view, id)).join(", ")}` : "no IR player in the starters",
    });
  }

  // empty-slot: a "0" with an eligible active bench player
  {
    const slots = startingSlots(input.league.roster_positions);
    const bench = input.view.active.filter((e) => !starterSet.has(e.playerId));
    const holes: string[] = [];
    if (ours) {
      slots.forEach((slot, i) => {
        const cur = starters[i] ?? "0";
        if (cur !== "0") return;
        const elig = SLOT_ELIGIBILITY[slot];
        const fit = bench.filter((e) => elig?.has(e.position));
        if (fit.length) holes.push(`${slot} empty with ${fit.map((e) => e.name).join("/")} on the bench`);
      });
    }
    out.push({
      name: "empty-slot", ok: holes.length === 0, action: "alert",
      detail: holes.length ? holes.join("; ") : ours ? "every slot that can be filled is filled" : "our roster not in the live read",
    });
  }

  // token
  {
    const v = assessToken(input.token, now);
    const ok = v.inconclusive || (v.usable && v.alert === null);
    out.push({ name: "token", ok, action: "alert", detail: v.summary });
  }

  // proposals: rows we mark proposed must still be on Sleeper
  {
    const open = new Set(input.outstandingOffers.map((o) => o.transactionId));
    const ghosts = input.proposalsDb
      .filter((p) => (p.status === "proposed" || p.status === "open") && p.transactionId && !open.has(p.transactionId))
      .map((p) => p.transactionId as string);
    out.push({
      name: "proposals", ok: ghosts.length === 0, action: "alert",
      detail: ghosts.length ? `recorded as proposed but not on Sleeper: ${ghosts.join(", ")}` : `${open.size} open offer(s) match the ledger`,
    });
  }

  // claim-slots
  {
    const openSlots = Math.max(0, capacity - input.view.active.length);
    const ok = input.pendingClaims.count <= openSlots;
    out.push({
      name: "claim-slots", ok, action: "alert",
      detail: ok
        ? `${input.pendingClaims.count} pending claim(s), ${openSlots} open slot(s)`
        : `${input.pendingClaims.count} pending claim(s) need slots but only ${openSlots} open (${input.pendingClaims.adds.join(", ")})`,
    });
  }

  // schedule
  {
    const late: string[] = [];
    for (const job of jobs) {
      const occ = lastOccurrence(job, now);
      if (occ === null) continue;
      const window = occ + jitterFor(job, occ) + job.maxLateMs;
      if (now <= window) continue; // still inside its useful window; the loop may yet run it
      if ((input.scheduledRuns[job.name] ?? 0) < occ) late.push(`${job.name} (${Math.round((now - occ) / 3_600_000)} h ago)`);
    }
    out.push({
      name: "schedule", ok: late.length === 0, action: "alert",
      detail: late.length ? `never marked: ${late.join(", ")}` : `${jobs.length} job(s) current`,
    });
  }

  // drops
  {
    const today = input.dropHistory.filter((d) => now - d.at < DAY_MS);
    const ok = today.length <= DAILY_LIMIT;
    out.push({
      name: "drops", ok, action: "freeze",
      detail: ok ? `${today.length} automatic drop(s) in 24 h (limit ${DAILY_LIMIT})` : `${today.length} automatic drops in 24 h, limit ${DAILY_LIMIT}: ${today.map((d) => d.name).join(", ")}`,
    });
  }

  // alert-storm
  {
    const ok = input.alertsLastHour <= ALERT_STORM_LIMIT;
    out.push({
      name: "alert-storm", ok, action: "alert",
      detail: ok ? `${input.alertsLastHour} alert(s) in the last hour` : `${input.alertsLastHour} alerts in the last hour, more than ${ALERT_STORM_LIMIT}: something is looping`,
    });
  }

  return out;
}

function nameOf(view: RosterView, id: string): string {
  return view.owned.find((e) => e.playerId === id)?.name ?? id;
}
// #endregion

// #region dedupe table
export function ensureInvariantTable(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS invariant_alerts (name TEXT PRIMARY KEY, last_alert INTEGER NOT NULL)");
}
export function lastInvariantAlert(db: Database, name: string): number {
  ensureInvariantTable(db);
  const row = db.query<{ last_alert: number }, [string]>("SELECT last_alert FROM invariant_alerts WHERE name = ?").get(name);
  return row?.last_alert ?? 0;
}
export function markInvariantAlert(db: Database, name: string, at: number): void {
  ensureInvariantTable(db);
  db.run("INSERT OR REPLACE INTO invariant_alerts (name, last_alert) VALUES (?, ?)", [name, at]);
}
/** Pure: is a push for this invariant due, given when it last went out? */
export function alertDue(lastAlert: number, now: number, dedupeMs = DEDUPE_MS): boolean {
  return now - lastAlert >= dedupeMs;
}
// #endregion

// #region IO wrapper
export interface RunInvariantsDeps {
  alert?: typeof sendAlert;
  freeze?: (reason: string) => Promise<void>;
  frozen?: () => boolean;
  log?: typeof logEvent;
}

/** Evaluate, then act: one push per failing invariant per 24 h, and a freeze
 *  the first time a freeze-class invariant fails while the coach is not
 *  already frozen. Returns everything so the daemon can log a one-line
 *  summary. Never throws. */
export async function runInvariants(input: InvariantInput, deps: RunInvariantsDeps = {}): Promise<InvariantResult> {
  const now = input.now ?? Date.now();
  const alert = deps.alert ?? sendAlert;
  const freeze = deps.freeze ?? freezeNow;
  const isFrozen = deps.frozen ?? (() => freezeState().frozen);
  const log = deps.log ?? logEvent;
  const checks = evaluateInvariants({ ...input, now });
  const alerted: string[] = [];
  const frozen: string[] = [];
  for (const c of checks) {
    if (c.ok) continue;
    try {
      if (c.action === "freeze" && !isFrozen()) {
        await freeze(`invariant ${c.name}: ${c.detail}`);
        frozen.push(c.name);
        log("system", "invariant-freeze", `Froze the coach: ${c.name} failed (${c.detail})`, { name: c.name, detail: c.detail });
      }
      if (alertDue(lastInvariantAlert(input.db, c.name), now)) {
        markInvariantAlert(input.db, c.name, now);
        alerted.push(c.name);
        log("system", "invariant-failed", `${c.name}: ${c.detail}`, { name: c.name, detail: c.detail, action: c.action });
        const title = c.action === "freeze" ? `Coach froze itself: ${c.name}` : `Invariant failed: ${c.name}`;
        await alert(title, c.detail, { level: "now", key: `invariant:${c.name}` });
      }
    } catch (err) {
      console.error(`[invariants] ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: checks.every((c) => c.ok), checks, alerted, frozen };
}
// #endregion

// #region collector
/** The live reads behind one evaluation. Everything comes from the same
 *  sources the decision paths use (GraphQL rosters, the token probe, the
 *  ledger tables), so the invariants see what the coach sees. Six network
 *  reads; the daemon runs it every INVARIANT_EVERY polls, not every poll. */
export async function collectInvariantInput(db: Database, gql: Gql, leg: number): Promise<InvariantInput> {
  const now = Date.now();
  const [league, rosters, state, token] = await Promise.all([
    sleeper.league(config.leagueId),
    leagueRosters(config.leagueId),
    sleeper.nflState(),
    probeToken(),
  ]);
  const mine = rosters.find((r) => r.roster_id === config.rosterId);
  if (!mine) throw new Error(`roster ${config.rosterId} not found in league ${config.leagueId}`);
  const view = buildRosterView(mine);
  const [pendingClaims, offers] = await Promise.all([
    pendingClaimSlots(gql, leg),
    outstandingOffers(gql, leg),
  ]);
  const proposalsDb = readProposals(db);
  const scheduledRuns: Record<string, number> = {};
  try {
    for (const r of db.query<{ job: string; last_run: number }, []>("SELECT job, last_run FROM scheduled_runs").all()) scheduledRuns[r.job] = r.last_run;
  } catch { /* no table yet: every job reads as never run */ }
  return {
    db, league, rosters, state, view, token, pendingClaims,
    outstandingOffers: offers.map((o) => ({ transactionId: o.transactionId })),
    proposalsDb, scheduledRuns,
    dropHistory: dropHistory(),
    alertsLastHour: alertsLastHour(db, now),
    now,
  };
}

/** trade_proposals rows, with a status when the table has that column. */
function readProposals(db: Database): ProposalRow[] {
  try {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(trade_proposals)").all().map((c) => c.name);
    if (!cols.includes("transaction_id")) return [];
    const statusCol = cols.includes("status") ? "status" : "NULL AS status";
    return db.query<{ transaction_id: string | null; status: string | null; at: number }, []>(
      `SELECT transaction_id, ${statusCol}, at FROM trade_proposals`,
    ).all().map((r) => ({ transactionId: r.transaction_id, status: r.status, at: r.at }));
  } catch {
    return [];
  }
}
// #endregion
