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
  // How much authority the planning agent actually has. The deterministic layer
  // owns the option set (availability + position caps + the VONA ranking); the
  // agent picks within the top N of it. It is the only layer that can read news,
  // tiers, roster shape and a developing run, so a tight leash here made it
  // decorative and forced every real rule down into mechanical hacks.
  // planMaxRank=1 restores fully deterministic picking with no code change,
  // which is the draft-night revert knob.
  planMaxRank: Number(process.env.VONA_PLAN_MAX_RANK ?? "22"),
  // Refuse to put this many players on a single bye week when a comparable
  // alternative exists. The one veto that outranks the agent, because it is
  // mechanical and mock #1 got it wrong (four players off in week 10).
  // At 3 this vetoes a FOURTH player on one week and leaves two or three alone,
  // which is right: with 16 roster spots and 9 starters in an 8-team league, two
  // players sharing a bye is a bench swap, not a problem (Filip's call).
  byeStackMax: Number(process.env.VONA_BYE_STACK_MAX ?? "3"),
  // Below this load the value board just takes its best pick and ignores byes
  // entirely. Only from here up is spreading worth even a tie-break.
  byeSoftMin: Number(process.env.VONA_BYE_SOFT_MIN ?? "2"),
  // VONA gap within which a bye-week clash may redirect the pick. Value models
  // never see byes, so without this the picker cheerfully takes a fourth player
  // who is off in week 10. Kept small on purpose: bye spreading is a tie-break,
  // never a reason to pass on a clearly better player. 0 disables it.
  byeEps: Number(process.env.VONA_BYE_EPS ?? "3"),
} as const;

// The read-only public Sleeper API. No auth token: it cannot write anything.
export const SLEEPER_API = "https://api.sleeper.app/v1";

// Where cached data (player dump, snapshots) lives. Gitignored.
export const DATA_DIR = new URL("../data/", import.meta.url).pathname;
