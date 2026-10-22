// The result of a waiver claim of ours, logged once from the transaction list.
//
// A claim is a deferred roster move: Sleeper resolves it at the clear
// (Wednesday ~03:15 ET, or ~47 h after a league drop) and the roster changes
// with no write of ours. On 2026-10-21 the Bo Nix for Jacksonville claim
// landed and the only trace in activity.jsonl was the lineup guard's starter
// swap; the daily review read the window as "no move" and skipped. A lost
// claim left even less. Every roster change of ours is an event, so the daemon
// reads the REST transaction list each poll (this leg and the last, see
// sleeper/rules.ts legsToScan) and logs each waiver transaction of ours that
// has reached `complete` or `failed`, once, keyed `claim:<id>` in the durable
// seen_transactions table. The list is Sleeper's own record, so a claim filed
// by hand in the app is logged the same as one the engine filed.
//
// Event names start with `claim-` so the review harness counts them.

export const CLAIM_SEEN_PREFIX = "claim:";
export const CLAIM_LANDED = "claim-landed";
export const CLAIM_LOST = "claim-lost";

/** A row of GET /league/<id>/transactions/<leg>, the fields this reads. */
export interface WaiverTxn {
  transaction_id?: string;
  type?: string;
  status?: string;
  roster_ids?: number[] | null;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  metadata?: { notes?: string | null } | null;
  status_updated?: number | null;
  created?: number | null;
  leg?: number | null;
}

export interface ClaimResult {
  transactionId: string;
  leg: number | null;
  landed: boolean;
  add: string | null;
  drop: string | null;
  /** Sleeper's own note ("Your waiver claim was processed successfully!",
   *  "This player was claimed by another owner.", "...too many players..."). */
  notes: string;
  /** When Sleeper processed it (status_updated), ms. */
  at: number | null;
  /** On a loss: the roster whose claim for the same man landed, if one did. */
  winnerRosterId: number | null;
}

export function claimSeenKey(transactionId: string): string {
  return `${CLAIM_SEEN_PREFIX}${transactionId}`;
}

// #region pure
const ours = (t: WaiverTxn, rosterId: number): boolean => (t.roster_ids ?? []).includes(rosterId);
const addOf = (t: WaiverTxn, rosterId: number): string | null =>
  Object.entries(t.adds ?? {}).find(([, rid]) => rid === rosterId)?.[0] ?? null;
const dropOf = (t: WaiverTxn, rosterId: number): string | null =>
  Object.entries(t.drops ?? {}).find(([, rid]) => rid === rosterId)?.[0] ?? null;

/** Who took the man our claim named: another roster's landed waiver claim for
 *  the same player, processed in the same batch (every claim of one clear
 *  shares one status_updated to the millisecond). A landed claim from another
 *  batch is a different week's story, never the winner. */
function winnerOf(lost: WaiverTxn, add: string | null, rosterId: number, txns: WaiverTxn[]): number | null {
  if (!add || lost.status_updated == null) return null;
  const w = txns.find((t) =>
    t.type === "waiver" && t.status === "complete" && !ours(t, rosterId) && Object.hasOwn(t.adds ?? {}, add)
    && t.status_updated === lost.status_updated);
  if (!w) return null;
  const rid = (w.adds ?? {})[add];
  return typeof rid === "number" ? rid : null;
}

/** Every waiver claim of ours in `txns` that Sleeper has resolved and we have
 *  not logged, oldest first. Pending claims and free-agent adds are not here:
 *  a pending claim has no result yet, and an add is logged when we write it. */
export function claimResults(txns: WaiverTxn[], rosterId: number, alreadySeen: (key: string) => boolean): ClaimResult[] {
  const out: ClaimResult[] = [];
  const seen = new Set<string>();
  for (const t of txns) {
    if (t.type !== "waiver" || !ours(t, rosterId)) continue;
    if (t.status !== "complete" && t.status !== "failed") continue;
    const id = String(t.transaction_id ?? "");
    if (!id || seen.has(id) || alreadySeen(claimSeenKey(id))) continue;
    seen.add(id);
    const add = addOf(t, rosterId);
    const landed = t.status === "complete";
    out.push({
      transactionId: id,
      leg: typeof t.leg === "number" ? t.leg : null,
      landed,
      add,
      drop: dropOf(t, rosterId),
      notes: String(t.metadata?.notes ?? ""),
      at: typeof t.status_updated === "number" ? t.status_updated : null,
      winnerRosterId: landed ? null : winnerOf(t, add, rosterId, txns),
    });
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.transactionId.localeCompare(b.transactionId));
}

export function fmtEt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(/,/g, "") + " ET";
}
// #endregion

export interface LogClaimResultsArgs {
  txns: WaiverTxn[];
  rosterId: number;
  alreadySeen: (key: string) => boolean;
  /** Durable; called before the event is written so a restart cannot log twice. */
  markSeen: (key: string, status: string) => void;
  log: (type: string, summary: string, detail: Record<string, unknown>) => void;
  /** Player id to display name; may throw, the id is used then. */
  nameOf: (playerId: string) => Promise<string>;
  /** Roster id to the manager's display name; may throw. */
  managerOf: (rosterId: number) => Promise<string>;
  /** Our waiver priority after the clear, `{ position, of }`; may throw. */
  waiverPosition: () => Promise<{ position: number; of: number } | null>;
}

const quiet = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };

/** Log each unlogged result once: `claim-landed` (add, drop, transaction,
 *  processed time, the new priority) or `claim-lost` (add, drop, Sleeper's
 *  note, who won him). Returns the results it logged. */
export async function logClaimResults(a: LogClaimResultsArgs): Promise<ClaimResult[]> {
  const results = claimResults(a.txns, a.rosterId, a.alreadySeen);
  if (!results.length) return results;
  const priority = results.some((r) => r.landed) ? await quiet(a.waiverPosition, null) : null;
  for (const r of results) {
    a.markSeen(claimSeenKey(r.transactionId), r.landed ? "landed" : "lost");
    const addName = r.add ? await quiet(() => a.nameOf(r.add!), r.add) : "nobody";
    const dropName = r.drop ? await quiet(() => a.nameOf(r.drop!), r.drop) : null;
    const when = r.at != null ? `processed ${fmtEt(r.at)}` : "processing time unknown";
    const winner = r.winnerRosterId != null
      ? ` Won by ${await quiet(() => a.managerOf(r.winnerRosterId!), `roster ${r.winnerRosterId}`)} (roster ${r.winnerRosterId}).`
      : "";
    const summary = r.landed
      ? `Waiver claim landed: ${addName} added${dropName ? `, ${dropName} dropped` : ", no drop"} (${when})${priority ? `; waiver priority now ${priority.position} of ${priority.of}` : ""}.`
      : `Waiver claim lost: ${addName}${dropName ? ` for ${dropName}` : ", no drop"} (${when}).${r.notes ? ` Sleeper: "${r.notes.replace(/\.$/, "")}."` : ""}${winner}`;
    a.log(r.landed ? CLAIM_LANDED : CLAIM_LOST, summary, {
      transactionId: r.transactionId, leg: r.leg, add: r.add, drop: r.drop, notes: r.notes,
      processedAt: r.at != null ? new Date(r.at).toISOString() : null,
      winnerRosterId: r.winnerRosterId,
      waiverPosition: r.landed ? priority : null,
    });
  }
  return results;
}
