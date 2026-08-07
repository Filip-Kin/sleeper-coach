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
import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { runAgent } from "../agent/runner.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor, type RankedPlayer } from "../analysis/vor.ts";
import type { DraftPick } from "../sleeper/types.ts";
import { logEvent } from "../log.ts";

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
const scoringType = draft.metadata?.scoring_type ?? "ppr";
const scoring = { ...league.scoring_settings };
if (scoringType === "half_ppr") scoring.rec = 0.5;
else if (scoringType === "std") scoring.rec = 0;
const scoringLabel = scoringType === "half_ppr" ? "half-PPR" : scoringType === "std" ? "standard" : "full-PPR";
console.log(`[draft-run] scoring: ${scoringLabel} (rec ${scoring.rec})`);
const projections = await loadSeasonProjections(config.season, scoring);

function boardNow(picks: DraftPick[]): RankedPlayer[] {
  const drafted = new Set(picks.map((p) => p.player_id));
  return rankByVor(projections, league).filter((r) => !drafted.has(r.playerId));
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
  const res = await runAgent({
    prompt:
      `You are the coach in a ${draft.settings.teams}-team ${scoringLabel} snake draft, approaching pick ${pickNo} (round ${round}). ${have}\n` +
      `Best available right now, by value under our scoring:\n${shortlist}\n\n` +
      `Give your ranked plan for your upcoming pick(s): weigh roster needs, tiers, positional scarcity and runs, and value. ` +
      `Early rounds favour the best RB/WR and genuinely elite/scarce TE; don't reach for QB/K/DEF. Anticipate runs. ` +
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
  await api("/queue", { players: plan.slice(0, 15) }).catch(() => {});
  logEvent("coach", "plan", `Plan @pick ${pickNo} (R${round}): ${plan.slice(0, 4).join(", ")}`, { reasoning: lastReasoning, plan, roster });
}

await refreshPlan(await sleeper.draftPicks(draftId)); // initial plan + queue (backstop ready)

// Rehearsal: start the draft ourselves once the queue is set.
if (rehearse) {
  console.log("[draft-run] rehearse: starting draft");
  await api("/click", { selector: ".start-draft-button" }).catch(() => {});
  await Bun.sleep(4000);
}

console.log("[draft-run] entering pick loop (waiting for our turns)…");
for (;;) {
  await ensureRoom();
  const picks = await sleeper.draftPicks(draftId);
  const n = picks.length;
  if (n >= total) {
    console.log(`[draft-run] draft complete (${n} picks)`);
    break;
  }
  const availNames = new Set(boardNow(picks).map((b) => b.name));
  const onClock = (await api("/on-clock")).onClock === true;

  if (onClock) {
    const pickNo = n + 1;
    if (!plan.some((nm) => availNames.has(nm))) await refreshPlan(picks);
    const target = plan.find((nm) => availNames.has(nm)) ?? boardNow(picks)[0]?.name;
    if (!target) {
      console.log("[draft-run] no target available?!");
      break;
    }
    console.log(`[draft-run] ON THE CLOCK pick ${pickNo} → drafting ${target}`);
    const t0 = Date.now();
    try {
      await api("/pick", { player: target });
    } catch (e) {
      console.log(`[draft-run] pick error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Poll a few seconds for the pick to register (API lags the click a moment).
    let after = await sleeper.draftPicks(draftId);
    for (let i = 0; i < 5 && !after.find((p) => p.pick_no === pickNo); i++) {
      await Bun.sleep(1200);
      after = await sleeper.draftPicks(draftId);
    }
    const mine = after.find((p) => p.pick_no === pickNo);
    const round = Math.floor((pickNo - 1) / draft.settings.teams) + 1;
    if (mine) {
      const nm = `${mine.metadata?.["first_name"] ?? ""} ${mine.metadata?.["last_name"] ?? ""}`.trim();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[draft-run] pick ${pickNo} = ${nm} (${secs}s)`);
      logEvent("coach", "draft-pick", `R${round} pick ${pickNo}: ${nm}`, { target, reasoning: lastReasoning, seconds: Number(secs) });
    } else {
      console.log(`[draft-run] pick ${pickNo} not registered (target ${target})`);
    }
    await refreshPlan(after); // adjust for the next turn, reacting to what just happened
  } else {
    // Between picks: adjust the plan periodically as others draft (throttled so
    // a mock's instant CPU picks don't trigger a refresh storm).
    if (Date.now() - lastRefresh > 30_000) await refreshPlan(picks);
    await Bun.sleep(2500);
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
