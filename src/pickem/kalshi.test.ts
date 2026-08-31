import { test, expect } from "bun:test";
import { parseSpreadTicker, coverProbability, type KalshiMarket } from "./kalshi.ts";

const mk = (over: Partial<KalshiMarket> & { ticker: string }): KalshiMarket => ({
  title: "", yesBid: null, yesAsk: null, lastPrice: null, volume: 0, ...over,
});

test("parses the ladder ticker into a team and the margin it must exceed", () => {
  expect(parseSpreadTicker("KXNFLSPREAD-26SEP14DENKC-KC8")).toEqual({ team: "KC", winsByOver: 7.5 });
  expect(parseSpreadTicker("KXNFLSPREAD-26SEP14DENKC-KC3")).toEqual({ team: "KC", winsByOver: 2.5 });
  expect(parseSpreadTicker("KXNFLSPREAD-26SEP21NYGLAR-NYG1")).toEqual({ team: "NYG", winsByOver: 0.5 });
});

test("rejects tickers from other series or shapes", () => {
  expect(parseSpreadTicker("KXNFLGAME-26SEP21NYGLAR-NYG")).toBeNull();
  expect(parseSpreadTicker("KXNFL1HSPREAD-26SEP14DENKC-KC3")).toBeNull();
  expect(parseSpreadTicker("garbage")).toBeNull();
});

test("reads the cover probability off the matching rung as a mid quote", () => {
  const markets = [
    mk({ ticker: "KXNFLSPREAD-26SEP14DENKC-KC3", yesBid: 52, yesAsk: 56, volume: 400 }),
    mk({ ticker: "KXNFLSPREAD-26SEP14DENKC-KC8", yesBid: 20, yesAsk: 24, volume: 400 }),
  ];
  expect(coverProbability(markets, "KC", 2.5)).toBeCloseTo(0.54, 6);
  expect(coverProbability(markets, "KC", 7.5)).toBeCloseTo(0.22, 6);
});

test("refuses to answer from a listed but untraded market", () => {
  // This is the state Kalshi is actually in: rungs exist, nobody has traded.
  // A stale or absent price must return null, never a confident number.
  const markets = [mk({ ticker: "KXNFLSPREAD-26SEP14DENKC-KC3", volume: 0, lastPrice: 50 })];
  expect(coverProbability(markets, "KC", 2.5)).toBeNull();
});

test("falls back to a last price only when the market has actually traded", () => {
  const markets = [mk({ ticker: "KXNFLSPREAD-26SEP14DENKC-KC3", volume: 250, lastPrice: 61 })];
  expect(coverProbability(markets, "KC", 2.5)).toBeCloseTo(0.61, 6);
});

test("returns null when the ladder has no rung at that line", () => {
  const markets = [mk({ ticker: "KXNFLSPREAD-26SEP14DENKC-KC3", yesBid: 52, yesAsk: 56, volume: 9 })];
  expect(coverProbability(markets, "KC", 4.5)).toBeNull();
  expect(coverProbability(markets, "DEN", 2.5)).toBeNull();
});
