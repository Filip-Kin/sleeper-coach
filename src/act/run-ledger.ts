// Which scheduled occurrence of each job has been handled, durably.
//
// A job is recorded as handled the moment it STARTS, not when it finishes. A
// redeploy that kills the container mid-run used to leave no row, so the new
// container found the occurrence unhandled and ran the job again: a second
// lineup write, a second claim, a second engineer pass. Now the row goes in
// first with finished = 0, and boot reports any row still unfinished once,
// without re-running it. Retrying a half-applied roster write is worse than
// missing one lock.

import type { Database } from "bun:sqlite";

export interface InterruptedRun { job: string; lastRun: number; startedAt: number }

export class RunLedger {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS scheduled_runs (
      job TEXT PRIMARY KEY,
      last_run INTEGER,
      finished INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER
    )`);
    // Older databases have the two-column table; upgrade in place. Existing
    // rows default to finished, which is what they were.
    try { db.run("ALTER TABLE scheduled_runs ADD COLUMN finished INTEGER NOT NULL DEFAULT 1"); } catch { /* already there */ }
    try { db.run("ALTER TABLE scheduled_runs ADD COLUMN started_at INTEGER"); } catch { /* already there */ }
  }

  lastRunOf(job: string): number {
    const row = this.db.query("SELECT last_run FROM scheduled_runs WHERE job = ?").get(job) as { last_run?: number } | null;
    return row?.last_run ?? 0;
  }

  markStarted(job: string, occurrence: number, now = Date.now()): void {
    this.db.run("INSERT OR REPLACE INTO scheduled_runs (job, last_run, finished, started_at) VALUES (?, ?, 0, ?)", [job, occurrence, now]);
  }

  markFinished(job: string, occurrence: number): void {
    this.db.run("INSERT OR REPLACE INTO scheduled_runs (job, last_run, finished, started_at) VALUES (?, ?, 1, (SELECT started_at FROM scheduled_runs WHERE job = ?))", [job, occurrence, job]);
  }

  /** A skipped or frozen occurrence: handled without ever starting. */
  markHandled(job: string, occurrence: number): void {
    this.db.run("INSERT OR REPLACE INTO scheduled_runs (job, last_run, finished, started_at) VALUES (?, ?, 1, NULL)", [job, occurrence]);
  }

  interrupted(): InterruptedRun[] {
    return (this.db.query("SELECT job, last_run, started_at FROM scheduled_runs WHERE finished = 0").all() as { job: string; last_run: number; started_at: number | null }[])
      .map((r) => ({ job: r.job, lastRun: r.last_run, startedAt: r.started_at ?? 0 }));
  }

  settleInterrupted(): void {
    this.db.run("UPDATE scheduled_runs SET finished = 1 WHERE finished = 0");
  }
}
