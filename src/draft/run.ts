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

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
const draftId = process.argv[2] ?? config.draftId;
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

const myPicks: string[] = [];
let plan: string[] = []; // ordered target names, best first
let lastRefresh = 0;

// The agent adjusts the plan reacting to the current draft, then we push it to
// the Sleeper queue as the autopick backstop.
async function refreshPlan(picks: DraftPick[]): Promise<void> {
  const board = boardNow(picks).slice(0, 22);
  const availNames = new Set(board.map((b) => b.name));
  const pickNo = picks.length + 1;
  const round = Math.floor((pickNo - 1) / draft.settings.teams) + 1;
  const have = myPicks.length ? `Your roster so far: ${myPicks.join(", ")}.` : "Your roster is empty.";
  const shortlist = board
    .map((r, i) => `${i + 1}. ${r.name} — ${r.position}${r.posRank} ${r.team}, ${r.points.toFixed(0)}pts VOR ${r.vor.toFixed(0)} ADP ${r.adp >= 999 ? "-" : r.adp.toFixed(0)} T${r.tier}${r.injuryStatus ? ` [${r.injuryStatus}]` : ""}`)
    .join("\n");
  const res = await runAgent({
    prompt:
      `You are the coach in a ${draft.settings.teams}-team ${scoringLabel} snake draft, approaching pick ${pickNo} (round ${round}). ${have}\n` +
      `Best available right now, by value under our scoring:\n${shortlist}\n\n` +
      `Give your ranked plan for your upcoming pick(s): weigh roster needs, tiers, positional scarcity and runs, and value. ` +
      `Early rounds favour the best RB/WR and genuinely elite/scarce TE; don't reach for QB/K/DEF. Anticipate runs: if a tier you need is about to empty, prioritise its last strong player. ` +
      `Reply with ONLY a semicolon-separated list of up to 8 exact names from the list above, best first. No other text.`,
  });
  const parsed = res.text
    .split(/[;\n]/)
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .filter((n) => availNames.has(n));
  plan = parsed.length ? parsed : board.map((b) => b.name);
  lastRefresh = Date.now();
  await api("/queue", { players: plan.slice(0, 15) }).catch(() => {});
  console.log(`[draft-run] plan (pick ${pickNo}): ${plan.slice(0, 5).join(", ")}${plan.length > 5 ? " …" : ""}`);
}

await refreshPlan(await sleeper.draftPicks(draftId)); // initial plan + queue

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
    await Bun.sleep(1500);
    const after = await sleeper.draftPicks(draftId);
    const mine = after.find((p) => p.pick_no === pickNo);
    if (mine) {
      const nm = `${mine.metadata?.["first_name"] ?? ""} ${mine.metadata?.["last_name"] ?? ""}`.trim();
      myPicks.push(nm);
      console.log(`[draft-run] pick ${pickNo} = ${nm} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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
console.log(`[draft-run] my roster: ${myPicks.join(", ")}`);
