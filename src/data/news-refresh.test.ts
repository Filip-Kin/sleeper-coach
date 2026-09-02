import { test, expect } from "bun:test";
import { dossierFromDump, validateWebEntries, merge, watchSet, extractJson, capUncorroborated } from "./news-refresh.ts";

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
    { name: "Josh Jacobs", status: "out", note: "Suspended 2 Sep pending legal case.", multiplier: 0.05, source: "https://example.com/report" },
    { name: "Healthy Guy", status: "watch", note: "Limited practice 1 Sep.", multiplier: 7 },   // clamped; watch needs no source
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

test("the web can make a player worse, and supplies the reason", () => {
  const m = merge(
    { "Josh Jacobs": { status: "risk", note: "depth chart", multiplier: 0.7, source: "dump" } },
    { "Josh Jacobs": { status: "out", note: "suspended", source: "web" } },
  );
  expect(m["Josh Jacobs"]?.status).toBe("out");
  expect(m["Josh Jacobs"]?.note).toBe("suspended");
});

test("the web can NEVER soften a hard flag from Sleeper", () => {
  // The first real run un-outed nine players this way. Sleeper says NA, an
  // article says risk: the player stays out, and the article becomes the why.
  const m = merge(
    { "Josh Jacobs": { status: "out", note: "Sleeper lists him NA.", source: "dump" } },
    { "Josh Jacobs": { status: "risk", note: "Suspension review still open, per 1 Sep report.", multiplier: 0.6, source: "web" } },
  );
  expect(m["Josh Jacobs"]?.status).toBe("out");
  expect(m["Josh Jacobs"]?.note).toContain("Sleeper lists him NA");
  expect(m["Josh Jacobs"]?.note).toContain("Suspension review");
});

test("the lower multiplier wins when both sides give one", () => {
  const m = merge(
    { "A": { status: "risk", note: "d", multiplier: 0.7, source: "dump" } },
    { "A": { status: "risk", note: "w", multiplier: 0.5, source: "web" } },
  );
  expect(m["A"]?.multiplier).toBe(0.5);
});

test("the free-agent pool excludes retired and teamless players, however well ranked", () => {
  const d = {
    "r1": { full_name: "Rostered", position: "WR", status: "Active", team: "SEA", search_rank: 500 },
    "a1": { full_name: "Live FA", position: "RB", status: "Active", team: "GB", search_rank: 40 },
    "x1": { full_name: "Drew Brees", position: "QB", status: "Inactive", team: null, search_rank: 10 },
    "x2": { full_name: "Teamless", position: "WR", status: "Active", team: null, search_rank: 12 },
    "k1": { full_name: "A Kicker", position: "K", status: "Active", team: "DAL", search_rank: 5 },
  };
  const w = watchSet(d as never, ["r1"]);
  expect(w.has("r1")).toBe(true);
  expect(w.has("a1")).toBe(true);
  expect(w.has("x1")).toBe(false);
  expect(w.has("x2")).toBe(false);
  expect(w.has("k1")).toBe(false);
});

test("the JSON is found even when the agent narrates around it", () => {
  const prose = 'I need to verify these claims first. Fetching trackers...\n\nDone. {"players":[{"name":"A","status":"watch","note":"x"}]}\nThat is everything.';
  expect((extractJson(prose) as { players: unknown[] }).players.length).toBe(1);
  expect(extractJson("no json here at all")).toBeNull();
  expect(extractJson('{"other":1} then {"players":[]}')).toEqual({ players: [] });
});

test("out or risk without a source URL is discarded; watch is fine without one", () => {
  const d = validateWebEntries({ players: [
    { name: "A", status: "out", note: "hallucinated" },
    { name: "B", status: "risk", note: "also", source: "not a url" },
    { name: "C", status: "risk", note: "real", source: "https://x.y/z" },
    { name: "D", status: "watch", note: "fine" },
  ] }, new Set(["A", "B", "C", "D"]));
  expect(Object.keys(d).sort()).toEqual(["C", "D"]);
  expect(d["C"]?.note).toContain("https://x.y/z");
});

test("the web alone cannot declare a healthy player out", () => {
  // The most damaging hallucination: out means a 0.05 multiplier, and the coach
  // would give a healthy starter away for nothing. Capped at risk.
  const w = { status: "out", note: "x", multiplier: 0.05, source: "web" } as const;
  const capped = capUncorroborated(w, undefined);
  expect(capped.status).toBe("risk");
  expect(capped.multiplier).toBeGreaterThanOrEqual(0.5);
  // Sleeper corroborates: the cap lifts.
  expect(capUncorroborated(w, { status: "out", note: "NA", source: "dump" }).status).toBe("out");
  expect(capUncorroborated(w, { status: "risk", note: "depth", source: "dump" }).status).toBe("out");
  // And merge applies it.
  const m = merge({}, { "Healthy": { status: "out", note: "fake", multiplier: 0.05, source: "web" } });
  expect(m["Healthy"]?.status).toBe("risk");
});
