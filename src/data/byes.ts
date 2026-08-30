// 2026 bye weeks, one per team. Derived from the ESPN scoreboard API's
// `week.teamsOnBye` for weeks 1-18 of the 2026 regular season (fetched
// 2026-08-30). Byes are fixed once the schedule is released, so this is a
// static table rather than a live fetch — no API to fail on draft night.
//
// ESPN spells Washington "WSH"; Sleeper uses "WAS". Keys here are SLEEPER
// abbreviations so they join straight onto a player's `team`.

export const BYE_WEEKS: Record<string, number> = {
  KC: 5, CAR: 5,
  CIN: 6, DET: 6, MIA: 6, MIN: 6,
  BUF: 7, LAC: 7, WAS: 7, JAX: 7,
  NO: 8, NYG: 8, SF: 8, HOU: 8,
  TEN: 9, PIT: 9,
  CHI: 10, DEN: 10, PHI: 10, TB: 10,
  ATL: 11, CLE: 11, GB: 11, LAR: 11, NE: 11, SEA: 11,
  IND: 13, LV: 13, NYJ: 13, BAL: 13,
  DAL: 14, ARI: 14,
};

export function byeWeek(team: string | null | undefined): number | null {
  if (!team) return null;
  return BYE_WEEKS[team] ?? null;
}

// How many of the given players share each bye week. Used to stop the draft
// agent stacking starters onto one dead week.
export function byeCounts(teams: (string | null | undefined)[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of teams) {
    const wk = byeWeek(t);
    if (wk == null) continue;
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
  }
  return counts;
}
