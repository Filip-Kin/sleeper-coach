import { DATA_DIR } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { projectPoints } from "./scoring.ts";
import type { ProjectionRecord, ScoringSettings, Position } from "../sleeper/types.ts";

// A normalised projection for one player, scored under this league's exact
// rules rather than Sleeper's generic pts_ppr.
export interface Projection {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  points: number; // projected season points under the league's scoring
  ptsPpr: number; // Sleeper's generic full-PPR points, kept for sanity checks
  adp: number; // full-PPR ADP; 999 means effectively undrafted/unknown
  injuryStatus: string | null;
  stats: Record<string, number>;
}

const TTL_MS = 12 * 60 * 60 * 1000; // projections drift through camp; refresh twice a day
const FANTASY = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function cachePath(season: string): string {
  return `${DATA_DIR}projections-${season}.json`;
}
function metaPath(season: string): string {
  return `${DATA_DIR}projections-${season}.meta.json`;
}

async function fetchAndCache(season: string): Promise<ProjectionRecord[]> {
  const records = await sleeper.seasonProjections(season);
  await Bun.write(cachePath(season), JSON.stringify(records));
  await Bun.write(metaPath(season), JSON.stringify({ fetchedAt: Date.now(), count: records.length }, null, 2));
  return records;
}

async function rawProjections(season: string, forceRefresh: boolean): Promise<ProjectionRecord[]> {
  const meta = (await Bun.file(metaPath(season)).exists())
    ? ((await Bun.file(metaPath(season)).json()) as { fetchedAt: number })
    : null;
  const fresh = meta && Date.now() - meta.fetchedAt < TTL_MS;
  if (!forceRefresh && fresh && (await Bun.file(cachePath(season)).exists())) {
    return (await Bun.file(cachePath(season)).json()) as ProjectionRecord[];
  }
  return fetchAndCache(season);
}

// Season projections, one row per fantasy-relevant player, scored under the
// given league scoring settings. Sorted by projected points, best first.
export async function loadSeasonProjections(
  season: string,
  scoring: ScoringSettings,
  opts?: { forceRefresh?: boolean },
): Promise<Projection[]> {
  const records = await rawProjections(season, opts?.forceRefresh ?? false);
  const out: Projection[] = [];

  for (const r of records) {
    const pos = (r.player?.position ?? r.player?.fantasy_positions?.[0] ?? null) as Position | null;
    if (!pos || !FANTASY.has(pos)) continue;

    const stats = r.stats ?? {};
    // Exact points under the league's scoring; fall back to Sleeper's pts_ppr
    // when the granular line is missing (e.g. some K/DEF rows).
    const exact = projectPoints(stats, scoring);
    const ptsPpr = stats["pts_ppr"] ?? 0;
    const points = exact > 0 ? exact : ptsPpr;

    out.push({
      playerId: r.player_id,
      name: `${r.player?.first_name ?? ""} ${r.player?.last_name ?? ""}`.trim() || r.player_id,
      position: pos,
      team: r.player?.team ?? r.team ?? "FA",
      points: Math.round(points * 10) / 10,
      ptsPpr: Math.round(ptsPpr * 10) / 10,
      adp: stats["adp_ppr"] ?? 999,
      injuryStatus: r.player?.injury_status ?? null,
      stats,
    });
  }

  out.sort((a, b) => b.points - a.points);
  return out;
}

export async function projectionsCacheStatus(season: string): Promise<{ fetchedAt: number; count: number } | null> {
  if (!(await Bun.file(metaPath(season)).exists())) return null;
  return (await Bun.file(metaPath(season)).json()) as { fetchedAt: number; count: number };
}
