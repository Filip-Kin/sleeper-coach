// What the coach may say in a DM: the brief.
//
// The DM model runs sandboxed with no tools and WITHOUT the coach system prompt,
// which is what makes it safe. The cost is that it knows nothing: asked "who on
// my team do you want", it bluffed, and asked about a Bijan-for-Collins swap it
// called Bijan "a cornerstone I am building around" when Bijan is on THEIR
// roster. Confident nonsense, and it refused every trade, which works against us
// because we WANT offers.
//
// So it gets a brief of facts we are happy to publish. This is safe to share by
// construction: the surplus list is exactly what we are trying to trade away, so
// telling them is the entire point. It carries no valuations, no thresholds and
// no rankings, and it comes from our own data rather than from the rival, so it
// cannot carry an injection.
//
// ONE SNAPSHOT. The three blocks (finish order, every roster, trade facts) used
// to each fetch their own snapshot, and only the trade facts applied trades in
// flight. On 2026-09-23 that put a player on two rosters at once inside one
// prompt. buildDmBrief takes snapshotWithPending exactly once and every block
// renders from it. The async wrappers below still exist for callers that want
// one block, and they accept the snapshot so nobody has to fetch twice.
//
// SECOND PERSON. The system prompt says "You are CoachClaude", so the brief
// says "you give", "you have sent", "your lineup". A brief in the first person
// ("I give") next to a prompt in the second was one reason the model lost track
// of which roster was whose. Every number is a season total, and the label says
// so; the old "per week" label was wrong by a factor of thirteen.

import { config } from "../config.ts";
import { recentEvents, type ActivityEvent } from "../log.ts";
import { tokenGql, outstandingOffers, type Gql, type PendingTrade } from "./api.ts";
import { snapshotWithPending, scheduleContext, type LeagueSnapshot } from "../analysis/trade-wire.ts";
import { proposeTrades, giveEligibleForProposal, byeAwareLineupTotal, depthInsurance, DEFAULT_FAIRNESS, type FairnessConfig } from "../analysis/trade-fair.ts";
import { sleeper } from "../sleeper/client.ts";
import type { LeagueUser, RosterSettings } from "../sleeper/types.ts";

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

export interface Counterpart { rosterId: number; displayName: string; teamName: string }

/** Everything handleDms needs for one reply, built from ONE snapshot. */
export interface DmBrief {
  /** The full brief block for the system prompt. */
  text: string;
  brief: TradeBrief;
  snap: LeagueSnapshot;
  teamName: (rosterId: number) => string;
  /** Null when the sender owns no roster in our league. */
  counterpart: Counterpart | null;
}

export const COUNTERPART_TAG = "(THE MANAGER YOU ARE TALKING TO)";
export const MINE_TAG = "(MINE)";

/** The first line of the DM system prompt. Naming the counterpart is what lets
 *  the model tell "my" from "your" in a thread where both sides say both. */
export function counterpartOpener(c: Counterpart | null): string {
  if (!c) return "You are talking to someone who is not in this league as a manager; do not discuss trades with them.";
  return `You are talking to ${c.displayName}, who manages ${c.teamName} (roster ${c.rosterId}).`;
}

// #region finish order
/** The coach's OWN projected finish order, computed, not guessed. Ranks every
 *  team by projected points-for from its optimal bye-aware starting lineup over
 *  the remaining season (byeAwareLineupTotal), blended with current record once
 *  games have been played. Filip: "actually compute who is 2nd and 3rd." Without
 *  this the model picked a different 2nd/3rd every run off whichever two stars
 *  caught its eye; the computed order is stable and defensible (two stars do not
 *  fill a ten-slot lineup, which is why the star-heavy teams rank lower than they
 *  look). Fed into the brief as the coach's official prediction. */
export function renderFinishOrder(
  snap: LeagueSnapshot, nameOf: Map<string, string>, settingsOf: Map<number, Partial<RosterSettings>>, week: number,
): string {
  const remaining: number[] = [];
  for (let w = week; w <= 15; w++) remaining.push(w);
  const rows = [...snap.rosterOf.entries()].map(([rid, roster]) => {
    const owner = nameOf.get(snap.ownerIdOf.get(rid) ?? "") ?? `roster ${rid}`;
    const st: Partial<RosterSettings> = settingsOf.get(rid) ?? {};
    // Strength = optimal starting lineup projected week by week with bye players
    // removed (bye coverage), PLUS injury cover: the value of the bench as
    // insurance at each position, same as the trade engine scores a team. A
    // roster that survives a starter going down is genuinely stronger over a
    // season than one whose projection is all in its starters.
    const lineup = byeAwareLineupTotal(roster, remaining);
    const cover = depthInsurance(roster, DEFAULT_FAIRNESS);
    const projPerSeason = Math.round(lineup + cover);
    // Actual results pull once they exist; fpts is 0 preseason, so early on this
    // is pure projected strength, which is right.
    const score = projPerSeason + (st.fpts ?? 0) + (st.wins ?? 0) * 5;
    return { rid, owner: rid === snap.ourRosterId ? `${owner} (you, CoachClaude)` : owner, proj: projPerSeason, cover: Math.round(cover), wins: st.wins ?? 0, losses: st.losses ?? 0, score };
  }).sort((a, b) => b.score - a.score);

  return rows.map((r, i) =>
    `${i + 1}. ${r.owner} (projected strength ${r.proj} season points, incl. ${r.cover} of injury cover${r.wins || r.losses ? `, record ${r.wins}-${r.losses}` : ""})`).join("\n");
}

export async function projectedFinishOrder(snap?: LeagueSnapshot): Promise<string> {
  const s = snap ?? await snapshotWithPending();
  const [users, rosters, state] = await Promise.all([
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    sleeper.nflState(),
  ]);
  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));
  const settingsOf = new Map(rosters.map((r) => [r.roster_id, r.settings ?? {}]));
  return renderFinishOrder(s, nameOf, settingsOf, Math.max(1, state.week ?? 1));
}
// #endregion

// #region rosters
/** Full analysis of every team: rosters with rest-of-season projections and bye
 *  weeks, plus the weeks each team drops below its starter needs. All PUBLIC,
 *  all deterministic, handed to the coach so it can talk numbers and specific
 *  bye-week holes about ANY team without a tool call. Filip: "it should have
 *  all that information for every team at its fingertips." Tools were the other
 *  option and are the wrong one here: the DM model runs sandboxed because the
 *  input is a rival's message, and pre-computing keeps that guarantee while
 *  giving the model trustworthy, already-correct facts instead of a fetch it
 *  could get wrong or be tricked into.
 *
 *  Exactly one block carries COUNTERPART_TAG and exactly one carries MINE_TAG. */
export function renderRosters(snap: LeagueSnapshot, nameOf: Map<string, string>, theirRosterId: number | null): string {
  const POS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
  // Dedicated starting slots a bye can leave empty (FLEX is flexible, ignored).
  const need: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };

  const blocks: string[] = [];
  for (const [rosterId, roster] of [...snap.rosterOf.entries()].sort((a, b) => a[0] - b[0])) {
    const owner = nameOf.get(snap.ownerIdOf.get(rosterId) ?? "") ?? `roster ${rosterId}`;
    const mine = rosterId === snap.ourRosterId;
    const tag = mine ? ` ${MINE_TAG}` : rosterId === theirRosterId ? ` ${COUNTERPART_TAG}` : "";
    const byPos: Record<string, typeof roster> = {};
    for (const p of roster) (byPos[p.position || "?"] ??= []).push(p);
    const lines = POS.filter((pos) => byPos[pos]?.length).map((pos) =>
      `  ${pos}: ` + byPos[pos]!
        .slice().sort((a, b) => b.points - a.points)
        .map((p) => `${p.name} (${Math.round(p.points)} season points${p.bye ? `, bye ${p.bye}` : ""}${p.onIr ? ", ON IR" : ""})`)
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
    blocks.push(`${owner}${tag}:\n${lines.join("\n")}` + (holes.length ? `\n  bye holes: ${holes.join("; ")}` : ""));
  }
  return blocks.join("\n\n");
}

export async function leagueRostersContext(theirRosterId: number | null = null, snap?: LeagueSnapshot): Promise<string> {
  const s = snap ?? await snapshotWithPending();
  const users = await sleeper.leagueUsers(config.leagueId);
  return renderRosters(s, new Map(users.map((u) => [u.user_id, u.display_name])), theirRosterId);
}
// #endregion

// #region trade facts
export interface BriefInputs {
  /** Our open offers, every rival (filtered here). */
  offers: PendingTrade[];
  sched: Partial<FairnessConfig>;
  /** The most recent trade-offer event from THIS manager, if any. */
  lastOfferEvent: ActivityEvent | undefined;
}

/** Pure: every fact in the brief derived from the snapshot and the inputs. */
export function tradeBriefFromSnapshot(snap: LeagueSnapshot, theirRosterId: number | null, inputs: BriefInputs): TradeBrief {
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
    const nameOf = (id: string) => snap.playerById.get(id)?.name ?? id;
    for (const t of inputs.offers) {
      if (!t.rosterIds.includes(theirRosterId)) continue;
      pendingFromUs.push({
        give: Object.entries(t.drops).filter(([, r]) => r === snap.ourRosterId).map(([id]) => nameOf(id)),
        get: Object.entries(t.adds).filter(([, r]) => r === snap.ourRosterId).map(([id]) => nameOf(id)),
      });
    }
    const d = inputs.lastOfferEvent?.detail as { sides?: { give: string[]; receive: string[] }; ourGain?: number; theirGain?: number; verdict?: string; reasons?: string[] } | undefined;
    if (d?.sides) {
      lastOffer = {
        give: d.sides.give, get: d.sides.receive,
        ourGain: d.ourGain ?? 0, theirGain: d.theirGain ?? 0, verdict: d.verdict ?? "reject",
        why: (d.reasons ?? []).find((r) => /net of schedule|below the floor|ceiling/.test(r)) ?? (d.reasons ?? [])[0] ?? "",
      };
    }
    const theirRoster = snap.rosterOf.get(theirRosterId) ?? [];
    if (theirRoster.length) {
      const top = proposeTrades(ourRoster, [{ managerId: String(theirRosterId), teamName: `roster ${theirRosterId}`, roster: theirRoster }],
        { ...cfg, ...inputs.sched }, 3);
      if (top[0]) askFor = top[0].offer.receive.map((p) => ({ name: p.name, position: p.position }));
      deals = top.map((d) => ({
        give: d.offer.give.map((p) => `${p.name} (${p.position})`),
        get: d.offer.receive.map((p) => `${p.name} (${p.position})`),
        theirGain: d.theirGain,
      }));
    }
  }
  return { surplus, thin, askFor, deals, lastOffer, pendingFromUs };
}

async function briefInputs(theirRosterId: number | null, gql: Gql): Promise<BriefInputs> {
  if (theirRosterId === null) return { offers: [], sched: {}, lastOfferEvent: undefined };
  let offers: PendingTrade[] = [];
  try {
    const week = Math.max(1, (await sleeper.nflState()).week ?? 1);
    offers = await outstandingOffers(gql, week);
  } catch { /* an unreadable offer list must not blank the brief */ }
  const lastOfferEvent = recentEvents(400).reverse().find((e) =>
    e.type === "trade-offer" && (e.detail as { theirRosterId?: number } | undefined)?.theirRosterId === theirRosterId);
  const sched = await scheduleContext(theirRosterId);
  return { offers, sched, lastOfferEvent };
}

export async function tradeBriefFor(theirRosterId: number | null, gql: Gql = tokenGql(), snap?: LeagueSnapshot): Promise<TradeBrief> {
  const s = snap ?? await snapshotWithPending(gql);
  return tradeBriefFromSnapshot(s, theirRosterId, await briefInputs(theirRosterId, gql));
}

/** The label the engine's reason strings use for a season-scale delta. Those
 *  strings are owned by trade-fair.ts; the brief relabels them on the way in so
 *  no number in the prompt is ever called weekly. */
function seasonUnits(s: string): string {
  return s.replace(/\bper week\b/gi, "season points").replace(/\ba week\b/gi, "a season");
}

/** Render the brief for the prompt. Explicitly bounded: the model is told these
 *  are the only players it may name. Second person throughout. */
export function briefText(b: TradeBrief): string {
  const list = (ps: { name: string; position: string }[]) =>
    ps.length ? ps.map((p) => `${p.name} (${p.position})`).join(", ") : "none";
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
  const lines = [
    `You would trade away these players for the right return (they are your injury cover, so the return has to reflect that): ${list(b.surplus)}.`,
    `Positions you are thinnest at: ${b.thin.length ? b.thin.join(", ") : "none in particular"}.`,
    b.askFor.length
      ? `From this manager you are most interested in: ${list(b.askFor)}.`
      : `You have no specific target on this manager's roster right now.`,
  ];
  if (b.pendingFromUs.length) {
    lines.push(
      `You have sent this manager these offers and they are still open, awaiting their answer: ` +
      b.pendingFromUs.map((o) => `you give ${o.give.join(" + ") || "nothing"}, you get ${o.get.join(" + ") || "nothing"}`).join("; ") + `.`,
      `If they ask about one of these, confirm it and stand by it. Never deny an offer you have made.`,
    );
  } else {
    lines.push(`You have no offer out to this manager right now. Do not describe one as sent or in their inbox.`);
  }
  if (b.lastOffer) {
    const lo = b.lastOffer;
    lines.push(
      `Their most recent offer to you: you give ${lo.give.join(" + ") || "nothing"}, you get ${lo.get.join(" + ") || "nothing"}. ` +
      `Your numbers on it: ${signed(lo.ourGain)} season points to your lineup, ${signed(lo.theirGain)} season points to theirs, verdict ${lo.verdict.toUpperCase()}` +
      (lo.why ? ` (${seasonUnits(lo.why)})` : "") + `.`,
      `If they ask why, argue from THESE numbers. If your gain was positive, say so and say it fell short of the margin; never claim a trade did nothing when the number says otherwise.`,
    );
  }
  if (b.deals.length) {
    lines.push(
      `Swaps with THIS manager that you would accept today, in order of preference:`,
      ...b.deals.map((d, i) => `  ${i + 1}. you give ${d.give.join(" + ")}, you get ${d.get.join(" + ")}.`),
      `You may name any of these in the conversation and say you would do it. They have already passed your own evaluation, so offering one commits you to nothing you would not accept anyway.`,
    );
  } else {
    lines.push(`You have no ready-made swap with this manager, so do not invent one. Invite them to send an offer instead.`);
  }
  lines.push(
    `Your acceptance rule, which you may state plainly: you accept any trade that does not leave your team worse off, and bench players count as injury cover, so bench-for-bench is judged on what each side gives up behind its starters. You do not haggle for the sake of it.`,
    `These are the ONLY players you may put in a trade. If they ask about anyone else, say you will look at a formal offer, and do not invent an opinion about a player who is not listed here.`,
    `All numbers above are season totals in fantasy points, never weekly. Say "send it as a real offer" at most once in a reply. Repeating it in every sentence reads like a brush-off, and the point is to get trades done.`,
  );
  return lines.join("\n");
}
// #endregion

// #region the whole brief
/** Which roster does this Sleeper user own? Needed so the brief can name what we
 *  want from THEIR team specifically rather than in general. */
export function rosterIdForUser(snap: LeagueSnapshot, userId: string): number | null {
  for (const [rosterId, owner] of snap.ownerIdOf) if (owner === userId) return rosterId;
  return null;
}

export function teamNameOf(users: LeagueUser[], snap: LeagueSnapshot): (rosterId: number) => string {
  const byUser = new Map(users.map((u) => [u.user_id, u]));
  return (rosterId) => {
    const u = byUser.get(snap.ownerIdOf.get(rosterId) ?? "");
    if (!u) return `roster ${rosterId}`;
    return u.metadata?.team_name?.trim() || u.display_name;
  };
}

/** Every block from ONE snapshot. */
export async function buildDmBrief(gql: Gql, theirUserId: string): Promise<DmBrief> {
  const [snap, users, rosters, state] = await Promise.all([
    snapshotWithPending(gql),
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    sleeper.nflState(),
  ]);
  const theirRosterId = rosterIdForUser(snap, theirUserId);
  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name]));
  const teamName = teamNameOf(users, snap);
  const counterpart: Counterpart | null = theirRosterId === null ? null : {
    rosterId: theirRosterId,
    displayName: nameOf.get(theirUserId) ?? `roster ${theirRosterId}`,
    teamName: teamName(theirRosterId),
  };
  const settingsOf = new Map(rosters.map((r) => [r.roster_id, r.settings ?? {}]));
  const week = Math.max(1, state.week ?? 1);
  const finish = renderFinishOrder(snap, nameOf, settingsOf, week);
  const rostersText = renderRosters(snap, nameOf, theirRosterId);
  const brief = tradeBriefFromSnapshot(snap, theirRosterId, await briefInputs(theirRosterId, gql));
  const text =
    `YOUR COMPUTED FINISH PREDICTION (by projected roster strength: optimal bye-aware lineup plus injury cover, blended with record once games are played). State this order when asked where teams finish; do not improvise a different one:\n${finish}\n\n` +
    `LEAGUE ROSTERS AND ANALYSIS (every team, with rest-of-season projections in season points, bye weeks, and the weeks each team is short a starter). The block tagged ${MINE_TAG} is YOUR roster, CoachClaude; the block tagged ${COUNTERPART_TAG} belongs to the person you are replying to:\n${rostersText}\n\n` +
    `TRADE FACTS:\n${briefText(brief)}`;
  return { text, brief, snap, teamName, counterpart };
}
// #endregion
