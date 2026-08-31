import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { sleeper } from "./sleeper/client.ts";
import { runAgent } from "./agent/runner.ts";
import { sendAlert } from "./alert.ts";
import { logEvent } from "./log.ts";
import { JOBS, isDue, type Job } from "./schedule.ts";
import { freezeState } from "./killswitch.ts";

// Long-running process the container execs. Mirrors the pit-podcast daemon
// shape: an infinite poll loop with durable SQLite state, each cycle wrapped so
// one failure alerts but never kills the loop. Its job is the *triggered*
// wakeup: notice a pending trade aimed at our roster and wake the agent to
// handle it. Scheduled deadline wakeups (lineups, waivers) are systemd timers
// (Phase E), not this loop.

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
const TRADES_ENABLED = /^(1|true|yes|on)$/i.test(process.env.TRADES_ENABLED ?? "");

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

interface TransactionLike {
  transaction_id: string;
  type: string;
  status: string;
  roster_ids?: number[];
  consenter_ids?: number[];
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
}

function alreadyHandled(txId: string): boolean {
  return db.query("SELECT 1 FROM seen_transactions WHERE transaction_id = ?").get(txId) !== null;
}
function markSeen(txId: string, status: string): void {
  db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [txId, status, Date.now()]);
}

// Name the players in an offer, so the notification is actionable rather than a
// transaction id. Falls back to the raw id if the player map cannot be loaded.
//
// Sleeper's `adds` and `drops` map player_id -> the roster_id that GAINS or LOSES
// that player, so a two-team trade lists BOTH directions in both maps. The first
// version of this ignored that and reported every player on both sides as ours:
// "we receive: A, B; we give up: A, B", which is worse than useless in an alert.
// Found by the trades session on 2026-08-30 before any real offer arrived.
async function describeTrade(tx: TransactionLike): Promise<string> {
  const side = async (m: Record<string, number> | null | undefined): Promise<string> => {
    const ids = Object.entries(m ?? {})
      .filter(([, rosterId]) => rosterId === config.rosterId)
      .map(([playerId]) => playerId);
    if (!ids.length) return "nothing";
    try {
      const { loadPlayers } = await import("./data/players.ts");
      const players = await loadPlayers();
      return ids
        .map((id) => {
          const p = (players as Record<string, { full_name?: string; position?: string }>)[id];
          return p?.full_name ? `${p.full_name}${p.position ? ` (${p.position})` : ""}` : id;
        })
        .join(", ");
    } catch {
      return ids.join(", ");
    }
  };
  return `we receive: ${await side(tx.adds)}; we give up: ${await side(tx.drops)}`;
}

async function handlePendingTrade(tx: TransactionLike): Promise<void> {
  if (!TRADES_ENABLED) {
    // Shadow mode. Do NOT spawn the agent: it holds the act CLI, and a run whose
    // only possible outcome is a thrown stub is noise, not a decision.
    //
    // We DO run the deterministic evaluation, because that is pure and writes
    // nothing, and an alert that says "reject, this costs 18 starting-lineup
    // points" is worth reading at 11pm whereas a list of names is not. It is
    // wrapped separately from the description so a failed projection fetch
    // degrades the alert rather than losing it.
    const what = await describeTrade(tx).catch(() => "could not read the offer");
    let verdict = "";
    try {
      const { evaluateTransactionForUs } = await import("./analysis/trade-live.ts");
      const res = await evaluateTransactionForUs(tx);
      verdict = res.summary;
    } catch (err) {
      verdict = `(could not evaluate: ${err instanceof Error ? err.message : String(err)})`;
    }
    logEvent("coach", "trade-shadow", `Pending trade ${tx.transaction_id} involves us; SHADOW MODE, acting on nothing. ${what}`, {
      transaction_id: tx.transaction_id,
      shadow: true,
      verdict,
    });
    await sendAlert(
      "Trade offer pending (coach is in shadow mode)",
      `${what}\n\n${verdict}\n\nThe coach will NOT respond. Handle it in Sleeper, or arm it once respondTrade's selectors are verified against a real offer.`,
    ).catch(() => {});
    markSeen(tx.transaction_id, "shadow");
    return;
  }

  // Trades are the coach's call, not Filip's — evaluate and decide autonomously.
  // Logged to the activity feed for watching; no phone ping (per Filip).
  logEvent("coach", "trade-offer", `Pending trade ${tx.transaction_id} involves us; evaluating.`, { transaction_id: tx.transaction_id });
  const prompt = `A pending trade (transaction id ${tx.transaction_id}) has been offered involving your roster (roster_id ${config.rosterId}). Investigate it with the coach CLI, evaluate it on the merits for winning the league, and either accept or reject it using the act CLI. Explain your reasoning as you go.`;
  const result = await runAgent({ prompt });
  db.run("INSERT INTO agent_runs (kind, ref, session_id, exit_code, started) VALUES (?, ?, ?, ?, ?)", [
    "trade", tx.transaction_id, result.sessionId, result.exitCode, Date.now(),
  ]);
  markSeen(tx.transaction_id, "handled");
  logEvent("coach", "trade-decided", `Handled trade ${tx.transaction_id}.`, { transaction_id: tx.transaction_id, reasoning: result.text.slice(0, 400) });
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
const JOB_COMMAND: Record<string, string[]> = {
  "lineup-thursday": ["bun", "run", "src/act/lineup-run.ts", "--live"],
  "lineup-sunday": ["bun", "run", "src/act/lineup-run.ts", "--live", "--refresh"],
  "inactive-sunday": ["bun", "run", "src/act/lineup-run.ts", "--live"],
  "inactive-monday": ["bun", "run", "src/act/lineup-run.ts", "--live"],
  "waiver-compute": ["bun", "run", "src/act/waiver-run.ts"],
  "waiver-submit": ["bun", "run", "src/act/waiver-run.ts"],
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

async function runDueJobs(): Promise<void> {
  if (draftActive()) return; // never fight a draft for the shared browser
  const now = Date.now();
  for (const job of JOBS) {
    const v = isDue(job, now, lastRunOf(job.name));
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
  const txns = (await sleeper.transactions(config.leagueId, round)) as TransactionLike[];

  for (const tx of txns) {
    const isTrade = tx.type === "trade";
    const isPending = tx.status === "pending";
    const involvesUs = (tx.roster_ids ?? []).includes(config.rosterId);
    if (isTrade && isPending && involvesUs && !alreadyHandled(tx.transaction_id)) {
      if (draftActive()) continue; // don't drive the browser mid-draft
      await handlePendingTrade(tx);
    }
  }
}

async function main(): Promise<void> {
  logEvent("daemon", "online", "Daemon started; watching for trades, auth and the weekly schedule.");
  console.log(`[daemon] polling every ${POLL_INTERVAL_MS / 1000}s, db=${DB_PATH}`);
  for (const j of JOBS) {
    console.log(`[schedule] ${j.name.padEnd(18)} ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][j.dow]} ${String(j.hour).padStart(2, "0")}:${String(j.minute).padStart(2, "0")} ET, usable up to ${Math.round(j.maxLateMs / 3600000)}h late`);
  }
  for (;;) {
    try {
      await pollOnce();
      await runDueJobs();
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
