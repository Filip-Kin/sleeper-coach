import { existsSync } from "node:fs";

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

const FREEZE_FILE = process.env.COACH_FREEZE_FILE ?? "/data/sleeper-coach/FREEZE";

// Also honour an env freeze, for a dev/staging process that should never write.
function envFrozen(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.COACH_FREEZE ?? "");
}

export interface FreezeState {
  frozen: boolean;
  reason: string;
}

export function freezeState(): FreezeState {
  if (envFrozen()) return { frozen: true, reason: "COACH_FREEZE env is set" };
  if (existsSync(FREEZE_FILE)) return { frozen: true, reason: `kill-switch file present (${FREEZE_FILE})` };
  return { frozen: false, reason: "" };
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
