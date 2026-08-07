import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { sleeper } from "./sleeper/client.ts";
import { runAgent } from "./agent/runner.ts";
import { sendAlert } from "./alert.ts";
import { logEvent } from "./log.ts";

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

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS seen_transactions (
  transaction_id TEXT PRIMARY KEY,
  status TEXT,
  first_seen INTEGER
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
}

function alreadyHandled(txId: string): boolean {
  return db.query("SELECT 1 FROM seen_transactions WHERE transaction_id = ?").get(txId) !== null;
}
function markSeen(txId: string, status: string): void {
  db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [txId, status, Date.now()]);
}

async function handlePendingTrade(tx: TransactionLike): Promise<void> {
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
const AUTH_CHECK_MS = Number(process.env.AUTH_CHECK_MS ?? 30 * 60 * 1000);
let lastAuthCheck = 0;
let lastAuthOk = true;

async function checkAuth(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "act", "login-check"], {
    cwd: "/app",
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const ok = (await proc.exited) === 0;
  if (!ok && lastAuthOk) {
    // This genuinely needs Filip: re-export/import a session. Ping the phone.
    await sendAlert("Sleeper login lost", "The coach's Sleeper session is no longer valid. Re-import a session so it can act on your team.");
  } else if (ok && !lastAuthOk) {
    logEvent("system", "auth-restored", "Sleeper session valid again.");
  }
  lastAuthOk = ok;
  lastAuthCheck = Date.now();
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
  logEvent("daemon", "online", "Daemon started; watching for trades and auth.");
  console.log(`[daemon] polling every ${POLL_INTERVAL_MS / 1000}s, db=${DB_PATH}`);
  for (;;) {
    try {
      await pollOnce();
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
