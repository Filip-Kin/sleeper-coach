#!/usr/bin/env bun
// Weekly outbound trade offers. See src/league/trade-propose.ts for when it
// decides to send one and why it is deliberately reluctant.
//
//   bun run src/league/propose-run.ts          send at most one offer
//   bun run src/league/propose-run.ts --dry    decide and print, send nothing

import { Database } from "bun:sqlite";
import { runProposerTwice } from "./trade-propose.ts";
import { DB_PATH } from "../paths.ts";

const DRY = process.argv.includes("--dry");
const db = new Database(DB_PATH);

if (DRY) {
  // A dry run must not write the cooldown row, or the real run would then skip
  // the very offer it just decided to send.
  const { dryRunProposer } = await import("./trade-propose.ts");
  const r = await dryRunProposer({ db });
  console.log(`[propose] considered ${r.considered}, best: ${r.sent ? r.sent.why : "none"} (${r.reason})`);
} else {
  // Two passes with a fresh read in between: the intent gate refuses to send
  // on a single look (src/analysis/trade-intent.ts).
  const r = await runProposerTwice({ db });
  console.log(`[propose] considered ${r.considered}; ${r.outcome === "sent" && r.sent ? `SENT: ${r.sent.why}` : `nothing sent (${r.outcome}: ${r.reason})`}`);
}
