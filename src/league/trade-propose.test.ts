import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { pairKey, onCooldown, pitchText, MAX_OPEN_OFFERS, REPROPOSE_COOLDOWN_DAYS } from "./trade-propose.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE trade_proposals (pair_key TEXT NOT NULL, manager_id TEXT NOT NULL,
    transaction_id TEXT, at INTEGER NOT NULL, why TEXT)`);
  return d;
}

test("a pair key ignores the order players are listed in", () => {
  // Otherwise the same swap re-sends because the arrays came back sorted
  // differently, which is exactly how a bot starts nagging someone.
  expect(pairKey("2", ["A", "B"], ["C"])).toBe(pairKey("2", ["B", "A"], ["C"]));
});

test("a pair key is per manager, so the same swap can go to someone else", () => {
  expect(pairKey("2", ["A"], ["B"])).not.toBe(pairKey("4", ["A"], ["B"]));
});

test("a recently offered pair is on cooldown", () => {
  const d = db();
  const now = 1_700_000_000_000;
  const key = pairKey("2", ["A"], ["B"]);
  d.run("INSERT INTO trade_proposals (pair_key, manager_id, at) VALUES (?, ?, ?)", [key, "2", now - 86_400_000]);
  expect(onCooldown(d, key, now)).toBe(true);
});

test("cooldown expires, so a fair offer can come back later in the season", () => {
  const d = db();
  const now = 1_700_000_000_000;
  const key = pairKey("2", ["A"], ["B"]);
  d.run("INSERT INTO trade_proposals (pair_key, manager_id, at) VALUES (?, ?, ?)",
    [key, "2", now - (REPROPOSE_COOLDOWN_DAYS + 1) * 86_400_000]);
  expect(onCooldown(d, key, now)).toBe(false);
});

test("an unseen pair is never on cooldown", () => {
  expect(onCooldown(db(), pairKey("2", ["A"], ["B"]), 1_700_000_000_000)).toBe(false);
});

test("the outstanding-offer cap is small enough not to look like spam", () => {
  expect(MAX_OPEN_OFFERS).toBeLessThanOrEqual(2);
});

test("the pitch leads with THEIR gain, which is the reason to say yes", () => {
  const p = {
    managerId: "2", teamName: "roster 2",
    offer: { receive: [{ name: "Bijan Robinson", position: "RB", points: 0 }], give: [{ name: "Rome Odunze", position: "WR", points: 0 }] },
    ourGain: 8.2, theirGain: 5.4, edge: 0, byeRelief: 0, score: 8.2, why: "",
  };
  const t = pitchText(p as never);
  expect(t).toContain("+5.4 to your starting lineup");
  expect(t).toContain("Rome Odunze");
  expect(t).toContain("Bijan Robinson");
  expect(t).toContain("No hard feelings");
});

test("the brief renders our outbound offers so the coach cannot deny one", async () => {
  const { briefText } = await import("./trade-propose.ts");
  const text = briefText({
    surplus: [], thin: [], askFor: [], deals: [], lastOffer: null,
    pendingFromUs: [{ give: ["Parker Washington"], get: ["Mark Andrews"] }],
  });
  expect(text).toContain("I give Parker Washington, I get Mark Andrews");
  expect(text).toContain("Never deny an offer you have made");
});
