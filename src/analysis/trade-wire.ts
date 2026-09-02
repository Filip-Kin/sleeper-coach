// Assemble the real rosters the two-sided trade evaluator needs, from the live
// API plus our own projections and news dossier.
//
// This is the missing link found in the pre-launch audit: src/analysis/trade-fair.ts
// implemented the whole decision (schedule-diluted value, a floor on our own gain,
// trade-specific rails, injury refusal) and NOTHING CALLED IT. The daemon was
// still doing shadow alerts with no verdict attached, so the decision engine was
// unreachable from the running system.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadSeasonProjections } from "./projections.ts";
import { rankByVor } from "./vor.ts";
import { loadNews, applyNews } from "../data/news.ts";
import { loadPlayers } from "../data/players.ts";
import { byeWeek } from "../data/byes.ts";
import type { TradePlayer, TradeOffer } from "./trade.ts";
import { evaluateTradeTwoSided, type FairnessConfig, DEFAULT_FAIRNESS, type TwoSidedEvaluation } from "./trade-fair.ts";

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
export function offerFromTransaction(
  tx: { adds?: Record<string, number> | null; drops?: Record<string, number> | null; roster_ids?: number[] },
  snap: LeagueSnapshot,
): { offer: TradeOffer; theirRosterId: number | null } {
  const get = (id: string): TradePlayer => snap.playerById.get(id) ?? { name: id, position: "", points: 0 };
  const receive: TradePlayer[] = [];
  const give: TradePlayer[] = [];
  for (const [id, rid] of Object.entries(tx.adds ?? {})) {
    if (rid === snap.ourRosterId) receive.push(get(id));
  }
  for (const [id, rid] of Object.entries(tx.drops ?? {})) {
    if (rid === snap.ourRosterId) give.push(get(id));
  }
  const theirRosterId = (tx.roster_ids ?? []).find((r) => r !== snap.ourRosterId) ?? null;
  return { offer: { receive, give }, theirRosterId };
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
  tx: { adds?: Record<string, number> | null; drops?: Record<string, number> | null; roster_ids?: number[] },
  overrides: Partial<FairnessConfig> = {},
): Promise<{ evaluation: TwoSidedEvaluation; theirRosterId: number | null }> {
  const snap = await snapshot();
  const { offer, theirRosterId } = offerFromTransaction(tx, snap);
  const ourRoster = snap.rosterOf.get(snap.ourRosterId) ?? [];
  const theirRoster = theirRosterId === null ? [] : snap.rosterOf.get(theirRosterId) ?? [];
  const sched = await scheduleContext(theirRosterId);
  const cfg: FairnessConfig = { ...DEFAULT_FAIRNESS, ...sched, ...overrides };
  return { evaluation: evaluateTradeTwoSided(offer, ourRoster, theirRoster, cfg), theirRosterId };
}
