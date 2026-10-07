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

/** One claim of ours as Sleeper holds it, with the leg it was filed under
 *  (a cancel needs it). `seats` is the net active slots it takes when it
 *  lands: adds minus drops, never below zero. */
export interface PendingClaim {
  transactionId: string;
  leg: number;
  adds: string[];
  drops: string[];
  seats: number;
}

export interface PendingClaims {
  adds: string[];
  drops: string[];
  /** Claims with no drop attached, each of which needs a free slot. */
  slotsNeeded: number;
  claims: PendingClaim[];
}

// #region pure
/** `rows` are the GraphQL transaction rows; a row may carry `leg` (the io
 *  layer tags each row with the leg it was read under). */
export function parsePendingClaims(rows: Record<string, unknown>[], rosterId: number): PendingClaims {
  const adds = new Set<string>();
  const drops = new Set<string>();
  const seen = new Set<string>();
  const claims: PendingClaim[] = [];
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
    const seats = Math.max(0, ourAdds.length - ourDrops.length);
    slotsNeeded += seats;
    claims.push({ transactionId: id, leg: Number(t.leg ?? 0), adds: ourAdds, drops: ourDrops, seats });
  }
  return { adds: [...adds], drops: [...drops], slotsNeeded, claims };
}

/** A pending claim of ours that takes `seats` active slots when it lands,
 *  valued at the best rest-of-season value among its adds. */
export interface HeldClaim extends PendingClaim {
  value: number;
  names: string[];
}

/** The claims to cancel so that no more than `seatsFree` held seats remain:
 *  the least valuable first, whole claims, until the overflow is covered. */
export function claimsToCancel(held: HeldClaim[], seatsFree: number): HeldClaim[] {
  const seated = held.filter((c) => c.seats > 0);
  let over = seated.reduce((n, c) => n + c.seats, 0) - Math.max(0, seatsFree);
  if (over <= 0) return [];
  const out: HeldClaim[] = [];
  for (const c of [...seated].sort((a, b) => a.value - b.value || a.transactionId.localeCompare(b.transactionId))) {
    if (over <= 0) break;
    out.push(c);
    over -= c.seats;
  }
  return out;
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
    // The leg the row was read under: a cancel must name it.
    rows.push(...raw.map((t) => ({ ...t, leg: l })));
  }
  return parsePendingClaims(rows, rosterId);
}
// #endregion
