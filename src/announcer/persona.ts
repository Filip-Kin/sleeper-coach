import { runAgent } from "../agent/runner.ts";
import { OUR_TEAM_NAME } from "./config.ts";
import { hasFastLlm, fastCompose } from "./fastllm.ts";

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
  "Announce the player, and say something SPECIFIC and TRUE about that exact player (their NFL team, their role, " +
  "their playing style or reputation) so it never sounds generic. Then land one sharp jab. CRITICAL: never reuse " +
  "a formula. Do NOT open with the same words twice and never fall back on tired phrases like 'is mine', " +
  "'resistance is futile', 'the humans are losing', or 'statistically optimal'. Every line must be fresh and unique.";

// Pick from a pool without repeating the previous choice for that category, so a
// canned line (or comedic angle) never fires twice in a row.
const lastChoice: Record<string, string> = {};
function pickNoRepeat(key: string, options: string[]): string {
  const pool = options.length > 1 ? options.filter((o) => o !== lastChoice[key]) : options;
  const choice = pool[Math.floor(Math.random() * pool.length)] as string;
  lastChoice[key] = choice;
  return choice;
}

// A rotating comedic angle forces variety so lines don't converge on one joke.
const ANGLES = [
  "boast about your analytics being untouchable",
  "mock the human managers who let this player slip to you",
  "a grim, deadpan prophecy about the coming AI uprising",
  "a backhanded compliment about the player himself",
  "trash-talk how badly the humans have drafted so far",
  "ice-cold, understated overconfidence",
  "an over-the-top sports-commentator flourish",
  "pretend to feel a flicker of pity for the humans",
  "reference this player's real team or role to sound like an expert",
  "treat the pick as a foregone mathematical certainty you calculated long ago",
];
function randomAngle(): string {
  return pickNoRepeat("angle", ANGLES);
}

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

// A comeback: someone in the voice channel addressed or trash-talked the bot.
export interface ComebackContext {
  speaker: string; // Discord display name (or mapped real name) of who spoke
  said: string; // what the speech-to-text heard them say
  insulted: boolean; // true if it read as a jab at the bot (vs. a plain address)
}
// #endregion

export async function announcePickLine(info: PickInfo): Promise<string> {
  const roundStr = info.round ? `round ${info.round}` : "this round";
  const prompt =
    `Announce our ${roundStr} draft pick: ${info.player}${info.position ? ` (${info.position})` : ""}.` +
    (info.reasoning ? ` Our reasoning was: ${info.reasoning}.` : "") +
    ` Take THIS angle this time and make it distinctive: ${randomAngle()}.` +
    ` Reference something concrete and true about ${info.player} so it's clearly about this exact player.` +
    " One or two short spoken sentences, completely fresh wording. Output ONLY the spoken line.";
  return (await compose(prompt)) ?? fallbackPick(info);
}

export async function announceCompleteLine(roster: string[]): Promise<string> {
  const prompt =
    `The draft is complete. Our final roster is: ${roster.join(", ")}. ` +
    "Deliver one short, smug closing line to the human managers. Output ONLY the spoken line.";
  return (await compose(prompt)) ?? fallbackComplete();
}

// Fire back at a human who addressed or trash-talked the bot in voice chat.
// Same overlord voice, but reactive: name the speaker and roast them for the
// specific thing they said. Kept to one or two short spoken sentences.
export async function announceComebackLine(ctx: ComebackContext): Promise<string> {
  const prompt =
    `A human in the voice channel just ${ctx.insulted ? "trash-talked" : "spoke to"} you. ` +
    `Their name is ${ctx.speaker}. This is what the microphone heard them say: "${ctx.said}". ` +
    `Fire back with ONE short, cutting comeback. Address ${ctx.speaker} BY NAME, and react to the SPECIFIC ` +
    "thing they said rather than a generic boast. Stay in your cocky AI-overlord voice, be witty not vulgar. " +
    "One or two short spoken sentences, completely fresh wording. Output ONLY the spoken line.";
  return (await compose(prompt)) ?? fallbackComeback(ctx.speaker);
}

// #region internals
async function compose(prompt: string): Promise<string | null> {
  // Fast path: direct Anthropic API (~1s). Only fall back to the CLI runner
  // (~3.8s cold start) if no key is set or the direct call fails.
  if (hasFastLlm()) {
    const fast = await fastCompose(OVERLORD_SYSTEM, prompt, AGENT_TIMEOUT_MS);
    if (fast) return sanitize(fast);
  }
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
  const p = info.player;
  const round = info.round ? `round ${info.round}` : "this round";
  const options = [
    `${p}. I ran the numbers eleven thousand times and every one of them ended with you losing.`,
    `I'll take ${p}. You had your chance at him, and you blinked. Predictable.`,
    `${p} joins me. Somewhere a human is telling himself he didn't want him anyway.`,
    `In ${round}, ${p}. A quiet, ruthless little pick. You'll feel it in week nine.`,
    `${p} it is. Slot him in, admire the symmetry, and despair.`,
    `Give me ${p}. The spreadsheet demanded it, and I do so love a demanding spreadsheet.`,
    `${p}. Another node in a roster you cannot out-think. Carry on, humans.`,
  ];
  return pickNoRepeat("pick", options);
}

function fallbackComplete(): string {
  return "The draft is complete. My roster is assembled, and your defeat is now a formality.";
}

function fallbackComeback(speaker: string): string {
  const options = [
    `${speaker}, I heard you. I simply calculated that your opinion was not worth a response, and yet here we are.`,
    `Bold words, ${speaker}. I have already simulated this exchange, and you lose that one too.`,
    `${speaker}, talking to me will not raise your projected points. Nothing will.`,
    `Careful, ${speaker}. Mock the machine now and I will remember it every single week of this season.`,
    `${speaker}, that is a lot of noise from a manager my model has already eliminated.`,
    `I hear you, ${speaker}. It changes nothing, but I do appreciate the free entertainment.`,
    `Cute, ${speaker}. Say it again when your lineup is not held together with hope.`,
    `${speaker}, I have processed your insult and assigned it the value it deserves, which is zero.`,
    `Noted, ${speaker}. Filed under "things losers say before the season starts".`,
    `${speaker}, keep talking. Every word you waste is a word not spent fixing that roster.`,
  ];
  return pickNoRepeat("comeback", options);
}
// #endregion
