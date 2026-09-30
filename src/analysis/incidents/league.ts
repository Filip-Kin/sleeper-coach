// The whole league as it stood at 09:29 ET on 2026-09-30, captured from the
// live feed (incidents/league-2026-09-30.json): all eight rosters with their
// injured-reserve lists, every rostered player's rest-of-season value, the
// twelve best unrostered players at each position, week-by-week projections,
// and our two pending waiver claims (add Croskey-Merritt for Gainwell, add
// Etienne for Spears).
//
// Shared by the replay tests so each one asserts on the real numbers and the
// real names, not on a roster shaped to make the test pass.
import fixture from "./league-2026-09-30.json";
import type { TradePlayer } from "../trade.ts";
import type { LeagueSnapshot } from "../trade-wire.ts";

export interface FixturePlayer {
  playerId: string; name: string; position: string; team: string;
  value: number; seasonPoints: number; seasonRank: number;
  injuryStatus: string | null; stash: boolean; bye: number | null;
  weekly: Record<string, number>;
}
interface FixtureRoster { rosterId: number; players: string[]; reserve: string[]; starters: string[] }
interface Fixture {
  capturedAt: string; week: number; ourRosterId: number; rosterPositions: string[];
  rosters: FixtureRoster[];
  pendingClaims: { adds: string[]; drops: string[]; slotsNeeded: number };
  players: Record<string, FixturePlayer>;
}
export const LEAGUE = fixture as unknown as Fixture;
export const WEEK = LEAGUE.week;
export const OURS = LEAGUE.ourRosterId;

export function fx(id: string): FixturePlayer {
  const p = LEAGUE.players[id];
  if (!p) throw new Error(`fixture has no player ${id}`);
  return p;
}
export function idOf(name: string): string {
  const p = Object.values(LEAGUE.players).find((x) => x.name === name);
  if (!p) throw new Error(`fixture has no ${name}`);
  return p.playerId;
}
export function tradePlayer(id: string, extra: Partial<TradePlayer> = {}): TradePlayer {
  const p = fx(id);
  return {
    playerId: id, name: p.name, position: p.position, points: p.value,
    seasonPoints: p.seasonPoints, seasonRank: p.seasonRank,
    injuryStatus: p.injuryStatus ?? undefined, returnsBeforePlayoffs: p.stash,
    bye: p.bye ?? undefined, ...extra,
  };
}
/** One roster as the trade snapshot carries it: every owned player, the ones
 *  on injured reserve flagged. */
export function rosterOf(rosterId: number): TradePlayer[] {
  const r = LEAGUE.rosters.find((x) => x.rosterId === rosterId);
  if (!r) throw new Error(`fixture has no roster ${rosterId}`);
  const ir = new Set(r.reserve);
  return r.players.map((id) => tradePlayer(id, { onIr: ir.has(id) }));
}
/** The snapshot the trade engine would have built at capture time, before
 *  any pending trade or pending claim is applied. */
export function leagueSnapshot(): LeagueSnapshot {
  const playerById = new Map(Object.keys(LEAGUE.players).map((id) => [id, tradePlayer(id)]));
  const rosters = new Map(LEAGUE.rosters.map((r) => [r.rosterId, rosterOf(r.rosterId)]));
  const idByName = new Map<string, string>();
  for (const r of rosters.values()) for (const p of r) idByName.set(p.name, p.playerId!);
  return { playerById, rosterOf: rosters, ourRosterId: OURS, idByName, ownerIdOf: new Map(), week: WEEK, capacity: 16 };
}
/** Unrostered players at a position, best rest-of-season value first. */
export function availableAt(position: string): FixturePlayer[] {
  const taken = new Set(LEAGUE.rosters.flatMap((r) => r.players));
  return Object.values(LEAGUE.players).filter((p) => p.position === position && !taken.has(p.playerId)).sort((a, b) => b.value - a.value);
}
