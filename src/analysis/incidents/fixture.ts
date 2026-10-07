// A captured league (scripts/capture-league-fixture.ts) as the replay tests
// read it. league.ts is the 2026-09-30 capture with the same helpers bound;
// this is the same thing for any capture.
import type { TradePlayer } from "../trade.ts";

export interface FixturePlayer {
  playerId: string; name: string; position: string; team: string;
  value: number; seasonPoints: number; seasonRank: number;
  injuryStatus: string | null; stash: boolean; bye: number | null;
  weekly: Record<string, number>;
}
export interface FixtureRoster { rosterId: number; players: string[]; reserve: string[]; starters: string[] }
export interface Fixture {
  capturedAt: string; week: number; ourRosterId: number; rosterPositions: string[];
  rosters: FixtureRoster[];
  pendingClaims: { adds: string[]; drops: string[]; slotsNeeded: number };
  waiverPositions?: Record<string, number | null>;
  players: Record<string, FixturePlayer>;
}

export function openFixture(raw: unknown) {
  const LEAGUE = raw as Fixture;
  const fx = (id: string): FixturePlayer => {
    const p = LEAGUE.players[id];
    if (!p) throw new Error(`fixture has no player ${id}`);
    return p;
  };
  const idOf = (name: string): string => {
    const p = Object.values(LEAGUE.players).find((x) => x.name === name);
    if (!p) throw new Error(`fixture has no ${name}`);
    return p.playerId;
  };
  const tradePlayer = (id: string, extra: Partial<TradePlayer> = {}): TradePlayer => {
    const p = fx(id);
    return {
      playerId: id, name: p.name, position: p.position, points: p.value,
      seasonPoints: p.seasonPoints, seasonRank: p.seasonRank,
      injuryStatus: p.injuryStatus ?? undefined, returnsBeforePlayoffs: p.stash,
      bye: p.bye ?? undefined, ...extra,
    };
  };
  const ourRoster = (): FixtureRoster => LEAGUE.rosters.find((r) => r.rosterId === LEAGUE.ourRosterId)!;
  const availableAt = (position: string): FixturePlayer[] => {
    const taken = new Set([...LEAGUE.rosters.flatMap((r) => r.players), ...LEAGUE.pendingClaims.adds]);
    return Object.values(LEAGUE.players).filter((p) => p.position === position && !taken.has(p.playerId)).sort((a, b) => b.value - a.value);
  };
  return { LEAGUE, fx, idOf, tradePlayer, ourRoster, availableAt };
}
