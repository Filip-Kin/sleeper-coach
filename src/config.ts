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
  rosterId: 3, // Filip's roster in this league ("--dangerously-skip-perms").

  // Last season's league, kept linked by Sleeper. Used to learn manager
  // tendencies and inform keeper analysis.
  previousLeagueId: "1267682977899364352",
} as const;

// The league is full PPR (1.0 per reception), which matches Sleeper's stored
// scoring settings. The coach reads scoring live from the league and values
// players off it directly, so there is no override here.

// The read-only public Sleeper API. No auth token: it cannot write anything.
export const SLEEPER_API = "https://api.sleeper.app/v1";

// Where cached data (player dump, snapshots) lives. Gitignored.
export const DATA_DIR = new URL("../data/", import.meta.url).pathname;
