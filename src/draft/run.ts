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
  const have = myPicks.length ? `So far you have drafted: ${myPicks.join(", ")}. ` : "";
  console.log(`[draft-run] ON THE CLOCK — pick ${pickNo} (round ${round})`);

  const t0 = Date.now();
  const res = await runAgent({
    prompt:
      `You are on the clock at pick ${pickNo} (round ${round}) of an 8-team full-PPR snake draft. ` +
      `Starters: QB, 2 RB, 2 WR, TE, 2 FLEX, K, DEF, plus bench. ${have}` +
      `Run \`coach available ${draftId} 20\` to see the best available players by value (VOR) under our exact scoring. ` +
      `Pick the best player for a balanced, winning roster given what you already have and positional scarcity, ` +
      `then draft with \`act pick "<exact full name from the board>"\`. Be decisive; you have a clock.`,
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
  await Bun.sleep(1500);
}

console.log(`[draft-run] my roster: ${myPicks.join(", ")}`);
