import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { config } from "../config.ts";
import { ACTIVITY_LOG } from "../paths.ts";
import { recentEvents } from "../log.ts";
import { parsePick, shortlist, pickBrief, pickOne, PICK_MAX, type PickCandidate } from "./trade-pick.ts";
import { runProposer, ensureTable, type ProposerIo } from "./trade-propose.ts";
import { IntentStore } from "../analysis/trade-intent.ts";
import type { LeagueSnapshot } from "../analysis/trade-wire.ts";
import type { Proposal } from "../analysis/trade-fair.ts";
import type { TradePlayer } from "../analysis/trade.ts";
import type { Gql } from "./api.ts";

const P = (name: string, position: string, points: number, x: Partial<TradePlayer> = {}): TradePlayer => ({ name, position, points, playerId: name, ...x });
const ours: TradePlayer[] = [
  P("QB1", "QB", 300), P("QB2", "QB", 290), P("RB1", "RB", 280), P("RB2", "RB", 200), P("WRa", "WR", 250), P("WRb", "WR", 245), P("WRc", "WR", 240),
  P("WRd", "WR", 235), P("WRe", "WR", 230), P("TE1", "TE", 190), P("K1", "K", 44), P("DEF1", "DEF", 10),
];
const prop = (managerId: string, give: TradePlayer[], receive: TradePlayer[], score: number): Proposal => ({
  managerId, teamName: `roster ${managerId}`, offer: { give, receive }, ourGain: 5, theirGain: 4, edge: 0, byeRelief: 0, score,
  why: `get ${receive.map((p) => p.name).join("+")} for ${give.map((p) => p.name).join("+")}`, theirReason: "",
});

describe("parsePick is strict", () => {
  test("a clean answer", () => {
    expect(parsePick('{"pick": 2, "why": "adds two starters"}', 3)).toEqual({ index: 1, why: "adds two starters" });
  });
  test("zero means none", () => {
    expect(parsePick('{"pick": 0, "why": "nothing clearly good"}', 3)).toEqual({ index: null, why: "nothing clearly good" });
  });
  test("prose around the JSON is tolerated, prose instead of it is not", () => {
    expect(parsePick('Sure. {"pick": 1, "why": "x"} Done.', 3)?.index).toBe(0);
    expect(parsePick("I would send the first one.", 3)).toBeNull();
  });
  test("out of range, non-integer, wrong type are refused", () => {
    expect(parsePick('{"pick": 4}', 3)).toBeNull();
    expect(parsePick('{"pick": 1.5}', 3)).toBeNull();
    expect(parsePick('{"pick": "1"}', 3)).toBeNull();
    expect(parsePick('{"pick": -1}', 3)).toBeNull();
  });
});

describe("shortlist is one per rival with a manager's numbers", () => {
  test("keeps the first candidate per rival, caps at PICK_MAX, and computes lineup and raw deltas", () => {
    const upgrade = prop("2", [P("QB2", "QB", 290)], [P("RBx", "RB", 260)], 9);
    const dupe = prop("2", [P("WRe", "WR", 230)], [P("RBy", "RB", 100)], 8);
    const others = ["3", "4", "5", "6"].map((m) => prop(m, [P("WRe", "WR", 230)], [P(`RB${m}`, "RB", 100)], 1));
    const s = shortlist(ours, [upgrade, dupe, ...others], () => 2);
    expect(s.length).toBe(PICK_MAX);
    expect(s.map((c) => c.proposal.managerId)).toEqual(["2", "3", "4", "5"]);
    const u = s[0]!;
    expect(u.lineupAfter - u.lineupBefore).toBe(60); // RBx 260 replaces RB2 200 at FLEX
    expect(u.rawDelta).toBe(-30); // 260 in, 290 out
    expect(u.startersAfter).toContain("RBx");
    expect(u.headToHeadRemaining).toBe(2);
  });
  test("the brief shows the bench cost the engine ignores", () => {
    const s = shortlist(ours, [prop("2", [P("QB2", "QB", 290)], [P("RBx", "RB", 260)], 9)], () => 2);
    const b = pickBrief(s, ours);
    expect(b).toContain("Our best lineup: 1994 -> 2054");
    expect(b).toContain("-30 for us");
    expect(b).toContain("* QB1");
    expect(b).toContain("  QB2"); // not a starter
  });
});

describe("pickOne fails closed", () => {
  const cands: PickCandidate[] = shortlist(ours, [prop("2", [P("QB2", "QB", 290)], [P("RBx", "RB", 260)], 9)], () => 2);
  test("a model error sends nothing", async () => {
    const r = await pickOne(cands, ours, async () => ({ sessionId: "s", text: "", exitCode: 1, error: "usage limit" }));
    expect(r.chosen).toBeNull();
    expect(r.error).toBe("usage limit");
  });
  test("an unparseable answer sends nothing", async () => {
    const r = await pickOne(cands, ours, async () => ({ sessionId: "s", text: "Send the first one, it is great.", exitCode: 0 }));
    expect(r.chosen).toBeNull();
    expect(r.error).toMatch(/unparsed/);
  });
  test("a clean pick returns that candidate, and the run is tool-free and untrusted", async () => {
    let seen: Record<string, unknown> = {};
    const r = await pickOne(cands, ours, async (o) => { seen = o as never; return { sessionId: "s", text: '{"pick": 1, "why": "starts for us"}', exitCode: 0 }; });
    expect(r.chosen).toBe(cands[0]!);
    expect(r.why).toBe("starts for us");
    expect(seen.untrusted).toBe(true);
    expect(seen.tools).toEqual([]);
  });
});

describe("the proposer sends only what the pick step chose", () => {
  const US = config.rosterId;
  const rivalRoster = (n: string): TradePlayer[] => [
    P(`${n}QB`, "QB", 200), P(`${n}RB1`, "RB", 270), P(`${n}RB2`, "RB", 265), P(`${n}RB3`, "RB", 210), P(`${n}RB4`, "RB", 205),
    P(`${n}WRa`, "WR", 150), P(`${n}WRb`, "WR", 140), P(`${n}TE`, "TE", 185), P(`${n}K`, "K", 42), P(`${n}DEF`, "DEF", 8),
  ];
  const snap = (): LeagueSnapshot => {
    const rosterOf = new Map<number, TradePlayer[]>([[US, ours], [2, rivalRoster("a")], [3, rivalRoster("b")]]);
    return { playerById: new Map([...rosterOf.values()].flat().map((p) => [p.playerId!, p])), rosterOf, ourRosterId: US, idByName: new Map(), ownerIdOf: new Map(), week: 4, capacity: 16 };
  };
  const weeks = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const gql: Gql = async () => ({});
  const NOW = 1_700_000_000_000;
  const gate = { minAgeMs: 1000, maxAgeMs: 60_000 };
  const intentPath = () => `/tmp/sleeper-coach-test/pick-intents-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  function io(over: Partial<ProposerIo>): Partial<ProposerIo> {
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
  const db = () => { const d = new Database(":memory:"); ensureTable(d); return d; };

  test("the model sees one candidate per rival and its choice is the one sent", async () => {
    rmSync(ACTIVITY_LOG, { force: true });
    let shown: PickCandidate[] = [];
    let sentTo: number[] = [];
    const deps = io({
      pick: async (cands) => { shown = cands; return { chosen: cands[cands.length - 1]!, why: "the last one starts for us" }; },
      proposeTrade: async (_g, spec) => { sentTo = [...new Set(Object.values(spec.adds))]; return { transactionId: "s", status: "proposed" }; },
    });
    const d = db(); const intents = new IntentStore(intentPath());
    await runProposer({ db: d, now: NOW, intents, io: deps, gate }, gql);
    const r = await runProposer({ db: d, now: NOW + 2000, intents, io: deps, gate }, gql);
    expect(shown.length).toBe(2);
    expect(new Set(shown.map((c) => c.proposal.managerId)).size).toBe(2);
    expect(r.outcome).toBe("sent");
    expect(r.sent?.managerId).toBe(shown[1]!.proposal.managerId);
    expect(sentTo).toContain(Number(shown[1]!.proposal.managerId));
    expect(recentEvents(50).some((e) => e.type === "trade-pick")).toBe(true);
  });
  test("none chosen means nothing sent, no intent, no cooldown row", async () => {
    rmSync(ACTIVITY_LOG, { force: true });
    let sends = 0;
    const deps = io({ pick: async () => ({ chosen: null, why: "nothing clearly good" }), proposeTrade: async () => { sends++; return { transactionId: "s", status: "proposed" }; } });
    const d = db(); const intents = new IntentStore(intentPath());
    const r = await runProposer({ db: d, now: NOW, intents, io: deps, gate }, gql);
    expect(r.outcome).toBe("nothing");
    expect(r.reason).toContain("chose none");
    expect(sends).toBe(0);
    expect(intents.all()).toEqual([]);
    expect(d.query<{ n: number }, []>("SELECT count(*) AS n FROM trade_proposals").get()?.n).toBe(0);
    expect(recentEvents(50).some((e) => e.type === "trade-pick-none")).toBe(true);
  });
  test("a model failure is logged and sends nothing", async () => {
    rmSync(ACTIVITY_LOG, { force: true });
    const deps = io({ pick: async () => ({ chosen: null, why: "model run failed; nothing sent", error: "usage limit" }) });
    const r = await runProposer({ db: db(), now: NOW, intents: new IntentStore(intentPath()), io: deps, gate }, gql);
    expect(r.outcome).toBe("nothing");
    expect(recentEvents(50).some((e) => e.type === "trade-pick-failed")).toBe(true);
  });
});
