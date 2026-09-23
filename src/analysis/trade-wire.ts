// Assemble the real rosters the two-sided trade evaluator needs, from the live
// API plus our own projections and news dossier.
//
// This is the missing link found in the pre-launch audit: src/analysis/trade-fair.ts
// implemented the whole decision (schedule-diluted value, a floor on our own gain,
// trade-specific rails, injury refusal) and NOTHING CALLED IT. The daemon was
// still doing shadow alerts with no verdict attached, so the decision engine was
// unreachable from the running system.
//
// Everything a poll needs is read ONCE into a LeagueSnapshot and handed down.
// The 2026-09-23 audit found three fetches of the same rosters in one poll, one
// of which fell back to REST and lost the IR flag (T2, T3).

import { config } from "../config.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import type { Roster } from "../sleeper/types.ts";
import { tokenGql, pendingRosterDelta, applyRosterDelta, pendingTrades, type Gql, type PendingTrade } from "../league/api.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadSeasonProjections } from "./projections.ts";
import { rankByVor } from "./vor.ts";
import { loadNews, applyNews } from "../data/news.ts";
import { loadPlayers } from "../data/players.ts";
import { byeWeek } from "../data/byes.ts";
import { activeCapacity } from "./roster-fit.ts";
import { RosterSourceError } from "./roster-view.ts";
import type { TradePlayer, TradeOffer } from "./trade.ts";
import {
  evaluateTradeTwoSided, evaluateTradeMultiSided, opponentWeight,
  type FairnessConfig, DEFAULT_FAIRNESS, type TwoSidedEvaluation, type MultiSidedEvaluation, type OpponentSide,
} from "./trade-fair.ts";

export interface LeagueSnapshot {
  playerById: Map<string, TradePlayer>;
  rosterOf: Map<number, TradePlayer[]>; // roster_id -> players, every entry carrying playerId and onIr
  ourRosterId: number;
  /** Kept for display code. Every write path keys on `playerId` from the
   *  roster entries instead: rostered names collide (two Josh Allens in the
   *  dump), ids do not. */
  idByName: Map<string, string>;
  ownerIdOf: Map<number, string>; // roster_id -> Sleeper user_id
  /** Current NFL week, the leg open transactions are filed under. */
  week: number;
  /** Active-roster cap, so a trade can be checked for legality before accept. */
  capacity: number;
}

// #region pure pieces
/** Statuses that keep a player off the field, as ros-projections.ts counts
 *  them. The stash rule ("hurt now, real talent, still time to come back")
 *  is the one the drop rails use; the trade rails claimed it for a year
 *  without ever receiving the flag (T5). Same rule, same inputs, computed
 *  here from the season board and the dump's injury status so the trade
 *  snapshot does not have to pull twelve weekly tables per poll. */
const RESERVE_STATUSES = new Set(["IR", "PUP", "NA", "SUS", "DNR", "COV", "OUT", "DOUBTFUL"]);
export const STASH_SEASON_MIN = 120;
const CHAMPIONSHIP_WEEK = 17;
export function stashFlag(injuryStatus: string | null | undefined, seasonPoints: number, week: number): boolean {
  const injured = RESERVE_STATUSES.has((injuryStatus ?? "").trim().toUpperCase());
  return injured && seasonPoints >= STASH_SEASON_MIN && week < CHAMPIONSHIP_WEEK;
}

/** Each roster as the trade engine values it. Pure, so the IR rule is testable.
 *  Throws when a roster came from the cached REST endpoint (no player_map):
 *  IR cannot be told from active there, and a snapshot that guessed offered an
 *  IR player as a starter (T3). An EMPTY roster with no map is fine, which is
 *  what staging's orphan teams look like. */
export function tradeRostersFrom(rosters: Roster[], playerById: Map<string, TradePlayer>): Map<number, TradePlayer[]> {
  // OWNED, not active. A player on IR is still ours to trade and still carries
  // his rest-of-season value (which already discounts the games he misses).
  // Excluding him here, as a 2026-09-19 patch did, made Nico Collins invisible
  // to the engine: a trade giving him away evaluated 25 points better than it
  // was, and the only thing that stopped it was a rail firing by accident. The
  // onIr flag is what tells the lineup and depth terms he cannot play this
  // week, and what the give-away rail keys on; that is where "cannot play"
  // belongs, not here.
  const rosterOf = new Map<number, TradePlayer[]>();
  for (const r of rosters) {
    if (!r.player_map && (r.players?.length ?? 0) > 0) throw new RosterSourceError(r.roster_id);
    const onIr = new Set(r.reserve ?? []);
    rosterOf.set(
      r.roster_id,
      (r.players ?? []).map((id) => ({ ...(playerById.get(id) ?? { name: id, position: "", points: 0 }), playerId: id, onIr: onIr.has(id) })),
    );
  }
  return rosterOf;
}

/** Our roster as it will stand once every trade we have agreed to processes.
 *  Pure. A player leaving in an in-flight trade is gone from the roster the
 *  proposer and the counter path reason over, so he is never offered twice
 *  (T2). Arrivals are valued from the snapshot's player table. */
export function applyPending(
  snap: LeagueSnapshot, delta: { incoming: string[]; outgoing: string[] },
): LeagueSnapshot {
  if (!delta.incoming.length && !delta.outgoing.length) return snap;
  const current = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const byId = new Map(current.map((p) => [p.playerId ?? "", p]));
  const effectiveIds = applyRosterDelta(current.map((p) => p.playerId ?? ""), delta);
  const rosterOf = new Map(snap.rosterOf);
  rosterOf.set(snap.ourRosterId, effectiveIds.map((id) =>
    byId.get(id) ?? { ...(snap.playerById.get(id) ?? { name: id, position: "", points: 0 }), playerId: id, onIr: false }));
  return { ...snap, rosterOf };
}
// #endregion

// One fetch, reused for every offer in a poll cycle.
export async function snapshot(): Promise<LeagueSnapshot> {
  const [league, state] = await Promise.all([sleeper.league(config.leagueId), sleeper.nflState()]);
  const week = Math.max(1, state.week ?? 1);
  const raw = await loadSeasonProjections(config.season, league.scoring_settings);
  const news = await loadNews();
  const board = rankByVor(applyNews(raw, news.byKey).adjusted, league, raw);
  const byName = new Map(board.map((b) => [b.name, b]));
  const dump = (await loadPlayers()) as Record<string, { full_name?: string; position?: string; injury_status?: string | null; team?: string | null; depth_chart_order?: number | null }>;

  const playerById = new Map<string, TradePlayer>();
  for (const [id, p] of Object.entries(dump)) {
    const name = p.full_name ?? id; // team defences have no full_name; the id IS the team
    const b = byName.get(name);
    if (!b && !p.position) continue;
    playerById.set(id, {
      name,
      playerId: id,
      position: p.position ?? b?.position ?? "",
      points: b?.points ?? 0,
      injuryStatus: p.injury_status ?? undefined,
      returnsBeforePlayoffs: stashFlag(p.injury_status, b?.points ?? 0, week),
      bye: byeWeek(p.team ?? b?.team ?? "") ?? undefined,
      depthChartOrder: typeof p.depth_chart_order === "number" ? p.depth_chart_order : undefined,
    });
  }

  const rosters = await leagueRosters(config.leagueId);
  const rosterOf = tradeRostersFrom(rosters, playerById);
  const idByName = new Map<string, string>();
  const ownerIdOf = new Map<number, string>();
  for (const r of rosters) {
    for (const id of r.players ?? []) {
      const name = playerById.get(id)?.name;
      if (name) idByName.set(name, id);
    }
    if (r.owner_id) ownerIdOf.set(r.roster_id, String(r.owner_id));
  }
  return { playerById, rosterOf, ourRosterId: config.rosterId, idByName, ownerIdOf, week, capacity: activeCapacity(league.roster_positions) };
}

/** snapshot() reflects the CURRENT roster. This applies trades we have agreed
 *  to but that have not processed yet, so every "what do we have" decision
 *  (proposing, evaluating an incoming offer, the trade brief) reasons about the
 *  roster we are about to hold, not a stale one. Only OUR roster is adjusted;
 *  the counterparties' current rosters are what we evaluate against. */
export async function snapshotWithPending(gql: Gql = tokenGql(), leg?: number, base?: LeagueSnapshot): Promise<LeagueSnapshot> {
  const snap = base ?? (await snapshot());
  const week = leg ?? snap.week;
  const delta = await pendingRosterDelta(gql, week).catch(() => ({ incoming: [], outgoing: [] }));
  return applyPending(snap, delta);
}

/** The snapshot a counter-offer is picked from. One per poll; the DM watcher
 *  calls this rather than snapshot() so a player already leaving in an
 *  in-flight trade is never offered again. */
export async function counterSnapshot(gql: Gql, leg: number): Promise<LeagueSnapshot> {
  return snapshotWithPending(gql, leg);
}

// Turn a Sleeper trade transaction into an offer from OUR perspective, and score
// it. `adds`/`drops` map player_id -> roster_id receiving/losing him.
export type Tx = { adds?: Record<string, number> | null; drops?: Record<string, number> | null; roster_ids?: number[] };

/** Any single roster's own side of a transaction: what THEY give and receive,
 *  regardless of who else is party to it or how many are. Lineup math is
 *  roster-local, so this one function serves our side, one opponent, or every
 *  opponent in a three-way trade.
 *
 *  Each player is the ROSTER ENTRY from the roster he is leaving, so a
 *  received player carries the rival's onIr flag and a given player carries
 *  ours (T4). The bare player table is the fallback for an id no roster holds. */
function sideOf(tx: Tx, snap: LeagueSnapshot, rosterId: number): TradeOffer {
  const entry = (id: string, fromRoster: number | undefined): TradePlayer => {
    const held = fromRoster === undefined ? undefined : snap.rosterOf.get(fromRoster)?.find((p) => p.playerId === id);
    return held ?? { ...(snap.playerById.get(id) ?? { name: id, position: "", points: 0 }), playerId: id };
  };
  const receive: TradePlayer[] = [];
  const give: TradePlayer[] = [];
  for (const [id, rid] of Object.entries(tx.adds ?? {})) if (rid === rosterId) receive.push(entry(id, tx.drops?.[id]));
  for (const [id, rid] of Object.entries(tx.drops ?? {})) if (rid === rosterId) give.push(entry(id, rosterId));
  return { receive, give };
}

export function offerFromTransaction(
  tx: Tx, snap: LeagueSnapshot,
): { offer: TradeOffer; theirRosterId: number | null } {
  const theirRosterId = (tx.roster_ids ?? []).find((r) => r !== snap.ourRosterId) ?? null;
  return { offer: sideOf(tx, snap, snap.ourRosterId), theirRosterId };
}

/** Every roster in the transaction besides ours, each with their OWN give and
 *  receive (never a mirror of our offer, which only holds for a 2-party trade).
 *  A three-way trade needs this: roster 1 receiving two of our stars for
 *  nothing has to be judged on its own terms, not folded into whatever roster
 *  2's separate, fairer-looking leg does to the combined picture. */
export function otherSides(tx: Tx, snap: LeagueSnapshot): { rosterId: number; offer: TradeOffer }[] {
  const ids = new Set<number>();
  for (const rid of Object.values(tx.adds ?? {})) ids.add(rid);
  for (const rid of Object.values(tx.drops ?? {})) ids.add(rid);
  ids.delete(snap.ourRosterId);
  return [...ids].map((rosterId) => ({ rosterId, offer: sideOf(tx, snap, rosterId) }));
}

// How many remaining regular-season weeks, and how many of those we play them.
// Their gain is diluted by exactly this, so getting it wrong changes decisions.
export async function scheduleContext(theirRosterId: number | null): Promise<{ remainingWeeks: number; headToHeadRemaining: number; upcomingWeeks: number[] }> {
  const state = await sleeper.nflState();
  const league = await sleeper.league(config.leagueId);
  const playoffStart = league.settings.playoff_week_start ?? 16;
  const week = Math.max(1, state.week ?? 1);
  const remainingWeeks = Math.max(1, playoffStart - week);
  // The actual week numbers, so lineup value can be measured week by week with
  // bye players removed. A count alone cannot tell you which weeks have holes.
  const upcomingWeeks: number[] = [];
  for (let w = week; w < playoffStart; w++) upcomingWeeks.push(w);
  if (theirRosterId === null) return { remainingWeeks, headToHeadRemaining: 0, upcomingWeeks };
  // Count real remaining meetings from the published matchups rather than
  // assuming an even schedule: an 8-team league does not always give exactly two.
  let h2h = 0;
  for (let w = week; w < playoffStart; w++) {
    try {
      const ms = (await sleeper.matchups(config.leagueId, w)) as { roster_id: number; matchup_id: number | null }[];
      const mine = ms.find((m) => m.roster_id === config.rosterId)?.matchup_id;
      if (mine == null) continue;
      if (ms.some((m) => m.roster_id === theirRosterId && m.matchup_id === mine)) h2h++;
    } catch {
      // A week that is not published yet simply does not count.
    }
  }
  return { remainingWeeks, headToHeadRemaining: h2h, upcomingWeeks };
}

/** The fairness config for a live evaluation against one rival: defaults,
 *  the schedule, the roster cap from the snapshot, then any overrides. */
export async function liveFairness(snap: LeagueSnapshot, theirRosterId: number | null, overrides: Partial<FairnessConfig> = {}): Promise<FairnessConfig> {
  const sched = await scheduleContext(theirRosterId);
  return { ...DEFAULT_FAIRNESS, ...sched, rosterCapacity: snap.capacity, ...overrides };
}

export async function evaluateLiveOffer(
  tx: Tx,
  overrides: Partial<FairnessConfig> = {},
  base?: LeagueSnapshot,
): Promise<{ evaluation: TwoSidedEvaluation | MultiSidedEvaluation; theirRosterId: number | null; isMultiParty: boolean; snap: LeagueSnapshot }> {
  // Effective roster: reflects trades we have already agreed to but that are
  // still processing, so a second incoming offer is judged against the roster
  // we are about to hold, not the stale one. The caller passes the poll's
  // snapshot when it has one; the CLI does not.
  const snap = base ?? (await snapshotWithPending());
  const { offer, theirRosterId } = offerFromTransaction(tx, snap);
  const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const others = otherSides(tx, snap);

  // THE THREE-WAY CASE. A trade naming more than one other roster cannot be
  // judged by picking the first one and ignoring the rest: on 2026-09-04 a real
  // proposal gave up Christian McCaffrey and Jalen Hurts to one roster for
  // NOTHING, bundled with a fairer-looking Nico Collins and Chase Brown for
  // Quentin Johnston against a second roster. The old code only ever built
  // `theirRoster` from the FIRST other roster in tx.roster_ids and evaluated
  // that one leg alone, so the second roster's own gain was never computed at
  // all, not misjudged, simply invisible. It happened to still reject, because
  // the free-rider leg alone was severe enough, but a closer three-way trade
  // could have slipped through with half the picture missing.
  if (others.length > 1) {
    const opponents: OpponentSide[] = [];
    for (const o of others) {
      opponents.push({
        rosterId: o.rosterId,
        roster: snap.rosterOf.get(o.rosterId) ?? [],
        offer: o.offer,
        weight: opponentWeight(await liveFairness(snap, o.rosterId, overrides)),
      });
    }
    const cfg = await liveFairness(snap, theirRosterId, overrides);
    return {
      evaluation: evaluateTradeMultiSided(offer, ourRoster, opponents, cfg),
      theirRosterId, isMultiParty: true, snap,
    };
  }

  const theirRoster = theirRosterId === null ? [] : snap.rosterOf.get(theirRosterId) ?? [];
  const cfg = await liveFairness(snap, theirRosterId, overrides);
  return { evaluation: evaluateTradeTwoSided(offer, ourRoster, theirRoster, cfg), theirRosterId, isMultiParty: false, snap };
}

/** Locate an open trade by id. Proposed trades live only in the GraphQL
 *  transactions-by-status feed, never in REST's /transactions (the daemon
 *  learned that on 2026-09-02), and they stay filed under the leg they were
 *  created in across the Tuesday rollover. */
export async function findTransaction(gql: Gql, leg: number, txId: string): Promise<PendingTrade | null> {
  // pendingTrades already scans legsToScan(leg); this is one call, not two.
  return (await pendingTrades(gql, leg)).find((t) => t.transactionId === txId) ?? null;
}
