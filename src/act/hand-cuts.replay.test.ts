// Replay of Tuesday 2026-10-27 09:20 ET (week 8) on the league as captured
// then (incidents/league-2026-10-27.json). Ka'imi Fairbairn, our only
// kicker, is on the week-8 leg at K on his bye (77.9 ROS, 0 this week); the
// 02:01 shadow run planned the stream `McPherson for Fairbairn, swap, via
// claim` (86.4 ROS, 9.2 this week) and the 20:00 claim job files it. The
// hand tool, asked the same move dry, answered "Ka'imi Fairbairn is not a
// legal cut": keptStarters keeps a kicker unless a better ROSTERED kicker
// can fill his slot, and the hand tool knew no other way for him to leave.
//
// The rule (act/hand-cuts.ts): a starting kicker or defense who is off this
// week is the drop for a newcomer at his position who plays it, exactly
// where planStream swaps him (the need week itself); before the need week,
// for a kicker who plays, for a newcomer who does not, at another position,
// for a plain drop, or with no week table, he stays kept.
import { describe, expect, test } from "bun:test";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-10-27.json";
import { notPlaying } from "../analysis/value.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { handLegalCuts } from "./hand-cuts.ts";

const { fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const WEEK = 8;
const BASE = { week: WEEK, pendingDrops: [] as string[] };
const mine = ourRoster();
const FAIRBAIRN = idOf("Ka'imi Fairbairn");
const MCPHERSON = idOf("Evan McPherson");
const SEA = idOf("Seattle Seahawks");

// roster-move.ts: the rail is the ACTIVE roster (Hurts and Etienne on IR are not on it).
const roster: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id));
const starters = mine.starters.map((id) => fx(id).name);
const newcomer = (id: string): RailPlayer => tradePlayer(id);

// startableThisWeek on a Tuesday morning (nothing kicked off): a body with a
// game and points in the week's table, not ruled out by his live status.
const playsWeek = (w: number) => (body: RailPlayer): boolean => (fx(body.playerId!).weekly[String(w)] ?? 0) > 0 && !notPlaying(body.injuryStatus);
const canFill = playsWeek(WEEK);

describe("the hand tool's cuts on 2026-10-27", () => {
  test("the shadow run's swap: Fairbairn, off in week 8, is the legal drop for McPherson, who plays it", () => {
    const r = handLegalCuts({ ...BASE, roster, starters, canFill, newcomer: newcomer(MCPHERSON) });
    expect(r.covered.map((p) => p.playerId)).toEqual([FAIRBAIRN]);
    expect(r.kept.has("ka'imi fairbairn")).toBe(false);
    // The cheapest cut at his position (the only kicker): the swap is judged there.
    expect(r.cuts.filter((p) => p.position === "K")[0]?.playerId).toBe(FAIRBAIRN);
    // Seattle plays week 8 and stays kept; so does every skill starter.
    expect(r.kept.has("seattle seahawks")).toBe(true);
    expect(r.cuts.some((p) => p.playerId === SEA)).toBe(false);
  });

  test("the same move with no newcomer (a plain drop) keeps him: nobody takes the slot", () => {
    const r = handLegalCuts({ ...BASE, roster, starters, canFill });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("a newcomer at another position covers nothing: Fairbairn stays kept", () => {
    const rb = Object.values((raw as { players: Record<string, { playerId: string; position: string }> }).players)
      .find((p) => p.position === "RB" && !mine.players.includes(p.playerId))!;
    const r = handLegalCuts({ ...BASE, roster, starters, canFill, newcomer: newcomer(rb.playerId) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("before the need week he plays for us and stays kept (week 9: both play)", () => {
    const r = handLegalCuts({ ...BASE, week: 9, roster, starters, canFill: playsWeek(9), newcomer: newcomer(MCPHERSON) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("a kicker who does not play this week himself covers nothing", () => {
    // Daniel Carlson (NO) and Eddy Pineiro (SF) share Fairbairn's week-8 bye.
    const r = handLegalCuts({ ...BASE, roster, starters, canFill, newcomer: newcomer(idOf("Daniel Carlson")) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("no week table: nobody fills a slot and every starter is kept", () => {
    const r = handLegalCuts({ ...BASE, roster, starters, canFill: () => false, newcomer: newcomer(MCPHERSON) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
    for (const n of starters) expect(r.kept.has(n.toLowerCase())).toBe(true);
  });

  test("a pending claim's drop neither leaves nor fills nor is covered", () => {
    const r = handLegalCuts({ ...BASE, pendingDrops: [FAIRBAIRN], roster, starters, canFill, newcomer: newcomer(MCPHERSON) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("a missing or zero table row is unknown, not off: a kicker not on bye and healthy is kept", () => {
    // Fairbairn as if his bye were week 9: the week-8 table still has him at
    // 0, but the engine's coveringFor (bye or status) does not name him.
    const notBye = roster.map((p) => (p.playerId === FAIRBAIRN ? { ...p, bye: 9 } : p));
    const r = handLegalCuts({ ...BASE, roster: notBye, starters, canFill, newcomer: newcomer(MCPHERSON) });
    expect(r.covered).toEqual([]);
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });

  test("a rostered kicker who plays is the spare, not a stream: the bye starter stays kept and the spare is the cut", () => {
    // Nick Folk (70.1 ROS, plays week 8) on our bench: the slot would start
    // him, so there is no empty-slot need (streaming.ts emptyStarterPositions)
    // and the planner's spare rule applies instead.
    const FOLK = idOf("Nick Folk");
    const withSpare = [...roster, tradePlayer(FOLK)];
    const r = handLegalCuts({ ...BASE, roster: withSpare, starters, canFill, newcomer: newcomer(MCPHERSON) });
    expect(r.covered).toEqual([]);
    expect(r.kept.has("ka'imi fairbairn")).toBe(true);
    expect(r.cuts.filter((p) => p.position === "K").map((p) => p.playerId)).toEqual([FOLK]);
  });

  test("a defense the same way: Seattle off this week is the drop for a defense who plays it", () => {
    const offSea = (body: RailPlayer): boolean => body.playerId === SEA ? false : canFill(body);
    const free = Object.values((raw as { players: Record<string, { playerId: string; position: string; weekly: Record<string, number> }> }).players)
      .find((p) => p.position === "DEF" && !mine.players.includes(p.playerId) && (p.weekly[String(WEEK)] ?? 0) > 0)!;
    const offRoster = roster.map((p) => (p.playerId === SEA ? { ...p, bye: WEEK } : p));
    const r = handLegalCuts({ ...BASE, roster: offRoster, starters, canFill: offSea, newcomer: newcomer(free.playerId) });
    expect(r.covered.map((p) => p.playerId)).toEqual([SEA]);
    expect(r.cuts.filter((p) => p.position === "DEF")[0]?.playerId).toBe(SEA);
    // The kicker on bye is not the defense newcomer's cover: same position only.
    expect(r.cuts.some((p) => p.playerId === FAIRBAIRN)).toBe(false);
  });
});
