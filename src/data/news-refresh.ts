#!/usr/bin/env bun
// Rebuild the news dossier every morning.
//
// The dossier (/data/sleeper-coach/news.json) scales projections BEFORE any
// value is computed, and until now it was hand-written on draft day and never
// touched again. Filip: "we should fix the news feed to refresh automatically
// like every morning or something." A four-day-old note saying a player faces
// suspension is not the same as knowing he is about to miss the season.
//
// Two layers, and the deterministic one is the floor:
//
//   1. FROM THE SLEEPER DUMP, no model involved. injury_status, roster status
//      and depth_chart_order are fetched fresh daily anyway. This is what would
//      have caught Josh Jacobs (NA, 4th on the depth chart) on its own.
//   2. FROM THE WEB, via a research agent that may only search and fetch. It
//      returns JSON; it never writes the file. Everything it says is validated
//      here: known player names only, a fixed status vocabulary, a bounded
//      multiplier. A page it read is untrusted input, so it runs with no shell,
//      no filesystem and no coach prompt (see runAgent research mode).
//
// The file is REBUILT, not appended to, so stale notes cannot linger. The
// agent's entry wins over the dump's for the same player, because it knows why.

import { loadPlayers } from "./players.ts";
import { sleeper } from "../sleeper/client.ts";
import { config } from "../config.ts";
import { runAgent } from "../agent/runner.ts";
import { logEvent } from "../log.ts";
import type { NewsStatus } from "./news.ts";

const NEWS_PATH = process.env.NEWS_PATH ?? "/data/sleeper-coach/news.json";
const STATUSES: readonly NewsStatus[] = ["out", "risk", "watch", "soft"];

export interface DossierEntry { status: NewsStatus; note: string; multiplier?: number; source: "dump" | "web" }
export type Dossier = Record<string, DossierEntry>;

interface DumpPlayer {
  full_name?: string; position?: string; team?: string | null; status?: string | null;
  injury_status?: string | null; injury_notes?: string | null; depth_chart_order?: number | null;
}

/** Layer 1. Pure, so it is tested. */
export function dossierFromDump(dump: Record<string, DumpPlayer>, watch: Set<string>): Dossier {
  const out: Dossier = {};
  for (const [id, p] of Object.entries(dump)) {
    if (!watch.has(id) || !p.full_name) continue;
    const inj = (p.injury_status ?? "").toLowerCase();
    const st = (p.status ?? "Active").toLowerCase();
    const skill = ["QB", "RB", "WR", "TE"].includes(p.position ?? "");
    const notes = p.injury_notes ? ` ${p.injury_notes}` : "";
    if (["out", "ir", "pup", "sus", "na"].includes(inj) || st !== "active") {
      out[p.full_name] = { status: "out", note: `Sleeper lists him ${p.injury_status ?? p.status}.${notes}`, source: "dump" };
    } else if (inj === "doubtful") {
      out[p.full_name] = { status: "risk", note: `Doubtful.${notes}`, multiplier: 0.6, source: "dump" };
    } else if (skill && typeof p.depth_chart_order === "number" && p.depth_chart_order >= 3) {
      out[p.full_name] = { status: "risk", note: `Listed ${p.depth_chart_order}th on his depth chart at ${p.position}; projection has not caught up.`, multiplier: 0.7, source: "dump" };
    } else if (inj === "questionable") {
      out[p.full_name] = { status: "watch", note: `Questionable.${notes}`, source: "dump" };
    }
  }
  return out;
}

/** Layer 2 output, validated. Anything malformed is dropped, never repaired. */
export function validateWebEntries(raw: unknown, knownNames: Set<string>): Dossier {
  const out: Dossier = {};
  const list = Array.isArray(raw) ? raw : (raw as { players?: unknown[] } | null)?.players;
  if (!Array.isArray(list)) return out;
  for (const e of list as Record<string, unknown>[]) {
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const status = e.status as NewsStatus;
    if (!name || !knownNames.has(name) || !STATUSES.includes(status)) continue;
    const note = typeof e.note === "string" ? e.note.trim().slice(0, 300) : "";
    if (!note) continue;
    let multiplier: number | undefined;
    if (typeof e.multiplier === "number" && Number.isFinite(e.multiplier)) multiplier = Math.min(1, Math.max(0.05, e.multiplier));
    out[name] = { status, note, multiplier, source: "web" };
  }
  return out;
}

export function merge(dump: Dossier, web: Dossier): Dossier {
  return { ...dump, ...web };
}

const RESEARCH_PROMPT = (names: string[], today: string) => `Today is ${today}. You are researching NFL availability for a fantasy football manager.

For EACH of these players, find out whether anything threatens his availability or role for the coming weeks: injury, suspension, legal case, holdout, demotion on the depth chart, or a trade. Use web search. Prefer reports from the last 7 days.

Players: ${names.join(", ")}

Reply with ONLY a JSON object, no prose, of the form:
{"players":[{"name":"<exact name from the list>","status":"out|risk|watch|soft","note":"<one sentence, with the date of the report>","multiplier":<optional number 0.05-1>}]}

Status meaning: out = will miss most or all of the rest of the season; risk = real chance of missing time or losing his role (give a multiplier, e.g. 0.6 for a likely multi-week absence); watch = playing but carrying something worth knowing; soft = minor. Omit any player with nothing to report. Never invent a report; if you did not find one, leave him out.`;

/** Who the dossier covers: everyone rostered in the league plus the top of the
 *  free-agent pool. The pool is filtered to ACTIVE players with a team, because
 *  the dump keeps retired players with a stale search_rank and the first dry run
 *  dutifully reported Drew Brees and Julian Edelman as out. Pure, so tested. */
export function watchSet(dump: Record<string, DumpPlayer & { search_rank?: number }>, rostered: Iterable<string>, poolSize = 60): Set<string> {
  const watch = new Set<string>(rostered);
  const pool = Object.entries(dump)
    .filter(([id, p]) => !watch.has(id) && p.full_name && ["QB", "RB", "WR", "TE"].includes(p.position ?? "")
      && (p.status ?? "").toLowerCase() === "active" && !!p.team && typeof p.search_rank === "number")
    .sort((a, b) => (a[1].search_rank ?? 9999) - (b[1].search_rank ?? 9999))
    .slice(0, poolSize);
  for (const [id] of pool) watch.add(id);
  return watch;
}

export async function refreshNews(opts: { web?: boolean; dry?: boolean } = {}): Promise<{ dump: number; web: number; total: number; path: string }> {
  const dump = (await loadPlayers()) as Record<string, DumpPlayer & { search_rank?: number }>;
  const rosters = await sleeper.rosters(config.leagueId);
  const watch = watchSet(dump, rosters.flatMap((r) => r.players ?? []));

  const fromDump = dossierFromDump(dump, watch);
  let fromWeb: Dossier = {};
  if (opts.web !== false) {
    const names = [...watch].map((id) => dump[id]?.full_name).filter((n): n is string => !!n);
    const known = new Set(names);
    const res = await runAgent({
      prompt: RESEARCH_PROMPT(names, new Date().toISOString().slice(0, 10)),
      research: true, partial: false, effort: "medium",
      extraSystemPrompt: "You are a careful sports researcher. Output valid JSON only.",
    });
    const text = res.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      fromWeb = validateWebEntries(JSON.parse(text), known);
      // Zero survivors is not an error, but it is not silence either: log the
      // head so "the agent found nothing" and "the agent returned prose that
      // happened to parse" can be told apart from the activity feed.
      if (!Object.keys(fromWeb).length) {
        logEvent("coach", "news-web-empty", "Research agent returned no usable entries", { error: res.error ?? null, head: text.slice(0, 300) });
      }
    } catch (e) {
      logEvent("coach", "news-web-failed", "Research agent did not return valid JSON; using the dump layer only", { error: String(e), agentError: res.error ?? null, head: text.slice(0, 300) });
    }
  }
  const merged = merge(fromDump, fromWeb);
  const file = { updatedAt: new Date().toISOString(), players: merged };
  if (!opts.dry) await Bun.write(NEWS_PATH, JSON.stringify(file, null, 2));
  logEvent("coach", "news-refreshed", `News dossier rebuilt: ${Object.keys(fromDump).length} from Sleeper, ${Object.keys(fromWeb).length} from the web`, {
    dump: Object.keys(fromDump).length, web: Object.keys(fromWeb).length, dry: !!opts.dry,
    out: Object.entries(merged).filter(([, e]) => e.status === "out").map(([n]) => n),
  });
  return { dump: Object.keys(fromDump).length, web: Object.keys(fromWeb).length, total: Object.keys(merged).length, path: NEWS_PATH };
}

if (import.meta.main) {
  const r = await refreshNews({ web: !process.argv.includes("--no-web"), dry: process.argv.includes("--dry") });
  console.log(`[news] ${r.total} entries (${r.dump} Sleeper, ${r.web} web)${process.argv.includes("--dry") ? " [dry, not written]" : ` -> ${r.path}`}`);
}
