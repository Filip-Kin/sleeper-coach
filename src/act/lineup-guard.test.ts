import { describe, expect, test } from "bun:test";
import { planLineup, parseTeamKickoffs, overlayRosterStatus, lockedPlayerIds, kickoffCacheIsCurrent, readKickoffCache, cachedTeamKickoffs } from "./lineup-guard.ts";
import { KICKOFF_CACHE } from "../paths.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LineupPlayer } from "../analysis/lineup.ts";
import type { PlayersMap } from "../sleeper/types.ts";

const P = (playerId: string, position: string, points: number, injuryStatus: string | null = null, extra: Partial<LineupPlayer> & { team?: string } = {}): LineupPlayer =>
  ({ playerId, name: `P${playerId}`, position, points, injuryStatus, onBye: false, inactive: false, ...extra }) as LineupPlayer;

const SLOTS = ["QB", "RB", "RB", "WR", "FLEX", "K", "DEF"];
const roster = () => [
  P("q1", "QB", 20), P("q2", "QB", 15),
  P("r1", "RB", 14), P("r2", "RB", 12), P("r3", "RB", 9),
  P("w1", "WR", 13), P("w2", "WR", 10),
  P("k1", "K", 8), P("SEA", "DEF", 7),
];
const CURRENT = ["q1", "r1", "r2", "w1", "w2", "k1", "SEA"];

describe("planLineup swap margin", () => {
  const withQ2 = (pts: number) => roster().map((p) => (p.playerId === "q2" ? { ...p, points: pts } : p));
  test("an edge inside the margin leaves the incumbent in (Hurts 18.7, Prescott 18.8)", () => {
    const plan = planLineup(CURRENT, withQ2(20.1), SLOTS, new Set(), 1);
    expect(plan.changed).toBe(false);
    expect(plan.ids[0]).toBe("q1");
  });
  test("an edge past the margin swaps, and the label shows the real projection", () => {
    const plan = planLineup(CURRENT, withQ2(21.5), SLOTS, new Set(), 1);
    expect(plan.changed).toBe(true);
    expect(plan.ids[0]).toBe("q2");
    expect(plan.swaps[0]?.out).toBe("Pq1 20.0");
    expect(plan.swaps[0]?.in).toBe("Pq2 21.5");
  });
  test("an Out starter is replaced whatever the margin says", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(), 5);
    expect(plan.ids).not.toContain("r1");
    expect(plan.ids).toContain("r3");
  });
  test("a starter projected at zero gets no protection", () => {
    const rs = roster().map((p) => (p.playerId === "w2" ? { ...p, points: 0 } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(), 1);
    expect(plan.ids).not.toContain("w2");
    expect(plan.ids).toContain("r3");
  });
  test("a forced swap does not drag a marginal one along with it", () => {
    const rs = withQ2(20.1).map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(), 1);
    expect(plan.ids[0]).toBe("q1");
    expect(plan.ids).toContain("r3");
    expect(plan.swaps.length).toBe(1);
  });
  test("margin 0 is the old behaviour", () => {
    expect(planLineup(CURRENT, withQ2(20.1), SLOTS, new Set(), 0).ids[0]).toBe("q2");
  });
});

describe("planLineup", () => {
  test("optimal lineup already set means no change", () => {
    const plan = planLineup(CURRENT, roster(), SLOTS, new Set());
    expect(plan.changed).toBe(false);
    expect(plan.ids).toEqual(CURRENT);
  });

  test("a starter who goes Out is replaced by the best bench body", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids).not.toContain("r1");
    expect(plan.ids).toContain("r3");
    expect(plan.swaps[0]?.why).toContain("Out");
  });

  test("a player back from Out who outscores his fill-in is restored", () => {
    // Site currently has r3 in for r1 (r1 was Out last lock); now r1 is healthy.
    const current = ["q1", "r3", "r2", "w1", "w2", "k1", "SEA"];
    const plan = planLineup(current, roster(), SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids).toContain("r1");
    expect(plan.ids).not.toContain("r3");
  });

  test("Questionable still starts", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Questionable" } : p));
    expect(planLineup(CURRENT, rs, SLOTS, new Set()).changed).toBe(false);
  });

  test("a locked Out starter stays; a locked bench player never comes in", () => {
    const rs = roster().map((p) => (p.playerId === "r1" ? { ...p, injuryStatus: "Out" } : p));
    // r1's game has kicked off, and so has r3's.
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(["r1", "r3"]));
    expect(plan.changed).toBe(false);
    expect(plan.ids[1]).toBe("r1");
  });

  test("locked starter pinned while an unlocked slot still gets fixed", () => {
    const rs = roster().map((p) => (p.playerId === "w1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set(["q1"]));
    expect(plan.changed).toBe(true);
    expect(plan.ids[0]).toBe("q1");
    expect(plan.ids).not.toContain("w1");
    expect(plan.ids).toContain("r3"); // r3 fills FLEX, w2 moves to WR
  });

  test("permuting two like slots is not a change", () => {
    const slots = ["RB", "RB"];
    const plan = planLineup(["r2", "r1"], [P("r1", "RB", 14), P("r2", "RB", 12)], slots, new Set());
    expect(plan.changed).toBe(false);
  });

  test("an Out kicker with no replacement keeps his slot rather than emptying it", () => {
    const rs = roster().map((p) => (p.playerId === "k1" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.changed).toBe(false);
    expect(plan.ids[5]).toBe("k1");
    expect(plan.unfilled).toEqual(["K"]);
  });

  test("never empties a slot whose active occupant merely has no replacement", () => {
    // An Out kicker with nobody behind him stays put (see the test above); the
    // rule that matters is that an ACTIVE occupant is kept, not a phantom.
    const rs = roster().map((p) => (p.playerId === "SEA" ? { ...p, injuryStatus: "Out" } : p));
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.ids[6]).toBe("SEA");
  });

  // R9. An occupant who is not on the active roster (dropped, traded, or parked
  // on IR while still listed as a starter) is a phantom, and a phantom is an
  // empty slot: fill it if we can, and write it empty if we cannot, because
  // Sleeper is already scoring it as empty.
  test("an occupant not in the active set is treated as an empty slot and filled", () => {
    const current = ["q1", "IRGUY", "r2", "w1", "w2", "k1", "SEA"];
    const plan = planLineup(current, roster(), SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids).not.toContain("IRGUY");
    expect(plan.ids[1]).toBe("r1");
  });
  test("a phantom with no replacement is written empty", () => {
    const rs = roster().filter((p) => p.playerId !== "SEA");
    const plan = planLineup(CURRENT, rs, SLOTS, new Set());
    expect(plan.changed).toBe(true);
    expect(plan.ids[6]).toBe("0");
  });
});

describe("parseTeamKickoffs", () => {
  test("maps both teams of each game to its kickoff", () => {
    const m = parseTeamKickoffs({ games: [{ startTime: 100, label: "CHI@CAR" }, { startTime: 200, label: "LAR@SF" }, { startTime: 0, label: "X@Y" }, { label: "bad" }] });
    expect(m.get("CHI")).toBe(100);
    expect(m.get("CAR")).toBe(100);
    expect(m.get("SF")).toBe(200);
    expect(m.size).toBe(4);
  });
  test("tolerates a missing cache", () => {
    expect(parseTeamKickoffs(null).size).toBe(0);
  });
});

describe("the kickoff cache is only trusted for the week it was built for", () => {
  // 2026-09-30: a week-4 cache on a week-5 Wednesday said every game had
  // kicked off. Every player pinned, every dropped player "on waivers".
  test("kickoffCacheIsCurrent wants an exact week match; no week is stale", () => {
    expect(kickoffCacheIsCurrent({ week: 5, games: [] }, 5)).toBe(true);
    expect(kickoffCacheIsCurrent({ week: 4, games: [] }, 5)).toBe(false);
    expect(kickoffCacheIsCurrent({ games: [] }, 5)).toBe(false);
    expect(kickoffCacheIsCurrent(null, 5)).toBe(false);
  });
  test("a stale file reads as no cache: empty map, nobody locked", async () => {
    mkdirSync(dirname(KICKOFF_CACHE), { recursive: true });
    const past = Date.now() - 3 * 86_400_000;
    writeFileSync(KICKOFF_CACHE, JSON.stringify({ week: 4, games: [{ startTime: past, label: "CHI@CAR" }] }));
    expect(await readKickoffCache(5)).toBeNull();
    expect((await cachedTeamKickoffs(5)).size).toBe(0);
    expect(lockedPlayerIds([{ playerId: "1", team: "CHI" }], await cachedTeamKickoffs(5), Date.now()).size).toBe(0);
    // The same file is the truth for its own week.
    expect((await cachedTeamKickoffs(4)).get("CHI")).toBe(past);
    rmSync(KICKOFF_CACHE, { force: true });
  });
});

describe("overlayRosterStatus", () => {
  const dump: PlayersMap = {
    "1": { player_id: "1", first_name: "A", last_name: "B", position: "WR", fantasy_positions: ["WR"], team: "GB", age: 1, years_exp: 1, status: "Active", injury_status: "Questionable", injury_notes: null, search_rank: 5 },
  };
  test("live null status beats the dump's stale Questionable", () => {
    const out = overlayRosterStatus(dump, { player_map: { "1": { player_id: "1", first_name: "A", last_name: "B", position: "WR", fantasy_positions: ["WR"], team: "GB", status: "Active", injury_status: null, news_updated: 1 } } });
    expect(out["1"]?.injury_status).toBeNull();
    expect(out["1"]?.search_rank).toBe(5); // dump fields kept
    expect(dump["1"]?.injury_status).toBe("Questionable"); // pure
  });
  test("a player missing from the dump is built from the map", () => {
    const out = overlayRosterStatus({}, { player_map: { "9": { player_id: "9", first_name: "New", last_name: "Guy", position: "RB", fantasy_positions: ["RB"], team: "DET", status: "Active", injury_status: "Out", news_updated: null } } });
    expect(out["9"]?.position).toBe("RB");
    expect(out["9"]?.full_name).toBe("New Guy");
    expect(out["9"]?.injury_status).toBe("Out");
  });
  test("no player_map means the dump is returned as is", () => {
    expect(overlayRosterStatus(dump, {})).toBe(dump);
  });
});

describe("lockedPlayerIds", () => {
  const cands = [
    { playerId: "a", team: "SF" },   // Thursday, already played
    { playerId: "b", team: "CAR" },  // Sunday
    { playerId: "c", team: "ZZZ" },  // no cached kickoff
  ];
  const kick = new Map([["SF", 1_000], ["CAR", 5_000]]);
  test("only players whose game has kicked off are locked", () => {
    const l = lockedPlayerIds(cands, kick, 2_000);
    expect([...l]).toEqual(["a"]);
  });
  test("a team with no cached kickoff is treated as unlocked", () => {
    expect(lockedPlayerIds(cands, kick, 9_999).has("c")).toBe(false);
  });
  test("nothing is locked before the first kickoff", () => {
    expect(lockedPlayerIds(cands, kick, 500).size).toBe(0);
  });
});

// The case the scheduled locks used to get wrong. A Thursday player banks his
// points, then gets an injury tag on Friday. The 11:00 Sunday lock must not
// try to bench him, because Sleeper will not move him and the points are real.
describe("a player who already played is never benched by a later solve", () => {
  const SLOTS = ["QB", "RB", "RB", "WR", "K", "DEF"];
  const roster = [
    P("q1", "QB", 20), P("thu", "RB", 19.6, "Out", { team: "SF" }),
    P("r1", "RB", 17), P("r2", "RB", 15), P("w1", "WR", 13),
    P("k1", "K", 8), P("SEA", "DEF", 7),
  ];
  const current = ["q1", "thu", "r1", "w1", "k1", "SEA"];
  test("unlocked, the solver would bench the Out player", () => {
    const plan = planLineup(current, roster, SLOTS, new Set());
    expect(plan.ids).not.toContain("thu");
  });
  test("locked, he keeps his slot and his points", () => {
    const plan = planLineup(current, roster, SLOTS, new Set(["thu"]));
    expect(plan.ids[1]).toBe("thu");
    expect(plan.changed).toBe(false);
  });
});

// 2026-10-04, week 4. Washington played in London at 09:30 ET. Mike Evans
// (Questionable, ribs) played at 16:25 ET, and the 49ers' inactives were due
// at about 14:55. Every bench player who could take his slot kicked off before
// that, so a late scratch would have scored zero with nobody left to bring in.
// The guard had Evans (14.0) over Croskey-Merritt (13.3) and the review moved
// it by hand eleven minutes before the London kickoff.
describe("a Questionable starter whose replacements lock before his inactives are known", () => {
  const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
  const T = (iso: string) => Date.parse(iso);
  const LONDON = T("2026-10-04T13:30:00Z"), EARLY = T("2026-10-04T17:00:00Z"), LATE = T("2026-10-04T20:25:00Z");
  const kickoffs = new Map<string, number>([
    ["WAS", LONDON], ["IND", LONDON], ["DAL", EARLY], ["KC", LATE], ["SF", LATE], ["HOU", EARLY], ["PHI", EARLY],
    ["DET", T("2026-10-05T00:20:00Z")], ["CIN", EARLY], ["BAL", EARLY], ["SEA", LATE],
  ]);
  const week4 = (evans = 14.04, evansStatus: string | null = "Questionable") => [
    P("dak", "QB", 18.3, null, { team: "DAL" }), P("hurts", "QB", 16.56, null, { team: "PHI" }),
    P("walker", "RB", 19.9, null, { team: "KC" }), P("cmc", "RB", 18.8, null, { team: "SF" }),
    P("brown", "RB", 17.4, null, { team: "CIN" }), P("jcm", "RB", 13.32, null, { team: "WAS" }),
    P("collins", "WR", 18.6, null, { team: "HOU" }), P("evans", "WR", evans, evansStatus, { team: "SF" }),
    P("downs", "WR", 13.84, null, { team: "IND" }), P("smith", "WR", 12, "Out", { team: "PHI" }),
    P("laporta", "TE", 11.3, null, { team: "DET" }), P("andrews", "TE", 9.77, null, { team: "BAL" }),
    P("bates", "K", 7.7, null, { team: "DET" }), P("SEA", "DEF", 8.8, null, { team: "SEA" }),
  ];
  const CURRENT = ["dak", "walker", "cmc", "collins", "evans", "laporta", "brown", "downs", "bates", "SEA"];
  const at = (iso: string) => ({ kickoffs, now: T(iso) });

  test("without kickoff knowledge the plan is the old one: Evans starts", () => {
    expect(planLineup(CURRENT, week4(), SLOTS, new Set()).changed).toBe(false);
  });
  test("twenty minutes before the London kickoff, Croskey-Merritt takes the slot", () => {
    const plan = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z"));
    expect(plan.changed).toBe(true);
    expect(plan.ids).toContain("jcm");
    expect(plan.ids).not.toContain("evans");
    expect(plan.ids.filter((id) => id !== "0").length).toBe(10);
    expect(plan.swaps.some((s) => /Questionable/.test(s.why))).toBe(true);
  });
  test("the next poll leaves that lineup alone", () => {
    const first = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z"));
    expect(planLineup(first.ids, week4(), SLOTS, new Set(), 1, at("2026-10-04T13:12:00Z")).changed).toBe(false);
  });
  test("after the lock it stays, and Evans cleared does not undo it", () => {
    const first = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z"));
    const locked = new Set(["jcm", "downs"]);
    expect(planLineup(first.ids, week4(14.04, null), SLOTS, locked, 1, at("2026-10-04T13:40:00Z")).changed).toBe(false);
  });
  test("hours before anything locks, nothing is decided yet", () => {
    expect(planLineup(CURRENT, week4(), SLOTS, new Set(), 1, at("2026-10-04T11:00:00Z")).changed).toBe(false);
  });
  test("a healthy Evans is not touched", () => {
    expect(planLineup(CURRENT, week4(14.04, null), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z")).changed).toBe(false);
  });
  test("a Questionable star still starts over a much weaker early body", () => {
    expect(planLineup(CURRENT, week4(20), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z")).changed).toBe(false);
  });
  test("a replacement who is still unlocked when the inactives land is the hedge, so Evans starts", () => {
    const late = new Map(kickoffs); late.set("WAS", LATE); late.set("IND", LATE);
    // Nothing locks in the next half hour, and Croskey-Merritt is there at 14:55.
    expect(planLineup(CURRENT, week4(), SLOTS, new Set(), 1, { kickoffs: late, now: T("2026-10-04T16:40:00Z") }).changed).toBe(false);
  });
  test("a later fallback counts toward his expected score", () => {
    // Andrews (9.77) in the late window: 0.75 x 14.04 + 0.25 x 9.77 + 1 = 13.97, over 13.32.
    const k = new Map(kickoffs); k.set("BAL", LATE);
    const plan = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, { kickoffs: k, now: T("2026-10-04T13:10:00Z") });
    // Same ten starters, and no write that only trades the WR and FLEX seats.
    expect(plan.changed).toBe(false);
    expect(plan.ids).toEqual(CURRENT);
  });
  // Reviewer's replay: LaPorta Questionable on Sunday night, Andrews at 13:00.
  // Croskey-Merritt's London lock decides nothing about the TE seat, and the
  // first version benched LaPorta at 09:00, put him back at 09:30 and benched
  // him again at 12:30.
  test("a lock that cannot take his seat decides nothing; only the locking player may come in", () => {
    const rs = () => week4(14.04, null).map((p) => (p.playerId === "laporta" ? { ...p, injuryStatus: "Questionable" } : p));
    let cur = CURRENT, writes = 0;
    for (let t = T("2026-10-04T12:00:00Z"); t <= T("2026-10-04T16:45:00Z"); t += 90_000) {
      const locked = lockedPlayerIds(rs() as never, kickoffs, t);
      const plan = planLineup(cur, rs(), SLOTS, locked, 1, { kickoffs, now: t });
      if (plan.changed) { writes++; cur = plan.ids; }
      if (t < T("2026-10-04T16:30:00Z")) expect(cur).toContain("laporta");
    }
    // One decision, in Andrews's own window, and it holds.
    expect(writes).toBe(1);
    expect(cur).toContain("andrews");
  });
  test("polled across the whole day, the Evans decision is one write", () => {
    let cur = CURRENT, writes = 0;
    for (let t = T("2026-10-04T12:00:00Z"); t <= T("2026-10-04T20:20:00Z"); t += 90_000) {
      const plan = planLineup(cur, week4(), SLOTS, lockedPlayerIds(week4() as never, kickoffs, t), 1, { kickoffs, now: t });
      if (plan.changed) { writes++; cur = plan.ids; }
    }
    expect(writes).toBe(1);
    expect(cur).toContain("jcm");
  });
  test("a Questionable replacement is not a hedge for a Questionable starter", () => {
    const slots = ["WR"];
    const k = new Map([["AAA", LATE], ["BBB", EARLY], ["CCC", LONDON]]);
    const rs = [P("x", "WR", 14, "Questionable", { team: "AAA" }), P("y", "WR", 12, "Questionable", { team: "BBB" }), P("e", "WR", 9, null, { team: "CCC" })];
    const plan = planLineup(["x"], rs, slots, new Set(), 1, { kickoffs: k, now: T("2026-10-04T13:10:00Z") });
    expect(plan.ids).not.toContain("y");
  });
  test("a stale Questionable on the projection row does not hedge a player the live roster calls healthy", () => {
    const plan = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, { ...at("2026-10-04T13:10:00Z"), questionable: new Set<string>() });
    expect(plan.changed).toBe(false);
  });
  test("with no later fallback the same numbers bench him", () => {
    const plan = planLineup(CURRENT, week4(), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z"));
    expect(plan.swaps.map((s) => s.why).join(" ")).toContain("expected 10.5");
  });
  test("same kickoff window: the guard can still react to the inactives, so no hedge", () => {
    const k = new Map(kickoffs); k.set("SF", LONDON);
    expect(planLineup(CURRENT, week4(), SLOTS, new Set(), 1, { kickoffs: k, now: T("2026-10-04T13:10:00Z") }).changed).toBe(false);
  });
  test("a Thursday body is not started over a player Questionable for Sunday", () => {
    const k = new Map(kickoffs); k.set("WAS", T("2026-10-02T00:15:00Z")); k.set("IND", T("2026-10-02T00:15:00Z"));
    expect(planLineup(CURRENT, week4(), SLOTS, new Set(), 1, { kickoffs: k, now: T("2026-10-02T00:00:00Z") }).changed).toBe(false);
  });
  test("a Questionable player on the bench is not brought in at full value over a sure starter", () => {
    const cur = ["dak", "walker", "cmc", "collins", "downs", "laporta", "brown", "jcm", "bates", "SEA"];
    expect(planLineup(cur, week4(15.5), SLOTS, new Set(), 1, at("2026-10-04T13:10:00Z")).changed).toBe(false);
  });
});
