// Bridge from the live Sleeper read-only API to the pure trade engine
// (trade.ts). This is where real transactions, our real roster and the
// projection table are turned into the TradePlayer shape the engine judges.
// Read-only: it fetches and evaluates, it never writes. The verdict it returns
// is the deterministic one the daemon's agent should defer to, and the
// human-readable summary is what gets surfaced when a call is left pending.
//
// One honest caveat, called out so nobody is misled by the number: `points`
// here is the FULL-SEASON projection, used as a stand-in for rest-of-season.
// Pre-season (where we are now) the two are the same. In-season this overstates
// the remaining value, though because it is applied identically to both sides of
// the trade the lineup DELTA stays a fair comparison. When weekly projections
// are wired for lineups, rest-of-season should become the sum of the remaining
// weeks; until then this is the best available and is flagged in the summary.

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadPlayers } from "../data/players.ts";
import { loadSeasonProjections } from "./projections.ts";
import { evaluateTrade, type TradeOffer, type TradePlayer, type TradeEvaluation, type TradeConfig } from "./trade.ts";

// The subset of a Sleeper trade transaction the evaluation needs. `adds` maps a
// player id to the roster id that RECEIVES him; `drops` maps a player id to the
// roster id that GIVES him up. So from our seat, we receive the adds whose value
// is our roster id, and we give up the drops whose value is our roster id.
export interface TxLike {
  transaction_id: string;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  roster_ids?: number[];
}

export interface LiveTradeResult {
  evaluation: TradeEvaluation;
  receive: TradePlayer[];
  give: TradePlayer[];
  summary: string;
}

async function projectionIndex(): Promise<Map<string, { name: string; position: string; points: number; injuryStatus: string | null }>> {
  const league = await sleeper.league(config.leagueId);
  const projections = await loadSeasonProjections(config.season, league.scoring_settings);
  const idx = new Map<string, { name: string; position: string; points: number; injuryStatus: string | null }>();
  for (const p of projections) idx.set(p.playerId, { name: p.name, position: p.position, points: p.points, injuryStatus: p.injuryStatus });
  return idx;
}

// Turn a set of player ids into TradePlayers, using projections for value and
// the player dump as a fallback for name/position when a player has no
// projection row (worth 0 to the lineup, which is the safe assumption).
async function toTradePlayers(
  ids: string[],
  proj: Map<string, { name: string; position: string; points: number; injuryStatus: string | null }>,
): Promise<TradePlayer[]> {
  const players = await loadPlayers();
  return ids.map((id) => {
    const pr = proj.get(id);
    if (pr) return { name: pr.name, position: pr.position, points: pr.points, injuryStatus: pr.injuryStatus ?? undefined };
    const dump = (players as Record<string, { full_name?: string; first_name?: string; last_name?: string; position?: string; injury_status?: string | null }>)[id];
    const name = (dump?.full_name ?? `${dump?.first_name ?? ""} ${dump?.last_name ?? ""}`.trim()) || id;
    return { name, position: dump?.position ?? "", points: 0, injuryStatus: dump?.injury_status ?? undefined };
  });
}

// Evaluate an already-fetched trade transaction from our roster's perspective.
export async function evaluateTransactionForUs(tx: TxLike, cfg?: TradeConfig, rosterId: number = config.rosterId): Promise<LiveTradeResult> {
  const receiveIds = Object.entries(tx.adds ?? {}).filter(([, rid]) => rid === rosterId).map(([pid]) => pid);
  const giveIds = Object.entries(tx.drops ?? {}).filter(([, rid]) => rid === rosterId).map(([pid]) => pid);

  const proj = await projectionIndex();
  const rosters = await sleeper.rosters(config.leagueId);
  const ours = rosters.find((r) => r.roster_id === rosterId);
  if (!ours) throw new Error(`evaluateTransactionForUs: roster ${rosterId} not found in league ${config.leagueId}`);

  const roster = await toTradePlayers(ours.players ?? [], proj);
  const receive = await toTradePlayers(receiveIds, proj);
  const give = await toTradePlayers(giveIds, proj);

  const offer: TradeOffer = { receive, give };
  const evaluation = evaluateTrade(offer, roster, cfg);

  const fmt = (ps: TradePlayer[]) => (ps.length ? ps.map((p) => `${p.name} (${p.position} ${p.points})`).join(", ") : "nothing");
  const summary =
    `Trade ${tx.transaction_id}: we receive ${fmt(receive)}; we give up ${fmt(give)}. ` +
    `Verdict ${evaluation.verdict.toUpperCase()} (starting-lineup ${evaluation.before} -> ${evaluation.after}, ` +
    `${evaluation.lineupDelta >= 0 ? "+" : ""}${evaluation.lineupDelta}). ` +
    `Value is measured on rest-of-season starting-lineup impact (currently a full-season proxy). ` +
    evaluation.reasons.join(". ");

  return { evaluation, receive, give, summary };
}

// Locate a pending trade transaction by id without knowing its week. Scans the
// current scoring period first, then a small window back, since a pending offer
// lives in the current week's transactions list.
export async function findTransaction(txId: string): Promise<TxLike | null> {
  const state = await sleeper.nflState().catch(() => ({ week: 1 }) as { week: number });
  const current = Math.max(1, state.week || 1);
  const weeks = Array.from(new Set([current, current - 1, 1])).filter((w) => w >= 1);
  for (const w of weeks) {
    const txns = (await sleeper.transactions(config.leagueId, w).catch(() => [])) as TxLike[];
    const hit = txns.find((t) => t.transaction_id === txId);
    if (hit) return hit;
  }
  return null;
}
