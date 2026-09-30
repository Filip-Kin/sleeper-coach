// A player named as the drop of our own pending waiver claim is committed.
//
// 2026-09-30, 09:19 ET. Two claims were pending: add Jacory Croskey-Merritt
// dropping Kenny Gainwell, and add Travis Etienne dropping Tyjae Spears. The
// weekly trade proposer, forty minutes from its slot, chose "we get Sam
// Darnold + DJ Moore for Dak Prescott + Kenny Gainwell". Had that gone out
// and been accepted, one of the two would have died when the other processed:
// the claim with no Gainwell left to drop, or the trade with no Gainwell left
// to give. The waiver run, the over-cap cut, the IR activation and the hand
// tool all knew about pending drops; the trade paths did not.
//
// The replay is on the league as it stood that morning (incidents/league.ts).
import { describe, expect, test } from "bun:test";
import { canDrop } from "./rails.ts";
import { evaluateTradeTwoSided, giveEligibleForProposal, proposeTrades, DEFAULT_FAIRNESS, type FairnessConfig } from "./trade-fair.ts";
import { markClaimDrops, snapshotWithPending } from "./trade-wire.ts";
import { leagueSnapshot, idOf, tradePlayer, LEAGUE, OURS } from "./incidents/league.ts";
import { scalePts } from "./value.ts";
import { SCALED_PTS } from "./trade-wire.ts";

const GAINWELL = idOf("Kenny Gainwell");
const SPEARS = idOf("Tyjae Spears");
const weeks = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const cfg: FairnessConfig = { ...scalePts(DEFAULT_FAIRNESS, 4, SCALED_PTS), remainingWeeks: 12, headToHeadRemaining: 2, upcomingWeeks: weeks, rosterCapacity: 16 };

describe("markClaimDrops", () => {
  test("flags the drop side of our pending claims on OUR roster and nobody else's", () => {
    const snap = markClaimDrops(leagueSnapshot(), LEAGUE.pendingClaims.drops);
    const ours = snap.rosterOf.get(OURS)!;
    expect(ours.filter((p) => p.claimDrop).map((p) => p.name).sort()).toEqual(["Kenny Gainwell", "Tyjae Spears"]);
    for (const [rid, roster] of snap.rosterOf) if (rid !== OURS) expect(roster.some((p) => p.claimDrop)).toBe(false);
  });
  test("no pending drops leaves the snapshot alone", () => {
    const base = leagueSnapshot();
    expect(markClaimDrops(base, [])).toBe(base);
  });
  test("an id we do not hold is ignored", () => {
    const snap = markClaimDrops(leagueSnapshot(), ["999999"]);
    expect(snap.rosterOf.get(OURS)!.some((p) => p.claimDrop)).toBe(false);
  });
});

describe("a claim's drop is committed in every trade path", () => {
  const snap = markClaimDrops(leagueSnapshot(), LEAGUE.pendingClaims.drops);
  const ours = snap.rosterOf.get(OURS)!;

  test("canDrop refuses him, and says why", () => {
    const v = canDrop("Kenny Gainwell", ours, { ...DEFAULT_FAIRNESS.rails, protectTopN: 0 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/committed to a pending roster move/);
  });
  test("the proposer's give gate refuses him", () => {
    const g = giveEligibleForProposal(ours.find((p) => p.playerId === GAINWELL)!, ours, cfg);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/committed to a pending roster move/);
  });
  test("without the flag the same player passes the give gate (the 09:19 state)", () => {
    const plain = leagueSnapshot().rosterOf.get(OURS)!;
    expect(giveEligibleForProposal(plain.find((p) => p.playerId === GAINWELL)!, plain, cfg).ok).toBe(true);
  });
  test("no proposal to any rival gives Gainwell or Spears", () => {
    for (const [rid, roster] of snap.rosterOf) {
      if (rid === OURS) continue;
      const props = proposeTrades(ours, [{ managerId: String(rid), teamName: `roster ${rid}`, roster }], cfg, 50);
      for (const p of props) {
        const gives = p.offer.give.map((x) => x.playerId);
        expect(gives).not.toContain(GAINWELL);
        expect(gives).not.toContain(SPEARS);
      }
    }
  });
  test("the reason is sent to the rival in a DM, so it does not say what the move is", () => {
    // "the drop of our pending waiver claim" told a rival with better waiver
    // priority that we have a claim in and who is about to hit the wire.
    const v = canDrop("Kenny Gainwell", ours, DEFAULT_FAIRNESS.rails);
    expect(v.reason).not.toMatch(/waiver|claim|drop/i);
  });
  test("an incoming offer that asks for him is refused by the rail", () => {
    const theirs = snap.rosterOf.get(1)!;
    const offer = { give: [ours.find((p) => p.playerId === GAINWELL)!], receive: [tradePlayer(idOf("Deebo Samuel"))] };
    const ev = evaluateTradeTwoSided(offer, ours, theirs, cfg);
    expect(ev.verdict).toBe("reject");
    expect(ev.railBlocks.join(" ")).toMatch(/committed to a pending roster move/);
  });
});

describe("snapshotWithPending reads our pending claims", () => {
  const claimRows = [
    { transaction_id: "c1", status: "pending", type: "waiver", roster_ids: [OURS], adds: { [idOf("Jacory Croskey-Merritt")]: OURS }, drops: { [GAINWELL]: OURS } },
    { transaction_id: "c2", status: "pending", type: "waiver", roster_ids: [OURS], adds: { [idOf("Travis Etienne")]: OURS }, drops: { [SPEARS]: OURS } },
    { transaction_id: "c3", status: "pending", type: "waiver", roster_ids: [5], adds: { "1": 5 }, drops: { [idOf("Josh Downs")]: 5 } },
  ];
  const gql = async (q: string) => ({ data: { league_transactions_by_status: q.includes('status:"pending"') && q.includes("leg:4") ? claimRows : [] } });
  test("the drops of OUR claims are flagged; another roster's claim is not ours", async () => {
    const snap = await snapshotWithPending(gql as never, 4, leagueSnapshot());
    const flagged = snap.rosterOf.get(OURS)!.filter((p) => p.claimDrop).map((p) => p.name).sort();
    expect(flagged).toEqual(["Kenny Gainwell", "Tyjae Spears"]);
  });
  test("a failed claims read leaves the roster unflagged rather than throwing", async () => {
    const down = async () => { throw new Error("down"); };
    const snap = await snapshotWithPending(down as never, 4, leagueSnapshot());
    expect(snap.rosterOf.get(OURS)!.some((p) => p.claimDrop)).toBe(false);
  });
});
