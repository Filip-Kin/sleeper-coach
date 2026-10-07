import { loadWeekProjections, tableIsUsable, scoredRows, MIN_SCORED_ROWS, type WeekProjection, type WeekSource } from "./week-projections.ts";
import { loadSeasonProjections } from "./projections.ts";
import type { ScoringSettings, Position } from "../sleeper/types.ts";

// Rest-of-season (ROS) projections: the currency the waiver engine and the drop
// rails trade in. A weekly number is the wrong unit for a keep/drop decision - it
// makes a bye-week or short-term-injured player look worthless - so ROS sums the
// remaining weeks through the fantasy championship.
//
// The fantasy season that matters runs to the championship in week 17 (playoffs
// start week 16, four teams). Points projected in weeks 18+ are irrelevant to a
// roster decision, so ROS stops at 17.
const CHAMPIONSHIP_WEEK = 17;

export interface RosProjection {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  points: number; // summed remaining-week projections, this week through wk 17
  weeksCounted: number;
  seasonPoints: number; // full-season projection, the healthy-talent signal
  injuryStatus: string | null;
  returnsBeforePlayoffs: boolean; // injured now but real talent => a stash, not dead weight
}

const RESERVE = new Set(["IR", "PUP", "NA", "SUS", "DNR", "COV", "OUT", "DOUBTFUL"]);

// #region pure
/** A week with no numbers must not enter the sum. Summing it as zeros takes
 *  one week off everyone who plays it and nothing off a man who sits it out
 *  (PUP, IR, bye), and that is a cut: on 2026-10-07, with week 5 read as
 *  zeros, the waiver planner priced Croskey-Merritt 9 points lower, Charbonnet
 *  (PUP) the same, and cleared "drop Croskey-Merritt for Charbonnet" that the
 *  real table refuses. Every completed and future week of 2026 carries 415 to
 *  507 scored rows (measured 2026-10-07, weeks 1 to 17), so an empty table is
 *  the feed, never the calendar. No numbers, no value, no decision. */
export function assertUsableWeek(table: WeekProjection[], week: number): void {
  if (tableIsUsable(table)) return;
  throw new Error(
    `week ${week} projection table has no numbers (${scoredRows(table)} rows scored, ${MIN_SCORED_ROWS} needed); ` +
      "rest-of-season value cannot be built from it, so no roster decision is made on it",
  );
}
// #endregion

// Build ROS projections for every fantasy player. `fromWeek` is the first week
// still to be played (the current NFL week). Weekly tables are cached per week,
// so the repeated fetch is cheap after the first run of the day.
export async function loadRestOfSeason(
  season: string,
  fromWeek: number,
  scoring: ScoringSettings,
  opts?: { forceRefresh?: boolean; stashSeasonMin?: number; source?: WeekSource },
): Promise<Map<string, RosProjection>> {
  const weeks: number[] = [];
  for (let w = Math.max(1, fromWeek); w <= CHAMPIONSHIP_WEEK; w++) weeks.push(w);

  // Sum remaining weeks. Sequential to be polite to the API and to reuse each
  // week's on-disk cache; the volume is small (a dozen weeks at most).
  const sum = new Map<string, RosProjection>();
  for (const w of weeks) {
    const table = await loadWeekProjections(season, w, scoring, { forceRefresh: opts?.forceRefresh, source: opts?.source });
    assertUsableWeek(table, w);
    for (const p of table) {
      const cur = sum.get(p.playerId);
      if (cur) {
        cur.points = Math.round((cur.points + p.points) * 100) / 100;
        cur.weeksCounted += p.hasGame ? 1 : 0;
        // Keep the most recent non-null injury status seen.
        if (p.injuryStatus) cur.injuryStatus = p.injuryStatus;
      } else {
        sum.set(p.playerId, {
          playerId: p.playerId,
          name: p.name,
          position: p.position,
          team: p.team,
          points: p.points,
          weeksCounted: p.hasGame ? 1 : 0,
          seasonPoints: 0,
          injuryStatus: p.injuryStatus,
          returnsBeforePlayoffs: false,
        });
      }
    }
  }

  // Join the full-season projection as a talent signal, and use it to decide the
  // stash flag. A player who is on a reserve/out status right now but carries a
  // strong season projection is hurt-but-good: exactly the player the rails must
  // refuse to drop, and whose thin ROS sum would otherwise mark him cuttable.
  const stashMin = opts?.stashSeasonMin ?? 120; // ~a low-end weekly starter's season line
  const seasonList = await loadSeasonProjections(season, scoring, { forceRefresh: opts?.forceRefresh });
  const seasonById = new Map(seasonList.map((s) => [s.playerId, s]));
  for (const r of sum.values()) {
    const s = seasonById.get(r.playerId);
    if (s) r.seasonPoints = s.points;
    const injured = RESERVE.has((r.injuryStatus ?? "").trim().toUpperCase());
    // Hurt but with real season-long talent, and there is still a playoff run to
    // return for (we are before the championship): a stash.
    r.returnsBeforePlayoffs = injured && r.seasonPoints >= stashMin && fromWeek < CHAMPIONSHIP_WEEK;
  }

  return sum;
}
