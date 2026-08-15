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

// VONA (Value Over Next Available) tuning. The draft engine picks the biggest
// value drop-off to our next snake pick rather than raw value; these govern how
// confident and how opponent-aware that prediction is. Defaults are deliberately
// humble — a wide ADP spread means we don't over-trust the survival estimate.
export const vonaConfig = {
  enabled: (process.env.VONA ?? "1") !== "0", // VONA=0 → pure VOR (old behaviour)
  adpSpread: Number(process.env.VONA_ADP_SPREAD ?? "8"), // logistic scale on ADP; higher = humbler
  oppNudge: Number(process.env.VONA_OPP_NUDGE ?? "0.15"), // max survival shave from a leaned opponent (0 disables)
  planEps: Number(process.env.VONA_PLAN_EPS ?? "2.5"), // VONA gap within which the agent's read may override the top pick
} as const;

// The read-only public Sleeper API. No auth token: it cannot write anything.
export const SLEEPER_API = "https://api.sleeper.app/v1";

// Where cached data (player dump, snapshots) lives. Gitignored.
export const DATA_DIR = new URL("../data/", import.meta.url).pathname;
