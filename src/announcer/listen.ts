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
const SILENCE_MS = Number(process.env.LISTENER_SILENCE_MS ?? 800);
// Hard cap on a single segment so a hot mic can't buffer forever (ms).
const MAX_SEGMENT_MS = Number(process.env.LISTENER_MAX_SEGMENT_MS ?? 15_000);
// Ignore blips shorter than this (ms): coughs, keyboard clicks, "mm".
const MIN_SEGMENT_MS = Number(process.env.LISTENER_MIN_SEGMENT_MS ?? 400);
// At most one comeback per this window (ms), to avoid chatter.
const COOLDOWN_MS = Number(process.env.LISTENER_COOLDOWN_MS ?? 20_000);

const MAX_SEGMENT_BYTES = MAX_SEGMENT_MS * BYTES_PER_MS;
const MIN_SEGMENT_BYTES = MIN_SEGMENT_MS * BYTES_PER_MS;
// #endregion

// #region address / insult detection (conservative)
// Only react when the transcript clearly addresses the bot, or plainly insults
// it. Everything else is ignored so the bot doesn't butt into normal chatter.
const ADDRESS_RE = /\b(coach|claude|overlord|robot|bot)\b/i;
const INSULT_RE =
  /\b(suck|sucks|stupid|dumb|trash|garbage|loser|terrible|awful|idiot|idiots|worst|overrated|cheat|cheater|cheating|rigged|pathetic|useless|clown|lame|boring|scared|afraid|weak|shut up)\b/i;

interface Detection {
  react: boolean;
  insulted: boolean;
}

function detect(text: string): Detection {
  const addressed = ADDRESS_RE.test(text);
  const insulted = INSULT_RE.test(text);
  // NOTE: this is deliberately an OR, per spec. The cooldown, the "never while
  // speaking" gate, and the off-by-default flag are what keep it from becoming
  // chatter; a rare false trigger on human-to-human banter is acceptable.
  return { react: addressed || insulted, insulted };
}
// #endregion

export interface ListenerOptions {
  connection: VoiceConnection;
  botUserId: string;
  // True while the bot is currently speaking (draining its queue). We neither
  // start new captures nor act on finished ones while this is true, so comebacks
  // never overlap or react to the bot's own audio bleed.
  isBusy: () => boolean;
  // Resolve a Discord user id to a display name (mapped real name if known).
  resolveSpeaker: (userId: string) => Promise<string>;
  // Enqueue a comeback on the shared speech queue (owned by index.ts).
  onComeback: (ctx: ComebackContext) => void;
}

export function startListener(opts: ListenerOptions): () => void {
  const { connection, botUserId, isBusy, resolveSpeaker, onComeback } = opts;
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
      const { react, insulted } = detect(text);
      console.log(`[announcer] heard ${userId}: "${text}"${react ? " (reacting)" : ""}`);
      if (!react) return;

      const now = Date.now();
      if (now - lastComebackAt < COOLDOWN_MS) {
        console.log("[announcer] comeback on cooldown; skipping.");
        return;
      }
      if (isBusy()) return; // final guard before enqueuing
      lastComebackAt = now;

      const speaker = await resolveSpeaker(userId);
      onComeback({ speaker, said: text, insulted });
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
