// A waiver claim may go through an open IR slot, and then the stash is part
// of the move.
//
// 2026-10-02 review. Both claims of 09-30 processed overnight, so Travis
// Etienne (NFL injured reserve, out at least four games) sits on the active
// bench with two IR slots empty. On that roster the planner answered an
// on-waivers player in two wrong ways:
//
// 1. A starter worth a claim came back "waiver-claim, ir-stash, no drop",
//    and the executor filed the claim with no drop and never moved Etienne:
//    a claim into a full roster, lost when waivers process. (The executor
//    half is pinned in src/act/claim-exec.test.ts.)
//
// 2. A bench upgrade of claim size (2.0 a week) came back "wait": the stash
//    path wins ties, names no drop, and the bench-claim test demands one.
//    With the IR slots full the same player was claimed. An open IR slot made
//    the coach able to do less. The first fix let the bench claim go through
//    the stash; the reviewer replayed Etienne's return and the cut was Mark
//    Andrews, not the body the newcomer was measured against (team +1.2,
//    against +12.5 for the direct swap). So a bench upgrade is a swap with
//    the man he beats, IR slot or not, and the stash is for an add the
//    lineup justifies.
//
// Roster: the captured league of 09-30 with both claims processed
// (incidents/league.ts), Etienne on NFL IR, Rico Dowdle Out.
import { describe, expect, test } from "bun:test";
import { planOne, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { chooseForcedDrops } from "./roster-fit.ts";
import type { RailPlayer } from "./rails.ts";
import { LEAGUE, OURS, fx, idOf, tradePlayer } from "./incidents/league.ts";

const swapIn: Record<string, string> = { [idOf("Tyjae Spears")]: idOf("Travis Etienne"), [idOf("Kenny Gainwell")]: idOf("Jacory Croskey-Merritt") };
const STATUS: Record<string, string> = { "Travis Etienne": "IR", "Rico Dowdle": "Out" };
const mine = LEAGUE.rosters.find((r) => r.rosterId === OURS)!;
const roster: RailPlayer[] = mine.players.map((id) => {
  const p = tradePlayer(swapIn[id] ?? id, { onIr: false });
  const status = STATUS[p.name];
  return status ? { ...p, injuryStatus: status, returnsBeforePlayoffs: true } : p;
});
const starters = mine.starters.map((id) => fx(id).name);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN");
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const onWaivers = (name: string, points: number): AvailablePlayer => ({ ...tradePlayer(idOf(name)), points, onWaivers: true });
const irOpen: RosterState = { roster, openBenchSlots: 0, openIrSlots: 2, startingSlots: SLOTS, irEligible, currentStarters: starters, weeksLeft: 14 };
const irFull: RosterState = { ...irOpen, openIrSlots: 0 };

describe("a claim through an open IR slot", () => {
  test("a starter on waivers is claimed by parking Etienne: nobody is dropped, and the move names the stash", () => {
    const m = planOne(onWaivers("Malik Washington", 260), irOpen, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.dropPath).toBe("ir-stash");
    expect(m.irStash).toBe("Travis Etienne");
    expect(m.drop).toBeNull();
    expect(m.reason).toContain("stash Travis Etienne");
    expect(m.reason.endsWith("— no drop")).toBe(false);
  });
  // 2026-10-06 (Filip: "take advantage of IR"): with the IR slot open the
  // same bench upgrade parks Etienne and drops nobody today. Downs stays as
  // depth; on Etienne's return the activation cuts the lowest value on the
  // roster, Mark Andrews at 119.8, who is the man the roster sheds first
  // whatever this move does (cutFirst). With the IR slots full it is the
  // swap it always was.
  test("a bench upgrade of 2.3 a week: a swap for Downs with IR full, a stash of Etienne with IR open", () => {
    const full = planOne(onWaivers("Malik Washington", 180), irFull, DEFAULT_WAIVERS);
    expect(full.kind).toBe("waiver-claim");
    expect(full.drop).toBe("Josh Downs");
    const open = planOne(onWaivers("Malik Washington", 180), irOpen, DEFAULT_WAIVERS);
    expect(open.kind).toBe("waiver-claim");
    expect(open.dropPath).toBe("ir-stash");
    expect(open.irStash).toBe("Travis Etienne");
    expect(open.drop).toBeNull();
    expect(open.reason).toContain("Mark Andrews goes");
  });
  test("the same for a back: 2.6 a week over Croskey-Merritt", () => {
    const full = planOne(onWaivers("RJ Harvey", 180), irFull, DEFAULT_WAIVERS);
    expect(full.drop).toBe("Jacory Croskey-Merritt");
    const open = planOne(onWaivers("RJ Harvey", 180), irOpen, DEFAULT_WAIVERS);
    expect(open.kind).toBe("waiver-claim");
    expect(open.irStash).toBe("Travis Etienne");
    expect(open.drop).toBeNull();
  });
  test("a free agent bench upgrade goes the same way", () => {
    const m = planOne({ ...onWaivers("Malik Washington", 170), onWaivers: false }, irOpen, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.irStash).toBe("Travis Etienne");
    expect(m.drop).toBeNull();
  });
  test("why: after a stash claim for a starter, Etienne's return cuts the same man the direct claim names", () => {
    const direct = planOne(onWaivers("Malik Washington", 260), irFull, DEFAULT_WAIVERS);
    expect(direct.drop).toBe("Mark Andrews");
    const onReturn = [...roster.map((p) => (p.name === "Travis Etienne" ? { ...p, injuryStatus: undefined, returnsBeforePlayoffs: false } : p)), { ...onWaivers("Malik Washington", 260) }];
    expect(chooseForcedDrops(onReturn, 1, undefined, starters)[0]?.name).toBe("Mark Andrews");
  });
  test("a bench upgrade of 1.6 a week is under the claim bar either way: wait for him to clear", () => {
    expect(planOne(onWaivers("Malik Washington", 170), irOpen, DEFAULT_WAIVERS).kind).toBe("wait");
    expect(planOne(onWaivers("Malik Washington", 170), irFull, DEFAULT_WAIVERS).kind).toBe("wait");
  });
  test("the stash does not lower the bar: nobody on the real wire of that day is claimed", () => {
    for (const p of Object.values(LEAGUE.players)) {
      const takenNow = LEAGUE.rosters.some((r) => r.players.includes(p.playerId)) && !Object.keys(swapIn).includes(p.playerId);
      if (takenNow || Object.values(swapIn).includes(p.playerId)) continue;
      const m = planOne({ ...tradePlayer(p.playerId), onWaivers: true }, irOpen, DEFAULT_WAIVERS);
      expect(`${p.name}: ${m.kind}`).not.toBe(`${p.name}: waiver-claim`);
    }
  });
});

describe("the stash is judged on the season lineup with the stashed man in it", () => {
  // Nico Collins Out and parked: a 165-point receiver starts only while he is
  // hurt. With Collins taken out of the lineup the add read as +16.9 and a
  // claim; with the IR slots full it read as +0 and a wait.
  const collinsOut = roster.map((p) => (p.name === "Nico Collins" ? { ...p, injuryStatus: "Out", returnsBeforePlayoffs: true } : p));
  const st = (ir: number): RosterState => ({ ...irOpen, roster: collinsOut, openIrSlots: ir, currentStarters: starters.filter((n) => n !== "Nico Collins") });
  test("a receiver who would start only in Collins's absence is not claimed by parking Collins", () => {
    const open = planOne(onWaivers("Malik Washington", 165), st(2), DEFAULT_WAIVERS);
    const full = planOne(onWaivers("Malik Washington", 165), st(0), DEFAULT_WAIVERS);
    expect(open.kind).not.toBe("waiver-claim");
    expect(open.kind).toBe(full.kind);
    expect(open.irStash).not.toBe("Nico Collins");
  });
});

describe("an open slot left by a player on IR (2026-10-06: an IR slot is a roster expansion)", () => {
  // Etienne parked, his slot empty (a stash claim that lost). The seat is a
  // seat; his return is priced on the way in: whoever the activation would
  // cut when he comes back must be the newcomer, Etienne himself, or the
  // player the direct path would drop today (waivers.ts returnsAcceptable).
  const active = roster.filter((p) => p.name !== "Travis Etienne");
  const etienne = roster.find((p) => p.name === "Travis Etienne")!;
  const open: RosterState = { ...irOpen, roster: active, reserve: [{ ...etienne, onIr: true }], openBenchSlots: 1, openIrSlots: 1 };
  const fa = (name: string, points?: number): AvailablePlayer => ({ ...tradePlayer(idOf(name)), ...(points ? { points } : {}), onWaivers: false });
  test("a depth receiver worth more than Mark Andrews is not seated: the seat costs Andrews on Etienne's return, and a fifth receiver is no upgrade at his position", () => {
    const m = planOne(fa("Malik Washington"), open, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.reason).toContain("bench -5.1");
    expect(chooseForcedDrops(active, 1, undefined, starters)[0]?.name).toBe("Mark Andrews");
    expect(chooseForcedDrops([...active, fa("Malik Washington"), { ...etienne, injuryStatus: undefined, returnsBeforePlayoffs: false }], 1, undefined, starters)[0]?.name).toBe("Mark Andrews");
  });
  test("a body worth less than Andrews is seated: on Etienne's return he is the one who goes", () => {
    const cheap = fa("Malik Washington", 100);
    const m = planOne(cheap, open, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.dropPath).toBe("bench-slot");
    expect(chooseForcedDrops([...active, cheap, { ...etienne, injuryStatus: undefined, returnsBeforePlayoffs: false }], 1, undefined, starters)[0]?.name).toBe("Malik Washington");
  });
  test("an add the lineup justifies goes INTO it: nobody dropped, and Rico Dowdle is not parked as well", () => {
    for (const p of [fa("Malik Washington", 260), onWaivers("Malik Washington", 260)]) {
      const m = planOne(p, open, DEFAULT_WAIVERS);
      expect(["free-add", "waiver-claim"]).toContain(m.kind);
      expect(m.dropPath).toBe("bench-slot");
      expect(m.drop).toBeNull();
      expect(m.irStash).toBeNull();
    }
  });
  test("a bench upgrade over Downs takes the seat and Downs stays as depth; Mark Andrews, the man shed first anyway, goes on the return", () => {
    const m = planOne(fa("Malik Washington", 170), open, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.dropPath).toBe("bench-slot");
    expect(m.drop).toBeNull();
    expect(chooseForcedDrops(active, 1, undefined, starters)[0]?.name).toBe("Mark Andrews");
  });
});
