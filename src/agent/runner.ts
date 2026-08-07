import { existsSync } from "node:fs";
import { join } from "node:path";

// Spawns the native `claude` CLI headless and streams its stream-json events.
// Modelled on the proven spotify-dj bridge, pointed at Opus with the coach's
// tool surface. Used both by the daemon (one-shot agentic tasks) and the web
// dashboard (interactive, streamed to the browser).

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = process.env.HOME ?? "/data/sleeper-coach/config";
// The native claude install lives in HOME/.local/bin, which a fresh shell's
// PATH may not include — resolve it absolutely.
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? `${HOME}/.local/bin/claude`;
const MODEL = process.env.COACH_MODEL ?? "claude-opus-4-8";
const EFFORT = process.env.COACH_EFFORT ?? "high";
const SETTINGS = join(REPO_ROOT, "claude-settings.json");
const SYSTEM_PROMPT_PATH = join(REPO_ROOT, "system-prompt.md");
// claude derives its transcript dir from cwd, replacing "/" with "-".
const SESSION_STORE = join(HOME, ".claude", "projects", REPO_ROOT.replace(/\//g, "-"));

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunOptions {
  prompt: string;
  sessionId?: string; // resume a conversation if its transcript exists
  onEvent?: (ev: AgentEvent) => void;
  extraSystemPrompt?: string;
}

export interface RunResult {
  sessionId: string;
  text: string; // concatenated assistant text
  exitCode: number;
  error?: string; // set when the run failed (limit hit, non-zero exit, no output)
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const systemPrompt =
    (await Bun.file(SYSTEM_PROMPT_PATH).text().catch(() => "")) +
    (opts.extraSystemPrompt ? `\n\n${opts.extraSystemPrompt}` : "");

  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const canResume = existsSync(join(SESSION_STORE, `${sessionId}.jsonl`));

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", MODEL,
    "--effort", EFFORT,
    "--settings", SETTINGS,
    "--append-system-prompt", systemPrompt,
    "--tools", "Bash", "WebSearch", "WebFetch",
    canResume ? "--resume" : "--session-id",
    sessionId,
    opts.prompt,
  ];

  const child = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME },
    stdout: "pipe",
    stderr: "pipe",
  });

  let text = "";
  let resultError: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  // Drain stderr concurrently so a chatty error stream can't deadlock stdout.
  const stderrPromise = new Response(child.stderr as ReadableStream<Uint8Array>)
    .text()
    .catch(() => "");

  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev: AgentEvent;
      try {
        ev = JSON.parse(line) as AgentEvent;
      } catch {
        continue;
      }
      opts.onEvent?.(ev);
      // The final "result" event flags failures (usage limit, API error, etc.)
      // via is_error / an error subtype — capture it so callers can react.
      if (ev.type === "result") {
        const isErr = ev["is_error"] === true || /error|limit/i.test(String(ev["subtype"] ?? ""));
        if (isErr) resultError = String(ev["result"] ?? ev["subtype"] ?? "agent error").slice(0, 300);
      }
      // Accumulate assistant text for the one-shot callers. Assistant events
      // carry { message: { content: [{ type: "text", text }] } }.
      if (ev.type === "assistant") {
        const msg = ev["message"];
        const content = msg && typeof msg === "object" ? (msg as { content?: unknown }).content : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
              const t = (block as { text?: unknown }).text;
              if (typeof t === "string") text += t;
            }
          }
        }
      }
    }
  }

  const exitCode = await child.exited;
  const stderr = (await stderrPromise).trim();
  let error: string | undefined;
  if (resultError) error = resultError;
  else if (exitCode !== 0) error = stderr.slice(0, 300) || `claude exited ${exitCode}`;
  else if (!text.trim()) error = stderr.slice(0, 300) || "no output from agent";
  return { sessionId, text: text.trim(), exitCode, error };
}
