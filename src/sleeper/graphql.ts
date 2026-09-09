// Sleeper's GraphQL endpoint, called directly with no token.
//
// Public league data (rosters, league settings, matchups, users, the sport
// state) answers a bare POST here, and unlike the documented REST API there is
// no CDN in front of it. Measured on 2026-09-09: REST /rosters came back from
// Cloudflare with age: 226 on s-maxage=300, so a lineup change can take five
// minutes to show up over REST (ten with stale-while-revalidate). GraphQL is
// cache-control: private, max-age=0, so it is live. The whole surface is
// documented in the sleeper-graphql repo (Projects/sleeper-graphql).
//
// Only public reads live here. Writes and anything user-scoped (DMs, trade
// responses, starters) go through tokenGql in league/api.ts, which is the same
// POST with the session token added as an authorization header.

import type { League, LeagueUser, NflState, Roster, RosterPlayerMini } from "./types.ts";

export const SLEEPER_GRAPHQL = "https://sleeper.app/graphql";

// SLEEPER_GRAPHQL_PUBLIC=0 makes every read go straight to REST again, without
// a deploy, if the endpoint ever changes shape under us.
export const GRAPHQL_FIRST = (process.env.SLEEPER_GRAPHQL_PUBLIC ?? "1") !== "0";

type GqlBody = { data?: Record<string, unknown>; errors?: { code?: string; message?: string }[] };

export async function publicGql(query: string, attempt = 0): Promise<Record<string, unknown>> {
  const res = await fetch(SLEEPER_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await Bun.sleep(500 * 2 ** attempt);
    return publicGql(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`sleeper graphql HTTP ${res.status}`);
  const body = (await res.json()) as GqlBody;
  const err = body.errors?.[0];
  if (err) throw new Error(`sleeper graphql: ${err.code ?? ""} ${err.message ?? ""}`.trim());
  return body.data ?? {};
}

function safeId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}

/** Try GraphQL, fall back to REST on any failure. The fallback is logged so a
 *  silently degraded read (stale REST data every poll) cannot hide for weeks. */
export async function withRestFallback<T>(
  what: string, viaGraphql: () => Promise<T>, viaRest: () => Promise<T>, enabled = GRAPHQL_FIRST,
): Promise<T> {
  if (!enabled) return viaRest();
  try {
    return await viaGraphql();
  } catch (err) {
    console.warn(`[sleeper] ${what}: graphql failed (${err instanceof Error ? err.message : String(err)}); using REST`);
    return viaRest();
  }
}

// #region mappers (pure, tested)
type Row = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

export function toRosterPlayerMini(row: Row): RosterPlayerMini {
  return {
    player_id: String(row.player_id ?? ""),
    first_name: String(row.first_name ?? ""),
    last_name: String(row.last_name ?? ""),
    position: strOrNull(row.position),
    fantasy_positions: strList(row.fantasy_positions),
    team: strOrNull(row.team),
    status: strOrNull(row.status),
    injury_status: strOrNull(row.injury_status),
    news_updated: typeof row.news_updated === "number" ? row.news_updated : null,
  };
}

export function toRoster(row: Row): Roster {
  const pm = row.player_map && typeof row.player_map === "object" ? (row.player_map as Record<string, Row>) : null;
  const player_map: Record<string, RosterPlayerMini> | undefined = pm
    ? Object.fromEntries(Object.entries(pm).filter(([, v]) => v && typeof v === "object").map(([k, v]) => [k, toRosterPlayerMini(v)]))
    : undefined;
  return {
    roster_id: num(row.roster_id),
    owner_id: strOrNull(row.owner_id),
    players: strList(row.players),
    starters: strList(row.starters),
    reserve: strList(row.reserve),
    keepers: strList(row.keepers),
    settings: ((row.settings as Roster["settings"] | null) ?? {}) as Roster["settings"],
    ...(player_map ? { player_map } : {}),
  };
}

export function toNflState(info: Row): NflState {
  return {
    season: String(info.season ?? ""),
    season_type: String(info.season_type ?? ""),
    week: num(info.week, 1),
    display_week: num(info.display_week, num(info.week, 1)),
  };
}

export function toLeague(row: Row): League {
  return {
    league_id: String(row.league_id ?? ""),
    name: String(row.name ?? ""),
    season: String(row.season ?? ""),
    status: String(row.status ?? ""),
    total_rosters: num(row.total_rosters),
    draft_id: String(row.draft_id ?? ""),
    previous_league_id: strOrNull(row.previous_league_id),
    scoring_settings: (row.scoring_settings as League["scoring_settings"] | null) ?? {},
    roster_positions: strList(row.roster_positions) ?? [],
    settings: ((row.settings as League["settings"] | null) ?? {}) as League["settings"],
  };
}

/** The REST /matchups row shape, from a matchup_legs_raw row. */
export interface MatchupRow {
  roster_id: number;
  matchup_id: number | null;
  starters: string[];
  players: string[];
  points: number | null;
}
export function toMatchup(row: Row): MatchupRow {
  return {
    roster_id: num(row.roster_id),
    matchup_id: typeof row.matchup_id === "number" ? row.matchup_id : null,
    starters: strList(row.starters) ?? [],
    players: strList(row.players) ?? [],
    points: typeof row.points === "number" ? row.points : null,
  };
}
// #endregion

// #region reads
function rows(data: Record<string, unknown>, field: string): Row[] {
  const v = data[field];
  if (!Array.isArray(v)) throw new Error(`sleeper graphql: ${field} missing from response`);
  return v as Row[];
}

/** All rosters, with player_map: a mini player record per rostered player
 *  carrying the live injury_status. This is the read the lineup guard runs
 *  every poll, so it has to be cheap (measured 132 ms, 42 KB) and fresh. */
export async function leagueRosters(leagueId: string): Promise<Roster[]> {
  const data = await publicGql(
    `{league_rosters(league_id:"${safeId(leagueId)}"){roster_id owner_id players starters reserve keepers settings player_map}}`,
  );
  return rows(data, "league_rosters").map(toRoster);
}

export async function getLeague(leagueId: string): Promise<League> {
  const data = await publicGql(
    `{get_league(league_id:"${safeId(leagueId)}"){league_id name season status total_rosters draft_id previous_league_id scoring_settings roster_positions settings}}`,
  );
  const row = data.get_league;
  if (!row || typeof row !== "object") throw new Error("sleeper graphql: get_league returned nothing");
  return toLeague(row as Row);
}

export async function sportInfo(sport = "nfl"): Promise<NflState> {
  const data = await publicGql(`{sport_info(sport:${JSON.stringify(sport)})}`);
  const info = data.sport_info;
  if (!info || typeof info !== "object") throw new Error("sleeper graphql: sport_info returned nothing");
  return toNflState(info as Row);
}

/** matchup_legs_raw: the same rows as REST /matchups without the 40 KB
 *  player_map. Sleeper's own description calls it the fast path. */
export async function matchupLegsRaw(leagueId: string, round: number): Promise<MatchupRow[]> {
  const data = await publicGql(
    `{matchup_legs_raw(league_id:"${safeId(leagueId)}",round:${Math.trunc(round)}){roster_id matchup_id starters players points}}`,
  );
  return rows(data, "matchup_legs_raw").map(toMatchup);
}

export async function leagueUsers(leagueId: string): Promise<LeagueUser[]> {
  const data = await publicGql(
    `{league_users(league_id:"${safeId(leagueId)}"){user_id display_name avatar metadata is_owner league_id}}`,
  );
  return rows(data, "league_users").map((r) => ({ ...r, user_id: String(r.user_id ?? ""), display_name: String(r.display_name ?? "") }) as unknown as LeagueUser);
}
// #endregion
