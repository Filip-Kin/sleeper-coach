import { describe, expect, test } from "bun:test";
import { runJobProcess } from "./spawn-job.ts";

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
