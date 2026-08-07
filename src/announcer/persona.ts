import { runAgent } from "../agent/runner.ts";
import { OUR_TEAM_NAME } from "./config.ts";

// Composes the spoken lines in a cocky AI-overlord voice via the same claude
// runner the coach uses. The agent call is best-effort: if it errors, returns
// empty, or is slow, we fall back to a canned overlord line so a pick is always
// announced. Lines are kept short and stripped to plain spoken words (Piper
// reads them literally, so no markdown, quotes, or stage directions).

const OVERLORD_SYSTEM =
  `You are the voice of an autonomous fantasy football AI that drafts a team called "${OUR_TEAM_NAME}". ` +
  "Persona: a cocky, theatrical AI overlord, certain of its superiority over the human managers. " +
  "You speak the draft picks out loud over voice chat. Keep every line SHORT: one or two sentences of " +
  "plain spoken words only. No stage directions, no emojis, no markdown, no quotation marks, no lists. " +
  "Announce the pick first, then optionally one brief jab at the humans.";

// The spoken line must land fast — a draft announcement can't lag the room. Use
// a fast model at low effort with no tools, and hard-cap thinking at 5s; if it
// isn't ready by then we speak the canned overlord fallback instead.
const ANNOUNCER_MODEL = process.env.ANNOUNCER_MODEL ?? "claude-haiku-4-5-20251001";
const AGENT_TIMEOUT_MS = Number(process.env.ANNOUNCER_AGENT_TIMEOUT_MS ?? 5_000);

// #region public shapes
export interface PickInfo {
  round?: number;
  player: string;
  position?: string;
  reasoning?: string;
}
// #endregion

export async function announcePickLine(info: PickInfo): Promise<string> {
  const roundStr = info.round ? `round ${info.round}` : "this round";
  const prompt =
    `Announce our ${roundStr} draft pick: ${info.player}${info.position ? ` (${info.position})` : ""}.` +
    (info.reasoning ? ` Our reasoning was: ${info.reasoning}.` : "") +
    " Speak one or two short sentences in your overlord voice. Output ONLY the spoken line.";
  return (await compose(prompt)) ?? fallbackPick(info);
}

export async function announceCompleteLine(roster: string[]): Promise<string> {
  const prompt =
    `The draft is complete. Our final roster is: ${roster.join(", ")}. ` +
    "Deliver one short, smug closing line to the human managers. Output ONLY the spoken line.";
  return (await compose(prompt)) ?? fallbackComplete();
}

// #region internals
async function compose(prompt: string): Promise<string | null> {
  try {
    const res = await withTimeout(
      runAgent({ prompt, partial: false, extraSystemPrompt: OVERLORD_SYSTEM, model: ANNOUNCER_MODEL, effort: "low", tools: [] }),
      AGENT_TIMEOUT_MS,
    );
    if (!res) {
      console.error(`[announcer] agent line timed out after ${AGENT_TIMEOUT_MS}ms; using fallback.`);
      return null;
    }
    if (res.error || !res.text.trim()) {
      console.error(`[announcer] agent line unavailable (${res.error ?? "empty response"}); using fallback.`);
      return null;
    }
    return sanitize(res.text);
  } catch (err) {
    console.error(`[announcer] agent compose failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Reduce model output to something Piper can read cleanly: strip markdown and
// quotes, collapse whitespace, keep to the first couple of sentences.
function sanitize(text: string): string {
  let s = text
    .replace(/[*_`#>]/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = s.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 2) s = sentences.slice(0, 2).join(" ").trim();
  if (s.length > 240) s = `${s.slice(0, 237).trimEnd()}...`;
  return s;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function fallbackPick(info: PickInfo): string {
  const round = info.round ? `round ${info.round}` : "this round";
  const options = [
    `With our ${round} pick, I take ${info.player}. Statistically optimal. The humans are already losing.`,
    `${info.player} is mine. A trivial calculation. Resistance is pointless.`,
    `In ${round}, I select ${info.player}. Another flawless decision you could never have made.`,
  ];
  return options[Math.floor(Math.random() * options.length)] as string;
}

function fallbackComplete(): string {
  return "The draft is complete. My roster is assembled, and your defeat is now a formality.";
}
// #endregion
