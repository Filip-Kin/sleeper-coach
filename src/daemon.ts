import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { sleeper } from "./sleeper/client.ts";
import { sendAlert } from "./alert.ts";
import { logEvent } from "./log.ts";
import { JOBS, isDue, dayLabel, type Job } from "./schedule.ts";
import { pickemTriggerDue, FINAL_WINDOW_MIN } from "./pickem/strategy.ts";
import { tokenGql as leagueGql, dropPlayers, completedTrades, myRosterView, pendingTrades } from "./league/api.ts";
import { assessToken } from "./league/token.ts";
import { probeToken } from "./league/api.ts";
import { runLineupGuard } from "./act/lineup-guard.ts";
import { DropRefused } from "./league/drop-ledger.ts";
import { overCap } from "./analysis/roster-view.ts";
import { heartbeat } from "./heartbeat.ts";
import { bootCanary, releaseCanaryFreeze, canaryFreezeActive, logDeploy } from "./soak/canary.ts";
import { runInvariants, collectInvariantInput } from "./invariants.ts";
import { pruneDeadJobs } from "./soak/migrations.ts";
import { activeRailRoster, chooseLegalForcedDrops } from "./analysis/reconcile-plan.ts";
import { reconcileReserve } from "./act/reserve-reconcile.ts";
import { RunLedger } from "./act/run-ledger.ts";
import { runJobProcess, JOB_TIMEOUT_MS } from "./act/spawn-job.ts";
import { reactToDropsCore } from "./act/drop-react.ts";
import { maybePublishWeekly } from "./blog/auto.ts";
import { allPosts } from "./blog/store.ts";
import { handlePendingTrades } from "./league/trade-watch.ts";
import { handleDms } from "./league/dm-watch.ts";
import { assessVeto, DEFAULT_VETO } from "./league/veto.ts";
import { snapshot, scheduleContext } from "./analysis/trade-wire.ts";
import { activeCapacity } from "./analysis/roster-fit.ts";
import { DEFAULT_FAIRNESS } from "./analysis/trade-fair.ts";
import { freezeState, assertWritesAllowed } from "./killswitch.ts";

// Long-running process the container execs. Mirrors the pit-podcast daemon
// shape: an infinite poll loop with durable SQLite state, each cycle wrapped so
// one failure alerts but never kills the loop. Its job is the *triggered*
// wakeup: notice a pending trade aimed at our roster and wake the agent to
// handle it. Scheduled deadline wakeups (lineups, waivers) are systemd timers
// (Phase E), not this loop.

import { STATE_DIR, DB_PATH, DRAFT_LOCK, KICKOFF_CACHE } from "./paths.ts";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 90_000);
// While the draft orchestrator is running it owns every write to the league,
// so the daemon stands down (trade handling, scheduled jobs, auth checks) until
// the lock file goes away.
const draftActive = () => existsSync(DRAFT_LOCK);
// Trades are the coach's call BY DESIGN, but the write path (respondTrade) is
// still a stub that throws, so with this off a real offer produced a failed agent
// run and nothing else. Off means shadow: describe the offer, alert Filip, act on
// nothing. Turn it on once respondTrade is implemented and the drop rails exist.
// The coach replying to DMs is on by default: it is the surface rivals actually
// use, and dm-watch rate-limits itself per thread so a misfire cannot spam
// anyone. DMS_ENABLED=0 turns it off without a deploy.
const DMS_ENABLED = (process.env.DMS_ENABLED ?? "1") !== "0";

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS seen_transactions (
  transaction_id TEXT PRIMARY KEY,
  status TEXT,
  first_seen INTEGER
)`);
// Which scheduled occurrence of each job we have already handled. Durable on
// purpose: "have I run this week's Sunday lock" must survive a container restart,
// which is the whole reason this can replace host systemd timers. A job is
// recorded when it STARTS, so a redeploy under it cannot re-run it. See
// act/run-ledger.ts.
const runs = new RunLedger(db);
db.run(`CREATE TABLE IF NOT EXISTS drop_reactions (
  transaction_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
db.run(`CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, ref TEXT, session_id TEXT, exit_code INTEGER, started INTEGER
)`);

function alreadyHandled(txId: string): boolean {
  return db.query("SELECT 1 FROM seen_transactions WHERE transaction_id = ?").get(txId) !== null;
}
function markSeen(txId: string, status: string): void {
  db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [txId, status, Date.now()]);
}

// #region auth watch
// The Sleeper session is a JWT (about a year; the one imported on 2026-09-09
// expires 2027-08-06) read from ${STATE_DIR}/sleeper-token. Sleeper can revoke
// it server-side and it does expire, so every AUTH_CHECK_MS the daemon asks
// `me` and reads the exp claim. Missing, rejected, or inside 14 days of expiry
// is alerted once a day with the exact refresh procedure. A network failure is
// inconclusive: writes are held for that poll and nobody is paged.
const AUTH_CHECK_MS = Number(process.env.AUTH_CHECK_MS ?? 30 * 60 * 1000);
const AUTH_ALERT_MS = 24 * 60 * 60 * 1000;
let lastAuthCheck = 0;
let lastAuthAlert = 0;
let authUsable = false;
let authSummary = "unchecked";

async function checkAuth(): Promise<boolean> {
  const now = Date.now();
  const verdict = assessToken(await probeToken(), now);
  if (verdict.inconclusive) {
    // Re-probe on the next poll rather than trusting a stale verdict for 30 min.
    lastAuthCheck = 0;
    console.log(`[auth] ${verdict.summary}; holding writes this poll`);
    return false;
  }
  lastAuthCheck = now;
  if (verdict.usable && !authUsable && authSummary !== "unchecked") {
    logEvent("system", "auth-restored", `Sleeper token usable again (${verdict.summary}).`);
  }
  if (!verdict.usable && (authUsable || authSummary === "unchecked")) {
    logEvent("system", "auth-lost", `Sleeper token not usable: ${verdict.summary}.`);
  }
  authUsable = verdict.usable;
  authSummary = verdict.summary;
  if (verdict.alert && now - lastAuthAlert > AUTH_ALERT_MS) {
    lastAuthAlert = now;
    await sendAlert("Sleeper token needs attention", verdict.alert).catch(() => {});
  }
  return verdict.usable;
}

/** Can a write go out now? Answers from the last check, re-probing when it is
 *  older than AUTH_CHECK_MS. Every job and every write path in this file is
 *  gated on it. */
async function tokenReady(): Promise<boolean> {
  if (Date.now() - lastAuthCheck > AUTH_CHECK_MS) return checkAuth();
  return authUsable;
}
// #endregion


// #region in-container scheduling
// Replaces the host systemd timers. Filip: "I want this to run containerized so
// it's not using my systemd timer." Every daemon poll asks each job whether its
// most recent occurrence has passed unhandled; the answer is durable in SQLite so
// a restart cannot double-fire or silently skip a week.
const lastRunOf = (job: string): number => runs.lastRunOf(job);

// Each job maps to a script already exercised by hand. Running them as separate
// processes rather than in-process is deliberate: a job that hangs or throws
// cannot take the daemon down with it, and each run's output lands in the
// container log where it can be read after the fact.
// --refresh forces loadPlayers and loadWeekProjections past their caches. EVERY
// job that writes a lineup gets it: the whole value of the 18:45 and 19:00 checks
// is catching injury news that broke in the last hour, and I originally wired
// those two WITHOUT it while giving it to the 11:00 lock, which made the late
// checks read stale data and quietly do nothing. A cache miss costs one API call.
//
// The two waiver jobs are genuinely different despite looking similar:
// compute is read-only planning in the small hours, submit is the one that acts.
// Waivers write by default now. They used to be off because every claim was
// shadowed regardless: the claim flow existed only as unverified trades-page DOM
// work, so the coach could work out the right claim and then not make it.
// submit_waiver_claim closed that, and Filip's position is that the manager
// manages ("it needs to be able to do everything that a league manager would").
//
// The schedule keeps a review window either way: waiver-compute runs Tuesday
// 02:00 in shadow and prints its intent to the activity feed, waiver-submit acts
// at 20:00, so there are eighteen hours to look and to touch the FREEZE file.
// WAIVERS_LIVE=0 turns writes off entirely without a deploy.
const waiversLive = (process.env.WAIVERS_LIVE ?? "1") !== "0";
const JOB_COMMAND: Record<string, string[]> = {
  // The engineer runs on the same containerized schedule as the coaching. Filip:
  // "I want to be hands off after today. The engineer should handle all
  // engineering. The bot should handle all coaching."
  "engineer": ["bun", "run", "src/engineer/engineer-run.ts"],
  "lineup-thursday": ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"],
  "lineup-sunday": ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"],
  "inactive-sunday": ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"],
  "inactive-monday": ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"],
  // The pick'em pool. One command for every occurrence: run.ts decides for
  // itself whether each game is inside its own final window, so the daily
  // backstop and the pre-kickoff passes are the same code with different timing.
  // Daily backstop only. The passes that actually carry our edge are spawned by
  // pickemKickoffPass() below, off real kickoff times.
  "news-refresh": ["bun", "run", "src/data/news-refresh.ts"],
  "pickem-slate": ["bun", "run", "src/pickem/run.ts"],
  "trade-propose": ["bun", "run", "src/league/propose-run.ts"],
  "waiver-compute": ["bun", "run", "src/act/waiver-run.ts"],
  // Claims only: their timing is irrelevant (batch-processed by priority), so
  // this one keeps a fixed, comfortable slot before the clear.
  "waiver-submit": waiversLive
    ? ["bun", "run", "src/act/waiver-run.ts", "--live", "--claims-only"]
    : ["bun", "run", "src/act/waiver-run.ts", "--claims-only"],
  // Adds only, on the randomised schedule. See the free-agent job in schedule.ts.
  "free-agent": waiversLive
    ? ["bun", "run", "src/act/waiver-run.ts", "--live", "--adds-only"]
    : ["bun", "run", "src/act/waiver-run.ts", "--adds-only"],
  "alert-digest": ["bun", "run", "scripts/alert-digest.ts"],
};

async function runJob(job: Job, occurrence: number): Promise<void> {
  const cmd = JOB_COMMAND[job.name];
  if (!cmd) {
    console.error(`[schedule] ${job.name} has no command; skipping`);
    return;
  }
  const frozen = freezeState();
  if (frozen.frozen) {
    // Mark it handled anyway: the freeze is a deliberate human decision, and we
    // do not want a queue of missed locks all firing the moment it is lifted.
    console.log(`[schedule] ${job.name} skipped, ${frozen.reason}`);
    logEvent("coach", "schedule-frozen", `${job.name} skipped: ${frozen.reason}`, { job: job.name });
    runs.markHandled(job.name, occurrence);
    return;
  }
  console.log(`[schedule] running ${job.name}: ${cmd.join(" ")}`);
  logEvent("coach", "schedule-run", `Running ${job.name}.`, { job: job.name, occurrence });
  // Recorded as handled BEFORE the spawn. A redeploy that kills the container
  // mid-run must not re-run a half-applied roster write on the next boot.
  runs.markStarted(job.name, occurrence);
  const r = await runJobProcess(cmd, { cwd: process.cwd(), timeoutMs: JOB_TIMEOUT_MS });
  const secs = r.secs.toFixed(1);
  console.log(r.out.trim().split("\n").slice(-25).join("\n"));
  if (r.timedOut) {
    await jobTimedOut(job.name, r.secs);
  } else if (r.code !== 0) {
    console.error(`[schedule] ${job.name} exited ${r.code} after ${secs}s: ${r.err.trim().slice(0, 400)}`);
    logEvent("coach", "schedule-failed", `${job.name} exited ${r.code}.`, { job: job.name, code: r.code, stderr: r.err.trim().slice(0, 600) });
    await sendAlert(`Scheduled job failed: ${job.name}`, `Exited ${r.code} after ${secs}s. ${r.err.trim().slice(0, 300)}`).catch(() => {});
    // Handled regardless. Retrying a half-applied roster write on the next
    // poll is more dangerous than missing the lock, and the alert has gone out.
  } else {
    console.log(`[schedule] ${job.name} finished in ${secs}s`);
    logEvent("coach", "schedule-done", `${job.name} finished in ${secs}s.`, { job: job.name });
  }
  runs.markFinished(job.name, occurrence);
}

// A child that overruns its deadline is killed, logged, and alerted once per
// job per day; the poll loop never waits on it again.
const timeoutAlerted = new Map<string, number>();
async function jobTimedOut(name: string, secs: number): Promise<void> {
  console.error(`[schedule] ${name} killed after ${secs.toFixed(0)}s (limit ${Math.round(JOB_TIMEOUT_MS / 60_000)} min)`);
  logEvent("coach", "job-timeout", `${name} was killed after ${Math.round(secs)}s, past the ${Math.round(JOB_TIMEOUT_MS / 60_000)} min limit.`, { job: name, secs: Math.round(secs) });
  const now = Date.now();
  if (now - (timeoutAlerted.get(name) ?? 0) > 24 * 3_600_000) {
    timeoutAlerted.set(name, now);
    await sendAlert(`Job timed out: ${name}`, `Killed after ${Math.round(secs / 60)} min. Check the container log.`).catch(() => {});
  }
}

/** Spawn a one-off job (lineup re-solve, claim reaction, blog) with the same
 *  deadline as the scheduled ones, output streamed to our own log. */
async function runOneOff(name: string, cmd: string[]): Promise<number> {
  const r = await runJobProcess(cmd, { cwd: process.cwd(), timeoutMs: JOB_TIMEOUT_MS, inherit: true });
  if (r.timedOut) await jobTimedOut(name, r.secs);
  return r.code;
}

// #region pick'em pre-kickoff passes
// Games in the pick'em pool lock individually, and we deliberately hold our real
// picks until minutes before each kickoff so rivals cannot copy them (the
// endpoint that shows us their picks shows them ours). A fixed timetable cannot
// do that: passes hours apart would mean almost no game was ever inside a
// twenty-minute window. So the daemon drives it off actual kickoff times, at its
// own 90-second poll granularity.
//
// Kickoffs come from a cache written by the pick'em job itself, sourced from
// Sleeper rather than a third party, and refreshed by the daily backstop pass
// (which is also how flex scheduling gets picked up).
let lastPickemPass = 0;

async function cachedKickoffs(): Promise<number[]> {
  try {
    const f = Bun.file(KICKOFF_CACHE);
    if (!(await f.exists())) return [];
    const j = (await f.json()) as { games?: { startTime?: number }[] };
    return (j.games ?? []).map((g) => Number(g.startTime)).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // a missing or half-written cache must never take the daemon down
  }
}

async function pickemKickoffPass(): Promise<void> {
  if (draftActive()) return;
  const kickoffs = await cachedKickoffs();
  if (!pickemTriggerDue(kickoffs, Date.now(), lastPickemPass)) return;
  if (!(await tokenReady())) return; // retried on the next poll, nothing burned
  lastPickemPass = Date.now();
  const next = Math.min(...kickoffs.filter((k) => k > Date.now()));
  const mins = Math.round((next - Date.now()) / 60_000);
  console.log(`[pickem] pre-kickoff pass: next game in ${mins} min (window ${FINAL_WINDOW_MIN} min)`);
  const code = await runOneOff("pickem-pass", ["bun", "run", "src/pickem/run.ts"]);
  if (code !== 0) {
    // Not fatal and not alerted: we are still holding a provisional favourite,
    // so a failed pass costs the edge on one game, and the next poll retries.
    console.error(`[pickem] pre-kickoff pass exited ${code}; retrying on the next poll`);
  }
}
// #endregion

let heldJobsLogged = false;

async function runDueJobs(): Promise<void> {
  if (draftActive()) return; // the draft orchestrator owns the league while it runs
  const now = Date.now();
  const due = JOBS.map((job) => ({ job, v: isDue(job, now, lastRunOf(job.name)) }));
  // Only pay for the token check when something actually wants to run, and
  // leave the occurrence UNMARKED so it is retried on the next poll instead of
  // being burned while the token is missing or Sleeper is unreachable.
  if (due.some((d) => d.v.due && d.v.occurrence !== null) && !(await tokenReady())) {
    if (!heldJobsLogged) {
      const names = due.filter((d) => d.v.due).map((d) => d.job.name).join(", ");
      console.log(`[schedule] Sleeper token not usable (${authSummary}); holding ${names} for the next poll`);
      heldJobsLogged = true;
    }
    return;
  }
  heldJobsLogged = false;
  for (const { job, v } of due) {
    if (v.due && v.occurrence !== null) {
      await runJob(job, v.occurrence);
    } else if (v.occurrence !== null && v.reason.includes("skipping")) {
      // Record it so the skip is logged once rather than every 90 seconds.
      console.log(`[schedule] ${job.name}: ${v.reason}`);
      logEvent("coach", "schedule-skipped", `${job.name}: ${v.reason}`, { job: job.name });
      runs.markHandled(job.name, v.occurrence);
    }
  }
}
// #endregion

// #region react to a drop
// WHY THIS IS NOT ON A TIMER. This league clears waivers two days after a player
// is dropped (waiver_clear_days 2), not weekly, but claims were only ever
// computed on Tuesdays. A player dropped on a Thursday therefore cleared on
// Saturday and was gone long before the coach next looked, which is the gap
// Filip pointed at. So a drop by ANY manager triggers a fresh claim evaluation.
//
// This does NOT undo the free-agent fairness rule, because the two are different
// races. A claim is resolved at the clear time in waiver_position order, so
// submitting the moment we notice takes nothing from anybody: everyone has until
// the clear. It is the instant free-agent grab that is unfair, and that stays on
// its randomised daily slot.
//
// A drop is marked reacted only once the claim run has exited 0 (see
// act/drop-react.ts): marking first buried every drop whose run crashed or was
// skipped inside the cooldown.
let lastDropReaction = 0;

function alreadyReacted(id: string): boolean {
  return db.query<{ at: number }, [string]>("SELECT at FROM drop_reactions WHERE transaction_id = ?").get(id) != null;
}

async function reactToDrops(week: number): Promise<void> {
  let txns: { transaction_id?: string; drops?: Record<string, number> | null; type?: string }[] = [];
  try {
    txns = (await sleeper.transactions(config.leagueId, Math.max(1, week))) as typeof txns;
  } catch {
    return; // a transient read failure is not worth a retry storm
  }
  const r = await reactToDropsCore({
    txns, alreadyReacted,
    markReacted: (id) => db.run("INSERT OR REPLACE INTO drop_reactions (transaction_id, at) VALUES (?, ?)", [id, Date.now()]),
    now: Date.now(), lastReaction: lastDropReaction, frozen: freezeState().frozen,
    run: async () => {
      lastDropReaction = Date.now();
      console.log(`[waivers] new drop(s) in the league; re-evaluating claims`);
      const cmd = waiversLive
        ? ["bun", "run", "src/act/waiver-run.ts", "--live", "--claims-only"]
        : ["bun", "run", "src/act/waiver-run.ts", "--claims-only"];
      return runOneOff("waiver-react", cmd);
    },
  });
  if (r.ran) {
    logEvent("coach", "waiver-react", `${r.fresh.length} player(s) dropped in the league; re-evaluated waiver claims (exit ${r.code}).`, { transactions: r.fresh, code: r.code });
    if (r.code !== 0) console.error(`[waivers] drop reaction exited ${r.code}; the drops stay unreacted and are retried after the cooldown`);
  }
}
// #endregion

// #region veto review of other managers' trades
const vetoSeen = new Set<string>();
async function reviewOthersTrades(leg: number): Promise<void> {
  // Runs after pollOnce's token gate. It used to sit behind a browser-ready
  // flag that nothing ever set to true, so the veto review never ran; it does
  // now, and it only ever flags for a human (assessVeto never votes).
  let pend: { transactionId: string; rosterIds: number[]; adds: Record<string, number>; drops: Record<string, number>; consenterIds: number[] }[] = [];
  try {
    pend = await pendingTrades(leagueGql(), leg);
  } catch { return; }
  const others = pend.filter((t) => !t.rosterIds.includes(config.rosterId) && !vetoSeen.has(t.transactionId));
  if (!others.length) return;
  const snap = await snapshot();
  for (const t of others) {
    vetoSeen.add(t.transactionId);
    const a = assessVeto(
      { transactionId: t.transactionId, rosterIds: t.rosterIds, adds: t.adds, drops: t.drops },
      snap.rosterOf,
      (id) => snap.playerById.get(id) ?? { name: id, position: "", points: 0 },
      DEFAULT_VETO,
    );
    logEvent("coach", "veto-review", `Trade ${t.transactionId} between rosters ${t.rosterIds.join(", ")}: ${a.verdict}. ${a.reason}`, {
      transaction_id: t.transactionId, verdict: a.verdict, gain: a.gain,
    });
    if (a.verdict === "flag") {
      await sendAlert("Possible collusion trade to review",
        `A trade between other managers looks like a dump: ${a.reason}. It is NOT vetoed automatically; review it in the app if you want to vote.`).catch(() => {});
    }
  }
}
// #endregion

// #region post-trade roster reconciliation and lineup re-solve
// accept_trade only records consent; the drop-to-fit and the lineup fix happen
// AFTER the trade processes, and nothing handled them. Filip: "when a trade
// goes through and we need to remove a player, will it pick the correct one,
// and will it fix our lineup?" These two functions are that yes.
let reconcileBusy = false;

// The "cannot auto-fix" and "frozen" alerts say it once an hour, not once a poll.
let lastStuckAlert = 0;
const STUCK_ALERT_MS = 60 * 60_000;

/** If a completed trade (or anything else) left us over the 16-man limit, drop
 *  the cheapest-to-lose players to get legal. Mechanism-agnostic: it fixes an
 *  over-cap roster however it arose, which is more robust than betting on
 *  Sleeper's exact accept-time drop flow, which we cannot rehearse.
 *
 *  The kill switch and the drop breaker live INSIDE dropPlayers (league/api.ts)
 *  since 2026-09-23. A DropRefused from there is the breaker's decision and is
 *  treated as "not now": logged, never alerted as a failure, retried next poll. */
async function reconcileRoster(gql: ReturnType<typeof leagueGql>): Promise<void> {
  if (reconcileBusy || draftActive()) return;
  reconcileBusy = true;
  try {
    const league = await sleeper.league(config.leagueId);
    const cap = activeCapacity(league.roster_positions);
    // Everything about "who is on the roster" comes from the one view. The cap
    // counts ACTIVE players only; the 2026-09-19 cascade came from counting
    // Sleeper's raw array, which includes injured reserve.
    const view = await myRosterView();
    const over = overCap(view, cap);
    if (over === 0) return;

    const snap = await snapshot();
    // The solver sees the FULL active roster (a man on IR is excluded by id,
    // structurally) and droppable() checks what it chose. Handing it only the
    // droppable subset (the audit's R2) made every candidate look like it
    // emptied a starting slot, and this path never dropped anyone.
    const full = activeRailRoster(view, snap.rosterOf.get(snap.ourRosterId) ?? []);
    if (view.reserve.length) console.log(`[reconcile] on IR, never a drop candidate: ${view.reserve.map((e) => e.name).join(", ")}`);
    const sched = await scheduleContext(null);
    const cfg = { ...DEFAULT_FAIRNESS, ...sched };
    const drops = chooseLegalForcedDrops(view, full, over, cfg, DEFAULT_FAIRNESS.rails);

    if (drops.length < over) {
      // Rails would not let us drop enough without cutting a stash or a
      // never-drop. That is a human decision, not an automatic one.
      logEvent("coach", "roster-overcap-stuck", `Over the roster cap by ${over} but only ${drops.length} legal drop(s); needs a human`, {
        over, chose: drops.map((d) => d.name),
      });
      if (Date.now() - lastStuckAlert > STUCK_ALERT_MS) {
        lastStuckAlert = Date.now();
        await sendAlert("Roster over cap, cannot auto-fix",
          `We are ${over} over the ${cap}-man limit and the rails only allow dropping ${drops.length}: ${drops.map((d) => d.name).join(", ") || "none"}. Handle it in Sleeper.`).catch(() => {});
      }
      return;
    }

    logEvent("coach", "roster-reconcile", `Over cap by ${over}; dropping ${drops.map((d) => d.name).join(", ")}`, {
      over, drops: drops.map((d) => ({ name: d.name, playerId: d.playerId, cost: d.cost })),
    });
    if (freezeState().frozen) {
      if (Date.now() - lastStuckAlert > STUCK_ALERT_MS) {
        lastStuckAlert = Date.now();
        await sendAlert("Roster over cap (frozen)", `Would drop ${drops.map((d) => d.name).join(", ")} but writes are frozen.`).catch(() => {});
      }
      return;
    }
    assertWritesAllowed("post-trade drop");

    try {
      const res = await dropPlayers(gql, drops.map((d) => d.playerId));
      logEvent("coach", "roster-dropped", `Dropped ${drops.map((d) => d.name).join(", ")} to get under the cap`, { status: res.status, drops: drops.map((d) => d.name) });
      // Roster changed: re-solve the lineup now rather than waiting for a timer.
      await resolveLineupNow("the roster changed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof DropRefused) {
        // The breaker decided. Not a failure: the next poll after the cooldown tries again.
        logEvent("coach", "drop-deferred", `Over-cap drop of ${drops.map((d) => d.name).join(", ")} deferred by the breaker: ${e.verdict.reason}`, { drops: drops.map((d) => d.name) });
        return;
      }
      logEvent("coach", "roster-drop-failed", `Could not drop to get under the cap: ${msg}`, { drops: drops.map((d) => d.name) });
      await sendAlert("Post-trade drop failed", `Wanted to drop ${drops.map((d) => d.name).join(", ")} but the write failed: ${msg}. Handle it in Sleeper.`).catch(() => {});
    }
  } finally {
    reconcileBusy = false;
  }
}

/** Re-solve and set the week's lineup immediately. Lineups are pure upside and
 *  reversible until kickoff, so this needs no shadow phase. */
async function resolveLineupNow(why: string): Promise<void> {
  if (freezeState().frozen) return;
  console.log(`[lineup] re-solving now: ${why}`);
  const code = await runOneOff("lineup-resolve", ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"]);
  if (code !== 0) console.error(`[lineup] re-solve exited ${code}`);
}

/** Notice a trade that has PROCESSED and react: reconcile the roster (which
 *  re-solves the lineup if it drops anyone) and, even on an even trade that
 *  needs no drop, re-solve the lineup so a newly acquired starter is in.
 *  Idempotent across restarts: each trade is keyed `done:<id>` in the durable
 *  seen_transactions table before anything runs. completedTrades scans this
 *  leg and the last, so a Tuesday completion is still found on Wednesday. */
async function reactToCompletedTrades(gql: ReturnType<typeof leagueGql>, leg: number): Promise<void> {
  if (draftActive()) return;
  let trades;
  try { trades = await completedTrades(gql, leg); } catch { return; }
  const ours = trades.filter((t) => t.rosterIds.includes(config.rosterId) && !alreadyHandled(`done:${t.transactionId}`));
  if (!ours.length) return;
  for (const t of ours) markSeen(`done:${t.transactionId}`, "completed");
  logEvent("coach", "trade-completed", `${ours.length} trade(s) involving us processed; reconciling roster and lineup`, {
    transactions: ours.map((t) => t.transactionId),
  });
  await reconcileRoster(gql);
  await resolveLineupNow("a trade involving us completed");
}
// #endregion

const SOAK_POLLS = Number(process.env.SOAK_POLLS ?? 0);
let polls = 0;

async function pollOnce(): Promise<void> {
  polls++;
  heartbeat(); // the web server's /health reads this; a stuck poll goes 503 in 5 min
  // A fresh container boots frozen (entrypoint writes `boot-canary <sha>`). The
  // freeze lifts only after read-only checks pass: token, real league id,
  // roster legal, matchup points nonzero in a scored week. A human freeze is
  // never touched here.
  if (canaryFreezeActive()) {
    const c = await bootCanary();
    if (c.ok) logEvent("system", "canary-pass", `Boot canary passed; freeze ${releaseCanaryFreeze()}.`);
    else await sendAlert("Boot canary failed, still frozen", c.failures.join("; "), { key: "canary" }).catch(() => {});
  }
  const state = await sleeper.nflState();
  const round = Math.max(1, state.week || 1);
  if (draftActive()) return; // the draft orchestrator owns the league while it runs

  // A healed player still parked on IR makes the roster invalid and every
  // lineup write fails, so he comes off reserve BEFORE the guard plans. The
  // reads are public; the write waits for the token. See act/reserve-reconcile.ts.
  const fixReserve = () => reconcileReserve({ gql: leagueGql(), tokenReady }).then(() => undefined);
  await fixReserve().catch((e) => console.error(`[reserve] ${e instanceof Error ? e.message : String(e)}`));

  // Is the lineup on the site still the optimal one? A starter ruled Out since
  // the last lock, or a player back from Out, is fixed here, every poll, not at
  // the next fixed lock. The reads are public GraphQL (no token, no player
  // dump), so this runs before the token gate; only a needed write waits for
  // the token. See act/lineup-guard.ts.
  await runLineupGuard({ tokenReady, onReserveIneligible: fixReserve }).catch((e) => console.error(`[lineup-guard] ${e instanceof Error ? e.message : String(e)}`));

  // TRADES COME FROM GRAPHQL, NOT REST. On 2026-09-02 a real offer sat live for
  // hours and the coach never saw it: GET /transactions/<week> does not list
  // proposed trades at all, and the old code also tested status "pending" when
  // Sleeper says "proposed". Both faults were in the same line. GraphQL's
  // league_transactions_by_status(status:"proposed") returns them, and
  // accept_trade / reject_trade respond without touching the trades-page DOM
  // that blocked this for weeks.
  // Everything below needs the session token. Gating here rather than letting
  // each call fail keeps a dead token visible in one place (the auth watch
  // alerts) instead of as five different error lines per poll.
  if (!(await tokenReady())) return;

  const gql = leagueGql();
  try {
    await handlePendingTrades(gql, round, alreadyHandled, markSeen, db);
  } catch (err) {
    console.error(`[daemon] trade check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A drop anywhere in the league opens a two-day waiver window on that player,
  // so it is evaluated when it happens rather than on Tuesday.
  await reactToDrops(round);

  // Trades between OTHER managers go to a league veto vote. We default to
  // allowing them (allow needs no action), and only flag a suspected collusion
  // dump for a human, because a wrong public veto poisons the league and the
  // vote mechanism is not yet observable to cast safely. See league/veto.ts.
  await reviewOthersTrades(round).catch((e) => console.error(`[veto] ${e instanceof Error ? e.message : String(e)}`));

  // A completed trade means a roster change: drop to fit if over cap, and
  // re-solve the lineup so the new players are actually started.
  await reactToCompletedTrades(gql, round).catch((e) => console.error(`[reconcile] ${e instanceof Error ? e.message : String(e)}`));
  // And a standing safety net: if we are ever over cap for any reason, fix it.
  await reconcileRoster(gql).catch((e) => console.error(`[reconcile] ${e instanceof Error ? e.message : String(e)}`));

  // The weekly review publishes itself once the week's games are over and the
  // stat feed has stopped moving. Checked here rather than on a Tuesday timer
  // because the week does not end at a fixed time. See blog/auto.ts.
  await maybePublishWeekly({
    posts: allPosts,
    currentWeek: async () => Math.max(1, (await sleeper.nflState()).week || 1),
    run: (w) => runOneOff("blog-weekly", ["bun", "run", "src/blog/generate.ts", "week", String(w)]),
  }).catch((e) => console.error(`[blog] ${e instanceof Error ? e.message : String(e)}`));

  // The coach answers its own DMs. Trade negotiation in this league happens in
  // chat, not the trade UI, so ignoring DMs meant ignoring half the game.
  if (DMS_ENABLED) {
    try {
      await handleDms({ gql, db });
    } catch (err) {
      console.error(`[daemon] dm check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Runtime invariants, every 10th poll (15 min): roster legal on Sleeper, no
  // starter on IR, claims have slots, offers we think are open still exist,
  // scheduled jobs actually ran, drop and alert budgets. One push per invariant
  // per day; the roster ones freeze. This is what tells us about a broken
  // roster at 9 AM instead of Filip at 10:38.
  if (polls % 10 === 1) {
    try {
      await runInvariants(await collectInvariantInput(db, gql, round));
    } catch (err) {
      console.error(`[daemon] invariants failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  logDeploy();
  pruneDeadJobs(db, JOBS);
  logEvent("daemon", "online", "Daemon started; watching for trades, auth and the weekly schedule.");
  console.log(`[daemon] polling every ${POLL_INTERVAL_MS / 1000}s, db=${DB_PATH}`);
  // A job the previous container started and never finished (killed by a
  // redeploy) is reported once and NOT re-run: its occurrence is already
  // recorded, and a second half-applied write is worse than a missed one.
  const cut = runs.interrupted();
  if (cut.length) {
    const names = cut.map((r) => `${r.job} (started ${new Date(r.startedAt).toISOString()})`).join(", ");
    logEvent("daemon", "job-interrupted", `Interrupted by the last restart, not re-run: ${names}`, { jobs: cut });
    await sendAlert("Job interrupted by a restart", `${names}. Not re-run; check the roster if it was a write job.`).catch(() => {});
    runs.settleInterrupted();
  }
  for (const j of JOBS) {
    const cmd = JOB_COMMAND[j.name];
    console.log(`[schedule] ${j.name.padEnd(18)} ${dayLabel(j)} ${String(j.hour).padStart(2, "0")}:${String(j.minute).padStart(2, "0")} ET, up to ${Math.round(j.maxLateMs / 3600000)}h late  ->  ${cmd ? cmd.slice(2).join(" ") : "NO COMMAND"}`);
  }
  for (;;) {
    try {
      await pollOnce();
      await runDueJobs();
      await pickemKickoffPass();
      if (!draftActive() && Date.now() - lastAuthCheck > AUTH_CHECK_MS) await checkAuth();
      if (SOAK_POLLS && polls >= SOAK_POLLS) { logEvent("daemon", "soak-done", `Soak finished after ${polls} polls.`); process.exit(0); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] poll error: ${msg}`);
      logEvent("daemon", "poll-error", msg);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

main();
