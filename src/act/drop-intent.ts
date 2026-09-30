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
  /** Forget intents older than maxAgeMs, and every intent under `prefix` other than `keep`
   *  (the decision changed, so the old one no longer counts). */
  settle(prefix: string, keep: string, now: number, maxAgeMs = MAX_AGE_MS): void {
    const all = this.read();
    for (const [k, v] of Object.entries(all)) {
      if (now - v.firstSeen > maxAgeMs || (k.startsWith(prefix) && k !== keep)) delete all[k];
    }
    this.write(all);
  }
  all(): DropIntent[] { return Object.values(this.read()); }
}
