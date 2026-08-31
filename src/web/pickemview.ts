// Assembles the pick'em tab. Filip has no Sleeper app on his phone, so this is
// the only place he can see the pool: what we picked, what everyone else picked,
// which games carry a real edge, and who is winning.
//
// Everything here is read-only. Submission lives in src/pickem/run.ts.

import { config } from "../config.ts";
import { browserGql, fetchWeek, fetchMyLegs, fetchLeaguePicks, currentLegId, type PickemGame, type Gql } from "../pickem/client.ts";
import { decide, safePick, isPickable, inFinalWindow, bestTiebreaker, gradePick, scorePicks, FINAL_WINDOW_HOURS } from "../pickem/strategy.ts";

export interface PickemGameView {
  gameId: string;
  away: string;
  home: string;
  kickoff: number;
  status: string;
  /** The line we are graded against, from the away team's view. */
  gradedSpreadAway: number | null;
  marketSpreadAway: number | null;
  locked: boolean;
  pickable: boolean;
  inFinalWindow: boolean;
  ourPick: string | null;
  ourOutcome: string | null;
  /** What the coach would pick right now, and why. */
  wants: string | null;
  wantsRule: string | null;
  wantsWhy: string | null;
  edge: number;
  /** Rival picks by display name, so the page needs no second lookup. */
  rivals: { name: string; team: string; outcome: string | null }[];
}

export interface PickemStandingRow {
  rosterId: number;
  name: string;
  isUs: boolean;
  season: number;
  week: number;
  submitted: number;
}

export interface PickemView {
  generatedAt: number;
  week: number;
  legId: string;
  legStatus: string;
  leagueName: string;
  /** How the pool is scored, stated plainly because it drives every decision. */
  format: string;
  summary: {
    games: number;
    picksHeld: number;
    edgesHeld: number;
    pickable: number;
    finalWindowHours: number;
  };
  tiebreaker: {
    label: string | null;
    ours: number | null;
    recommended: number;
    rivals: { name: string; value: number }[];
  };
  standings: PickemStandingRow[];
  games: PickemGameView[];
  refreshSeconds: number;
}

interface Cached { at: number; week: number; view: PickemView }
let cache: Cached | null = null;
const TTL_MS = 60_000;

async function names(leagueId: string): Promise<Map<number, string>> {
  const [users, rosters] = await Promise.all([
    fetch(`https://api.sleeper.app/v1/league/${leagueId}/users`).then((r) => r.json()) as Promise<{ user_id: string; display_name: string }[]>,
    fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`).then((r) => r.json()) as Promise<{ roster_id: number; owner_id: string }[]>,
  ]);
  const byUser = new Map(users.map((u) => [u.user_id, u.display_name]));
  return new Map(rosters.map((r) => [r.roster_id, byUser.get(r.owner_id) ?? `roster ${r.roster_id}`]));
}

export async function pickemView(weekArg?: number): Promise<PickemView> {
  const leagueId = config.pickemLeagueId;
  const rosterId = config.pickemRosterId;
  const legId = weekArg ? `v1:regular:${weekArg}` : await currentLegId(leagueId);
  const week = Number(/:(\d+)$/.exec(legId)?.[1] ?? 0);
  if (!week) throw new Error(`cannot read a week out of leg ${legId}`);

  if (cache && cache.week === week && Date.now() - cache.at < TTL_MS) return cache.view;

  const gql: Gql = browserGql();
  const [games, myLegs, leaguePicks, nameOf] = await Promise.all([
    fetchWeek(gql, week),
    fetchMyLegs(gql, leagueId, rosterId),
    fetchLeaguePicks(gql, leagueId, legId),
    names(leagueId),
  ]);

  const mine = myLegs.find((l) => l.legId === legId) ?? { legId, status: "unknown", picks: {}, tiebreaker: null };
  const now = Date.now();
  const rivalIds = Object.keys(leaguePicks).map(Number).filter((r) => r !== rosterId).sort((a, b) => a - b);

  const gameViews: PickemGameView[] = games
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((g: PickemGame) => {
      const pickable = isPickable(g, now);
      const final = inFinalWindow(g, now);
      // Show the pick we would actually make right now: the real decision inside
      // the final window, the information-free provisional one before it. Showing
      // the edge pick early would be misleading, since that is not what we submit.
      const d = pickable ? (final ? decide(g) : safePick(g)) : decide(g);
      return {
        gameId: g.gameId,
        away: g.away,
        home: g.home,
        kickoff: g.startTime,
        status: g.status,
        gradedSpreadAway: g.gradedSpreadAway,
        marketSpreadAway: g.marketSpreadAway,
        locked: g.gradedLocked || !pickable,
        pickable,
        inFinalWindow: final,
        ourPick: mine.picks[g.gameId]?.team ?? null,
        // Graded from the scoreline. The stored outcome field is pick input, not
        // a result, so it says "win" on every pick ever made.
        ourOutcome: mine.picks[g.gameId] ? gradePick(g, mine.picks[g.gameId]!.team) : null,
        wants: d?.team ?? null,
        wantsRule: d?.rule ?? null,
        wantsWhy: d?.reason ?? null,
        edge: d?.edge ?? 0,
        rivals: rivalIds.map((r) => {
          const team = leaguePicks[r]?.picks?.[g.gameId]?.team ?? "";
          return { name: nameOf.get(r) ?? `roster ${r}`, team, outcome: team ? gradePick(g, team) : null };
        }).filter((x) => x.team),
      };
    });

  // Season totals need every leg up to now. Cheap enough behind the cache, and it
  // is the only way to show the standing that actually decides the pool.
  const season = new Map<number, number>();
  for (let w = 1; w <= week; w++) {
    const [legPicks, legGames] = w === week
      ? [leaguePicks, games]
      : await Promise.all([
          fetchLeaguePicks(gql, leagueId, `v1:regular:${w}`).catch(() => ({} as Awaited<ReturnType<typeof fetchLeaguePicks>>)),
          fetchWeek(gql, w).catch(() => [] as PickemGame[]),
        ]);
    for (const [rid, v] of Object.entries(legPicks)) {
      const { correct } = scorePicks(legGames, v.picks ?? {});
      season.set(Number(rid), (season.get(Number(rid)) ?? 0) + correct);
    }
  }
  const allIds = [...new Set([rosterId, ...Object.keys(leaguePicks).map(Number)])];
  const standings: PickemStandingRow[] = allIds
    .map((rid) => {
      const picks = rid === rosterId ? mine.picks : (leaguePicks[rid]?.picks ?? {});
      return {
        rosterId: rid,
        name: nameOf.get(rid) ?? `roster ${rid}`,
        isUs: rid === rosterId,
        season: season.get(rid) ?? 0,
        week: scorePicks(games, picks).correct,
        submitted: Object.keys(picks).length,
      };
    })
    .sort((a, b) => b.season - a.season || b.week - a.week || a.name.localeCompare(b.name));

  const rivalTbs = rivalIds
    .map((r) => ({ name: nameOf.get(r) ?? `roster ${r}`, tb: leaguePicks[r]?.tiebreaker }))
    .filter((x) => x.tb)
    .map((x) => ({ name: x.name, value: x.tb!.value }));
  const tbGameId = mine.tiebreaker?.gameId ?? rivalIds.map((r) => leaguePicks[r]?.tiebreaker?.gameId).find(Boolean) ?? null;
  const tbGame = tbGameId ? games.find((g) => g.gameId === tbGameId) : null;

  const view: PickemView = {
    generatedAt: Date.now(),
    week,
    legId,
    legStatus: mine.status,
    leagueName: "Da Pick Em",
    format: "1 point per correct pick against the spread. No confidence points, no bonuses.",
    summary: {
      games: gameViews.length,
      picksHeld: Object.keys(mine.picks).length,
      edgesHeld: gameViews.filter((g) => g.edge > 0 && g.ourPick === g.wants).length,
      pickable: gameViews.filter((g) => g.pickable).length,
      finalWindowHours: FINAL_WINDOW_HOURS,
    },
    tiebreaker: {
      label: tbGame ? `${tbGame.away} at ${tbGame.home}` : null,
      ours: mine.tiebreaker?.value ?? null,
      recommended: bestTiebreaker(rivalTbs.map((r) => r.value)),
      rivals: rivalTbs,
    },
    standings,
    games: gameViews,
    // Only worth polling while games are running.
    refreshSeconds: gameViews.some((g) => g.status !== "complete" && g.kickoff < Date.now()) ? 60 : 0,
  };

  cache = { at: Date.now(), week, view };
  return view;
}
