import { test, expect } from "bun:test";
import { renderRosters, renderFinishOrder, tradeBriefFromSnapshot, briefText, counterpartOpener } from "./dm-brief.ts";
import type { LeagueSnapshot } from "../analysis/trade-wire.ts";
import type { TradePlayer } from "../analysis/trade.ts";

const PP = (playerId: string, name: string, position: string, points: number, over: Partial<TradePlayer> = {}): TradePlayer =>
  ({ playerId, name, position, points, depthChartOrder: 1, ...over });

// Our roster AS IT WILL BE once the in-flight trade processes: Incoming Guy is
// ours, Outgoing Guy is gone. Every block must agree on that one roster.
const OURS: TradePlayer[] = [
  PP("q1", "Our QB", "QB", 300), PP("r1", "Our RB1", "RB", 280), PP("r2", "Incoming Guy", "RB", 200), PP("r3", "Our RB3", "RB", 60, { depthChartOrder: 3 }),
  PP("w1", "Our WRa", "WR", 250), PP("w2", "Our WRb", "WR", 245), PP("w3", "Our WRc", "WR", 240), PP("w4", "Our WRd", "WR", 235), PP("w5", "Our WRe", "WR", 230),
  PP("t1", "Our TE", "TE", 190), PP("k1", "Our K", "K", 44), PP("d1", "DAL", "DEF", 10), PP("i1", "Hurt Guy", "WR", 131, { onIr: true }),
];
const THEIRS: TradePlayer[] = [
  PP("tq", "Their QB", "QB", 290), PP("tr1", "Their RB1", "RB", 270), PP("tr2", "Their RB2", "RB", 265), PP("tr3", "Their RB3", "RB", 260), PP("tr4", "Their RB4", "RB", 200),
  PP("tw1", "Their WRa", "WR", 90), PP("tw2", "Their WRb", "WR", 80), PP("tw3", "Their WRc", "WR", 70), PP("tt", "Their TE", "TE", 185), PP("tk", "Their K", "K", 42), PP("td", "SF", "DEF", 8),
];
const OTHER: TradePlayer[] = [PP("oq", "Other QB", "QB", 200), PP("or", "Other RB", "RB", 100), PP("ow", "Other WR", "WR", 100), PP("ot", "Other TE", "TE", 50)];

function snap(): LeagueSnapshot {
  const rosterOf = new Map<number, TradePlayer[]>([[1, THEIRS], [3, OURS], [5, OTHER]]);
  const playerById = new Map<string, TradePlayer>();
  const idByName = new Map<string, string>();
  for (const ps of rosterOf.values()) for (const p of ps) { playerById.set(p.playerId!, p); idByName.set(p.name, p.playerId!); }
  return { playerById, rosterOf, ourRosterId: 3, idByName, ownerIdOf: new Map([[1, "u1"], [3, "u3"], [5, "u5"]]), week: 3, capacity: 16 };
}
const NAMES = new Map([["u1", "Cloud Nine"], ["u3", "Filip96"], ["u5", "Third Wheel"]]);

test("exactly one roster block is tagged as the counterpart and one as mine", () => {
  const text = renderRosters(snap(), NAMES, 1);
  expect(text.split("(THE MANAGER YOU ARE TALKING TO)").length - 1).toBe(1);
  expect(text.split("(MINE)").length - 1).toBe(1);
  expect(text).toContain("Cloud Nine (THE MANAGER YOU ARE TALKING TO)");
  expect(text).toContain("Filip96 (MINE)");
  expect(text).toContain("Third Wheel:");
});

test("with no counterpart nothing is tagged as one", () => {
  expect(renderRosters(snap(), NAMES, null)).not.toContain("THE MANAGER YOU ARE TALKING TO");
});

test("every block reads our roster from the same snapshot, delta in flight included", () => {
  const s = snap();
  const rosters = renderRosters(s, NAMES, 1);
  const mine = rosters.split("\n\n").find((b) => b.includes("(MINE)"))!;
  expect(mine).toContain("Incoming Guy");
  expect(mine).not.toContain("Outgoing Guy");
  expect(mine).toContain("on injured reserve");
  expect(mine).toContain("Hurt Guy");

  const finish = renderFinishOrder(s, NAMES, new Map(), 3);
  expect(finish.split("(you, CoachClaude)").length - 1).toBe(1);
  expect(finish.split("\n").length).toBe(3);

  const brief = tradeBriefFromSnapshot(s, 1, { offers: [], sched: {}, lastOfferEvent: undefined });
  const ourNames = new Set(OURS.map((p) => p.name));
  for (const p of brief.surplus) expect(ourNames.has(p.name)).toBe(true);
  expect(brief.surplus.map((p) => p.name)).not.toContain("Hurt Guy");
  for (const d of brief.deals) for (const g of d.give) expect(ourNames.has(g.replace(/ \([A-Z]+\)$/, ""))).toBe(true);
});

test("pending offers are read from the transaction against the same snapshot", () => {
  const s = snap();
  const brief = tradeBriefFromSnapshot(s, 1, {
    offers: [{ transactionId: "t", status: "proposed", type: "trade", rosterIds: [1, 3], consenterIds: [3], created: 0,
      adds: { w5: 1, tr4: 3 }, drops: { w5: 3, tr4: 1 } }],
    sched: {}, lastOfferEvent: undefined,
  });
  expect(brief.pendingFromUs).toEqual([{ give: ["Our WRe"], get: ["Their RB4"] }]);
});

test("the brief is in the second person and labels season points, never per week", () => {
  const text = briefText({
    surplus: [{ name: "Our WRe", position: "WR" }], thin: ["TE"], askFor: [{ name: "Their RB4", position: "RB" }],
    deals: [{ give: ["Our WRe (WR)"], get: ["Their RB4 (RB)"], theirGain: 4.1 }],
    lastOffer: { give: ["Our QB"], get: ["Their RB1"], ourGain: -12.5, theirGain: 40.2, verdict: "reject", why: "our lineup -12.5 per week averaged over that run" },
    pendingFromUs: [{ give: ["Our WRe"], get: ["Their RB4"] }],
  });
  expect(text).not.toMatch(/per week/i);
  expect(text).toContain("season points");
  expect(text).toContain("You would trade away");
  expect(text).toContain("You have sent");
  expect(text).toContain("you give Our WRe, you get Their RB4");
  expect(text).toContain("-12.5 season points");
  expect(text).not.toMatch(/\bI (give|get|have|am|would|accept|do not)\b/);
  expect(text).toContain("Never deny an offer you have made");
});

test("the opener names the counterpart, their team and their roster number", () => {
  expect(counterpartOpener({ rosterId: 1, displayName: "cookieeater45", teamName: "Cloud Nine" }))
    .toBe("You are talking to cookieeater45, who manages Cloud Nine (roster 1).");
  expect(counterpartOpener(null)).toContain("not in this league");
});
