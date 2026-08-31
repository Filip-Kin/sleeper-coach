// A genuinely LIVE market line, which Sleeper does not give us.
//
// WHY THIS EXISTS. Sleeper's own `spread` field is a market line but a stale one:
// measured over 529 games, its last update sits a median 68 hours before
// kickoff, and only about a tenth of games see it move inside five hours. Worse,
// `pickem_spread` (the line we are GRADED against) looks like the OPENING line,
// frozen. So the disagreement we trade on is really open-versus-close, and the
// closer we can read the true current line, the bigger and fresher the signal.
//
// Source is ESPN's public odds endpoints: free, no key, and already a dependency
// of this repo (src/data/nfl-games.ts uses the same scoreboard for game state).
//   scoreboard  -> event ids, and live odds for upcoming games
//   core /odds  -> per-event open / close / current point spreads
//
// Everything here degrades to null rather than throwing. A third-party outage
// must leave us picking off Sleeper's own line, never blank and never crashed.

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

// ESPN spells Washington WSH, Sleeper WAS. Only difference across 32 teams,
// same fix as src/data/nfl-games.ts.
const TEAM_FIX: Record<string, string> = { WSH: "WAS" };
const toSleeper = (t: string): string => TEAM_FIX[t] ?? t;

export interface MarketLine {
  away: string;
  home: string;
  /** Current market spread from the AWAY team's view, matching Sleeper's sign
   *  convention: +3.5 means the away team is a 3.5 point underdog. */
  spreadAway: number | null;
  /** The opening line, for reference. Sleeper's graded line tracks this. */
  openAway: number | null;
  /** Market total. Far better than a global prior for the weekly tiebreaker. */
  total: number | null;
  provider: string | null;
  eventId: string;
}

function parseSpread(node: unknown): number | null {
  const ps = (node as { pointSpread?: { american?: string; alternateDisplayValue?: string } } | undefined)?.pointSpread;
  const raw = ps?.american ?? ps?.alternateDisplayValue;
  if (raw === undefined || raw === null) return null;
  // ESPN writes "+1.5" / "-2.5" / "EVEN".
  const s = String(raw).trim();
  if (/^even$/i.test(s)) return 0;
  const n = Number(s.replace("+", ""));
  return Number.isFinite(n) ? n : null;
}

function parseTotal(node: unknown): number | null {
  const t = (node as { total?: { american?: string; alternateDisplayValue?: string } } | undefined)?.total;
  const raw = t?.american ?? t?.alternateDisplayValue;
  const n = Number(String(raw ?? "").replace("+", ""));
  return Number.isFinite(n) ? n : null;
}

async function getJson(url: string, timeoutMs = 12_000): Promise<unknown | null> {
  try {
    // The UA matters and not in the obvious direction. src/data/nfl-games.ts
    // already recorded it: no UA, a custom UA and a full browser UA all get 403
    // from ESPN, and a curl UA gets 200. This is the opposite of Nominatim and
    // Overpass, which demand a contactable UA. I burned a fetch working that out
    // twice, so it is written down in both places now.
    const res = await fetch(url, {
      headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface ScoreboardEvent {
  id: string;
  competitions: {
    competitors: { homeAway: string; team: { abbreviation: string } }[];
    odds?: {
      provider?: { name?: string };
      awayTeamOdds?: { open?: unknown; close?: unknown; current?: unknown };
      overUnder?: number;
      close?: unknown;
      current?: unknown;
    }[];
  }[];
}

/** Live lines for a week, keyed "AWAY@HOME" in Sleeper abbreviations.
 *
 *  The scoreboard already embeds odds for upcoming games, so this is normally
 *  ONE request for the whole slate. Games whose odds are missing there fall back
 *  to the per-event core endpoint, which is also the only place open/close live
 *  once a game has finished. */
export async function fetchMarketLines(season: string, week: number): Promise<Map<string, MarketLine>> {
  const out = new Map<string, MarketLine>();
  const sb = (await getJson(`${SCOREBOARD}?dates=${season}&seasontype=2&week=${week}`)) as { events?: ScoreboardEvent[] } | null;
  if (!sb?.events) return out;

  const needsDetail: { key: string; eventId: string }[] = [];
  for (const e of sb.events) {
    const comp = e.competitions?.[0];
    if (!comp) continue;
    const away = toSleeper(comp.competitors.find((c) => c.homeAway === "away")?.team.abbreviation ?? "");
    const home = toSleeper(comp.competitors.find((c) => c.homeAway === "home")?.team.abbreviation ?? "");
    if (!away || !home) continue;
    const key = `${away}@${home}`;

    // Prefer a book that actually carries a close/current spread.
    const odds = comp.odds ?? [];
    const pick = odds.find((o) => o.awayTeamOdds?.current ?? o.awayTeamOdds?.close) ?? odds[0];
    const ao = pick?.awayTeamOdds;
    const line: MarketLine = {
      away, home, eventId: e.id,
      spreadAway: parseSpread(ao?.current) ?? parseSpread(ao?.close),
      openAway: parseSpread(ao?.open),
      total: parseTotal(pick?.current) ?? parseTotal(pick?.close) ?? (typeof pick?.overUnder === "number" ? pick.overUnder : null),
      provider: pick?.provider?.name ?? null,
    };
    out.set(key, line);
    if (line.spreadAway === null) needsDetail.push({ key, eventId: e.id });
  }

  // Only pay for per-event calls where the scoreboard came back without a line.
  for (const { key, eventId } of needsDetail) {
    const d = await fetchEventLine(season, week, eventId);
    if (d) {
      const prev = out.get(key);
      out.set(key, { ...(prev as MarketLine), ...d });
    }
  }
  return out;
}

/** Per-event odds, which is where open/close survive after a game finishes. */
export async function fetchEventLine(
  _season: string, _week: number, eventId: string,
): Promise<Partial<MarketLine> | null> {
  const d = (await getJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds`)) as
    { items?: ScoreboardEvent["competitions"][0]["odds"] } | null;
  const items = d?.items ?? [];
  if (!items.length) return null;
  // The settled book is the one carrying a close; it is the honest closing line.
  const pick = items.find((i) => i.awayTeamOdds?.close) ?? items[0];
  const ao = pick?.awayTeamOdds;
  return {
    spreadAway: parseSpread(ao?.current) ?? parseSpread(ao?.close),
    openAway: parseSpread(ao?.open),
    total: parseTotal(pick?.current) ?? parseTotal(pick?.close) ?? (typeof pick?.overUnder === "number" ? pick.overUnder : null),
    provider: pick?.provider?.name ?? null,
  };
}
