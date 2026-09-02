// Sees a trade offer, decides it, responds to it, and says why in the DM.
//
// This replaces a path that could never have worked. The old poll looked for
// pending trades in the REST transactions feed, which does not list them, and
// tested for status "pending" when Sleeper says "proposed". Even had it seen the
// offer it would only have shadowed, because responding needed a trades-page DOM
// that was never built. `accept_trade` / `reject_trade` are plain GraphQL
// mutations, so all of that goes away.
//
// The DECISION is deterministic (src/analysis/trade-fair.ts), not a model call.
// Filip: "I don't want any involvement with accepting trades or rejecting
// trades. The whole point here is that Claude is the manager." A rule that can
// be tested and explained is what makes that delegation safe.

import { config } from "../config.ts";
import { logEvent } from "../log.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import {
  pendingTrades, acceptTrade, rejectTrade, listDms, threadMessages, sendDm,
  type Gql, type PendingTrade,
} from "./api.ts";
import { snapshot, offerFromTransaction, evaluateLiveOffer } from "../analysis/trade-wire.ts";
import type { TwoSidedEvaluation } from "../analysis/trade-fair.ts";

export interface TradeSides { receive: string[]; give: string[] }

/** What the coach says back. Deterministic on purpose: this goes to a real
 *  person in Filip's league, so it states the actual numbers the decision was
 *  made on rather than improvising. The swagger is fixed dressing, not a model
 *  free to say anything. */
export function tradeReplyText(ev: TwoSidedEvaluation, sides: TradeSides): string {
  const got = sides.receive.join(", ") || "nothing";
  const gave = sides.give.join(", ") || "nothing";
  if (ev.verdict === "accept") {
    return `Accepted. ${gave} out, ${got} in. That is +${ev.ourGain} to my starting lineup ` +
      `and +${ev.theirGain} to yours, which is a deal I take every time. Pleasure doing business.`;
  }
  // Lead with the blocking reason when there is one: it is the most useful
  // sentence in the message and usually the funniest.
  const blocked = ev.fairnessBlocks[0] ?? ev.railBlocks[0];
  const head = blocked ? `Rejected: ${blocked}.` : "Rejected.";
  return `${head} Giving up ${gave} for ${got} moves my starting lineup ${ev.ourGain >= 0 ? "+" : ""}${ev.ourGain} ` +
    `and yours ${ev.theirGain >= 0 ? "+" : ""}${ev.theirGain}. Net of the schedule that is ${ev.netValue} ` +
    `against the ${ev.requiredEdge} point margin I need. ` +
    `Send something that helps us both and I will take it: I accept any trade that does not make me worse.`;
}

/** Find the DM thread this offer was proposed in, so the reply lands in the
 *  conversation the human is actually looking at. Trade offers arrive as a
 *  message carrying the transaction id as a structured attachment. */
export async function findTradeThread(gql: Gql, transactionId: string): Promise<string | null> {
  const dms = await listDms(gql, 25);
  for (const d of dms) {
    try {
      const msgs = await threadMessages(gql, d.dmId);
      if (msgs.some((m) => m.tradeTransactionId === transactionId)) return d.dmId;
    } catch { /* a thread we cannot read is not the one */ }
  }
  return null;
}

export interface HandledTrade {
  transactionId: string;
  verdict: string;
  ourGain: number;
  theirGain: number;
  replied: boolean;
}

export async function handlePendingTrades(
  gql: Gql,
  leg: number,
  alreadyHandled: (id: string) => boolean,
  markHandled: (id: string, how: string) => void,
): Promise<HandledTrade[]> {
  const out: HandledTrade[] = [];
  const trades: PendingTrade[] = await pendingTrades(gql, leg);
  for (const t of trades) {
    if (!t.rosterIds.includes(config.rosterId)) continue;
    if (t.consenterIds.includes(config.rosterId)) continue; // we already agreed
    if (alreadyHandled(t.transactionId)) continue;

    const tx = { adds: t.adds, drops: t.drops, roster_ids: t.rosterIds };
    const { evaluation: ev, theirRosterId } = await evaluateLiveOffer(tx);
    const snap = await snapshot();
    const { offer } = offerFromTransaction(tx, snap);
    const sides: TradeSides = {
      receive: offer.receive.map((p) => p.name),
      give: offer.give.map((p) => p.name),
    };

    logEvent("coach", "trade-offer", `Trade ${t.transactionId} from roster ${theirRosterId}: ${ev.verdict}`, {
      transaction_id: t.transactionId, theirRosterId, verdict: ev.verdict, ourGain: ev.ourGain, theirGain: ev.theirGain,
      netValue: ev.netValue, requiredEdge: ev.requiredEdge, sides, reasons: ev.reasons,
    });

    const frozen = freezeState();
    if (frozen.frozen) {
      logEvent("coach", "trade-frozen", `Trade ${t.transactionId} left alone: coach is frozen`, { reason: frozen.reason });
      continue; // deliberately NOT marked handled: decide it when unfrozen
    }
    assertWritesAllowed("trade respond");

    const status = ev.verdict === "accept"
      ? await acceptTrade(gql, t.transactionId, leg)
      : await rejectTrade(gql, t.transactionId, leg);

    let replied = false;
    try {
      const dmId = await findTradeThread(gql, t.transactionId);
      if (dmId) {
        await sendDm(gql, dmId, tradeReplyText(ev, sides));
        replied = true;
      }
    } catch (e) {
      // The decision is what matters; a failed pleasantry must not undo it.
      logEvent("coach", "trade-reply-failed", `Could not reply in the DM for ${t.transactionId}`, { error: String(e) });
    }

    markHandled(t.transactionId, ev.verdict);
    logEvent("coach", "trade-decided", `${ev.verdict.toUpperCase()} trade ${t.transactionId} (server said ${status})`, {
      transaction_id: t.transactionId, verdict: ev.verdict, status, replied,
    });
    out.push({ transactionId: t.transactionId, verdict: ev.verdict, ourGain: ev.ourGain, theirGain: ev.theirGain, replied });
  }
  return out;
}
