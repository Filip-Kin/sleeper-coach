// The durable ledger behind the drop circuit breaker. One SQLite table, opened
// by BOTH processes that can remove a player: the daemon (reconcile) and the
// spawned waiver-run (adds and claims with a drop). Before 2026-09-23 the table
// lived inside daemon.ts, so three of the four drop paths never saw it.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mayDrop, type DropRecord, type GuardVerdict } from "../analysis/drop-guard.ts";
import { DB_PATH } from "../paths.ts";

let db: Database | null = null;
function open(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS auto_drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dropped_at INTEGER NOT NULL,
    via TEXT NOT NULL DEFAULT 'reconcile'
  )`);
  try { db.run("ALTER TABLE auto_drops ADD COLUMN via TEXT NOT NULL DEFAULT 'reconcile'"); } catch { /* already there */ }
  return db;
}

export function dropHistory(): DropRecord[] {
  return (open().query("SELECT name, dropped_at FROM auto_drops ORDER BY dropped_at DESC LIMIT 50").all() as { name: string; dropped_at: number }[])
    .map((r) => ({ name: r.name, at: r.dropped_at }));
}
export function recordDrop(name: string, via: string, at = Date.now()): void {
  open().run("INSERT INTO auto_drops (name, dropped_at, via) VALUES (?, ?, ?)", [name, at, via]);
}
/** The breaker's verdict for a drop about to happen now. */
export function dropVerdict(now = Date.now()): GuardVerdict {
  return mayDrop(dropHistory(), now);
}
export class DropRefused extends Error {
  constructor(readonly verdict: GuardVerdict, readonly wanted: string[]) {
    super(`drop refused by the circuit breaker: ${verdict.reason}`);
    this.name = "DropRefused";
  }
}

/** Tests delete the scratch database between cases; the open handle must go
 *  with it or inserts land in an unlinked file. Never called in production. */
export function resetLedgerForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetLedgerForTests is for tests only");
  db?.close();
  db = null;
}
