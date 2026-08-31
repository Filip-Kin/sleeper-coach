import { derivePhase, buildStandings } from "./seasonview.ts";
import type { NflGame } from "../data/nfl-games.ts";
import type { League, LeagueUser, Roster } from "../sleeper/types.ts";

// Offline tests for the season view's pure parts. The assembly itself needs the
// live API and is exercised by hand; these pin the two decisions that would
// silently mislead if they broke: what "phase" a week is in, and the standings
// order plus where the playoff line falls.

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

// #region derivePhase
const g = (state: "pre" | "in" | "post"): NflGame =>
  ({ state, kickoff: 0, detail: "", home: "A", away: "B", fracRemaining: state === "pre" ? 1 : state === "post" ? 0 : 0.5 });
const games = (...states: ("pre" | "in" | "post")[]) => new Map(states.map((s, i) => [`T${i}`, g(s)]));

t("all games scheduled is a future week", derivePhase(1, 1, games("pre", "pre"), true) === "future");
t("any game running is live", derivePhase(1, 1, games("pre", "in", "post"), true) === "live");
t("all games final is a past week", derivePhase(1, 1, games("post", "post"), true) === "past");
// Sunday afternoon: the early games are done, the late ones have not started.
t("some final and some scheduled is still live", derivePhase(1, 1, games("post", "pre"), true) === "live");

// THE case this function exists for. /state/nfl reports week 1 for the whole of
// the preceding week, so the calendar says "current" while nothing has kicked
// off. Showing that as live, with a 0-0 scoreboard, would be wrong.
t("the current week before kickoff is future, not live",
  derivePhase(1, 1, games("pre", "pre", "pre"), true) === "future");

// Without a scoreboard we fall back to the calendar rather than guessing.
t("no scoreboard falls back to the calendar (past)", derivePhase(3, 5, new Map(), false) === "past");
t("no scoreboard falls back to the calendar (future)", derivePhase(9, 5, new Map(), false) === "future");
t("no scoreboard falls back to the calendar (current)", derivePhase(5, 5, new Map(), false) === "live");
t("an empty game map falls back even when the fetch claimed to work",
  derivePhase(5, 5, new Map(), true) === "live");
// #endregion

// #region buildStandings
const league = {
  settings: { playoff_teams: 4, playoff_week_start: 16 },
} as unknown as League;

const roster = (id: number, wins: number, losses: number, fpts: number, dec: number, waiver: number): Roster =>
  ({
    roster_id: id, owner_id: `u${id}`, players: [], starters: [], reserve: null, keepers: null,
    settings: { wins, losses, ties: 0, fpts, fpts_decimal: dec, waiver_position: waiver, total_moves: 0 } as never,
  }) as Roster;

const users: LeagueUser[] = [1, 2, 3, 4, 5].map((i) => ({
  user_id: `u${i}`, display_name: `owner${i}`, avatar: null,
  metadata: i === 3 ? { team_name: "Ours" } : { team_name: `Team ${i}` },
}));

const rosters = [
  roster(1, 2, 3, 500, 25, 6),
  roster(2, 5, 0, 700, 0, 8),
  roster(3, 3, 2, 640, 50, 5), // config.rosterId is 3 in this repo
  roster(4, 3, 2, 610, 10, 4),
  roster(5, 5, 0, 690, 99, 2),
];
const table = buildStandings(rosters, users, league);

t("standings sort by wins first", table[0]!.wins === 5 && table[1]!.wins === 5);
t("points for breaks a tie on wins", table[0]!.rosterId === 2 && table[1]!.rosterId === 5,
  `got ${table[0]!.rosterId}, ${table[1]!.rosterId}`);
t("the fpts decimal is added, not dropped", table[1]!.pointsFor === 690.99, `got ${table[1]!.pointsFor}`);
t("a whole-number score stays whole", table[0]!.pointsFor === 700);
t("ranks are 1-based and dense", table.map((r) => r.rank).join(",") === "1,2,3,4,5");
t("the top four are in playoff spots", table.filter((r) => r.inPlayoffSpot).length === 4);
t("fifth place is outside the cut", table[4]!.inPlayoffSpot === false);
t("our roster is flagged exactly once", table.filter((r) => r.isUs).length === 1);
t("our roster is the right one", table.find((r) => r.isUs)!.rosterId === 3);
t("a team name is preferred over the display name", table.find((r) => r.isUs)!.teamName === "Ours");
t("waiver position is carried through", table.find((r) => r.rosterId === 5)!.waiverPosition === 2);
// Same wins AND our roster ahead of roster 4 on points for.
t("equal records are separated by points for",
  table.findIndex((r) => r.rosterId === 3) < table.findIndex((r) => r.rosterId === 4));
// #endregion

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
