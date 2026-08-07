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
import { slotOnClock, positionCap } from "./logic.ts";
import type { DraftPick } from "../sleeper/types.ts";
import { logEvent } from "../log.ts";
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

// The autopick BACKSTOP queue. Deep and RB/WR-first so that if the clock ever
// expires and Sleeper autopicks, it can never surface an early TE/QB (they sit
// far down the queue, behind ~22 RB/WR). One TE/QB only if we don't have one.
function buildQueue(board: RankedPlayer[], counts: Record<string, number>): string[] {
  const rbwr = board.filter((b) => b.position === "RB" || b.position === "WR").slice(0, 22);
  const te = (counts["TE"] ?? 0) >= 1 ? [] : board.filter((b) => b.position === "TE").slice(0, 1);
  const qb = (counts["QB"] ?? 0) >= 1 ? [] : board.filter((b) => b.position === "QB").slice(0, 1);
  const kdef = board.filter((b) => b.position === "K" || b.position === "DEF").slice(0, 2);
  return [...rbwr, ...te, ...qb, ...kdef].map((b) => b.name).slice(0, 28);
}

// The agent adjusts the plan reacting to the current draft; we push it to the
// Sleeper queue as the autopick backstop and log its reasoning.
async function refreshPlan(picks: DraftPick[]): Promise<void> {
  await resolveSlot();
  const roster = myRoster(picks);
  const board = boardNow(picks).slice(0, 22);
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
    prompt:
      `You are the coach in a ${draft.settings.teams}-team ${scoringLabel} snake draft, approaching pick ${pickNo} (round ${round}). ${have}\n` +
      `Recent picks (react to runs and what rivals are stacking):\n${recent}\n\n` +
      `Best available right now, by value under our scoring:\n${shortlist}\n\n` +
      `Build the strongest STARTING lineup. Prioritise RB and WR heavily early (you start 2 RB, 2 WR, and 2 FLEX). ` +
      `You need only ONE tight end: do NOT reach for a TE, and never plan a second TE until the very last rounds; ` +
      `a TE is worth an early pick only if it is clearly the best value AND you have none. Take at most one QB and not ` +
      `before mid-draft. Draft K and DEF only in the final 2-3 rounds. Anticipate RB/WR runs and respect tiers over raw rank. ` +
      `First write ONE short sentence of reasoning. Then on a new line write "PICKS:" followed by up to 8 exact names from the list above, semicolon-separated, best first.`,
  });
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
  // Backstop queue is the disciplined deep list (RB/WR-first), NOT the agent's
  // plan — so a missed clock can never autopick an early TE.
  const queue = buildQueue(boardNow(picks), myPositionCounts(picks, myDraftSlot));
  await api("/queue", { players: queue }).catch(() => {});
  logEvent("coach", "plan", `Plan @pick ${pickNo} (R${round}): ${plan.slice(0, 4).join(", ")}`, { reasoning: lastReasoning, plan, roster });
}

await refreshPlan(await sleeper.draftPicks(draftId)); // initial plan + queue (backstop ready)

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
const teams = draft.settings.teams;
for (;;) {
  await ensureRoom();
  await resolveSlot();
  const picks = await sleeper.draftPicks(draftId);
  const n = picks.length;
  if (n >= total) {
    console.log(`[draft-run] draft complete (${n} picks)`);
    break;
  }
  const pickNo = n + 1;
  const round = Math.floor((pickNo - 1) / teams) + 1;
  // Our turn requires BOTH signals to agree: the live enabled draft button
  // (real-time; the button is briefly enabled for everyone at kickoff, so the
  // DOM alone false-fires at pick 1) AND the snake math saying our slot is up
  // (guards the kickoff false-positive and any DOM oddity). Together they are
  // robust to the picks-API lag and the start-of-draft flash.
  // Single live-truth read: on the clock + who is ACTUALLY still available.
  const state = (await api("/draft-state")) as { onClock?: boolean; available?: { name: string; pos: string }[] };
  const onClock = state.onClock === true;
  const availSet = new Set((state.available ?? []).map((a) => a.name));
  const myTurn = onClock && myDraftSlot != null && slotOnClock(pickNo, teams) === myDraftSlot;
  if (!myTurn) {
    // Between picks: adjust the plan (agent) + refresh the queue backstop,
    // throttled so a mock's instant CPU picks don't storm the agent.
    if (Date.now() - lastRefresh > 20_000) await refreshPlan(picks);
    await Bun.sleep(1500);
    continue;
  }

  // ON THE CLOCK — pick FAST from the LIVE available set only (never a player
  // who's already gone), best per our board + roster caps. If the live read is
  // empty for any reason, fall back to the board so we still pick.
  const board = boardNow(picks);
  const byName = new Map(board.map((b) => [b.name, b]));
  const counts = myPositionCounts(picks, myDraftSlot);
  const availOk = (b: RankedPlayer): boolean => availSet.size === 0 || availSet.has(b.name);
  const needOk = (pos: string): boolean => (counts[pos] ?? 0) < positionCap(pos, round);
  const target =
    plan.map((nm) => byName.get(nm)).find((b): b is RankedPlayer => !!b && availOk(b) && needOk(b.position)) ??
    board.find((b) => availOk(b) && needOk(b.position)) ??
    board.find((b) => availOk(b)) ??
    board[0];
  if (!target) {
    console.log("[draft-run] no target available");
    break;
  }
  console.log(`[draft-run] ON THE CLOCK pick ${pickNo} (R${round}) → ${target.name} (${target.position})`);
  const t0 = Date.now();
  try {
    await api("/pick", { player: target.name });
  } catch (e) {
    console.log(`[draft-run] pick error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let after = await sleeper.draftPicks(draftId);
  for (let i = 0; i < 6 && !after.find((p) => p.pick_no === pickNo); i++) {
    await Bun.sleep(1200);
    after = await sleeper.draftPicks(draftId);
  }
  const mine = after.find((p) => p.pick_no === pickNo && p.draft_slot === myDraftSlot);
  if (mine) {
    const nm = `${mine.metadata?.["first_name"] ?? ""} ${mine.metadata?.["last_name"] ?? ""}`.trim();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[draft-run] pick ${pickNo} = ${nm} (${secs}s)`);
    logEvent("coach", "draft-pick", `R${round} pick ${pickNo}: ${nm} (${target.position})`, { target: target.name, reasoning: lastReasoning, seconds: Number(secs) });
  } else {
    // Pick didn't land — during a live draft this needs a human. Alert once.
    console.log(`[draft-run] pick ${pickNo} did NOT register (target ${target.name})`);
    if (!rehearse) await sendAlert("Draft: pick may have failed", `Pick ${pickNo} target ${target.name} didn't register — check the draft.`);
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
