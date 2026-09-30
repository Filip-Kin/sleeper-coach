// A hard rail on automatic drops, independent of whatever decided to drop.
//
// On 2026-09-19 reconcileRoster miscounted the roster cap and cut three
// receivers in four minutes: one every 90-second poll, each one "correct"
// according to the arithmetic it was given. The arithmetic is fixed, but the
// shape of that failure is the thing to defend against, not the specific bug.
// Any automatic process that can delete a player, running on a loop, will
// eventually delete several.
//
// So the rail is dumb on purpose and knows nothing about roster maths:
//
//   1. One automatic drop per COOLDOWN. A second one inside the window is
//      DEFERRED: refused now, retried by the caller after the window. It is
//      not a freeze. On 2026-09-30 two IR activations two minutes apart were
//      both legitimate (two players healed in the same news cycle); the
//      second one just had to wait an hour.
//   2. At most DAILY_LIMIT automatic drops in 24 hours. Past that the coach
//      stops dropping until a human looks (verdict.freeze), because a slow
//      drip of "one more" is the cascade in a different coat.
//
// A legitimate over-cap fix needs exactly one drop and then the roster is
// legal, so a correct coach never notices this rail exists. Only AUTOMATIC
// drops count: a trade give, a filed claim (Wednesday may or may not process
// it) and a manual run are recorded for history but never trip the breaker.

export const COOLDOWN_MS = Number(process.env.DROP_COOLDOWN_MS ?? 60 * 60 * 1000);
export const DAILY_LIMIT = Number(process.env.DROP_DAILY_LIMIT ?? 3);
const DAY_MS = 24 * 60 * 60 * 1000;

/** The `via` values that are the coach acting on its own and so count toward
 *  the breaker. Everything else ("trade", "claim", "manual", a test's "test")
 *  is history only. */
export const AUTOMATIC_VIA: ReadonlySet<string> = new Set(["reconcile", "ir-activate", "free-add", "stream"]);
export function countsTowardBreaker(via: string | undefined): boolean {
  return via === undefined || AUTOMATIC_VIA.has(via);
}
/** The rows the breaker and the `drops` invariant look at. */
export function automaticDrops<T extends { via?: string }>(history: T[]): T[] {
  return history.filter((d) => countsTowardBreaker(d.via));
}

export interface DropRecord { name: string; at: number; via?: string }

export interface GuardVerdict {
  allowed: boolean;
  reason: string;
  /** True when the refusal is the daily limit: the coach should stop dropping
   *  until a human looks, rather than simply skip this one. */
  freeze: boolean;
  /** For a cooldown deferral: when the caller may try again. */
  retryAt?: number;
}

/** May we drop right now, given what we have already dropped? Pure. */
export function mayDrop(history: DropRecord[], now: number): GuardVerdict {
  const counted = automaticDrops(history);
  const today = counted.filter((d) => now - d.at < DAY_MS);
  if (today.length >= DAILY_LIMIT) {
    return {
      allowed: false,
      freeze: true,
      reason: `${today.length} automatic drops in the last 24h (limit ${DAILY_LIMIT}): ${today.map((d) => d.name).join(", ")}; drops are frozen until DROP_FREEZE is removed`,
    };
  }
  const recent = counted.filter((d) => now - d.at < COOLDOWN_MS);
  if (recent.length) {
    const last = recent.reduce((a, b) => (a.at > b.at ? a : b));
    const mins = Math.round((now - last.at) / 60_000);
    const retryAt = last.at + COOLDOWN_MS;
    return {
      allowed: false,
      freeze: false,
      retryAt,
      reason: `dropped ${last.name} ${mins} min ago; one automatic drop per ${Math.round(COOLDOWN_MS / 60_000)} min, deferred until ${new Date(retryAt).toISOString()}`,
    };
  }
  return { allowed: true, freeze: false, reason: "" };
}
