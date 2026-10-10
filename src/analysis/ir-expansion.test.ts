// An IR slot is a roster expansion (Filip, 2026-10-06, 09:50 ET).
//
// "You got to take advantage of IR. If we have two players that are injured
// that means we can pick up two players. Even if it's just for one week,
// those players might be better than some of our starters but only for
// this one week. So we want to keep our starters and just for this week
// stream that defense." And: "if we have a third player that is injured
// and they're good otherwise, like if he's usually a starter for us, don't
// drop them."
//
// That morning the bot had planned "claim RJ Harvey, drop Jacory
// Croskey-Merritt" with two IR slots empty and Travis Etienne (NFL IR) and
// Rico Dowdle (Out) sitting on the active bench, and had no notion of a
// one-week pickup at all. The moves were made by hand: Etienne and Dowdle
// to IR, claims for Harvey and the Bengals defense (8.8 this week against
// Seattle's 6.4) into the two open slots, nobody dropped. This file replays
// them on the league as captured that evening (league-2026-10-06.json) and
// pins what the planner does now.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, stashCandidates, weekLineupGain, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { planStream, type StreamPoolPlayer, type StreamNeed } from "./streaming.ts";
import { chooseForcedDrops } from "./roster-fit.ts";
import { canDrop, type RailPlayer } from "./rails.ts";
import { notPlaying } from "./value.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-06.json";
import { LEAGUE as OLD, OURS as OLD_OURS, fx as oldFx, idOf as oldIdOf, tradePlayer as oldPlayer } from "./incidents/league.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const WEEK = LEAGUE.week; // 5
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN");
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const mine = ourRoster();
const starters = mine.starters.map((id) => fx(id).name);
const weekPointsFor = (ids: string[], week: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const id of ids) {
    const p = fx(id);
    m.set(p.name, notPlaying(p.injuryStatus) ? 0 : p.weekly[String(week)] ?? 0);
  }
  return m;
};
// The wire as the morning saw it: today's unrostered players plus the two
// the evening's claims took off it.
const wire: AvailablePlayer[] = [...["QB", "RB", "WR", "TE", "K", "DEF"].flatMap((pos) => availableAt(pos)).map((p) => p.playerId), ...LEAGUE.pendingClaims.adds]
  .map((id) => ({ ...tradePlayer(id), onWaivers: true }));
const allIds = [...mine.players, ...LEAGUE.pendingClaims.adds, ...wire.map((p) => p.playerId!)];
const onWaivers = (name: string): AvailablePlayer => ({ ...tradePlayer(idOf(name)), onWaivers: true });

// The morning: sixteen active, IR empty, no claim pending, last in the waiver order.
const morningRoster: RailPlayer[] = mine.players.map((id) => tradePlayer(id, { onIr: false }));
const morning: RosterState = {
  roster: morningRoster, reserve: [], openBenchSlots: 0, openIrSlots: 2, startingSlots: SLOTS,
  irEligible, currentStarters: starters, weeksLeft: 13, priorityFree: true, weekPoints: weekPointsFor(allIds, WEEK),
};

describe("the morning of 2026-10-06: two IR slots free, Etienne and Dowdle on the active bench", () => {
  test("we are last in the waiver order, so a claim costs nothing", () => {
    expect(LEAGUE.waiverPositions?.[String(LEAGUE.ourRosterId)]).toBe(LEAGUE.rosters.length);
  });
  test("the stash order is longest absence first: Etienne (NFL IR), then Dowdle, then Smith (both Out, Dowdle has less of his season left)", () => {
    expect(stashCandidates(morning, DEFAULT_WAIVERS).map((p) => p.name)).toEqual(["Travis Etienne", "Rico Dowdle", "DeVonta Smith"]);
  });
  test("RJ Harvey is claimed by parking Etienne, and Croskey-Merritt stays: he is the one who goes when Etienne returns, the same cut the direct path names", () => {
    const m = planOne(onWaivers("RJ Harvey"), morning, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.dropPath).toBe("ir-stash");
    expect(m.irStash).toBe("Travis Etienne");
    expect(m.drop).toBeNull();
    expect(m.rental).toBe(false);
    expect(m.reason).toContain("Jacory Croskey-Merritt goes");
    const direct = planOne(onWaivers("RJ Harvey"), { ...morning, openIrSlots: 0 }, DEFAULT_WAIVERS);
    expect(direct.drop).toBe("Jacory Croskey-Merritt");
    const onReturn = [...morningRoster.map((p) => (p.name === "Travis Etienne" ? { ...p, injuryStatus: undefined, returnsBeforePlayoffs: false } : p)), tradePlayer(idOf("RJ Harvey"))];
    expect(chooseForcedDrops(onReturn, 1, undefined, starters)[0]?.name).toBe("Jacory Croskey-Merritt");
  });
  test("the Bengals defense is a one-week rental: +2.4 this week over Seattle, claimed at no cost into a stash of Dowdle, and he is the one who goes on either return", () => {
    // Harvey's claim is in: he is ours for the plan, Etienne is on IR, one IR slot left.
    const etienne = morningRoster.find((p) => p.name === "Travis Etienne")!;
    const after: RosterState = {
      ...morning,
      roster: [...morningRoster.filter((p) => p.name !== "Travis Etienne"), { ...tradePlayer(idOf("RJ Harvey")), claimAdd: true }],
      reserve: [{ ...etienne, onIr: true }], openIrSlots: 1, openBenchSlots: 0,
    };
    expect(weekLineupGain(onWaivers("Cincinnati Bengals"), null, after)).toBe(2.4);
    const m = planOne(onWaivers("Cincinnati Bengals"), after, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.rental).toBe(true);
    expect(m.weekGainPts).toBe(2.4);
    expect(m.dropPath).toBe("ir-stash");
    expect(m.irStash).toBe("Rico Dowdle");
    expect(m.drop).toBeNull();
    expect(m.reason).toContain("the newcomer goes");
    expect(m.reason).toContain("one-week rental");
  });
  test("a rental is never worth waiver priority: not last in the order, the same defense waits", () => {
    const m = planOne(onWaivers("Cincinnati Bengals"), { ...morning, priorityFree: false }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
  });
  test("a rental never cuts a season body: with no IR slot and no open slot the Bengals are skipped, Croskey-Merritt is not cut for one week", () => {
    const m = planOne(onWaivers("Cincinnati Bengals"), { ...morning, openIrSlots: 0 }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
  });
  test("a rental may take the seat of an earlier rental: a defense worth no more for the season than the Jaguars already on the roster", () => {
    const jax = tradePlayer(idOf("Jacksonville Jaguars"));
    const wp = new Map(morning.weekPoints); wp.set(jax.name, 0); // last week's rental, nothing this week
    const withJax: RosterState = { ...morning, roster: [...morningRoster.filter((p) => p.name !== "Jacory Croskey-Merritt"), jax], openIrSlots: 0, weekPoints: wp };
    const cheaper = { ...onWaivers("Cincinnati Bengals"), points: jax.points };
    const m = planOne(cheaper, withJax, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
    expect(m.rental).toBe(true);
    expect(m.drop).toBe("Jacksonville Jaguars");
  });
  test("DeVonta Smith (Out, WR13 on the season) is a protected stash: no path cuts him", () => {
    expect(canDrop("DeVonta Smith", morningRoster).allowed).toBe(false);
    for (const p of wire) expect(planOne(p, morning, DEFAULT_WAIVERS).drop).not.toBe("DeVonta Smith");
  });
  test("a bench upgrade under the free bar is not a claim even at no cost, and a bench body worth a point a week is", () => {
    const moves = planWaivers(wire, morning, DEFAULT_WAIVERS);
    const harvey = moves.find((m) => m.add === "RJ Harvey")!;
    expect(harvey.kind).toBe("waiver-claim");
    expect(moves.indexOf(harvey)).toBe(0);
    for (const m of moves.filter((x) => x.kind === "waiver-claim" && !x.rental)) expect(m.benchGainPts / 13 >= DEFAULT_WAIVERS.benchSwapMarginPerWeek || m.gainPts >= DEFAULT_WAIVERS.freeAddMarginPts).toBe(true);
  });
});

describe("the evening: fourteen active, two on IR, both claims pending", () => {
  const active = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
  const pendingAdds = LEAGUE.pendingClaims.adds.map((id) => ({ ...tradePlayer(id), claimAdd: true }));
  const reserve = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
  const evening: RosterState = {
    roster: [...active, ...pendingAdds], reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS,
    irEligible, currentStarters: starters, weeksLeft: 13, priorityFree: true, weekPoints: weekPointsFor(allIds, WEEK),
  };
  test("the pending adds are planned with as ours and are not a drop for anyone", () => {
    for (const p of pendingAdds) expect(canDrop(p.name, evening.roster).allowed).toBe(false);
    for (const m of planWaivers(wire, evening, DEFAULT_WAIVERS)) expect(["RJ Harvey", "Cincinnati Bengals"]).not.toContain(m.drop ?? "");
  });
  test("nothing else is claimed tonight: no seat, no stash, nothing over the bar, and no rental by cutting a back for a receiver", () => {
    const eveningWire = wire.filter((p) => !LEAGUE.pendingClaims.adds.includes(p.playerId!));
    expect(planWaivers(eveningWire, evening, DEFAULT_WAIVERS).filter((m) => m.kind === "waiver-claim" || m.kind === "free-add")).toEqual([]);
    const metcalf = planOne(onWaivers("DK Metcalf"), evening, DEFAULT_WAIVERS);
    expect(metcalf.kind).not.toBe("waiver-claim");
    expect(metcalf.drop).toBeNull();
  });
});

describe("week 6: Bates and the Bengals are both on bye, Seattle plays", () => {
  // Both claims landed: sixteen active, Harvey and the Bengals ours.
  const roster = [...mine.players.filter((id) => !mine.reserve.includes(id)), ...LEAGUE.pendingClaims.adds].map((id) => tradePlayer(id, { onIr: false }));
  const need: StreamNeed = { week: 6, position: "K", coveringFor: ["Jake Bates"] };
  const pool = (week: number, onWaivers = false): StreamPoolPlayer[] =>
    availableAt("K").map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly[String(week)] ?? 0, onWaivers, value: p.value }));
  const week6Starters = starters.filter((n) => n !== "Jake Bates" && n !== "Sam LaPorta" && n !== "Chase Brown");
  test("the Bengals, a spare defense on bye, make room for the kicker; Bates stays", () => {
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(6), roster, mayLeave: () => true, forcedDrop: () => { throw new Error("no cut"); }, currentStarters: week6Starters });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Cincinnati Bengals");
    expect(d.add).not.toBeNull();
    expect(availableAt("K").find((p) => p.name === d.add)!.weekly["6"]).toBeGreaterThan(0);
  });
  test("Seattle is never the spare: our one defense worth more than the Bengals", () => {
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(6), roster, mayLeave: () => true, forcedDrop: () => null, currentStarters: week6Starters });
    expect(d.drop).not.toBe("Seattle Seahawks");
  });
  test("without the Bengals it is the old swap: Bates leaves in his bye week for a free kicker", () => {
    const thin = roster.filter((p) => p.name !== "Cincinnati Bengals");
    const d = planStream({ need, week: 6, openBenchSlots: 0, pool: pool(6), roster: thin, mayLeave: () => true, forcedDrop: () => null, currentStarters: week6Starters });
    expect(d.how).toBe("swap");
    expect(d.drop).toBe("Jake Bates");
  });
  test("the spare may leave a week early, in week 5, since he is not playing for us either way", () => {
    const d = planStream({ need, week: 5, openBenchSlots: 0, pool: pool(6), roster, mayLeave: () => true, forcedDrop: () => null, currentStarters: starters.filter((n) => n !== "Seattle Seahawks").concat("Cincinnati Bengals") });
    // In week 5 the Bengals start for us (the rental), so they are not a spare yet and the swap waits.
    expect(d.how).toBe("wait");
    const after = planStream({ need, week: 5, openBenchSlots: 0, pool: pool(6), roster, mayLeave: () => true, forcedDrop: () => null, currentStarters: starters });
    expect(after.how).toBe("swap");
    expect(after.drop).toBe("Cincinnati Bengals");
  });
  test("an open slot and the priority free: the best kicker who plays week 6 is claimed, waivers or not", () => {
    const d = planStream({ need, week: 6, openBenchSlots: 1, pool: pool(6, true), roster, mayLeave: () => true, forcedDrop: () => null, priorityFree: true });
    expect(d.how).toBe("open-slot");
    expect(d.onWaivers).toBe(true);
  });
});

describe("the reviewer's replays of 2026-10-06", () => {
  // 1. The 2026-10-01 regression in two steps, on the 09-30 league with
  //    both claims landed and Etienne on IR: seat Tre Tucker by parking
  //    Etienne (his return cuts Tucker, fine), then drop Tucker for Malik
  //    Washington as a bench upgrade. Etienne's return would then cut Mark
  //    Andrews, whom neither move pays for. The drop path is forecast too.
  test("a drop path is forecast too: Washington for Tucker is the same-position swap the value rule makes, and the forecast names Andrews, the man shed first after it", () => {
    const swapIn: Record<string, string> = { [oldIdOf("Tyjae Spears")]: oldIdOf("Travis Etienne"), [oldIdOf("Kenny Gainwell")]: oldIdOf("Jacory Croskey-Merritt") };
    const old = OLD.rosters.find((r) => r.rosterId === OLD_OURS)!;
    const oldStarters = old.starters.map((id) => oldFx(id).name);
    const oldSlots = OLD.rosterPositions.filter((x) => x !== "BN");
    const etienne = { ...oldPlayer(oldIdOf("Travis Etienne")), injuryStatus: "IR", returnsBeforePlayoffs: true, onIr: true };
    const tucker = oldPlayer(oldIdOf("Tre Tucker"));
    const active = [...old.players.map((id) => oldPlayer(swapIn[id] ?? id, { onIr: false })).filter((p) => p.name !== "Travis Etienne"), tucker];
    const state: RosterState = { roster: active, reserve: [etienne], openBenchSlots: 0, openIrSlots: 1, startingSlots: oldSlots, irEligible, currentStarters: oldStarters, weeksLeft: 14 };
    const m = planOne({ ...oldPlayer(oldIdOf("Malik Washington")), onWaivers: false }, state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.drop).toBe("Tre Tucker");
    const onReturn = [...active.filter((p) => p.name !== "Tre Tucker"), oldPlayer(oldIdOf("Malik Washington")), { ...etienne, onIr: false, injuryStatus: undefined, returnsBeforePlayoffs: false }];
    expect(chooseForcedDrops(onReturn, 1, undefined, oldStarters)[0]?.name).toBe("Mark Andrews");
    expect(chooseForcedDrops(active.filter((p) => p.name !== "Tre Tucker"), 1, undefined, oldStarters)[0]?.name).toBe("Mark Andrews");
  });
  // 2. A defense is never a bench upgrade: the Eagles (91.5 for the season,
  //    5.5 this week) do not take the Bengals' seat while the Bengals are
  //    the one who plays.
  const landed = [...mine.players.filter((id) => !mine.reserve.includes(id)), ...LEAGUE.pendingClaims.adds].map((id) => tradePlayer(id, { onIr: false }));
  const reserve = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
  const wednesday: RosterState = {
    roster: landed, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
    currentStarters: starters, weeksLeft: 13, priorityFree: true, weekPoints: weekPointsFor(allIds, WEEK),
  };
  test("a kicker or defense is never a bench upgrade: the Eagles do not replace the Bengals for the season", () => {
    const eagles = { ...tradePlayer(idOf("Philadelphia Eagles")), onWaivers: false };
    const m = planOne(eagles, wednesday, DEFAULT_WAIVERS);
    expect(m.kind).toBe("skip");
    expect(m.drop).toBeNull();
  });
  // 4. In week 6 the Bengals are on bye and not starting: a spent rental.
  //    His seat is free for a depth body, not a cut that "lifts the lineup +0".
  test("a spent rental's seat is a seat: in week 6 a depth back takes the Bengals' slot", () => {
    const week6Starters = starters.filter((n) => n !== "Jake Bates" && n !== "Sam LaPorta" && n !== "Chase Brown");
    const wk6: RosterState = { ...wednesday, currentStarters: week6Starters, weeksLeft: 12, weekPoints: weekPointsFor(allIds, 6) };
    const moves = wire.map((p) => planOne({ ...p, onWaivers: false }, wk6, DEFAULT_WAIVERS));
    // Charbonnet beats Croskey-Merritt by 1.1 a week on the feed, but he is
    // on PUP with no game played and 67 on the season against 128: a feed
    // built on an assumed return is no number to cut on (2026-10-09 defect),
    // so he is a skip. The same man playing takes the Bengals' seat and
    // Croskey-Merritt stays.
    const pup = moves.find((m) => m.add === "Zach Charbonnet")!;
    expect(pup.kind).toBe("skip");
    expect(pup.reason).toContain("not playing now (PUP)");
    const charbonnet = planOne({ ...tradePlayer(idOf("Zach Charbonnet")), injuryStatus: undefined, onWaivers: false }, wk6, DEFAULT_WAIVERS);
    expect(charbonnet.kind).toBe("free-add");
    expect(charbonnet.drop).toBe("Cincinnati Bengals");
    // Nobody is cut while the seat is free; a body with no depth value is refused on depth.
    for (const m of moves) expect(["Cincinnati Bengals", null]).toContain(m.drop);
    const dobbins = moves.find((m) => m.add === "J.K. Dobbins")!;
    expect(dobbins.kind).toBe("skip");
    expect(dobbins.reason).toMatch(/adds only/);
    // Never Seattle, our one defense that plays.
    for (const m of moves) expect(m.drop).not.toBe("Seattle Seahawks");
  });
});

describe("the second reviewer's replays of 2026-10-06", () => {
  const landed = [...mine.players.filter((id) => !mine.reserve.includes(id)), ...LEAGUE.pendingClaims.adds].map((id) => tradePlayer(id, { onIr: false }));
  const reserve = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
  const week6Starters = starters.filter((n) => n !== "Jake Bates" && n !== "Sam LaPorta" && n !== "Chase Brown");
  const wk6: RosterState = {
    roster: landed, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
    currentStarters: week6Starters, weeksLeft: 12, priorityFree: true, weekPoints: weekPointsFor(allIds, 6),
  };
  test("with a seat open nobody leaves: Charbonnet, playing, takes the open seat, not the Bengals' slot; on PUP he takes nothing", () => {
    const m = planOne({ ...tradePlayer(idOf("Zach Charbonnet")), injuryStatus: undefined, onWaivers: false }, { ...wk6, openBenchSlots: 1 }, DEFAULT_WAIVERS);
    expect(m.kind).toBe("free-add");
    expect(m.dropPath).toBe("bench-slot");
    expect(m.drop).toBeNull();
    // The seat's later cut (a return) would reach Croskey-Merritt, a body a PUP newcomer does not beat on the season projection.
    const pup = planOne({ ...tradePlayer(idOf("Zach Charbonnet")), onWaivers: false }, { ...wk6, openBenchSlots: 1 }, DEFAULT_WAIVERS);
    expect(pup.kind).toBe("skip");
    expect(pup.reason).toContain("season projection");
  });
  test("a defense with points this week is not spare, whatever the leg says: in week 5 the Bengals keep their seat before the guard starts them", () => {
    const wk5: RosterState = { ...wk6, currentStarters: starters, weeksLeft: 13, weekPoints: weekPointsFor(allIds, WEEK) };
    const m = planOne({ ...tradePlayer(idOf("Zach Charbonnet")), onWaivers: false }, wk5, DEFAULT_WAIVERS);
    expect(m.drop).not.toBe("Cincinnati Bengals");
  });
});
