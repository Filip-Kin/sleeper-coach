// Per-week NFL game state: has this player's game finished, is it in progress,
// or has it not kicked off yet.
//
// WHY THIS EXISTS, and why it is not Sleeper. The in-season UI has to mark every
// starter as played / playing / yet to play, because "points already earned
// versus still to come" is the number that actually matters on a Sunday. Sleeper's
// matchup endpoint cannot answer it: `players_points` gives 0.0 both for a player
// whose game kicks off in four hours and for one who has finished and been shut
// out. Treating those the same would either double-count a dead score into the
// "still to come" pile or write off a player who has not taken a snap.
//
// So game state comes from ESPN's public scoreboard, the same free no-key source
// src/data/byes.ts was built from. It is READ-ONLY and entirely optional: if the
// fetch fails the whole UI still renders, every player is marked "unknown" and
// the win probability says so rather than inventing a split. A third-party
// outage must never blank the app.
//
// Abbreviation join: ESPN spells Washington "WSH", Sleeper "WAS". That is the
// ONLY difference across all 32 teams (checked against the bye table, which is
// Sleeper-keyed). Everything here is normalised to Sleeper abbreviations so it
// joins straight onto a player's `team`.

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// "pre"  kickoff is in the future, the whole projection is still to come
// "in"   in progress, part of the projection is banked and part is still live
// "post" final, whatever he scored is all he is going to score
export type GameState = "pre" | "in" | "post";

export interface NflGame {
  state: GameState;
  kickoff: number; // epoch ms
  // ESPN's own short description ("Sun 1:00 PM EDT", "Q3 4:12", "Final"). Shown
  // verbatim so the UI never has to reformat a clock it does not own.
  detail: string;
  home: string; // Sleeper abbreviation
  away: string;
  // Fraction of the game still unplayed, 1 before kickoff and 0 at the whistle.
  // This is what scales a live player's remaining projection and his variance.
  fracRemaining: number;
}

export interface WeekGames {
  // Sleeper team abbreviation -> that team's game this week. A team on bye has
  // no entry, which is the correct answer: it has no game.
  byTeam: Map<string, NflGame>;
  fetchedAt: number;
  // False when the source could not be read. The UI MUST degrade to "state
  // unknown" rather than pretending everything is yet to play.
  ok: boolean;
  error?: string;
}

// ESPN -> Sleeper. Only Washington differs; the map is kept explicit so a future
// rebrand is a one-line change rather than a hunt.
const TEAM_FIX: Record<string, string> = { WSH: "WAS" };
function toSleeperTeam(espn: string): string {
  return TEAM_FIX[espn] ?? espn;
}

const QUARTER_SECONDS = 15 * 60;
const REGULATION_SECONDS = 4 * QUARTER_SECONDS;

// How much football is left, as a fraction of a regulation game.
//
// Variance accrues with playing time, so this is the term that makes a player
// mid-third-quarter less uncertain than one who has not kicked off. Overtime is
// deliberately treated as "nearly over" rather than as extra time: a game in OT
// has essentially all of its fantasy scoring behind it.
export function fractionRemaining(state: GameState, period: number, clockSeconds: number): number {
  if (state === "pre") return 1;
  if (state === "post") return 0;
  if (period >= 5) return Math.max(0, Math.min(1, clockSeconds / REGULATION_SECONDS));
  const quartersAfterThisOne = Math.max(0, 4 - period);
  const left = clockSeconds + quartersAfterThisOne * QUARTER_SECONDS;
  return Math.max(0, Math.min(1, left / REGULATION_SECONDS));
}

// Shape of the slice of the ESPN scoreboard response we read. Everything is
// optional because it is someone else's API and a missing field must degrade,
// not throw.
interface EspnScoreboard {
  events?: {
    date?: string;
    status?: { clock?: number; period?: number; type?: { state?: string; shortDetail?: string; detail?: string } };
    competitions?: {
      status?: { clock?: number; period?: number; type?: { state?: string; shortDetail?: string; detail?: string } };
      competitors?: { homeAway?: string; team?: { abbreviation?: string } }[];
    }[];
  }[];
}

function parseState(raw: string | undefined): GameState {
  return raw === "in" ? "in" : raw === "post" ? "post" : "pre";
}

export function parseScoreboard(body: EspnScoreboard, now: number): Map<string, NflGame> {
  const byTeam = new Map<string, NflGame>();
  for (const ev of body.events ?? []) {
    const comp = ev.competitions?.[0];
    const status = comp?.status ?? ev.status;
    const state = parseState(status?.type?.state);
    const period = status?.period ?? 0;
    const clock = status?.clock ?? 0;
    const kickoff = ev.date ? Date.parse(ev.date) : now;
    const teams = (comp?.competitors ?? [])
      .map((c) => ({ side: c.homeAway, abbr: c.team?.abbreviation ? toSleeperTeam(c.team.abbreviation) : null }))
      .filter((t): t is { side: string | undefined; abbr: string } => t.abbr !== null);
    const home = teams.find((t) => t.side === "home")?.abbr ?? teams[0]?.abbr ?? "";
    const away = teams.find((t) => t.side === "away")?.abbr ?? teams[1]?.abbr ?? "";
    const game: NflGame = {
      state,
      kickoff: Number.isFinite(kickoff) ? kickoff : now,
      detail: status?.type?.shortDetail ?? status?.type?.detail ?? "",
      home,
      away,
      fracRemaining: fractionRemaining(state, period, clock),
    };
    for (const t of teams) byTeam.set(t.abbr, game);
  }
  return byTeam;
}

// Memory cache only. Game state is worthless after a restart and writing it to
// disk would be one more thing to invalidate; refetching costs a single request.
const cache = new Map<string, WeekGames>();

// A live week has to be near-real-time, but a week that is entirely finished
// never changes again, so it is pointless to keep asking.
const TTL_LIVE_MS = 45_000;
const TTL_SETTLED_MS = 10 * 60 * 1000;

function ttlFor(games: Map<string, NflGame>): number {
  for (const g of games.values()) if (g.state === "in") return TTL_LIVE_MS;
  return TTL_SETTLED_MS;
}

export async function loadWeekGames(season: string, week: number, now: number = Date.now()): Promise<WeekGames> {
  const key = `${season}-${week}`;
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < ttlFor(hit.byTeam)) return hit;

  try {
    const url = `${SCOREBOARD}?dates=${season}&seasontype=2&week=${week}`;
    // ESPN 403s this endpoint for an unrecognised User-Agent and serves it happily
    // to curl. It is public, keyless and unauthenticated (the same JSON behind the
    // public scoreboard page) and we ask for it once per week per 45 seconds, so
    // this is only about presenting a UA their edge recognises. Verified on
    // 2026-08-31: no UA, a custom UA and a full browser UA all return 403; a curl
    // UA returns 200.
    // A slow third party must not hang the page; the UI is fine without this.
    const res = await fetch(url, {
      headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
    const byTeam = parseScoreboard((await res.json()) as EspnScoreboard, now);
    const out: WeekGames = { byTeam, fetchedAt: now, ok: byTeam.size > 0 };
    cache.set(key, out);
    return out;
  } catch (err) {
    // Serve a stale copy if we have one: an old game state beats no game state.
    if (hit) return { ...hit, error: err instanceof Error ? err.message : String(err) };
    return { byTeam: new Map(), fetchedAt: now, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
