// Sleeper's rules, encoded once, each with a test that pins it.
//
// Every one of these was learned from a production incident where the coach
// had ASSUMED the rule instead of encoding it. The audit of 2026-09-23 found
// the same rule written five different ways in five files. This file is the
// only place a Sleeper rule lives; a module that needs one imports it, and a
// new rule gets a row here and a test before any code depends on it.

import type { League, Roster } from "./types.ts";
import type { RosterView, RosterEntry } from "../analysis/roster-view.ts";

export type Settings = League["settings"];

// #region injured reserve
/** Statuses this league allows on IR. IR and PUP always; the rest are the
 *  commissioner's reserve_allow_* flags. This league: OUT, SUS, COV. Questionable
 *  and Doubtful are weekly game states and are NOT eligible, which is how a
 *  stash that improves invalidates the whole roster. */
export function irEligibleSet(s: Settings): Set<string> {
  const set = new Set<string>(["IR", "PUP"]);
  if (s.reserve_allow_out) set.add("OUT");
  if (s.reserve_allow_doubtful) set.add("DOUBTFUL");
  if (s.reserve_allow_sus) set.add("SUS");
  if (s.reserve_allow_cov) set.add("COV");
  if (s.reserve_allow_na) set.add("NA");
  if (s.reserve_allow_dnr) set.add("DNR");
  return set;
}
export function irEligible(status: string | null | undefined, s: Settings): boolean {
  return irEligibleSet(s).has((status ?? "").trim().toUpperCase());
}
/** Players parked on IR who no longer qualify. Sleeper treats the roster as
 *  invalid while any exist and refuses every lineup write. */
export function staleReserve(view: Pick<RosterView, "reserve">, s: Settings): RosterEntry[] {
  return view.reserve.filter((e) => !irEligible(e.injuryStatus, s));
}
export function irSlots(league: Pick<League, "settings" | "roster_positions">): number {
  return league.settings.reserve_slots ?? league.roster_positions.filter((p) => p === "IR").length;
}
/** Sleeper refuses roster_update_reserve while any of the week's games is in
 *  progress ("must wait until this week's games are complete"). */
export function reserveWritable(games: { status: string }[]): boolean {
  return !games.some((g) => g.status !== "pre_game" && g.status !== "complete");
}
export const RESERVE_LOCKED_RE = /games are complete/i;
export const RESERVE_INELIGIBLE_RE = /no longer IR eligible/i;
// #endregion

// #region roster legality
export interface Legality { ok: boolean; overBy: number; staleIr: string[]; reserveNotOwned: string[] }
export function rosterLegal(view: RosterView, capacity: number, s: Settings): Legality {
  const overBy = Math.max(0, view.active.length - capacity);
  const staleIr = staleReserve(view, s).map((e) => e.name);
  const reserveNotOwned = [...view.reserveIds].filter((id) => !view.ownedIds.has(id));
  return { ok: overBy === 0 && staleIr.length === 0 && reserveNotOwned.length === 0, overBy, staleIr, reserveNotOwned };
}
// #endregion

// #region transactions
/** A trade changes what anyone holds only when every roster in it has said
 *  yes. The proposer is a consenter from the moment the offer is sent, so a
 *  lone consenter means nobody else has agreed. */
export function tradeInFlight(t: { roster_ids?: number[] | null; consenter_ids?: number[] | null }): boolean {
  const rosters = t.roster_ids ?? [];
  const consenters = new Set(t.consenter_ids ?? []);
  return rosters.length > 0 && rosters.every((r) => consenters.has(r));
}
export const TX_DEAD = new Set(["rejected", "failed", "expired", "cancelled", "canceled"]);
/** An offer that Sleeper reports dead, or that has passed the expiry we set
 *  when proposing it (settings.expires_at, seconds). */
export function tradeDead(t: { status?: string | null; settings?: { expires_at?: number | null } | null }, nowMs: number): boolean {
  if (TX_DEAD.has(String(t.status ?? "").toLowerCase())) return true;
  const exp = t.settings?.expires_at;
  return typeof exp === "number" && exp > 0 && exp * 1000 < nowMs;
}
/** A transaction is filed under the leg it was created in and stays there until
 *  processed, while the NFL week rolls over on Tuesday. Every read of open
 *  transactions has to look one leg back or it goes blind on Tuesday and
 *  Wednesday. Learned 2026-09-22 (claims) and 2026-09-23 (trades, audit). */
export function legsToScan(leg: number): number[] {
  const l = Math.max(1, Math.trunc(leg));
  return l > 1 ? [l, l - 1] : [l];
}
export function pastTradeDeadline(week: number, s: Settings): boolean {
  const deadline = s.trade_deadline ?? 99;
  return week > deadline;
}
/** Waiver claims only make sense under rolling priority (waiver_type 0). Under
 *  FAAB a claim without a bid is a wasted claim. */
export function claimAllowed(s: Settings): boolean {
  return (s.waiver_type ?? 0) === 0;
}
// #endregion

// #region players
/** Sleeper player ids: numeric for people, the team code for a defense. */
export const isTeamCode = (id: string): boolean => /^[A-Z]{2,4}$/.test(id);
/** A player is locked in place once his own game has kicked off. A team with no
 *  known kickoff is treated as unlocked: the worst case is a refused write. */
export function lockedAtKickoff(team: string | null | undefined, kickoffs: Map<string, number>, now: number): boolean {
  if (!team) return false;
  const k = kickoffs.get(team);
  return typeof k === "number" && k <= now;
}
/** A player dropped in the last `clearDays` is on waivers; and from his team's
 *  kickoff until the next waiver run every player is. Verified 2026-09-22 from
 *  week-2 transactions: free adds of players whose teams had NOT kicked off
 *  went through on Sunday evening while others were refused. The write-time
 *  fallback in waiver-run remains the last word. */
export function playerOnWaivers(args: {
  droppedAt?: number | null; teamKickoff?: number | null; now: number; lastWaiverRunAt: number; clearDays: number;
}): boolean {
  const { droppedAt, teamKickoff, now, lastWaiverRunAt, clearDays } = args;
  if (typeof droppedAt === "number" && now - droppedAt < clearDays * 86_400_000) return true;
  if (typeof teamKickoff === "number" && teamKickoff <= now && teamKickoff > lastWaiverRunAt) return true;
  return false;
}
// #endregion

/** Status strings the bot compares against, in one place. */
export const TX_STATUS = { proposed: "proposed", pending: "pending", complete: "complete", rejected: "rejected", failed: "failed" } as const;
export type RosterLike = Pick<Roster, "players" | "reserve">;
