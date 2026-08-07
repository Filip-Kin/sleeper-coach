import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// One durable, append-only activity log both agents write to. It's the record
// of everything the coach and the engineer do — decisions, reasoning, picks,
// trades, improvement requests, code changes — for observability and for the
// public spectacle. JSONL so it's trivially streamable to the dashboard and
// publishable.

const LOG_PATH = process.env.ACTIVITY_LOG ?? "/data/sleeper-coach/activity.jsonl";
// Transient "thinking" channel: the agent's full streamed output, kept OUT of
// the durable activity log (which is the record of decisions) but tailed into
// the live dashboard console so the model's reasoning is watchable in full.
const REASONING_PATH = process.env.REASONING_LOG ?? "/data/sleeper-coach/reasoning.jsonl";

export interface ActivityEvent {
  ts: string;
  actor: "coach" | "engineer" | "daemon" | "system";
  type: string; // e.g. draft-pick, plan, lineup, trade-eval, improve-request, code-change
  summary: string;
  detail?: unknown;
}

export function logEvent(actor: ActivityEvent["actor"], type: string, summary: string, detail?: unknown): void {
  const ev: ActivityEvent = { ts: new Date().toISOString(), actor, type, summary, ...(detail !== undefined ? { detail } : {}) };
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(ev) + "\n");
  } catch {
    /* logging must never break the caller */
  }
  console.log(`[${actor}] ${type}: ${summary}`);
}

// Append a chunk of the agent's live reasoning to the transient channel. Shown
// in the dashboard console as it streams; never pollutes the durable activity
// record. Keeps the caller safe if the write fails.
export function logThink(actor: ActivityEvent["actor"], text: string): void {
  if (!text.trim()) return;
  const ev = { ts: new Date().toISOString(), actor, type: "think", text };
  try {
    mkdirSync(dirname(REASONING_PATH), { recursive: true });
    appendFileSync(REASONING_PATH, JSON.stringify(ev) + "\n");
  } catch {
    /* transient channel — never break the caller */
  }
}

// Read the most recent N events (for the dashboard activity view).
export function recentEvents(n = 100): ActivityEvent[] {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l) as ActivityEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ActivityEvent => e !== null);
}
