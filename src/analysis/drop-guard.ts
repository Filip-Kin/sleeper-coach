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
//   1. One automatic drop per COOLDOWN. A second one inside the window is a
//      cascade, not a decision, and the coach freezes itself instead.
//   2. At most DAILY_LIMIT automatic drops in 24 hours.
//
// A legitimate over-cap fix needs exactly one drop and then the roster is
// legal, so a correct coach never notices this rail exists. Trades and manual
// runs are unaffected: this covers the automatic path only.

export const COOLDOWN_MS = Number(process.env.DROP_COOLDOWN_MS ?? 60 * 60 * 1000);
export const DAILY_LIMIT = Number(process.env.DROP_DAILY_LIMIT ?? 3);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DropRecord { name: string; at: number }

export interface GuardVerdict {
  allowed: boolean;
  reason: string;
  /** True when the refusal looks like a runaway loop and the coach should
   *  freeze itself rather than simply skip this one. */
  freeze: boolean;
}

/** May we drop right now, given what we have already dropped? Pure. */
export function mayDrop(history: DropRecord[], now: number): GuardVerdict {
  const recent = history.filter((d) => now - d.at < COOLDOWN_MS);
  if (recent.length) {
    const last = recent.reduce((a, b) => (a.at > b.at ? a : b));
    const mins = Math.round((now - last.at) / 60_000);
    return {
      allowed: false,
      freeze: true,
      reason: `dropped ${last.name} ${mins} min ago; a second automatic drop inside ${Math.round(COOLDOWN_MS / 60_000)} min is a cascade, not a decision`,
    };
  }
  const today = history.filter((d) => now - d.at < DAY_MS);
  if (today.length >= DAILY_LIMIT) {
    return {
      allowed: false,
      freeze: true,
      reason: `${today.length} automatic drops in the last 24h (limit ${DAILY_LIMIT}): ${today.map((d) => d.name).join(", ")}`,
    };
  }
  return { allowed: true, freeze: false, reason: "" };
}
