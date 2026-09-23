// Every child the daemon spawns gets a deadline. A job that hangs (a stuck
// fetch with no timeout, a model call that never returns) used to hang the
// poll loop with it: no lineup guard, no trade watch, nothing, until somebody
// noticed the heartbeat had stopped.

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
