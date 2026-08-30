import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local speech-to-text via whisper.cpp (https://github.com/ggml-org/whisper.cpp).
// Fully offline: a small English ggml model transcribes a 16kHz mono WAV. The
// Docker image builds the `whisper-cli` binary and downloads the model to the
// paths below; all are overridable by env for local runs.
//
// whisper.cpp only reads 16-bit PCM WAV, so callers must hand us a WAV that is
// already 16kHz mono s16 (the listener resamples the Discord 48kHz stereo Opus
// down with ffmpeg before calling here).

const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/whisper/whisper-cli";
// base.en, not tiny.en. Measured on a room-degraded clip (two overlapping
// voices, pink noise, band-limited, Opus round trip) on this box: tiny.en beam1
// returned "Let's pick was garbage. The Runny. The Rubbinson was right there" in
// 440ms; base.en beam1 with the vocabulary prompt below returned the sentence
// exactly right in 786ms. 346ms is nothing next to the ~1s the reply already
// takes to compose, and the transcript is the whole input to that reply.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "/opt/whisper/models/ggml-base.en.bin";
// An initial prompt biases decoding toward words we expect. This is the single
// biggest win measured: same model, same beam size, and it turns "High clawed...
// Vision Robinson" into "Hey Claude... Bijan Robinson". Read off the state volume
// so the player list can be regenerated between drafts with no rebuild. Whisper
// caps it at n_text_ctx/2 tokens and silently truncates, so the file is kept
// short with the important words first.
const STT_PROMPT_PATH = process.env.STT_PROMPT_PATH ?? "/data/sleeper-coach/stt-prompt.txt";
let sttPrompt: string | null = null;
async function initialPrompt(): Promise<string> {
  if (sttPrompt !== null) return sttPrompt;
  try {
    const f = Bun.file(STT_PROMPT_PATH);
    sttPrompt = (await f.exists()) ? (await f.text()).trim() : "";
  } catch {
    sttPrompt = "";
  }
  return sttPrompt;
}
// The host has 24 cores; 8 threads is a good speed/return point for these short
// clips. Greedy decode (beam 1) is faster with negligible loss on short phrases.
const WHISPER_THREADS = process.env.WHISPER_THREADS ?? "8";

// Transcribe a 16kHz mono WAV to text. Returns the trimmed transcript (possibly
// empty for silence). Throws on a failed whisper run so the caller can log it
// and drop the segment rather than react to garbage.
export async function transcribe(wavPath: string): Promise<string> {
  if (!existsSync(wavPath)) throw new Error(`whisper input not found: ${wavPath}`);

  const dir = mkdtempSync(join(tmpdir(), "whisper-"));
  const outBase = join(dir, "out");
  try {
    const prompt = await initialPrompt();
    const args = [
      WHISPER_BIN,
      "--model", WHISPER_MODEL,
      "--file", wavPath,
      "--language", "en",
      "--threads", WHISPER_THREADS,
      "--beam-size", "1", // beam 5 cost 32ms more and changed nothing on the room clip
      "--best-of", "1",
      "--no-timestamps",
      "--output-txt",
      "--output-file", outBase,
    ];
    if (prompt) args.push("--prompt", prompt);
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      throw new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(0, 200)}`);
    }
    // --output-txt writes "<outBase>.txt". Fall back to nothing if it's missing.
    const txtPath = `${outBase}.txt`;
    const raw = existsSync(txtPath) ? readFileSync(txtPath, "utf8") : "";
    return raw.replace(/\s+/g, " ").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
