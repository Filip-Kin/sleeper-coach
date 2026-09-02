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
  pendingTrades, acceptTrade, rejectTrade, proposeTrade, outstandingOffers, listDms, threadMessages, sendDm,
  type Gql, type PendingTrade,
} from "./api.ts";
import { snapshot, offerFromTransaction, evaluateLiveOffer, scheduleContext } from "../analysis/trade-wire.ts";
import { DEFAULT_FAIRNESS, type TwoSidedEvaluation, type Proposal } from "../analysis/trade-fair.ts";
import { pickCounter, recordProposal, MAX_OPEN_OFFERS, OFFER_TTL_DAYS } from "./trade-propose.ts";
import type { Database } from "bun:sqlite";
import { newsAgeDays } from "../data/news.ts";

/** Warn once a day when the news dossier is old enough to be lying to us. */
export const NEWS_STALE_DAYS = 5;
let lastStaleWarn = 0;
async function warnIfNewsStale(): Promise<void> {
  if (Date.now() - lastStaleWarn < 86_400_000) return;
  const age = await newsAgeDays();
  if (age !== null && age <= NEWS_STALE_DAYS) return;
  lastStaleWarn = Date.now();
  logEvent("coach", "news-stale", age === null
    ? "No news dossier exists; trades are being valued on raw projections and injury flags only"
    : `News dossier is ${age} days old; a trade was just evaluated against it`, { ageDays: age });
}

export interface TradeSides { receive: string[]; give: string[] }

/** What the coach says back. Deterministic on purpose: this goes to a real
 *  person in Filip's league, so it states the actual numbers the decision was
 *  made on rather than improvising. The swagger is fixed dressing, not a model
 *  free to say anything. */
/** Somebody offering our starting QB for literally nothing back, or asking us
 *  to gut our team for a double-digit loss, is not a genuine misjudgement, it
 *  is a probe to see if the bot bites. Filip, after the coach flatly rejected
 *  exactly that: "if it gets offered a stupid trade I feel like the response
 *  should be a little more critical." A dry "Rejected: below the floor" reads
 *  the same for a real close call and an obvious troll, and it should not. */
export const BLATANT_OUR_GAIN_PTS = -30;
export function isBlatantLowball(sides: TradeSides, ev: TwoSidedEvaluation): boolean {
  if (ev.verdict === "accept") return false;
  return sides.receive.length === 0 || ev.ourGain <= BLATANT_OUR_GAIN_PTS;
}

export function tradeReplyText(ev: TwoSidedEvaluation, sides: TradeSides, counter?: Proposal | null): string {
  const got = sides.receive.join(", ") || "nothing";
  const gave = sides.give.join(", ") || "nothing";
  // "My team", not "my starting lineup": the number now includes bye weeks and
  // bench cover, and saying "lineup" invited the correct reply "these are both
  // bench players", which the coach then argued against its own maths.
  if (ev.verdict === "accept") {
    return `Accepted. ${gave} out, ${got} in. That is +${ev.ourGain} to my team over the rest of the season, cover included, ` +
      `and ${ev.theirGain >= 0 ? "+" : ""}${ev.theirGain} to yours. Pleasure doing business.`;
  }
  const blatant = isBlatantLowball(sides, ev);
  const blocked = ev.fairnessBlocks[0] ?? ev.railBlocks[0];
  // The joke never replaces the reason, it leads it: a rival who tried it
  // still gets told exactly what gave the probe away.
  const head = blatant
    ? `Hahaha, very funny, but I am not falling for that one.${blocked ? ` ${blocked}.` : ""}`
    : blocked ? `Rejected: ${blocked}.` : "Rejected.";
  const small = ev.ourGain > 0 ? ` It is a real but small gain for me, and it does not clear the margin I need before I move a body.` : "";
  // A counter turns "no" into a next move. It is only ever a deal the acceptor
  // would take straight back, so naming it commits us to nothing new.
  const tail = counter
    ? ` Instead, I have sent you one that works for both of us: you get ${counter.offer.give.map((p) => p.name).join(" + ")}, ` +
      `I get ${counter.offer.receive.map((p) => p.name).join(" + ")}. That is +${counter.theirGain} to your team by my numbers. Accept it and we are done.`
    : ` I accept any trade that does not leave my team worse off.`;
  return `${head} Giving up ${gave} for ${got} moves my team ${ev.ourGain >= 0 ? "+" : ""}${ev.ourGain} ` +
    `over the rest of the season, bye weeks and injury cover included, and yours ${ev.theirGain >= 0 ? "+" : ""}${ev.theirGain}. ` +
    `Net of how often we still play, that is ${ev.netValue} against the ${ev.requiredEdge} I need.${small}${tail}`;
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
  db?: Database,
): Promise<HandledTrade[]> {
  const out: HandledTrade[] = [];
  const trades: PendingTrade[] = await pendingTrades(gql, leg);
  for (const t of trades) {
    if (!t.rosterIds.includes(config.rosterId)) continue;
    if (t.consenterIds.includes(config.rosterId)) continue; // we already agreed
    if (alreadyHandled(t.transactionId)) continue;

    const tx = { adds: t.adds, drops: t.drops, roster_ids: t.rosterIds };
    await warnIfNewsStale();
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

    // COUNTER-OFFER. A refusal with a better shape in hand should say so with a
    // real offer, not a hint in chat. Sleeper's propose_trade takes the id of
    // the offer being rejected and does both in one call. Bounded by the same
    // limits as the weekly proposer: never more than MAX_OPEN_OFFERS out, never
    // a second offer to someone who has not answered the first, never the same
    // pairing inside the cooldown. If the counter fails for any reason we fall
    // back to a plain reject, so a refusal is never left undelivered.
    let counter: Proposal | null = null;
    let status = "";
    if (ev.verdict === "accept") {
      status = await acceptTrade(gql, t.transactionId, leg);
    } else {
      if (db && theirRosterId !== null) {
        try {
          const open = await outstandingOffers(gql, leg);
          const busy = open.some((o) => o.rosterIds.includes(theirRosterId));
          if (open.length < MAX_OPEN_OFFERS && !busy) {
            const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
            const theirRoster = snap.rosterOf.get(theirRosterId) ?? [];
            const cfg = { ...DEFAULT_FAIRNESS, ...(await scheduleContext(theirRosterId)) };
            counter = pickCounter(ourRoster, { managerId: String(theirRosterId), teamName: `roster ${theirRosterId}`, roster: theirRoster }, cfg, db, Date.now());
          }
        } catch (e) {
          logEvent("coach", "trade-counter-skipped", `Could not look for a counter to ${t.transactionId}`, { error: String(e) });
        }
      }
      if (counter) {
        try {
          const adds: Record<string, number> = {}, drops: Record<string, number> = {};
          for (const p of counter.offer.receive) { const id = snap.idByName.get(p.name); if (!id) throw new Error(`no id for ${p.name}`); adds[id] = snap.ourRosterId; drops[id] = theirRosterId!; }
          for (const p of counter.offer.give)    { const id = snap.idByName.get(p.name); if (!id) throw new Error(`no id for ${p.name}`); adds[id] = theirRosterId!; drops[id] = snap.ourRosterId; }
          const res = await proposeTrade(gql, {
            adds, drops,
            expiresAt: Math.floor((Date.now() + OFFER_TTL_DAYS * 86_400_000) / 1000),
            rejectTransactionId: t.transactionId, rejectTransactionLeg: leg,
          });
          status = `countered:${res.status}`;
          recordProposal(db!, counter, res.transactionId, Date.now());
          logEvent("coach", "trade-countered", `Rejected ${t.transactionId} and countered roster ${theirRosterId}: ${counter.why}`, {
            rejected: t.transactionId, transaction_id: res.transactionId, theirRosterId, ourGain: counter.ourGain, theirGain: counter.theirGain,
          });
        } catch (e) {
          logEvent("coach", "trade-counter-failed", `Counter to ${t.transactionId} failed; rejecting plainly`, { error: String(e) });
          counter = null;
        }
      }
      if (!counter) status = await rejectTrade(gql, t.transactionId, leg);
    }

    let replied = false;
    try {
      const dmId = await findTradeThread(gql, t.transactionId);
      if (dmId) {
        await sendDm(gql, dmId, tradeReplyText(ev, sides, counter));
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
