// Reacting to a drop anywhere in the league, with the bookkeeping in the right
// order: a drop is marked reacted only once the claim run has EXITED 0. Before
// 2026-09-23 the ids were recorded first "so a failing evaluation cannot loop",
// which meant a crashed run, or one skipped inside the cooldown, buried the
// drop for good. The cooldown still bounds the retry rate.

import { unreactedDrops } from "../analysis/waivers.ts";

export const DROP_REACTION_COOLDOWN_MS = 20 * 60 * 1000;

export interface DropReactArgs {
  txns: { transaction_id?: string; drops?: Record<string, number> | null }[];
  alreadyReacted: (id: string) => boolean;
  markReacted: (id: string) => void;
  now: number;
  lastReaction: number;
  frozen: boolean;
  /** Spawn the claim run; resolve with its exit code. */
  run: () => Promise<number>;
}

export async function reactToDropsCore(a: DropReactArgs): Promise<{ ran: boolean; fresh: string[]; code: number | null }> {
  const fresh = unreactedDrops(a.txns, a.alreadyReacted);
  if (!fresh.length) return { ran: false, fresh, code: null };
  if (a.now - a.lastReaction < DROP_REACTION_COOLDOWN_MS) return { ran: false, fresh, code: null };
  if (a.frozen) return { ran: false, fresh, code: null };
  const code = await a.run();
  if (code === 0) for (const id of fresh) a.markReacted(id);
  return { ran: true, fresh, code };
}
