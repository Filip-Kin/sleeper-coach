// Replay of Monday 2026-11-09 09:16 ET (week 9) on the league as captured
// then (incidents/league-2026-11-09.json, read through the real
// pendingClaimPlayers path). Our counter-offer 1425359907405783040 to
// roster 1 was live: DJ Moore (WR BUF, 133 ROS) for Dak Prescott (QB, 144),
// Jakobi Meyers (WR, 95) and Khalil Shakir (WR, 93), our lineup +13. The
// hand tool's cut order read Robinson #1, Shakir #2, Meyers #3, Prescott #4
// and nothing marked the three legs as held: a free add after Robinson, a
// stream's cut, a reserve cut or a hand `add` would have taken Shakir, and
// Sleeper voids a trade whose player has left the roster.
//
// The rule (act/pending-claims.ts): while an offer we sent is live, or a
// trade we accepted sits in review, every leg we give is committed like the
// drop side of a pending claim: on `drops`, never a cut in any path, and
// the refusal names the transaction. The offer rejected or expired frees
// them on the next read.
import { describe, expect, test } from "bun:test";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-11-09.json";
import { notPlaying } from "../analysis/value.ts";
import { canDrop, DEFAULT_RAILS, type RailPlayer } from "../analysis/rails.ts";
import { chooseForcedDrops, keptStarters } from "../analysis/roster-fit.ts";
import { stashCandidates, DEFAULT_WAIVERS } from "../analysis/waivers.ts";
import { handLegalCuts } from "./hand-cuts.ts";
import { railsWithPendingDrops, parsePendingClaims, NO_PENDING, type PendingClaims } from "./pending-claims.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const WEEK = 9;
const TX = "1425359907405783040";
const mine = ourRoster();
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");

// roster-move.ts: the rail is the ACTIVE roster (Hurts and Etienne on IR are not on it).
const roster: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const starters = mine.starters.map((id) => fx(id).name);
const canFill = (body: RailPlayer): boolean => (fx(body.playerId!).weekly[String(WEEK)] ?? 0) > 0 && !notPlaying(body.injuryStatus);
const held: PendingClaims = { ...NO_PENDING, ...LEAGUE.pendingClaims, tradeGives: LEAGUE.pendingClaims.tradeGives ?? [] };
const names = (ps: { name: string }[]): string[] => ps.map((p) => p.name);
const LEGS = ["Dak Prescott", "Jakobi Meyers", "Khalil Shakir"];

describe("the live offer's legs as the capture read them from Sleeper", () => {
  test("the three men we give are on the committed list, held for the transaction", () => {
    expect(held.tradeGives.map((g) => g.transactionId)).toEqual([TX, TX, TX]);
    expect(held.tradeGives.map((g) => g.status)).toEqual(["proposed", "proposed", "proposed"]);
    expect(held.drops.map((id) => fx(id).name).sort()).toEqual([...LEGS].sort());
    expect(held.claims).toEqual([]); // no claim pending: these are trade legs only
    expect(held.adds).toEqual([]); // Moore is theirs until it processes
    for (const id of held.drops) expect(mine.players).toContain(id);
  });
});

describe("the hand tool's cuts on 2026-11-09 (roster-move.ts drop \"nobody\")", () => {
  test("as filed, with nothing held: Robinson #1, Shakir #2, Meyers #3, Prescott #4", () => {
    const { cuts } = handLegalCuts({ week: WEEK, roster, starters, pendingDrops: [], canFill });
    expect(names(cuts).slice(0, 4)).toEqual(["Wan'Dale Robinson", "Khalil Shakir", "Jakobi Meyers", "Dak Prescott"]);
  });
  test("with the offer live: Robinson is the only cut; the legs are not in the order", () => {
    const { cuts } = handLegalCuts({ week: WEEK, roster, starters, pendingDrops: held.drops, canFill });
    expect(names(cuts)).toEqual(["Wan'Dale Robinson"]);
  });
  test("a --drop naming a leg is refused with the transaction", () => {
    const rails = railsWithPendingDrops(DEFAULT_RAILS, roster, held);
    for (const leg of LEGS) {
      const v = canDrop(leg, roster, rails);
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain(TX);
      expect(v.reason).toContain("proposed");
    }
    expect(canDrop("Wan'Dale Robinson", roster, { ...rails, protectTopN: 0 }).allowed).toBe(true);
  });
  test("the offer rejected: Shakir is cut #2 again on the next read", () => {
    const row = {
      transaction_id: TX, type: "trade", status: "rejected", roster_ids: [1, 3], consenter_ids: [3], created: Date.now() - 3_600_000,
      adds: { "4983": 3, "3294": 1, "5947": 1, "8134": 1 }, drops: { "4983": 1, "3294": 3, "5947": 3, "8134": 3 }, settings: { expires_at: Math.floor(Date.now() / 1000) + 86_400 },
    };
    const freed = parsePendingClaims([row], 3);
    expect(freed.drops).toEqual([]);
    const { cuts } = handLegalCuts({ week: WEEK, roster, starters, pendingDrops: freed.drops, canFill });
    expect(names(cuts)[1]).toBe("Khalil Shakir");
  });
});

describe("every engine cut path plans around the legs", () => {
  const rails = railsWithPendingDrops(DEFAULT_WAIVERS.rails, roster, held);
  const keep = keptStarters(starters, roster, (body) => canFill(body) && !held.drops.includes(body.playerId ?? ""));
  test("a forced cut (reserve return, over-cap reconcile): the legs are never chosen, however many seats are needed", () => {
    const one = chooseForcedDrops(roster, 1, undefined, keep, rails, SLOTS);
    expect(names(one)).toEqual(["Wan'Dale Robinson"]);
    // Two seats: nobody legal remains after Robinson (the legs and the stashes are held), so it stops short rather than take a leg.
    const two = chooseForcedDrops(roster, 2, undefined, keep, rails, SLOTS);
    for (const d of two) expect(LEGS).not.toContain(d.name);
  });
  test("without the hold the second forced cut IS Shakir, the defect", () => {
    const free = railsWithPendingDrops(DEFAULT_WAIVERS.rails, roster, NO_PENDING);
    const two = chooseForcedDrops(roster, 2, undefined, keptStarters(starters, roster, canFill), free, SLOTS);
    expect(names(two)).toContain("Khalil Shakir");
  });
  test("the IR seat: a leg is never the stash either", () => {
    const stashes = stashCandidates({ roster, irEligible: (s) => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").toUpperCase()), currentStarters: starters }, { rails });
    for (const s of stashes) expect(LEGS).not.toContain(s.name);
    expect(names(stashes)).toEqual(expect.arrayContaining(["Mike Evans", "DeVonta Smith"]));
  });
});
