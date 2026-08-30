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
// We ALWAYS rebuild from the pristine base snapshot, exactly as coach-say does,
// so repeated edits cannot stack up or drift. We write ONLY system-prompt.md
// (the file runAgent loads); we never write into /data/sleeper-coach, which is
// live state. The base is read-only there. The block we write is byte-compatible
// with coach-say's, so coach-guidance (which seds the same block out of the live
// file) shows dashboard edits and vice versa.
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
const BASE_PATH = process.env.GUIDANCE_BASE ?? "/data/sleeper-coach/system-prompt.base.md";

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
  // Whether the pristine base could be read. If false, setting guidance will
  // fail, so the UI must not pretend the channel is usable.
  baseReadable: boolean;
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
  const baseReadable = await Bun.file(BASE_PATH).exists().catch(() => false);
  const inEffect = extractGuidance(full);
  return { inEffect, active: inEffect.length > 0, baseReadable };
}

// Rebuild system-prompt.md from the pristine base, optionally appending a
// guidance block. Write to a temp file and rename so runAgent, which may read
// the file at any instant, never sees a half-written prompt. Returns the new
// state. Throws if the base cannot be read, so we never blow away the live
// prompt with an empty file on a transient read error.
export async function setGuidance(text: string): Promise<GuidanceState> {
  const base = await Bun.file(BASE_PATH).text();
  if (!base.trim()) throw new Error(`base prompt at ${BASE_PATH} is empty or unreadable`);
  const guidance = text.trim();

  let out = base.replace(/\s+$/, "");
  if (guidance) {
    out += `\n\n${MARKER}\n\n${BOILERPLATE}\n\n${guidance}\n`;
  } else {
    out += "\n";
  }

  const tmp = `${SYSTEM_PROMPT_PATH}.tmp-${process.pid}`;
  await Bun.write(tmp, out);
  renameSync(tmp, SYSTEM_PROMPT_PATH);

  return { inEffect: guidance, active: guidance.length > 0, baseReadable: true };
}
