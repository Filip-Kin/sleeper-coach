#!/usr/bin/env bun
// Autonomous draft orchestrator.
//
// ALL draft state comes from the live browser DOM + our own local record — never
// the Sleeper picks API, which lags badly during a live draft (that lag caused
// mistimed turns, duplicate QB/TE past the cap, and a missed pick). Specifically:
//   - turn        = our pick button is live (DOM), debounced past the kickoff flash
//   - available   = the draft room's player list (DOM), full names
//   - our roster  = tracked LOCALLY as we pick (zero lag), seeded from the board
//   - rival picks = scraped from the board cells (DOM)
//   - pick landed = our cell count on the board grew (DOM)
// The agent plans between picks; on the clock we act fast and deterministically.
//
//   bun run src/draft/run.ts [draftId] [--rehearse] [--seat=N]

import { unlinkSync } from "node:fs";
import { config, trueScoring } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { runAgent } from "../agent/runner.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor, type RankedPlayer } from "../analysis/vor.ts";
import { positionCap } from "./logic.ts";
import { logEvent, logThink } from "../log.ts";
import { sendAlert } from "../alert.ts";

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
const argv = process.argv.slice(2);
const draftId = argv.find((a) => !a.startsWith("--")) ?? config.draftId;
const rehearse = argv.includes("--rehearse");
const seat = Number(argv.find((a) => a.startsWith("--seat="))?.split("=")[1] ?? "0"); // 0-indexed CLAIM
const roomUrl = `https://sleeper.com/draft/nfl/${draftId}`;

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

const draft = await sleeper.draft(draftId);
const teams = draft.settings.teams;
const rounds = draft.settings.rounds;
console.log(`[draft-run] draft ${draftId}: ${teams}x${rounds}=${teams * rounds} picks, ${draft.settings.pick_timer}s clock`);

await Bun.write(DRAFT_LOCK, String(draftId)); // daemon: hands off the browser

async function ensureRoom(): Promise<void> {
  const u = String((await api("/eval", { expr: "location.href" })).result ?? "");
  if (!u.includes(String(draftId))) {
    await api("/goto", { url: roomUrl });
    await Bun.sleep(2500);
  }
}
await api("/goto", { url: roomUrl });
await Bun.sleep(3000);

// Rehearsal: claim a seat (position variety via --seat) before setting the queue.
if (rehearse) {
  console.log(`[draft-run] rehearse: claiming seat ${seat + 1}`);
  await api("/click", { text: "CLAIM", nth: seat }).catch(() => {});
  await Bun.sleep(2500);
}

// Value the board by THIS league's scoring (half-PPR, Filip-confirmed).
const league = await sleeper.league(config.leagueId);
const scoring = trueScoring(league.scoring_settings);
const scoringLabel = "half-PPR";
console.log(`[draft-run] scoring: ${scoringLabel} (rec ${scoring.rec})`);
const projections = await loadSeasonProjections(config.season, scoring);

// The static value board — VOR under our scoring. It does NOT depend on who's
// been drafted (availability is judged live from the DOM), so compute it once.
const fullBoard: RankedPlayer[] = rankByVor(projections, league);
const byName = new Map(fullBoard.map((b) => [b.name, b]));

// #region live state (all DOM)
interface State { onClock: boolean; available: { name: string; pos: string }[]; drafted: number }
async function draftState(): Promise<State> {
  const s = (await api("/draft-state")) as { onClock?: boolean; available?: { name: string; pos: string }[]; drafted?: number };
  return { onClock: s.onClock === true, available: s.available ?? [], drafted: s.drafted ?? 0 };
}

// Snake: which team slot drafts at (round, pick-in-round).
function slotOf(round: number, pickInRound: number): number {
  return round % 2 === 1 ? pickInRound : teams - pickInRound + 1;
}

// Every drafted pick, scraped live from the board DOM, tagged with the drafting
// slot derived from its round.pick label. Names here are abbreviated ("B.
// Robinson") — fine for rival tracking; our own roster we keep in full locally.
async function boardPicks(): Promise<{ round: number; slot: number; name: string; pos: string }[]> {
  const r = (await api("/board-picks")) as { picks?: { round: number; pickInRound: number; name: string; pos: string }[] };
  return (r.picks ?? []).map((p) => ({ round: p.round, slot: slotOf(p.round, p.pickInRound), name: p.name, pos: p.pos }));
}
// #endregion

let plan: string[] = []; // ordered target names, best first
let lastRefresh = 0;
let lastReasoning = "";
let myDraftSlot: number | null = null;
let agentBackoffUntil = 0; // pause agent calls after an error (limit hit, etc.)

// Our slot, resolved once from the (static) draft order — not the picks feed.
async function resolveSlot(): Promise<void> {
  if (myDraftSlot != null) return;
  const d = await sleeper.draft(draftId);
  const slot = d.draft_order?.[config.userId];
  if (typeof slot === "number") myDraftSlot = slot;
}

// #region our roster — tracked LOCALLY as we pick (full names, zero API lag)
const myDrafted: { name: string; position: string }[] = [];
function localCounts(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const d of myDrafted) if (d.position) c[d.position] = (c[d.position] ?? 0) + 1;
  return c;
}
// How many cells the board shows for our slot (DOM truth for "did our pick land").
async function myBoardCount(): Promise<number> {
  return (await boardPicks()).filter((p) => p.slot === myDraftSlot).length;
}
// #endregion

const QUEUE_DEPTH = 8;

// The autopick BACKSTOP queue (only used if the clock expires with automation
// dead). Built ONLY from the live-available set, kept short, balanced RB/WR, and
// never DEF/K (Sleeper autopicks down the queue, so a queued defense would
// surface early; left out, its native ADP autopick fills the tail late).
function buildQueue(counts: Record<string, number>, availSet: Set<string>): string[] {
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
  return [...out, ...te, ...qb].map((b) => b.name);
}

// Push the backstop queue. Reads a fresh live-available set itself, and is only
// ever called OFF the clock (start + right after we pick) — never mid-clock.
async function pushQueue(): Promise<void> {
  const s = await draftState();
  const q = buildQueue(localCounts(), new Set(s.available.map((a) => a.name)));
  if (q.length) await api("/queue", { players: q }).catch(() => {});
}

// #region emoji troll — react on Sleeper when a rival snipes a player we wanted
const TROLL = process.env.TROLL !== "0"; // on by default; TROLL=0 disables
const reactedPicks = new Set<string>(); // keyed by "round.slot.name"
function lastName(n: string): string {
  return (n.trim().split(/\s+/).slice(-1)[0] ?? n).toLowerCase();
}
async function maybeTroll(picks: { round: number; slot: number; name: string; pos: string }[]): Promise<void> {
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
    const ok = (await api("/react", { player: p.name, emoji }).catch(() => ({ ok: false }))) as { ok?: boolean };
    logEvent("coach", "troll", `Reacted ${emoji} to ${p.name} (${p.pos}) — one I wanted.`, { player: p.name, emoji, landed: ok.ok === true });
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
async function refreshPlan(available: { name: string; pos: string }[], recent: { round: number; slot: number; name: string; pos: string }[]): Promise<void> {
  await resolveSlot();
  const roster = myDrafted.map((d) => `${d.name} (${d.position})`);
  const availSet = new Set(available.map((a) => a.name));
  const board = fullBoard.filter((b) => availSet.size === 0 || availSet.has(b.name)).slice(0, 22);
  const availNames = new Set(board.map((b) => b.name));
  const round = myDrafted.length + 1;
  const have = roster.length ? `Your roster so far: ${roster.join(", ")}.` : "Your roster is empty.";
  const shortlist = board
    .map((r, i) => `${i + 1}. ${r.name} — ${r.position}${r.posRank} ${r.team}, ${r.points.toFixed(0)}pts VOR ${r.vor.toFixed(0)} ADP ${r.adp >= 999 ? "-" : r.adp.toFixed(0)} T${r.tier}${r.injuryStatus ? ` [${r.injuryStatus}]` : ""}`)
    .join("\n");
  const recentStr = recent
    .slice(-10)
    .map((p) => `R${p.round} team ${p.slot}${p.slot === myDraftSlot ? " [YOU]" : ""}: ${p.name} (${p.pos})`)
    .join("\n") || "(no picks yet)";
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
      `Best available right now, by value under our scoring:\n${shortlist}\n\n` +
      `Build the strongest STARTING lineup. Prioritise RB and WR heavily early (you start 2 RB, 2 WR, and 2 FLEX). ` +
      `Because RB is scarcer and fills your FLEX, build real RB depth — aim for about five RBs by the end — and don't ` +
      `stack more than about five WRs unless a WR is clearly the best value. You need only ONE tight end: do NOT reach ` +
      `for a TE, and never plan a second TE until the very last rounds; a TE is worth an early pick only if it is clearly ` +
      `the best value AND you have none. Take exactly ONE QB in this 1-QB league and only from the mid rounds; do NOT ` +
      `draft a backup QB (leave that to the very last round, if at all). Draft K and DEF only in the final 2-3 rounds. ` +
      `Anticipate RB/WR runs and respect tiers over raw rank. ` +
      `First write two or three sentences of reasoning about the board, runs, and roster needs. Then on a new line write "PICKS:" followed by up to 8 exact names from the list above, semicolon-separated, best first.`,
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

// Initial plan + backstop queue (read the live board once).
{
  const s0 = await draftState();
  await refreshPlan(s0.available, await boardPicks());
  await pushQueue();
}

// Rehearsal: start the draft ourselves once the queue is set.
if (rehearse) {
  console.log("[draft-run] rehearse: starting draft");
  await api("/click", { selector: ".start-draft-button" }).catch(() => {});
  await Bun.sleep(4000);
}

// Resolve our slot before picking anything (draft_order populates on start).
for (let i = 0; i < 40 && myDraftSlot == null; i++) {
  await resolveSlot();
  if (myDraftSlot == null) await Bun.sleep(1500);
}
console.log(`[draft-run] our draft slot: ${myDraftSlot ?? "unresolved"}`);

// Seed our local roster from any picks already on the board at our slot (e.g.
// keepers), so round counting starts from reality.
for (const p of (await boardPicks()).filter((p) => p.slot === myDraftSlot)) {
  myDrafted.push({ name: p.name, position: p.pos });
}
console.log(`[draft-run] entering pick loop (seeded ${myDrafted.length} of our picks)…`);

let lastBoardAt = 0;
for (;;) {
  await ensureRoom();
  await resolveSlot();
  if (myDraftSlot == null) { await Bun.sleep(1500); continue; }
  if (myDrafted.length >= rounds) {
    console.log(`[draft-run] all ${rounds} of our picks made`);
    break;
  }
  const round = myDrafted.length + 1;
  const counts = localCounts();
  const { onClock, available, drafted } = await draftState();
  const globalPick = drafted + 1;

  if (Date.now() - lastBoardAt > 5000) { logBoard(globalPick, round, available); lastBoardAt = Date.now(); }

  if (!onClock) {
    const picks = await boardPicks();
    await maybeTroll(picks).catch(() => {});
    if (Date.now() > agentBackoffUntil && Date.now() - lastRefresh > 20_000) await refreshPlan(available, picks);
    await Bun.sleep(1500);
    continue;
  }

  // Our button is live — debounce to reject the kickoff flash / a turn passing
  // in the same instant. Only a stable on-clock is genuinely our turn.
  await Bun.sleep(700);
  const confirm = await draftState();
  if (!confirm.onClock) continue;

  let liveSet = new Set(confirm.available.map((a) => a.name));
  if (liveSet.size === 0) { liveSet = new Set((await draftState()).available.map((a) => a.name)); }

  const availOk = (b: RankedPlayer): boolean => liveSet.size === 0 || liveSet.has(b.name);
  const needOk = (pos: string): boolean => (counts[pos] ?? 0) < positionCap(pos, round);

  // Must-fill the mandatory starters (DEF, K): value never prioritises them, so
  // reserve the final picks. They're usually outside the visible window, so pick
  // the best by value and let makePick search for it (no availOk gate).
  const mandatoryMissing = ["DEF", "K"].filter((p) => (counts[p] ?? 0) === 0);
  const remaining = rounds - myDrafted.length; // picks left, including this one
  let target: RankedPlayer | undefined;
  let forcedMandatory = false;
  if (mandatoryMissing.length && remaining <= mandatoryMissing.length) {
    const pos = mandatoryMissing[0]!;
    target = fullBoard.find((b) => b.position === pos);
    forcedMandatory = !!target;
  }
  if (!target) {
    target =
      plan.map((nm) => byName.get(nm)).find((b): b is RankedPlayer => !!b && availOk(b) && needOk(b.position)) ??
      fullBoard.find((b) => availOk(b) && needOk(b.position)) ??
      fullBoard.find((b) => availOk(b)) ??
      fullBoard[0];
  }
  if (!target) { console.log("[draft-run] no target available"); await Bun.sleep(1500); continue; }

  console.log(`[debug] our R${round} (global ${globalPick}) slot=${myDraftSlot} availN=${liveSet.size} target=${target.name} (${target.position})${forcedMandatory ? " [must-fill]" : ""}`);
  logBoard(globalPick, round, confirm.available, target.name);
  lastBoardAt = Date.now();
  // Announce BEFORE we click. The announcer (a separate process) speaks off this
  // event; we do NOT wait for it, so slow/failed voice never holds up the pick.
  logEvent("coach", "pick-intent", `On the clock (R${round}): taking ${target.name} (${target.position}).`, { target: target.name, position: target.position, round, reasoning: lastReasoning });
  const t0 = Date.now();
  try {
    await api("/pick", { player: target.name });
  } catch (e) {
    console.log(`[draft-run] pick error: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Confirm the pick landed by OUR cell count on the board growing (DOM truth;
  // works for both visible picks and out-of-window DEF/K, and for back-to-back).
  let landed = false;
  for (let i = 0; i < 16; i++) {
    if ((await myBoardCount()) > myDrafted.length) { landed = true; break; }
    await Bun.sleep(800);
  }
  if (landed) {
    myDrafted.push({ name: target.name, position: target.position });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[draft-run] our R${round} = ${target.name} (${secs}s)`);
    logEvent("coach", "draft-pick", `Our R${round} pick: ${target.name} (${target.position})`, { target: target.name, reasoning: lastReasoning, seconds: Number(secs) });
    await pushQueue().catch(() => {});
    if (Date.now() > agentBackoffUntil) await refreshPlan(confirm.available, await boardPicks()).catch(() => {});
  } else {
    console.log(`[draft-run] our R${round} did NOT register (target ${target.name})`);
    logEvent("coach", "pick-miss", `Our R${round} target ${target.name} didn't register.`, { target: target.name });
    if (!rehearse) await sendAlert("Draft: pick may have failed", `Round ${round} target ${target.name} didn't register — check the draft.`);
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
