// Every child the daemon spawns gets a deadline. A job that hangs (a stuck
// fetch with no timeout, a model call that never returns) used to hang the
// poll loop with it: no lineup guard, no trade watch, nothing, until somebody
// noticed the heartbeat had stopped.

import { EXIT_BEFORE_WRITE } from "../killswitch.ts";

export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 10 * 60 * 1000);
const KILL_GRACE_MS = 5_000;

export interface JobResult {
  code: number;
  out: string;
  err: string;
  timedOut: boolean;
  secs: number;
}

export interface JobOptions {
  cwd: string;
  timeoutMs?: number;
  /** Stream the child's output to our own stdout/stderr instead of capturing it. */
  inherit?: boolean;
}

export async function runJobProcess(cmd: string[], opts: JobOptions): Promise<JobResult> {
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
  const t0 = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, KILL_GRACE_MS);
  }, timeoutMs);
  const [code, out, err] = await Promise.all([
    proc.exited,
    proc.stdout && typeof proc.stdout !== "number" ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr && typeof proc.stderr !== "number" ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  clearTimeout(timer);
  return { code: timedOut && code === 0 ? 124 : code, out, err, timedOut, secs: (Date.now() - t0) / 1000 };
}

export interface RetryOptions {
  /** How many more runs a before-write failure may get. */
  retries: number;
  waitMs: number;
  /** A failed run longer than this is not repeated. The daemon waits on the
   *  job, so three slow failures would hold the poll loop (lineup guard,
   *  heartbeat) for the sum. A read timeout fails in seconds. */
  maxFailSecs?: number;
  onRetry?: (failed: JobResult, attempt: number) => void;
}

/** Run a job, and run it again when it failed before attempting any write.
 *
 *  The only failure repeated is exit EXIT_BEFORE_WRITE, which a job script
 *  returns when it died in its read phase (killswitch.failureExitCode): a
 *  Sleeper read that timed out, a DNS miss. Nothing on the site has changed,
 *  so the second run starts from the same place the first did. Any other exit
 *  code and a deadline kill are returned at once: the run may have written. */
export async function runJobWithRetry(cmd: string[], opts: JobOptions, retry: RetryOptions): Promise<JobResult & { attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    const r = await runJobProcess(cmd, opts);
    if (r.timedOut || r.code !== EXIT_BEFORE_WRITE || attempt > retry.retries || r.secs > (retry.maxFailSecs ?? Infinity)) return { ...r, attempts: attempt };
    retry.onRetry?.(r, attempt);
    await Bun.sleep(retry.waitMs);
  }
}
