// Two looks before any automatic drop.
//
// Nothing on Sleeper is urgent at 90-second resolution: a claim processes on
// its own schedule and a roster that is over the cap or holding a stale IR
// player is illegal for an hour just as it is for a minute. So no automatic
// drop happens on one read. The first poll that wants a cut records the exact
// decision (which player, why); a later poll, at least MIN_AGE_MS on, must
// reach the same decision from fresh data before the write goes out. A
// changed decision starts the clock again; a stale intent is forgotten.
//
// Filip, 2026-09-30: "Think through everything before you do it. Filing the
// claim now does not make any sense, you can file the claim in 2 hours and
// it will make no difference. So stop rushing changes."

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_DIR } from "../paths.ts";

export const MIN_AGE_MS = 30 * 60_000;
export const MAX_AGE_MS = 6 * 3_600_000;
/** Bookkeeping rows in the store: how often a decision under a prefix restarted. */
const RESTART_KEY = "__restarts__:";

export interface DropIntent { key: string; firstSeen: number; note: string }
export type IntentDecision = { action: "record" } | { action: "wait"; readyAt: number } | { action: "go"; firstSeen: number };

/** Pure: what to do with a decision `key` seen now, given what was recorded. */
export function decideIntent(prev: DropIntent | null, now: number, minAgeMs = MIN_AGE_MS, maxAgeMs = MAX_AGE_MS): IntentDecision {
  if (!prev || now - prev.firstSeen > maxAgeMs) return { action: "record" };
  if (now - prev.firstSeen < minAgeMs) return { action: "wait", readyAt: prev.firstSeen + minAgeMs };
  return { action: "go", firstSeen: prev.firstSeen };
}

export class DropIntentStore {
  constructor(private readonly path = `${STATE_DIR}/drop-intents.json`) {}
  private read(): Record<string, DropIntent> {
    try { return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, DropIntent>) : {}; } catch { return {}; }
  }
  private write(all: Record<string, DropIntent>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all, null, 1));
  }
  get(key: string): DropIntent | null { return this.read()[key] ?? null; }
  put(intent: DropIntent): void { const all = this.read(); all[intent.key] = intent; this.write(all); }
  delete(key: string): void { const all = this.read(); delete all[key]; this.write(all); }
  /** Forget intents older than maxAgeMs, and every intent under `prefix` other
   *  than `keep` (the decision changed, so the old one no longer counts).
   *  Returns how many times the decision under `prefix` has restarted within
   *  maxAgeMs, so a caller can notice a decision that never settles. */
  settle(prefix: string, keep: string, now: number, maxAgeMs = MAX_AGE_MS): number {
    const all = this.read();
    let changed = 0;
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(RESTART_KEY)) continue;
      if (now - v.firstSeen > maxAgeMs) { delete all[k]; continue; }
      if (k.startsWith(prefix) && k !== keep) { delete all[k]; changed++; }
    }
    const rk = `${RESTART_KEY}${prefix}`;
    const prev = all[rk];
    const count = prev && now - prev.firstSeen <= maxAgeMs ? Number(prev.note) + changed : changed;
    if (count > 0) all[rk] = { key: rk, firstSeen: prev && now - prev.firstSeen <= maxAgeMs ? prev.firstSeen : now, note: String(count) };
    else delete all[rk];
    this.write(all);
    return count;
  }
  /** The decision under `prefix` is moot (the player it was about has been
   *  moved another way): drop every intent under it and its restart row.
   *  Without this a recorded intent outlives its cause for MAX_AGE_MS; on
   *  2026-10-07 "drop Croskey-Merritt for Dowdle" sat in the store after
   *  Dowdle had come off IR into a free seat. */
  forget(prefix: string): void {
    const all = this.read();
    for (const k of Object.keys(all)) if (k.startsWith(prefix) || k === `${RESTART_KEY}${prefix}`) delete all[k];
    this.write(all);
  }
  /** Every real intent (bookkeeping rows excluded). */
  all(): DropIntent[] { return Object.values(this.read()).filter((i) => !i.key.startsWith(RESTART_KEY)); }
}
