#!/usr/bin/env bun
// Weekly outbound trade offers. See src/league/trade-propose.ts for when it
// decides to send one and why it is deliberately reluctant.
//
//   bun run src/league/propose-run.ts          send at most one offer
//   bun run src/league/propose-run.ts --dry    decide and print, send nothing

import { Database } from "bun:sqlite";
import { runProposer } from "./trade-propose.ts";

const DRY = process.argv.includes("--dry");
const DB_PATH = `${process.env.STATE_DIR ?? "/data/sleeper-coach"}/coach.db`;
const db = new Database(DB_PATH);

if (DRY) {
  // A dry run must not write the cooldown row, or the real run would then skip
  // the very offer it just decided to send.
  const { dryRunProposer } = await import("./trade-propose.ts");
  const r = await dryRunProposer({ db });
  console.log(`[propose] considered ${r.considered}, best: ${r.sent ? r.sent.why : "none"} (${r.reason})`);
} else {
  const r = await runProposer({ db });
  console.log(`[propose] considered ${r.considered}; ${r.sent ? `SENT: ${r.sent.why}` : `nothing sent (${r.reason})`}`);
}
