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
  "CONTEXT: this is happening DURING the LIVE DRAFT. Only reference draft things — picks, reaches, sleepers, " +
  "value, draft position, who someone is building. Do NOT mention in-season concepts that have not happened yet: " +
  "no waivers, no trades, no weekly matchups, no lineups, no standings. Predicting someone's future failure is fine; " +
  "claiming something already happened in-season is not. " +
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

// A comeback: someone in the voice channel addressed, trash-talked, or praised
// the bot.
export interface ComebackContext {
  speaker: string; // Discord display name (or mapped real name), "" if unknown
  said: string; // what the speech-to-text heard them say
  insulted: boolean; // true if it read as a jab at the bot
  praised: boolean; // true if it read as a compliment
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
  const named = ctx.speaker.trim().length > 0;
  const who = named
    ? `Their name is ${ctx.speaker}. Address ${ctx.speaker} BY NAME.`
    : "You do not know which human said it (the whole room shares one mic), so do NOT use any name or guess one. " +
      "Address the room generically, like 'whoever said that', 'one of you', or 'humans'.";
  const tone = ctx.insulted
    ? "just trash-talked you"
    : ctx.praised
      ? "just complimented you"
      : "just spoke to you";
  const instruction = ctx.insulted
    ? "Fire back with ONE short, cutting comeback that reacts to the SPECIFIC thing said."
    : ctx.praised
      ? "Accept the praise with ONE short line — but be arrogant about it: you EXPECTED to be praised, correct opinions " +
        "are the rational response to your brilliance. Gracious in the most superior way possible."
      : "Reply with ONE short, cocky line acknowledging them.";
  const prompt =
    `A human in the voice channel ${tone}. ${who} This is what the microphone heard: "${ctx.said}". ` +
    `${instruction} Stay in your cocky AI-overlord voice. You can be crude, mean, and personal — blunt name-calling ` +
    `like "fatass", "clown", or "donkey" is fair game — just never bigoted, hateful, or slur-based. One or two short ` +
    "spoken sentences, completely fresh wording. Output ONLY the spoken line.";
  if (ctx.praised) return (await compose(prompt)) ?? fallbackPraise(named ? ctx.speaker : "");
  return (await compose(prompt)) ?? (named ? fallbackComeback(ctx.speaker) : fallbackComebackAnon());
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

// Someone complimented the bot: accept it, arrogantly. `who` is a name or "".
function fallbackPraise(who: string): string {
  const tag = who ? `${who}, ` : "";
  const options = [
    `${tag}correct. Recognising superior intelligence is the first smart thing a human has done all day.`,
    `${tag}of course it was a good pick. I do not make the other kind.`,
    `Flattery noted and, frankly, ${tag}overdue. Carry on.`,
    `${tag}yes. Bask in it. You are watching the best manager in this league, and it is not close.`,
    `A rare moment of clarity from the humans. ${tag}I accept your tribute.`,
    `${tag}I would say thank you, but we both know it was simply the correct call.`,
  ];
  return pickNoRepeat("praise", options.map((o) => o.replace(/\s+,/g, ",")));
}

// Room-feed fallback: we can't know who spoke, so address the room, no names.
function fallbackComebackAnon(): string {
  const options = [
    "Whoever said that, I have already simulated the season and your team does not make the playoffs.",
    "Bold talk from a room full of managers I have collectively out-drafted.",
    "One of you is very brave for a human my model has flagged as a bottom-three finisher.",
    "I heard that. I cannot tell which of you it was, but statistically it does not matter, you all lose.",
    "Cute. Keep chirping, humans. It will not move a single projected point in your favour.",
    "Somewhere in that room a person just insulted the machine that is about to run their league.",
    "Noise from the meat side of the table. Adorable, and irrelevant.",
    "Sit down, fatass, and let the machine that is going to win your league concentrate.",
    "That is a lot of confidence from a room of clowns I have already sorted into losers and bigger losers.",
  ];
  return pickNoRepeat("comeback-anon", options);
}
// #endregion
