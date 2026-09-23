import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeat, readHeartbeat, heartbeatAgeMs, healthVerdict, HEARTBEAT_STALE_MS } from "./heartbeat.ts";
import { HEARTBEAT_FILE } from "./paths.ts";

describe("heartbeat file", () => {
  test("each call bumps the poll count and the file reads back", () => {
    heartbeat();
    heartbeat();
    const hb = readHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.poll).toBe(2);
    expect(hb!.pid).toBe(process.pid);
    expect(HEARTBEAT_FILE.startsWith("/tmp/")).toBe(true); // never the production volume under test
    const age = heartbeatAgeMs();
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(5_000);
  });
  test("a corrupt file is no heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const f = join(dir, "heartbeat");
    writeFileSync(f, "{not json");
    expect(readHeartbeat(f)).toBeNull();
    expect(heartbeatAgeMs(Date.now(), f)).not.toBeNull(); // mtime still counts as alive
    expect(heartbeatAgeMs(Date.now(), join(dir, "missing"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  test("healthVerdict thresholds", () => {
    expect(healthVerdict(null).status).toBe(503);
    expect(healthVerdict(1_000).status).toBe(200);
    expect(healthVerdict(HEARTBEAT_STALE_MS + 1).status).toBe(503);
    expect(healthVerdict(HEARTBEAT_STALE_MS + 1).body).toContain("old");
  });
  test("an old mtime reads as stale end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const f = join(dir, "heartbeat");
    writeFileSync(f, JSON.stringify({ ts: "x", poll: 1, pid: 1 }));
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(f, old, old);
    expect(healthVerdict(heartbeatAgeMs(Date.now(), f)).status).toBe(503);
    rmSync(dir, { recursive: true, force: true });
  });
});
