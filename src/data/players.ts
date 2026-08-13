import { DATA_DIR } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import type { PlayersMap } from "../sleeper/types.ts";

// The player dump is large and changes slowly. Cache it on disk and only
// refresh when older than the TTL, so we are polite to the API.

const CACHE_PATH = `${DATA_DIR}players.json`;
const META_PATH = `${DATA_DIR}players.meta.json`;
const TTL_MS = 24 * 60 * 60 * 1000; // one day

interface CacheMeta {
  fetchedAt: number;
  count: number;
}

async function readMeta(): Promise<CacheMeta | null> {
  const f = Bun.file(META_PATH);
  if (!(await f.exists())) return null;
  return (await f.json()) as CacheMeta;
}

export async function loadPlayers(opts?: {
  forceRefresh?: boolean;
}): Promise<PlayersMap> {
  const meta = await readMeta();
  const fresh = meta && Date.now() - meta.fetchedAt < TTL_MS;

  if (!opts?.forceRefresh && fresh && (await Bun.file(CACHE_PATH).exists())) {
    return (await Bun.file(CACHE_PATH).json()) as PlayersMap;
  }

  const players = await sleeper.playersDump();
  await Bun.write(CACHE_PATH, JSON.stringify(players));
  await Bun.write(
    META_PATH,
    JSON.stringify(
      { fetchedAt: Date.now(), count: Object.keys(players).length } satisfies CacheMeta,
      null,
      2,
    ),
  );
  return players;
}

export async function cacheStatus(): Promise<{ fetchedAt: number; count: number } | null> {
  return readMeta();
}
