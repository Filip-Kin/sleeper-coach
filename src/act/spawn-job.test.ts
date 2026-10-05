import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJobProcess, runJobWithRetry } from "./spawn-job.ts";
import { EXIT_BEFORE_WRITE } from "../killswitch.ts";

// R8. Every spawned job gets a deadline. A hung child used to hang the poll
// loop with it.
describe("runJobProcess", () => {
  test("a job that overruns is killed and reported", async () => {
    const r = await runJobProcess(["sleep", "30"], { cwd: "/tmp", timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
  test("a quick job returns its exit code and output", async () => {
    const r = await runJobProcess(["sh", "-c", "echo hi; exit 3"], { cwd: "/tmp", timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(3);
    expect(r.out.trim()).toBe("hi");
  });
});

// 2026-10-04 18:45 ET: inactive-sunday died on one 15 s read timeout and the
// occurrence was burned. A run that says it never reached a write is repeated;
// nothing else is.
describe("runJobWithRetry", () => {
  /** A job that exits with the next code in `codes` on each run, counting runs in a file. */
  const scripted = (codes: number[]): { cmd: string[]; runs: () => number } => {
    const f = join(mkdtempSync(join(tmpdir(), "retry-")), "n");
    const pick = codes.map((c, i) => `[ "$n" = "${i + 1}" ] && exit ${c}`).join("; ");
    return {
      cmd: ["sh", "-c", `n=$(( $(cat ${f} 2>/dev/null || echo 0) + 1 )); echo $n > ${f}; ${pick}; exit ${codes[codes.length - 1]}`],
      runs: () => Number(readFileSync(f, "utf8").trim()),
    };
  };
  const opts = { cwd: "/tmp", timeoutMs: 5_000 };

  test("a run that failed before any write is repeated until it passes", async () => {
    const job = scripted([EXIT_BEFORE_WRITE, EXIT_BEFORE_WRITE, 0]);
    const seen: number[] = [];
    const r = await runJobWithRetry(job.cmd, opts, { retries: 2, waitMs: 1, onRetry: (_r, attempt) => seen.push(attempt) });
    expect(r.code).toBe(0);
    expect(r.attempts).toBe(3);
    expect(job.runs()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });
  test("it gives up after the allowed retries and reports the last failure", async () => {
    const job = scripted([EXIT_BEFORE_WRITE]);
    const r = await runJobWithRetry(job.cmd, opts, { retries: 2, waitMs: 1 });
    expect(r.code).toBe(EXIT_BEFORE_WRITE);
    expect(r.attempts).toBe(3);
    expect(job.runs()).toBe(3);
  });
  test("a failure at or after the write gate is never repeated", async () => {
    const job = scripted([1, 0]);
    const r = await runJobWithRetry(job.cmd, opts, { retries: 2, waitMs: 1 });
    expect(r.code).toBe(1);
    expect(r.attempts).toBe(1);
    expect(job.runs()).toBe(1);
  });
  test("a job that passes runs once", async () => {
    const job = scripted([0]);
    const r = await runJobWithRetry(job.cmd, opts, { retries: 2, waitMs: 1 });
    expect(r.attempts).toBe(1);
    expect(job.runs()).toBe(1);
  });
  test("a job killed at its deadline is never repeated", async () => {
    const r = await runJobWithRetry(["sleep", "30"], { cwd: "/tmp", timeoutMs: 200 }, { retries: 2, waitMs: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.attempts).toBe(1);
  });
  test("a slow failure is not repeated, so the poll loop is never held for three of them", async () => {
    const r = await runJobWithRetry(["sh", "-c", `sleep 0.4; exit ${EXIT_BEFORE_WRITE}`], opts, { retries: 2, waitMs: 1, maxFailSecs: 0.2 });
    expect(r.code).toBe(EXIT_BEFORE_WRITE);
    expect(r.attempts).toBe(1);
  });
});
