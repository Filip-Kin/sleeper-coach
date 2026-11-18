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
  db.run(`CREATE TABLE IF NOT EXISTS claim_cancel_refusals (
    transaction_id TEXT PRIMARY KEY,
    adds TEXT NOT NULL,
    until INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  return db;
}

/** How long a claim whose cancel Sleeper refused as "past its time" is taken
 *  as about to process. Sleeper's own words are "wait for waivers to clear in
 *  a few minutes"; the Wednesday run has processed between 03:15 and 03:16 ET
 *  every week of 2026 and the refusals of 2026-11-18 came at 03:07 and 03:11.
 *  A claim still pending an hour on did not process and is a fault again. */
export const CANCEL_REFUSED_FOR_MS = 3_600_000;

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

/** A claim of ours the coach left without a seat and Sleeper would not
 *  cancel, with the instant until which that is a known state. */
export interface CancelRefusal { transactionId: string; adds: string[]; until: number; reason: string; at: number }

/** Sleeper's answer to a cancel, recorded when it is the same "time to claim
 *  has passed" (the pre-clear lock: the claim processes within minutes and,
 *  seatless, fails on its own). Any other failure is not recorded: that claim
 *  is seatless with no end in sight and the claim-slots invariant says so.
 *
 *  Wednesday 2026-11-18 03:07 ET: Smith came off injured reserve into the
 *  seat held for the no-drop Gesicki claim, the cancel was refused eight
 *  minutes before the clear, and at 03:08 claim-slots failed ("1 pending
 *  claim(s) with no drop need slots but only 0 open") and woke an engineer
 *  for a state the coach had chosen and could not improve. Returns whether
 *  the refusal was recorded. */
export function noteCancelRefused(transactionId: string, adds: string[], msg: string, at = Date.now()): boolean {
  if (!CLAIM_LOCKED_RE.test(msg)) return false;
  const d = open();
  // The first refusal sets the hour: a second refusal of the same claim (the
  // hand tool after the reconciler) must not extend it.
  d.run("INSERT OR IGNORE INTO claim_cancel_refusals (transaction_id, adds, until, reason, at) VALUES (?, ?, ?, ?, ?)", [transactionId, JSON.stringify(adds), at + CANCEL_REFUSED_FOR_MS, msg, at]);
  return true;
}
/** Every refused cancel still inside its hour. */
export function cancelRefusals(now = Date.now()): CancelRefusal[] {
  return open().query<{ transaction_id: string; adds: string; until: number; reason: string; at: number }, [number]>("SELECT transaction_id, adds, until, reason, at FROM claim_cancel_refusals WHERE until > ? ORDER BY until").all(now)
    .map((r) => ({ transactionId: r.transaction_id, adds: JSON.parse(r.adds) as string[], until: r.until, reason: r.reason, at: r.at }));
}

/** Tests delete the scratch database between cases; the open handle must go
 *  with it. Never called in production. */
export function resetClaimLocksForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetClaimLocksForTests is for tests only");
  db?.close();
  db = null;
}
