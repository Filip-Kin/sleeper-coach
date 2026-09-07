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

test("pickStreamer takes the best available body at the needed position", () => {
  const avail = [
    { name: "Streamer K1", position: "K", points: 40 },
    { name: "Streamer K2", position: "K", points: 48 },
    { name: "Some WR", position: "WR", points: 120 },
  ];
  const pick = pickStreamer({ week: 6, position: "K", coveringFor: ["Bates"] }, avail);
  expect(pick?.add).toBe("Streamer K2");
});

test("pickStreamer returns null when nobody at that position is available", () => {
  expect(pickStreamer({ week: 6, position: "K", coveringFor: [] }, [{ name: "X", position: "WR", points: 1 }])).toBeNull();
});
