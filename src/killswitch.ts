import { existsSync, readFileSync } from "node:fs";

// The kill switch: a single file on the state volume that disables every write
// the coach can make. Filip can freeze the coach instantly without stopping the
// container or touching Coolify, and unfreeze it just as fast.
//
//   touch  /data/sleeper-coach/FREEZE     # coach makes no more writes
//   rm     /data/sleeper-coach/FREEZE     # writes resume
//
// This is deliberately a plain file check, not a config value or an env var: a
// frozen coach must be recoverable from a phone with nothing but a shell, and an
// env change would need a container restart, which is exactly the thing we are
// avoiding in-season. Every write path (lineup, add/drop, and trades once live)
// must call assertWritesAllowed() before it acts.
//
// There are TWO files, because there are two different things to stop:
//
//   FREEZE        a human (or the boot canary) decided the coach must not act.
//                 Blocks every write: lineups, reserve moves, claims, trades,
//                 drops, scheduled jobs. freezeState() reads this one and only
//                 this one.
//   DROP_FREEZE   the drop circuit breaker tripped. Blocks DROPS only. On
//                 2026-09-30 the breaker wrote FREEZE instead: a second IR
//                 activation two minutes after the first was refused (right),
//                 and then the lineup guard, the reserve reconciler and the
//                 Sunday locks all stopped too (wrong), with the roster left
//                 illegal. A runaway drop loop is a reason to stop dropping;
//                 it is not a reason to leave an empty slot on Sunday.
//                 dropFreezeState() reads BOTH files, since a human freeze
//                 also stops drops.
//
//   rm /data/sleeper-coach/DROP_FREEZE    # drops resume; nothing else changed

// Under `bun test` (NODE_ENV=test) the switch points at a scratch path. On
// 2026-09-19 a real freeze on the production volume made four draft write tests
// fail inside the container, because they read the live kill-switch file. Tests
// must never depend on production state, in either direction.
import { FREEZE_FILE, DROP_FREEZE_FILE } from "./paths.ts";
export { FREEZE_FILE, DROP_FREEZE_FILE };

// Also honour an env freeze, for a dev/staging process that should never write.
function envFrozen(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.COACH_FREEZE ?? "");
}

export interface FreezeState {
  frozen: boolean;
  reason: string;
}

/** The HUMAN kill switch. True stops every write the coach can make. */
export function freezeState(): FreezeState {
  if (envFrozen()) return { frozen: true, reason: "COACH_FREEZE env is set" };
  if (existsSync(FREEZE_FILE)) return { frozen: true, reason: `kill-switch file present (${FREEZE_FILE})` };
  return { frozen: false, reason: "" };
}

/** The BREAKER's marker alone: is DROP_FREEZE set? This is the question the
 *  `drop-freeze` invariant asks ("did the coach stop itself?"), and it must
 *  not include the human switch. On 2026-09-30 12:23Z the daemon booted while
 *  Filip's FREEZE was up for a fix, the invariant read dropFreezeState() (both
 *  files), logged `invariant-failed: drop-freeze` for a deliberate human stop,
 *  and the watcher woke an incident engineer for it. A human freeze is a
 *  state someone chose; only the breaker's own marker is a fault. */
export function breakerState(): FreezeState {
  if (existsSync(DROP_FREEZE_FILE)) {
    let why = "";
    try { why = readFileSync(DROP_FREEZE_FILE, "utf8").trim().split("\n")[0] ?? ""; } catch { /* the file is the fact; its text is a courtesy */ }
    return { frozen: true, reason: `drops frozen by the circuit breaker (${DROP_FREEZE_FILE})${why ? `: ${why}` : ""}` };
  }
  return { frozen: false, reason: "" };
}

/** May the coach DROP a player? No when the human switch is set, and no when
 *  the breaker has tripped. Lineup and reserve writes do not ask this. This is
 *  the WRITE gate; for "has the breaker tripped" use breakerState(). */
export function dropFreezeState(): FreezeState {
  const human = freezeState();
  if (human.frozen) return human;
  return breakerState();
}

// Throw if writes are currently disabled. Call this at the top of every write
// path, before any browser navigation, so a frozen coach stops loudly and early
// rather than part-way through a DOM mutation.
export function assertWritesAllowed(action: string): void {
  const s = freezeState();
  if (s.frozen) {
    throw new Error(`writes are FROZEN (${s.reason}); refusing to ${action}. Remove the freeze to re-enable.`);
  }
}

/** Freeze the coach from inside, when it detects it is misbehaving in a way
 *  that no single write path can be trusted. Writes the human switch, so it
 *  stops everything and only a human (or `rm`) lifts it. Nothing calls this
 *  today; the breaker and the drops invariant use dropFreezeNow. */
export async function freezeNow(reason: string): Promise<void> {
  await Bun.write(FREEZE_FILE, `${new Date().toISOString()} auto-frozen: ${reason}\n`);
}

/** Stop DROPS from inside. Used by the drop circuit breaker when the daily
 *  limit is exceeded, and by the `drops` invariant: a loop that wants to cut a
 *  player every 90 seconds must stop itself, not wait to be noticed. Lineups,
 *  reserve moves and scheduled jobs carry on. */
export async function dropFreezeNow(reason: string): Promise<void> {
  await Bun.write(DROP_FREEZE_FILE, `${new Date().toISOString()} drops auto-frozen: ${reason}\n`);
}
