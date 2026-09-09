// The Sleeper session token: where it lives, how it is read and written, and
// the pure check the daemon runs on it.
//
// The token is the JWT the Sleeper web app keeps in localStorage under the key
// "token". Sent as a plain `authorization: <token>` header (no Bearer prefix)
// it authenticates every user-scoped GraphQL call: DMs, trade responses,
// starters, waiver claims, pick'em picks. Verified 2026-09-09 from the host
// with a bare fetch: `me`, `my_dms` and a no-op roster_update_starters all
// answered with errors: null. The browser that used to hold the token added
// nothing, so it is gone; this file is what replaced it.
//
// Refreshing is a human step on purpose. The `login` query wants a password
// and a captcha, and storing Filip's password on the box is worse than a
// yearly copy-paste. The instruction below is what the daemon alerts with.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STATE_DIR = process.env.STATE_DIR ?? "/data/sleeper-coach";
export const TOKEN_FILE = `${STATE_DIR}/sleeper-token`;

/** The refresh procedure, word for word what the alert says. README, "The
 *  Sleeper token", walks through the same steps. */
export const REFRESH_INSTRUCTION =
  "Refresh it: log in at https://sleeper.com in a browser, open DevTools, Application, Local Storage, " +
  "https://sleeper.com, copy the value of the key \"token\", then run " +
  "`docker exec -i <coach container> bun run src/act/cli.ts token import -` and paste the token.";

export class MissingTokenError extends Error {
  constructor(file: string) {
    super(`no Sleeper token: set SLEEPER_TOKEN or write ${file}. ${REFRESH_INSTRUCTION}`);
    this.name = "MissingTokenError";
  }
}

/** SLEEPER_TOKEN env first (tests, one-off scripts), then the state file. */
export function readToken(file = TOKEN_FILE): string {
  const fromEnv = process.env.SLEEPER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(file)) throw new MissingTokenError(file);
  const tok = readFileSync(file, "utf8").trim();
  if (!tok) throw new MissingTokenError(file);
  return tok;
}

/** Write the token with mode 600. The file holds a full login, so the mode is
 *  set explicitly rather than trusting the umask. */
export function writeToken(token: string, file = TOKEN_FILE): void {
  const tok = token.trim();
  if (!tok) throw new Error("refusing to write an empty token");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${tok}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync's mode only applies when the file is created
}

/** The `exp` claim of a JWT in milliseconds, or null when the token is not a
 *  JWT or carries no exp. No signature check: Sleeper is the one that verifies
 *  it; this is only for the "how long have we got" arithmetic. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

// #region the daemon's check, pure
/** What one probe of the token found. Produced by probeToken in api.ts and by
 *  the test fixtures. */
export type TokenProbe =
  | { kind: "ok"; expMs: number | null }
  | { kind: "missing" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export interface TokenVerdict {
  /** True when writes can go out now. A token that expires soon is still usable. */
  usable: boolean;
  /** Text for the daily alert, or null when nothing needs Filip. */
  alert: string | null;
  /** True when the probe was inconclusive (network, HTTP 5xx). The daemon holds
   *  writes for one poll and does not count it as a lost session. */
  inconclusive: boolean;
  summary: string;
}

export const WARN_DAYS = 14;

/** `me` succeeded and the JWT exp is more than WARN_DAYS out: fine. Anything
 *  else produces an alert with the refresh instruction. */
export function assessToken(probe: TokenProbe, nowMs: number, warnDays = WARN_DAYS): TokenVerdict {
  switch (probe.kind) {
    case "missing":
      return { usable: false, inconclusive: false, alert: `The coach has no Sleeper token, so it cannot act on your team. ${REFRESH_INSTRUCTION}`, summary: "missing" };
    case "unauthorized":
      return { usable: false, inconclusive: false, alert: `Sleeper rejected the coach's token (unauthorized). ${REFRESH_INSTRUCTION}`, summary: "unauthorized" };
    case "error":
      return { usable: false, inconclusive: true, alert: null, summary: `inconclusive: ${probe.message}` };
    case "ok": {
      if (probe.expMs === null) {
        return { usable: true, inconclusive: false, alert: null, summary: "ok, no exp claim" };
      }
      const daysLeft = (probe.expMs - nowMs) / 86_400_000;
      if (daysLeft <= warnDays) {
        const when = daysLeft <= 0 ? "has expired" : `expires in ${Math.max(0, Math.floor(daysLeft))} day(s)`;
        return { usable: true, inconclusive: false, alert: `The coach's Sleeper token ${when}. ${REFRESH_INSTRUCTION}`, summary: `ok, ${when}` };
      }
      return { usable: true, inconclusive: false, alert: null, summary: `ok, ${Math.floor(daysLeft)} days left` };
    }
  }
}
// #endregion
