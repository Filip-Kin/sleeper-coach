#!/usr/bin/env bun
// Sends trade offers of our own. Filip: "Send out trades that you think other
// managers might actually accept."
//
// Until now this never happened. proposeTrades() in trade-fair.ts generated
// candidates and was well tested, but nothing called it: there was no schedule
// entry, and the only send path was a trades-page DOM flow gated behind
// TRADE_WRITE_ARMED that threw "the propose flow has not been verified against a
// real trade partner". Staging could not verify it either, because all seven
// other staging teams are orphans with no owner. GraphQL's propose_trade removes
// that blocker entirely.
//
// WHEN IT DECIDES TO OFFER, which is the part that needs to be conservative,
// because every offer is a message to somebody Filip knows:
//
//   - Weekly, on Wednesday morning, once waivers have settled so the rosters it
//     reasons about are the ones people actually have.
//   - Never after the trade deadline (week 11 in this league).
//   - Only players our lineup can genuinely spare: never a dedicated-slot
//     starter at his position, never an injured stash due back before the
//     playoffs (his projection understates him), and only if losing him costs
//     the lineup less than the surplus line.
//   - Only where THEY gain too. An offer they would never accept is noise, and
//     noise from a bot is how you get muted.
//   - One offer per rival at a time, and at most MAX_OPEN_OFFERS outstanding, so
//     it never looks like spam.
//   - Never re-send a pairing that was rejected, for REPROPOSE_COOLDOWN_DAYS.
//
// Everything about the VALUE judgement lives in trade-fair.ts. This file is only
// about restraint and plumbing.

import { Database } from "bun:sqlite";
import { config } from "../config.ts";
import { logEvent, recentEvents } from "../log.ts";
import { assertWritesAllowed, freezeState } from "../killswitch.ts";
import { tokenGql, proposeTrade, outstandingOffers, listDms, sendDm, type Gql, type PendingTrade, type ProposalSpec } from "./api.ts";
import { snapshot, snapshotWithPending, scheduleContext, type LeagueSnapshot } from "../analysis/trade-wire.ts";
import { proposeTrades, giveEligibleForProposal, byeAwareLineupTotal, depthInsurance, DEFAULT_FAIRNESS, type Proposal, type RivalRoster, type FairnessConfig } from "../analysis/trade-fair.ts";
import { gateOutgoing, offerKey, IntentStore, DEFAULT_GATE, type GateOptions } from "../analysis/trade-intent.ts";
import type { TradePlayer } from "../analysis/trade.ts";
import { shortlist, pickOne, type PickCandidate, type PickResult } from "./trade-pick.ts";
import { pastTradeDeadline, tradeDead } from "../sleeper/rules.ts";
import { STATE_DIR } from "../paths.ts";
import { sleeper } from "../sleeper/client.ts";
import type { RosterSettings, LeagueSettings } from "../sleeper/types.ts";

/** Never have more than this many of our offers waiting for an answer. */
export const MAX_OPEN_OFFERS = 2;
/** Do not re-offer the same pair of players to the same manager for this long. */
export const REPROPOSE_COOLDOWN_DAYS = 21;
/** Offers expire so a stale one cannot be accepted weeks later against a roster
 *  that has changed underneath it. */
export const OFFER_TTL_DAYS = 3;

export interface ProposerState {
  db: Database;
  now?: number;
  /** Decide and report, but send nothing and record nothing. */
  dry?: boolean;
  /** Where the two-pass intents live. Defaults to the state volume. */
  intents?: IntentStore;
  gate?: GateOptions;
  /** Every read and write the proposer performs, injectable for tests. */
  io?: Partial<ProposerIo>;
}

export interface ProposerIo {
  nflState: () => Promise<{ week: number }>;
  league: () => Promise<{ settings: LeagueSettings }>;
  outstandingOffers: (gql: Gql, leg: number) => Promise<PendingTrade[]>;
  snapshot: (gql: Gql, leg: number) => Promise<LeagueSnapshot>;
  scheduleContext: (theirRosterId: number) => Promise<{ remainingWeeks: number; headToHeadRemaining: number; upcomingWeeks: number[] }>;
  proposeTrade: (gql: Gql, spec: ProposalSpec) => Promise<{ transactionId: string; status: string }>;
  pitch: (gql: Gql, snap: LeagueSnapshot, best: Proposal) => Promise<void>;
  /** The judgement step (trade-pick.ts): one of the shortlist, or none. */
  pick: (cands: PickCandidate[], ourRoster: TradePlayer[]) => Promise<PickResult>;
}
const REAL_IO: ProposerIo = {
  nflState: () => sleeper.nflState(),
  league: () => sleeper.league(config.leagueId),
  outstandingOffers,
  snapshot: (gql, leg) => snapshotWithPending(gql, leg),
  scheduleContext,
  proposeTrade,
  pitch: async (gql, snap, best) => {
    // A bare offer notification is easy to ignore. A line saying why it is good
    // for THEM is what gets it looked at.
    const owner = snap.ownerIdOf.get(Number(best.managerId));
    const dm = owner ? (await listDms(gql, 25)).find((d) => d.lastAuthorId === owner || d.title?.includes(owner)) : null;
    if (dm) await sendDm(gql, dm.dmId, pitchText(best));
  },
  pick: (cands, ourRoster) => pickOne(cands, ourRoster),
};

/** Identity of a swap for the cooldown: manager plus the PLAYER IDS on each
 *  side, order-independent. Ids, not names: two rostered players can share a
 *  name and the write path keys on ids anyway (T10). */
export function pairKey(managerId: string, receiveIds: string[], giveIds: string[]): string {
  return [managerId, [...receiveIds].sort().join("+"), [...giveIds].sort().join("+")].join("|");
}
export function pairPlayers(key: string): Set<string> {
  const [, recv = "", give = ""] = key.split("|");
  return new Set([...recv.split("+"), ...give.split("+")].filter(Boolean));
}
const ids = (ps: TradePlayer[]): string[] => ps.map((p) => p.playerId ?? p.name);
export function proposalKey(p: Proposal): string {
  return pairKey(p.managerId, ids(p.offer.receive), ids(p.offer.give));
}

/** Is this swap, or one close enough to it, still inside the cooldown with
 *  this manager? "Close enough" is sharing at least half its players with a
 *  recent offer (T11): re-sending Evans + Etienne for Rice as Evans + Downs
 *  for Rice is the same nag with one name changed. */
export function onCooldown(
  db: Database, key: string, now: number, cooldownDays = REPROPOSE_COOLDOWN_DAYS,
): boolean {
  const [managerId = ""] = key.split("|");
  const mine = pairPlayers(key);
  if (!mine.size) return false;
  const rows = db.query<{ pair_key: string }, [string, number]>(
    "SELECT pair_key FROM trade_proposals WHERE manager_id = ? AND at > ?",
  ).all(managerId, now - cooldownDays * 86_400_000);
  const needed = Math.ceil(mine.size / 2);
  return rows.some((r) => {
    let shared = 0;
    for (const id of pairPlayers(r.pair_key)) if (mine.has(id)) shared++;
    return shared >= needed;
  });
}

export function ensureTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS trade_proposals (
    pair_key TEXT NOT NULL, manager_id TEXT NOT NULL, transaction_id TEXT,
    at INTEGER NOT NULL, why TEXT)`);
  // Reconciliation columns (T12). Older rows default to open and are settled
  // on the first poll that does not find them at Sleeper.
  try { db.run("ALTER TABLE trade_proposals ADD COLUMN status TEXT NOT NULL DEFAULT 'open'"); } catch { /* already there */ }
  try { db.run("ALTER TABLE trade_proposals ADD COLUMN dead_at INTEGER"); } catch { /* already there */ }
}

/** Our outstanding offers that are still alive: not dead by status and not
 *  past the expiry we set when we sent them. api.ts does not read
 *  settings.expires_at, so the expiry is reconstructed from created + TTL,
 *  which is what every offer we send carries. */
export function liveOffers(open: PendingTrade[], now: number): PendingTrade[] {
  return open.filter((t) => !tradeDead({ status: t.status, settings: { expires_at: t.expiresAt ?? Math.floor(t.created / 1000) + OFFER_TTL_DAYS * 86_400 } }, now));
}

/** Settle trade_proposals rows against what Sleeper still lists (T12): a row
 *  whose transaction is no longer among our live open offers is dead. Returns
 *  the transaction ids just marked. Rows on cooldown stay on cooldown either
 *  way; this only stops a dead offer counting toward MAX_OPEN_OFFERS. */
export function reconcileProposals(db: Database, open: PendingTrade[], now: number): string[] {
  ensureTable(db);
  const live = new Set(liveOffers(open, now).map((t) => t.transactionId));
  const rows = db.query<{ transaction_id: string | null }, []>(
    "SELECT transaction_id FROM trade_proposals WHERE status = 'open'",
  ).all();
  const dead = rows.map((r) => r.transaction_id).filter((id): id is string => !!id && !live.has(id));
  for (const id of dead) db.run("UPDATE trade_proposals SET status = 'dead', dead_at = ? WHERE transaction_id = ?", [now, id]);
  if (dead.length) logEvent("coach", "trade-proposals-reconciled", `${dead.length} of our offers are no longer open at Sleeper`, { transaction_ids: dead });
  return dead;
}

/** The propose_trade payload for a proposal, keyed on player ids from the
 *  roster entries, never a name lookup. */
export function specFor(p: Proposal, snap: LeagueSnapshot, theirRosterId: number, now: number): ProposalSpec {
  const adds: Record<string, number> = {};
  const drops: Record<string, number> = {};
  const idOf = (x: TradePlayer): string => {
    const id = x.playerId ?? snap.idByName.get(x.name);
    if (!id) throw new Error(`no player id for ${x.name}`);
    return id;
  };
  for (const x of p.offer.receive) { const id = idOf(x); adds[id] = snap.ourRosterId; drops[id] = theirRosterId; }
  for (const x of p.offer.give) { const id = idOf(x); adds[id] = theirRosterId; drops[id] = snap.ourRosterId; }
  return { adds, drops, expiresAt: Math.floor((now + OFFER_TTL_DAYS * 86_400_000) / 1000) };
}

export interface ProposeResult {
  sent: Proposal | null;
  considered: number;
  reason: string;
}

/** Decide without sending, and WITHOUT recording a cooldown. A dry run that
 *  wrote the cooldown row would make the next real run skip the offer it had
 *  just chosen. */
export async function dryRunProposer(state: ProposerState, gql: Gql = tokenGql()): Promise<ProposeResult> {
  return runProposer({ ...state, dry: true }, gql);
}

/** Two-pass send: "a bad idea has to look good twice." Pass one records the
 *  intent and returns `recorded`; a later pass with fresh data sends it if it
 *  still clears. The runner (propose-run.ts) makes the second pass after a
 *  fresh fetch; anything under DEFAULT_GATE.minAgeMs apart is refused as one
 *  look counted twice. */
export type ProposeOutcome = "sent" | "recorded" | "waiting" | "dry" | "nothing" | "failed";
export interface ProposeResultFull extends ProposeResult { outcome: ProposeOutcome }

export async function runProposer(state: ProposerState, gql: Gql = tokenGql()): Promise<ProposeResultFull> {
  const db = state.db;
  const now = state.now ?? Date.now();
  const io: ProposerIo = { ...REAL_IO, ...state.io };
  ensureTable(db);

  const frozen = freezeState();
  if (frozen.frozen) return { sent: null, considered: 0, outcome: "nothing", reason: `frozen: ${frozen.reason ?? "no reason given"}` };

  const nfl = await io.nflState();
  const league = await io.league();
  const week = Math.max(1, nfl.week ?? 1);
  if (pastTradeDeadline(week, league.settings)) {
    return { sent: null, considered: 0, outcome: "nothing", reason: `past the week ${league.settings.trade_deadline} trade deadline` };
  }

  // Only LIVE offers count toward the cap (T12); a dead row is settled here.
  const open = liveOffers(await io.outstandingOffers(gql, week), now);
  reconcileProposals(db, open, now);
  if (open.length >= MAX_OPEN_OFFERS) {
    return { sent: null, considered: 0, outcome: "nothing", reason: `${open.length} of our offers are still unanswered` };
  }
  const busyRosters = new Set(open.flatMap((t) => t.rosterIds));

  // The roster we will hold once agreed trades process, so a player already
  // leaving is never offered (T2).
  const snap = await io.snapshot(gql, week);
  const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const rivals: RivalRoster[] = [];
  for (const [rosterId, roster] of snap.rosterOf) {
    if (rosterId === snap.ourRosterId) continue;
    if (busyRosters.has(rosterId)) continue; // already waiting on them
    if (!roster.length) continue; // an orphan roster has nobody to answer
    rivals.push({ managerId: String(rosterId), teamName: `roster ${rosterId}`, roster });
  }
  if (!rivals.length) return { sent: null, considered: 0, outcome: "nothing", reason: "no rival is free to receive an offer" };

  // Schedule dilution is per rival, so evaluate each against its own head to
  // head count rather than one blended number.
  const candidates: Proposal[] = [];
  const h2hOf = new Map<string, number>();
  for (const rival of rivals) {
    const sched = await io.scheduleContext(Number(rival.managerId));
    h2hOf.set(rival.managerId, sched.headToHeadRemaining);
    candidates.push(...proposeTrades(ourRoster, [rival], { ...DEFAULT_FAIRNESS, ...sched, rosterCapacity: snap.capacity }, 5));
  }
  candidates.sort((a, b) => b.score - a.score || b.theirGain - a.theirGain);

  const fresh = candidates.filter((c) => !onCooldown(db, proposalKey(c), now));
  if (!fresh.length) {
    return { sent: null, considered: candidates.length, outcome: "nothing",
      reason: candidates.length ? "every candidate was offered recently" : "no offer helps both sides right now" };
  }

  // The judgement step: the engine's best per rival goes to the model, which
  // sends one or none. The engine's own ranking is not the send order any more
  // (2026-09-23: it put a Prescott giveaway above the one real upgrade).
  const cands = shortlist(ourRoster, fresh, (m) => h2hOf.get(m) ?? 0);
  const picked = await io.pick(cands, ourRoster);
  if (picked.error) {
    logEvent("coach", "trade-pick-failed", `Could not judge ${cands.length} candidate offers; nothing sent`, { error: picked.error });
    return { sent: null, considered: candidates.length, outcome: "nothing", reason: picked.why };
  }
  if (!picked.chosen) {
    logEvent("coach", "trade-pick-none", `Judged ${cands.length} candidate offers and sent none: ${picked.why}`, {
      candidates: cands.map((c) => c.proposal.why), why: picked.why,
    });
    return { sent: null, considered: candidates.length, outcome: "nothing", reason: `judged ${cands.length} and chose none: ${picked.why}` };
  }
  const best = picked.chosen.proposal;
  logEvent("coach", "trade-pick", `Judged ${cands.length} candidate offers and chose ${best.why}: ${picked.why}`, {
    candidates: cands.map((c) => c.proposal.why), chosen: best.why, why: picked.why,
  });

  if (state.dry) return { sent: best, considered: candidates.length, outcome: "dry", reason: `dry run, nothing sent; judged ${cands.length}, chose this one: ${picked.why}` };

  // The two-pass gate (T11). Keyed on ids so a namesake cannot satisfy it.
  const intents = state.intents ?? new IntentStore(`${STATE_DIR}/trade-intents.json`);
  const gateOpts = state.gate ?? DEFAULT_GATE;
  intents.prune(now, gateOpts.maxAgeMs ?? DEFAULT_GATE.maxAgeMs);
  const key = offerKey(best.managerId, ids(best.offer.give), ids(best.offer.receive));
  const decision = gateOutgoing({ key, verdict: "accept", lineupDelta: best.ourGain }, intents.get(key), now, gateOpts);
  if (decision.action === "record") {
    intents.put({ key, firstSeen: now, lineupDelta: best.ourGain, note: best.why });
    logEvent("coach", "trade-intent", `Recorded an intent to offer ${best.offer.give.map((p) => p.name).join(" + ")} for ${best.offer.receive.map((p) => p.name).join(" + ")} to roster ${best.managerId}; sends if it still clears on the next pass`, { key, why: best.why });
    return { sent: best, considered: candidates.length, outcome: "recorded", reason: decision.reason };
  }
  if (decision.action !== "send") {
    return { sent: best, considered: candidates.length, outcome: "waiting", reason: decision.reason };
  }

  assertWritesAllowed("trade propose");
  const theirRosterId = Number(best.managerId);
  let res: { transactionId: string; status: string };
  try {
    res = await io.proposeTrade(gql, specFor(best, snap, theirRosterId, now));
  } catch (e) {
    // A refused propose (a defense id the API would not take, a roster that
    // moved under us) is a logged miss, never a crashed job (T7).
    const msg = e instanceof Error ? e.message : String(e);
    logEvent("coach", "trade-propose-failed", `Could not send ${best.why}: ${msg}`, { error: msg, theirRosterId, why: best.why });
    return { sent: null, considered: candidates.length, outcome: "failed", reason: `propose failed: ${msg}` };
  }
  intents.delete(key);

  db.run("INSERT INTO trade_proposals (pair_key, manager_id, transaction_id, at, why) VALUES (?, ?, ?, ?, ?)",
    [proposalKey(best), best.managerId, res.transactionId, now, best.why]);
  logEvent("coach", "trade-proposed", `Offered ${best.offer.give.map((p) => p.name).join(", ")} for ${best.offer.receive.map((p) => p.name).join(", ")} to roster ${best.managerId}`, {
    transaction_id: res.transactionId, status: res.status, why: best.why,
    ourGain: best.ourGain, theirGain: best.theirGain, considered: candidates.length,
  });

  await io.pitch(gql, snap, best).catch(() => { /* the offer stands with or without the sales pitch */ });

  return { sent: best, considered: candidates.length, outcome: "sent", reason: "sent" };
}

/** Run the two-pass gate to completion in one job: pass one records, then
 *  after `waitMs` of real time a second pass re-reads everything and sends if
 *  the same deal is still the best one. The weekly schedule runs this once,
 *  so without it the intent would only ever be recorded. */
export async function runProposerTwice(state: ProposerState, gql: Gql = tokenGql(), waitMs = DEFAULT_GATE.minAgeMs + 5_000): Promise<ProposeResultFull> {
  const first = await runProposer(state, gql);
  if (first.outcome !== "recorded") return first;
  await new Promise((r) => setTimeout(r, waitMs));
  return runProposer({ ...state, now: undefined }, gql);
}

/** The pitch. Their side in positional terms and nothing about ours: "+30 to
 *  me" is the line that gets an offer declined on principle (T13). */
export function pitchText(p: Proposal): string {
  const give = p.offer.give.map((x) => x.name).join(", ");
  const get = p.offer.receive.map((x) => x.name).join(", ");
  const why = p.theirReason ? ` ${p.theirReason.charAt(0).toUpperCase()}${p.theirReason.slice(1)}.` : "";
  return `Offer sent: you get ${give}, I get ${get}.${why} No hard feelings if you pass.`;
}

// ---------------------------------------------------------------------------
// What the coach may say in a DM lives in dm-brief.ts (TradeBrief, the finish
// order, the roster blocks, the trade facts). Re-exported here so existing
// imports keep working; the bodies are owned by that file.
// ---------------------------------------------------------------------------
export { projectedFinishOrder, leagueRostersContext, tradeBriefFor, briefText, type TradeBrief } from "./dm-brief.ts";

/** Record an offer we sent, so the cooldown and the outstanding-offer cap see it
 *  whether it came from the weekly proposer or from a counter. */
export function recordProposal(db: Database, p: Proposal, transactionId: string, now: number): void {
  ensureTable(db);
  db.run("INSERT INTO trade_proposals (pair_key, manager_id, transaction_id, at, why) VALUES (?, ?, ?, ?, ?)",
    [proposalKey(p), p.managerId, transactionId, now, p.why]);
}

/** The best counter to send a rival who just sent us something we refused.
 *
 *  Pure apart from the cooldown lookup, so it is testable. Returns null when
 *  nothing clears the acceptor's bar with that rival gaining too, or when the
 *  best candidate was offered to them recently. A counter is a proposal like
 *  any other: it must be a deal we would accept if it came straight back. */
export function pickCounter(
  ourRoster: TradePlayer[], rival: RivalRoster, cfg: FairnessConfig, db: Database, now: number,
): Proposal | null {
  ensureTable(db);
  const candidates = proposeTrades(ourRoster, [rival], cfg, 5);
  return candidates.find((c) => !onCooldown(db, proposalKey(c), now)) ?? null;
}
