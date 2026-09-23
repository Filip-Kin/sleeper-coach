import { test, expect } from "bun:test";
import { emptyStarterPositions, streamNeeds, pickStreamer } from "./streaming.ts";

const P = (name: string, position: string, points: number, bye?: number, injuryStatus?: string) =>
  ({ name, position, points, bye, injuryStatus });

// A full, legal roster: one kicker (bye 6), one defense (bye 11), depth elsewhere.
const roster = [
  P("Hurts","QB",310), P("Prescott","QB",300), P("CMC","RB",291), P("Brown","RB",255),
  P("Walker","RB",244), P("Etienne","RB",207), P("Collins","WR",262), P("Smith","WR",229),
  P("Evans","WR",222), P("Reed","WR",198), P("LaPorta","TE",196), P("Andrews","TE",163),
  P("Bates","K",44,6), P("SEA","DEF",30,11),
];

test("a week with no byes has no empty slots", () => {
  expect(emptyStarterPositions(roster, 3)).toEqual([]);
});

test("the kicker's bye week leaves the K slot empty", () => {
  expect(emptyStarterPositions(roster, 6)).toEqual(["K"]);
});

test("the defense's bye week leaves the DEF slot empty", () => {
  expect(emptyStarterPositions(roster, 11)).toEqual(["DEF"]);
});

test("an OUT kicker also triggers a need, not just a bye", () => {
  const hurt = roster.map((p) => p.name === "Bates" ? { ...p, injuryStatus: "OUT" } : p);
  expect(emptyStarterPositions(hurt, 3)).toEqual(["K"]);
});

test("streamNeeds scans a window and reports the week and who it covers for", () => {
  const needs = streamNeeds(roster, 5, 4); // weeks 5,6,7,8
  const k = needs.find((n) => n.position === "K");
  expect(k?.week).toBe(6);
  expect(k?.coveringFor).toEqual(["Bates"]);
});

test("no need is raised for a position we have depth at", () => {
  // Two kickers, one on bye: the other covers, no need.
  const twoK = [...roster, P("Backup K","K",30,10)];
  expect(streamNeeds(twoK, 5, 3).some((n) => n.position === "K")).toBe(false);
});

// R4. A streamer is a one-week fill, so he is ranked on THAT week's projection
// and must not himself be on bye that week. Rest-of-season points put a kicker
// on his own bye at the top of the list on 2026-09-22.
test("pickStreamer ranks on the need week's points and skips a bye", () => {
  const avail = [
    { name: "Streamer K1", position: "K", weekPoints: 9, bye: 6 },   // best ROS, but on bye in week 6
    { name: "Streamer K2", position: "K", weekPoints: 7, bye: 10 },
    { name: "Streamer K3", position: "K", weekPoints: 8, bye: 11 },
    { name: "Some WR", position: "WR", weekPoints: 20, bye: 12 },
  ];
  const pick = pickStreamer({ week: 6, position: "K", coveringFor: ["Bates"] }, avail);
  expect(pick?.add).toBe("Streamer K3");
  expect(pick?.points).toBe(8);
});

test("pickStreamer never picks a player on bye in the need week", () => {
  const avail = [{ name: "Only K", position: "K", weekPoints: 9, bye: 6 }];
  expect(pickStreamer({ week: 6, position: "K", coveringFor: [] }, avail)).toBeNull();
});

test("pickStreamer skips a zero projection for the week", () => {
  const avail = [{ name: "Idle K", position: "K", weekPoints: 0, bye: 10 }];
  expect(pickStreamer({ week: 6, position: "K", coveringFor: [] }, avail)).toBeNull();
});

test("pickStreamer returns null when nobody at that position is available", () => {
  expect(pickStreamer({ week: 6, position: "K", coveringFor: [] }, [{ name: "X", position: "WR", weekPoints: 1, bye: 9 }])).toBeNull();
});
