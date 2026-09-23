// Pins for the 2026-09-23 trade audit (T3, T4, T6, T9, T10, T13, T14) that
// only need exports which already existed, so the file was run against the
// unmodified code first. Before the fixes: 3 pass, 11 fail (see the commit).
import { describe, expect, test } from "bun:test";
import { bestLineup, evaluateTrade, type TradePlayer } from "./trade.ts";
import { evaluateTradeTwoSided, refusedForInjury, proposeTrades, DEFAULT_FAIRNESS, type FairnessConfig } from "./trade-fair.ts";
import { tradeRostersFrom, offerFromTransaction, type LeagueSnapshot } from "./trade-wire.ts";
import { assessVeto, DEFAULT_VETO } from "../league/veto.ts";
import type { Roster } from "../sleeper/types.ts";

const P = (name: string, position: string, points: number, x: Partial<TradePlayer> = {}): TradePlayer => ({ name, position, points, ...x });

// Sixteen active players, the real shape (RB-heavy, seven WR, one TE, two QB).
const ours: TradePlayer[] = [
  P("McCaffrey", "RB", 291, { playerId: "1", bye: 8 }), P("Chase Brown", "RB", 255, { playerId: "2", bye: 6 }),
  P("Kenneth Walker", "RB", 244, { playerId: "3", bye: 5 }), P("Travis Etienne", "RB", 208, { playerId: "4", bye: 8 }),
  P("Nico Collins", "WR", 262, { playerId: "5", bye: 8 }), P("DeVonta Smith", "WR", 229, { playerId: "6", bye: 10 }),
  P("Mike Evans", "WR", 222, { playerId: "7", bye: 8 }), P("Parker Washington", "WR", 212, { playerId: "8", bye: 7 }),
  P("Jayden Reed", "WR", 198, { playerId: "9", bye: 11 }), P("DK Metcalf", "WR", 183, { playerId: "10", bye: 9 }),
  P("Josh Downs", "WR", 172, { playerId: "11", bye: 6 }), P("Sam LaPorta", "TE", 197, { playerId: "12", bye: 6 }),
  P("Jalen Hurts", "QB", 311, { playerId: "13", bye: 10 }), P("Dak Prescott", "QB", 250, { playerId: "14", bye: 10 }),
  P("Jake Bates", "K", 130, { playerId: "15", bye: 6 }), P("Seattle", "DEF", 113, { playerId: "SEA", bye: 11 }),
];
const theirs: TradePlayer[] = [
  P("Rival QB", "QB", 300, { playerId: "r1", bye: 7 }), P("Rival RB1", "RB", 200, { playerId: "r2", bye: 7 }),
  P("Rival RB2", "RB", 150, { playerId: "r3", bye: 9 }), P("Trey McBride", "TE", 235, { playerId: "r4", bye: 11 }),
  P("Rival TE2", "TE", 120, { playerId: "r5", bye: 5 }), P("Rival WR1", "WR", 240, { playerId: "r6", bye: 5 }),
  P("Rival WR2", "WR", 210, { playerId: "r7", bye: 9 }), P("Rival WR3", "WR", 190, { playerId: "r8", bye: 6 }),
  P("Rival K", "K", 125, { playerId: "r9", bye: 8 }), P("Rival DEF", "DEF", 100, { playerId: "r10", bye: 6 }),
];
const weeks = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const cfg = (x: Partial<FairnessConfig> = {}): FairnessConfig => ({ ...DEFAULT_FAIRNESS, remainingWeeks: 12, upcomingWeeks: weeks, ...x });

describe("T3 a REST-shaped roster is an error, not a degrade", () => {
  test("tradeRostersFrom throws when a roster with players has no player_map", () => {
    const rest: Roster = { roster_id: 2, owner_id: "u", players: ["a", "b"], starters: null, reserve: null, keepers: null, settings: {} as Roster["settings"] };
    expect(() => tradeRostersFrom([rest], new Map())).toThrow(/player_map/);
  });
  test("an empty orphan roster (staging) is fine", () => {
    const empty: Roster = { roster_id: 2, owner_id: null, players: [], starters: null, reserve: null, keepers: null, settings: {} as Roster["settings"] };
    expect(tradeRostersFrom([empty], new Map()).get(2)).toEqual([]);
  });
});

describe("T4 a received player carries the rival's onIr, and IR on the receive side is refused", () => {
  const snap: LeagueSnapshot = {
    playerById: new Map([...ours, ...theirs].map((p) => [p.playerId!, p])),
    rosterOf: new Map([[3, ours], [2, theirs.map((p) => (p.playerId === "r6" ? { ...p, onIr: true } : p))]]),
    ourRosterId: 3, idByName: new Map(), ownerIdOf: new Map(), week: 4, capacity: 16,
  };
  const tx = { adds: { r6: 3, "11": 2 }, drops: { r6: 2, "11": 3 }, roster_ids: [3, 2] };
  test("sideOf reads the receive side from the rival's roster entry", () => {
    const { offer } = offerFromTransaction(tx, snap);
    expect(offer.receive[0]?.onIr).toBe(true);
    expect(offer.give[0]?.playerId).toBe("11");
  });
  test("refusedForInjury refuses onIr even with no injury string", () => {
    expect(refusedForInjury(P("x", "WR", 240, { onIr: true }))).toMatch(/injured reserve/i);
  });
  test("the evaluation blocks it", () => {
    const { offer } = offerFromTransaction(tx, snap);
    const ev = evaluateTradeTwoSided(offer, ours, snap.rosterOf.get(2)!, cfg());
    expect(ev.verdict).toBe("reject");
    expect(ev.fairnessBlocks.join(" ")).toMatch(/injured reserve/i);
  });
});

describe("T6 lineup totals exclude IR; the give-away rail stays", () => {
  test("bestLineup never starts an onIr player", () => {
    const r = [P("Hurt QB", "QB", 300, { onIr: true }), P("Healthy QB", "QB", 200)];
    const l = bestLineup(r);
    expect(l.starters.find((s) => s.slot === "QB")?.player?.name).toBe("Healthy QB");
    expect(l.total).toBe(200 + 38 + 30);
  });
  test("giving away an IR player is still a rail block", () => {
    const roster = ours.map((p) => (p.playerId === "5" ? { ...p, onIr: true } : p));
    const ev = evaluateTrade({ give: [roster[4]!], receive: [P("Rival WR3", "WR", 190, { playerId: "r8" })] }, roster);
    expect(ev.verdict).toBe("reject");
    expect(ev.railBlocks.join(" ")).toMatch(/injured reserve/i);
  });
});

describe("T9 the roster after the trade must be legal", () => {
  test("a 2-for-1 that puts us over the cap is rejected as illegal", () => {
    const ev = evaluateTradeTwoSided(
      { receive: [P("Trey McBride", "TE", 235, { playerId: "r4", bye: 11 }), P("Rival RB1", "RB", 200, { playerId: "r2", bye: 7 })], give: [P("Josh Downs", "WR", 172, { playerId: "11", bye: 6 })] },
      ours, theirs, cfg({ rosterCapacity: 16 }),
    );
    expect(ev.verdict).toBe("reject");
    expect(ev.fairnessBlocks.join(" ")).toMatch(/roster would be illegal/);
  });
  test("the same trade with room is not blocked for legality", () => {
    const ev = evaluateTradeTwoSided(
      { receive: [P("Trey McBride", "TE", 235, { playerId: "r4", bye: 11 }), P("Rival RB1", "RB", 200, { playerId: "r2", bye: 7 })], give: [P("Josh Downs", "WR", 172, { playerId: "11", bye: 6 })] },
      ours, theirs, cfg({ rosterCapacity: 17 }),
    );
    expect(ev.fairnessBlocks.join(" ")).not.toMatch(/illegal/);
  });
});

describe("T10 everything keys on playerId", () => {
  const twins = [
    ...ours.filter((p) => p.position !== "QB"),
    P("Josh Allen", "QB", 311, { playerId: "qb" }),
    P("Josh Allen", "WR", 5, { playerId: "wr" }),
  ];
  test("giving away the namesake WR does not also remove the QB from the lineup", () => {
    const ev = evaluateTrade({ give: [P("Josh Allen", "WR", 5, { playerId: "wr" })], receive: [P("Rival WR3", "WR", 190, { playerId: "r8" })] }, twins);
    expect(ev.after).toBeGreaterThanOrEqual(ev.before);
  });
  test("veto side gain removes by id, not name", () => {
    const rosterOf = new Map([[2, twins], [4, theirs]]);
    const playerOf = (id: string) => [...twins, ...theirs].find((p) => p.playerId === id) ?? P(id, "", 0);
    const a = assessVeto({ transactionId: "t", rosterIds: [2, 4], adds: { wr: 4, r8: 2 }, drops: { wr: 2, r8: 4 } }, rosterOf, playerOf, DEFAULT_VETO);
    expect(a.gain[2]).toBeGreaterThanOrEqual(0);
  });
});

describe("T13 the proposer objective", () => {
  const props = proposeTrades(ours, [{ managerId: "2", teamName: "r", roster: theirs }], cfg(), 10);
  test("no proposal takes more than twice what it gives", () => {
    for (const p of props) expect(p.ourGain / Math.max(p.theirGain, 0.1)).toBeLessThanOrEqual(2);
  });
  test("candidates are ranked by the smaller side's gain, package size aside", () => {
    for (let i = 1; i < props.length; i++) {
      const a = props[i - 1]!, b = props[i]!;
      expect(a.score).toBeGreaterThanOrEqual(b.score);
      expect(Math.abs(a.score - Math.min(a.ourGain, a.theirGain) - a.byeRelief * DEFAULT_FAIRNESS.byeReliefPts + (a.offer.give.length + a.offer.receive.length) * 0.5)).toBeLessThan(0.11);
      void b;
    }
    expect(props.length).toBeGreaterThan(0);
  });
});

describe("T14 units are season points", () => {
  test("the bye-aware reason never says per week", () => {
    const ev = evaluateTradeTwoSided({ receive: [P("Trey McBride", "TE", 235, { playerId: "r4", bye: 11 })], give: [P("Mike Evans", "WR", 222, { playerId: "7", bye: 8 })] }, ours, theirs, cfg());
    const text = ev.reasons.join("\n");
    expect(text).not.toMatch(/per week/);
    expect(text).toMatch(/season points/);
  });
});
