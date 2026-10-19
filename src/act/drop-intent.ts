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

export interface DropIntent {
  key: string;
  firstSeen: number;
  note: string;
  /** Set when the breaker's cooldown deferred the write after both looks
   *  agreed: the decision stands and is retried at this instant, not looked
   *  at a third time. A cooldown is a hold, not a changed decision. On
   *  2026-10-16 the Strange add passed its second look at 12:53, was
   *  deferred until 13:23, and was forgotten: no record, so the confirm
   *  loop never ran an adds-capable job, and roster 6 added him at 15:54. */
  retryAt?: number;
}
export type IntentDecision = { action: "record" } | { action: "wait"; readyAt: number } | { action: "go"; firstSeen: number };

/** When a recorded intent may be written: its second look, or the breaker's
 *  retry instant if that is later. */
export function intentDueAt(prev: DropIntent, minAgeMs = MIN_AGE_MS): number {
  return Math.max(prev.firstSeen + minAgeMs, prev.retryAt ?? 0);
}

/** Pure: what to do with a decision `key` seen now, given what was recorded. */
export function decideIntent(prev: DropIntent | null, now: number, minAgeMs = MIN_AGE_MS, maxAgeMs = MAX_AGE_MS): IntentDecision {
  if (!prev || now - prev.firstSeen > maxAgeMs) return { action: "record" };
  const readyAt = intentDueAt(prev, minAgeMs);
  if (now < readyAt) return { action: "wait", readyAt };
  return { action: "go", firstSeen: prev.firstSeen };
}

/** The intents a confirming run takes now: those past the minimum age, unless
 *  the last confirming run was under `throttleMs` ago AND every one of them
 *  was already due then (so that run saw it and could not write it: the
 *  throttle is for a write that keeps failing, not for a new decision). An
 *  intent that came due since the last run goes at once, which keeps a free
 *  add recorded before a Sunday kickoff from waiting out the throttle of a
 *  claim confirmed just before it. The daemon's two-hour backoff after three
 *  failed runs is a hold of its own (daemon.ts waiverConfirmHoldUntil), checked
 *  before this is asked, so it holds every intent, new or old. Pure. */
export function intentsToConfirm(
  intents: DropIntent[], now: number, lastConfirm: number, throttleMs: number, minAgeMs = MIN_AGE_MS, maxAgeMs = MAX_AGE_MS,
): DropIntent[] {
  const due = intents.filter((i) => decideIntent(i, now, minAgeMs, maxAgeMs).action === "go");
  if (!due.length) return [];
  // A deferred intent comes due at its retry instant, so one the breaker
  // held past the last run goes at once like any new decision.
  if (now - lastConfirm < throttleMs && due.every((i) => intentDueAt(i, minAgeMs) <= lastConfirm)) return [];
  return due;
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
  /** The breaker's cooldown refused a write whose two looks agreed: keep the
   *  decision as it was recorded (`intent` is the record the confirming run
   *  took, first look and all) and hold it until `retryAt`. The next
   *  confirming run after that instant re-plans from fresh data and writes
   *  if it reaches the same move; no third look, no new 30-minute wait. */
  defer(intent: DropIntent, retryAt: number): void {
    this.put({ ...(this.get(intent.key) ?? intent), retryAt });
  }
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
