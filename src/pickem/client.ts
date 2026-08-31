// Sleeper's pick'em game. It has NO public REST surface: legs, everyone's picks,
// and pick submission are GraphQL-only, discovered by introspecting
// https://sleeper.app/graphql with our own session token. The relevant fields:
//
//   query    get_pickem_legs(league_id, roster_id)          our week + our picks
//   query    get_pickem_leg(league_id, roster_id, leg_id)
//   query    get_pickem_picks_for_league(league_id, leg_id)  EVERY member's picks
//   query    scores(sport, season, season_type, week)        games, lines, results
//   mutation make_pickem_pick(league_id, roster_id, leg_id, pick)
//   mutation remove_pickem_pick(...)
//   mutation set_pickem_tiebreaker(league_id, roster_id, leg_id, tiebreaker)
//
// The trap that cost the first attempt: `pick` requires outcome:"win" as well as
// game_id and team. Without it the server answers `invalid_pick_for_game`, which
// reads like the team or game is wrong when in fact the shape is wrong.

import { config } from "../config.ts";

export type Gql = (query: string) => Promise<Record<string, unknown>>;

/** Calls GraphQL from inside the persistent browser, so the session token never
 *  leaves the profile and the request carries the site's own origin. A plain
 *  server-side fetch is not worth the risk here: Sleeper sits behind Cloudflare
 *  and the page-context path is already proven by every other write we make. */
export function browserGql(api = process.env.BROWSER_API ?? "http://127.0.0.1:9223"): Gql {
  return async (query: string) => {
    const res = await fetch(`${api}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.error) throw new Error(`graphql transport: ${String(j.error ?? res.statusText)}`);
    return (j.result ?? {}) as Record<string, unknown>;
  };
}

function unwrap(body: Record<string, unknown>, field: string): unknown {
  const errs = body.errors as { code?: string; message?: string }[] | undefined;
  const err = errs?.[0];
  if (err) throw new Error(`graphql ${field}: ${err.code ?? ""} ${err.message ?? ""}`.trim());
  const data = body.data as Record<string, unknown> | undefined;
  return data?.[field];
}

// Interpolating into a GraphQL string is only safe because these are validated
// to character classes first. Never relax these without switching to variables.
function safeId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}
function safeTeam(v: string): string {
  if (!/^[A-Z]{2,4}$/.test(v)) throw new Error(`unsafe team: ${v}`);
  return v;
}
function safeLeg(v: string): string {
  if (!/^[a-z0-9:]{1,32}$/.test(v)) throw new Error(`unsafe leg_id: ${v}`);
  return v;
}

export interface PickemGame {
  gameId: string;
  away: string;
  home: string;
  startTime: number;              // ms epoch
  status: string;                 // pre_game | complete | ...
  /** The line we are actually GRADED against. Always ends in .5 (no pushes). */
  gradedSpreadAway: number | null;
  gradedLocked: boolean;
  gradedUpdatedAt: number | null;
  /** Sleeper's betting-market line for the same game. Moves after the graded
   *  line is frozen, which is the entire source of our edge. */
  marketSpreadAway: number | null;
  marketUpdatedAt: number | null;
  awayScore: number | null;
  homeScore: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function fetchWeek(gql: Gql, week: number, season: string = config.season): Promise<PickemGame[]> {
  if (!Number.isInteger(week) || week < 1 || week > 22) throw new Error(`bad week: ${week}`);
  if (!/^[0-9]{4}$/.test(season)) throw new Error(`bad season: ${season}`);
  const body = await gql(
    `{scores(sport:"nfl",season:"${season}",season_type:"regular",week:${week})` +
    `{game_id status start_time metadata}}`,
  );
  const raw = (unwrap(body, "scores") ?? []) as Record<string, unknown>[];
  return raw.map((s) => {
    const m = (s.metadata ?? {}) as Record<string, unknown>;
    const graded = (m.pickem_spread ?? {}) as Record<string, unknown>;
    const market = (m.spread ?? {}) as Record<string, unknown>;
    const away = String(m.away_team ?? "");
    const home = String(m.home_team ?? "");
    return {
      gameId: String(s.game_id ?? ""),
      away,
      home,
      startTime: num(s.start_time) ?? 0,
      status: String(s.status ?? ""),
      gradedSpreadAway: num(graded[away]),
      gradedLocked: graded.is_locked === true,
      gradedUpdatedAt: num(graded.updated_at),
      marketSpreadAway: num(market[away]),
      marketUpdatedAt: num(market.updated_at),
      awayScore: num(m.away_score),
      homeScore: num(m.home_score),
    };
  }).filter((g) => g.gameId && g.away && g.home);
}

export interface LegPick { gameId: string; team: string; outcome: string | null }
export interface Tiebreaker { type: string; value: number; gameId: string }
export interface LegState {
  legId: string;
  status: string;                  // pre_leg | in_leg | complete
  picks: Record<string, LegPick>;  // by game_id
  tiebreaker: Tiebreaker | null;
}

function parseLeg(raw: Record<string, unknown>): LegState {
  const picks: Record<string, LegPick> = {};
  for (const [gid, p] of Object.entries((raw.picks ?? {}) as Record<string, Record<string, unknown>>)) {
    picks[gid] = { gameId: gid, team: String(p.team ?? ""), outcome: p.outcome ? String(p.outcome) : null };
  }
  const tb = (raw.tiebreaker ?? {}) as Record<string, unknown>;
  return {
    legId: String(raw.leg_id ?? ""),
    status: String(raw.status ?? ""),
    picks,
    tiebreaker: tb.type
      ? { type: String(tb.type), value: Number(tb.value ?? 0), gameId: String(tb.game_id ?? "") }
      : null,
  };
}

export async function fetchMyLegs(gql: Gql, leagueId: string, rosterId: number): Promise<LegState[]> {
  const body = await gql(
    `{get_pickem_legs(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)})` +
    `{leg_id status picks tiebreaker}}`,
  );
  return ((unwrap(body, "get_pickem_legs") ?? []) as Record<string, unknown>[]).map(parseLeg);
}

/** Every member's picks, keyed by roster_id. Sleeper serves this to any league
 *  member while the leg is still open, so rivals' submitted picks are readable
 *  before kickoff. That is what makes picking LAST worth anything. */
export async function fetchLeaguePicks(
  gql: Gql, leagueId: string, legId: string,
): Promise<Record<number, { picks: Record<string, LegPick>; tiebreaker: Tiebreaker | null }>> {
  const body = await gql(
    `{get_pickem_picks_for_league(league_id:"${safeId(leagueId)}",leg_id:"${safeLeg(legId)}",include_tiebreaker:true)}`,
  );
  const raw = (unwrap(body, "get_pickem_picks_for_league") ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<number, { picks: Record<string, LegPick>; tiebreaker: Tiebreaker | null }> = {};
  for (const [rid, v] of Object.entries(raw)) {
    const leg = parseLeg(v);
    out[Number(rid)] = { picks: leg.picks, tiebreaker: leg.tiebreaker };
  }
  return out;
}

/** outcome:"win" is REQUIRED — see the header note. Replacing an existing pick
 *  is the same call; the server overwrites the entry for that game_id. */
export async function submitPick(
  gql: Gql, leagueId: string, rosterId: number, legId: string, gameId: string, team: string,
): Promise<LegState> {
  const body = await gql(
    `mutation{make_pickem_pick(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},` +
    `leg_id:"${safeLeg(legId)}",pick:{game_id:"${safeId(gameId)}",team:"${safeTeam(team)}",outcome:"win"})` +
    `{leg_id status picks tiebreaker}}`,
  );
  return parseLeg((unwrap(body, "make_pickem_pick") ?? {}) as Record<string, unknown>);
}

export async function removePick(
  gql: Gql, leagueId: string, rosterId: number, legId: string, gameId: string, team: string,
): Promise<LegState> {
  const body = await gql(
    `mutation{remove_pickem_pick(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},` +
    `leg_id:"${safeLeg(legId)}",pick:{game_id:"${safeId(gameId)}",team:"${safeTeam(team)}",outcome:"win"})` +
    `{leg_id status picks tiebreaker}}`,
  );
  return parseLeg((unwrap(body, "remove_pickem_pick") ?? {}) as Record<string, unknown>);
}

export async function setTiebreaker(
  gql: Gql, leagueId: string, rosterId: number, legId: string, gameId: string, value: number,
): Promise<LegState> {
  const body = await gql(
    `mutation{set_pickem_tiebreaker(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},` +
    `leg_id:"${safeLeg(legId)}",tiebreaker:{type:"total_points",game_id:"${safeId(gameId)}",value:${Math.trunc(value)}})` +
    `{leg_id status picks tiebreaker}}`,
  );
  return parseLeg((unwrap(body, "set_pickem_tiebreaker") ?? {}) as Record<string, unknown>);
}

/** The league's currently active leg, straight from the league object. */
export async function currentLegId(leagueId: string): Promise<string> {
  const res = await fetch(`https://api.sleeper.app/v1/league/${safeId(leagueId)}`);
  const j = (await res.json()) as { metadata?: { current_pickem_leg_id?: string } };
  const leg = j.metadata?.current_pickem_leg_id;
  if (!leg) throw new Error("league has no current_pickem_leg_id");
  return leg;
}
