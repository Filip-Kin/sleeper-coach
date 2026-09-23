// The daemon's pulse. One small file on the state volume, rewritten every poll
// with the time, the poll count and the pid. Two readers: the dashboard's
// /health route (web/server.ts) turns the file's age into 200 or 503 so an
// external monitor can page Filip when the loop has stopped, and the soak
// (src/soak/assert.ts) reads the poll count to prove the loop stayed alive for
// the whole run. A daemon that is up but wedged looks identical to a healthy
// one from `docker ps`; this is the difference.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HEARTBEAT_FILE } from "./paths.ts";

export interface Heartbeat {
  ts: string;
  poll: number;
  pid: number;
}

/** A heartbeat older than this means the poll loop is not running. Five
 *  minutes is three production polls (90 s each) plus slack for a slow Sleeper
 *  call; a single missed poll never pages anyone. */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

let polls = 0;

/** Called once per daemon poll. Never throws: a full disk must not take the
 *  loop down, it just makes /health go red, which is the right outcome. */
export function heartbeat(): void {
  polls += 1;
  const hb: Heartbeat = { ts: new Date().toISOString(), poll: polls, pid: process.pid };
  try {
    mkdirSync(dirname(HEARTBEAT_FILE), { recursive: true });
    // A plain write, not a temp-and-rename: the file is a few bytes and a
    // reader that hits a partial write sees invalid JSON, which readHeartbeat
    // treats the same as no file. The mtime is the signal that matters.
    writeFileSync(HEARTBEAT_FILE, JSON.stringify(hb));
  } catch (err) {
    console.error(`[heartbeat] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The last heartbeat, or null when there is none or it is unreadable. */
export function readHeartbeat(file = HEARTBEAT_FILE): Heartbeat | null {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Heartbeat>;
    if (typeof j.poll !== "number" || typeof j.ts !== "string") return null;
    return { ts: j.ts, poll: j.poll, pid: typeof j.pid === "number" ? j.pid : 0 };
  } catch {
    return null;
  }
}

/** Milliseconds since the file was last written, or null with no file. Uses
 *  the mtime rather than the JSON so a corrupt write still reports fresh. */
export function heartbeatAgeMs(now = Date.now(), file = HEARTBEAT_FILE): number | null {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export interface HealthVerdict {
  ok: boolean;
  status: 200 | 503;
  ageMs: number | null;
  body: string;
}

/** Pure: the /health answer for a given age. */
export function healthVerdict(ageMs: number | null, staleMs = HEARTBEAT_STALE_MS): HealthVerdict {
  if (ageMs === null) return { ok: false, status: 503, ageMs, body: "no heartbeat" };
  if (ageMs > staleMs) return { ok: false, status: 503, ageMs, body: `heartbeat ${Math.round(ageMs / 1000)}s old` };
  return { ok: true, status: 200, ageMs, body: `ok ${Math.round(ageMs / 1000)}s` };
}
