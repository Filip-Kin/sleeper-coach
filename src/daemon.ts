import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { sleeper } from "./sleeper/client.ts";
import { sendAlert } from "./alert.ts";
import { logEvent } from "./log.ts";
import { JOBS, isDue, dayLabel, type Job } from "./schedule.ts";
import { pickemTriggerDue, FINAL_WINDOW_MIN } from "./pickem/strategy.ts";
import { browserGql as leagueGql } from "./league/api.ts";
import { handlePendingTrades } from "./league/trade-watch.ts";
import { handleDms } from "./league/dm-watch.ts";
import { freezeState } from "./killswitch.ts";

// Long-running process the container execs. Mirrors the pit-podcast daemon
// shape: an infinite poll loop with durable SQLite state, each cycle wrapped so
// one failure alerts but never kills the loop. Its job is the *triggered*
// wakeup: notice a pending trade aimed at our roster and wake the agent to
// handle it. Scheduled deadline wakeups (lineups, waivers) are systemd timers
// (Phase E), not this loop.

const STATE_DIR = process.env.COACH_STATE ?? "/data/sleeper-coach";
const DB_PATH = process.env.COACH_DB ?? "/data/sleeper-coach/coach.db";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 90_000);
// While the draft orchestrator owns the shared browser, the daemon must not
// navigate it (auth checks / trade handling), or it hijacks the draft.
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
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
// which is the whole reason this can replace host systemd timers.
db.run(`CREATE TABLE IF NOT EXISTS scheduled_runs (
  job TEXT PRIMARY KEY,
  last_run INTEGER
)`);
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
// The Sleeper session (a ~1-year JWT in the browser profile) should last the
// season, but a server-side logout would silently break the coach's hands. So
// we periodically confirm login and push an HA alert on any change, per Filip.
const BROWSER_API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const AUTH_CHECK_MS = Number(process.env.AUTH_CHECK_MS ?? 30 * 60 * 1000);
// Genuine session loss must be confirmed by several CONSECUTIVE definitive reads
// before we ping Filip — the old check false-fired constantly, so the bar is
// deliberately high. An inconclusive ("unknown") read never counts either way.
const AUTH_FAIL_THRESHOLD = Number(process.env.AUTH_FAIL_THRESHOLD ?? 3);
let lastAuthCheck = 0;
let lastAuthOk = true;
let authOutStreak = 0;

async function checkAuth(): Promise<void> {
  lastAuthCheck = Date.now();
  let state = "unknown";
  try {
    const res = await fetch(`${BROWSER_API}/auth`, { signal: AbortSignal.timeout(20_000) });
    state = String(((await res.json()) as { state?: string }).state ?? "unknown");
  } catch {
    state = "unknown"; // browser-server unreachable — inconclusive, never alert
  }
  if (state === "ok") {
    if (!lastAuthOk) logEvent("system", "auth-restored", "Sleeper session valid again.");
    lastAuthOk = true;
    authOutStreak = 0;
    return;
  }
  if (state === "logged_out" || state === "expired") {
    authOutStreak++;
    // Ping only after repeated confirmation, and only once per outage. This
    // genuinely needs Filip: re-export/import a session.
    if (authOutStreak >= AUTH_FAIL_THRESHOLD && lastAuthOk) {
      lastAuthOk = false;
      logEvent("system", "auth-lost", `Sleeper session ${state} (confirmed ${authOutStreak}x).`);
      await sendAlert("Sleeper login lost", `The coach's Sleeper session is ${state}. Re-import a session so it can act on your team.`);
    }
    return;
  }
  // "unknown": inconclusive — leave streak and lastAuthOk untouched, no alert.
}
// #endregion


// #region in-container scheduling
// Replaces the host systemd timers. Filip: "I want this to run containerized so
// it's not using my systemd timer." Every daemon poll asks each job whether its
// most recent occurrence has passed unhandled; the answer is durable in SQLite so
// a restart cannot double-fire or silently skip a week.
function lastRunOf(job: string): number {
  const row = db.query("SELECT last_run FROM scheduled_runs WHERE job = ?").get(job) as { last_run?: number } | null;
  return row?.last_run ?? 0;
}
function markRun(job: string, occurrence: number): void {
  db.run("INSERT OR REPLACE INTO scheduled_runs (job, last_run) VALUES (?, ?)", [job, occurrence]);
}

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
// waiver-run.ts --live performs only costless free-agent adds and still SHADOWS
// every claim, because the claim DOM flow is unverified. So WAIVERS_LIVE flips
// the submit job without a code change, once a shadow cycle has been reviewed.
const waiversLive = /^(1|true|yes|on)$/i.test(process.env.WAIVERS_LIVE ?? "");
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
  "pickem-slate": ["bun", "run", "src/pickem/run.ts"],
  "waiver-compute": ["bun", "run", "src/act/waiver-run.ts"],
  "waiver-submit": waiversLive
    ? ["bun", "run", "src/act/waiver-run.ts", "--live"]
    : ["bun", "run", "src/act/waiver-run.ts"],
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
    markRun(job.name, occurrence);
    return;
  }
  console.log(`[schedule] running ${job.name}: ${cmd.join(" ")}`);
  logEvent("coach", "schedule-run", `Running ${job.name}.`, { job: job.name, occurrence });
  const t0 = Date.now();
  const proc = Bun.spawn(cmd, { cwd: "/app", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(out.trim().split("\n").slice(-25).join("\n"));
  if (code !== 0) {
    console.error(`[schedule] ${job.name} exited ${code} after ${secs}s: ${err.trim().slice(0, 400)}`);
    logEvent("coach", "schedule-failed", `${job.name} exited ${code}.`, { job: job.name, code, stderr: err.trim().slice(0, 600) });
    await sendAlert(`Scheduled job failed: ${job.name}`, `Exited ${code} after ${secs}s. ${err.trim().slice(0, 300)}`).catch(() => {});
    // Mark it handled regardless. Retrying a half-applied roster write on the
    // next 90s poll is more dangerous than missing the lock, and the alert has
    // already gone out.
    markRun(job.name, occurrence);
    return;
  }
  console.log(`[schedule] ${job.name} finished in ${secs}s`);
  logEvent("coach", "schedule-done", `${job.name} finished in ${secs}s.`, { job: job.name });
  markRun(job.name, occurrence);
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
const KICKOFF_CACHE = `${process.env.STATE_DIR ?? "/data/sleeper-coach"}/pickem-kickoffs.json`;
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
  if (!(await browserReady())) return; // retried on the next poll, nothing burned
  lastPickemPass = Date.now();
  const next = Math.min(...kickoffs.filter((k) => k > Date.now()));
  const mins = Math.round((next - Date.now()) / 60_000);
  console.log(`[pickem] pre-kickoff pass: next game in ${mins} min (window ${FINAL_WINDOW_MIN} min)`);
  const proc = Bun.spawn(["bun", "run", "src/pickem/run.ts"], { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    // Not fatal and not alerted: we are still holding a provisional favourite,
    // so a failed pass costs the edge on one game, and the next poll retries.
    console.error(`[pickem] pre-kickoff pass exited ${code}; retrying on the next poll`);
  }
}
// #endregion

/** Is the shared browser up? Every scheduled job drives it, and the container
 *  starts the daemon and browser-server together, so at boot a job can be due
 *  before Brave has finished launching. That failed pickem-slate 0.2s into its
 *  first deploy, and because a failed job is marked handled rather than retried,
 *  the day's run was simply lost. Cheap ping, short timeout, no navigation. */
let browserWaitLogged = false;
async function browserReady(): Promise<boolean> {
  try {
    const res = await fetch(`${BROWSER_API}/auth`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runDueJobs(): Promise<void> {
  if (draftActive()) return; // never fight a draft for the shared browser
  const now = Date.now();
  const due = JOBS.map((job) => ({ job, v: isDue(job, now, lastRunOf(job.name)) }));
  // Only pay for the readiness check when something actually wants to run, and
  // leave the occurrence UNMARKED so it is retried on the next poll instead of
  // being burned by a startup race.
  if (due.some((d) => d.v.due && d.v.occurrence !== null) && !(await browserReady())) {
    if (!browserWaitLogged) {
      const names = due.filter((d) => d.v.due).map((d) => d.job.name).join(", ");
      console.log(`[schedule] browser not up yet; holding ${names} for the next poll`);
      browserWaitLogged = true;
    }
    return;
  }
  browserWaitLogged = false;
  for (const { job, v } of due) {
    if (v.due && v.occurrence !== null) {
      await runJob(job, v.occurrence);
    } else if (v.occurrence !== null && v.reason.includes("skipping")) {
      // Record it so the skip is logged once rather than every 90 seconds.
      console.log(`[schedule] ${job.name}: ${v.reason}`);
      logEvent("coach", "schedule-skipped", `${job.name}: ${v.reason}`, { job: job.name });
      markRun(job.name, v.occurrence);
    }
  }
}
// #endregion

async function pollOnce(): Promise<void> {
  const state = await sleeper.nflState();
  const round = Math.max(1, state.week || 1);
  if (draftActive()) return; // don't drive the browser mid-draft

  // TRADES COME FROM GRAPHQL, NOT REST. On 2026-09-02 a real offer sat live for
  // hours and the coach never saw it: GET /transactions/<week> does not list
  // proposed trades at all, and the old code also tested status "pending" when
  // Sleeper says "proposed". Both faults were in the same line. GraphQL's
  // league_transactions_by_status(status:"proposed") returns them, and
  // accept_trade / reject_trade respond without touching the trades-page DOM
  // that blocked this for weeks.
  const gql = leagueGql();
  try {
    await handlePendingTrades(gql, round, alreadyHandled, markSeen);
  } catch (err) {
    console.error(`[daemon] trade check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The coach answers its own DMs. Trade negotiation in this league happens in
  // chat, not the trade UI, so ignoring DMs meant ignoring half the game.
  if (DMS_ENABLED) {
    try {
      await handleDms({ gql, db });
    } catch (err) {
      console.error(`[daemon] dm check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  logEvent("daemon", "online", "Daemon started; watching for trades, auth and the weekly schedule.");
  console.log(`[daemon] polling every ${POLL_INTERVAL_MS / 1000}s, db=${DB_PATH}`);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] poll error: ${msg}`);
      logEvent("daemon", "poll-error", msg);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

main();
