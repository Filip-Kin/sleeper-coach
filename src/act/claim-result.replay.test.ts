// Replay of the live transaction list captured 2026-10-22 (incidents/
// transactions-2026-10-22.json) for the defect filed that morning: our claim
// for Bo Nix (drop Jacksonville, 1418262744104247296) landed at the Wednesday
// clear and nothing in activity.jsonl said so; a lost claim would have said
// less. Leg 4 holds a real loss of ours: Cincinnati (1413195928436817920),
// "claimed by another owner", taken by roster 5 in the same batch.
import { describe, expect, test } from "bun:test";
import raw from "../analysis/incidents/transactions-2026-10-22.json";
import { claimResults, claimSeenKey, logClaimResults, fmtEt, type WaiverTxn } from "./claim-result.ts";

const fx = raw as unknown as {
  rosterId: number;
  legs: Record<string, WaiverTxn[]>;
  rosters: { roster_id: number; owner_id: string; settings: { waiver_position: number | null } }[];
  users: { user_id: string; display_name: string }[];
};
const ME = fx.rosterId;
const legs = (...ls: number[]): WaiverTxn[] => ls.flatMap((l) => fx.legs[String(l)] ?? []);
const never = () => false;

describe("claimResults on the 2026-10-22 capture", () => {
  test("legs 7 and 6 (the poll of 2026-10-22): the Nix claim landed, and the 10-16 Mahomes-for-Dowdle claim before it", () => {
    const r = claimResults(legs(7, 6), ME, never);
    expect(r.map((x) => [x.transactionId, x.landed, x.add, x.drop])).toEqual([
      ["1416519976465997824", true, "4046", "7021"],
      ["1418262744104247296", true, "11563", "JAX"],
    ]);
    expect(r[1]!.notes).toBe("Your waiver claim was processed successfully!");
    expect(fmtEt(r[1]!.at!)).toBe("Wed 10/21 03:16 ET");
    expect(r[1]!.leg).toBe(6);
  });
  test("leg 4: the lost Cincinnati claim names its winner and Sleeper's note; the landed ones carry no winner", () => {
    const r = claimResults(legs(4), ME, never);
    const lost = r.filter((x) => !x.landed);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      transactionId: "1413195928436817920", add: "CIN", drop: null, winnerRosterId: 5,
      notes: "This player was claimed by another owner.",
    });
    expect(r.filter((x) => x.landed).map((x) => x.add).sort()).toEqual(["12489", "12533", "7543"]);
    expect(r.every((x) => x.landed === (x.winnerRosterId === null))).toBe(true);
  });
  test("a winner is only a landed claim from the same batch; another week's landed claim for the same man is not", () => {
    const cin = legs(4).find((t) => t.transaction_id === "1413195928436417920" || t.transaction_id === "1413195928436817920")!;
    const earlier: WaiverTxn = { transaction_id: "x-earlier", type: "waiver", status: "complete", roster_ids: [5], adds: { CIN: 5 }, drops: null, status_updated: cin.status_updated! - 7 * 86_400_000, leg: 3 };
    const only = claimResults([cin, earlier], ME, never);
    expect(only[0]!.winnerRosterId).toBeNull();
    expect(claimResults([{ ...cin, status_updated: null }, earlier], ME, never)[0]!.winnerRosterId).toBeNull();
  });
  test("other rosters' claims and free-agent adds are not ours", () => {
    expect(claimResults(legs(4, 6, 7), 1, never).every((x) => x.transactionId !== "1418262744104247296")).toBe(true);
    expect(claimResults(legs(7), ME, never)).toEqual([]); // leg 7 is three free-agent adds
    const theirs = claimResults(legs(6), 1, never);
    expect(theirs.map((x) => x.landed)).toEqual([true, false, false]);
  });
  test("a seen transaction is never a result again, and a pending one is not a result yet", () => {
    const seen = new Set<string>([claimSeenKey("1418262744104247296")]);
    expect(claimResults(legs(7, 6), ME, (k) => seen.has(k)).map((x) => x.transactionId)).toEqual(["1416519976465997824"]);
    const pending: WaiverTxn = { ...legs(6).find((t) => t.transaction_id === "1418262744104247296")!, status: "pending" };
    expect(claimResults([pending], ME, never)).toEqual([]);
  });
});

describe("logClaimResults", () => {
  const names: Record<string, string> = { "11563": "Bo Nix", JAX: "Jacksonville Jaguars", CIN: "Cincinnati Bengals", "4046": "Patrick Mahomes", "7021": "Rico Dowdle" };
  const managers = new Map(fx.rosters.map((r) => [r.roster_id, fx.users.find((u) => u.user_id === r.owner_id)?.display_name ?? ""]));
  const harness = (txns: WaiverTxn[], opts: { brokenNames?: boolean } = {}) => {
    const seen = new Map<string, string>();
    const events: { type: string; summary: string; detail: Record<string, unknown> }[] = [];
    const order: string[] = [];
    const run = () => logClaimResults({
      txns, rosterId: ME,
      alreadySeen: (k) => seen.has(k),
      markSeen: (k, s) => { seen.set(k, s); order.push(`seen:${k}`); },
      log: (type, summary, detail) => { events.push({ type, summary, detail }); order.push(`log:${detail.transactionId}`); },
      nameOf: async (id) => { if (opts.brokenNames) throw new Error("no dump"); return names[id] ?? id; },
      managerOf: async (rid) => managers.get(rid) ?? `roster ${rid}`,
      waiverPosition: async () => ({ position: fx.rosters.find((r) => r.roster_id === ME)!.settings.waiver_position!, of: fx.rosters.length }),
    });
    return { run, seen, events, order };
  };
  test("the Nix claim is one claim-landed event with names, drop, time and the new priority, marked seen before it is written", async () => {
    const h = harness(legs(7, 6));
    await h.run();
    const nix = h.events.find((e) => e.detail.transactionId === "1418262744104247296")!;
    expect(nix.type).toBe("claim-landed");
    expect(nix.summary).toBe("Waiver claim landed: Bo Nix added, Jacksonville Jaguars dropped (processed Wed 10/21 03:16 ET); waiver priority now 8 of 8.");
    expect(nix.detail).toMatchObject({ add: "11563", drop: "JAX", leg: 6, processedAt: "2026-10-21T07:16:03.715Z", waiverPosition: { position: 8, of: 8 }, winnerRosterId: null });
    expect(h.order.indexOf("seen:claim:1418262744104247296")).toBeLessThan(h.order.indexOf("log:1418262744104247296"));
    expect(h.events.map((e) => e.detail.transactionId)).toEqual(["1416519976465997824", "1418262744104247296"]);
  });
  test("a second pass logs nothing (idempotent across restarts)", async () => {
    const h = harness(legs(7, 6));
    await h.run();
    expect(await h.run()).toEqual([]);
    expect(h.events).toHaveLength(2);
  });
  test("the lost Cincinnati claim is claim-lost with Sleeper's note and the manager who won him", async () => {
    const h = harness(legs(4));
    await h.run();
    const cin = h.events.find((e) => e.type === "claim-lost")!;
    expect(cin.summary).toBe('Waiver claim lost: Cincinnati Bengals, no drop (processed Wed 10/07 03:15 ET). Sleeper: "This player was claimed by another owner." Won by Majoma (roster 5).');
    expect(cin.detail).toMatchObject({ transactionId: "1413195928436817920", winnerRosterId: 5, waiverPosition: null });
    expect(h.seen.get("claim:1413195928436817920")).toBe("lost");
  });
  test("a name lookup that throws still logs, by id", async () => {
    const h = harness(legs(7, 6), { brokenNames: true });
    await h.run();
    expect(h.events[1]!.summary).toContain("11563 added, JAX dropped");
  });
  test("a lost claim with no note from Sleeper has no empty quote", async () => {
    const cin = legs(4).find((t) => t.transaction_id === "1413195928436817920")!;
    const h = harness([{ ...cin, metadata: null }]);
    await h.run();
    expect(h.events[0]!.summary).toBe("Waiver claim lost: Cincinnati Bengals, no drop (processed Wed 10/07 03:15 ET).");
  });
});
