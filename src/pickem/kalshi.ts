// Kalshi's NFL spread ladder: the best-shaped input for this pool that we cannot
// yet use.
//
// WHY IT WOULD BE BETTER THAN ANY BOOK. Every other source gives us a LINE, so
// using it means comparing two lines and eating the noise of two books simply
// disagreeing (measured at 0.74 points mean absolute difference, comparable to
// the signal itself, which is why the ESPN feed tested worse than Sleeper's own
// field). Kalshi instead lists a ladder per game:
//
//   KXNFLSPREAD-26SEP14DENKC-KC8   "Kansas City wins by over 7.5 points?"
//   KXNFLSPREAD-26SEP14DENKC-KC3   "Kansas City wins by over 2.5 points?"
//
// That is a margin distribution, so we could read the probability of covering
// THE EXACT number Sleeper grades us on, with no line comparison at all. Given
// the graded line KC -2.5, P(cover) is just the KC3 yes price.
//
// WHY IT IS NOT WIRED IN. Measured 2026-08-31: every settled NFL market has zero
// volume (98 of 98 moneyline, 200 of 200 spread), and the market history only
// begins 2026-08-07, so there is nothing to backtest either. An untraded market
// has no price and therefore no information. Preseason markets being dead is
// normal, so this module PROBES and LOGS liquidity each pass; if real volume
// appears once the season starts, that is the signal to validate it and switch.
// It never touches a pick.

const API = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  title: string;
  yesBid: number | null;
  yesAsk: number | null;
  lastPrice: number | null;
  volume: number;
}

export interface LiquidityReport {
  markets: number;
  traded: number;        // markets with any volume at all
  quoted: number;        // markets with a live two-sided quote
  totalVolume: number;
  /** True once there is enough real trading to be worth validating against. */
  usable: boolean;
  error?: string;
}

/** "KXNFLSPREAD-26SEP14DENKC-KC8" -> { team: "KC", winsByOver: 7.5 }
 *  The trailing integer N means "wins by over N-0.5", which is how the ladder
 *  avoids pushes, the same trick as the .5 hook on Sleeper's graded line. */
export function parseSpreadTicker(ticker: string): { team: string; winsByOver: number } | null {
  const m = /^KXNFLSPREAD-[0-9A-Z]+-([A-Z]{2,4})(\d+)$/.exec(ticker);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  return { team: m[1] as string, winsByOver: n - 0.5 };
}

/** Probability that `team` covers a spread of `line` points, read straight off
 *  the ladder. line is the margin the team must EXCEED (2.5 for a -2.5 favourite).
 *  Uses the mid of the quote, and refuses to answer from an untraded market:
 *  a stale last price on zero volume is worse than no answer. */
export function coverProbability(
  markets: KalshiMarket[], team: string, line: number,
): number | null {
  for (const mk of markets) {
    const p = parseSpreadTicker(mk.ticker);
    if (!p || p.team !== team) continue;
    if (Math.abs(p.winsByOver - line) > 1e-9) continue;
    if (mk.yesBid !== null && mk.yesAsk !== null) return (mk.yesBid + mk.yesAsk) / 200; // cents -> probability
    if (mk.volume > 0 && mk.lastPrice !== null) return mk.lastPrice / 100;
    return null; // listed but untraded: no information
  }
  return null;
}

function toMarket(raw: Record<string, unknown>): KalshiMarket {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ticker: String(raw.ticker ?? ""),
    title: String(raw.title ?? ""),
    yesBid: num(raw.yes_bid),
    yesAsk: num(raw.yes_ask),
    lastPrice: num(raw.last_price),
    volume: num(raw.volume) ?? 0,
  };
}

/** Read-only, best-effort, and never allowed to break a pick'em pass. */
export async function probeLiquidity(limit = 200): Promise<LiquidityReport> {
  try {
    const res = await fetch(`${API}/markets?series_ticker=KXNFLSPREAD&status=open&limit=${limit}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { markets: 0, traded: 0, quoted: 0, totalVolume: 0, usable: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { markets?: Record<string, unknown>[] };
    const markets = (body.markets ?? []).map(toMarket);
    const traded = markets.filter((m) => m.volume > 0).length;
    const quoted = markets.filter((m) => m.yesBid !== null && m.yesAsk !== null).length;
    const totalVolume = markets.reduce((a, m) => a + m.volume, 0);
    return {
      markets: markets.length,
      traded, quoted, totalVolume,
      // Deliberately a high bar. A handful of contracts is not a market, and
      // switching to a thin price would be worse than the 56.3% we already have.
      usable: quoted >= 8 && totalVolume >= 1000,
    };
  } catch (e) {
    return { markets: 0, traded: 0, quoted: 0, totalVolume: 0, usable: false, error: (e as Error).message };
  }
}
