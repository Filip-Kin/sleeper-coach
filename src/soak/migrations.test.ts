import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { pruneDeadJobs } from "./migrations.ts";
import { JOBS } from "../schedule.ts";

describe("pruneDeadJobs", () => {
  test("removes the retired pick'em rows and keeps every live job", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE scheduled_runs (job TEXT PRIMARY KEY, last_run INTEGER)");
    const dead = ["pickem-final-thu", "pickem-final-sun", "pickem-final-sun-night", "pickem-final-mon", "pickem-0900", "pickem-1200", "pickem-1530", "pickem-1830"];
    for (const j of [...dead, ...JOBS.map((x) => x.name)]) db.run("INSERT INTO scheduled_runs VALUES (?, ?)", [j, 1]);
    const removed = pruneDeadJobs(db, JOBS);
    expect(removed.sort()).toEqual(dead.sort());
    const left = db.query<{ job: string }, []>("SELECT job FROM scheduled_runs ORDER BY job").all().map((r) => r.job);
    expect(left).toEqual(JOBS.map((x) => x.name).sort());
    expect(left).toContain("pickem-slate"); // the one pick'em job that still exists
  });
  test("idempotent and safe on an empty database", () => {
    const db = new Database(":memory:");
    expect(pruneDeadJobs(db, JOBS)).toEqual([]);
    expect(pruneDeadJobs(db, JOBS)).toEqual([]);
  });
});
