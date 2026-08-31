#!/usr/bin/env bun
// The AUTONOMOUS engineer, running inside the coach container.
//
// WHY. Filip, 31 August 2026: "I want to be hands off after today. The engineer
// should handle all engineering. The bot should handle all coaching." The engineer
// already existed (src/engineer/engineer.ts) but nothing ever called it and it
// assumed a host with the repo, docker and git credentials. This version is a
// scheduled job in the coach container, so the same containerized schedule that
// runs the weekly coaching locks also runs the engineering.
//
// WHY NO DOCKER SOCKET. It does not need one. Pushing to main is enough, because
// Coolify auto-deploys this repo on push. Handing a container the docker socket
// would be root-equivalent on the host, which is a far worse trade than a
// repo-scoped token.
//
// THE GATE IS THE FULL TEST SUITE, not just a typecheck. On 30 August two branches
// that each passed alone reached main with a broken suite, because the merge
// combined a bun:test file with a runner that only knew plain scripts. A typecheck
// would not have caught it. If the suite is red the work is REVERTED and the
// request is marked failed, so a bad change cannot deploy itself.
//
//   bun run src/engineer/engineer-run.ts            # drain the queue once
//   bun run src/engineer/engineer-run.ts --dry      # plan only, no agent, no push

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { logEvent } from "../log.ts";
import { sendAlert } from "../alert.ts";

const STATE = process.env.COACH_STATE ?? "/data/sleeper-coach";
const QUEUE = process.env.IMPROVE_QUEUE ?? `${STATE}/improvement-requests.jsonl`;
const WORK = process.env.ENGINEER_REPO ?? `${STATE}/repo`;
const DRAFT_LOCK = `${STATE}/draft-active`;
const CLAUDE = process.env.CLAUDE_BIN ?? `${STATE}/config/.local/bin/claude`;
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? `${STATE}/config`;
const REMOTE = process.env.ENGINEER_REMOTE ?? "https://github.com/Filip-Kin/sleeper-coach.git";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const MODEL = process.env.ENGINEER_MODEL ?? "claude-opus-4-8";
const DRY = process.argv.includes("--dry");

interface Req { id: string; ts: string; status: string; request: string; artefacts?: string[]; summary?: string }

const load = (): Req[] =>
  existsSync(QUEUE) ? readFileSync(QUEUE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Req) : [];
const save = (rs: Req[]): void => writeFileSync(QUEUE, rs.map((r) => JSON.stringify(r)).join("\n") + (rs.length ? "\n" : ""));

async function sh(cmd: string[], cwd = WORK): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: CLAUDE_HOME } });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

// The push URL carries the token. Never logged, and never written into the repo's
// stored remote, so it cannot leak into a committed config.
const authRemote = (): string => (TOKEN ? REMOTE.replace("https://", `https://x-access-token:${TOKEN}@`) : REMOTE);

async function ensureRepo(): Promise<boolean> {
  if (!TOKEN) {
    console.error("[engineer] GITHUB_TOKEN is not set; cannot push, standing down.");
    return false;
  }
  mkdirSync(STATE, { recursive: true });
  if (!existsSync(`${WORK}/.git`)) {
    console.log("[engineer] cloning the repo into the state volume (first run)");
    const c = await sh(["git", "clone", authRemote(), WORK], STATE);
    if (c.code !== 0) { console.error(`[engineer] clone failed: ${c.err.slice(0, 300)}`); return false; }
  }
  await sh(["git", "config", "user.name", "Sleeper Coach Engineer"]);
  await sh(["git", "config", "user.email", "engineer@filipkin.com"]);
  await sh(["git", "remote", "set-url", "origin", REMOTE]); // token-free on disk
  const f = await sh(["git", "fetch", authRemote(), "main"]);
  if (f.code !== 0) { console.error(`[engineer] fetch failed: ${f.err.slice(0, 300)}`); return false; }
  await sh(["git", "checkout", "-B", "main", "FETCH_HEAD"]);
  await sh(["git", "reset", "--hard", "FETCH_HEAD"]);
  await sh(["git", "clean", "-fd"]);
  return true;
}

async function runAgentOn(req: Req): Promise<boolean> {
  const artefacts = (req.artefacts ?? []).filter((a) => existsSync(a));
  const brief =
    `You are the engineer for an autonomous fantasy football coach. Implement this request in the repo at ${WORK}.\n\n` +
    `REQUEST\n${req.request}\n\n` +
    (artefacts.length ? `ARTEFACTS captured from the live site, read these first:\n${artefacts.join("\n")}\n\n` : "") +
    `RULES\n` +
    `- The full suite must pass: run \`bun run test\`. Your work is REVERTED if it is red.\n` +
    `- Never weaken src/analysis/rails.ts or src/killswitch.ts. They exist to stop irreversible mistakes.\n` +
    `- Every write path verifies by reading state back from the DOM, never from the rosters API, which serves stale data for minutes after a change.\n` +
    `- NEVER issue a write against the real league 1389357604773322752. Staging is 1399830848848592896 (our roster_id 1).\n` +
    `- Leave new write paths GATED behind their env flag. Implement and test; do not arm.\n` +
    `- No em dashes. NZ spelling. Comments explain WHY, citing the incident when one motivated the code.\n` +
    `- Do not commit; the runner commits and pushes if the suite is green.\n`;

  console.log(`[engineer] working on ${req.id}: ${req.request.slice(0, 110)}`);
  if (DRY) { console.log("[engineer] (dry run, agent not invoked)"); return false; }
  const p = Bun.spawn(
    [CLAUDE, "--model", MODEL, "--settings", `${WORK}/engineer-settings.json`,
     "--append-system-prompt", readFileSync(`${WORK}/engineer-prompt.md`, "utf8"),
     "--print", brief],
    { cwd: WORK, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: CLAUDE_HOME } },
  );
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  console.log(out.trim().slice(-2000));
  if (code !== 0) console.error(`[engineer] agent exited ${code}: ${err.slice(0, 300)}`);
  return code === 0;
}

async function main(): Promise<void> {
  if (existsSync(DRAFT_LOCK)) { console.log("[engineer] a draft is live; standing down."); return; }
  const queue = load();
  const open = queue.filter((r) => r.status === "open");
  if (!open.length) { console.log("[engineer] queue empty."); return; }
  console.log(`[engineer] ${open.length} open request(s)`);
  if (!(await ensureRepo())) return;

  for (const req of open) {
    logEvent("engineer", "start", `Working on ${req.id}: ${req.request.slice(0, 160)}`, { id: req.id });
    const ok = await runAgentOn(req);
    const changed = (await sh(["git", "status", "--porcelain"])).out.trim();
    if (!ok || !changed) {
      req.status = ok ? "no-change" : "failed";
      req.summary = ok ? "agent made no changes" : "agent errored";
      logEvent("engineer", "aborted", `${req.id}: ${req.summary}`, { id: req.id });
      await sh(["git", "checkout", "--", "."]); await sh(["git", "clean", "-fd"]);
      continue;
    }
    // THE GATE. A typecheck is not enough; see the header.
    const tests = await sh(["bash", "scripts/run-tests.sh"]);
    if (tests.code !== 0) {
      console.error(`[engineer] SUITE RED, reverting ${req.id}`);
      console.error(tests.out.trim().split("\n").slice(-20).join("\n"));
      req.status = "failed"; req.summary = "test suite failed; work reverted";
      logEvent("engineer", "reverted", `${req.id}: suite red, work reverted.`, { id: req.id });
      await sendAlert("Engineer reverted a change", `${req.id}: the test suite failed, so nothing was pushed.`).catch(() => {});
      await sh(["git", "checkout", "--", "."]); await sh(["git", "clean", "-fd"]);
      continue;
    }
    const msg = `${(req.request.split("\n")[0] ?? req.id).slice(0, 68)}\n\nAutonomous engineer, request ${req.id}. Full test suite green before push.`;
    await sh(["git", "add", "-A"]);
    await sh(["git", "commit", "-m", msg]);
    const push = await sh(["git", "push", authRemote(), "HEAD:main"]);
    if (push.code !== 0) {
      req.status = "failed"; req.summary = `push failed: ${push.err.slice(0, 200)}`;
      logEvent("engineer", "push-failed", `${req.id}: ${req.summary}`, { id: req.id });
      continue;
    }
    req.status = "done"; req.summary = "implemented, suite green, pushed to main";
    logEvent("engineer", "done", `${req.id} shipped: suite green, pushed. Coolify will redeploy.`, { id: req.id });
    await sendAlert("Engineer shipped a change", `${req.id}: ${req.request.slice(0, 200)}. Suite green, pushed to main.`).catch(() => {});
  }
  save(queue);
}

await main();
