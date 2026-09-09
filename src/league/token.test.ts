import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessToken, jwtExpiry, MissingTokenError, REFRESH_INSTRUCTION, writeToken } from "./token.ts";
import { probeToken, SleeperAuthError, tokenGql } from "./api.ts";

// A JWT with a chosen exp claim. The signature is junk on purpose: nothing here
// verifies it, and Sleeper is the only party that should.
function jwt(exp: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ user_id: 1, exp })}.sig`;
}
const DAY = 86_400_000;

// Capture what the transport sends and answer with a canned body or status.
function fakeFetch(answers: { status?: number; body?: unknown }[]) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    const a = answers.shift() ?? { status: 200, body: { data: {} } };
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("tokenGql transport", () => {
  test("sends the token as a plain authorization header, no Bearer", async () => {
    const f = fakeFetch([{ body: { data: { me: { user_id: "1" } } } }]);
    const gql = tokenGql({ token: "abc.def.ghi", fetchImpl: f.impl });
    const body = await gql("{me{user_id}}");
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]?.url).toBe("https://sleeper.app/graphql");
    expect(f.calls[0]?.headers.authorization).toBe("abc.def.ghi");
    expect(f.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({ query: "{me{user_id}}" });
    // The raw body comes back so the helpers keep unwrapping data/errors.
    expect((body.data as { me: { user_id: string } }).me.user_id).toBe("1");
  });

  test("an unauthorized answer is surfaced as SleeperAuthError", async () => {
    const f = fakeFetch([{ body: { data: { me: null }, errors: [{ code: "unauthorized", message: "unauthorized", path: ["me"] }] } }]);
    const gql = tokenGql({ token: "bad", fetchImpl: f.impl });
    await expect(gql("{me{user_id}}")).rejects.toBeInstanceOf(SleeperAuthError);
  });

  test("other GraphQL errors pass through in the body for the caller to unwrap", async () => {
    const f = fakeFetch([{ body: { data: null, errors: [{ code: "invalid_pick_for_game", message: "no" }] } }]);
    const body = await tokenGql({ token: "t", fetchImpl: f.impl })("mutation{x}");
    expect((body.errors as { code: string }[])[0]?.code).toBe("invalid_pick_for_game");
  });

  test("a missing token throws MissingTokenError with the refresh instruction, before any request", async () => {
    const prevEnv = process.env.SLEEPER_TOKEN;
    delete process.env.SLEEPER_TOKEN;
    try {
      const tokenFile = join(mkdtempSync(join(tmpdir(), "sleeper-token-")), "absent");
      const f = fakeFetch([]);
      const err = await tokenGql({ fetchImpl: f.impl, tokenFile })("{me{user_id}}").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain(REFRESH_INSTRUCTION);
      expect((err as Error).message).toContain(tokenFile);
      expect(f.calls.length).toBe(0);
    } finally {
      if (prevEnv !== undefined) process.env.SLEEPER_TOKEN = prevEnv;
    }
  });

  test("retries once on 429 and 5xx, then gives up", async () => {
    const ok = { body: { data: { me: { user_id: "1" } } } };
    const f = fakeFetch([{ status: 503, body: {} }, ok]);
    const body = await tokenGql({ token: "t", fetchImpl: f.impl })("{me{user_id}}");
    expect(f.calls.length).toBe(2);
    expect((body.data as { me: { user_id: string } }).me.user_id).toBe("1");

    const g = fakeFetch([{ status: 429, body: {} }, { status: 429, body: {} }]);
    await expect(tokenGql({ token: "t", fetchImpl: g.impl })("{me{user_id}}")).rejects.toThrow(/HTTP 429/);
    expect(g.calls.length).toBe(2);
  });
});

describe("jwtExpiry", () => {
  test("reads exp in seconds and returns milliseconds", () => {
    expect(jwtExpiry(jwt(1_817_000_000))).toBe(1_817_000_000_000);
  });
  test("null for a non-JWT or a JWT without exp", () => {
    expect(jwtExpiry("not-a-jwt")).toBeNull();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(jwtExpiry(`${b64({})}.${b64({ user_id: 1 })}.x`)).toBeNull();
  });
});

describe("assessToken (the daemon's check, pure)", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");

  test("me ok and exp far out: usable, no alert", () => {
    const v = assessToken({ kind: "ok", expMs: now + 331 * DAY }, now);
    expect(v.usable).toBe(true);
    expect(v.alert).toBeNull();
    expect(v.inconclusive).toBe(false);
    expect(v.summary).toContain("331 days");
  });

  test("exactly 14 days out alerts; 15 days out does not", () => {
    expect(assessToken({ kind: "ok", expMs: now + 14 * DAY }, now).alert).not.toBeNull();
    expect(assessToken({ kind: "ok", expMs: now + 15 * DAY }, now).alert).toBeNull();
  });

  test("inside 14 days: still usable, alert carries the refresh instruction", () => {
    const v = assessToken({ kind: "ok", expMs: now + 3 * DAY }, now);
    expect(v.usable).toBe(true);
    expect(v.alert).toContain("expires in 3 day(s)");
    expect(v.alert).toContain(REFRESH_INSTRUCTION);
  });

  test("me ok but no exp claim: usable, nothing to warn about", () => {
    const v = assessToken({ kind: "ok", expMs: null }, now);
    expect(v.usable).toBe(true);
    expect(v.alert).toBeNull();
  });

  test("missing and unauthorized: not usable, alert with the instruction", () => {
    for (const kind of ["missing", "unauthorized"] as const) {
      const v = assessToken({ kind }, now);
      expect(v.usable).toBe(false);
      expect(v.inconclusive).toBe(false);
      expect(v.alert).toContain(REFRESH_INSTRUCTION);
    }
  });

  test("a transport error is inconclusive: not usable this poll, no alert", () => {
    const v = assessToken({ kind: "error", message: "fetch failed" }, now);
    expect(v.usable).toBe(false);
    expect(v.inconclusive).toBe(true);
    expect(v.alert).toBeNull();
  });
});

describe("probeToken", () => {
  test("maps me, unauthorized and a network error to probe kinds", async () => {
    process.env.SLEEPER_TOKEN = jwt(Math.floor(Date.now() / 1000) + 300 * 86_400);
    try {
      const ok = await probeToken(async () => ({ data: { me: { user_id: "1267685386142887936" } } }));
      expect(ok.kind).toBe("ok");
      if (ok.kind === "ok") expect(ok.expMs).toBeGreaterThan(Date.now() + 299 * DAY);

      const un = await probeToken(async () => { throw new SleeperAuthError("unauthorized"); });
      expect(un.kind).toBe("unauthorized");

      const err = await probeToken(async () => { throw new Error("fetch failed"); });
      expect(err.kind).toBe("error");
    } finally {
      delete process.env.SLEEPER_TOKEN;
    }
  });
});

describe("writeToken", () => {
  test("writes one line with mode 600 even when the file already existed with looser bits", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleeper-token-"));
    const file = join(dir, "sleeper-token");
    writeToken("first\n", file);
    chmodSync(file, 0o644);
    writeToken("  second  ", file);
    expect(readFileSync(file, "utf8")).toBe("second\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeToken("   ", file)).toThrow(/empty/);
  });
});
