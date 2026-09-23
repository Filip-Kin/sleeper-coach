// Boot-time tidying of coach.db. Small, idempotent, and each step says why.

import type { Database } from "bun:sqlite";
import type { Job } from "../schedule.ts";

/** Delete scheduled_runs rows for jobs that no longer exist. The fixed pick'em
 *  timetable (pickem-0900, pickem-final-sun, ...) was replaced by kickoff-driven
 *  passes on 2026-09-02 and its eight rows stayed in the table, where they read
 *  as jobs the loop had stopped running. Returns the names removed. */
export function pruneDeadJobs(db: Database, jobs: readonly Pick<Job, "name">[]): string[] {
  db.run("CREATE TABLE IF NOT EXISTS scheduled_runs (job TEXT PRIMARY KEY, last_run INTEGER)");
  const live = new Set(jobs.map((j) => j.name));
  const rows = db.query<{ job: string }, []>("SELECT job FROM scheduled_runs").all();
  const dead = rows.map((r) => r.job).filter((name) => !live.has(name));
  for (const name of dead) db.run("DELETE FROM scheduled_runs WHERE job = ?", [name]);
  return dead;
}
