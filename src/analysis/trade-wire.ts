// Assemble the real rosters the two-sided trade evaluator needs, from the live
// API plus our own projections and news dossier.
//
// This is the missing link found in the pre-launch audit: src/analysis/trade-fair.ts
// implemented the whole decision (schedule-diluted value, a floor on our own gain,
// trade-specific rails, injury refusal) and NOTHING CALLED IT. The daemon was
// still doing shadow alerts with no verdict attached, so the decision engine was
// unreachable from the running system.

import { config } from "../config.ts";
import { browserGql, pendingRosterDelta, applyRosterDelta, type Gql } from "../league/api.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadSeasonProjections } from "./projections.ts";
import { rankByVor } from "./vor.ts";
import { loadNews, applyNews } from "../data/news.ts";
import { loadPlayers } from "../data/players.ts";
import { byeWeek } from "../data/byes.ts";
import type { TradePlayer, TradeOffer } from "./trade.ts";
import {
  evaluateTradeTwoSided, evaluateTradeMultiSided, opponentWeight,
  type FairnessConfig, DEFAULT_FAIRNESS, type TwoSidedEvaluation, type MultiSidedEvaluation, type OpponentSide,
} from "./trade-fair.ts";

export interface LeagueSnapshot {
  playerById: Map<string, TradePlayer>;
  rosterOf: Map<number, TradePlayer[]>; // roster_id -> players
  ourRosterId: number;
  // Sending an offer needs the player ID back from the name the value model
  // works in. Built from ROSTERED players only, which removes almost all of the
  // duplicate-name ambiguity in the full 12k dump.
  idByName: Map<string, string>;
  ownerIdOf: Map<number, string>; // roster_id -> Sleeper user_id
}

// One fetch, reused for every offer in a poll cycle.
export async function snapshot(): Promise<LeagueSnapshot> {
  const league = await sleeper.league(config.leagueId);
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
      position: p.position ?? b?.position ?? "",
      points: b?.points ?? 0,
      injuryStatus: p.injury_status ?? undefined,
      bye: byeWeek(p.team ?? b?.team ?? "") ?? undefined,
      depthChartOrder: typeof p.depth_chart_order === "number" ? p.depth_chart_order : undefined,
    });
  }

  const rosters = await sleeper.rosters(config.leagueId);
  const rosterOf = new Map<number, TradePlayer[]>();
  const idByName = new Map<string, string>();
  const ownerIdOf = new Map<number, string>();
  for (const r of rosters) {
    rosterOf.set(
      r.roster_id,
      (r.players ?? []).map((id) => playerById.get(id) ?? { name: id, position: "", points: 0 }),
    );
    for (const id of r.players ?? []) {
      const name = playerById.get(id)?.name;
      if (name) idByName.set(name, id);
    }
    if (r.owner_id) ownerIdOf.set(r.roster_id, String(r.owner_id));
  }
  return { playerById, rosterOf, ourRosterId: config.rosterId, idByName, ownerIdOf };
}

// Turn a Sleeper trade transaction into an offer from OUR perspective, and score
// it. `adds`/`drops` map player_id -> roster_id receiving/losing him.
type Tx = { adds?: Record<string, number> | null; drops?: Record<string, number> | null; roster_ids?: number[] };

/** Any single roster's own side of a transaction: what THEY give and receive,
 *  regardless of who else is party to it or how many are. Lineup math is
 *  roster-local, so this one function serves our side, one opponent, or every
 *  opponent in a three-way trade. */
function sideOf(tx: Tx, snap: LeagueSnapshot, rosterId: number): TradeOffer {
  const get = (id: string): TradePlayer => snap.playerById.get(id) ?? { name: id, position: "", points: 0 };
  const receive: TradePlayer[] = [];
  const give: TradePlayer[] = [];
  for (const [id, rid] of Object.entries(tx.adds ?? {})) if (rid === rosterId) receive.push(get(id));
  for (const [id, rid] of Object.entries(tx.drops ?? {})) if (rid === rosterId) give.push(get(id));
  return { receive, give };
}

/** snapshot() reflects the CURRENT roster. This applies trades we have agreed
 *  to but that have not processed yet, so every "what do we have" decision
 *  (proposing, evaluating an incoming offer, the trade brief) reasons about the
 *  roster we are about to hold, not a stale one. Only OUR roster is adjusted;
 *  the counterparties' current rosters are what we evaluate against. */
export async function snapshotWithPending(gql: Gql = browserGql(), leg?: number): Promise<LeagueSnapshot> {
  const snap = await snapshot();
  const week = leg ?? Math.max(1, (await sleeper.nflState()).week ?? 1);
  const delta = await pendingRosterDelta(gql, week).catch(() => ({ incoming: [], outgoing: [] }));
  if (!delta.incoming.length && !delta.outgoing.length) return snap;
  const currentIds = (await sleeper.rosters(config.leagueId)).find((r) => r.roster_id === snap.ourRosterId)?.players ?? [];
  const effectiveIds = applyRosterDelta(currentIds, delta);
  const rosterOf = new Map(snap.rosterOf);
  rosterOf.set(snap.ourRosterId, effectiveIds.map((id) => snap.playerById.get(id) ?? { name: id, position: "", points: 0 }));
  return { ...snap, rosterOf };
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

export async function evaluateLiveOffer(
  tx: Tx,
  overrides: Partial<FairnessConfig> = {},
): Promise<{ evaluation: TwoSidedEvaluation | MultiSidedEvaluation; theirRosterId: number | null; isMultiParty: boolean }> {
  // Effective roster: reflects trades we have already agreed to but that are
  // still processing, so a second incoming offer is judged against the roster
  // we are about to hold, not the stale one.
  const snap = await snapshotWithPending();
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
      const sched = await scheduleContext(o.rosterId);
      opponents.push({
        rosterId: o.rosterId,
        roster: snap.rosterOf.get(o.rosterId) ?? [],
        offer: o.offer,
        weight: opponentWeight({ ...DEFAULT_FAIRNESS, ...sched, ...overrides }),
      });
    }
    const sched = await scheduleContext(theirRosterId);
    const cfg: FairnessConfig = { ...DEFAULT_FAIRNESS, ...sched, ...overrides };
    return {
      evaluation: evaluateTradeMultiSided(offer, ourRoster, opponents, cfg),
      theirRosterId, isMultiParty: true,
    };
  }

  const theirRoster = theirRosterId === null ? [] : snap.rosterOf.get(theirRosterId) ?? [];
  const sched = await scheduleContext(theirRosterId);
  const cfg: FairnessConfig = { ...DEFAULT_FAIRNESS, ...sched, ...overrides };
  return { evaluation: evaluateTradeTwoSided(offer, ourRoster, theirRoster, cfg), theirRosterId, isMultiParty: false };
}
