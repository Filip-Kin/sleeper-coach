import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RunLedger } from "./run-ledger.ts";

// R11. A job that was started and never finished (the container was redeployed
// under it) must not be re-run on boot: its occurrence is already recorded as
// handled the moment it starts, and boot reports the interruption once.
describe("RunLedger", () => {
  test("a started job counts as run", () => {
    const db = new Database(":memory:");
    const l = new RunLedger(db);
    l.markStarted("lineup-sunday", 100);
    expect(l.lastRunOf("lineup-sunday")).toBe(100);
  });
  test("a started-but-unfinished job is reported on the next boot and not re-run", () => {
    const db = new Database(":memory:");
    new RunLedger(db).markStarted("waiver-submit", 500);
    const boot = new RunLedger(db);
    expect(boot.interrupted().map((r) => r.job)).toEqual(["waiver-submit"]);
    boot.settleInterrupted();
    expect(boot.interrupted()).toEqual([]);
    expect(boot.lastRunOf("waiver-submit")).toBe(500);
  });
  test("a finished job is not interrupted", () => {
    const db = new Database(":memory:");
    const l = new RunLedger(db);
    l.markStarted("engineer", 7);
    l.markFinished("engineer", 7);
    expect(new RunLedger(db).interrupted()).toEqual([]);
  });
  test("an existing table without the new columns is upgraded", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE scheduled_runs (job TEXT PRIMARY KEY, last_run INTEGER)");
    db.run("INSERT INTO scheduled_runs (job, last_run) VALUES ('old', 42)");
    const l = new RunLedger(db);
    expect(l.lastRunOf("old")).toBe(42);
    expect(l.interrupted()).toEqual([]);
  });
});
