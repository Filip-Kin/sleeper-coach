// Players spoken for by our own pending moves: the waiver claims we have
// filed and the trades we have agreed to.
//
// A claim names an add and, usually, a drop. Until Wednesday processes it,
// both are committed: the add must not be planned again (a second claim for
// the same player is a wasted priority), and the drop must not be handed to
// another move (two moves dropping one man leaves the second one refused, or
// worse, dropping someone else to make room). pendingClaimSlots in league/api
// counts the slots; this reads the players.
//
// A trade of ours binds its legs the same way (2026-11-09): while an offer
// we sent is live (status proposed, we the lone consenter, not expired) or a
// trade we accepted sits in review (every roster consented, Sleeper's status
// pending), every player we give in it is still ours and still on the active
// roster, and Sleeper voids a trade whose player has left. A free add after
// the cheapest cut, a stream's cut, a reserve cut or a hand `add` would have
// taken Shakir, a leg of the live +13 offer, for a +1 bench swap. So the
// legs ride the same never-drop list the claim drops do, and the reason
// names the transaction. An offer the rival rejects, or that expires, frees
// them on the next read; a trade not yet agreed by the other side binds
// nothing of theirs and, until we consent, nothing of ours.

import { config } from "../config.ts";
import { legsToScan, offerLive, TX_DEAD } from "../sleeper/rules.ts";
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

/** A player we give in a live trade of ours: an offer we sent that is still
 *  open, or a trade we accepted that is in review. */
export interface TradeGive {
  playerId: string;
  transactionId: string;
  /** Sleeper's status: `proposed` (awaiting the other side) or `pending` (agreed, in review). */
  status: string;
  leg: number;
}

export interface PendingClaims {
  adds: string[];
  /** Every player of ours committed to leave: the drop side of each pending
   *  claim and every leg we give in a live trade (`tradeGives`). The one
   *  list every cut path reads. */
  drops: string[];
  /** Claims with no drop attached, each of which needs a free slot. */
  slotsNeeded: number;
  claims: PendingClaim[];
  /** The legs we give in live trades, with the transaction each is held for. */
  tradeGives: TradeGive[];
}

/** What a caller gets when the read fails: nothing held, nothing seated. */
export const NO_PENDING: PendingClaims = { adds: [], drops: [], slotsNeeded: 0, claims: [], tradeGives: [] };

// #region pure
/** `rows` are the GraphQL transaction rows; a row may carry `leg` (the io
 *  layer tags each row with the leg it was read under). Waiver rows are our
 *  claims; trade rows we have consented to and that are still live
 *  (rules.ts offerLive) give their legs of ours. */
export function parsePendingClaims(rows: Record<string, unknown>[], rosterId: number, now = Date.now()): PendingClaims {
  const adds = new Set<string>();
  const drops = new Set<string>();
  const seen = new Set<string>();
  const claims: PendingClaim[] = [];
  const tradeGives: TradeGive[] = [];
  let slotsNeeded = 0;
  for (const t of rows) {
    if (!((t.roster_ids as number[] | null) ?? []).includes(rosterId)) continue;
    const id = String(t.transaction_id ?? "");
    if (seen.has(id)) continue;
    const ourDrops = Object.entries((t.drops as Record<string, number> | null) ?? {}).filter(([, r]) => r === rosterId).map(([p]) => p);
    if (t.type === "trade") {
      // Only a trade WE have agreed to binds our legs: the proposer is a
      // consenter from the moment the offer is sent (rules.ts tradeInFlight),
      // so our own offers and the inbound ones we accepted are consented;
      // an inbound offer not yet answered is not.
      if (!((t.consenter_ids as number[] | null) ?? []).includes(rosterId)) continue;
      const status = String(t.status ?? "").toLowerCase();
      const settings = (t.settings as { expires_at?: unknown } | null) ?? null;
      const expiresAt = typeof settings?.expires_at === "number" ? settings.expires_at : null;
      // An open offer dies by status or by its expiry. A trade every side
      // has agreed to (status pending, in review) dies by status only: its
      // expires_at is the offer's, which review can outlive (an offer taken
      // on its last day plus two review days), and once processed or vetoed
      // it leaves these statuses on its own.
      const live = status === "proposed" ? offerLive({ status, created: Number(t.created ?? 0), expiresAt }, now) : !TX_DEAD.has(status);
      if (!live) continue;
      seen.add(id);
      for (const p of ourDrops) {
        drops.add(p);
        tradeGives.push({ playerId: p, transactionId: id, status, leg: Number(t.leg ?? 0) });
      }
      continue;
    }
    if (t.type !== "waiver") continue;
    seen.add(id);
    const ourAdds = Object.entries((t.adds as Record<string, number> | null) ?? {}).filter(([, r]) => r === rosterId).map(([p]) => p);
    for (const p of ourAdds) adds.add(p);
    for (const p of ourDrops) drops.add(p);
    const seats = Math.max(0, ourAdds.length - ourDrops.length);
    slotsNeeded += seats;
    claims.push({ transactionId: id, leg: Number(t.leg ?? 0), adds: ourAdds, drops: ourDrops, seats });
  }
  return { adds: [...adds], drops: [...drops], slotsNeeded, claims, tradeGives };
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

/** The claim drops alone (`drops` less the trade legs), for a report line. */
export function claimDropsOf(pending: Pick<PendingClaims, "drops" | "tradeGives">): string[] {
  return pending.drops.filter((id) => !pending.tradeGives.some((g) => g.playerId === id));
}

/** Why a committed player may not be cut, for the rails' reason text
 *  (rails.ts canDrop) and the hand tool. A trade leg names its transaction;
 *  a claim's drop is spoken for by the claim. */
export function heldReason(playerId: string, pending: Pick<PendingClaims, "tradeGives">): string | null {
  const give = pending.tradeGives.find((g) => g.playerId === playerId);
  if (give) return `he is a leg of our live trade ${give.transactionId} (${give.status}); he leaves in it, not in a cut, until it processes or dies`;
  return null;
}

/** The rails with every committed player on the never-drop list, by name,
 *  so no other move can pick him: the drop side of each pending claim and
 *  every leg we give in a live trade. He stays on the roster for lineup
 *  maths because he is still ours until the move processes. The reason
 *  travels with the name (RailConfig.neverDropWhy), so a refusal says which
 *  transaction holds him. */
export function railsWithPendingDrops(rails: RailConfig, roster: RailPlayer[], pending: Pick<PendingClaims, "drops" | "tradeGives">): RailConfig {
  if (!pending.drops.length) return rails;
  const ids = new Set(pending.drops);
  const held = roster.filter((p) => p.playerId && ids.has(p.playerId));
  const why: Record<string, string> = { ...(rails.neverDropWhy ?? {}) };
  for (const p of held) {
    const r = heldReason(p.playerId!, pending) ?? "he is the drop of our pending waiver claim and is spoken for until it processes";
    why[p.name.toLowerCase()] = r;
  }
  return { ...rails, neverDrop: [...rails.neverDrop, ...held.map((p) => p.name)], neverDropWhy: why };
}
// #endregion

// #region io
function numericId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}

/** The statuses that can hold a move of ours: a claim is `pending` or
 *  `processing`; a trade is `proposed` until the other side answers and
 *  `pending` once every roster has consented and it sits in review. */
const HELD_STATUSES = ["pending", "processing", "proposed"] as const;

export async function pendingClaimPlayers(
  gql: Gql, leg: number, rosterId = config.rosterId, leagueId = config.leagueId, now = Date.now(),
): Promise<PendingClaims> {
  const rows: Record<string, unknown>[] = [];
  for (const status of HELD_STATUSES) for (const l of legsToScan(leg)) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${numericId(leagueId)}",status:"${status}",leg:${l})` +
      `{transaction_id status type roster_ids consenter_ids adds drops created settings}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const raw = ((body.data as Record<string, unknown> | undefined)?.league_transactions_by_status ?? []) as Record<string, unknown>[];
    // The leg the row was read under: a cancel must name it.
    rows.push(...raw.map((t) => ({ ...t, leg: l })));
  }
  return parsePendingClaims(rows, rosterId, now);
}
// #endregion
