// Replay of Friday 2026-10-16 on the league as captured Thursday 10-15 17:32Z
// (incidents/league-2026-10-15.json). Will Reichard (K, MIN, 99.6 ROS) was
// unrostered; MIN had its bye in week 6, so from Thursday's first kickoff
// Sleeper held him: a free add is refused ("on waivers") and so is a claim
// ("The time to claim this player has passed", six times Friday to Sunday).
// The planner read him as a claim at no priority cost (we were last) and
// every react and confirm run filed him again. The rule now: a bye team's
// man is LOCKED (rules.ts waiverState), neither addable nor claimable until
// the Wednesday clear; the plan names him as a wait and writes nothing, and
// the Wednesday free-agent run plans him afresh as a free agent.
import { describe, expect, test } from "bun:test";
import { planOne, planWaivers, bestClaim, DEFAULT_WAIVERS, type AvailablePlayer, type RosterState } from "./waivers.ts";
import { planStream, type StreamPoolPlayer, type StreamNeed } from "./streaming.ts";
import type { RailPlayer } from "./rails.ts";
import { openFixture } from "./incidents/fixture.ts";
import raw from "./incidents/league-2026-10-15.json";
import { weeksLeft } from "./value.ts";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt } = openFixture(raw);
const SLOTS = LEAGUE.rosterPositions.filter((s) => s !== "BN" && s !== "IR");
const mine = ourRoster();
const irEligible = (s?: string | null): boolean => ["IR", "PUP", "OUT", "SUS", "COV"].includes((s ?? "").trim().toUpperCase());
const active: RailPlayer[] = mine.players.filter((id) => !mine.reserve.includes(id)).map((id) => tradePlayer(id, { onIr: false }));
const reserve: RailPlayer[] = mine.reserve.map((id) => tradePlayer(id, { onIr: true }));
const starters = mine.starters.map((id) => fx(id).name);
const wk = (p: { playerId?: string }, week = "6"): number => (p.playerId ? (fx(p.playerId).weekly[week] ?? 0) : 0);
const weekPoints = new Map<string, number>();
for (const p of Object.values(LEAGUE.players)) weekPoints.set(p.name, p.weekly["6"] ?? 0);
// Friday: we are last in the order (the Mahomes claim processed), so a claim is free.
const state: RosterState = {
  roster: active, reserve, openBenchSlots: 0, openIrSlots: 0, startingSlots: SLOTS, irEligible,
  currentStarters: starters, weeksLeft: weeksLeft(6), priorityFree: true, weekPoints, canFill: (b) => wk(b) > 0,
};
const REICHARD = idOf("Will Reichard");
const reichard = (extra: Partial<AvailablePlayer> = {}): AvailablePlayer => ({ ...tradePlayer(REICHARD), onWaivers: true, ...extra });

describe("2026-10-16: Reichard, MIN on bye, claimed six times and refused six times", () => {
  test("the fixture is the case as filed", () => {
    expect(fx(REICHARD).team).toBe("MIN");
    expect(fx(REICHARD).bye).toBe(6);
    expect(availableAt("K").map((p) => p.name)).toContain("Will Reichard");
    expect(active).toHaveLength(16);
  });
  test("as the planner read him (on waivers, priority free) he was the claim", () => {
    const m = planOne(reichard(), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("waiver-claim");
  });
  test("locked: a wait that names the clear, no drop, nothing to file", () => {
    const m = planOne(reichard({ locked: true }), state, DEFAULT_WAIVERS);
    expect(m.kind).toBe("wait");
    expect(m.drop).toBeNull();
    expect(m.reason).toContain("neither addable nor claimable until Wednesday's waiver clear");
    const board = planWaivers([reichard({ locked: true })], state, DEFAULT_WAIVERS);
    expect(board.map((b) => b.kind)).toEqual(["wait"]);
    expect(bestClaim(board)).toBeNull();
  });
  test("Wednesday: a free agent again, planned on his merits", () => {
    const m = planOne(reichard({ onWaivers: false, locked: false }), state, DEFAULT_WAIVERS);
    expect(m.kind).not.toBe("wait");
    expect(m.kind).not.toBe("skip");
  });
  test("a locked kicker is not a streamer either: the pool skips him for the next free body", () => {
    const need: StreamNeed = { week: 7, position: "K", coveringFor: ["Ka'imi Fairbairn"] };
    const pool: StreamPoolPlayer[] = availableAt("K").map((p) => ({
      playerId: p.playerId, name: p.name, position: p.position, bye: p.bye, weekPoints: p.weekly["7"] ?? 0, onWaivers: false, value: p.value,
      locked: p.playerId === REICHARD,
    }));
    const d = planStream({ need, week: 7, openBenchSlots: 1, pool, roster: active, mayLeave: () => true, forcedDrop: () => null, priorityFree: true });
    expect(d.add).not.toBeNull();
    expect(d.add).not.toBe("Will Reichard");
    const unlocked = planStream({ need, week: 7, openBenchSlots: 1, pool: pool.map((p) => ({ ...p, locked: false })), roster: active, mayLeave: () => true, forcedDrop: () => null, priorityFree: true });
    expect(unlocked.add).toBe(pool.filter((p) => p.bye !== 7 && p.weekPoints > 0).sort((a, b) => b.weekPoints - a.weekPoints)[0]!.name);
  });
});
