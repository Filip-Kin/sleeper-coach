// Pins for the 2026-09-23 trade audit that need the NEW seams (T2, T5, T7,
// T8, T11, T12, T13, T16). Against the unmodified code this file cannot link
// (the exports do not exist), which is the honest "before": none of these
// behaviours had a test because none of them had a seam.
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { config } from "../config.ts";
import { recentEvents } from "../log.ts";
import { ACTIVITY_LOG } from "../paths.ts";
import { DropRefused } from "./drop-ledger.ts";
import type { PendingTrade, Gql } from "./api.ts";
import { handlePendingTrades, acceptSucceeded, reviewOpenOffers, type TradeWatchDeps } from "./trade-watch.ts";
import {
  runProposer, pairKey, onCooldown, liveOffers, reconcileProposals, ensureTable, OFFER_TTL_DAYS, type ProposerIo,
} from "./trade-propose.ts";
import { IntentStore } from "../analysis/trade-intent.ts";
import { applyPending, stashFlag, type LeagueSnapshot } from "../analysis/trade-wire.ts";
import { fitsObjective, objectiveScore, outboundConfig, DEFAULT_FAIRNESS, DEFAULT_PROPOSER, type FairnessConfig } from "../analysis/trade-fair.ts";
import type { TradePlayer } from "../analysis/trade.ts";

const P = (name: string, position: string, points: number, x: Partial<TradePlayer> = {}): TradePlayer => ({ name, position, points, playerId: name, ...x });
const US = config.rosterId; // 1 under test
const THEM = 2;
const ours: TradePlayer[] = [
  P("QB1", "QB", 300), P("RB1", "RB", 280), P("RBbad", "RB", 190, { depthChartOrder: 2 }), P("WRa", "WR", 250), P("WRb", "WR", 245), P("WRc", "WR", 240),
  P("WRd", "WR", 235), P("WRe", "WR", 230), P("TE1", "TE", 190), P("K1", "K", 44), P("DEF1", "DEF", 10),
];
const theirs: TradePlayer[] = [
  P("tQB", "QB", 290), P("tRB1", "RB", 270), P("tRB2", "RB", 265), P("tRB3", "RB", 210), P("tRB4", "RB", 200), P("tWRa", "WR", 222), P("tWRb", "WR", 215), P("tWRc", "WR", 70),
  P("tTE", "TE", 185), P("tK", "K", 42), P("tDEF", "DEF", 8),
];
const snap = (): LeagueSnapshot => ({
  playerById: new Map([...ours, ...theirs].map((p) => [p.playerId!, p])),
  rosterOf: new Map([[US, ours], [THEM, theirs]]),
  ourRosterId: US, idByName: new Map(), ownerIdOf: new Map(), week: 4, capacity: 16,
});
const weeks = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const fair: FairnessConfig = { ...DEFAULT_FAIRNESS, remainingWeeks: 12, headToHeadRemaining: 2, upcomingWeeks: weeks, rosterCapacity: 16 };
const gql: Gql = async () => ({});
const NOW = 1_700_000_000_000;
const tx = (id: string, over: Partial<PendingTrade> = {}): PendingTrade => ({
  transactionId: id, status: "proposed", type: "trade", rosterIds: [US, THEM], consenterIds: [THEM],
  adds: { tRB2: US, WRc: THEM }, drops: { tRB2: THEM, WRc: US }, created: NOW - 60_000, ...over,
});
function db(): Database { const d = new Database(":memory:"); ensureTable(d); return d; }
const eventsOf = (type: string) => recentEvents(500).filter((e) => e.type === type);

beforeEach(() => { rmSync(ACTIVITY_LOG, { force: true }); });

describe("T2 one snapshot per poll, and a player already leaving is gone from it", () => {
  test("applyPending removes the outgoing player and adds the incoming one", () => {
    const s = applyPending(snap(), { incoming: ["tRB2"], outgoing: ["WRc"] });
    const names = (s.rosterOf.get(US) ?? []).map((p) => p.playerId);
    expect(names).not.toContain("WRc");
    expect(names).toContain("tRB2");
    expect(s.rosterOf.get(THEM)).toBe(theirs); // rivals untouched
  });
  test("the poll takes exactly one snapshot for any number of offers", async () => {
    let snaps = 0;
    const deps = fakeDeps({ snapshot: async () => { snaps++; return snap(); } });
    await handlePendingTrades(gql, 4, () => false, () => {}, db(), { ...deps, pendingTrades: async () => [tx("a"), tx("b", { adds: { tRB3: US, WRd: THEM }, drops: { tRB3: THEM, WRd: US } })] });
    expect(snaps).toBe(1);
  });
  test("a snapshot that throws is a logged skip, not a crash (T3)", async () => {
    const deps = fakeDeps({ snapshot: async () => { throw new Error("roster 2 came from a source with no player_map"); } });
    const out = await handlePendingTrades(gql, 4, () => false, () => {}, db(), { ...deps, pendingTrades: async () => [tx("a")] });
    expect(out).toEqual([]);
    expect(eventsOf("trade-snapshot-failed").length).toBe(1);
  });
});

describe("T5 the stash flag reaches the trade snapshot", () => {
  test("hurt now, real talent, season still to play: a stash", () => {
    expect(stashFlag("IR", 200, 4)).toBe(true);
    expect(stashFlag("Out", 200, 4)).toBe(true);
  });
  test("questionable, or a scrub, or the championship week: not a stash", () => {
    expect(stashFlag("Questionable", 200, 4)).toBe(false);
    expect(stashFlag("IR", 50, 4)).toBe(false);
    expect(stashFlag("IR", 200, 17)).toBe(false);
  });
});

function fakeDeps(over: Partial<TradeWatchDeps> = {}): TradeWatchDeps {
  return {
    now: () => NOW,
    pendingTrades: async () => [],
    outstandingOffers: async () => [],
    snapshot: async () => snap(),
    evaluate: async () => ({
      evaluation: { verdict: "accept", ourGain: 10, theirGain: 5, edge: 5, netValue: 9, requiredEdge: 3, railBlocks: [], fairnessBlocks: [], reasons: [], lineupDelta: 10, before: 0, after: 0 },
      theirRosterId: THEM, isMultiParty: false,
    }),
    fairness: async () => fair,
    acceptTrade: async () => "complete",
    rejectTrade: async () => "rejected",
    proposeTrade: async () => ({ transactionId: "new", status: "proposed" }),
    findTradeThread: async () => null,
    sendDm: async () => "",
    alert: async () => {},
    warnIfNewsStale: async () => {},
    ...over,
  };
}

describe("T8 the accept is checked", () => {
  test("acceptSucceeded reads Sleeper's status", () => {
    expect(acceptSucceeded("complete")).toBe(true);
    expect(acceptSucceeded("processing")).toBe(true);
    expect(acceptSucceeded("")).toBe(false);
    expect(acceptSucceeded("failed")).toBe(false);
    expect(acceptSucceeded("rejected")).toBe(false);
  });
  test("DropRefused defers: not handled, logged, no alert, retried next poll", async () => {
    const handled: string[] = [];
    let alerts = 0, accepts = 0;
    const deps = fakeDeps({
      pendingTrades: async () => [tx("d")],
      acceptTrade: async () => { accepts++; throw new DropRefused({ allowed: false, reason: "3 drops this hour", freeze: false }, ["WRc"]); },
      alert: async () => { alerts++; },
    });
    await handlePendingTrades(gql, 4, (id) => handled.includes(id), (id) => handled.push(id), db(), deps);
    await handlePendingTrades(gql, 4, (id) => handled.includes(id), (id) => handled.push(id), db(), deps);
    expect(handled).toEqual([]);
    expect(accepts).toBe(2);
    expect(alerts).toBe(0);
    expect(eventsOf("trade-deferred").length).toBe(2);
    expect(eventsOf("trade-accept-failed").length).toBe(0);
  });
  test("a dead status back from accept: handled, logged, alerted once, never re-evaluated", async () => {
    const handled: string[] = [];
    let alerts = 0, evaluations = 0;
    const base = fakeDeps();
    const deps = fakeDeps({
      pendingTrades: async () => [tx("f")],
      evaluate: async (t, s) => { evaluations++; return base.evaluate(t, s); },
      acceptTrade: async () => "failed",
      alert: async () => { alerts++; },
    });
    for (let i = 0; i < 3; i++) await handlePendingTrades(gql, 4, (id) => handled.includes(id), (id) => handled.push(id), db(), deps);
    expect(handled).toEqual(["f"]);
    expect(alerts).toBe(1);
    expect(evaluations).toBe(1);
    expect(eventsOf("trade-accept-failed").length).toBe(1);
  });
  test("a thrown accept (not DropRefused) is the same failure path", async () => {
    const handled: string[] = [];
    let alerts = 0;
    const deps = fakeDeps({
      pendingTrades: async () => [tx("g")],
      acceptTrade: async () => { throw new Error("gql 500"); },
      alert: async () => { alerts++; },
    });
    await handlePendingTrades(gql, 4, (id) => handled.includes(id), (id) => handled.push(id), db(), deps);
    expect(handled).toEqual(["g"]);
    expect(alerts).toBe(1);
  });
  test("a good accept is handled with the verdict and no alert", async () => {
    const handled: [string, string][] = [];
    let alerts = 0;
    const deps = fakeDeps({ pendingTrades: async () => [tx("h")], alert: async () => { alerts++; } });
    const out = await handlePendingTrades(gql, 4, (id) => handled.some((h) => h[0] === id), (id, how) => handled.push([id, how]), db(), deps);
    expect(handled).toEqual([["h", "accept"]]);
    expect(alerts).toBe(0);
    expect(out[0]?.verdict).toBe("accept");
  });
});

describe("T16 an offer Sleeper reports dead is filed, not decided", () => {
  test("status expired is marked handled without an evaluation", async () => {
    const handled: [string, string][] = [];
    let evaluations = 0;
    const base = fakeDeps();
    const deps = fakeDeps({ pendingTrades: async () => [tx("x", { status: "expired" })], evaluate: async (t, s) => { evaluations++; return base.evaluate(t, s); } });
    await handlePendingTrades(gql, 4, () => false, (id, how) => handled.push([id, how]), db(), deps);
    expect(handled).toEqual([["x", "dead"]]);
    expect(evaluations).toBe(0);
  });
});

describe("T11 our open offers are re-checked every poll", () => {
  test("an open offer that no longer clears our bar is logged stale, once", async () => {
    // We offered WRc for tRB2; pretend tRB2 has since gone on IR on their roster.
    const s = snap();
    s.rosterOf.set(THEM, theirs.map((p) => (p.playerId === "tRB2" ? { ...p, onIr: true } : p)));
    const open = [tx("o", { consenterIds: [US] })];
    const deps = fakeDeps();
    const stale1 = await reviewOpenOffers(open, s, deps);
    const stale2 = await reviewOpenOffers(open, s, deps);
    expect(stale1).toEqual(["o"]);
    expect(stale2).toEqual(["o"]);
    expect(eventsOf("trade-offer-stale").length).toBe(1);
  });
  test("an open offer that still clears is not logged", async () => {
    // The proposer's own top pick on this fixture, through the real two-sided engine.
    const open = [tx("ok", { consenterIds: [US], adds: { tRB2: US, tRB4: US, WRc: THEM, WRd: THEM }, drops: { tRB2: THEM, tRB4: THEM, WRc: US, WRd: US } })];
    const stale = await reviewOpenOffers(open, snap(), fakeDeps());
    expect(stale).toEqual([]);
  });
});

describe("T11 cooldown throttles a swap sharing half its players", () => {
  test("same manager, half the players in common: throttled", () => {
    const d = db();
    d.run("INSERT INTO trade_proposals (pair_key, manager_id, transaction_id, at) VALUES (?, ?, ?, ?)", [pairKey("2", ["rice"], ["evans", "etienne"]), "2", "t1", NOW - 86_400_000]);
    expect(onCooldown(d, pairKey("2", ["rice"], ["evans", "downs"]), NOW)).toBe(true);
    expect(onCooldown(d, pairKey("2", ["rice", "x"], ["a", "b"]), NOW)).toBe(false); // 1 of 4
    expect(onCooldown(d, pairKey("4", ["rice"], ["evans", "downs"]), NOW)).toBe(false); // other manager
  });
});

describe("T12 dead offers do not count toward the cap", () => {
  test("liveOffers drops expired and dead-status offers", () => {
    const fresh = tx("live");
    const old = tx("old", { created: NOW - (OFFER_TTL_DAYS + 1) * 86_400_000 });
    const dead = tx("dead", { status: "rejected" });
    expect(liveOffers([fresh, old, dead], NOW).map((t) => t.transactionId)).toEqual(["live"]);
  });
  test("reconcileProposals marks rows absent from Sleeper dead", () => {
    const d = db();
    for (const id of ["a", "b"]) d.run("INSERT INTO trade_proposals (pair_key, manager_id, transaction_id, at) VALUES (?, ?, ?, ?)", [`2|${id}|x`, "2", id, NOW - 1000]);
    expect(reconcileProposals(d, [tx("a")], NOW)).toEqual(["b"]);
    const rows = d.query<{ transaction_id: string; status: string }, []>("SELECT transaction_id, status FROM trade_proposals ORDER BY transaction_id").all();
    expect(rows).toEqual([{ transaction_id: "a", status: "open" }, { transaction_id: "b", status: "dead" }]);
    expect(reconcileProposals(d, [tx("a")], NOW)).toEqual([]); // idempotent
  });
});

describe("T13 the objective", () => {
  test("today's +111/+9 shape is cut by the ratio cap and would rank below +12/+10 anyway", () => {
    expect(fitsObjective(111, 9)).toBe(false);
    expect(fitsObjective(12, 10)).toBe(true);
    expect(fitsObjective(5, -1)).toBe(false);
    const cfg = { ...DEFAULT_FAIRNESS, byeReliefPts: 0 };
    expect(objectiveScore({ ourGain: 111, theirGain: 9, byeRelief: 0, size: 2 }, cfg)).toBeLessThan(objectiveScore({ ourGain: 12, theirGain: 10, byeRelief: 0, size: 2 }, cfg));
  });
  test("the outbound ceiling is 1.5 points per remaining week; inbound stays 15", () => {
    expect(outboundConfig(fair).maxTheirGainPts).toBe(18);
    expect(fair.maxTheirGainPts).toBe(15);
    expect(DEFAULT_PROPOSER.theirGainPtsPerWeek).toBe(1.5);
  });
});

// #region the proposer end to end, with every read and write faked
function proposerIo(over: Partial<ProposerIo> = {}): Partial<ProposerIo> {
  return {
    nflState: async () => ({ week: 4 }),
    league: async () => ({ settings: { trade_deadline: 11 } as never }),
    outstandingOffers: async () => [],
    snapshot: async () => snap(),
    scheduleContext: async () => ({ remainingWeeks: 12, headToHeadRemaining: 2, upcomingWeeks: weeks }),
    proposeTrade: async () => ({ transactionId: "sent1", status: "proposed" }),
    pitch: async () => {},
    ...over,
  };
}
const intentPath = () => `/tmp/sleeper-coach-test/intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

describe("T11 gateOutgoing is wired into the proposer", () => {
  test("first pass records, a second pass inside the window sends, the intent is then cleared", async () => {
    const d = db();
    const intents = new IntentStore(intentPath());
    let sends = 0;
    const io = proposerIo({ proposeTrade: async () => { sends++; return { transactionId: "s", status: "proposed" }; } });
    const first = await runProposer({ db: d, now: NOW, intents, io, gate: { minAgeMs: 1000, maxAgeMs: 60_000 } }, gql);
    expect(first.outcome).toBe("recorded");
    expect(sends).toBe(0);
    const tooSoon = await runProposer({ db: d, now: NOW + 500, intents, io, gate: { minAgeMs: 1000, maxAgeMs: 60_000 } }, gql);
    expect(tooSoon.outcome).toBe("waiting");
    const second = await runProposer({ db: d, now: NOW + 2000, intents, io, gate: { minAgeMs: 1000, maxAgeMs: 60_000 } }, gql);
    expect(second.outcome).toBe("sent");
    expect(sends).toBe(1);
    expect(intents.all()).toEqual([]);
    expect(d.query<{ n: number }, []>("SELECT count(*) AS n FROM trade_proposals").get()?.n).toBe(1);
  });
  test("a dry run neither records an intent nor a cooldown row", async () => {
    const d = db();
    const intents = new IntentStore(intentPath());
    const r = await runProposer({ db: d, now: NOW, intents, io: proposerIo(), dry: true }, gql);
    expect(r.outcome).toBe("dry");
    expect(r.sent).not.toBeNull();
    expect(intents.all()).toEqual([]);
  });
});

describe("T7 a thrown propose is a logged miss, not a crashed job", () => {
  test("trade-propose-failed is logged and the job returns", async () => {
    const d = db();
    const intents = new IntentStore(intentPath());
    const io = proposerIo({ proposeTrade: async () => { throw new Error("propose_trade: invalid player id SEA"); } });
    const gate = { minAgeMs: 1000, maxAgeMs: 60_000 };
    await runProposer({ db: d, now: NOW, intents, io, gate }, gql);
    const r = await runProposer({ db: d, now: NOW + 2000, intents, io, gate }, gql);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/invalid player id/);
    expect(eventsOf("trade-propose-failed").length).toBe(1);
  });
});

describe("T12 the cap counts only live offers", () => {
  test("two dead offers do not block a new one", async () => {
    const d = db();
    const io = proposerIo({ outstandingOffers: async () => [tx("dead1", { status: "rejected", consenterIds: [US] }), tx("dead2", { created: NOW - 10 * 86_400_000, consenterIds: [US] })] });
    const r = await runProposer({ db: d, now: NOW, intents: new IntentStore(intentPath()), io, dry: true }, gql);
    expect(r.reason).not.toMatch(/unanswered/);
    expect(r.sent).not.toBeNull();
  });
  test("two live offers do", async () => {
    const d = db();
    const io = proposerIo({ outstandingOffers: async () => [tx("l1", { consenterIds: [US] }), tx("l2", { consenterIds: [US], rosterIds: [US, 3] })] });
    const r = await runProposer({ db: d, now: NOW, intents: new IntentStore(intentPath()), io, dry: true }, gql);
    expect(r.reason).toMatch(/unanswered/);
  });
});

describe("T16 the deadline comes from the rules module", () => {
  test("week 12 against a week 11 deadline sends nothing", async () => {
    const io = proposerIo({ nflState: async () => ({ week: 12 }) });
    const r = await runProposer({ db: db(), now: NOW, intents: new IntentStore(intentPath()), io, dry: true }, gql);
    expect(r.reason).toMatch(/deadline/);
    expect(r.sent).toBeNull();
  });
  test("a league with no deadline set never blocks", async () => {
    const io = proposerIo({ nflState: async () => ({ week: 12 }), league: async () => ({ settings: {} as never }) });
    const r = await runProposer({ db: db(), now: NOW, intents: new IntentStore(intentPath()), io, dry: true }, gql);
    expect(r.reason).not.toMatch(/deadline/);
  });
});
// #endregion
