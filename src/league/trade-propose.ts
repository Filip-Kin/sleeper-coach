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
  return open.filter((t) => !tradeDead({ status: t.status, settings: { expires_at: Math.floor(t.created / 1000) + OFFER_TTL_DAYS * 86_400 } }, now));
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
  for (const rival of rivals) {
    const sched = await io.scheduleContext(Number(rival.managerId));
    candidates.push(...proposeTrades(ourRoster, [rival], { ...DEFAULT_FAIRNESS, ...sched, rosterCapacity: snap.capacity }, 5));
  }
  candidates.sort((a, b) => b.score - a.score || b.theirGain - a.theirGain);

  const fresh = candidates.filter((c) => !onCooldown(db, proposalKey(c), now));
  const best = fresh[0];
  if (!best) {
    return { sent: null, considered: candidates.length, outcome: "nothing",
      reason: candidates.length ? "every candidate was offered recently" : "no offer helps both sides right now" };
  }

  if (state.dry) return { sent: best, considered: candidates.length, outcome: "dry", reason: "dry run, nothing sent" };

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
// What the coach may say in a DM
// ---------------------------------------------------------------------------
//
// The DM model runs sandboxed with no tools and WITHOUT the coach system prompt,
// which is what makes it safe. The cost is that it knows nothing: asked "who on
// my team do you want", it bluffed, and asked about a Bijan-for-Collins swap it
// called Bijan "a cornerstone I am building around" when Bijan is on THEIR
// roster. Confident nonsense, and it refused every trade, which works against us
// because we WANT offers.
//
// So it gets a small brief of facts we are happy to publish. This is safe to
// share by construction: the surplus list is exactly what we are trying to trade
// away, so telling them is the entire point. It carries no valuations, no
// thresholds and no rankings, and it comes from our own data rather than from
// the rival, so it cannot carry an injection.

export interface TradeBrief {
  /** Players we would move. Advertising these is the point. */
  surplus: { name: string; position: string }[];
  /** Positions where our starting lineup is thinnest. */
  thin: string[];
  /** If we already have a candidate for THIS manager, what we would ask for. */
  askFor: { name: string; position: string }[];
  /** The most recent offer from THIS manager and how it actually graded, so the
   *  DM argues from the real numbers instead of a script. The bot once told a
   *  rival a swap "moves my Sunday score by nothing" while its own engine had it
   *  at +7.2, and lost the argument to someone reading it more carefully. */
  lastOffer: { give: string[]; get: string[]; ourGain: number; theirGain: number; verdict: string; why: string } | null;
  /** Offers WE have sent this manager that are still open. Without this the
   *  coach denied a deal it had DM'd him about minutes earlier ("I did not take
   *  Andrews") because the brief only knew about inbound offers. */
  pendingFromUs: { give: string[]; get: string[] }[];
  /** Specific swaps against THIS manager that our own rules already clear.
   *  These are the deals the coach may name in a negotiation: each one has
   *  been through the same evaluation that decides a real offer, so agreeing
   *  to one in chat commits us to nothing we would not already accept. */
  deals: { give: string[]; get: string[]; theirGain: number }[];
}

/** Facts the DM reply is allowed to state. Empty is fine: the prompt tells the
 *  model to say it has nothing specific rather than invent something. */
/** The coach's OWN projected finish order, computed, not guessed. Ranks every
 *  team by projected points-for from its optimal bye-aware starting lineup over
 *  the remaining season (byeAwareLineupTotal), blended with current record once
 *  games have been played. Filip: "actually compute who is 2nd and 3rd." Without
 *  this the model picked a different 2nd/3rd every run off whichever two stars
 *  caught its eye; the computed order is stable and defensible (two stars do not
 *  fill a ten-slot lineup, which is why the star-heavy teams rank lower than they
 *  look). Fed into the brief as the coach's official prediction. */
export async function projectedFinishOrder(): Promise<string> {
  const snap = await snapshot();
  const [users, rosters, state] = await Promise.all([
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    sleeper.nflState(),
  ]);
  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));
  const week = Math.max(1, state.week ?? 1);
  const remaining: number[] = [];
  for (let w = week; w <= 15; w++) remaining.push(w);
  const settingsOf = new Map(rosters.map((r) => [r.roster_id, r.settings ?? {}]));

  const rows = [...snap.rosterOf.entries()].map(([rid, roster]) => {
    const owner = nameOf.get(snap.ownerIdOf.get(rid) ?? "") ?? `roster ${rid}`;
    const st: Partial<RosterSettings> = settingsOf.get(rid) ?? {};
    // Strength = optimal starting lineup projected week by week with bye players
    // removed (bye coverage), PLUS injury cover: the value of the bench as
    // insurance at each position, same as the trade engine scores a team. A
    // roster that survives a starter going down is genuinely stronger over a
    // season than one whose projection is all in its starters.
    const lineup = byeAwareLineupTotal(roster as never, remaining);
    const cover = depthInsurance(roster as never, DEFAULT_FAIRNESS);
    const projPerSeason = Math.round(lineup + cover);
    // Actual results pull once they exist; fpts is 0 preseason, so early on this
    // is pure projected strength, which is right.
    const score = projPerSeason + (st.fpts ?? 0) + (st.wins ?? 0) * 5;
    return { rid, owner: rid === snap.ourRosterId ? `${owner} (you, CoachClaude)` : owner, proj: projPerSeason, cover: Math.round(cover), wins: st.wins ?? 0, losses: st.losses ?? 0, score };
  }).sort((a, b) => b.score - a.score);

  return rows.map((r, i) =>
    `${i + 1}. ${r.owner} (projected strength ${r.proj}, incl. ${r.cover} of injury cover${r.wins || r.losses ? `, record ${r.wins}-${r.losses}` : ""})`).join("\n");
}

/** Full analysis of every team: rosters with rest-of-season projections and bye
 *  weeks, plus the weeks each team drops below its starter needs. All PUBLIC,
 *  all deterministic, handed to the coach so it can talk numbers and specific
 *  bye-week holes about ANY team without a tool call. Filip: "it should have
 *  all that information for every team at its fingertips." Tools were the other
 *  option and are the wrong one here: the DM model runs sandboxed because the
 *  input is a rival's message, and pre-computing keeps that guarantee while
 *  giving the model trustworthy, already-correct facts instead of a fetch it
 *  could get wrong or be tricked into. */
export async function leagueRostersContext(): Promise<string> {
  const snap = await snapshot();
  const users = await sleeper.leagueUsers(config.leagueId);
  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));
  const POS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
  // Dedicated starting slots a bye can leave empty (FLEX is flexible, ignored).
  const need: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };

  const blocks: string[] = [];
  for (const [rosterId, roster] of [...snap.rosterOf.entries()].sort((a, b) => a[0] - b[0])) {
    const owner = nameOf.get(snap.ownerIdOf.get(rosterId) ?? "") ?? `roster ${rosterId}`;
    const mine = rosterId === snap.ourRosterId ? " (MINE)" : "";
    const byPos: Record<string, typeof roster> = {};
    for (const p of roster) (byPos[p.position || "?"] ??= []).push(p);
    const lines = POS.filter((pos) => byPos[pos]?.length).map((pos) =>
      `  ${pos}: ` + byPos[pos]!
        .slice().sort((a, b) => b.points - a.points)
        .map((p) => `${p.name} (${Math.round(p.points)}${p.bye ? `, bye ${p.bye}` : ""}${p.onIr ? ", ON IR" : ""})`)
        .join(", "));
    // The model reads this brief and talks trades off it. A player on IR is
    // ours, but he is not startable and the rails will not let him be traded
    // away, so the brief says so in words rather than leaving the model to
    // treat a 131-point receiver as a normal chip. Before 2026-09-20 the brief
    // carried no IR information at all.
    const stashed = roster.filter((p) => p.onIr);
    if (stashed.length) {
      lines.push(`  on injured reserve (not startable, ${mine ? "NOT tradeable, do not offer them" : "the owner cannot start them"}): ${stashed.map((p) => p.name).join(", ")}`);
    }

    // Per-week starter holes from byes, weeks 1-14 (regular season pre-playoff).
    // IR players cannot fill a slot, so they do not count as available.
    const holes: string[] = [];
    for (let w = 1; w <= 14; w++) {
      const avail: Record<string, number> = {};
      for (const p of roster) if (p.bye !== w && !p.onIr) avail[p.position] = (avail[p.position] ?? 0) + 1;
      const short = POS.filter((pos) => (avail[pos] ?? 0) < (need[pos] ?? 0))
        .map((pos) => `${pos}=${avail[pos] ?? 0}/${need[pos] ?? 0}`);
      if (short.length) holes.push(`wk${w} ${short.join(" ")}`);
    }
    blocks.push(`${owner}${mine}:\n${lines.join("\n")}` + (holes.length ? `\n  bye holes: ${holes.join("; ")}` : ""));
  }
  return blocks.join("\n\n");
}

export async function tradeBriefFor(theirRosterId: number | null, gql: Gql = tokenGql()): Promise<TradeBrief> {
  void gql;
  const snap = await snapshotWithPending(gql);
  const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const cfg = DEFAULT_FAIRNESS;

  const surplus = ourRoster
    .filter((p) => giveEligibleForProposal(p, ourRoster, cfg).ok)
    .sort((a, b) => b.points - a.points)
    .slice(0, 6)
    .map((p) => ({ name: p.name, position: p.position }));

  // Thin = the starting slots where our best option is weakest relative to the
  // rest of the lineup. Coarse on purpose; it is conversational, not a valuation.
  const byPos = new Map<string, number>();
  for (const p of ourRoster) byPos.set(p.position, Math.max(byPos.get(p.position) ?? 0, p.points));
  const thin = [...byPos.entries()]
    .filter(([pos]) => ["RB", "WR", "TE", "QB"].includes(pos))
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([pos]) => pos);

  let askFor: { name: string; position: string }[] = [];
  let deals: TradeBrief["deals"] = [];
  let lastOffer: TradeBrief["lastOffer"] = null;
  const pendingFromUs: TradeBrief["pendingFromUs"] = [];
  if (theirRosterId !== null) {
    try {
      const week = Math.max(1, (await sleeper.nflState()).week ?? 1);
      for (const t of await outstandingOffers(gql, week)) {
        if (!t.rosterIds.includes(theirRosterId)) continue;
        const nameOf = (id: string) => snap.playerById.get(id)?.name ?? id;
        pendingFromUs.push({
          give: Object.entries(t.drops).filter(([, r]) => r === snap.ourRosterId).map(([id]) => nameOf(id)),
          get: Object.entries(t.adds).filter(([, r]) => r === snap.ourRosterId).map(([id]) => nameOf(id)),
        });
      }
    } catch { /* an unreadable offer list must not blank the brief */ }
    const ev = recentEvents(400).reverse().find((e) =>
      e.type === "trade-offer" && (e.detail as { theirRosterId?: number } | undefined)?.theirRosterId === theirRosterId);
    const d = ev?.detail as { sides?: { give: string[]; receive: string[] }; ourGain?: number; theirGain?: number; verdict?: string; reasons?: string[] } | undefined;
    if (d?.sides) {
      lastOffer = {
        give: d.sides.give, get: d.sides.receive,
        ourGain: d.ourGain ?? 0, theirGain: d.theirGain ?? 0, verdict: d.verdict ?? "reject",
        why: (d.reasons ?? []).find((r) => /net of schedule|below the floor|ceiling/.test(r)) ?? (d.reasons ?? [])[0] ?? "",
      };
    }
  }
  if (theirRosterId !== null) {
    const theirRoster = snap.rosterOf.get(theirRosterId) ?? [];
    if (theirRoster.length) {
      const sched = await scheduleContext(theirRosterId);
      const best = proposeTrades(ourRoster, [{ managerId: String(theirRosterId), teamName: `roster ${theirRosterId}`, roster: theirRoster }],
        { ...cfg, ...sched }, 1)[0];
      const top = proposeTrades(ourRoster, [{ managerId: String(theirRosterId), teamName: `roster ${theirRosterId}`, roster: theirRoster }],
        { ...cfg, ...sched }, 3);
      if (top[0]) askFor = top[0].offer.receive.map((p) => ({ name: p.name, position: p.position }));
      deals = top.map((d) => ({
        give: d.offer.give.map((p) => `${p.name} (${p.position})`),
        get: d.offer.receive.map((p) => `${p.name} (${p.position})`),
        theirGain: d.theirGain,
      }));
      void best;
    }
  }
  return { surplus, thin, askFor, deals, lastOffer, pendingFromUs };
}

/** Render the brief for the prompt. Explicitly bounded: the model is told these
 *  are the only players it may name. */
export function briefText(b: TradeBrief): string {
  const list = (ps: { name: string; position: string }[]) =>
    ps.length ? ps.map((p) => `${p.name} (${p.position})`).join(", ") : "none";
  const lines = [
    `Players I would trade away for the right return (they are my injury cover, so the return has to reflect that): ${list(b.surplus)}.`,
    `Positions I am thinnest at: ${b.thin.length ? b.thin.join(", ") : "none in particular"}.`,
    b.askFor.length
      ? `From this manager I am most interested in: ${list(b.askFor)}.`
      : `I have no specific target on this manager roster right now.`,
  ];
  if (b.pendingFromUs.length) {
    lines.push(
      `Offers I currently have OUT to this manager, awaiting their answer: ` +
      b.pendingFromUs.map((o) => `I give ${o.give.join(" + ") || "nothing"}, I get ${o.get.join(" + ") || "nothing"}`).join("; ") + `.`,
      `If they ask about one of these, confirm it and stand by it. Never deny an offer you have made.`,
    );
  }
  if (b.lastOffer) {
    const lo = b.lastOffer;
    lines.push(
      `Their most recent offer to me: I give ${lo.give.join(" + ") || "nothing"}, I get ${lo.get.join(" + ") || "nothing"}. ` +
      `My honest numbers on it: ${lo.ourGain >= 0 ? "+" : ""}${lo.ourGain} per week to my lineup, ${lo.theirGain >= 0 ? "+" : ""}${lo.theirGain} to theirs, verdict ${lo.verdict.toUpperCase()}` +
      (lo.why ? ` (${lo.why})` : "") + `.`,
      `If they ask why, argue from THESE numbers. If my gain was positive, say so and say it fell short of the margin; never claim a trade did nothing when the number says otherwise.`,
    );
  }
  if (b.deals.length) {
    lines.push(
      `Swaps with THIS manager that I would accept today, in order of preference:`,
      ...b.deals.map((d, i) => `  ${i + 1}. I give ${d.give.join(" + ")}, I get ${d.get.join(" + ")}.`),
      `You may name any of these in the conversation and say you would do it. They have already passed my own evaluation, so offering one commits me to nothing I would not accept anyway.`,
    );
  } else {
    lines.push(`I have no ready-made swap with this manager, so do not invent one. Invite them to send an offer instead.`);
  }
  lines.push(
    `My acceptance rule, which you may state plainly: I accept any trade that does not leave my team worse off, and bench players count as injury cover, so bench-for-bench is judged on what each side gives up behind its starters. I do not haggle for the sake of it.`,
    `These are the ONLY players you may name. If they ask about anyone else, say you will look at a formal offer, and do not invent an opinion about a player who is not listed here.`,
    `Say "send it as a real offer" at most once in a reply. Repeating it in every sentence reads like a brush-off, and the point is to get trades done.`,
  );
  return lines.join("\n");
}

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
