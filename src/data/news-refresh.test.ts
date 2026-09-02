import { test, expect } from "bun:test";
import { dossierFromDump, validateWebEntries, merge } from "./news-refresh.ts";

const dump = {
  "1": { full_name: "Josh Jacobs", position: "RB", status: "Active", injury_status: "NA", depth_chart_order: 4 },
  "2": { full_name: "Healthy Guy", position: "WR", status: "Active", injury_status: null, depth_chart_order: 1 },
  "3": { full_name: "Buried Back", position: "RB", status: "Active", injury_status: null, depth_chart_order: 3 },
  "4": { full_name: "Banged Up", position: "TE", status: "Active", injury_status: "Questionable", injury_notes: "ankle" },
  "5": { full_name: "Retired Man", position: "QB", status: "Inactive", injury_status: null },
  "6": { full_name: "Not Watched", position: "RB", status: "Active", injury_status: "Out" },
  "7": { full_name: "Buried Kicker", position: "K", status: "Active", injury_status: null, depth_chart_order: 3 },
};
const watch = new Set(["1", "2", "3", "4", "5", "7"]);

test("the dump layer catches the Jacobs shape on its own", () => {
  const d = dossierFromDump(dump as never, watch);
  expect(d["Josh Jacobs"]?.status).toBe("out");
  expect(d["Josh Jacobs"]?.source).toBe("dump");
});

test("a healthy starter gets no entry", () => {
  expect(dossierFromDump(dump as never, watch)["Healthy Guy"]).toBeUndefined();
});

test("buried on the depth chart is a risk with a multiplier; kickers are not", () => {
  const d = dossierFromDump(dump as never, watch);
  expect(d["Buried Back"]?.status).toBe("risk");
  expect(d["Buried Back"]?.multiplier).toBeLessThan(1);
  expect(d["Buried Kicker"]).toBeUndefined();
});

test("questionable is a watch that carries the note; inactive is out", () => {
  const d = dossierFromDump(dump as never, watch);
  expect(d["Banged Up"]?.status).toBe("watch");
  expect(d["Banged Up"]?.note).toContain("ankle");
  expect(d["Retired Man"]?.status).toBe("out");
});

test("players outside the watch set are ignored, so the file stays small", () => {
  expect(dossierFromDump(dump as never, watch)["Not Watched"]).toBeUndefined();
});

test("web entries are validated, never repaired", () => {
  const known = new Set(["Josh Jacobs", "Healthy Guy"]);
  const d = validateWebEntries({ players: [
    { name: "Josh Jacobs", status: "out", note: "Suspended 2 Sep pending legal case.", multiplier: 0.05 },
    { name: "Healthy Guy", status: "watch", note: "Limited practice 1 Sep.", multiplier: 7 },   // clamped
    { name: "Made Up Player", status: "out", note: "x" },                                        // unknown name
    { name: "Josh Jacobs", status: "cursed", note: "x" },                                        // bad status (overwrites? no: dropped)
    { name: "Healthy Guy", status: "risk" },                                                     // no note
  ] }, known);
  expect(d["Josh Jacobs"]?.status).toBe("out");
  expect(d["Healthy Guy"]?.multiplier).toBe(1);
  expect(d["Made Up Player"]).toBeUndefined();
  expect(Object.keys(d).length).toBe(2);
});

test("garbage from the agent yields an empty layer, not a crash", () => {
  expect(validateWebEntries("not json at all", new Set())).toEqual({});
  expect(validateWebEntries(null, new Set())).toEqual({});
  expect(validateWebEntries({ players: "nope" }, new Set())).toEqual({});
});

test("the web layer wins over the dump for the same player, because it knows why", () => {
  const m = merge(
    { "Josh Jacobs": { status: "risk", note: "depth chart", multiplier: 0.7, source: "dump" } },
    { "Josh Jacobs": { status: "out", note: "suspended", source: "web" } },
  );
  expect(m["Josh Jacobs"]?.status).toBe("out");
  expect(m["Josh Jacobs"]?.source).toBe("web");
});
