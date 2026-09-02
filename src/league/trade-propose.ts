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
import { browserGql, proposeTrade, outstandingOffers, listDms, sendDm, type Gql } from "./api.ts";
import { snapshot, scheduleContext } from "../analysis/trade-wire.ts";
import { proposeTrades, giveEligibleForProposal, DEFAULT_FAIRNESS, type Proposal, type RivalRoster } from "../analysis/trade-fair.ts";
import { sleeper } from "../sleeper/client.ts";

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
}

export function pairKey(managerId: string, receive: string[], give: string[]): string {
  return [managerId, [...receive].sort().join("+"), [...give].sort().join("+")].join("|");
}

/** Has this exact swap been offered to this manager recently? */
export function onCooldown(
  db: Database, key: string, now: number, cooldownDays = REPROPOSE_COOLDOWN_DAYS,
): boolean {
  const row = db.query<{ at: number }, [string, number]>(
    "SELECT at FROM trade_proposals WHERE pair_key = ? AND at > ? ORDER BY at DESC LIMIT 1",
  ).get(key, now - cooldownDays * 86_400_000);
  return row !== null && row !== undefined;
}

function ensureTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS trade_proposals (
    pair_key TEXT NOT NULL, manager_id TEXT NOT NULL, transaction_id TEXT,
    at INTEGER NOT NULL, why TEXT)`);
}

export interface ProposeResult {
  sent: Proposal | null;
  considered: number;
  reason: string;
}

/** Decide without sending, and WITHOUT recording a cooldown. A dry run that
 *  wrote the cooldown row would make the next real run skip the offer it had
 *  just chosen. */
export async function dryRunProposer(state: ProposerState, gql: Gql = browserGql()): Promise<ProposeResult> {
  return runProposer({ ...state, dry: true }, gql);
}

export async function runProposer(state: ProposerState, gql: Gql = browserGql()): Promise<ProposeResult> {
  const db = state.db;
  const now = state.now ?? Date.now();
  ensureTable(db);

  const frozen = freezeState();
  if (frozen.frozen) return { sent: null, considered: 0, reason: `frozen: ${frozen.reason ?? "no reason given"}` };

  const nfl = await sleeper.nflState();
  const league = await sleeper.league(config.leagueId);
  const week = Math.max(1, nfl.week ?? 1);
  const deadline = league.settings.trade_deadline ?? 11;
  if (week > deadline) return { sent: null, considered: 0, reason: `past the week ${deadline} trade deadline` };

  const open = await outstandingOffers(gql, week);
  if (open.length >= MAX_OPEN_OFFERS) {
    return { sent: null, considered: 0, reason: `${open.length} of our offers are still unanswered` };
  }
  const busyRosters = new Set(open.flatMap((t) => t.rosterIds));

  const snap = await snapshot();
  const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const rivals: RivalRoster[] = [];
  for (const [rosterId, roster] of snap.rosterOf) {
    if (rosterId === snap.ourRosterId) continue;
    if (busyRosters.has(rosterId)) continue; // already waiting on them
    rivals.push({ managerId: String(rosterId), teamName: `roster ${rosterId}`, roster });
  }
  if (!rivals.length) return { sent: null, considered: 0, reason: "no rival is free to receive an offer" };

  // Schedule dilution is per rival, so evaluate each against its own head to
  // head count rather than one blended number.
  const candidates: Proposal[] = [];
  for (const rival of rivals) {
    const sched = await scheduleContext(Number(rival.managerId));
    candidates.push(...proposeTrades(ourRoster, [rival], { ...DEFAULT_FAIRNESS, ...sched }, 5));
  }
  candidates.sort((a, b) => b.score - a.score || b.theirGain - a.theirGain);

  const fresh = candidates.filter((c) =>
    !onCooldown(db, pairKey(c.managerId, c.offer.receive.map((p) => p.name), c.offer.give.map((p) => p.name)), now));
  const best = fresh[0];
  if (!best) {
    return { sent: null, considered: candidates.length,
      reason: candidates.length ? "every candidate was offered recently" : "no offer helps both sides right now" };
  }

  if (state.dry) return { sent: best, considered: candidates.length, reason: "dry run, nothing sent" };

  assertWritesAllowed("trade propose");
  const theirRosterId = Number(best.managerId);
  const adds: Record<string, number> = {};
  const drops: Record<string, number> = {};
  for (const p of best.offer.receive) {
    const id = snap.idByName.get(p.name);
    if (!id) return { sent: null, considered: candidates.length, reason: `could not resolve a player id for ${p.name}` };
    adds[id] = config.rosterId; drops[id] = theirRosterId;
  }
  for (const p of best.offer.give) {
    const id = snap.idByName.get(p.name);
    if (!id) return { sent: null, considered: candidates.length, reason: `could not resolve a player id for ${p.name}` };
    adds[id] = theirRosterId; drops[id] = config.rosterId;
  }

  const res = await proposeTrade(gql, {
    adds, drops,
    expiresAt: Math.floor((now + OFFER_TTL_DAYS * 86_400_000) / 1000),
  });

  const key = pairKey(best.managerId, best.offer.receive.map((p) => p.name), best.offer.give.map((p) => p.name));
  db.run("INSERT INTO trade_proposals (pair_key, manager_id, transaction_id, at, why) VALUES (?, ?, ?, ?, ?)",
    [key, best.managerId, res.transactionId, now, best.why]);
  logEvent("coach", "trade-proposed", `Offered ${best.offer.give.map((p) => p.name).join(", ")} for ${best.offer.receive.map((p) => p.name).join(", ")} to roster ${best.managerId}`, {
    transaction_id: res.transactionId, status: res.status, why: best.why,
    ourGain: best.ourGain, theirGain: best.theirGain, considered: candidates.length,
  });

  // A bare offer notification is easy to ignore. A line saying why it is good
  // for THEM is what gets it looked at.
  try {
    const owner = snap.ownerIdOf.get(theirRosterId);
    const dm = owner ? (await listDms(gql, 25)).find((d) => d.lastAuthorId === owner || d.title?.includes(owner)) : null;
    if (dm) {
      await sendDm(gql, dm.dmId, pitchText(best));
    }
  } catch { /* the offer stands with or without the sales pitch */ }

  return { sent: best, considered: candidates.length, reason: "sent" };
}

/** The pitch. Deterministic, and honest about their side: the number is the one
 *  we actually computed for them, which is also the argument for saying yes. */
export function pitchText(p: Proposal): string {
  const give = p.offer.give.map((x) => x.name).join(", ");
  const get = p.offer.receive.map((x) => x.name).join(", ");
  return `Offer sent: you get ${give}, I get ${get}. By my numbers that is +${p.theirGain} to your starting lineup, ` +
    `which is why I think you take it. It is +${p.ourGain} to mine, so we both win. No hard feelings if you pass.`;
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
  /** Specific swaps against THIS manager that our own rules already clear.
   *  These are the deals the coach may name in a negotiation: each one has
   *  been through the same evaluation that decides a real offer, so agreeing
   *  to one in chat commits us to nothing we would not already accept. */
  deals: { give: string[]; get: string[]; theirGain: number }[];
}

/** Facts the DM reply is allowed to state. Empty is fine: the prompt tells the
 *  model to say it has nothing specific rather than invent something. */
export async function tradeBriefFor(theirRosterId: number | null, gql: Gql = browserGql()): Promise<TradeBrief> {
  void gql;
  const snap = await snapshot();
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
  if (theirRosterId !== null) {
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
  return { surplus, thin, askFor, deals, lastOffer };
}

/** Render the brief for the prompt. Explicitly bounded: the model is told these
 *  are the only players it may name. */
export function briefText(b: TradeBrief): string {
  const list = (ps: { name: string; position: string }[]) =>
    ps.length ? ps.map((p) => `${p.name} (${p.position})`).join(", ") : "none";
  const lines = [
    `Players I would trade away: ${list(b.surplus)}.`,
    `Positions I am thinnest at: ${b.thin.length ? b.thin.join(", ") : "none in particular"}.`,
    b.askFor.length
      ? `From this manager I am most interested in: ${list(b.askFor)}.`
      : `I have no specific target on this manager roster right now.`,
  ];
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
    `My acceptance rule, which you may state plainly: I accept any trade that does not make my starting lineup worse, and I do not haggle for the sake of it.`,
    `These are the ONLY players you may name. If they ask about anyone else, say you will look at a formal offer, and do not invent an opinion about a player who is not listed here.`,
    `Say "send it as a real offer" at most once in a reply. Repeating it in every sentence reads like a brush-off, and the point is to get trades done.`,
  );
  return lines.join("\n");
}
