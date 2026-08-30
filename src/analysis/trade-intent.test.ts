import { offerKey, gateOutgoing, IntentStore, DEFAULT_GATE, type OutgoingIntent } from "./trade-intent.ts";
import { rmSync } from "node:fs";

// Run with: bun run src/analysis/trade-intent.test.ts
let pass = 0,
  fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
};

// --- offerKey is order-independent and partner-sensitive ---
const k1 = offerKey(2, ["Josh Downs", "David Montgomery"], ["Stud RB"]);
const k2 = offerKey(2, ["david montgomery", "josh  downs"], ["stud rb"]);
const k3 = offerKey(3, ["Josh Downs", "David Montgomery"], ["Stud RB"]);
t("offerKey ignores order and casing/punctuation", k1 === k2, `${k1} vs ${k2}`);
t("offerKey distinguishes the partner", k1 !== k3);

// --- gate: the two-pass state machine ---
const now = 1_000_000_000_000;

// A non-accept verdict is never proposed.
t("surface verdict is not sent outward", gateOutgoing({ key: k1, verdict: "surface", lineupDelta: 12 }, null, now).action === "reject");
t("reject verdict is not sent outward", gateOutgoing({ key: k1, verdict: "reject", lineupDelta: -3 }, null, now).action === "reject");

// First accept with no prior: record only.
const first = gateOutgoing({ key: k1, verdict: "accept", lineupDelta: 40 }, null, now);
t("first good look records an intent", first.action === "record", first.reason);

const prior: OutgoingIntent = { key: k1, firstSeen: now, lineupDelta: 40 };

// Second accept, but too soon (same instant / under minAge): wait.
t("a too-soon second look waits", gateOutgoing({ key: k1, verdict: "accept", lineupDelta: 40 }, prior, now + 1_000).action === "wait");

// Second accept, aged into the window: send.
const sendDecision = gateOutgoing({ key: k1, verdict: "accept", lineupDelta: 40 }, prior, now + DEFAULT_GATE.minAgeMs + 1_000);
t("a separate confirming pass sends", sendDecision.action === "send", sendDecision.reason);

// A different proposal does not satisfy a prior intent for another proposal.
t("a different proposal restarts the two-pass", gateOutgoing({ key: k3, verdict: "accept", lineupDelta: 40 }, prior, now + DEFAULT_GATE.minAgeMs + 1_000).action === "record");

// A stale prior (older than maxAge) is discarded and the two-pass restarts.
t("a stale prior intent restarts rather than sends", gateOutgoing({ key: k1, verdict: "accept", lineupDelta: 40 }, prior, now + DEFAULT_GATE.maxAgeMs + 1_000).action === "record");

// --- the durable store round-trips and prunes ---
const tmp = `${process.env.SCRATCH_DIR ?? "/tmp"}/trade-intent-test-${process.pid}.json`;
rmSync(tmp, { force: true });
const store = new IntentStore(tmp);
t("empty store reads nothing", store.get(k1) === null && store.all().length === 0);
store.put(prior);
t("store persists and reads back an intent", store.get(k1)?.lineupDelta === 40);
store.put({ key: k3, firstSeen: now - DEFAULT_GATE.maxAgeMs - 5_000, lineupDelta: 10 });
t("store holds multiple intents", store.all().length === 2);
store.prune(now, DEFAULT_GATE.maxAgeMs);
t("prune drops only the stale intent", store.get(k1) !== null && store.get(k3) === null, `${store.all().length} left`);
store.delete(k1);
t("delete removes an intent", store.get(k1) === null && store.all().length === 0);
rmSync(tmp, { force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
