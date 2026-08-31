import { test, expect, beforeEach, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests for the live-guidance channel (src/web/guidance.ts). It is pure file
// manipulation, it writes into a live container mid-draft, and a mistake in it
// (blanking the prompt, or baking stale guidance into the base) is invisible from
// the outside, so it is exactly the piece that must be tested. Everything runs
// against temp files via the SYSTEM_PROMPT_PATH and GUIDANCE_BASE overrides, so no
// real prompt or state file is ever touched. GUIDANCE_BASE is set, which makes the
// base resolution exclusive to it (no fall-through to /data or the repo base), so
// these are deterministic even on a box where those really exist.

const dir = mkdtempSync(join(tmpdir(), "guidance-test-"));
const BASE = join(dir, "system-prompt.base.md");
const SP = join(dir, "system-prompt.md");
process.env.GUIDANCE_BASE = BASE;
process.env.SYSTEM_PROMPT_PATH = SP;

const BASE_TEXT = "# You are the coach\n\nBase strategy body.\n";
const MARKER = "## LIVE GUIDANCE FROM YOUR MANAGER";
const BOILERPLATE =
  "Written by your manager DURING this draft. It overrides the general\n" +
  "strategy guidance you were given wherever they conflict. Follow it unless\n" +
  "doing so would leave a mandatory starting slot (QB, TE, K, DEF) unfilled.";
// Exactly what coach-say writes for a given guidance, for the byte-identity check.
const coachSay = (g: string) => `${BASE_TEXT}\n\n${MARKER}\n\n${BOILERPLATE}\n\n${g}\n`;

// Import guidance.ts in beforeAll, not at top level: guidance.ts reads
// GUIDANCE_BASE and SYSTEM_PROMPT_PATH at module load, so the env (set above) must
// be in place first, and doing it behind a top-level await would register the
// test() calls too late to be discovered when bun collects several test files at
// once. beforeAll runs after the env is set and before any test.
type GuidanceModule = typeof import("./guidance.ts");
let readGuidanceState: GuidanceModule["readGuidanceState"];
let setGuidance: GuidanceModule["setGuidance"];
beforeAll(async () => {
  ({ readGuidanceState, setGuidance } = await import("./guidance.ts"));
});

const noTmp = () => readdirSync(dir).filter((f) => f.includes(".tmp"));

beforeEach(() => {
  writeFileSync(BASE, BASE_TEXT);
  writeFileSync(SP, BASE_TEXT);
});

test("set then get round-trips the exact text typed", async () => {
  const typed = "take receivers now, we have enough RBs";
  const set = await setGuidance(typed);
  expect(set).toEqual({ inEffect: typed, active: true, baseReadable: true });
  const got = await readGuidanceState();
  expect(got.inEffect).toBe(typed);
  expect(got.active).toBe(true);
  expect(got.baseReadable).toBe(true);
});

test("setting twice does not stack and is byte-identical to coach-say", async () => {
  await setGuidance("first guidance");
  await setGuidance("second guidance");
  const sp = readFileSync(SP, "utf8");
  expect((sp.match(/## LIVE GUIDANCE FROM YOUR MANAGER/g) ?? []).length).toBe(1);
  expect(sp).toBe(coachSay("second guidance"));
});

test("clearing removes the block and leaves the base file unchanged", async () => {
  await setGuidance("temporary guidance");
  await setGuidance("");
  expect(readFileSync(SP, "utf8")).toBe(BASE_TEXT); // coach-say clear = base verbatim
  expect(readFileSync(BASE, "utf8")).toBe(BASE_TEXT); // base is never written
  const got = await readGuidanceState();
  expect(got.active).toBe(false);
  expect(got.inEffect).toBe("");
});

test("a missing base is refused and never blanks the live prompt", async () => {
  rmSync(BASE);
  const before = readFileSync(SP, "utf8");
  await expect(setGuidance("should not apply")).rejects.toThrow();
  expect(readFileSync(SP, "utf8")).toBe(before); // live prompt untouched
  const got = await readGuidanceState();
  expect(got.baseReadable).toBe(false);
  expect(got.reason).toBeTruthy();
});

test("a base that already carries the guidance marker is refused, not stripped", async () => {
  // If this were ever snapshotted as a base, every future rebuild would bake the
  // stale guidance in permanently and invisibly. It must be a hard refusal.
  writeFileSync(BASE, coachSay("stale baked-in guidance"));
  await expect(setGuidance("fresh guidance")).rejects.toThrow(/already contain|refus/i);
  const got = await readGuidanceState();
  expect(got.baseReadable).toBe(false);
  expect(got.reason).toMatch(/already contain/i);
});

test("the atomic write leaves no .tmp files behind, on success or failure", async () => {
  await setGuidance("alpha");
  await setGuidance("");
  expect(noTmp()).toEqual([]); // clean after successful writes
  rmSync(BASE);
  await expect(setGuidance("beta")).rejects.toThrow();
  expect(noTmp()).toEqual([]); // clean after a failed write too
});
