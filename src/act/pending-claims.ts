// Players spoken for by our own pending waiver claims.
//
// A claim names an add and, usually, a drop. Until Wednesday processes it,
// both are committed: the add must not be planned again (a second claim for
// the same player is a wasted priority), and the drop must not be handed to
// another move (two moves dropping one man leaves the second one refused, or
// worse, dropping someone else to make room). pendingClaimSlots in league/api
// counts the slots; this reads the players.

import { config } from "../config.ts";
import { legsToScan } from "../sleeper/rules.ts";
import type { Gql } from "../league/api.ts";
import type { RailConfig, RailPlayer } from "../analysis/rails.ts";

export interface PendingClaims {
  adds: string[];
  drops: string[];
  /** Claims with no drop attached, each of which needs a free slot. */
  slotsNeeded: number;
}

// #region pure
export function parsePendingClaims(rows: Record<string, unknown>[], rosterId: number): PendingClaims {
  const adds = new Set<string>();
  const drops = new Set<string>();
  const seen = new Set<string>();
  let slotsNeeded = 0;
  for (const t of rows) {
    if (t.type !== "waiver") continue;
    if (!((t.roster_ids as number[] | null) ?? []).includes(rosterId)) continue;
    const id = String(t.transaction_id ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const ourAdds = Object.entries((t.adds as Record<string, number> | null) ?? {}).filter(([, r]) => r === rosterId).map(([p]) => p);
    const ourDrops = Object.entries((t.drops as Record<string, number> | null) ?? {}).filter(([, r]) => r === rosterId).map(([p]) => p);
    for (const p of ourAdds) adds.add(p);
    for (const p of ourDrops) drops.add(p);
    if (ourAdds.length > ourDrops.length) slotsNeeded += ourAdds.length - ourDrops.length;
  }
  return { adds: [...adds], drops: [...drops], slotsNeeded };
}

export function withoutPendingAdds<T extends { playerId: string }>(pool: T[], adds: string[]): T[] {
  if (!adds.length) return pool;
  const gone = new Set(adds);
  return pool.filter((p) => !gone.has(p.playerId));
}

/** The rails with every pending drop on the never-drop list, by name, so no
 *  other move can pick him. He stays on the roster for lineup maths because
 *  he is still ours until Wednesday. */
export function railsWithPendingDrops(rails: RailConfig, roster: RailPlayer[], dropIds: string[]): RailConfig {
  if (!dropIds.length) return rails;
  const ids = new Set(dropIds);
  const names = roster.filter((p) => p.playerId && ids.has(p.playerId)).map((p) => p.name);
  return { ...rails, neverDrop: [...rails.neverDrop, ...names] };
}
// #endregion

// #region io
function numericId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}

export async function pendingClaimPlayers(
  gql: Gql, leg: number, rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<PendingClaims> {
  const rows: Record<string, unknown>[] = [];
  for (const status of ["pending", "processing"]) for (const l of legsToScan(leg)) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${numericId(leagueId)}",status:"${status}",leg:${l})` +
      `{transaction_id status type roster_ids adds drops}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const raw = ((body.data as Record<string, unknown> | undefined)?.league_transactions_by_status ?? []) as Record<string, unknown>[];
    rows.push(...raw);
  }
  return parsePendingClaims(rows, rosterId);
}
// #endregion
