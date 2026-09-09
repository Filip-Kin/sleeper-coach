#!/usr/bin/env bun
// Autonomous draft orchestrator.
//
// ALL draft state comes from Sleeper GraphQL plus our own local record. The
// 2026 draft ran off the draft-room DOM because REST /draft/<id>/picks lags by
// up to a day during a live draft (that lag caused mistimed turns, duplicate
// QB/TE past the cap, and a missed pick). GraphQL draft_picks is the feed the
// room itself renders from, so the DOM is no longer needed:
//   - turn        = get_draft status is "drafting" and the lowest open pick_no
//                   belongs to our draft_order slot
//   - available   = our value board minus draft_picks, filtered to active players
//   - our roster  = tracked LOCALLY as we pick (zero lag), seeded from the picks
//   - rival picks = draft_picks, with full names from the pick metadata
//   - pick landed = a pick appears at the pick_no we sent
// The agent plans between picks; on the clock we act fast and deterministically.
//
//   bun run src/draft/run.ts [draftId] [--rehearse] [--seat=N] [--open-room]
//
// --open-room points the shared browser at the draft room once, for whoever is
// watching over noVNC. Nothing is read back from it.

import { unlinkSync } from "node:fs";
import { config, vonaConfig } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { browserGql } from "../league/api.ts";
import {
  publicDraftGql, getDraft, draftPicks, draftQueue, updateDraftQueue, draftPickPlayer, reactToDraftPick,
  draftAutopickers, activePlayers, availableIds, clockState, claimDraftSlot, updateDraftStatus,
  pickRound, pickSlot, type DraftInfo, type LivePick, type ClockState,
} from "../league/draft-api.ts";
import { runAgent } from "../agent/runner.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor, type RankedPlayer } from "../analysis/vor.ts";
import { rankByVona, type VonaPlayer } from "../analysis/vona.ts";
import { positionCap, slotOnClock, ownPickNo, nextOwnPickNo } from "./logic.ts";
import { gapDemandFor } from "./opponents.ts";
import { byeWeek, byeCounts } from "../data/byes.ts";
import { loadNews, newsFor, applyNews, type NewsEntry } from "../data/news.ts";
import { logEvent, logThink } from "../log.ts";
import { sendAlert } from "../alert.ts";

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
// Pause between announcing our intent and picking, so the announcer's voice
// leads the pick. Safe: the draft clock is 90s+, and if the announcer is dead
// this is just a short fixed wait, never an actual block.
const ANNOUNCE_LEAD_MS = Number(process.env.ANNOUNCE_LEAD_MS ?? 6000);
// A deliberate beat on the clock before committing, purely so the face has time
// to show it working. There is nothing to compute here: the plan is refreshed
// BETWEEN our picks, off the clock, so the decision is genuinely instant and an
// instant pick looks to a viewer like nothing happened at all. Five seconds of a
// ninety second clock costs nothing, and ANNOUNCE_LEAD_MS already sets the
// precedent of pacing this for an audience. Set to 0 to pick immediately.
const THINK_PAUSE_MS = Number(process.env.THINK_PAUSE_MS ?? 5000);
const argv = process.argv.slice(2);
const draftId = argv.find((a) => !a.startsWith("--")) ?? config.draftId;
const rehearse = argv.includes("--rehearse");
const openRoom = argv.includes("--open-room");
const seat = Number(argv.find((a) => a.startsWith("--seat="))?.split("=")[1] ?? "0"); // 0-indexed CLAIM
const roomUrl = `https://sleeper.com/draft/nfl/${draftId}`;

// Two transports. Public reads go straight to the endpoint (no token, no
// browser serialisation); anything user-scoped or mutating carries the session
// token by running inside the logged-in page.
const pub = publicDraftGql;
const auth = browserGql(API);

let draft: DraftInfo = await getDraft(pub, draftId);
const teams = draft.teams;
const rounds = draft.rounds;
console.log(`[draft-run] draft ${draftId}: ${teams}x${rounds}=${teams * rounds} picks, ${draft.pickTimer}s clock, status ${draft.status}${draft.leagueId ? "" : " (mock)"}`);

await Bun.write(DRAFT_LOCK, String(draftId)); // daemon: hands off the browser

if (openRoom) {
  await fetch(`${API}/goto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: roomUrl }) })
    .catch((e: unknown) => console.log(`[draft-run] open-room failed: ${e instanceof Error ? e.message : String(e)}`));
}

// Rehearsal: claim a seat (position variety via --seat) before setting the queue.
if (rehearse) {
  console.log(`[draft-run] rehearse: claiming seat ${seat + 1}`);
  try {
    draft = await claimDraftSlot(auth, draftId, seat + 1);
  } catch (e) {
    console.log(`[draft-run] rehearse: claim failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// If Sleeper has us on autopick it drafts off the queue the instant we are on
// the clock, before this loop can act. Say so up front rather than discovering
// it as a string of "did NOT register" alerts.
{
  const auto = await draftAutopickers(pub, draftId).catch(() => [] as string[]);
  if (auto.includes(config.userId)) {
    console.log("[draft-run] WARNING: we are on Sleeper autopick; turn it off in the room or the queue picks for us");
    if (!rehearse) await sendAlert("Draft: autopick is ON", "Sleeper lists us as an autopicker. Turn it off in the draft room or the queue picks ahead of the coach.");
  }
}

// Value the board by THIS league's live scoring settings (full PPR).
const league = await sleeper.league(config.leagueId);
const scoring = league.scoring_settings;
const rec = scoring.rec ?? 0;
const scoringLabel = rec >= 1 ? "full-PPR" : rec > 0 ? `${rec}-PPR` : "standard";
console.log(`[draft-run] scoring: ${scoringLabel} (rec ${rec})`);
const rawProjections = await loadSeasonProjections(config.season, scoring);

// The news layer. Projections and ADP feeds cannot see a pending suspension or
// a PUP list, so scale points by the dossier BEFORE value is computed, that way
// VOR, positional tiers and VONA survival all agree on what a player is worth.
// Only facts with a stated absence move a player; everything else is advisory
// text the agent reads on the shortlist (see src/data/news.ts).
const { updatedAt: newsAt, byKey: news } = await loadNews();
const { adjusted: projections, changed: newsChanged } = applyNews(rawProjections, news);
console.log(`[draft-run] news: ${news.size} entries (updated ${newsAt ?? "unknown"}), ${newsChanged.length} players devalued`);
for (const c of newsChanged) console.log(`[draft-run]   ${c.status.toUpperCase()} ${c.name}: ${c.from.toFixed(0)} -> ${c.to.toFixed(0)}pts`);
if (news.size === 0) console.log("[draft-run] WARNING: no news dossier loaded, drafting on numbers alone");
logEvent("coach", "news-loaded", `News dossier: ${news.size} entries, ${newsChanged.length} players devalued.`, { updatedAt: newsAt, changed: newsChanged });

// The static value board, VOR under our scoring. It does NOT depend on who's
// been drafted (availability is judged live from the DOM), so compute it once.
const fullBoard: RankedPlayer[] = rankByVor(projections, league, rawProjections);
const byName = new Map(fullBoard.map((b) => [b.name, b]));
const byId = new Map(fullBoard.map((b) => [b.playerId, b]));

// The active-player universe, read once. It filters the board to players
// Sleeper will actually let us draft; a retired or unsigned name in the
// projections feed is otherwise a pick that errors on the clock. Best effort:
// without it the board alone decides, which is what the DOM loop did too.
let activeIds: Set<string> | null = null;
try {
  const active = await activePlayers(pub);
  activeIds = new Set(active.map((p) => p.playerId));
  const offBoard = fullBoard.filter((b) => !/^[A-Z]{2,3}$/.test(b.playerId) && !activeIds!.has(b.playerId)).length;
  console.log(`[draft-run] active players: ${active.length} (${offBoard} board names not active, ignored)`);
} catch (e) {
  console.log(`[draft-run] WARNING: get_active_players failed (${e instanceof Error ? e.message : String(e)}); availability from the board alone`);
}

// #region VONA: value over next available
// Resolve draft slot -> Sleeper username, once, so the opponent survival prior
// can tell WHICH known manager picks in the gap before our next turn. Best
// effort: if a lookup fails we simply skip that seat's nudge.
const slotUsername = new Map<number, string>();
if (vonaConfig.enabled && vonaConfig.oppNudge > 0) {
  for (const [userId, slot] of Object.entries(draft.draftOrder ?? {})) {
    try {
      const u = await sleeper.user(userId);
      if (u?.username) slotUsername.set(slot, u.username);
    } catch { /* unknown seat -> no nudge */ }
  }
}

// Usernames of KNOWN managers picking between our current pick and our next one.
function gapUsernames(currentPick: number, nextPick: number): string[] {
  const out: string[] = [];
  for (let p = currentPick + 1; p < nextPick; p++) {
    const u = slotUsername.get(slotOnClock(p, teams));
    if (u) out.push(u);
  }
  return out;
}

// Rank the currently-available players by VONA for the round we're about to
// pick. Falls back to plain VOR order when VONA is disabled, our slot is
// unknown, or it's the final round (no "next pick" to predict against). Always
// returns VonaPlayer so callers can render one shape.
function rankAvailable(availableNames: Set<string>, round: number): VonaPlayer[] {
  const avail = [...availableNames]
    .map((n) => byName.get(n))
    .filter((b): b is RankedPlayer => !!b);
  const slot = myDraftSlot;
  const next = slot != null && round < rounds ? nextOwnPickNo(ownPickNo(round, slot, teams), slot, teams, rounds) : null;
  if (!vonaConfig.enabled || slot == null || next == null) {
    return avail
      .slice()
      .sort((a, b) => b.vor - a.vor)
      .map((p) => ({ ...p, vona: p.vor, pSurvive: 1 }));
  }
  const gapDemand = vonaConfig.oppNudge > 0 ? gapDemandFor(gapUsernames(ownPickNo(round, slot, teams), next)) : undefined;
  return rankByVona(avail, { nextPickNo: next, adpSpread: vonaConfig.adpSpread, gapDemand, oppNudge: vonaConfig.oppNudge });
}
// #endregion

// #region live state (all GraphQL)
interface BoardPick { round: number; slot: number; name: string; pos: string; pickNo: number; playerId: string }
interface State {
  onClock: boolean;
  available: { name: string; pos: string }[];
  drafted: number;
  picks: BoardPick[];
  clock: ClockState;
  draft: DraftInfo;
}

// Every drafted pick, tagged with the drafting slot derived from its pick_no.
// Names come from our board when the player is on it (so byName lookups for
// byes work) and from the pick's own metadata otherwise. Full names, unlike
// the abbreviated "B. Robinson" the board cells used to give us.
function toBoardPicks(picks: LivePick[]): BoardPick[] {
  return picks.map((p) => ({
    round: pickRound(p.pickNo, teams),
    slot: pickSlot(p.pickNo, teams),
    name: byId.get(p.playerId)?.name ?? p.name,
    pos: p.position || byId.get(p.playerId)?.position || "",
    pickNo: p.pickNo,
    playerId: p.playerId,
  }));
}

// Who is still draftable: the board minus the picks, minus anyone Sleeper no
// longer lists as active. Ordered by ADP so the top of the list reads like the
// room's default sort, which is what the dashboard's "available" panel shows.
function availableFrom(picks: LivePick[]): { name: string; pos: string }[] {
  const drafted = new Set(picks.map((p) => p.playerId));
  const ids = availableIds(byId.keys(), drafted, activeIds);
  return fullBoard
    .filter((b) => ids.has(b.playerId))
    .sort((a, b) => a.adp - b.adp || b.vor - a.vor)
    .map((b) => ({ name: b.name, pos: b.position }));
}

async function draftState(): Promise<State> {
  const [d, picks] = await Promise.all([getDraft(pub, draftId), draftPicks(pub, draftId)]);
  draft = d;
  const clock = clockState(d, picks);
  return { onClock: clock.onClock, available: availableFrom(picks), drafted: picks.length, picks: toBoardPicks(picks), clock, draft: d };
}

async function boardPicks(): Promise<BoardPick[]> {
  return toBoardPicks(await draftPicks(pub, draftId));
}
// #endregion

let plan: string[] = []; // ordered target names, best first
let lastRefresh = 0;
let refreshInFlight = false;
let lastReasoning = "";
let myDraftSlot: number | null = null;
let agentBackoffUntil = 0; // pause agent calls after an error (limit hit, etc.)

// Our slot, resolved once from the draft order. Null until the commissioner
// sets the order, which is why this re-reads get_draft until it appears.
async function resolveSlot(): Promise<void> {
  if (myDraftSlot != null) return;
  const d = await getDraft(pub, draftId);
  draft = d;
  const slot = d.draftOrder?.[config.userId];
  if (typeof slot === "number") myDraftSlot = slot;
}

// #region our roster: tracked LOCALLY as we pick (full names, zero API lag)
const myDrafted: { name: string; position: string }[] = [];
function localCounts(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const d of myDrafted) if (d.position) c[d.position] = (c[d.position] ?? 0) + 1;
  return c;
}
// #endregion

const QUEUE_DEPTH = 8;

// The autopick BACKSTOP queue (only used if the clock expires with automation
// dead). Built ONLY from the live-available set, kept short, balanced RB/WR, and
// never DEF/K (Sleeper autopicks down the queue, so a queued defense would
// surface early; left out, its native ADP autopick fills the tail late).
function buildQueue(counts: Record<string, number>, availSet: Set<string>): RankedPlayer[] {
  const live = availSet.size ? fullBoard.filter((b) => availSet.has(b.name)) : fullBoard;
  const rbs = live.filter((b) => b.position === "RB");
  const wrs = live.filter((b) => b.position === "WR");
  const out: RankedPlayer[] = [];
  let ri = 0, wi = 0;
  let rc = counts["RB"] ?? 0, wc = counts["WR"] ?? 0;
  while (out.length < QUEUE_DEPTH && (ri < rbs.length || wi < wrs.length)) {
    const takeRb = wi >= wrs.length ? true : ri >= rbs.length ? false : rc <= wc;
    if (takeRb && ri < rbs.length) { out.push(rbs[ri++]!); rc++; }
    else if (wi < wrs.length) { out.push(wrs[wi++]!); wc++; }
  }
  const te = (counts["TE"] ?? 0) >= 1 ? [] : live.filter((b) => b.position === "TE").slice(0, 1);
  const qb = (counts["QB"] ?? 0) >= 1 ? [] : live.filter((b) => b.position === "QB").slice(0, 1);
  return [...out, ...te, ...qb];
}

// Push the backstop queue. Reads a fresh live-available set itself, and is only
// ever called OFF the clock (start + right after we pick), never mid-clock.
// update_draft_queue REPLACES the queue (verified on a mock draft 2026-09-09:
// it echoes back exactly the ids sent), so there is no stale tail to clear.
async function pushQueue(): Promise<void> {
  const s = await draftState();
  const q = buildQueue(localCounts(), new Set(s.available.map((a) => a.name)));
  if (q.length) {
    const names = q.map((b) => b.name);
    let pushed: string[] = [];
    try {
      pushed = await updateDraftQueue(auth, draftId, q.map((b) => b.playerId));
    } catch (e) {
      console.log(`[draft-run] queue push failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Log what we actually pushed. The dashboard previously had to reconstruct
    // the queue from the lagging picks feed and label it an estimate, because
    // nothing recorded it. During the 2026 draft Filip could not see what the
    // engine intended to do, which was the clearest UX failure of the night.
    logEvent("coach", "queue", `Backstop queue: ${names.join(", ")}`, { queue: names, playerIds: q.map((b) => b.playerId), pushed: pushed.length });
  }
}

// Log every NEW board pick once, so downstream consumers (the Discord announcer)
// have the full draft, who took whom, in which round, to make pick-specific
// commentary. Names here are the board's abbreviated form ("B. Robinson").
const seenBoardPicks = new Set<string>();
function logNewBoardPicks(picks: BoardPick[]): void {
  for (const p of picks) {
    const key = `${p.round}.${p.slot}.${p.name}`;
    if (seenBoardPicks.has(key)) continue;
    seenBoardPicks.add(key);
    const mine = p.slot === myDraftSlot;
    logEvent("coach", "board-pick", `${mine ? "WE" : `Team ${p.slot}`} drafted ${p.name} (${p.pos}) in R${p.round}`, { round: p.round, slot: p.slot, name: p.name, pos: p.pos, mine, pickNo: p.pickNo, playerId: p.playerId });
  }
}

// #region emoji troll: react on Sleeper when a rival snipes a player we wanted
const TROLL = process.env.TROLL !== "0"; // on by default; TROLL=0 disables
const reactedPicks = new Set<string>(); // keyed by "round.slot.name"
function lastName(n: string): string {
  return (n.trim().split(/\s+/).slice(-1)[0] ?? n).toLowerCase();
}
async function maybeTroll(picks: BoardPick[]): Promise<void> {
  if (!TROLL || myDraftSlot == null || plan.length === 0) return;
  const top3 = plan.slice(0, 3).map(lastName);
  const top8 = plan.slice(0, 8).map(lastName);
  for (const p of picks) {
    const key = `${p.round}.${p.slot}.${p.name}`;
    if (reactedPicks.has(key) || p.slot === myDraftSlot) continue;
    const ln = lastName(p.name);
    if (!top8.includes(ln)) continue;
    reactedPicks.add(key);
    const emoji = top3.includes(ln) ? "crying" : "shock";
    // The reaction lands on the pick number, and the response carries the
    // pick's reactions map, so "landed" is read back rather than assumed.
    const landed = await reactToDraftPick(auth, draftId, p.pickNo, emoji)
      .then((r) => (r.reactions[config.userId] ?? []).includes(emoji))
      .catch(() => false);
    logEvent("coach", "troll", `Reacted ${emoji} to ${p.name} (${p.pos}), one I wanted.`, { player: p.name, emoji, landed, pickNo: p.pickNo });
    return; // one per pass, never a burst
  }
}
// #endregion

// Observability: publish what the coach sees as available (live DOM) + the pick
// it's leaning toward, keyed to the REAL draft position, for the dashboard.
function logBoard(globalPick: number, round: number, available: { name: string; pos: string }[], target?: string): void {
  logEvent(
    "coach",
    "board",
    `Pick ${globalPick} · our R${round}: ${available.length} available${target ? `, leaning ${target}` : ""}`,
    { pickNo: globalPick, round, available: available.slice(0, 20), target, reasoning: lastReasoning },
  );
}

// The agent adjusts the PLAN (a ranked shortlist) reacting to the live draft. It
// never blocks a pick. On any agent error we log it, fall back to the value
// board, and back off so we don't hammer a failing agent.
// Live guidance from the manager, re-read on EVERY plan refresh so an edit lands
// within one cycle (~20s). Deliberately uncached for that reason. It is injected
// as the last and most salient part of the prompt, and it can override the
// generic strategy advice above it, but it cannot touch the deterministic rails
// (positionCap, must-fill, the bye veto) which are enforced in code after the
// agent has spoken. Any read failure is silently ignored: a missing or unreadable
// hint file must never be able to stop a draft.
const GUIDANCE_PATH = process.env.GUIDANCE_PATH ?? "/data/sleeper-coach/guidance.txt";
let lastGuidance = "";
async function readGuidance(): Promise<string> {
  try {
    const f = Bun.file(GUIDANCE_PATH);
    if (!(await f.exists())) return "";
    const t = (await f.text()).trim();
    if (t && t !== lastGuidance) {
      console.log(`[draft-run] manager guidance in effect: ${t.replace(/\s+/g, " ").slice(0, 200)}`);
      logEvent("coach", "guidance", `Manager guidance: ${t.replace(/\s+/g, " ").slice(0, 200)}`, { guidance: t });
    }
    lastGuidance = t;
    return t;
  } catch {
    return "";
  }
}

async function refreshPlan(available: { name: string; pos: string }[], recent: BoardPick[]): Promise<void> {
  await resolveSlot();
  const roster = myDrafted.map((d) => `${d.name} (${d.position})`);
  const availSet0 = new Set(available.map((a) => a.name));
  const round = myDrafted.length + 1;
  // Rank by VONA (value over next available), so the agent reasons off the same
  // scarcity signal the deterministic picker uses: who won't be here next turn.
  const availSet = availSet0.size ? availSet0 : new Set(fullBoard.map((b) => b.name));
  // Filter to what this round can actually take, using the SAME caps the picker
  // enforces. Without this the shortlist fills with kickers and defences: they
  // always survive to our next pick, so their VONA sits at ~0, which outranks a
  // receiver who falls back and scores negative. The picker discarded them
  // anyway, so the agent was spending its round-1 plan ranking placekickers.
  const planCounts = localCounts();
  const board = rankAvailable(availSet, round)
    .filter((b) => (planCounts[b.position] ?? 0) < positionCap(b.position, round))
    .slice(0, 22);
  const availNames = new Set(board.map((b) => b.name));
  const have = roster.length ? `Your roster so far: ${roster.join(", ")}.` : "Your roster is empty.";
  // Sleeper's injury_status is close to noise in preseason, so when the dossier
  // says the tag is soft we show the reporting INSTEAD of the bare tag, the
  // agent was previously fading healthy studs off a blanket "Questionable".
  const tagOf = (r: (typeof board)[number]): string => {
    const n: NewsEntry | undefined = newsFor(news, r.name);
    if (!n) return r.injuryStatus ? ` [${r.injuryStatus}]` : "";
    // "soft" exists to cancel a scary tag. With no tag to cancel it is just context.
    if (n.status === "soft") {
      return r.injuryStatus ? ` [${r.injuryStatus}, NOISE: ${n.note}]` : ` [${n.note}]`;
    }
    return `${r.injuryStatus ? ` [${r.injuryStatus}]` : ""} [${n.status.toUpperCase()}: ${n.note}]`;
  };
  const shortlist = board
    .map((r, i) => {
      const bye = byeWeek(r.team);
      return `${i + 1}. ${r.name}: ${r.position}${r.posRank} ${r.team}, ${r.points.toFixed(0)}pts VOR ${r.vor.toFixed(0)} VONA ${r.vona.toFixed(0)} surv ${Math.round(r.pSurvive * 100)}% ADP ${r.adp >= 999 ? "-" : r.adp.toFixed(0)} T${r.tier} bye${bye ?? "?"}${tagOf(r)}`;
    })
    .join("\n");
  // Bye-week concentration on the roster we've built so far. Stacking starters
  // on one bye costs a week of the season, and nothing in the value model sees it.
  const myByes = byeCounts(myDrafted.map((d) => byName.get(d.name)?.team));
  const byeStr = [...myByes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([wk, n]) => `week ${wk}: ${n}`)
    .join(", ");
  const heavyByes = [...myByes.entries()].filter(([, n]) => n >= 3).map(([wk]) => wk);
  // Players who probably won't make it back to us, flag the run risk explicitly.
  const goneSoon = board.filter((r) => r.pSurvive < 0.35).slice(0, 8);
  const goneStr = goneSoon.length
    ? `Likely GONE before your next pick (draft these now or lose them): ${goneSoon.map((r) => `${r.name} (${r.position}, ${Math.round(r.pSurvive * 100)}%)`).join("; ")}.`
    : "";
  const recentStr = recent
    .slice(-10)
    .map((p) => `R${p.round} team ${p.slot}${p.slot === myDraftSlot ? " [YOU]" : ""}: ${p.name} (${p.pos})`)
    .join("\n") || "(no picks yet)";
  const guidance = await readGuidance();
  const res = await runAgent({
    partial: false, // whole assistant messages → clean full reasoning in the console
    onEvent: (ev) => {
      if (ev.type !== "assistant") return;
      const msg = ev["message"];
      const content = msg && typeof msg === "object" ? (msg as { content?: unknown }).content : undefined;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
          const t = (b as { text?: unknown }).text;
          if (typeof t === "string") logThink("coach", t);
        }
      }
    },
    prompt:
      `You are the coach in a ${teams}-team ${scoringLabel} snake draft, about to make your round ${round} pick. ${have}\n` +
      `Recent picks (react to runs and what rivals are stacking):\n${recentStr}\n\n` +
      `YOU MAKE THE PICK. The first name you list that is still available is what gets drafted, so lead with your actual choice. ` +
      `Everything below is an input to that decision, not an instruction. ` +
      `The list is ranked by VONA (value over next available: value now minus what you can still get at that position when the pick snakes back to you). ` +
      `VOR is raw value, "surv" is the chance the player is still there at your next pick, VONA is the value you forfeit by waiting. ` +
      `VONA is a good default and you should usually take the top of it, but you are the only one who can see news, tiers, a run developing and the shape of your roster, ` +
      `so depart from it when you have a real football reason, and say what that reason is:\n${shortlist}\n\n` +
      (goneStr ? `${goneStr}\n\n` : "") +
      `Reading the tags: "bye N" is that player's bye week. A bracket marked NOISE means Sleeper flags him but the ` +
      `reporting says he is fine, do NOT downgrade him for it. RISK or OUT means a real chance of missing games, and ` +
      `his points above are ALREADY reduced for it, so do not penalise him twice. WATCH is a knock worth knowing but ` +
      `no value change. A note marked UPSIDE is an opportunity the projections have not caught up with yet.\n\n` +
      (byeStr ? `Your roster's bye weeks so far: ${byeStr}.\n` : "") +
      (heavyByes.length
        ? `You already have three or more players on the week ${heavyByes.join(" and ")} bye. Break the tie AWAY from that bye unless the player is clearly the best pick.\n\n`
        : "\n") +
      (guidance
        ? `\n=== GUIDANCE FROM YOUR MANAGER, written during this draft. This OVERRIDES the general strategy advice below wherever they conflict. Follow it unless it would leave a mandatory starting slot unfilled: ===\n${guidance}\n===\n\n`
        : "") +
      `Build the strongest STARTING lineup. Prioritise RB and WR heavily early (you start 2 RB, 2 WR, and 2 FLEX). ` +
      `Because RB is scarcer and fills your FLEX, build real RB depth, aim for about five RBs by the end, and don't ` +
      `stack more than about five WRs unless a WR is clearly the best value. You need only ONE tight end: do NOT reach ` +
      `for a TE, and never plan a second TE until the very last rounds; a TE is worth an early pick only if it is clearly ` +
      `the best value AND you have none. Take exactly ONE QB in this 1-QB league and only from the mid rounds; do NOT ` +
      `draft a backup QB (leave that to the very last round, if at all). Draft K and DEF only in the final 2-3 rounds. ` +
      `Anticipate RB/WR runs and respect tiers over raw rank. ` +
      `First write two or three sentences of reasoning about the board, runs, and roster needs. Then on a new line write "PICKS:" followed by up to 8 exact names ` +
      `from the list above, semicolon-separated, YOUR CHOICE FIRST and the rest as fallbacks in order if someone is taken before the click lands.\n` +
      `Your reasoning MUST justify the FIRST name on that list. If your reasoning talks you into a different player, change the LIST, not the reasoning, ` +
      `the first name is what actually gets drafted, and a mismatch means we draft someone you argued against.`,
  });
  if (res.error || !res.text.trim()) {
    plan = board.map((b) => b.name);
    lastReasoning = `Agent unavailable (${res.error ?? "empty response"}); using value board.`;
    agentBackoffUntil = Date.now() + 60_000;
    lastRefresh = Date.now();
    logEvent("coach", "plan-error", `Agent unavailable; drafting off the value board. (${res.error ?? "empty"})`, { error: res.error, plan: plan.slice(0, 6) });
    return;
  }
  const lines = res.text.split("\n").map((s) => s.trim()).filter(Boolean);
  const picksLine = lines.find((l) => /^picks\s*:/i.test(l)) ?? lines[lines.length - 1] ?? "";
  lastReasoning = (lines.filter((l) => l !== picksLine).join(" ") || res.text).slice(0, 300);
  const parsed = picksLine
    .replace(/^picks\s*:/i, "")
    .split(/[;\n]/)
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .filter((n) => availNames.has(n));
  plan = parsed.length ? parsed : board.map((b) => b.name);
  lastRefresh = Date.now();
  logEvent("coach", "plan", `Plan @R${round}: ${plan.slice(0, 4).join(", ")}`, { reasoning: lastReasoning, plan, roster });
}

// Initial plan + backstop queue (read the live board once). The existing
// queue is logged first so a leftover from a previous session is visible.
{
  const s0 = await draftState();
  const existing = await draftQueue(auth, draftId).catch(() => [] as string[]);
  if (existing.length) console.log(`[draft-run] existing queue: ${existing.map((id) => byId.get(id)?.name ?? id).join(", ")}`);
  await refreshPlan(s0.available, s0.picks);
  await pushQueue();
}

// Rehearsal: start the draft ourselves once the queue is set.
if (rehearse && draft.status === "pre_draft") {
  console.log("[draft-run] rehearse: starting draft");
  try {
    draft = await updateDraftStatus(auth, draftId, "drafting");
  } catch (e) {
    console.log(`[draft-run] rehearse: start failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Resolve our slot before picking anything. draft_order is null until the
// commissioner randomises the order, which in this league happens about fifteen
// minutes before kickoff, so wait it out (up to 30 min) rather than the old
// 60s. Proceeding without a slot is not harmless: on-clock detection compares
// the open pick's slot to ours, so without a slot we never pick at all.
{
  const slotDeadline = Date.now() + 30 * 60_000;
  let waited = 0;
  while (myDraftSlot == null && Date.now() < slotDeadline) {
    await resolveSlot();
    if (myDraftSlot != null) break;
    if (waited % 20 === 0) console.log("[draft-run] waiting for draft_order to be set (order not randomised yet)…");
    waited++;
    await Bun.sleep(3000);
  }
}
console.log(`[draft-run] our draft slot: ${myDraftSlot ?? "unresolved"}`);
if (myDraftSlot == null) {
  console.log("[draft-run] WARNING: slot unresolved, pick confirmation and VONA next-pick math are both degraded");
  if (!rehearse) await sendAlert("Draft: slot unresolved", "draft_order never appeared. The coach will still pick, but pick confirmation is unreliable, watch the room.");
}

// Seed our local roster from any picks already on the board at our slot (e.g.
// keepers, or a restart mid-draft), so round counting starts from reality.
for (const p of (await boardPicks()).filter((p) => p.slot === myDraftSlot)) {
  myDrafted.push({ name: p.name, position: p.pos });
}
console.log(`[draft-run] entering pick loop (seeded ${myDrafted.length} of our picks)…`);

let lastBoardAt = 0;
// Kick a plan refresh WITHOUT blocking the poll loop.
//
// This was a real defect, not a tuning knob. refreshPlan is an LLM call that can
// take tens of seconds, and the off-clock branch AWAITED it. While it ran we
// stopped checking whether our turn had started, so the clock could be running
// for half a minute before we noticed: the thinking face appeared ~30s late and
// the whole turn looked sluggish. The plan is only read at decision time, so a
// refresh that lands late simply applies to the next pick instead.
function kickRefresh(available: { name: string; pos: string }[], recent: BoardPick[]): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  void refreshPlan(available, recent)
    .catch(() => {
      lastRefresh = Date.now(); // don't retry in a tight loop on a failure
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

for (;;) {
  await resolveSlot();
  if (myDraftSlot == null) { await Bun.sleep(1500); continue; }
  if (myDrafted.length >= rounds) {
    console.log(`[draft-run] all ${rounds} of our picks made`);
    break;
  }
  const round = myDrafted.length + 1;
  const counts = localCounts();
  const state = await draftState().catch((e: unknown) => {
    console.log(`[draft-run] state read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (!state) { await Bun.sleep(1500); continue; }
  const { onClock, available, drafted } = state;
  const globalPick = state.clock.pickNo ?? drafted + 1;

  // The feed knows when the draft is over, which the DOM never told us. Stop
  // here rather than waiting forever for a pick that cannot come.
  if (state.draft.status === "complete") {
    console.log(`[draft-run] draft is complete with ${myDrafted.length} of our picks recorded`);
    break;
  }

  if (Date.now() - lastBoardAt > 5000) { logBoard(globalPick, round, available); lastBoardAt = Date.now(); }

  if (!onClock) {
    logNewBoardPicks(state.picks);
    await maybeTroll(state.picks).catch(() => {});
    if (Date.now() > agentBackoffUntil && Date.now() - lastRefresh > 20_000) kickRefresh(available, state.picks);
    await Bun.sleep(1500);
    continue;
  }

  // The open pick is ours. Re-read once before acting so a pause or a pick
  // that lands in the same instant (an autopick for us, a keeper) cannot make
  // us send a pick_no that is no longer open.
  await Bun.sleep(700);
  const confirm = await draftState();
  if (!confirm.onClock || confirm.clock.pickNo == null) continue;
  const pickNo = confirm.clock.pickNo;
  logNewBoardPicks(confirm.picks);

  // Tell the face we are on the clock the MOMENT the button goes live, not when
  // the decision is done. pick-intent fires after all the thinking has already
  // happened, so on its own the thinking face never appeared WHILE it was
  // thinking, which is precisely when a watcher wants to see it working.
  logEvent("coach", "on-clock", `On the clock: round ${round}.`, { round });
  if (THINK_PAUSE_MS > 0) await Bun.sleep(THINK_PAUSE_MS);

  let liveSet = new Set(confirm.available.map((a) => a.name));
  if (liveSet.size === 0) { liveSet = new Set((await draftState()).available.map((a) => a.name)); }

  const availOk = (b: RankedPlayer): boolean => liveSet.size === 0 || liveSet.has(b.name);
  const needOk = (pos: string): boolean => (counts[pos] ?? 0) < positionCap(pos, round);

  // Must-fill EVERY mandatory starting slot, not just DEF and K. Derived from
  // the league's own roster_positions so it cannot drift from the real settings.
  // RB and WR fill themselves, but QB and TE do not: value never prioritises
  // them, and now that the agent chooses freely it is entirely capable of taking
  // a fifth running back every round and finishing with an empty TE slot. Mock
  // #4 took a third RB over the top TE at R5, which is defensible on its own but
  // shows the failure mode is live. Reserve exactly as many final picks as there
  // are unfilled mandatory slots.
  const mandatorySlots = [...new Set(league.roster_positions.filter((p) => ["QB", "TE", "K", "DEF"].includes(p)))];
  const mandatoryMissing = mandatorySlots.filter((p) => (counts[p] ?? 0) === 0);
  const remaining = rounds - myDrafted.length; // picks left, including this one
  let target: RankedPlayer | undefined;
  let forcedMandatory = false;
  if (mandatoryMissing.length && remaining <= mandatoryMissing.length) {
    const pos = mandatoryMissing[0]!;
    // Kickers and defences are near-interchangeable (K1 to K11 spans about five
    // projected points across a whole season), so spend that spread on a clean
    // bye instead. Mock #4 force-filled a kicker onto week 11 and gave us four
    // players off that week; this path bypasses the bye veto, so it needs its
    // own check. Prefer names the draft room can actually see when it lists any
    // at this position, otherwise fall back to board order as before (DEF and K
    // are often outside the visible window, which is why there is no hard gate).
    const load = byeCounts(myDrafted.map((d) => byName.get(d.name)?.team));
    const atPos = fullBoard.filter((b) => b.position === pos);
    const visible = atPos.filter((b) => liveSet.has(b.name));
    const pool = (visible.length ? visible : atPos).slice(0, 8);
    target = pool.reduce((best, b) => {
      const lb = byeWeek(b.team) == null ? 0 : load.get(byeWeek(b.team)!) ?? 0;
      const lbest = byeWeek(best.team) == null ? 0 : load.get(byeWeek(best.team)!) ?? 0;
      if (lb < lbest) return b;
      if (lb === lbest && b.vor > best.vor) return b;
      return best;
    }, pool[0] ?? atPos[0]!);
    forcedMandatory = !!target;
    if (target && atPos[0] && target.name !== atPos[0].name) {
      console.log(`[draft-run] must-fill ${pos}: took ${target.name} (bye ${byeWeek(target.team) ?? "?"}) over ${atPos[0].name} (bye ${byeWeek(atPos[0].team) ?? "?"}) on bye load`);
    }
  }
  if (!target) {
    // DIVISION OF LABOUR. The deterministic layer owns the OPTION SET: what is
    // available, what the position caps allow, and the VONA value ranking over
    // that. The agent chooses WITHIN it. It is the only layer that can read
    // news, tiers, roster shape and a run developing, so confining it to a
    // near-tie made it decorative and pushed every real rule down into
    // mechanical hacks. The remaining deterministic powers are narrow and
    // named: the caps above, the DEF/K must-fill, and a bye-stack veto.
    //
    // planMaxRank is the safety bound and the revert knob: the agent may take
    // anything inside the top N of the eligible ranking. Set VONA_PLAN_MAX_RANK=1
    // to restore fully deterministic picking without touching code.
    const ranked = rankAvailable(liveSet, round);
    const eligible = ranked.filter((b) => availOk(b) && needOk(b.position));
    const vonaTop = eligible[0];
    const planPick = plan.map((nm) => byName.get(nm)).find((b): b is RankedPlayer => !!b && availOk(b) && needOk(b.position));
    if (vonaTop) {
      const load = byeCounts(myDrafted.map((d) => byName.get(d.name)?.team));
      const byeLoad = (b: RankedPlayer): number => {
        const wk = byeWeek(b.team);
        return wk == null ? 0 : load.get(wk) ?? 0;
      };
      const planRank = planPick ? eligible.findIndex((v) => v.name === planPick.name) + 1 : 0;
      const agentInCharge = !!planPick && planRank > 0 && planRank <= vonaConfig.planMaxRank;

      if (agentInCharge && planPick) {
        let pick: VonaPlayer = eligible[planRank - 1]!;
        // Sole veto over the agent's call: refuse to pile a fourth player onto
        // one bye week when a comparable alternative exists. Mechanical, easily
        // checked, and a model cannot be trusted to never slip on it, mock #1
        // put four players on week 10.
        if (byeLoad(pick) >= vonaConfig.byeStackMax) {
          const alt = eligible
            .filter((b) => pick.vona - b.vona <= vonaConfig.byeEps && byeLoad(b) < byeLoad(pick))
            .sort((a, b) => b.vona - a.vona)[0];
          if (alt) {
            console.log(`[draft-run] bye-stack veto: ${pick.name} (bye ${byeWeek(pick.team) ?? "?"}, load ${byeLoad(pick)}) -> ${alt.name} (bye ${byeWeek(alt.team) ?? "?"}, load ${byeLoad(alt)})`);
            logEvent("coach", "bye-veto", `Vetoed a bye stack: ${alt.name} over ${pick.name}.`, {
              from: pick.name, to: alt.name, fromBye: byeWeek(pick.team), toBye: byeWeek(alt.team),
            });
            pick = alt;
          }
        }
        if (planRank > 1) {
          // Sign these properly: the gap can be NEGATIVE when the agent's pick has
          // higher raw VOR than the VONA top, which reordering by survival makes
          // perfectly possible. A hardcoded minus printed "VOR --1.0".
          const gap = (n: number): string => `${n >= 0 ? "-" : "+"}${Math.abs(n).toFixed(1)}`;
          console.log(`[draft-run] agent call: ${pick.name} (VONA rank ${planRank} of ${eligible.length}, top was ${vonaTop.name}, VONA ${gap(vonaTop.vona - pick.vona)} VOR ${gap(vonaTop.vor - pick.vor)})`);
          logEvent("coach", "agent-override", `Agent took ${pick.name} over the value board's ${vonaTop.name}.`, {
            picked: pick.name, vonaTop: vonaTop.name, vonaRank: planRank,
            vonaGap: Math.round((vonaTop.vona - pick.vona) * 10) / 10,
            vorGap: Math.round((vonaTop.vor - pick.vor) * 10) / 10,
            reasoning: lastReasoning,
          });
        }
        target = pick;
      } else {
        // No usable plan (agent errored, backed off, or named someone outside
        // the bound). Fall back to the value board, and here bye spreading acts
        // as a tie-break since nothing intelligent is watching, but only once
        // the week is genuinely crowded. Two players sharing a bye is a bench
        // swap, so below byeSoftMin we just take the best available and move on.
        const nearTop = byeLoad(vonaTop) >= vonaConfig.byeSoftMin
          ? eligible.filter((b) => vonaTop.vona - b.vona <= vonaConfig.byeEps)
          : [vonaTop];
        target = nearTop.reduce((best, b) => {
          const d = byeLoad(b) - byeLoad(best);
          if (d < 0) return b;
          if (d === 0 && b.vona > best.vona) return b;
          return best;
        }, vonaTop);
        if (planPick && planRank > vonaConfig.planMaxRank) {
          console.log(`[draft-run] agent pick ${planPick.name} rejected: VONA rank ${planRank} > planMaxRank ${vonaConfig.planMaxRank}`);
        }
        if (target.name !== vonaTop.name) {
          console.log(`[draft-run] bye spread: ${vonaTop.name} (bye ${byeWeek(vonaTop.team) ?? "?"}) -> ${target.name} (bye ${byeWeek(target.team) ?? "?"})`);
        }
      }
    } else {
      target = planPick ?? fullBoard.find((b) => availOk(b)) ?? fullBoard[0];
    }
  }
  if (!target) { console.log("[draft-run] no target available"); await Bun.sleep(1500); continue; }

  // Plan age matters: the agent plans off the clock, so rivals can take its top
  // target before our turn (mock #4 lost Garrett Wilson 10 picks ahead of us and
  // correctly fell through to the next name on its list). Log the age so a
  // genuinely stale plan is visible rather than inferred.
  const planAgeS = ((Date.now() - lastRefresh) / 1000).toFixed(0);
  console.log(`[debug] our R${round} (global ${globalPick}) slot=${myDraftSlot} availN=${liveSet.size} planAge=${planAgeS}s target=${target.name} (${target.position})${forcedMandatory ? " [must-fill]" : ""}`);
  logBoard(globalPick, round, confirm.available, target.name);
  lastBoardAt = Date.now();
  // Announce BEFORE we click. The announcer (a separate process) speaks off this
  // event; we do NOT wait for it, so slow/failed voice never holds up the pick.
  // The agent's rationale is written for the top of ITS plan. Sitting at slot 4
  // that player is regularly gone by our turn, we take someone else, and the
  // stale rationale rides along: a slot-6 mock had three of five picks carrying a
  // rationale that argued for a DIFFERENT player. It reaches the spoken line and,
  // worse, the public blog recap, which would then explain a pick we never made.
  // Keep it only when it is actually about the player we took, and otherwise say
  // nothing, which every consumer already handles.
  const reasoningForPick =
    lastReasoning && lastReasoning.toLowerCase().includes(lastName(target.name)) ? lastReasoning : undefined;
  logEvent("coach", "pick-intent", `On the clock (R${round}): taking ${target.name} (${target.position}).`, { target: target.name, position: target.position, team: target.team, bye: byeWeek(target.team), round, adp: target.adp, reasoning: reasoningForPick });
  await Bun.sleep(ANNOUNCE_LEAD_MS); // let the announcer's voice lead the pick
  const t0 = Date.now();
  try {
    const r = await draftPickPlayer(auth, draftId, target.playerId, pickNo);
    if (r.playerId !== target.playerId) console.log(`[draft-run] pick ${pickNo} answered with ${r.name} (${r.playerId}), not ${target.name}`);
  } catch (e) {
    console.log(`[draft-run] pick error: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Confirm the pick landed by a pick appearing at OUR pick_no in the feed. The
  // mutation answers with the pick itself, but the feed is what everyone else
  // sees, so that is what we trust. Window is deliberately generous: at 16
  // tries (~13s) a DOM-era mock timed out on a pick that had in fact landed,
  // logged a miss, fired a pick-failed alert and re-clicked. ~24s still leaves
  // most of a 90s clock, and a double-pick is not possible: a landed pick
  // closes our pick_no, so the retry path exits first.
  let landed: BoardPick | undefined;
  for (let i = 0; i < 30; i++) {
    landed = (await boardPicks().catch(() => [] as BoardPick[])).find((p) => p.pickNo === pickNo);
    if (landed) break;
    await Bun.sleep(800);
  }
  if (landed) {
    // Record what the board says we took. If Sleeper autopicked for us in the
    // same instant it can differ from the target, and the roster count must
    // follow the board, not our intent.
    if (landed.playerId !== target.playerId) {
      console.log(`[draft-run] pick ${pickNo} landed as ${landed.name} (${landed.pos}), not our target ${target.name}`);
    }
    myDrafted.push({ name: landed.name, position: landed.pos || target.position });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[draft-run] our R${round} = ${landed.name} (${secs}s)`);
    logEvent("coach", "draft-pick", `Our R${round} pick: ${landed.name} (${landed.pos || target.position})`, { target: target.name, picked: landed.name, playerId: landed.playerId, pickNo, reasoning: lastReasoning, seconds: Number(secs) });
    await pushQueue().catch(() => {});
    // Also non-blocking. At the turn of a snake we pick twice in a row, so an
    // awaited refresh here ate the second clock.
    if (Date.now() > agentBackoffUntil) kickRefresh(confirm.available, await boardPicks());
  } else {
    console.log(`[draft-run] our R${round} did NOT register (target ${target.name})`);
    logEvent("coach", "pick-miss", `Our R${round} target ${target.name} didn't register.`, { target: target.name });
    if (!rehearse) await sendAlert("Draft: pick may have failed", `Round ${round} target ${target.name} didn't register. Check the draft.`);
    await Bun.sleep(1500);
  }
}

try {
  unlinkSync(DRAFT_LOCK);
} catch {
  /* already gone */
}
const finalRoster = myDrafted.map((d) => d.name);
logEvent("coach", "draft-complete", `Draft complete. Roster: ${finalRoster.join(", ")}`, { roster: finalRoster });
console.log(`[draft-run] my roster: ${finalRoster.join(", ")}`);

// Publish the public post-draft recap (best-effort; never fail the draft on it).
if (!rehearse) {
  try {
    const p = Bun.spawn(["bun", "run", "src/blog/generate.ts", "draft", String(draftId)], { cwd: "/app", env: process.env, stdout: "inherit", stderr: "inherit" });
    await p.exited;
  } catch (e) {
    console.log(`[draft-run] blog recap failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
