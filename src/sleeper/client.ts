import { SLEEPER_API } from "../config.ts";
import type {
  League,
  LeagueUser,
  Roster,
  Draft,
  DraftPick,
  PlayersMap,
  NflState,
  SleeperUser,
  ProjectionRecord,
} from "./types.ts";

// Projections/stats live at the API root, not under /v1. Undocumented but
// stable and widely used; same read-only nature.
const SLEEPER_ROOT = "https://api.sleeper.app";

// #region core request
// Sleeper asks callers to stay well under 1000 requests/minute. Everything here
// is read-only; there is deliberately no write path in this client.

class SleeperError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Sleeper API ${status} for ${url}`);
    this.name = "SleeperError";
  }
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  const url = `${SLEEPER_API}${path}`;
  const res = await fetch(url);
  if (res.status === 429 && attempt < 4) {
    // Back off on rate limiting: 0.5s, 1s, 2s, 4s.
    await Bun.sleep(500 * 2 ** attempt);
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new SleeperError(res.status, url);
  return (await res.json()) as T;
}

async function getRoot<T>(path: string, attempt = 0): Promise<T> {
  const url = `${SLEEPER_ROOT}${path}`;
  const res = await fetch(url);
  if (res.status === 429 && attempt < 4) {
    await Bun.sleep(500 * 2 ** attempt);
    return getRoot<T>(path, attempt + 1);
  }
  if (!res.ok) throw new SleeperError(res.status, url);
  return (await res.json()) as T;
}
// #endregion

// #region endpoints
export const sleeper = {
  user: (usernameOrId: string) => get<SleeperUser>(`/user/${usernameOrId}`),

  league: (leagueId: string) => get<League>(`/league/${leagueId}`),

  leagueUsers: (leagueId: string) =>
    get<LeagueUser[]>(`/league/${leagueId}/users`),

  rosters: (leagueId: string) => get<Roster[]>(`/league/${leagueId}/rosters`),

  matchups: (leagueId: string, week: number) =>
    get<unknown[]>(`/league/${leagueId}/matchups/${week}`),

  // Completed and pending transactions for a scoring period (the "round").
  transactions: (leagueId: string, round: number) =>
    get<unknown[]>(`/league/${leagueId}/transactions/${round}`),

  draft: (draftId: string) => get<Draft>(`/draft/${draftId}`),

  draftPicks: (draftId: string) => get<DraftPick[]>(`/draft/${draftId}/picks`),

  // The full NFL player dump (~5MB). Cache it; refresh at most once a day.
  playersDump: () => get<PlayersMap>(`/players/nfl`),

  nflState: () => get<NflState>(`/state/nfl`),

  // Season-long projections (includes ADP and a full projected stat line).
  seasonProjections: (season: string) =>
    getRoot<ProjectionRecord[]>(`/projections/nfl/${season}?season_type=regular`),

  // Per-week projections for in-season lineup calls.
  weeklyProjections: (season: string, week: number) =>
    getRoot<ProjectionRecord[]>(`/projections/nfl/${season}/${week}?season_type=regular`),
};
// #endregion

export { SleeperError };
