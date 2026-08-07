#!/usr/bin/env bun
// The engineer. Runs on the HOST (has the git repo + docker), separate from the
// coach's football context. It drains the coach's improvement requests, has a
// coding agent implement each one, gates on typecheck, then commits under its
// OWN git identity, pushes to the public repo, and redeploys the container.
// Every step is logged for the public record. Guardrails: never deploys on a
// failing typecheck; every change is a revertable commit; it stands down while
// a draft is live.
//
//   bun run src/engineer/engineer.ts        (host, from the repo root)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { $ } from "bun";
import { logEvent } from "../log.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const QUEUE = process.env.IMPROVE_QUEUE ?? "/data/sleeper-coach/improvement-requests.jsonl";
const DRAFT_LOCK = "/data/sleeper-coach/draft-active";
const CLAUDE = process.env.HOST_CLAUDE ?? "/home/filip/.local/bin/claude";
const ENG_SETTINGS = `${REPO}/engineer-settings.json`;
const ENG_PROMPT = readFileSync(`${REPO}/engineer-prompt.md`, "utf8");
const AUTHOR = ["-c", "user.name=Sleeper Coach Engineer", "-c", "user.email=engineer@filipkin.com"];

interface Req {
  id: string;
  ts: string;
  status: string;
  request: string;
  summary?: string;
}

function loadQueue(): Req[] {
  if (!existsSync(QUEUE)) return [];
  return readFileSync(QUEUE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Req);
}
function saveQueue(reqs: Req[]): void {
  writeFileSync(QUEUE, reqs.map((r) => JSON.stringify(r)).join("\n") + (reqs.length ? "\n" : ""));
}

async function notify(title: string, message: string): Promise<void> {
  // On the host, reuse the proven HA helper (localhost:8123 + ~/.ha_token).
  const helper = "/home/filip/scripts/ha-notify.sh";
  if (existsSync(helper)) {
    await $`${helper} ${`Coach engineer: ${title}`} ${message}`.nothrow().quiet();
    return;
  }
  const url = process.env.HA_NOTIFY_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title, message }) });
  } catch {
    /* best effort */
  }
}

async function runCodingAgent(request: string): Promise<string> {
  const task = `Improvement request for the sleeper-coach service:\n\n${request}\n\nImplement it now with a minimal, correct diff, then run \`bun run typecheck\` and fix any errors. Finish with a short summary of what you changed.`;
  const proc = Bun.spawn(
    [
      CLAUDE, "--print", "--output-format", "text", "--model", "claude-opus-4-8", "--effort", "high",
      "--settings", ENG_SETTINGS,
      "--tools", "Read", "Edit", "Write", "Grep", "Glob", "Bash",
      "--append-system-prompt", ENG_PROMPT,
      task,
    ],
    { cwd: REPO, env: { ...process.env, HOME: "/home/filip" }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function implement(req: Req): Promise<void> {
  logEvent("engineer", "pickup", `Implementing request: ${req.request}`, { id: req.id });

  const summary = await runCodingAgent(req.request);

  const tc = await $`bun run typecheck`.cwd(REPO).nothrow().quiet();
  if (tc.exitCode !== 0) {
    req.status = "failed-typecheck";
    logEvent("engineer", "typecheck-fail", `Typecheck failed; reverting, not deploying: ${req.request}`, { id: req.id, output: tc.stderr.toString().slice(-600) });
    await $`git checkout -- .`.cwd(REPO).nothrow().quiet(); // discard the broken change
    await notify("Engineer: change rejected (typecheck)", req.request);
    return;
  }

  const dirty = (await $`git status --porcelain`.cwd(REPO).quiet()).stdout.toString().trim();
  if (!dirty) {
    req.status = "no-change";
    logEvent("engineer", "no-op", `No code change produced: ${req.request}`, { id: req.id, summary });
    return;
  }

  const diffstat = (await $`git diff --stat`.cwd(REPO).quiet()).stdout.toString().trim();
  await $`git ${AUTHOR} add -A`.cwd(REPO).quiet();
  const msg = `engineer: ${req.request.slice(0, 60)}\n\nAuto-implemented from coach improvement request ${req.id}.\n\n${summary.slice(0, 800)}`;
  await $`git ${AUTHOR} commit -q -m ${msg}`.cwd(REPO).quiet();
  await $`git push -q origin main`.cwd(REPO).nothrow().quiet();

  // Redeploy so the change goes live.
  await $`docker compose build`.cwd(REPO).nothrow().quiet();
  await $`docker compose up -d --force-recreate`.cwd(REPO).nothrow().quiet();

  req.status = "done";
  req.summary = summary.slice(0, 800);
  logEvent("engineer", "code-change", `Deployed change: ${req.request}`, { id: req.id, diffstat, summary: req.summary });
  await notify("Engineer: change deployed", `${req.request}\n\n${diffstat}`);
}

// #region main
if (existsSync(DRAFT_LOCK)) {
  console.log("[engineer] a draft is live; standing down until it finishes");
  process.exit(0);
}
const queue = loadQueue();
const pending = queue.filter((r) => r.status === "pending");
if (!pending.length) {
  console.log("[engineer] no pending requests");
  process.exit(0);
}
console.log(`[engineer] ${pending.length} pending request(s)`);
for (const req of pending) {
  try {
    await implement(req);
  } catch (e) {
    req.status = "error";
    logEvent("engineer", "error", `Error on ${req.id}: ${e instanceof Error ? e.message : String(e)}`, { id: req.id });
    await $`git checkout -- .`.cwd(REPO).nothrow().quiet();
  }
  saveQueue(queue);
}
console.log("[engineer] done");
// #endregion
