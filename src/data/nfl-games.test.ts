import { fractionRemaining, parseScoreboard } from "./nfl-games.ts";

// Offline tests for the game-state layer. No network: parseScoreboard is fed a
// synthetic ESPN payload. These pin the two things the rest of the UI trusts it
// for: the played/playing/yet-to-play call, and the Washington abbreviation join
// that is the only difference between ESPN's names and Sleeper's.

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- fractionRemaining --------------------------------------------------------
t("a scheduled game has the whole game left", fractionRemaining("pre", 0, 0) === 1);
t("a final game has nothing left", fractionRemaining("post", 4, 0) === 0);
// Start of the first quarter: four full quarters to run.
t("kickoff is the whole game", near(fractionRemaining("in", 1, 15 * 60), 1));
// Half time: two quarters gone, two to go.
t("half time is half a game", near(fractionRemaining("in", 2, 0), 0.5));
// Eight minutes left in the third: 8 + 15 of 60.
t("mid third quarter", near(fractionRemaining("in", 3, 8 * 60), (8 + 15) / 60));
t("two minutes left in the fourth", near(fractionRemaining("in", 4, 120), 2 / 60));
// Overtime has essentially all its fantasy scoring behind it.
t("overtime is nearly over", fractionRemaining("in", 5, 600) < 0.2);
t("fraction is never negative", fractionRemaining("in", 4, -50) === 0);
t("fraction never exceeds one", fractionRemaining("in", 1, 99999) === 1);

// --- parseScoreboard ----------------------------------------------------------
const NOW = 1_760_000_000_000;
const payload = {
  events: [
    {
      date: "2026-09-13T17:00Z",
      competitions: [{
        status: { clock: 0, period: 0, type: { state: "pre", shortDetail: "Sun 1:00 PM EDT" } },
        competitors: [
          { homeAway: "home", team: { abbreviation: "WSH" } },
          { homeAway: "away", team: { abbreviation: "DAL" } },
        ],
      }],
    },
    {
      date: "2026-09-13T20:05Z",
      competitions: [{
        status: { clock: 300, period: 3, type: { state: "in", shortDetail: "Q3 5:00" } },
        competitors: [
          { homeAway: "home", team: { abbreviation: "SEA" } },
          { homeAway: "away", team: { abbreviation: "SF" } },
        ],
      }],
    },
    {
      date: "2026-09-13T13:00Z",
      competitions: [{
        status: { clock: 0, period: 4, type: { state: "post", shortDetail: "Final" } },
        competitors: [
          { homeAway: "home", team: { abbreviation: "KC" } },
          { homeAway: "away", team: { abbreviation: "BUF" } },
        ],
      }],
    },
  ],
};

const games = parseScoreboard(payload, NOW);

t("every team in every game is indexed", games.size === 6, `got ${games.size}`);
t("ESPN WSH is keyed as Sleeper WAS", games.has("WAS") && !games.has("WSH"));
t("a scheduled game reads pre", games.get("DAL")?.state === "pre");
t("a running game reads in", games.get("SEA")?.state === "in");
t("a finished game reads post", games.get("KC")?.state === "post");
t("both sides of a game share its state", games.get("SF")?.state === "in" && games.get("BUF")?.state === "post");
t("home and away are recorded", games.get("SEA")?.home === "SEA" && games.get("SEA")?.away === "SF");
t("ESPN's own clock text is passed through", games.get("SEA")?.detail === "Q3 5:00");
t("kickoff is parsed to epoch ms", games.get("KC")?.kickoff === Date.parse("2026-09-13T13:00Z"));
t("a live game carries a partial fraction",
  near(games.get("SEA")!.fracRemaining, (5 + 15) / 60), `got ${games.get("SEA")!.fracRemaining}`);
t("a pre game has the whole game remaining", games.get("DAL")?.fracRemaining === 1);
t("a post game has none remaining", games.get("KC")?.fracRemaining === 0);

// A team on a bye simply has no entry, which is the honest answer rather than a
// fabricated "pre" game the UI would then count as points still to come.
t("a team with no game this week is absent", !games.has("CIN"));

// Malformed input must degrade, never throw: it is someone else's API.
t("an empty payload yields no games", parseScoreboard({}, NOW).size === 0);
t("an event with no competitors is skipped", parseScoreboard({ events: [{ date: "x", competitions: [{}] }] }, NOW).size === 0);
t("a missing status defaults to pre rather than throwing", (() => {
  const g = parseScoreboard({ events: [{ competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "GB" } }] }] }] }, NOW);
  return g.get("GB")?.state === "pre";
})());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
