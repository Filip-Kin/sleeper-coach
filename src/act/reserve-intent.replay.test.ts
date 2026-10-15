// Replay of 2026-10-15 on the league as captured that afternoon
// (analysis/incidents/league-2026-10-15.json): sixteen active, DeVonta Smith
// (Questionable since Wednesday's reset) and Travis Etienne (NFL IR) on
// injured reserve, his forced cut (Dowdle, 77) held for Friday's final
// injury report. At 13:20 ET Jalen Hurts flipped Out (calf): a bench man
// who qualifies for IR, so the hold gave way to "move Hurts to injured
// reserve and activate Smith", nobody cut, recorded for a second look 30
// minutes on. At 13:28 the roster-legal invariant paged "no longer
// IR-eligible: DeVonta Smith": it knew the hold (cleared) and not the
// intent. The move itself was right; the page was the fault.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildRosterView } from "../analysis/roster-view.ts";
import { DEFAULT_FAIRNESS } from "../analysis/trade-fair.ts";
import { DEFAULT_RAILS } from "../analysis/rails.ts";
import { openFixture } from "../analysis/incidents/fixture.ts";
import raw from "../analysis/incidents/league-2026-10-15.json";
import { planReserveActivation, currentReserveIntents, RESERVE_INTENT_PREFIX } from "./reserve-reconcile.ts";
import { DropIntentStore, MAX_AGE_MS } from "./drop-intent.ts";
import { evaluateInvariants, type InvariantInput } from "../invariants.ts";
import type { Roster, League } from "../sleeper/types.ts";
import type { RailPlayer } from "../analysis/rails.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LEAGUE, fx, idOf, tradePlayer, ourRoster } = openFixture(raw);
const S = { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_sus: 1, reserve_allow_cov: 1, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_dnr: 0, trade_deadline: 11, waiver_type: 0 } as unknown as League["settings"];
const CAP = LEAGUE.rosterPositions.filter((s) => s !== "IR").length; // 16
const cfg = { ...DEFAULT_FAIRNESS, upcomingWeeks: [6, 7, 8, 9], remainingWeeks: 12, headToHeadRemaining: 1 };
const mine = ourRoster();
const SMITH = idOf("DeVonta Smith");
const HURTS = idOf("Jalen Hurts");
const ETIENNE = idOf("Travis Etienne");
const INTENT_AT = Date.UTC(2026, 9, 15, 17, 20, 38); // Thu 2026-10-15 13:20:38 ET, the first look
const PAGED_AT = Date.UTC(2026, 9, 15, 17, 28, 21); // 13:28:21 ET, the invariant's poll
const FRI_REPORT = Date.UTC(2026, 9, 16, 22, 0, 0); // Fri 18:00 ET, Smith's held cut

function roster(players: string[], reserve: string[], starters: string[]): Roster {
  const player_map: NonNullable<Roster["player_map"]> = {};
  for (const id of players) {
    const p = fx(id);
    if (p.position === "DEF") continue;
    const [first, ...rest] = p.name.split(" ");
    player_map[id] = { player_id: id, first_name: first ?? "", last_name: rest.join(" "), position: p.position, fantasy_positions: [p.position], team: p.team, status: "Active", injury_status: p.injuryStatus, news_updated: null };
  }
  return { roster_id: 3, owner_id: "u", players, starters, reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map };
}
const rail = (players: string[], reserve: string[]): RailPlayer[] => players.map((id) => tradePlayer(id, { onIr: reserve.includes(id) }));
const names = (ids: string[]): string[] => ids.map((id) => fx(id).name);
const canFill = (body: RailPlayer, starter: RailPlayer): boolean => body.position === starter.position && (fx(body.playerId ?? "").weekly[String(LEAGUE.week)] ?? 0) > 0;

const live = roster(mine.players, mine.reserve, mine.starters);
const league = { league_id: "L", name: "t", season: "2026", status: "in_season", total_rosters: 8, draft_id: "D", previous_league_id: null, scoring_settings: {}, roster_positions: LEAGUE.rosterPositions, settings: S } as League;
function invariantInput(over: Partial<InvariantInput>, now: number): InvariantInput {
  return {
    db: new Database(":memory:"), league, rosters: [live], state: { season: "2026", season_type: "regular", week: LEAGUE.week, display_week: LEAGUE.week }, view: buildRosterView(live),
    token: { kind: "ok", expMs: now + 200 * 86_400_000 }, pendingClaims: { count: 0, adds: [] }, outstandingOffers: [], proposalsDb: [],
    scheduledRuns: {}, kickoffs: [], dropHistory: [], alertsLastHour: 0, now, jobs: [], ...over,
  };
}
const rosterLegal = (over: Partial<InvariantInput>, now: number) => evaluateInvariants(invariantInput(over, now)).find((c) => c.name === "roster-legal")!;

describe("2026-10-15: Hurts flips Out with Smith's cut held for Friday", () => {
  test("the capture is the incident roster", () => {
    expect(mine.players.length).toBe(18);
    expect(mine.reserve).toEqual([SMITH, ETIENNE]);
    expect(fx(SMITH).injuryStatus).toBe("Questionable");
    expect(fx(HURTS).injuryStatus).toBe("Out");
    expect(mine.starters).not.toContain(HURTS);
  });
  test("the reconciler's plan: Hurts takes Smith's reserve seat, nobody is cut, the hold does not apply", () => {
    const plan = planReserveActivation({ view: buildRosterView(live), settings: S, cap: CAP, railRoster: rail(mine.players, mine.reserve), cfg, rails: DEFAULT_RAILS, keep: names(mine.starters), heldClaims: [], canFill, cutNotBefore: FRI_REPORT, now: INTENT_AT })[0]!;
    expect(plan.action).toBe("activate");
    expect(plan.playerId).toBe(SMITH);
    expect(plan.stash?.playerId).toBe(HURTS);
    expect(plan.drop).toBeNull();
    expect(plan.reserveAfter.sort()).toEqual([ETIENNE, HURTS].sort());
  });
  test("the deployed invariant paged on Smith eight minutes into the intent (the incident)", () => {
    const c = rosterLegal({ reserveHold: null, reserveIntents: [] }, PAGED_AT);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("no longer IR-eligible: DeVonta Smith");
  });
  test("with the stash intent open the stale IR is handled, said, not paged", () => {
    const dir = mkdtempSync(join(tmpdir(), "reserve-intent-"));
    const store = new DropIntentStore(join(dir, "drop-intents.json"));
    // What the reconciler wrote at 13:20:38 ET (drop-intents.json that afternoon).
    store.put({ key: `${RESERVE_INTENT_PREFIX}${SMITH}:stash:${HURTS}`, firstSeen: INTENT_AT, note: "DeVonta Smith is Questionable, not IR-eligible; the active roster is full and Jalen Hurts (Out) qualifies for injured reserve, so he takes the seat and nobody is cut" });
    const intents = currentReserveIntents(PAGED_AT, store);
    expect(intents.map((i) => i.playerId)).toEqual([SMITH]);
    const c = rosterLegal({ reserveHold: null, reserveIntents: intents }, PAGED_AT);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("DeVonta Smith stale on IR, his activation recorded");
    expect(c.detail).toContain("confirming on a second look");
    // The store forgets the intent after its life; so does the invariant.
    const later = INTENT_AT + MAX_AGE_MS + 1;
    expect(currentReserveIntents(later, store)).toEqual([]);
    expect(rosterLegal({ reserveHold: null, reserveIntents: intents }, later).ok).toBe(false);
    // A restart row under the prefix is bookkeeping, not an intent.
    store.settle(`${RESERVE_INTENT_PREFIX}${SMITH}:`, "other", PAGED_AT);
    expect(currentReserveIntents(PAGED_AT, store)).toEqual([]);
  });
  test("the hold still covers the morning's state: Smith held, no intent", () => {
    const c = rosterLegal({ reserveHold: { playerId: SMITH, name: "DeVonta Smith", until: FRI_REPORT }, reserveIntents: [] }, PAGED_AT);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("cut held for his final injury report");
  });
});
