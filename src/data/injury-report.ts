// What the reporting says about each injured player: the injury, when he is
// expected back, or that his season is over.
//
// Filip, 2026-11-16, after Jalen Hurts held an IR seat for weeks with a
// season-ending blood-clot diagnosis: "You need to specifically read the news
// when a player is injured and see what people are saying. Are people saying
// he's going to be out for a week or two, or are people saying this player has
// blood clots and needs to be on blood thinners for 3-6 months and can't play
// while he's on them." And: "this is not something you can just shortcut."
//
// The projection feed zeroes every injured player for every week, so it cannot
// tell a two-week hamstring from a season-ending diagnosis, and a status flag
// (Out, IR) cannot either. Only the reporting can. So for every player Sleeper
// lists as not playing, a research agent reads the current reporting and
// returns, with the sources it read: the injury, the expected return week, and
// whether he is done for the season. Unknown stays unknown: no report, or a
// report without a source, decides nothing.
//
// Refreshed daily with the news dossier, and at once for a player of ours whose
// status turns to not playing (daemon: refreshInjuriesFor).

import { loadPlayers } from "./players.ts";
import { sleeper } from "../sleeper/client.ts";
import { config } from "../config.ts";
import { takenAcrossLeague } from "../analysis/roster-view.ts";
import { runAgent } from "../agent/runner.ts";
import { logEvent } from "../log.ts";
import { STATE_DIR } from "../paths.ts";
import { extractJson } from "./news-refresh.ts";

export const INJURY_PATH = process.env.INJURY_PATH ?? `${STATE_DIR}/injury-reports.json`;
/** Sleeper statuses that mean he is not playing now. Questionable plays. */
const NOT_PLAYING = new Set(["OUT", "IR", "PUP", "SUS", "NA", "DOUBTFUL", "DNR", "COV"]);
/** A report older than this is researched again. */
export const REPORT_TTL_MS = 20 * 3_600_000;

export type Confidence = "high" | "medium" | "low";
export interface InjuryReport {
  playerId: string;
  name: string;
  /** The Sleeper status when this was researched; a change triggers a re-read. */
  sleeperStatus: string;
  injury: string;
  /** NFL week he is expected to play again; null when the reporting gives none. */
  returnWeek: number | null;
  /** The reporting says he will not play again this NFL season. */
  seasonOver: boolean;
  /** Who said so: only "team" or "doctor" makes season-over certain. Filip:
   *  "we want to know first, certain, that some doctor said this guy's not
   *  going to play anymore." "maybe" from a reporter is "report". */
  confirmedBy: "team" | "doctor" | "report" | "none";
  confidence: Confidence;
  summary: string;
  sources: string[];
  researchedAt: string;
}
export interface InjuryFile { updatedAt: string; week: number; reports: Record<string, InjuryReport> }

// #region pure
const CONF: Confidence[] = ["high", "medium", "low"];

/** Keep only reports that cite a source and make sense for this week. */
export function validateReports(raw: unknown, wanted: Map<string, { playerId: string; status: string }>, week: number, nowIso: string): Record<string, InjuryReport> {
  const out: Record<string, InjuryReport> = {};
  const list = (raw as { players?: unknown[] } | null)?.players;
  if (!Array.isArray(list)) return out;
  for (const e of list as Record<string, unknown>[]) {
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const who = wanted.get(name);
    if (!who) continue;
    const sources = (Array.isArray(e.sources) ? e.sources : []).filter((u): u is string => typeof u === "string" && /^https?:\/\/\S+$/.test(u.trim())).map((u) => u.trim());
    if (!sources.length) continue; // an unsourced claim decides nothing
    const summary = typeof e.summary === "string" ? e.summary.trim().slice(0, 400) : "";
    const injury = typeof e.injury === "string" ? e.injury.trim().slice(0, 120) : "";
    if (!summary) continue;
    const confidence = CONF.includes(e.confidence as Confidence) ? (e.confidence as Confidence) : "low";
    const seasonOver = e.seasonOver === true;
    const confirmedBy = (["team", "doctor", "report", "none"] as const).includes(e.confirmedBy as never) ? (e.confirmedBy as InjuryReport["confirmedBy"]) : "none";
    let returnWeek: number | null = typeof e.returnWeek === "number" && Number.isInteger(e.returnWeek) ? e.returnWeek : null;
    if (returnWeek !== null && (returnWeek < week || returnWeek > 22)) returnWeek = null;
    if (seasonOver) returnWeek = null;
    out[who.playerId] = { playerId: who.playerId, name, sleeperStatus: who.status, injury, returnWeek, seasonOver, confirmedBy, confidence, summary, sources, researchedAt: nowIso };
  }
  return out;
}

/** Players to (re)research: not playing per Sleeper, and no fresh report or a
 *  report from a different status. */
export function needsResearch(
  injured: { playerId: string; status: string }[], existing: Record<string, InjuryReport>, now: number,
): string[] {
  return injured.filter((p) => {
    const r = existing[p.playerId];
    if (!r) return true;
    if (r.sleeperStatus !== p.status) return true;
    return now - Date.parse(r.researchedAt) > REPORT_TTL_MS;
  }).map((p) => p.playerId);
}

/** The facts a roster decision may act on.
 *  - seasonOver: CERTAIN only. The team or a doctor said he will not play
 *    again this season, the report is high confidence, and Sleeper still lists
 *    him not playing. "We're not sure he plays again" is not season over.
 *  - returnWeek: a medium or high confidence timeline.
 *  Anything else is unknown, and unknown never releases anyone. */
export interface InjuryFacts { seasonOver: boolean; returnWeek: number | null; known: boolean }
export function factsFor(r: InjuryReport | undefined, liveStatus: string | null | undefined, week: number): InjuryFacts {
  const notPlaying = NOT_PLAYING.has((liveStatus ?? "").trim().toUpperCase());
  if (!r || !notPlaying) return { seasonOver: false, returnWeek: null, known: false };
  const seasonOver = r.seasonOver && r.confidence === "high" && (r.confirmedBy === "team" || r.confirmedBy === "doctor");
  // A return week that has come while he is still listed out is stale: the
  // timeline slipped, so it is unknown again until the next read.
  const returnWeek = r.confidence !== "low" && r.returnWeek !== null && r.returnWeek > week ? r.returnWeek : null;
  return { seasonOver, returnWeek: seasonOver ? null : returnWeek, known: seasonOver || returnWeek !== null };
}
// #endregion

// #region io
export async function loadInjuryReports(): Promise<InjuryFile> {
  try {
    const f = Bun.file(INJURY_PATH);
    if (await f.exists()) return (await f.json()) as InjuryFile;
  } catch { /* unreadable: treat as empty, decisions fall back to unknown */ }
  return { updatedAt: "", week: 0, reports: {} };
}

const PROMPT = (people: { name: string; team: string; status: string }[], week: number, today: string) => `Today is ${today}, NFL week ${week} of the regular season (fantasy season ends week 17).

These players are listed as not playing. For EACH one, use web search to read the current reporting about his injury or absence: what the injury is, what doctors, the team and beat reporters say about the timeline, and when he is expected to play again. Read the actual articles; do not guess from the injury type alone.

Players:
${people.map((p) => `- ${p.name} (${p.team}, Sleeper status ${p.status})`).join("\n")}

For each player decide:
- returnWeek: the NFL week he is expected to play again, as an integer, if the reporting supports one. Null if the reporting gives no timeline.
- seasonOver: true only if it is CERTAIN he will not play again this NFL season: the team announced it, a team doctor or surgeon said it, or he had season-ending surgery or was placed on season-ending IR. "Might miss the rest of the season", "could be done", "not sure he returns" is NOT season over: set false and give a returnWeek only if one is reported. A long but finite timeline that ends before week 18 is NOT season over; give the returnWeek.
- confirmedBy: "team" if the team announced it, "doctor" if a team doctor or surgeon (or a medical diagnosis with a stated treatment that rules him out, such as blood thinners he cannot play on) is the source, "report" if it rests on reporters or insiders only, "none" if nothing.
- confidence: high = team or doctor statement or multiple reliable reports agree; medium = one reliable report; low = speculation.

Your reply must END with a single JSON object and nothing after it:
{"players":[{"name":"<exact name from the list>","injury":"<injury>","returnWeek":<integer or null>,"seasonOver":<true|false>,"confirmedBy":"team|doctor|report|none","confidence":"high|medium|low","summary":"<one or two sentences of what the reporting says, with dates>","sources":["<URL you actually read>"]}]}
Every entry MUST list at least one source URL you fetched. If you found nothing reliable for a player, leave him out.`;

/** Research the given players (all not-playing league players when omitted)
 *  and merge into the file. */
export async function refreshInjuries(opts: { onlyIds?: string[]; dry?: boolean } = {}): Promise<{ researched: number; reports: number; fresh: Record<string, InjuryReport>; asked: string[] }> {
  const state = await sleeper.nflState();
  const week = Math.max(1, state.week || 1);
  const dump = (await loadPlayers()) as Record<string, { full_name?: string; team?: string | null; injury_status?: string | null; position?: string }>;
  const rosters = await sleeper.rosters(config.leagueId);
  const owned = takenAcrossLeague(rosters);
  const injured = [...owned]
    .map((id) => ({ playerId: id, status: (dump[id]?.injury_status ?? "").trim(), name: dump[id]?.full_name ?? "", team: dump[id]?.team ?? "FA", pos: dump[id]?.position ?? "" }))
    .filter((p) => p.name && ["QB", "RB", "WR", "TE", "K"].includes(p.pos) && NOT_PLAYING.has(p.status.toUpperCase()));
  const file = await loadInjuryReports();
  const now = Date.now();
  const ids = opts.onlyIds ?? needsResearch(injured, file.reports, now);
  const todo = injured.filter((p) => ids.includes(p.playerId));
  if (!todo.length) return { researched: 0, reports: Object.keys(file.reports).length, fresh: {}, asked: [] };
  const res = await runAgent({
    prompt: PROMPT(todo.map((p) => ({ name: p.name, team: p.team, status: p.status })), week, new Date().toISOString().slice(0, 10)),
    research: true, partial: false, effort: "medium",
    model: process.env.NEWS_MODEL ?? "claude-sonnet-5",
    extraSystemPrompt: "You are a careful sports injury researcher. Output valid JSON only at the end.",
  });
  const parsed = extractJson(res.text);
  const wanted = new Map(todo.map((p) => [p.name, { playerId: p.playerId, status: p.status }]));
  const fresh = parsed ? validateReports(parsed, wanted, week, new Date().toISOString()) : {};
  if (!parsed) logEvent("coach", "injury-research-failed", "Injury research returned no JSON; previous reports kept", { error: res.error ?? null, head: res.text.slice(0, 300) });
  // Drop reports for players who are playing again or no longer rostered.
  const stillInjured = new Set(injured.map((p) => p.playerId));
  const reports: Record<string, InjuryReport> = {};
  for (const [id, r] of Object.entries(file.reports)) if (stillInjured.has(id)) reports[id] = r;
  Object.assign(reports, fresh);
  if (!opts.dry) await Bun.write(INJURY_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), week, reports }, null, 2));
  logEvent("coach", "injury-research", `Injury reporting read for ${todo.length} player(s); ${Object.keys(fresh).length} sourced`, {
    reports: Object.values(fresh).map((r) => `${r.name}: ${r.seasonOver ? "season over" : r.returnWeek ? `back week ${r.returnWeek}` : "no timeline"} (${r.confidence}) ${r.injury}`),
  });
  return { researched: todo.length, reports: Object.keys(reports).length, fresh, asked: todo.map((p) => p.name) };
}
// #endregion

if (import.meta.main) {
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
  const dry = process.argv.includes("--dry");
  const r = await refreshInjuries({ onlyIds: ids.length ? ids : undefined, dry });
  console.log(`[injuries] asked about: ${r.asked.join(", ")}`);
  for (const rep of Object.values(r.fresh)) {
    const f = factsFor(rep, rep.sleeperStatus, (await sleeper.nflState()).week || 1);
    console.log(`\n${rep.name} (${rep.sleeperStatus}) — ${rep.injury}`);
    console.log(`  reporting: ${rep.seasonOver ? "season over" : rep.returnWeek ? `back week ${rep.returnWeek}` : "no timeline"}; confirmed by ${rep.confirmedBy}; confidence ${rep.confidence}`);
    console.log(`  bot would treat as: ${f.seasonOver ? "SEASON OVER (release)" : f.returnWeek ? `returns week ${f.returnWeek}` : "unknown (hold)"}`);
    console.log(`  ${rep.summary}`);
    console.log(`  ${rep.sources.join(" ")}`);
  }
  const missing = r.asked.filter((n) => !Object.values(r.fresh).some((x) => x.name === n));
  if (missing.length) console.log(`\nno sourced report: ${missing.join(", ")}`);
  console.log(`\n[injuries] researched ${r.researched}${dry ? " (dry, nothing written)" : ""}`);
}
