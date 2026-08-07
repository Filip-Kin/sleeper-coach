import type { PlayersMap, SleeperPlayer, Position } from "../sleeper/types.ts";

export interface BoardEntry {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  rank: number; // lower is better
  age: number | null;
  yearsExp: number | null;
  injuryStatus: string | null;
}

const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

// First-pass value board: order fantasy-relevant players by Sleeper's
// search_rank. This is a placeholder ordering good enough to poke at now; the
// real board will blend projected points (scoring.ts), positional scarcity for
// this 8-team full-PPR league, ADP, and the qualitative news layer.
export function buildBoard(
  players: PlayersMap,
  opts?: { position?: Position; limit?: number },
): BoardEntry[] {
  const entries: BoardEntry[] = [];

  for (const p of Object.values(players)) {
    const pos = primaryPosition(p);
    if (!pos || !FANTASY_POSITIONS.has(pos)) continue;
    if (p.search_rank === null || p.search_rank === undefined) continue;
    if (opts?.position && pos !== opts.position) continue;

    entries.push({
      playerId: p.player_id,
      name: p.full_name ?? `${p.first_name} ${p.last_name}`.trim(),
      position: pos,
      team: p.team ?? "FA",
      rank: p.search_rank,
      age: p.age,
      yearsExp: p.years_exp,
      injuryStatus: p.injury_status,
    });
  }

  entries.sort((a, b) => a.rank - b.rank);
  return opts?.limit ? entries.slice(0, opts.limit) : entries;
}

function primaryPosition(p: SleeperPlayer): Position | null {
  if (p.position && FANTASY_POSITIONS.has(p.position)) return p.position;
  return p.fantasy_positions?.find((fp) => FANTASY_POSITIONS.has(fp)) ?? null;
}
