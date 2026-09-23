import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isStagingTarget } from "./config.ts";
import { DB_PATH } from "./paths.ts";

// Home Assistant push notifications. Wired via env at deploy time:
//   HA_NOTIFY_URL  e.g. https://ha.filipkin.com/api/services/notify/mobile_app_x
//   HA_TOKEN       a long-lived HA access token
// If unset, alerts just log, so the daemon runs fine in development.
//
// Every alert is RECORDED before it is sent, in an `alerts` table in coach.db,
// so a push that never arrived (HA down, phone off, the hourly budget spent)
// is still on the record and still shows up in the next digest. Two levels:
//
//   now     pushes immediately, subject to a budget of NOW_BUDGET_PER_HOUR. The
//           2026-09-19 drop cascade produced dozens of pushes in minutes and
//           the useful one (the self-freeze) was buried. When the budget is
//           spent, ONE "muted for an hour" push goes out and nothing else until
//           the hour rolls over. The rows are still written.
//   digest  never pushes. Collected into one 09:00 ET push by sendDigest(),
//           which the schedule's `alert-digest` job calls. For things Filip
//           wants to know about but not be woken for: a stale-IR notice, a
//           skipped free-agent pass, a token inside its warning window.
//
// A process pointed at the staging league never pushes to Filip's phone. On
// 2026-09-20 a verification run against staging sent "IR opportunity: Jayden
// Daniels" three times and a failed add for a player who is not on his team.

export type AlertLevel = "now" | "digest";
export interface AlertOptions {
  level?: AlertLevel;
  /** A stable name for the condition ("token-expiry", "invariant:roster-legal").
   *  Recorded so the digest can group repeats and so callers can dedupe. */
  key?: string;
}

export const NOW_BUDGET_PER_HOUR = Number(process.env.ALERT_BUDGET_PER_HOUR ?? 10);
const HOUR_MS = 60 * 60 * 1000;
/** The row the budget writes when it mutes, so the mute itself is on record
 *  and is sent exactly once per hour. */
export const MUTE_KEY = "__muted__";

export interface AlertRow {
  id: number;
  ts: number;
  level: AlertLevel;
  title: string;
  message: string;
  key: string | null;
  /** 1 when a push actually went out (or would have, on staging). */
  sent: number;
}

// #region store (pure over a Database handle; the tests hand in a temp one)
export function ensureAlertTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    key TEXT,
    sent INTEGER NOT NULL DEFAULT 0
  )`);
  db.run("CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts)");
}

export function recordAlert(db: Database, a: { ts: number; level: AlertLevel; title: string; message: string; key?: string }): number {
  ensureAlertTables(db);
  db.run("INSERT INTO alerts (ts, level, title, message, key, sent) VALUES (?, ?, ?, ?, ?, 0)",
    [a.ts, a.level, a.title, a.message, a.key ?? null]);
  const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
  return row?.id ?? 0;
}

export function markSent(db: Database, id: number): void {
  db.run("UPDATE alerts SET sent = 1 WHERE id = ?", [id]);
}

/** "now" pushes that went out in the last hour, the mute row excluded. */
export function nowPushesLastHour(db: Database, now: number): number {
  ensureAlertTables(db);
  const row = db.query<{ n: number }, [number, string]>(
    "SELECT count(*) AS n FROM alerts WHERE level = 'now' AND sent = 1 AND ts > ? AND (key IS NULL OR key <> ?)",
  ).get(now - HOUR_MS, MUTE_KEY);
  return row?.n ?? 0;
}

/** Has the mute notice already gone out this hour? */
export function mutedThisHour(db: Database, now: number): boolean {
  const row = db.query<{ n: number }, [string, number]>(
    "SELECT count(*) AS n FROM alerts WHERE key = ? AND sent = 1 AND ts > ?",
  ).get(MUTE_KEY, now - HOUR_MS);
  return (row?.n ?? 0) > 0;
}

export type BudgetDecision = "push" | "mute-notice" | "silent";

/** Pure: what the budget lets a "now" alert do at this moment. */
export function budgetDecision(pushesThisHour: number, muteAlreadySent: boolean, budget = NOW_BUDGET_PER_HOUR): BudgetDecision {
  if (pushesThisHour < budget) return "push";
  return muteAlreadySent ? "silent" : "mute-notice";
}

/** Everything in the last hour, any level, for the invariant that watches
 *  for an alert storm. */
export function alertsLastHour(db: Database, now: number): number {
  ensureAlertTables(db);
  const row = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM alerts WHERE ts > ?").get(now - HOUR_MS);
  return row?.n ?? 0;
}

/** Rows a digest would cover: every digest-level row not yet sent, plus the
 *  "now" rows that were muted, so a busy hour still reaches Filip in the
 *  morning summary rather than vanishing. */
export function pendingDigest(db: Database): AlertRow[] {
  ensureAlertTables(db);
  return db.query<AlertRow, [string]>(
    "SELECT id, ts, level, title, message, key, sent FROM alerts WHERE sent = 0 AND (key IS NULL OR key <> ?) ORDER BY ts",
  ).all(MUTE_KEY);
}

export interface DigestText { title: string; message: string; count: number }

/** Pure: one push worth of text from the pending rows. Groups by key (or
 *  title when there is no key), counts repeats, quotes the first line of the
 *  most recent message of each group. */
export function composeDigest(rows: AlertRow[], maxLines = 8): DigestText | null {
  if (!rows.length) return null;
  const groups = new Map<string, { n: number; last: AlertRow }>();
  for (const r of rows) {
    const k = r.key ?? r.title;
    const g = groups.get(k);
    if (g) { g.n += 1; g.last = r; } else groups.set(k, { n: 1, last: r });
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.n - a.n || b.last.ts - a.last.ts)
    .slice(0, maxLines)
    .map((g) => {
      const first = g.last.message.split("\n")[0]?.trim() ?? "";
      const body = first ? `${g.last.title}: ${first}` : g.last.title;
      return g.n > 1 ? `${g.n}x ${body}` : body;
    });
  const more = groups.size > maxLines ? ` (+${groups.size - maxLines} more)` : "";
  return {
    title: `Digest: ${rows.length} alert${rows.length === 1 ? "" : "s"}`,
    message: lines.join("\n") + more,
    count: rows.length,
  };
}
// #endregion

// #region transport
async function pushHa(title: string, message: string): Promise<boolean> {
  const url = process.env.HA_NOTIFY_URL;
  const token = process.env.HA_TOKEN;
  const line = `[alert] ${title}: ${message}`;
  if (isStagingTarget) {
    console.log(`${line} (staging, not sent)`);
    return true;
  }
  if (!url || !token) {
    console.log(line);
    return true;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Coach: ${title}`, message }),
    });
    if (!res.ok) {
      console.error(`${line} (HA ${res.status})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${line} (HA send failed: ${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
// #endregion

// #region the module's database handle
let handle: Database | null = null;
function db(): Database {
  if (handle) return handle;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  handle = new Database(DB_PATH);
  ensureAlertTables(handle);
  return handle;
}
/** Tests point the module at a scratch database. Refused outside NODE_ENV=test. */
export function useAlertDbForTests(d: Database | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("useAlertDbForTests is for tests only");
  handle = d;
}
// #endregion

/** Record, then push if the level and the budget allow. Never throws; a
 *  broken database or a dead HA must never stop the caller acting. */
export async function sendAlert(title: string, message: string, opts: AlertOptions = {}): Promise<void> {
  const level: AlertLevel = opts.level ?? "now";
  const now = Date.now();
  let d: Database | null = null;
  let id = 0;
  try {
    d = db();
    id = recordAlert(d, { ts: now, level, title, message, key: opts.key });
  } catch (err) {
    console.error(`[alert] record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Every [alert] line a staging process prints carries the same suffix, so
  // the soak can assert "no [alert] line without it" and mean it.
  const suffix = isStagingTarget ? " (staging, not sent)" : "";
  if (level === "digest") {
    console.log(`[alert] (digest) ${title}: ${message}${suffix}`);
    return;
  }
  let decision: BudgetDecision = "push";
  if (d) {
    try {
      decision = budgetDecision(nowPushesLastHour(d, now), mutedThisHour(d, now));
    } catch {
      decision = "push";
    }
  }
  if (decision === "silent") {
    console.log(`[alert] (muted) ${title}: ${message}${suffix}`);
    return;
  }
  if (decision === "mute-notice") {
    console.log(`[alert] (muted) ${title}: ${message}${suffix}`);
    if (d) {
      const muteId = recordAlert(d, {
        ts: now, level: "now", key: MUTE_KEY, title: "Alerts muted for an hour",
        message: `${NOW_BUDGET_PER_HOUR} pushes in the last hour. Further alerts are recorded and go out in the morning digest. Check the dashboard.`,
      });
      if (await pushHa("Alerts muted for an hour", `${NOW_BUDGET_PER_HOUR} pushes in the last hour. The rest are in the morning digest.`)) markSent(d, muteId);
    }
    return;
  }
  const ok = await pushHa(title, message);
  if (ok && d && id) {
    try { markSent(d, id); } catch { /* recorded already */ }
  }
}

/** The 09:00 ET job: one push with counts and the notable lines, then the
 *  rows are marked sent so they are not repeated tomorrow. Returns what was
 *  sent, or null when there was nothing. */
export async function sendDigest(): Promise<DigestText | null> {
  const d = db();
  const rows = pendingDigest(d);
  const text = composeDigest(rows);
  if (!text) return null;
  const ok = await pushHa(text.title, text.message);
  if (ok) {
    const ids = rows.map((r) => r.id);
    d.run(`UPDATE alerts SET sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  return text;
}
