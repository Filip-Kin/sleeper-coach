// Sleeper's answer to a claim it will not take: "The time to claim this
// player has passed. Please wait for waivers to clear in a few minutes."
//
// Will Reichard, MIN on bye in week 6, never dropped: the claim was refused
// six times between Friday 2026-10-16 14:02 ET and Sunday 12:26, each one an
// exit-1 run, an alert row and an incident session, and each time the next
// league drop had the react run file the same claim again. The schedule rule
// (sleeper/rules.ts waiverState "locked") keeps a bye team's men out of the
// claim plan; this table is the write-time fallback for when that rule is
// wrong about a man: Sleeper said no, so he is locked until the next clear
// (act/waiver-status.ts nextWaiverRunAt), and no run files him again before
// it. Like the drop ledger, one SQLite table in coach.db, read by the spawned
// waiver-run and the daemon alike.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../paths.ts";

export const CLAIM_LOCKED_RE = /time to claim this player has passed/i;

let db: Database | null = null;
function open(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS claim_locks (
    player_id TEXT PRIMARY KEY,
    until INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  return db;
}

export interface ClaimLock { playerId: string; until: number; reason: string; at: number }

/** Sleeper refused a claim for this man as past its time: no claim and no
 *  add for him until `until` (the next weekly clear). */
export function lockClaim(playerId: string, until: number, reason: string, at = Date.now()): void {
  open().run("INSERT OR REPLACE INTO claim_locks (player_id, until, reason, at) VALUES (?, ?, ?, ?)", [playerId, until, reason, at]);
}
/** When his lock ends, or null when he is not locked now. */
export function claimLockedUntil(playerId: string, now = Date.now()): number | null {
  const row = open().query<{ until: number }, [string]>("SELECT until FROM claim_locks WHERE player_id = ?").get(playerId);
  return row && row.until > now ? row.until : null;
}
/** Every lock still running. */
export function claimLocks(now = Date.now()): ClaimLock[] {
  return (open().query<{ player_id: string; until: number; reason: string; at: number }, [number]>("SELECT player_id, until, reason, at FROM claim_locks WHERE until > ? ORDER BY until").all(now))
    .map((r) => ({ playerId: r.player_id, until: r.until, reason: r.reason, at: r.at }));
}

/** Tests delete the scratch database between cases; the open handle must go
 *  with it. Never called in production. */
export function resetClaimLocksForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetClaimLocksForTests is for tests only");
  db?.close();
  db = null;
}
