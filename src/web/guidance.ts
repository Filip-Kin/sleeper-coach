import { renameSync } from "node:fs";

// Live guidance to the draft agent, written from the dashboard.
//
// Problem 1 from the 30 Aug 2026 draft: the dashboard's feedback box streamed
// the agent's reasoning but typing into it did NOTHING to the running draft.
// During a draft the engine (src/draft/run.ts) owns the plan loop, so an
// interactive /api/chat call is a separate conversation that never touches the
// pick. What actually worked mid-draft was the shell tool ~/.local/bin/coach-say,
// which rewrites the LIVE GUIDANCE block in system-prompt.md inside the running
// container. runAgent re-reads system-prompt.md on EVERY call and passes it as
// --append-system-prompt, so an edit reaches the planning agent within one plan
// refresh (about 20 seconds). This module makes the dashboard write through that
// same mechanism.
//
// We ALWAYS rebuild from a pristine base snapshot, exactly as coach-say does, so
// repeated edits cannot stack up or drift. We write ONLY system-prompt.md (the
// file runAgent loads); we never write into /data/sleeper-coach, which is live
// state. The block we write is byte-compatible with coach-say's, so
// coach-guidance (which seds the same block out of the live file) shows dashboard
// edits and vice versa.
//
// Honesty, and it cost us a pick on 30 Aug: this reaches the agent on its NEXT
// plan refresh, not instantly. It cannot change a pick already on the clock, and
// when the plan went 116s stale the engine fell through to the raw value board
// where guidance has no effect at all. The UI says so plainly.

// runAgent reads REPO_ROOT/system-prompt.md (see src/agent/runner.ts). From
// src/web/, "../.." is that same REPO_ROOT (/app in the container). Overridable
// for tests so a smoke test never clobbers the committed prompt.
const SYSTEM_PROMPT_PATH =
  process.env.SYSTEM_PROMPT_PATH ?? new URL("../../system-prompt.md", import.meta.url).pathname;

// The pristine base every rebuild starts from, so guidance can never stack.
//
// Resolution order, so the channel self-heals on a fresh machine WITHOUT ever
// writing to live state:
//   1. GUIDANCE_BASE env, if set (tests, or an explicit override).
//   2. /data/sleeper-coach/system-prompt.base.md, the hand-made snapshot the live
//      box and coach-say share, so on that box we rebuild from the exact same base.
//   3. system-prompt.base.md committed in the repo, which ships inside the image,
//      so a fresh Coolify deploy or any other machine has a working base with no
//      manual step. This is the fix for the base living only on one machine by
//      accident: rather than SEEDING a file into /data (forbidden: that is live
//      state), we commit the base to git and fall back to it.
const DATA_BASE = "/data/sleeper-coach/system-prompt.base.md";
const REPO_BASE = new URL("../../system-prompt.base.md", import.meta.url).pathname;
const ENV_BASE = process.env.GUIDANCE_BASE;

// The exact marker and boilerplate coach-say writes, kept byte-identical so the
// two tools are interchangeable and coach-guidance's sed still finds the block.
const MARKER = "## LIVE GUIDANCE FROM YOUR MANAGER";
const BOILERPLATE =
  "Written by your manager DURING this draft. It overrides the general\n" +
  "strategy guidance you were given wherever they conflict. Follow it unless\n" +
  "doing so would leave a mandatory starting slot (QB, TE, K, DEF) unfilled.";

export interface GuidanceState {
  // The guidance text currently in the live system-prompt.md, or "" if none.
  inEffect: string;
  // True when the live file actually carries a guidance block right now.
  active: boolean;
  // Whether a usable pristine base could be resolved. If false, setting guidance
  // will fail, so the UI must not pretend the channel is usable.
  baseReadable: boolean;
  // When baseReadable is false, a short human reason the UI can show verbatim so
  // the operator knows WHY the channel is dead instead of guessing.
  reason?: string;
}

interface ResolvedBase {
  text?: string; // present only when a usable, un-poisoned base was read
  reason?: string; // present only on failure, ready for the UI
}

// Find and read a usable pristine base. Refuses a base that already carries the
// guidance marker: rebuilding from an already-appended prompt would bake that
// stale guidance in permanently, invisibly, on every future edit. That is the
// single worst failure this file can have, so it is a hard refusal, not a strip.
async function resolveBase(): Promise<ResolvedBase> {
  // An explicit GUIDANCE_BASE override is authoritative and exclusive: it does not
  // silently fall back to the default chain (and it keeps tests deterministic on a
  // box where the /data and repo bases both really exist).
  const candidates = ENV_BASE ? [ENV_BASE] : [DATA_BASE, REPO_BASE];
  let sawPath = false;
  for (const path of candidates) {
    const file = Bun.file(path);
    if (!(await file.exists().catch(() => false))) continue;
    sawPath = true;
    const text = await file.text().catch(() => "");
    if (!text.trim()) continue; // empty/unreadable — try the next candidate
    if (text.includes(MARKER)) {
      // Poisoned base. Do NOT fall through to another candidate and do NOT strip
      // it: refuse loudly so the operator fixes the base rather than silently
      // baking guidance in forever.
      return { reason: `base at ${path} already contains a guidance block; refusing to use it as a base (it would bake that guidance in permanently). Restore a clean base.` };
    }
    return { text };
  }
  return {
    reason: sawPath
      ? "no usable base prompt found (every candidate was empty)."
      : "no base prompt found. Expected system-prompt.base.md in the repo or on the state volume.",
  };
}

// Pull the raw guidance text back out of the live system-prompt.md. We strip our
// own marker and boilerplate so what returns is exactly what was typed, ready to
// pre-fill the edit box. Uses lastIndexOf so a stray marker in the base (there
// should be none) can never shadow the appended block.
function extractGuidance(fullPrompt: string): string {
  const idx = fullPrompt.lastIndexOf(MARKER);
  if (idx === -1) return "";
  let after = fullPrompt.slice(idx + MARKER.length);
  const bIdx = after.indexOf(BOILERPLATE);
  if (bIdx !== -1) after = after.slice(bIdx + BOILERPLATE.length);
  return after.trim();
}

export async function readGuidanceState(): Promise<GuidanceState> {
  const full = await Bun.file(SYSTEM_PROMPT_PATH).text().catch(() => "");
  const base = await resolveBase();
  const inEffect = extractGuidance(full);
  return {
    inEffect,
    active: inEffect.length > 0,
    baseReadable: base.text !== undefined,
    ...(base.text === undefined ? { reason: base.reason } : {}),
  };
}

// Rebuild system-prompt.md from the pristine base, optionally appending a
// guidance block. Write to a temp file and rename so runAgent, which may read the
// file at any instant, never sees a half-written prompt. On any failure the temp
// file is removed so no .tmp litter is left behind, and the live prompt is left
// untouched. Throws (never blanks the prompt) when no usable base can be resolved.
export async function setGuidance(text: string): Promise<GuidanceState> {
  const base = await resolveBase();
  if (base.text === undefined) throw new Error(base.reason ?? "no usable base prompt");
  const guidance = text.trim();

  // Byte-identical to coach-say: base verbatim, then the block. coach-say cats the
  // base unchanged and appends "\n\n## ...", and with empty guidance it is the base
  // alone. The base is immutable and read fresh every call, so a rebuild can never
  // stack a second block regardless of what was in the live prompt before.
  const out = guidance
    ? `${base.text}\n\n${MARKER}\n\n${BOILERPLATE}\n\n${guidance}\n`
    : base.text;

  const tmp = `${SYSTEM_PROMPT_PATH}.tmp-${process.pid}`;
  try {
    await Bun.write(tmp, out);
    renameSync(tmp, SYSTEM_PROMPT_PATH);
  } catch (err) {
    await Bun.file(tmp).delete().catch(() => {}); // no litter if the rename failed
    throw err;
  }

  return { inEffect: guidance, active: guidance.length > 0, baseReadable: true };
}
