// A free agent into an open bench slot is chosen by what he is worth to the
// team, and an IR stash stays a deferred drop even for a player on NFL IR.
//
// 2026-10-01 review, on the roster as it stood with both pending claims
// processed (incidents/league.ts), Travis Etienne on NFL injured reserve and
// Rico Dowdle Out.
//
// 1. With a bench slot open, the first add was Matthew Stafford: a third
//    quarterback in a one-quarterback league. Costless adds all tie at a
//    lineup gain of zero and the tie broke on "points over the cheapest
//    bench body at his own position", which a quarterback wins against
//    another quarterback. He would never play, and at 243 points he would
//    sit inside the protected top twelve and push a real player out of it.
//
// 2. The same review tried to treat parking a player on NFL IR as free (he
//    is out for weeks, the slot is "as good as open"). The reviewer replayed
//    the return: when Etienne comes back the cut is the lowest rest-of-season
//    value on the bench, and that is Mark Andrews, not the receiver who took
//    the slot. A swap the planner refuses when asked directly would have
//    happened in two steps. The stash keeps its bar; the last block pins why.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, depthGain, claimFallbackAllowed, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { chooseForcedDrops } from "./roster-fit.ts";
import type { RailPlayer } from "./rails.ts";
import { LEAGUE, OURS, fx, idOf, tradePlayer, availableAt } from "./incidents/league.ts";

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
const fa = (name: string): AvailablePlayer => ({ ...tradePlayer(idOf(name)), onWaivers: false });
const taken = new Set(Object.values(swapIn));
const wire: AvailablePlayer[] = ["QB", "RB", "WR", "TE", "K", "DEF"]
  .flatMap((pos) => availableAt(pos))
  .filter((p) => !taken.has(p.playerId))
  .map((p) => ({ ...tradePlayer(p.playerId), onWaivers: false }));

// Fifteen active (Etienne already on IR) and one bench slot open.
const active = roster.filter((p) => p.name !== "Travis Etienne");
const open: RosterState = { roster: active, openBenchSlots: 1, openIrSlots: 1, startingSlots: SLOTS, irEligible, currentStarters: starters, weeksLeft: 14 };

describe("an open bench slot goes to the body worth most to the team", () => {
  test("a third quarterback is not taken: he would start in no week and cover nobody", () => {
    const m = planOne(fa("Matthew Stafford"), open, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(depthGain(fa("Matthew Stafford"), open)).toBe(0);
  });
  test("the slot goes to Malik Washington, a fifth receiver; every costless add on the board is a back, a receiver or a tight end", () => {
    const adds = planWaivers(wire, open, DEFAULT_WAIVERS).filter((m) => m.kind === "free-add");
    expect(adds[0]?.add).toBe("Malik Washington");
    expect(adds[0]?.dropPath).toBe("bench-slot");
    expect(adds[0]?.drop).toBeNull();
    expect(adds.every((m) => ["RB", "WR", "TE"].includes(m.position))).toBe(true);
  });
  test("a body worth under a point to the team is noise and is left on the wire", () => {
    const adds = planWaivers(wire, open, DEFAULT_WAIVERS).filter((m) => m.kind === "free-add");
    for (const m of adds) expect(m.depthPts).toBeGreaterThanOrEqual(DEFAULT_WAIVERS.openSlotMinPts);
    expect(adds.length).toBeLessThan(wire.length / 2);
  });
  test("a second kicker or defense is not depth: their byes are covered by a swap in the bye week", () => {
    for (const pos of ["K", "DEF"]) for (const p of availableAt(pos)) {
      expect(planOne({ ...tradePlayer(p.playerId), onWaivers: false }, open, DEFAULT_WAIVERS).kind).toBe("skip");
    }
  });
  test("a kicker into an EMPTY kicker slot is taken, however few points he has left", () => {
    const noKicker: RosterState = { ...open, roster: active.filter((p) => p.position !== "K"), openBenchSlots: 2, currentStarters: starters.filter((n) => n !== "Jake Bates") };
    const weak = { ...tradePlayer(availableAt("K")[0]!.playerId), points: 4, onWaivers: false };
    const m = planOne(weak, noKicker, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.startsForUs).toBe(true);
  });
  test("a free agent who is not playing covers nobody: no insurance credit", () => {
    const hurt = { ...fa("Malik Washington"), injuryStatus: "Out" };
    expect(depthGain(hurt, open)).toBeLessThan(depthGain(fa("Malik Washington"), open));
  });
  test("an on-waivers player is not claimed for an open bench seat", () => {
    expect(planOne({ ...fa("Malik Washington"), onWaivers: true }, open, DEFAULT_WAIVERS).kind).toBe("wait");
  });
});

describe("parking a player on NFL IR is a deferred drop on the ONE value (2026-10-06)", () => {
  // Filip, 2026-10-06: "take advantage of IR". The stash is offered for
  // any add; on the return the activation cuts the lowest rest-of-season
  // value that is not a starter (roster-fit.ts), and the planner names him.
  // On this roster that is Mark Andrews at 119.8, the man the roster sheds
  // first whatever the move. A seat that costs him later is paid for the
  // same way a drop is: a lineup gain, a bench upgrade at the newcomer's
  // own position, or a one-week rental. A fifth receiver worth less than
  // Josh Downs pays nothing, so the 2026-10-01 outcome stands.
  const full: RosterState = { roster, openBenchSlots: 0, openIrSlots: 2, startingSlots: SLOTS, irEligible, currentStarters: starters, weeksLeft: 14 };
  test("Malik Washington is not seated by parking Etienne: the seat would cost Andrews on the return, and a fifth receiver worth less than Downs is no upgrade at his position", () => {
    const m = planOne(fa("Malik Washington"), full, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.reason).toContain("ir-stash lifts the lineup just +0");
    expect(chooseForcedDrops(roster.filter((p) => p.name !== "Travis Etienne"), 1, undefined, starters)[0]?.name).toBe("Mark Andrews");
  });
  test("a receiver who beats Downs by a point a week is seated by parking Etienne: the deferred cut of Andrews is paid by the upgrade", () => {
    const m = planOne({ ...fa("Malik Washington"), points: 165 }, full, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.dropPath).toBe("ir-stash");
    expect(m.irStash).toBe("Travis Etienne");
    expect(m.reason).toContain("Mark Andrews goes");
  });
  test("every free add made through the stash leaves a return cut the planner names: the newcomer, his direct drop, or the first-shed man", () => {
    const first = chooseForcedDrops(roster.filter((p) => p.name !== "Travis Etienne"), 1, undefined, starters)[0]?.name ?? null;
    const adds = planWaivers(wire, full, DEFAULT_WAIVERS).filter((m) => m.kind === "free-add" && m.dropPath === "ir-stash");
    expect(adds.length).toBeGreaterThan(0);
    for (const m of adds) {
      const inc = wire.find((p) => p.name === m.add)!;
      const onReturn = [...roster.map((p) => (p.name === m.irStash ? { ...p, injuryStatus: undefined, returnsBeforePlayoffs: false } : p)), inc];
      const cut = chooseForcedDrops(onReturn, 1, undefined, starters)[0]?.name ?? null;
      expect([m.add, m.irStash, first]).toContain(cut);
    }
  });
});

describe("a free add Sleeper says is on waivers becomes a claim only if it is worth one", () => {
  const full: RosterState = { roster, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible, currentStarters: starters, weeksLeft: 14 };
  const worth = (name: string, points: number): AvailablePlayer => ({ ...fa(name), points });
  test("a depth body into an open slot is not claimed", () => {
    const m = planOne(fa("Malik Washington"), open, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(claimFallbackAllowed(m, fa("Malik Washington"), open, DEFAULT_WAIVERS)).toBe(false);
  });
  test("a bench swap of 1.6 a week (a free add) is under the 2.0 a week a claim needs: not claimed", () => {
    const p = worth("Malik Washington", 170);
    const m = planOne(p, full, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Josh Downs");
    expect(claimFallbackAllowed(m, p, full, DEFAULT_WAIVERS)).toBe(false);
  });
  test("a bench swap of 2.3 a week is claimed, with the same drop", () => {
    const p = worth("Malik Washington", 180);
    const m = planOne(p, full, DEFAULT_WAIVERS);
    expect(m.drop).toBe("Josh Downs");
    expect(claimFallbackAllowed(m, p, full, DEFAULT_WAIVERS)).toBe(true);
  });
  test("a claim that would take a different route than the free add is not filed in its place", () => {
    const p = worth("Malik Washington", 180);
    const m = { ...planOne(p, full, DEFAULT_WAIVERS), drop: "Mark Andrews" };
    expect(claimFallbackAllowed(m, p, full, DEFAULT_WAIVERS)).toBe(false);
  });
});
