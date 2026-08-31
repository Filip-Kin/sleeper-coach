import type { PlayersMap } from "../sleeper/types.ts";
import type { WeekProjection } from "./week-projections.ts";
import type { LineupPlayer } from "./lineup.ts";
import { byeWeek } from "../data/byes.ts";

// Availability (OUT/IR/bye) is decided by the solver's own availabilityOf, so it
// is NOT re-derived here; this module only joins the data sources and passes the
// raw injury status and bye flag through.

// Assemble our roster into the LineupPlayer[] the solver expects, joining three
// sources: who is on the roster (player ids), what position/injury each player
// is (the player dump), and this week's projection (the per-week endpoint).
//
// Identity note: team defences are keyed in Sleeper by the team abbreviation
// (e.g. "SEA"), which is also their player id, and they have no entry in the
// player dump. Handle them explicitly rather than dropping them, or the DEF slot
// would never be filled.

export interface RosterWeekPlayer extends LineupPlayer {
  team: string;
  hasProjection: boolean; // a projection row existed this week
}

// Build the weekly lineup candidates for a set of roster player ids. `week` is
// the scoring week, used to flag byes. `inactiveIds` are player ids confirmed
// not to be playing (e.g. a late Sunday scratch read from the inactives report);
// they are force-benched regardless of projection.
export function buildRosterWeek(
  rosterIds: string[],
  players: PlayersMap,
  weekIndex: Map<string, WeekProjection>,
  week: number,
  inactiveIds: Set<string> = new Set(),
): RosterWeekPlayer[] {
  const out: RosterWeekPlayer[] = [];
  for (const id of rosterIds) {
    const dump = players[id];
    const proj = weekIndex.get(id);

    // Position: prefer the dump, then the projection, then the DEF convention.
    let position = dump?.position ?? dump?.fantasy_positions?.[0] ?? proj?.position ?? null;
    let team = dump?.team ?? proj?.team ?? "FA";
    let name = dump?.full_name ?? (dump ? `${dump.first_name} ${dump.last_name}`.trim() : proj?.name ?? id);
    if (!position && /^[A-Z]{2,4}$/.test(id)) {
      position = "DEF";
      team = id;
      name = `${id} DEF`;
    }
    if (!position) continue; // genuinely unidentifiable; skip rather than mis-slot

    // Injury status: the daily player dump is fresher than the weekly projection
    // row, so prefer it. The solver's availabilityOf decides what benches him.
    const injuryStatus = dump?.injury_status ?? proj?.injuryStatus ?? null;

    // A player with no projection row this week has no game (bye or otherwise not
    // playing), so a real 0 is the honest projection. onBye is also set from the
    // bye table, the belt-and-braces version for the live path.
    const onBye = byeWeek(team) === week || (proj != null && proj.onBye);

    out.push({
      playerId: id,
      name,
      position,
      points: proj?.points ?? 0,
      injuryStatus,
      onBye,
      inactive: inactiveIds.has(id), // ONLY confirmed inactives; injury/bye is the solver's call
      team,
      hasProjection: proj != null,
    });
  }
  return out;
}
