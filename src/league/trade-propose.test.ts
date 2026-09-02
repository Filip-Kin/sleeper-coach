import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { pairKey, onCooldown, pitchText, MAX_OPEN_OFFERS, REPROPOSE_COOLDOWN_DAYS } from "./trade-propose.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE trade_proposals (pair_key TEXT NOT NULL, manager_id TEXT NOT NULL,
    transaction_id TEXT, at INTEGER NOT NULL, why TEXT)`);
  return d;
}

test("a pair key ignores the order players are listed in", () => {
  // Otherwise the same swap re-sends because the arrays came back sorted
  // differently, which is exactly how a bot starts nagging someone.
  expect(pairKey("2", ["A", "B"], ["C"])).toBe(pairKey("2", ["B", "A"], ["C"]));
});

test("a pair key is per manager, so the same swap can go to someone else", () => {
  expect(pairKey("2", ["A"], ["B"])).not.toBe(pairKey("4", ["A"], ["B"]));
});

test("a recently offered pair is on cooldown", () => {
  const d = db();
  const now = 1_700_000_000_000;
  const key = pairKey("2", ["A"], ["B"]);
  d.run("INSERT INTO trade_proposals (pair_key, manager_id, at) VALUES (?, ?, ?)", [key, "2", now - 86_400_000]);
  expect(onCooldown(d, key, now)).toBe(true);
});

test("cooldown expires, so a fair offer can come back later in the season", () => {
  const d = db();
  const now = 1_700_000_000_000;
  const key = pairKey("2", ["A"], ["B"]);
  d.run("INSERT INTO trade_proposals (pair_key, manager_id, at) VALUES (?, ?, ?)",
    [key, "2", now - (REPROPOSE_COOLDOWN_DAYS + 1) * 86_400_000]);
  expect(onCooldown(d, key, now)).toBe(false);
});

test("an unseen pair is never on cooldown", () => {
  expect(onCooldown(db(), pairKey("2", ["A"], ["B"]), 1_700_000_000_000)).toBe(false);
});

test("the outstanding-offer cap is small enough not to look like spam", () => {
  expect(MAX_OPEN_OFFERS).toBeLessThanOrEqual(2);
});

test("the pitch leads with THEIR gain, which is the reason to say yes", () => {
  const p = {
    managerId: "2", teamName: "roster 2",
    offer: { receive: [{ name: "Bijan Robinson", position: "RB", points: 0 }], give: [{ name: "Rome Odunze", position: "WR", points: 0 }] },
    ourGain: 8.2, theirGain: 5.4, edge: 0, byeRelief: 0, score: 8.2, why: "",
  };
  const t = pitchText(p as never);
  expect(t).toContain("+5.4 to your starting lineup");
  expect(t).toContain("Rome Odunze");
  expect(t).toContain("Bijan Robinson");
  expect(t).toContain("No hard feelings");
});

test("the brief renders our outbound offers so the coach cannot deny one", async () => {
  const { briefText } = await import("./trade-propose.ts");
  const text = briefText({
    surplus: [], thin: [], askFor: [], deals: [], lastOffer: null,
    pendingFromUs: [{ give: ["Parker Washington"], get: ["Mark Andrews"] }],
  });
  expect(text).toContain("I give Parker Washington, I get Mark Andrews");
  expect(text).toContain("Never deny an offer you have made");
});

// --- counters -----------------------------------------------------------------
import { pickCounter, recordProposal } from "./trade-propose.ts";
import { evaluateTradeTwoSided, DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { asksForCounter } from "./dm-watch.ts";
import { tradeReplyText } from "./trade-watch.ts";

const PP = (name: string, position: string, points: number, depth = 1) => ({ name, position, points, depthChartOrder: depth });
// WR-rich with a hole at RB2; they are RB-rich and WR-poor. A 2-for-1 exists.
const OURS = [PP("QB1","QB",300), PP("RB1","RB",280), PP("RBbad","RB",60,3), PP("WRa","WR",250), PP("WRb","WR",245), PP("WRc","WR",240),
  PP("WRd","WR",235), PP("WRe","WR",230), PP("TE1","TE",190), PP("K1","K",44), PP("DEF1","DEF",10)];
const THEIRS = [PP("tQB","QB",290), PP("tRB1","RB",270), PP("tRB2","RB",265), PP("tRB3","RB",260), PP("tRB4","RB",200), PP("tWRa","WR",90), PP("tWRb","WR",80), PP("tWRc","WR",70),
  PP("tTE","TE",185), PP("tK","K",42), PP("tDEF","DEF",8)];
const RIVAL = { managerId: "2", teamName: "them", roster: THEIRS };

test("THE INVARIANT: any counter it picks would be accepted if it came straight back", () => {
  const c = pickCounter(OURS as never, RIVAL as never, DEFAULT_FAIRNESS, db(), 1_700_000_000_000);
  expect(c).not.toBeNull();
  const back = evaluateTradeTwoSided(c!.offer, OURS as never, THEIRS as never, DEFAULT_FAIRNESS);
  expect(back.verdict).toBe("accept");
  expect(c!.theirGain).toBeGreaterThan(0);
});

test("no counter when nothing clears the bar", () => {
  // Their roster is all junk; nothing we could receive helps us.
  const junk = { managerId: "2", teamName: "them", roster: THEIRS.map((p) => ({ ...p, points: 5 })) };
  expect(pickCounter(OURS as never, junk as never, DEFAULT_FAIRNESS, db(), 1)).toBeNull();
});

test("a counter already offered recently is skipped", () => {
  const d = db();
  const now = 1_700_000_000_000;
  const first = pickCounter(OURS as never, RIVAL as never, DEFAULT_FAIRNESS, d, now)!;
  recordProposal(d, first, "tx1", now);
  const second = pickCounter(OURS as never, RIVAL as never, DEFAULT_FAIRNESS, d, now);
  const key = (p: typeof first) => [p.offer.receive.map((x) => x.name).sort().join("+"), p.offer.give.map((x) => x.name).sort().join("+")].join("|");
  expect(second === null || key(second) !== key(first)).toBe(true);
});

test("asking for a counter is detected, ordinary chat is not", () => {
  for (const yes of ["can you counter?", "what would you give for Rice", "send me an offer", "make me an offer then", "what do you want for Evans", "counter offer?"]) {
    expect(asksForCounter(yes)).toBe(true);
  }
  for (const no of ["good luck this week", "lol", "these are both bench players", "why did you reject that"]) {
    expect(asksForCounter(no)).toBe(false);
  }
});

test("a rejection that carries a counter names it and their gain", () => {
  const c = pickCounter(OURS as never, RIVAL as never, DEFAULT_FAIRNESS, db(), 1)!;
  const ev = { verdict: "reject", ourGain: -3, theirGain: 4, netValue: -4, requiredEdge: 3, railBlocks: [], fairnessBlocks: [], reasons: [], lineupDelta: -3, before: 0, after: 0, edge: 0 } as never;
  const t = tradeReplyText(ev, { receive: ["X"], give: ["Y"] }, c);
  expect(t).toContain("Instead, I have sent you one");
  expect(t).toContain(`+${c.theirGain} to your team`);
});

// --- sharper tone for a blatant lowball --------------------------------------
import { isBlatantLowball, BLATANT_OUR_GAIN_PTS } from "./trade-watch.ts";

const evLike = (over: Record<string, unknown> = {}) => ({
  verdict: "reject", ourGain: -3, theirGain: 4, netValue: -4, requiredEdge: 3,
  railBlocks: [], fairnessBlocks: [], reasons: [], lineupDelta: -3, before: 0, after: 0, edge: 0, ...over,
}) as never;

test("our starting QB for literally nothing is called out, not just declined", () => {
  const ev = evLike({ ourGain: -48.3, theirGain: 10.4 });
  expect(isBlatantLowball({ receive: [], give: ["Jalen Hurts"] }, ev)).toBe(true);
  const t = tradeReplyText(ev, { receive: [], give: ["Jalen Hurts"] });
  expect(t).toContain("Hahaha");
  expect(t).toContain("-48.3"); // still transparent: the real numbers follow
});

test("a real but marginal refusal keeps the plain, non-mocking tone", () => {
  // The Tate-for-Washington shape: we DO get something back, and the miss is
  // small. Sarcasm here would be wrong, since it is a genuine close call.
  const ev = evLike({ ourGain: -3.3, theirGain: 4.2 });
  expect(isBlatantLowball({ receive: ["Carnell Tate"], give: ["Parker Washington"] }, ev)).toBe(false);
  expect(tradeReplyText(ev, { receive: ["Carnell Tate"], give: ["Parker Washington"] })).not.toContain("Hahaha");
});

test("a huge negative even with something nominal returned still reads as a fleece", () => {
  const ev = evLike({ ourGain: BLATANT_OUR_GAIN_PTS - 1, theirGain: 90 });
  expect(isBlatantLowball({ receive: ["a 2029 7th"], give: ["Christian McCaffrey"] }, ev)).toBe(true);
});

test("an accepted trade is never treated as a lowball, whatever the numbers", () => {
  const ev = evLike({ verdict: "accept", ourGain: -48.3 });
  expect(isBlatantLowball({ receive: [], give: ["X"] }, ev)).toBe(false);
});
