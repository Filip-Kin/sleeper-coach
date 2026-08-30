// The two-pass rail for OUTGOING trade proposals: "a bad idea has to look good
// twice." An outgoing offer is recorded as an intent on one pass and only
// actually sent on a LATER, separate pass, and only if it still evaluates as a
// clear win. This is the trade equivalent of the draft's stale-plan guard: a
// single bad evaluation, or a projection blip that flips a marginal call, can
// never on its own fire an irreversible send.
//
// Incoming offers do not need this: their bands (reject / surface / accept) live
// in evaluateTrade, and a human is in the loop for anything between. Outgoing
// proposals are the least testable and the least urgent path (the trade
// deadline is week 11), so they get the strictest gate.
//
// The gate is a pure function; the durable record lives in a tiny JSON store
// with an EXPLICIT path, so nothing here writes to live state by default and the
// tests drive it against a scratch file.

import type { TradeVerdict } from "./trade.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Identity of a proposal that ignores player order and side ordering, so the
// same deal seen twice matches itself. Partner is included: the same players
// offered to a different manager is a different intent.
export function offerKey(partner: string | number, give: string[], receive: string[]): string {
  const norm = (xs: string[]) =>
    xs
      .map((s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim())
      .sort()
      .join("+");
  return `${String(partner)}|give:${norm(give)}|recv:${norm(receive)}`;
}

export interface OutgoingIntent {
  key: string;
  firstSeen: number; // epoch ms of the first good look
  lineupDelta: number; // the evaluation at first look, for the log
  note?: string;
}

export interface GateOptions {
  // The two good looks must be at least this far apart, so "twice" means two
  // separate cycles rather than one evaluation counted twice.
  minAgeMs?: number;
  // An intent older than this is stale (rosters and projections have moved on):
  // discard it and start the two-pass over rather than send on old evidence.
  maxAgeMs?: number;
}

// Defaults sized to the daemon's ~90s poll: a second confirming pass is a
// separate cycle, and a day-old intent is thrown away.
export const DEFAULT_GATE: Required<GateOptions> = {
  minAgeMs: 60_000,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

export type GateAction = "reject" | "record" | "wait" | "send";

export interface GateDecision {
  action: GateAction;
  reason: string;
}

// Decide what to do with an outgoing proposal given any matching prior intent.
//
//   reject  the proposal is not a clear win for us; do not propose it at all
//   record  first good look; log the intent and wait for a later pass
//   wait    matching intent exists but is too fresh; the second look is too soon
//   send    matching intent has aged into the window; it has looked good twice
export function gateOutgoing(
  current: { key: string; verdict: TradeVerdict; lineupDelta: number },
  prior: OutgoingIntent | null,
  now: number,
  opts: GateOptions = {},
): GateDecision {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_GATE.minAgeMs;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_GATE.maxAgeMs;

  // We only ever SEND a proposal we are clearly confident in. A "surface" or
  // "reject" verdict is not something to fire at another manager unprompted; for
  // an outgoing offer the auto-accept bar is the send bar.
  if (current.verdict !== "accept") {
    return { action: "reject", reason: `outgoing proposal must clear the auto-accept bar; verdict is "${current.verdict}"` };
  }

  if (!prior || prior.key !== current.key) {
    return { action: "record", reason: "first good look at this proposal; recorded as an intent, will re-check next pass" };
  }

  const age = now - prior.firstSeen;
  if (age > maxAgeMs) {
    return { action: "record", reason: `prior intent is stale (${Math.round(age / 1000)}s old); starting the two-pass over` };
  }
  if (age < minAgeMs) {
    return { action: "wait", reason: `prior intent is only ${Math.round(age / 1000)}s old; a separate confirming pass is required before sending` };
  }
  return { action: "send", reason: `proposal has evaluated as a clear win twice, ${Math.round(age / 1000)}s apart; sending` };
}

// A minimal durable store for outgoing intents, keyed by offerKey. Explicit path
// on purpose: a write path must never resolve its own target from ambient
// config, and the tests point it at a scratch file.
export class IntentStore {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, OutgoingIntent> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, OutgoingIntent>;
    } catch {
      // A corrupt store is treated as empty rather than crashing the caller: the
      // worst case is one extra confirming pass, which is the safe direction.
      return {};
    }
  }

  private writeAll(all: Record<string, OutgoingIntent>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(all, null, 2));
  }

  get(key: string): OutgoingIntent | null {
    return this.readAll()[key] ?? null;
  }

  put(intent: OutgoingIntent): void {
    const all = this.readAll();
    all[intent.key] = intent;
    this.writeAll(all);
  }

  delete(key: string): void {
    const all = this.readAll();
    delete all[key];
    this.writeAll(all);
  }

  all(): OutgoingIntent[] {
    return Object.values(this.readAll());
  }

  // Drop intents older than maxAgeMs so a proposal abandoned mid-two-pass does
  // not linger and fire weeks later off dead evidence.
  prune(now: number, maxAgeMs: number): void {
    const all = this.readAll();
    let changed = false;
    for (const [k, v] of Object.entries(all)) {
      if (now - v.firstSeen > maxAgeMs) {
        delete all[k];
        changed = true;
      }
    }
    if (changed) this.writeAll(all);
  }
}
