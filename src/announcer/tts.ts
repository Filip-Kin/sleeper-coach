import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local text-to-speech via Piper (https://github.com/rhasspy/piper). Piper is a
// small, fast, fully offline neural TTS. We feed the text on stdin and it writes
// a WAV file, which the voice layer streams into Discord. All paths default to
// the locations the Docker image installs to, overridable by env for local runs.

const PIPER_BIN = process.env.PIPER_BIN ?? "/opt/piper/piper";
const PIPER_MODEL = process.env.PIPER_MODEL ?? "/opt/piper/voices/en_US-lessac-medium.onnx";
const PIPER_ESPEAK_DATA = process.env.PIPER_ESPEAK_DATA ?? "/opt/piper/espeak-ng-data";
const PIPER_LIB_DIR = process.env.PIPER_LIB_DIR ?? "/opt/piper";

export interface Speech {
  path: string; // the generated WAV
  cleanup: () => void; // remove the temp dir once played
}

// Synthesise `text` to a WAV file. Throws on failure so the caller can log it
// and skip the line rather than hang the queue.
export async function synthesize(text: string): Promise<Speech> {
  const dir = mkdtempSync(join(tmpdir(), "announcer-"));
  const wav = join(dir, "line.wav");

  const proc = Bun.spawn(
    [PIPER_BIN, "--model", PIPER_MODEL, "--espeak_data", PIPER_ESPEAK_DATA, "--output_file", wav],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Piper's bundled shared libraries sit beside the binary.
      env: { ...process.env, LD_LIBRARY_PATH: `${PIPER_LIB_DIR}:${process.env.LD_LIBRARY_PATH ?? ""}` },
    },
  );
  proc.stdin.write(text);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`piper exited ${code}: ${stderr.trim().slice(0, 200)}`);
  }

  return {
    path: wav,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
