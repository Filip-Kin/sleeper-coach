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
  type Gql, type PendingTrade, type ProposalSpec,
} from "./api.ts";
import { DropRefused } from "./drop-ledger.ts";
import { snapshotWithPending, offerFromTransaction, evaluateLiveOffer, liveFairness, type LeagueSnapshot } from "../analysis/trade-wire.ts";
import { evaluateTradeTwoSided, outboundConfig, type FairnessConfig, type TradeVerdictSummary, type Proposal, type TwoSidedEvaluation, type MultiSidedEvaluation } from "../analysis/trade-fair.ts";
import { pickCounter, recordProposal, reconcileProposals, liveOffers, MAX_OPEN_OFFERS, OFFER_TTL_DAYS, specFor } from "./trade-propose.ts";
import { tradeDead, TX_DEAD } from "../sleeper/rules.ts";
import { sendAlert } from "../alert.ts";
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
export function isBlatantLowball(sides: TradeSides, ev: TradeVerdictSummary): boolean {
  if (ev.verdict === "accept") return false;
  return sides.receive.length === 0 || ev.ourGain <= BLATANT_OUR_GAIN_PTS;
}

export function tradeReplyText(ev: TradeVerdictSummary, sides: TradeSides, counter?: Proposal | null): string {
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
  // A three-way trade carries per-opponent gains; name them, because the whole
  // point of bundling legs is to keep any single roster's payday from standing
  // out. "opponents" is only present on a multi-party evaluation.
  const opp = (ev as { opponents?: { rosterId: number; theirGain: number }[] }).opponents;
  const multiLine = opp && opp.length > 1
    ? ` This is a ${opp.length + 1}-team trade and I see every leg: ${opp.map((o) => `roster ${o.rosterId} ${o.theirGain >= 0 ? "+" : ""}${o.theirGain}`).join(", ")}.`
    : "";
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
    `over the rest of the season, bye weeks and injury cover included, and the other side ${ev.theirGain >= 0 ? "+" : ""}${ev.theirGain}.${multiLine} ` +
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

/** Sleeper's answer to accept_trade is the transaction's new status. Anything
 *  dead or empty means the accept did not take (T8). */
export function acceptSucceeded(status: string): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s !== "" && !TX_DEAD.has(s);
}

/** Every side effect the poll performs, injectable so the accept and reject
 *  paths can be driven through their failure modes in a test without a
 *  network or a token. Production uses the real functions. */
export interface TradeWatchDeps {
  now: () => number;
  pendingTrades: (gql: Gql, leg: number) => Promise<PendingTrade[]>;
  outstandingOffers: (gql: Gql, leg: number) => Promise<PendingTrade[]>;
  snapshot: (gql: Gql, leg: number) => Promise<LeagueSnapshot>;
  evaluate: (tx: { adds: Record<string, number>; drops: Record<string, number>; roster_ids: number[] }, snap: LeagueSnapshot) =>
    Promise<{ evaluation: TwoSidedEvaluation | MultiSidedEvaluation; theirRosterId: number | null; isMultiParty: boolean }>;
  fairness: (snap: LeagueSnapshot, theirRosterId: number | null) => Promise<FairnessConfig>;
  acceptTrade: (gql: Gql, txId: string, leg: number, giveIds: string[]) => Promise<string>;
  rejectTrade: (gql: Gql, txId: string, leg: number) => Promise<string>;
  proposeTrade: (gql: Gql, spec: ProposalSpec) => Promise<{ transactionId: string; status: string }>;
  findTradeThread: (gql: Gql, transactionId: string) => Promise<string | null>;
  sendDm: (gql: Gql, dmId: string, text: string) => Promise<string>;
  alert: (title: string, message: string) => Promise<void>;
  warnIfNewsStale: () => Promise<void>;
}
const REAL_DEPS: TradeWatchDeps = {
  now: () => Date.now(),
  pendingTrades, outstandingOffers,
  snapshot: (gql, leg) => snapshotWithPending(gql, leg),
  evaluate: (tx, snap) => evaluateLiveOffer(tx, {}, snap),
  fairness: (snap, rid) => liveFairness(snap, rid),
  acceptTrade, rejectTrade, proposeTrade, findTradeThread, sendDm,
  alert: sendAlert, warnIfNewsStale,
};

/** Offers we sent that a rival has up to three days to accept. Nothing
 *  re-checked them in that window (T11), so every poll re-runs each one
 *  through the bar we would apply if it came back to us. There is no withdraw
 *  mutation, so a stale one is logged (once) for the record and for the DM
 *  brief; it is not pulled. */
const staleLogged = new Set<string>();
export async function reviewOpenOffers(open: PendingTrade[], snap: LeagueSnapshot, deps: TradeWatchDeps): Promise<string[]> {
  const stale: string[] = [];
  const ours = snap.rosterOf.get(snap.ourRosterId) ?? [];
  for (const t of open) {
    const { offer, theirRosterId } = offerFromTransaction({ adds: t.adds, drops: t.drops, roster_ids: t.rosterIds }, snap);
    if (theirRosterId === null) continue;
    const theirs = snap.rosterOf.get(theirRosterId) ?? [];
    const ev = evaluateTradeTwoSided(offer, ours, theirs, outboundConfig(await deps.fairness(snap, theirRosterId)));
    if (ev.verdict === "accept") { staleLogged.delete(t.transactionId); continue; }
    stale.push(t.transactionId);
    if (staleLogged.has(t.transactionId)) continue;
    staleLogged.add(t.transactionId);
    logEvent("coach", "trade-offer-stale", `Our open offer ${t.transactionId} to roster ${theirRosterId} would no longer clear our own bar; it cannot be withdrawn`, {
      transaction_id: t.transactionId, theirRosterId, ourGain: ev.ourGain, theirGain: ev.theirGain, netValue: ev.netValue, requiredEdge: ev.requiredEdge,
      blocks: [...ev.fairnessBlocks, ...ev.railBlocks],
    });
  }
  return stale;
}

export async function handlePendingTrades(
  gql: Gql,
  leg: number,
  alreadyHandled: (id: string) => boolean,
  markHandled: (id: string, how: string) => void,
  db?: Database,
  overrides: Partial<TradeWatchDeps> = {},
): Promise<HandledTrade[]> {
  const deps: TradeWatchDeps = { ...REAL_DEPS, ...overrides };
  const now = deps.now();
  const out: HandledTrade[] = [];
  const trades: PendingTrade[] = await deps.pendingTrades(gql, leg);
  const incoming = trades.filter((t) =>
    t.rosterIds.includes(config.rosterId) && !t.consenterIds.includes(config.rosterId) && !alreadyHandled(t.transactionId));
  // Our own open offers, read once per poll; the cap and the counter path
  // both count only the live ones (T12).
  const open = liveOffers(await deps.outstandingOffers(gql, leg), now);
  if (db) reconcileProposals(db, open, now);
  if (!incoming.length && !open.length) return out;

  // ONE snapshot per poll (T2). A roster read that cannot tell IR from active
  // throws, and the poll skips rather than deciding on a guess (T3).
  let snap: LeagueSnapshot;
  try {
    snap = await deps.snapshot(gql, leg);
  } catch (e) {
    logEvent("coach", "trade-snapshot-failed", `Skipping the trade poll: ${e instanceof Error ? e.message : String(e)}`, { error: String(e), pending: incoming.map((t) => t.transactionId) });
    return out;
  }
  if (open.length) await reviewOpenOffers(open, snap, deps).catch((e) => logEvent("coach", "trade-review-failed", "Could not re-check our open offers", { error: String(e) }));

  for (const t of incoming) {
    // An expired or withdrawn offer still listed as proposed is not decided,
    // only filed (T16).
    if (tradeDead({ status: t.status }, now)) { markHandled(t.transactionId, "dead"); continue; }

    const tx = { adds: t.adds, drops: t.drops, roster_ids: t.rosterIds };
    await deps.warnIfNewsStale();
    const { evaluation: ev, theirRosterId, isMultiParty } = await deps.evaluate(tx, snap);
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
      // THE ACCEPT IS CHECKED (T8). A refusal by the drop breaker is a
      // deferral: the offer is still good, the roster just moved too much
      // this hour, so it is left unhandled and retried next poll, no alert.
      // Anything else that stops the accept (a thrown write, a dead or empty
      // status back from Sleeper) is filed as handled and alerted ONCE, so a
      // broken accept is not re-evaluated every ninety seconds forever.
      const give = offer.give.map((p) => p.playerId ?? "").filter(Boolean);
      try {
        status = await deps.acceptTrade(gql, t.transactionId, leg, give);
        if (!acceptSucceeded(status)) throw new Error(`accept_trade returned status "${status}"`);
      } catch (e) {
        if (e instanceof DropRefused) {
          logEvent("coach", "trade-deferred", `Trade ${t.transactionId} accept deferred: ${e.verdict.reason}`, { transaction_id: t.transactionId, reason: e.verdict.reason, give });
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        markHandled(t.transactionId, "accept-failed");
        logEvent("coach", "trade-accept-failed", `Trade ${t.transactionId} evaluated ACCEPT but the accept did not take: ${msg}`, { transaction_id: t.transactionId, error: msg, status, sides });
        await deps.alert("Trade accept failed", `Trade ${t.transactionId} (${sides.give.join(", ")} for ${sides.receive.join(", ")}) evaluated accept but Sleeper did not take it: ${msg}. It is filed as handled; decide it in the app.`).catch(() => {});
        continue;
      }
    } else {
      // A counter is a 2-party propose_trade by construction, so it makes no
      // sense against a three-way trade: we would be offering one rival a
      // different deal than the tangle they proposed. Multi-party trades get a
      // plain reject and an honest explanation, never a counter.
      if (db && theirRosterId !== null && !isMultiParty) {
        try {
          const busy = open.some((o) => o.rosterIds.includes(theirRosterId));
          if (open.length < MAX_OPEN_OFFERS && !busy) {
            const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
            const theirRoster = snap.rosterOf.get(theirRosterId) ?? [];
            const cfg = await deps.fairness(snap, theirRosterId);
            counter = pickCounter(ourRoster, { managerId: String(theirRosterId), teamName: `roster ${theirRosterId}`, roster: theirRoster }, cfg, db, now);
          }
        } catch (e) {
          logEvent("coach", "trade-counter-skipped", `Could not look for a counter to ${t.transactionId}`, { error: String(e) });
        }
      }
      if (counter) {
        try {
          const spec = specFor(counter, snap, theirRosterId!, now);
          const res = await deps.proposeTrade(gql, { ...spec, rejectTransactionId: t.transactionId, rejectTransactionLeg: leg });
          status = `countered:${res.status}`;
          recordProposal(db!, counter, res.transactionId, now);
          logEvent("coach", "trade-countered", `Rejected ${t.transactionId} and countered roster ${theirRosterId}: ${counter.why}`, {
            rejected: t.transactionId, transaction_id: res.transactionId, theirRosterId, ourGain: counter.ourGain, theirGain: counter.theirGain,
          });
        } catch (e) {
          logEvent("coach", "trade-counter-failed", `Counter to ${t.transactionId} failed; rejecting plainly`, { error: String(e) });
          counter = null;
        }
      }
      if (!counter) {
        try {
          status = await deps.rejectTrade(gql, t.transactionId, leg);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          markHandled(t.transactionId, "reject-failed");
          logEvent("coach", "trade-reject-failed", `Trade ${t.transactionId} evaluated REJECT but the reject did not take: ${msg}`, { transaction_id: t.transactionId, error: msg, sides });
          await deps.alert("Trade reject failed", `Trade ${t.transactionId} evaluated reject but Sleeper did not take it: ${msg}. It is filed as handled; decide it in the app.`).catch(() => {});
          continue;
        }
      }
    }

    let replied = false;
    try {
      const dmId = await deps.findTradeThread(gql, t.transactionId);
      if (dmId) {
        await deps.sendDm(gql, dmId, tradeReplyText(ev, sides, counter));
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
