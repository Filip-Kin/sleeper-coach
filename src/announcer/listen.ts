import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndBehaviorType } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import { opus } from "prism-media";
import { transcribe } from "./whisper.ts";
import type { ComebackContext } from "./persona.ts";

// The LISTEN + COMEBACK phase. Subscribes to each speaking user's Opus stream on
// the existing voice connection, decodes to PCM, segments on end-of-speech,
// transcribes locally with whisper.cpp, and (only when the speech clearly
// addresses or trash-talks the bot) hands a comeback context back to the caller
// to enqueue on the SAME speech queue the announcements use. Nothing here plays
// audio directly: comebacks go through the caller's queue so a comeback can
// never talk over a pick announcement.
//
// This whole module is inert unless LISTENER_ENABLED is on (the caller decides).

// #region tunables (env-overridable)
// Discord voice is always 48kHz stereo 16-bit PCM once decoded.
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1_000; // 192

// End a speech segment after this much silence (ms).
const SILENCE_MS = Number(process.env.LISTENER_SILENCE_MS ?? 500);
// Hard cap on a single segment so a hot mic can't buffer forever (ms).
const MAX_SEGMENT_MS = Number(process.env.LISTENER_MAX_SEGMENT_MS ?? 15_000);
// Ignore blips shorter than this (ms): coughs, keyboard clicks, "mm".
const MIN_SEGMENT_MS = Number(process.env.LISTENER_MIN_SEGMENT_MS ?? 400);
// At most one comeback per this window (ms), to avoid chatter.
// Addressed-only is itself the throttle, so this only needs to stop a follow-up
// window from double-firing on overlapping segments. An explicit name always
// bypasses it: being unable to ask it two questions in a row is worse than the
// occasional extra line.
const COOLDOWN_MS = Number(process.env.LISTENER_COOLDOWN_MS ?? 10_000);
// Rolling window of recent transcribed segments, so a heckle split across two
// silence-separated segments (e.g. "coach claude" ... "you suck") is detected as
// one line. We run detection on the JOINED recent text and clear it after a hit.
const WINDOW_MS = Number(process.env.LISTENER_WINDOW_MS ?? 8_000);
const WINDOW_MAX = Number(process.env.LISTENER_WINDOW_MAX ?? 4);
const recentSegments: { text: string; at: number }[] = [];

const MAX_SEGMENT_BYTES = MAX_SEGMENT_MS * BYTES_PER_MS;
const MIN_SEGMENT_BYTES = MIN_SEGMENT_MS * BYTES_PER_MS;
// #endregion

// #region address / insult detection (conservative)
// Only react when the transcript clearly addresses the bot, or plainly insults
// it. Everything else is ignored so the bot doesn't butt into normal chatter.
// Include common tiny.en mishears of "claude" so a garbled address still
// triggers. These are OBSERVED, not guessed: "juan" came out of a live room on
// 2026-08-30 ("Hey, Juan, drop admin table") and was silently ignored. None of
// them collide with a manager's name in this league (Ian, Owen, Chris, Matt,
// Kevin, Nate, Michel, Filip), which is what makes them safe to add.
const ADDRESS_RE = /\b(coach|claude|claud|clawed|cloud|clod|juan|clyde|claudia|cloudy|todd|clod|cody)\b|\b(overlord|robot|bot)\b/i;
// Once it has just answered someone, the NEXT thing said in the room is almost
// always still aimed at it, and people stop repeating the name: "Say, why do you
// think you need it?" was ignored for exactly this reason. So a reply opens a
// short follow-up window in which a second-person question also counts as
// addressed. Bounded by the window and by needing a real address first, so it
// cannot turn into constant chatter.
const FOLLOWUP_MS = Number(process.env.LISTENER_FOLLOWUP_MS ?? 20_000);
// Second person is not enough on its own: "I wasn't rebuilding a whole plate,
// you're cut up" is two humans talking and matched on a bare "you". A follow-up
// has to actually look like a question put TO it, so require second person plus
// either a question mark or an interrogative opener. Whisper punctuates questions
// reliably enough for this to work.
const SECOND_PERSON_RE = /\b(you|your|yours|you're|youre)\b/i;
const QUESTION_SHAPE_RE = /\?|^\s*(what|why|how|who|when|where|which|do|does|did|can|could|will|would|are|is|was|should|any)\b/i;
function looksLikeAQuestionToUs(text: string): boolean {
  return SECOND_PERSON_RE.test(text) && QUESTION_SHAPE_RE.test(text);
}
// Two tiers, because one broad list made it chatty in a real room. On a
// 56-utterance sample the STRONG words never misfired once, and every false
// trigger came from the mild tier: it fired back at "it was so kind of a hell of
// a story" because "hell" was in the list.
//
// Strong words are unambiguous heckling and fire on their own.
const STRONG_INSULT_RE =
  /\b(sucks?|sucked|stupid|trash|dogshit|garbage|loser|terrible|awful|horrible|horrendous|idiots?|overrated|overhyped|cheat|cheater|cheating|rigged|pathetic|useless|worthless|clown|shitty|crappy|asshole|fucking|fucked|goddamn|washed|bricked|dumbass|clanker|clankers|clunker|clinker|planker|flanker|clank|clanka|shut up)\b/i;
// Mild words are ordinary speech as often as they are insults ("a hell of a
// story", "he was good but bad in the red zone"), so they only count when the
// line is actually pointed at US.
const MILD_INSULT_RE =
  /\b(dumb|worst|lame|boring|scared|afraid|weak|shit|crap|ass|fuck|damn|hell|bum|choke|choked|broken|broke|joke|bust|busted|wack|whack|blows|blow|mid|bad|boo|hoe|hoes)\b/i;
// Multi-word heckles the single-word lists can't catch. These are already
// directed by construction, so they count as strong.
const INSULT_PHRASE_RE = /(half the time|does\s?n'?t work|do\s?n'?t work|barely work|so bad|bad pick|garbage pick|piece of|pieces of)/i;
// Praise, so it can graciously (smugly) accept a compliment too.
const PRAISE_RE =
  /\b(great|nice|love|amazing|genius|brilliant|smart|clever|awesome|incredible|beast|goat|excellent|impressive|respect|king|legend|based|cracked|good (pick|call|choice|job|pull)|well done|nailed it|w pick|dub)\b/i;

interface Detection {
  react: boolean;
  insulted: boolean;
  praised: boolean;
}

function detect(text: string, inFollowUp = false): Detection {
  const named = ADDRESS_RE.test(text);
  const addressed = named || (inFollowUp && looksLikeAQuestionToUs(text));

  // IT ONLY SPEAKS WHEN SPOKEN TO. Overheard trash talk used to trigger it on
  // its own, and in a real room that made it interject constantly: an eight
  // person draft is wall to wall profanity and complaining that has nothing to
  // do with the bot. The insult and praise lists survive only to pick the TONE
  // and the face for a reply we were already going to make.
  const insulted = STRONG_INSULT_RE.test(text) || INSULT_PHRASE_RE.test(text) || MILD_INSULT_RE.test(text);
  const praised = !insulted && PRAISE_RE.test(text);
  return { react: addressed, insulted, praised };
}
// #endregion

export interface ListenerOptions {
  connection: VoiceConnection;
  botUserId: string;
  // True while the bot is currently speaking (draining its queue). We neither
  // start new captures nor act on finished ones while this is true, so comebacks
  // never overlap or react to the bot's own audio bleed.
  isBusy: () => boolean;
  // True for a short window after WE announced a pick. Trash talk in that window
  // is obviously about the pick, so it is the one time overheard heckling is
  // worth answering without being addressed by name.
  justPicked?: () => boolean;
  // Resolve a Discord user id to a display name (mapped real name if known).
  resolveSpeaker: (userId: string) => Promise<string>;
  // Enqueue a comeback on the shared speech queue (owned by index.ts).
  onComeback: (ctx: ComebackContext) => void;
}

export function startListener(opts: ListenerOptions): () => void {
  const { connection, botUserId, isBusy, resolveSpeaker, onComeback } = opts;
  const justPicked = opts.justPicked ?? ((): boolean => false);
  const receiver = connection.receiver;

  let stopped = false;
  let lastComebackAt = 0;
  // Users we are currently capturing, so a repeated "start" doesn't double-subscribe.
  const capturing = new Set<string>();

  function onSpeakingStart(userId: string): void {
    if (stopped) return;
    if (userId === botUserId) return; // never react to ourselves
    if (isBusy()) return; // don't listen while we're talking
    if (capturing.has(userId)) return; // already capturing this speaker

    capturing.add(userId);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      capturing.delete(userId);
      try {
        opusStream.destroy();
      } catch {
        // already gone
      }
      void handleSegment(userId, chunks, bytes);
    };

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= MAX_SEGMENT_BYTES) finish(); // hard cap: stop early
    });
    decoder.on("end", finish);
    decoder.on("error", (err: Error) => {
      console.error(`[announcer] opus decode error for ${userId}: ${err.message}`);
      finish();
    });
    opusStream.on("error", (err: Error) => {
      console.error(`[announcer] receive stream error for ${userId}: ${err.message}`);
      finish();
    });

    opusStream.pipe(decoder);
  }

  async function handleSegment(userId: string, chunks: Buffer[], bytes: number): Promise<void> {
    if (stopped) return;
    if (bytes < MIN_SEGMENT_BYTES) return; // too short to be speech
    // If we started talking while this was being captured, drop it: we won't
    // talk over ourselves, and the tail end is likely our own audio anyway.
    if (isBusy()) return;

    let wav: { path: string; cleanup: () => void } | null = null;
    try {
      wav = await pcmToWav(Buffer.concat(chunks, bytes));
      const text = await transcribe(wav.path);
      if (!text) return;

      // Add to the rolling window and detect on the JOINED recent text, so a
      // heckle spread across segment boundaries still triggers.
      const now = Date.now();
      recentSegments.push({ text, at: now });
      while (recentSegments.length > WINDOW_MAX) recentSegments.shift();
      while (recentSegments.length && now - recentSegments[0]!.at > WINDOW_MS) recentSegments.shift();
      const combined = recentSegments.map((s) => s.text).join(" ").trim();

      // A reply opens the follow-up window; see FOLLOWUP_MS above.
      const inFollowUp = lastComebackAt > 0 && now - lastComebackAt < FOLLOWUP_MS;
      const { react, insulted, praised } = detect(combined, inFollowUp);
      // An explicit name always gets an answer. Everything else is rate limited,
      // which is the difference between a bot you can talk to and one that
      // interjects.
      const bypassCooldown = ADDRESS_RE.test(combined);
      // The pick-heckle window: unaddressed trash talk counts, but only right
      // after we picked, when it can only be about us.
      const heckle = !react && insulted && justPicked();
      const why = ADDRESS_RE.test(combined) ? "named" : react ? "follow-up" : heckle ? "heckle after our pick" : "";
      console.log(`[announcer] heard ${userId}: "${text}"${why ? ` (reacting: ${why})` : ""}`);
      if (!react && !heckle) return;
      if (!bypassCooldown && now - lastComebackAt < COOLDOWN_MS) {
        console.log("[announcer] comeback on cooldown; skipping.");
        return;
      }
      if (isBusy()) return; // final guard before enqueuing
      lastComebackAt = now;
      // Clear the window so the same words don't re-trigger as new segments land.
      recentSegments.length = 0;

      const speaker = await resolveSpeaker(userId);
      onComeback({ speaker, said: combined, insulted, praised });
    } catch (err) {
      console.error(`[announcer] listen pipeline failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      wav?.cleanup();
    }
  }

  receiver.speaking.on("start", onSpeakingStart);

  console.log(`[announcer] listener active (silence ${SILENCE_MS}ms, cap ${MAX_SEGMENT_MS}ms, cooldown ${COOLDOWN_MS}ms).`);

  return () => {
    stopped = true;
    receiver.speaking.off("start", onSpeakingStart);
    for (const userId of capturing) {
      const sub = receiver.subscriptions.get(userId);
      try {
        sub?.destroy();
      } catch {
        // already gone
      }
    }
    capturing.clear();
  };
}

// #region pcm -> wav
// whisper.cpp wants 16kHz mono 16-bit WAV; the decoded Discord audio is 48kHz
// stereo. Resample with ffmpeg (already in the image), reading raw s16le from
// stdin and writing a WAV to a temp file the caller cleans up.
async function pcmToWav(pcm: Buffer): Promise<{ path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "listen-"));
  const wav = join(dir, "seg.wav");
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "pipe:0",
      "-ar", "16000", "-ac", "1",
      "-y", wav,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(pcm);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    cleanup();
    throw new Error(`ffmpeg resample exited ${code}: ${stderr.trim().slice(0, 200)}`);
  }
  return { path: wav, cleanup };
}
// #endregion
