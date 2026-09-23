import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendAlert, sendDigest, useAlertDbForTests, budgetDecision, composeDigest, recordAlert, markSent,
  nowPushesLastHour, mutedThisHour, alertsLastHour, pendingDigest, NOW_BUDGET_PER_HOUR, MUTE_KEY, type AlertRow,
} from "./alert.ts";

// Under NODE_ENV=test the config points at STAGING, so pushHa never calls HA
// and every send is a console line; the table is what we assert on.

let dir = "";
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alert-test-"));
  db = new Database(join(dir, "coach.db"));
  useAlertDbForTests(db);
});
afterEach(() => {
  useAlertDbForTests(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = (): AlertRow[] => db.query<AlertRow, []>("SELECT id, ts, level, title, message, key, sent FROM alerts ORDER BY id").all();

describe("every alert is recorded before anything else happens", () => {
  test("a now alert is a sent row", async () => {
    await sendAlert("Title", "body", { key: "k1" });
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]!.level).toBe("now");
    expect(r[0]!.key).toBe("k1");
    expect(r[0]!.sent).toBe(1);
  });
  test("a digest alert is recorded and never pushed", async () => {
    await sendAlert("Quiet", "later", { level: "digest" });
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]!.level).toBe("digest");
    expect(r[0]!.sent).toBe(0);
  });
});

describe("the hourly budget", () => {
  test("pure decision table", () => {
    expect(budgetDecision(0, false, 10)).toBe("push");
    expect(budgetDecision(9, false, 10)).toBe("push");
    expect(budgetDecision(10, false, 10)).toBe("mute-notice");
    expect(budgetDecision(10, true, 10)).toBe("silent");
    expect(budgetDecision(50, true, 10)).toBe("silent");
  });
  test("ten pushes, then one mute notice, then silence; the rows stay", async () => {
    for (let i = 0; i < NOW_BUDGET_PER_HOUR + 5; i++) await sendAlert(`A${i}`, "x");
    const r = rows();
    const pushed = r.filter((x) => x.sent === 1 && x.key !== MUTE_KEY);
    const mutes = r.filter((x) => x.key === MUTE_KEY);
    const held = r.filter((x) => x.sent === 0);
    expect(pushed.length).toBe(NOW_BUDGET_PER_HOUR);
    expect(mutes.length).toBe(1);
    expect(mutes[0]!.sent).toBe(1);
    expect(held.length).toBe(5);
    expect(nowPushesLastHour(db, Date.now())).toBe(NOW_BUDGET_PER_HOUR);
    expect(mutedThisHour(db, Date.now())).toBe(true);
    expect(alertsLastHour(db, Date.now())).toBe(NOW_BUDGET_PER_HOUR + 5 + 1);
  });
  test("old pushes fall out of the window", () => {
    const old = Date.now() - 2 * 3_600_000;
    for (let i = 0; i < 12; i++) markSent(db, recordAlert(db, { ts: old, level: "now", title: "old", message: "" }));
    expect(nowPushesLastHour(db, Date.now())).toBe(0);
    expect(budgetDecision(nowPushesLastHour(db, Date.now()), mutedThisHour(db, Date.now()))).toBe("push");
  });
});

describe("the digest", () => {
  test("composeDigest groups by key, counts repeats, quotes the latest first line", () => {
    const mk = (id: number, key: string | null, title: string, message: string): AlertRow => ({ id, ts: id, level: "digest", title, message, key, sent: 0 });
    const t = composeDigest([
      mk(1, "ir", "IR opportunity", "Collins is eligible\nmore"),
      mk(2, "ir", "IR opportunity", "Collins still eligible"),
      mk(3, null, "Skipped free agent", "window closed"),
    ]);
    expect(t).not.toBeNull();
    expect(t!.count).toBe(3);
    expect(t!.title).toBe("Digest: 3 alerts");
    expect(t!.message.split("\n")).toEqual(["2x IR opportunity: Collins still eligible", "Skipped free agent: window closed"]);
    expect(composeDigest([])).toBeNull();
  });
  test("sendDigest pushes once, covers muted rows too, and clears", async () => {
    await sendAlert("Quiet one", "a", { level: "digest", key: "q" });
    await sendAlert("Quiet two", "b", { level: "digest", key: "q" });
    for (let i = 0; i < NOW_BUDGET_PER_HOUR + 1; i++) await sendAlert(`Loud${i}`, "x", { key: "loud" });
    expect(pendingDigest(db).length).toBe(3); // two digest rows plus the one muted now row
    const sent = await sendDigest();
    expect(sent).not.toBeNull();
    expect(sent!.count).toBe(3);
    expect(sent!.message).toContain("2x Quiet two: b");
    expect(pendingDigest(db).length).toBe(0);
    expect(await sendDigest()).toBeNull();
  });
});
