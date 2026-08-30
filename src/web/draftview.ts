import { config, vonaConfig } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor, type RankedPlayer } from "../analysis/vor.ts";
import { rankByVona } from "../analysis/vona.ts";
import { loadPlayers } from "../data/players.ts";
import { byeWeek, byeCounts } from "../data/byes.ts";
import { loadNews, newsFor, applyNews } from "../data/news.ts";
import { ownPickNo, nextOwnPickNo } from "../draft/logic.ts";
import { recentEvents, type ActivityEvent } from "../log.ts";

// Problem 2 from the 30 Aug 2026 draft: Filip had "no idea what its queue for
// picking was" and had to keep asking what the coach was about to do. This module
// surfaces, live and read-only, everything the engine decides with: the current
// plan, the backstop queue, our roster's bye load, and the recent agent overrides.
//
// Two hard rules shape it. First, we NEVER drive the shared browser and we do not
// change the engine: everything here comes from the Sleeper read-only API plus the
// same analysis modules the engine imports. Second, plan AGE is read from the
// engine's OWN logged plan, never a fresh recompute. A recompute would always read
// ~0s old and would hide the exact failure that cost a pick on 30 Aug, when a
// 116-second-stale plan fell through to the raw value board.
//
// Honesty about provenance, because some of it cannot be exact off the browser:
//  - Plan order + reasoning + AGE: the engine's own log. Authoritative.
//  - VOR, tier, news tags: recomputed from the shared modules. Exact and static.
//  - VONA + survival: recomputed here from Sleeper's draft picks, which lag a few
//    picks during a live draft, and without the small opponent-nudge the engine
//    applies. Close, not identical. Labelled as a live estimate in the UI.
//  - Backstop queue: the engine does not log the queue it pushes, and we will not
//    change the engine to make it. So we rebuild it with the engine's exact
//    algorithm from the same inputs, and the UI calls it a reconstruction.

const QUEUE_DEPTH = 8; // must match src/draft/run.ts buildQueue

// The backstop autopick queue, rebuilt with the identical algorithm the engine
// uses (src/draft/run.ts buildQueue): live-available only, RB/WR balanced to the
// current roster, then one TE and one QB if we have none, never K/DEF (Sleeper
// autopicks down the queue, so a queued defence would surface far too early).
function buildBackstopQueue(
  fullBoard: RankedPlayer[],
  counts: Record<string, number>,
  availSet: Set<string>,
): RankedPlayer[] {
  const live = availSet.size ? fullBoard.filter((b) => availSet.has(b.name)) : fullBoard;
  const rbs = live.filter((b) => b.position === "RB");
  const wrs = live.filter((b) => b.position === "WR");
  const out: RankedPlayer[] = [];
  let ri = 0, wi = 0;
  let rc = counts["RB"] ?? 0, wc = counts["WR"] ?? 0;
  while (out.length < QUEUE_DEPTH && (ri < rbs.length || wi < wrs.length)) {
    const takeRb = wi >= wrs.length ? true : ri >= rbs.length ? false : rc <= wc;
    if (takeRb && ri < rbs.length) { out.push(rbs[ri++]!); rc++; }
    else if (wi < wrs.length) { out.push(wrs[wi++]!); wc++; }
  }
  const te = (counts["TE"] ?? 0) >= 1 ? [] : live.filter((b) => b.position === "TE").slice(0, 1);
  const qb = (counts["QB"] ?? 0) >= 1 ? [] : live.filter((b) => b.position === "QB").slice(0, 1);
  return [...out, ...te, ...qb];
}

export async function draftView(): Promise<unknown> {
  const [league, players, draft] = await Promise.all([
    sleeper.league(config.leagueId),
    loadPlayers(),
    sleeper.draft(config.draftId),
  ]);
  const teams = draft.settings.teams;
  const rounds = draft.settings.rounds;

  // Build the board the SAME way the engine does: news-adjusted points, but the
  // replacement baseline taken from the raw projections (see rankByVor) so a few
  // devalued fringe players cannot inflate everyone else's VOR.
  const rawProjections = await loadSeasonProjections(config.season, league.scoring_settings);
  const { byKey: news } = await loadNews();
  const { adjusted } = applyNews(rawProjections, news);
  const fullBoard = rankByVor(adjusted, league, rawProjections);
  const byName = new Map(fullBoard.map((b) => [b.name, b]));
  const byId = new Map(fullBoard.map((b) => [b.playerId, b]));

  const picks = await sleeper.draftPicks(config.draftId).catch(() => []);
  const draftedIds = new Set(picks.map((p) => p.player_id));
  const ourPicks = picks
    .filter((p) => p.roster_id === config.rosterId || p.picked_by === config.userId)
    .sort((a, b) => a.pick_no - b.pick_no);
  const ourCount = ourPicks.length;
  const round = Math.min(rounds, ourCount + 1);
  const slot = draft.draft_order?.[config.userId] ?? null;
  const draftLive = draft.status === "drafting";

  const available = fullBoard.filter((b) => !draftedIds.has(b.playerId));

  // Live VONA/survival estimate. Pure board-state (no opponent nudge) and off the
  // Sleeper picks feed, so it is close to but not identical to the engine's number.
  let vonaBy: Map<string, { vona: number; pSurvive: number }> | null = null;
  let nextPickNo: number | null = null;
  if (vonaConfig.enabled && slot != null && ourCount < rounds) {
    const cur = ownPickNo(round, slot, teams);
    nextPickNo = nextOwnPickNo(cur, slot, teams, rounds);
    if (nextPickNo != null) {
      const scored = rankByVona(available, { nextPickNo, adpSpread: vonaConfig.adpSpread });
      vonaBy = new Map(scored.map((p) => [p.playerId, { vona: p.vona, pSurvive: p.pSurvive }]));
    }
  }

  // Our roster, in pick order, with each player's bye week.
  const roster = ourPicks.map((p) => {
    const b = byId.get(p.player_id);
    const meta = players[p.player_id];
    const name = b?.name
      ?? meta?.full_name
      ?? (`${meta?.first_name ?? ""} ${meta?.last_name ?? ""}`.trim() || p.player_id);
    const pos = b?.position ?? meta?.position ?? p.metadata?.position ?? "?";
    const team = b?.team ?? meta?.team ?? "?";
    return { name, pos, team, round: p.round, bye: byeWeek(team) };
  });

  // Per-week bye load across the roster, flagged at 3+ (the same threshold the
  // engine's bye veto uses). Four starters on one week was the worst hole in the
  // league on 30 Aug and nothing surfaced it at the time.
  const byeMap = byeCounts(roster.map((r) => r.team));
  const byes = [...byeMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, count]) => ({ week, count, heavy: count >= vonaConfig.byeStackMax }));

  const events = recentEvents(600);

  // The engine's CURRENT plan, straight from its log. The plan event carries only
  // names + reasoning; we enrich each name from the board here. "gone" flags a
  // planned target a rival has since taken, which is exactly when the engine falls
  // to the next name on the list.
  const planEv = [...events].reverse().find(
    (e): e is ActivityEvent => e.actor === "coach" && (e.type === "plan" || e.type === "plan-error"),
  );
  const planDetail = (planEv?.detail ?? {}) as { plan?: string[]; reasoning?: string; error?: string };
  const planNames = Array.isArray(planDetail.plan) ? planDetail.plan : [];
  const planRows = planNames.map((name) => {
    const b = byName.get(name);
    const v = b && vonaBy ? vonaBy.get(b.playerId) : undefined;
    const entry = newsFor(news, name);
    return {
      name,
      pos: b ? `${b.position}${b.posRank}` : "?",
      team: b?.team ?? "?",
      vor: b?.vor ?? null,
      tier: b?.tier ?? null,
      vona: v?.vona ?? null,
      pSurvive: v?.pSurvive ?? null,
      bye: b ? byeWeek(b.team) : null,
      news: entry ? { status: entry.status, note: entry.note } : null,
      gone: b ? draftedIds.has(b.playerId) : false,
    };
  });

  // Backstop queue, reconstructed with the engine's algorithm from our current
  // counts and the live-available set.
  const counts: Record<string, number> = {};
  for (const r of roster) if (r.pos) counts[r.pos] = (counts[r.pos] ?? 0) + 1;
  const availSet = new Set(available.map((b) => b.name));
  const queue = buildBackstopQueue(fullBoard, counts, availSet).map((b) => ({
    name: b.name,
    pos: `${b.position}${b.posRank}`,
    team: b.team,
    bye: byeWeek(b.team),
  }));

  // Recent agent overrides, with the value board's alternative. The raw VOR gap is
  // MISLEADING when the board wanted a K or DEF: those are one-starter capped, so a
  // kicker being 45 VOR "better" than a receiver is worth almost nothing to take
  // early. We flag capped so the UI never prints that gap as a clean cost.
  const overrides = events
    .filter((e) => e.type === "agent-override")
    .slice(-6)
    .reverse()
    .map((e) => {
      const d = (e.detail ?? {}) as {
        picked?: string; vonaTop?: string; vonaRank?: number; vonaGap?: number; vorGap?: number; reasoning?: string;
      };
      const topBoard = d.vonaTop ? byName.get(d.vonaTop) : undefined;
      const capped = topBoard ? topBoard.position === "K" || topBoard.position === "DEF" : false;
      return {
        ts: e.ts,
        picked: d.picked ?? null,
        board: d.vonaTop ?? null,
        boardPos: topBoard?.position ?? null,
        vonaRank: d.vonaRank ?? null,
        vonaGap: d.vonaGap ?? null,
        vorGap: d.vorGap ?? null,
        capped,
        reasoning: d.reasoning ?? null,
      };
    });

  return {
    draftLive,
    draftStatus: draft.status,
    context: { slot, round, teams, rounds, ourCount, nextPickNo, vonaEnabled: vonaConfig.enabled },
    plan: {
      ts: planEv?.ts ?? null,
      isError: planEv?.type === "plan-error",
      error: planDetail.error ?? null,
      reasoning: planDetail.reasoning ?? null,
      rows: planRows,
    },
    queue,
    roster,
    byes,
    overrides,
  };
}
