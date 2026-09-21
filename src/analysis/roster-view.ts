// One answer to "who is on the roster", for every module that asks.
//
// Sleeper's roster carries a `players` array that INCLUDES injured reserve, and
// a `reserve` array naming the IR subset. Before 2026-09-20 sixteen call sites
// read `players` raw and each applied its own filter, or none. The cap check
// counted IR players and cut three receivers in four minutes. The drop table
// could pick a man already on IR. The lineup solver offered IR players as
// starters. The trade engine, after a patch, could not see them at all and
// would have given one away for nothing. Every one of those was a different
// module answering the same question differently.
//
// A player is in exactly one of two places, active or reserve, and four
// questions are asked about him:
//
//   owned      do we hold him?           trade value, news, display
//   active     does he count to the cap? capacity, open-slot maths
//   startable  may he play this week?    active, then the solver's own rules
//   droppable  may a robot cut him?      active, then the rails
//
// This module answers the first two structurally and gives the other two a
// correct starting set. Nothing here fetches: the input is a Roster already
// read from the live GraphQL endpoint, never the cached REST one.

import type { Roster } from "../sleeper/types.ts";
import { canDrop, type RailPlayer, type RailConfig, DEFAULT_RAILS } from "./rails.ts";

export interface RosterEntry {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  injuryStatus: string | null;
  onIr: boolean;
}

export interface RosterView {
  rosterId: number;
  /** Everything we hold, IR included. */
  owned: RosterEntry[];
  /** Counts against the roster cap. */
  active: RosterEntry[];
  /** On injured reserve. */
  reserve: RosterEntry[];
  ownedIds: Set<string>;
  activeIds: Set<string>;
  reserveIds: Set<string>;
}

const isTeamCode = (id: string): boolean => /^[A-Z]{2,4}$/.test(id);

/** Build the view from one roster read. Pure. A roster from REST has
 *  `reserve: null` and no `player_map`; it degrades to "everyone is active",
 *  which is the pre-2026-09-19 behaviour, never a crash. */
export function buildRosterView(roster: Roster): RosterView {
  const reserveIds = new Set(roster.reserve ?? []);
  const pm = roster.player_map ?? {};
  const owned: RosterEntry[] = (roster.players ?? []).map((id) => {
    const p = pm[id];
    const def = !p && isTeamCode(id);
    return {
      playerId: id,
      name: p ? `${p.first_name} ${p.last_name}`.trim() : def ? `${id} DEF` : id,
      position: p?.position ?? (def ? "DEF" : "?"),
      team: p?.team ?? (def ? id : null),
      injuryStatus: p?.injury_status ?? null,
      onIr: reserveIds.has(id),
    };
  });
  const active = owned.filter((e) => !e.onIr);
  const reserve = owned.filter((e) => e.onIr);
  return {
    rosterId: roster.roster_id,
    owned, active, reserve,
    ownedIds: new Set(owned.map((e) => e.playerId)),
    activeIds: new Set(active.map((e) => e.playerId)),
    reserveIds: new Set(reserve.map((e) => e.playerId)),
  };
}

/** How many players over the cap the ACTIVE roster is. Reserve never counts. */
export function overCap(view: RosterView, capacity: number): number {
  return Math.max(0, view.active.length - capacity);
}

/** Who an automatic process may cut: active players the rails allow. Reserve
 *  is excluded structurally, not by a filter somebody has to remember, because
 *  cutting a man already on IR frees no slot and just loses the player. The
 *  rail roster is matched by id so a name spelt two ways cannot slip through. */
export function droppable(view: RosterView, railRoster: RailPlayer[], cfg: RailConfig = DEFAULT_RAILS): RailPlayer[] {
  return railRoster.filter((p) => {
    if (p.playerId ? !view.activeIds.has(p.playerId) : p.onIr) return false;
    return canDrop(p.name, railRoster, cfg).allowed;
  });
}

/** Every player held by anyone in the league, IR included. A player on
 *  somebody's IR is not a free agent. */
export function takenAcrossLeague(rosters: Roster[]): Set<string> {
  const taken = new Set<string>();
  for (const r of rosters) for (const id of r.players ?? []) taken.add(id);
  return taken;
}
