#!/usr/bin/env bun
// Autonomous draft orchestrator. Watches the draft room; whenever the coach is
// on the clock it invokes the agent (Claude) to read the best-available board
// and make the pick. Works for the real draft (default) or a mock (pass its
// draft id). This is the draft-night engine and the rehearsal harness.
//
//   bun run src/draft/run.ts [draftId]

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { runAgent } from "../agent/runner.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor } from "../analysis/vor.ts";

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const draftId = process.argv[2] ?? config.draftId;

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

await api("/goto", { url: `https://sleeper.com/draft/nfl/${draftId}` });
await Bun.sleep(3000);

// Safety net FIRST: queue the current best-available board so any missed clock
// autopicks OUR board, not Sleeper's raw ADP. Refreshed every few rounds below.
const league = await sleeper.league(config.leagueId);
const projections = await loadSeasonProjections(config.season, league.scoring_settings);
async function syncQueue(): Promise<void> {
  const drafted = new Set((await sleeper.draftPicks(draftId)).map((p) => p.player_id));
  const names = rankByVor(projections, league).filter((r) => !drafted.has(r.playerId)).slice(0, 20).map((r) => r.name);
  await api("/queue", { players: names });
  console.log(`[draft-run] queued ${names.length} as autopick safety net`);
}
await syncQueue();

const myPicks: string[] = [];

for (;;) {
  const picks = await sleeper.draftPicks(draftId);
  if (picks.length >= total) {
    console.log(`[draft-run] draft complete (${picks.length} picks)`);
    break;
  }
  const onClock = (await api("/on-clock")).onClock === true;
  if (!onClock) {
    await Bun.sleep(2500);
    continue;
  }

  const pickNo = picks.length + 1;
  const round = Math.floor((pickNo - 1) / draft.settings.teams) + 1;
  const have = myPicks.length ? `Your roster so far: ${myPicks.join(", ")}. ` : "You have no players yet. ";
  console.log(`[draft-run] ON THE CLOCK — pick ${pickNo} (round ${round})`);

  // Compute the best-available shortlist in-process and hand it to the agent
  // inline, so it doesn't shell out and reparse the whole projection set.
  const drafted = new Set(picks.map((p) => p.player_id));
  const avail = rankByVor(projections, league).filter((r) => !drafted.has(r.playerId)).slice(0, 18);
  const shortlist = avail
    .map((r, i) => `${i + 1}. ${r.name} — ${r.position}${r.posRank} ${r.team}, ${r.points.toFixed(0)}pts VOR ${r.vor.toFixed(0)} ADP ${r.adp >= 999 ? "-" : r.adp.toFixed(0)} tier ${r.tier}${r.injuryStatus ? ` [${r.injuryStatus}]` : ""}`)
    .join("\n");

  const t0 = Date.now();
  const res = await runAgent({
    prompt:
      `You are the coach, on the clock at pick ${pickNo} (round ${round}) of an 8-team full-PPR snake draft. ` +
      `Starters: QB, 2 RB, 2 WR, TE, 2 FLEX, K, DEF, plus 6 bench. ${have}` +
      `Best available right now, by value (VOR) under our exact scoring:\n${shortlist}\n\n` +
      `Pick the best player for a balanced, winning roster given your existing picks, positional scarcity and tiers ` +
      `(early rounds: take the best RB/WR/elite TE value; don't reach for QB/K/DEF). ` +
      `Then IMMEDIATELY run: act pick "<exact name from the list>". Be decisive and fast — the clock is running. Keep reasoning to a sentence or two.`,
  });
  console.log(`[draft-run] agent finished in ${((Date.now() - t0) / 1000).toFixed(1)}s (exit ${res.exitCode})`);

  const after = await sleeper.draftPicks(draftId);
  const mine = after.find((p) => p.pick_no === pickNo);
  if (mine) {
    const nm = `${mine.metadata?.["first_name"] ?? ""} ${mine.metadata?.["last_name"] ?? ""}`.trim();
    myPicks.push(nm);
    console.log(`[draft-run] pick ${pickNo} = ${nm}`);
  } else {
    console.log(`[draft-run] warning: pick ${pickNo} not registered; may have auto-picked`);
  }
  if (round % 4 === 0) await syncQueue(); // top the safety net back up
  await Bun.sleep(1500);
}

console.log(`[draft-run] my roster: ${myPicks.join(", ")}`);
