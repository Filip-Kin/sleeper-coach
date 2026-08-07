#!/usr/bin/env bun
// Autonomous draft orchestrator.
//
// Model (per league strategy): the agent is the decision-maker and the queue is
// its plan. BETWEEN picks (off the clock, where there's time) the agent produces
// a ranked plan reacting to what everyone else is doing; the orchestrator pushes
// it to the Sleeper queue as the autopick backstop. ON the clock the orchestrator
// acts FAST and deterministically: it drafts the top still-available name from
// the plan. No slow deliberation while the clock ticks.
//
//   bun run src/draft/run.ts [draftId]

import { unlinkSync } from "node:fs";
import { config, trueScoring } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { runAgent } from "../agent/runner.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor, type RankedPlayer } from "../analysis/vor.ts";
import { positionCap } from "./logic.ts";
import type { DraftPick } from "../sleeper/types.ts";
import { logEvent, logThink } from "../log.ts";
import { sendAlert } from "../alert.ts";

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
// args: <draftId> [--rehearse] [--seat=N]. --rehearse claims a seat and starts
// the draft itself (for mock practice); without it, the script just joins the
// (real) draft, queues, and picks when the commissioner starts it. This is one
// fire-and-forget script that runs the whole draft — the production pattern.
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
const total = draft.settings.teams * draft.settings.rounds;
console.log(`[draft-run] draft ${draftId}: ${draft.settings.teams}x${draft.settings.rounds}=${total} picks, ${draft.settings.pick_timer}s clock`);

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

// Value the board by THIS draft's scoring (ppr | half_ppr | std).
const league = await sleeper.league(config.leagueId);
// The league is half-PPR (Filip-confirmed; see config.trueScoring).
const scoring = trueScoring(league.scoring_settings);
const scoringLabel = "half-PPR";
console.log(`[draft-run] scoring: ${scoringLabel} (rec ${scoring.rec})`);
const projections = await loadSeasonProjections(config.season, scoring);

function boardNow(picks: DraftPick[]): RankedPlayer[] {
  const drafted = new Set(picks.map((p) => p.player_id));
  return rankByVor(projections, league).filter((r) => !drafted.has(r.playerId));
}

// How many of each position we've already drafted (our slot only).
function myPositionCounts(picks: DraftPick[], slot: number | null): Record<string, number> {
  const c: Record<string, number> = {};
  if (slot == null) return c;
  for (const p of picks) {
    if (p.draft_slot !== slot) continue;
    const pos = p.metadata?.position;
    if (pos) c[pos] = (c[pos] ?? 0) + 1;
  }
  return c;
}

let plan: string[] = []; // ordered target names, best first
let lastRefresh = 0;
let lastReasoning = "";
let myDraftSlot: number | null = null;
let agentBackoffUntil = 0; // pause agent calls after an error (limit hit, etc.)

// Our own picks, read from the draft slot (robust vs. tracking makePick calls,
// since some picks may come via the autopick queue).
async function resolveSlot(): Promise<void> {
  if (myDraftSlot != null) return;
  const d = await sleeper.draft(draftId);
  const slot = d.draft_order?.[config.userId];
  if (typeof slot === "number") myDraftSlot = slot;
}
function myRoster(picks: DraftPick[]): string[] {
  if (myDraftSlot == null) return [];
  return picks
    .filter((p) => p.draft_slot === myDraftSlot)
    .sort((a, b) => a.pick_no - b.pick_no)
    .map((p) => `${p.metadata?.["first_name"] ?? ""} ${p.metadata?.["last_name"] ?? ""}`.trim());
}

const QUEUE_DEPTH = 8;

// The autopick BACKSTOP queue (only used if the clock ever expires with the
// automation dead). Rules learned from live mocks:
//  1) Build it ONLY from the LIVE available set (the DOM truth), never the
//     lagging picks API — so it can never contain a player already drafted, the
//     bug that had it re-searching gone players and grinding for ~45s.
//  2) Keep it SHORT (QUEUE_DEPTH). Setting the queue is per-player DOM work; a
//     long queue starves the on-the-clock pick. It is only a dead-man's switch.
//  3) Balance RB/WR by alternating on whichever we're shorter on, so a value-
//     heavy RB board can't pile up. Ties break toward RB (slight half-PPR lean).
//  4) NEVER queue DEF/K. Sleeper autopicks strictly down the queue, so a queued
//     defense surfaces the instant the skill names drain. Left out, Sleeper's
//     own ADP autopick fills the tail late where K/DEF belong.
function buildQueue(board: RankedPlayer[], counts: Record<string, number>, availSet: Set<string>): string[] {
  const live = availSet.size ? board.filter((b) => availSet.has(b.name)) : board;
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

// Push the backstop queue. Reads a FRESH live-available set itself, so it's
// always valid, and is only ever called OFF the clock (at start and right after
// we pick) — never while our clock is ticking.
async function pushQueue(picks: DraftPick[]): Promise<void> {
  const s = (await api("/draft-state")) as { available?: { name: string; pos: string }[] };
  const availSet = new Set((s.available ?? []).map((a) => a.name));
  const q = buildQueue(boardNow(picks), myPositionCounts(picks, myDraftSlot), availSet);
  if (q.length) await api("/queue", { players: q }).catch(() => {});
}

// Observability: publish what the coach currently sees as available (the live
// DOM read) plus the pick it's leaning toward, so the dashboard's Coach view
// shows exactly the board state the engine is deciding from.
function logBoard(pickNo: number, round: number, available: { name: string; pos: string }[], target?: string): void {
  logEvent(
    "coach",
    "board",
    `Board @pick ${pickNo} (R${round}): ${available.length} available${target ? `, leaning ${target}` : ""}`,
    { pickNo, round, available: available.slice(0, 20), target, reasoning: lastReasoning },
  );
}

// The agent adjusts the PLAN (a ranked shortlist) reacting to the live draft.
// It never touches the queue and never blocks a pick — picking is deterministic
// off this plan + the value board. `available` is the live DOM read, so the
// shortlist only ever contains players actually still in the room. On any agent
// error (usage limit, crash) we log it, fall back to the pure value board, and
// back off so we don't hammer a failing agent.
async function refreshPlan(picks: DraftPick[], available: { name: string; pos: string }[]): Promise<void> {
  await resolveSlot();
  const roster = myRoster(picks);
  const availSet = new Set(available.map((a) => a.name));
  const board = boardNow(picks).filter((b) => availSet.size === 0 || availSet.has(b.name)).slice(0, 22);
  const availNames = new Set(board.map((b) => b.name));
  const pickNo = picks.length + 1;
  const round = Math.floor((pickNo - 1) / draft.settings.teams) + 1;
  const have = roster.length ? `Your roster so far: ${roster.join(", ")}.` : "Your roster is empty.";
  const shortlist = board
    .map((r, i) => `${i + 1}. ${r.name} — ${r.position}${r.posRank} ${r.team}, ${r.points.toFixed(0)}pts VOR ${r.vor.toFixed(0)} ADP ${r.adp >= 999 ? "-" : r.adp.toFixed(0)} T${r.tier}${r.injuryStatus ? ` [${r.injuryStatus}]` : ""}`)
    .join("\n");
  // The live draft flow: what's been picked and by whom, so the coach reacts to
  // runs and to what rivals are building.
  const recent = picks
    .slice(-10)
    .map((p) => `${p.pick_no}. ${p.metadata?.["first_name"] ?? ""} ${p.metadata?.["last_name"] ?? ""} (${p.metadata?.["position"] ?? "?"}) → team ${p.draft_slot}${p.draft_slot === myDraftSlot ? " [YOU]" : ""}`)
    .join("\n") || "(no picks yet)";
  const res = await runAgent({
    partial: false, // whole assistant messages → clean full reasoning in the console
    onEvent: (ev) => {
      // Stream the model's full output to the live console as it arrives.
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
      `You are the coach in a ${draft.settings.teams}-team ${scoringLabel} snake draft, approaching pick ${pickNo} (round ${round}). ${have}\n` +
      `Recent picks (react to runs and what rivals are stacking):\n${recent}\n\n` +
      `Best available right now, by value under our scoring:\n${shortlist}\n\n` +
      `Build the strongest STARTING lineup. Prioritise RB and WR heavily early (you start 2 RB, 2 WR, and 2 FLEX). ` +
      `Because RB is scarcer and fills your FLEX, build real RB depth — aim for about five RBs by the end — and don't ` +
      `stack more than about five WRs unless a WR is clearly the best value. You need only ONE tight end: do NOT reach ` +
      `for a TE, and never plan a second TE until the very last rounds; a TE is worth an early pick only if it is clearly ` +
      `the best value AND you have none. Take exactly ONE QB in this 1-QB league and only from the mid rounds; do NOT ` +
      `draft a backup QB (leave that to the very last round, if at all). Draft K and DEF only in the final 2-3 rounds. ` +
      `Anticipate RB/WR runs and respect tiers over raw rank. ` +
      `First write two or three sentences of reasoning explaining your thinking about the board, runs, and roster needs. Then on a new line write "PICKS:" followed by up to 8 exact names from the list above, semicolon-separated, best first.`,
  });
  if (res.error || !res.text.trim()) {
    // Agent unavailable — keep drafting deterministically off the value board.
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
  logEvent("coach", "plan", `Plan @pick ${pickNo} (R${round}): ${plan.slice(0, 4).join(", ")}`, { reasoning: lastReasoning, plan, roster });
}

// Initial plan + backstop queue (read the live board once so both are built
// from what's actually in the room).
{
  const picks0 = await sleeper.draftPicks(draftId);
  const s0 = (await api("/draft-state")) as { available?: { name: string; pos: string }[] };
  await refreshPlan(picks0, s0.available ?? []);
  await pushQueue(picks0);
}

// Rehearsal: start the draft ourselves once the queue is set.
if (rehearse) {
  console.log("[draft-run] rehearse: starting draft");
  await api("/click", { selector: ".start-draft-button" }).catch(() => {});
  await Bun.sleep(4000);
}

// Resolve our draft slot before picking anything — draft_order populates when
// the draft starts and may lag a moment. Never pick until we know our slot.
for (let i = 0; i < 40 && myDraftSlot == null; i++) {
  await resolveSlot();
  if (myDraftSlot == null) await Bun.sleep(1500);
}
console.log(`[draft-run] our draft slot: ${myDraftSlot ?? "unresolved"}`);
console.log("[draft-run] entering pick loop (waiting for our turns)…");
const rounds = draft.settings.rounds;

// Deterministic state comes from the LIVE browser, never the lagging picks API:
//  - Our turn = our pick button is live (onClock), debounced across two reads to
//    dodge the brief all-buttons flash at kickoff.
//  - Our round = a LOCAL count of picks we've made (seeded from our current
//    roster), incremented only when a pick is confirmed. No global pick number,
//    so API lag can never mistime a turn.
//  - A pick is confirmed when our button goes back to disabled (the turn was
//    consumed) — true whether we clicked it or the clock autopicked from queue.
let myPicksMade = myRoster(await sleeper.draftPicks(draftId)).length;
let lastBoardAt = 0;

async function draftState(): Promise<{ onClock: boolean; available: { name: string; pos: string }[] }> {
  const s = (await api("/draft-state")) as { onClock?: boolean; available?: { name: string; pos: string }[] };
  return { onClock: s.onClock === true, available: s.available ?? [] };
}

for (;;) {
  if (myPicksMade >= rounds) {
    console.log(`[draft-run] all ${rounds} of our picks made`);
    break;
  }
  await ensureRoom();
  await resolveSlot();
  const round = myPicksMade + 1;
  const { onClock, available } = await draftState();

  // Observability: publish the live board view (what the engine sees available)
  // on a light time throttle, so the dashboard Coach view updates steadily.
  if (Date.now() - lastBoardAt > 5000) { logBoard(round, round, available); lastBoardAt = Date.now(); }

  if (!onClock) {
    // Off the clock: adjust the PLAN only (throttled, paused during agent
    // backoff). The queue is a backstop, refreshed only right after we pick.
    if (Date.now() > agentBackoffUntil && Date.now() - lastRefresh > 20_000) {
      await refreshPlan(await sleeper.draftPicks(draftId), available);
    }
    await Bun.sleep(1500);
    continue;
  }

  // Our button is live — debounce to reject the kickoff flash / a turn that
  // passes in the same instant. Only a stable on-clock is genuinely our turn.
  await Bun.sleep(700);
  const confirm = await draftState();
  if (!confirm.onClock) continue;

  // ON THE CLOCK — pick from the LIVE available set (the DOM truth), best per
  // our board + roster caps. Re-read once if the read came back empty.
  let liveSet = new Set(confirm.available.map((a) => a.name));
  if (liveSet.size === 0) {
    const retry = await draftState();
    liveSet = new Set(retry.available.map((a) => a.name));
  }
  const picks = await sleeper.draftPicks(draftId);
  const board = boardNow(picks);
  const byName = new Map(board.map((b) => [b.name, b]));
  const counts = myPositionCounts(picks, myDraftSlot);
  const availOk = (b: RankedPlayer): boolean => liveSet.size === 0 || liveSet.has(b.name);
  const needOk = (pos: string): boolean => (counts[pos] ?? 0) < positionCap(pos, round);
  const target =
    plan.map((nm) => byName.get(nm)).find((b): b is RankedPlayer => !!b && availOk(b) && needOk(b.position)) ??
    board.find((b) => availOk(b) && needOk(b.position)) ??
    board.find((b) => availOk(b)) ??
    board[0];
  if (!target) {
    console.log("[draft-run] no target available");
    await Bun.sleep(1500);
    continue;
  }
  console.log(`[debug] our pick #${round} slot=${myDraftSlot} availN=${liveSet.size} target=${target.name} (${target.position}) inAvail=${liveSet.has(target.name)}`);
  console.log(`[debug] avail(live): ${[...liveSet].slice(0, 8).join(", ") || "(empty)"}`);
  console.log(`[debug] plan top: ${plan.slice(0, 5).join(", ") || "(none)"}`);
  logBoard(round, round, confirm.available, target.name); // publish with the chosen target
  lastBoardAt = Date.now();
  const t0 = Date.now();
  try {
    await api("/pick", { player: target.name });
  } catch (e) {
    console.log(`[draft-run] pick error: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Confirm by our button clearing (turn consumed), not by the API. Wait up to
  // ~10s for it to disable; if it never does, the pick didn't take.
  let consumed = false;
  for (let i = 0; i < 12; i++) {
    if (!(await draftState()).onClock) { consumed = true; break; }
    await Bun.sleep(800);
  }
  if (consumed) {
    myPicksMade++;
    const after = await sleeper.draftPicks(draftId);
    // Log what we actually clicked (target). The API roster lags, so reading the
    // "last" pick back would show the PREVIOUS pick — misleading. Only override
    // if the clock autopicked something other than our target from the queue.
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[draft-run] our pick #${round} = ${target.name} (${secs}s)`);
    logEvent("coach", "draft-pick", `Our pick #${round} (R${round}): ${target.name} (${target.position})`, { target: target.name, reasoning: lastReasoning, seconds: Number(secs) });
    // Safe window: next turn is a full snake cycle away. Refresh the small
    // backstop queue and adjust the plan now, off the clock.
    await pushQueue(after).catch(() => {});
    if (Date.now() > agentBackoffUntil) await refreshPlan(after, confirm.available).catch(() => {});
  } else {
    console.log(`[draft-run] our pick #${round} did NOT register (target ${target.name})`);
    logEvent("coach", "pick-miss", `Our pick #${round} target ${target.name} didn't register.`, { target: target.name });
    if (!rehearse) await sendAlert("Draft: pick may have failed", `Our pick #${round} target ${target.name} didn't register — check the draft.`);
    await Bun.sleep(1500);
  }
}

try {
  unlinkSync(DRAFT_LOCK);
} catch {
  /* already gone */
}
const finalRoster = myRoster(await sleeper.draftPicks(draftId));
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
