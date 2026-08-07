// Static identifiers for Filip's league, discovered from the Sleeper read-only API.
// Season-scoped values (league_id, draft_id) change each year; update them at rollover.

export const config = {
  season: "2026",
  sport: "nfl",

  // The user this coach plays for.
  username: "Filip96",
  userId: "1267685386142887936",

  // The active league and its draft.
  leagueId: "1389357604773322752",
  draftId: "1389357604773322753",
  rosterId: 3, // Filip's roster in this league ("The Gays").

  // Last season's league, kept linked by Sleeper. Used to learn manager
  // tendencies and inform keeper analysis.
  previousLeagueId: "1267682977899364352",
} as const;

// This league is actually HALF PPR, but Sleeper's stored setting reads full PPR
// (rec 1.0) and Filip isn't commissioner so can't correct it. He confirmed the
// real scoring, so we force the reception value to the truth everywhere the
// coach values players. `raw` is the league's stored scoring; only `rec` is off.
export const TRUE_REC = 0.5;
export function trueScoring<T extends Record<string, number>>(raw: T): T {
  return { ...raw, rec: TRUE_REC };
}

// The read-only public Sleeper API. No auth token: it cannot write anything.
export const SLEEPER_API = "https://api.sleeper.app/v1";

// Where cached data (player dump, snapshots) lives. Gitignored.
export const DATA_DIR = new URL("../data/", import.meta.url).pathname;
