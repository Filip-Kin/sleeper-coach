// What to do with a write Sleeper refused.
//
// The lineup guard used to retry a refused plan every fifteen minutes and
// alert every time, so a roster Sleeper would not accept (a healed player
// still on IR, say) produced ninety alerts a day and no diagnosis. Now the
// refusal text is classified so the daemon can fix the cause, retries back off
// per distinct plan up to an hour, and each distinct plan alerts once a day.

import { RESERVE_INELIGIBLE_RE } from "../sleeper/rules.ts";

const MIN = 60_000;

export class FailureLedger {
  private entries = new Map<string, { count: number; nextAt: number; alertedAt: number }>();
  constructor(
    private readonly baseMs = 15 * MIN,
    private readonly capMs = 60 * MIN,
    private readonly alertEveryMs = 24 * 60 * MIN,
  ) {}

  shouldAttempt(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !e || now >= e.nextAt;
  }

  recordFailure(key: string, now: number): { alert: boolean; retryInMs: number; count: number } {
    const prev = this.entries.get(key);
    const count = (prev?.count ?? 0) + 1;
    const retryInMs = Math.min(this.capMs, this.baseMs * 2 ** (count - 1));
    const alert = !prev || now - prev.alertedAt >= this.alertEveryMs;
    this.entries.set(key, { count, nextAt: now + retryInMs, alertedAt: alert ? now : prev?.alertedAt ?? now });
    return { alert, retryInMs, count };
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}

export type LineupRefusal =
  | { kind: "reserve-ineligible" }
  | { kind: "locked"; playerId: string | null }
  | { kind: "other" };

/** Sleeper's refusal text, sorted into what the daemon can act on. */
export function classifyLineupRefusal(msg: string): LineupRefusal {
  if (RESERVE_INELIGIBLE_RE.test(msg)) return { kind: "reserve-ineligible" };
  if (/\block(ed|s)?\b/i.test(msg)) {
    const id = /\b(\d{3,})\b/.exec(msg)?.[1] ?? null;
    return { kind: "locked", playerId: id };
  }
  return { kind: "other" };
}
