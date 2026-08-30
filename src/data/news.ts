// The qualitative news layer the board always promised (see board.ts) and never
// had. Sleeper's `injury_status` is the only football signal the draft agent used
// to get, and in late preseason it is close to noise: on 2026-08-30 it tagged 33
// of the top 150 by ADP "Questionable", including Patrick Mahomes and a kicker.
// The agent could not tell camp maintenance from a torn ACL, and it had no way
// at all to see a suspension, a holdout or a depth-chart change.
//
// This reads a hand-curated dossier off the PERSISTENT state volume, so late
// news can be dropped in and picked up on the next process start with no
// rebuild and no redeploy — which matters when something breaks an hour before
// a draft.
//
// Two effects, deliberately separated:
//   1. `note` is advisory text shown to the agent on the shortlist. It cannot
//      move a player; it only lets the agent's plan break a near-tie (the
//      existing `planEps` window) with an actual football read.
//   2. `status`/`multiplier` scale projected points BEFORE value is computed, so
//      VOR, tiers and VONA all see it. This is reserved for facts, not vibes:
//      a player who is out for the season is worth ~nothing and leaving him
//      atop the board is a bug, not a strategy choice.

const NEWS_PATH = process.env.NEWS_PATH ?? "/data/sleeper-coach/news.json";

// out   — done for the season, or out so long he is undraftable here.
// risk  — a real chance of missing games (pending suspension, multi-week injury).
// watch — playing, but carrying a knock worth knowing about. No value change.
// soft  — Sleeper flags him but the reporting says it is noise. No value change,
//         and we say so explicitly so the agent stops fading a healthy stud.
export type NewsStatus = "out" | "risk" | "watch" | "soft";

export interface NewsEntry {
  status: NewsStatus;
  note: string;
  multiplier?: number; // explicit override of the status default
}

interface NewsFile {
  updatedAt?: string;
  players?: Record<string, NewsEntry>;
}

const DEFAULT_MULTIPLIER: Record<NewsStatus, number> = {
  out: 0.05, // not literally 0, so he still sorts above an empty slot
  risk: 0.85, // ~2-3 games of a 17-game season, the honest expected-value haircut
  watch: 1,
  soft: 1,
};

// Names come from two directions (Sleeper's dump and a human writing the
// dossier), so join on a loose key: case-folded, punctuation dropped, and the
// generational suffix removed. "Ja'Marr Chase" and "Brian Thomas Jr." both land.
function key(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "") // keep digits: they are never noise in a name
    .replace(/\s+/g, " ")
    .trim();
}

let cache: { updatedAt: string | null; byKey: Map<string, NewsEntry> } | null = null;

export async function loadNews(): Promise<{ updatedAt: string | null; byKey: Map<string, NewsEntry> }> {
  if (cache) return cache;
  const byKey = new Map<string, NewsEntry>();
  let updatedAt: string | null = null;
  try {
    const f = Bun.file(NEWS_PATH);
    if (await f.exists()) {
      const parsed = (await f.json()) as NewsFile;
      updatedAt = parsed.updatedAt ?? null;
      for (const [name, entry] of Object.entries(parsed.players ?? {})) {
        if (entry && typeof entry.note === "string") byKey.set(key(name), entry);
      }
    }
  } catch {
    // A malformed or unreadable dossier must never stop a draft. We log the
    // count at startup, so an empty map is visible rather than silent.
  }
  cache = { updatedAt, byKey };
  return cache;
}

export function newsFor(news: Map<string, NewsEntry>, name: string): NewsEntry | undefined {
  return news.get(key(name));
}

export function newsMultiplier(entry: NewsEntry | undefined): number {
  if (!entry) return 1;
  return entry.multiplier ?? DEFAULT_MULTIPLIER[entry.status];
}

// Scale projected points by the news multiplier. Applied to raw projections
// BEFORE ranking so VOR, positional tiers and VONA survival all agree.
export function applyNews<T extends { name: string; points: number }>(
  projections: T[],
  news: Map<string, NewsEntry>,
): { adjusted: T[]; changed: { name: string; from: number; to: number; status: NewsStatus }[] } {
  const changed: { name: string; from: number; to: number; status: NewsStatus }[] = [];
  const adjusted = projections.map((p) => {
    const entry = newsFor(news, p.name);
    const m = newsMultiplier(entry);
    if (!entry || m === 1) return p;
    const to = p.points * m;
    changed.push({ name: p.name, from: p.points, to, status: entry.status });
    return { ...p, points: to };
  });
  return { adjusted, changed };
}
