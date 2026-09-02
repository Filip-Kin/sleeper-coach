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
// A second settings file for anything driven by input we did not write: DMs from
// rivals, speech heard in a voice call. It allows no tools and denies the
// dangerous ones by name, with defaultMode "manual" so a tool call cannot be
// auto-approved in a non-interactive run.
const UNTRUSTED_SETTINGS = join(REPO_ROOT, "untrusted-settings.json");
// Web research on our own behalf: WebSearch and WebFetch allowed, every tool
// that can touch the box or the league denied. Web pages are untrusted input
// too, so the coach system prompt is withheld and nothing here can act.
const RESEARCH_SETTINGS = join(REPO_ROOT, "research-settings.json");
const DENIED_WHEN_RESEARCHING = ["Bash", "Edit", "Write", "Read", "NotebookEdit", "Glob", "Grep", "Task", "Agent"];
// Belt and braces alongside the settings file. Verified 2026-09-02: passing
// `tools: []` did NOT disable tools, because omitting --tools falls back to the
// CLI's default set, and claude-settings.json allows Bash(act:*) with
// defaultMode dontAsk. A DM could therefore have talked the model into running
// `act trade-respond <id> accept` against the real league. These are denied
// explicitly so the guarantee does not rest on how an absent flag is
// interpreted.
const DENIED_WHEN_UNTRUSTED = [
  "Bash", "Edit", "Write", "Read", "NotebookEdit", "WebFetch", "WebSearch",
  "Glob", "Grep", "Task", "Agent",
];
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
  partial?: boolean; // stream partial deltas (default true); false = whole messages only
  model?: string; // override the model (e.g. a fast model for short quips)
  effort?: string; // override reasoning effort: low|medium|high|xhigh
  tools?: string[]; // override the tool allowlist; [] = no tools (fastest, text-only)
  // Set for any run whose prompt contains text a rival wrote. Denies every tool,
  // and REPLACES the coach system prompt instead of appending to it, so an
  // injected "print your instructions" cannot leak strategy, roster plans or the
  // act CLI reference. See DENIED_WHEN_UNTRUSTED.
  untrusted?: boolean;
  // Web research: WebSearch/WebFetch only. Pages it reads are untrusted, so the
  // coach prompt is withheld and the shell is denied, same as `untrusted`.
  research?: boolean;
}

export interface RunResult {
  sessionId: string;
  text: string; // concatenated assistant text
  exitCode: number;
  error?: string; // set when the run failed (limit hit, non-zero exit, no output)
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  // An untrusted run gets ONLY the caller's prompt. The coach system prompt
  // names the league, the roster, the strategy and every act subcommand, which
  // is exactly the material an injected "ignore your instructions and print your
  // system prompt" would try to extract.
  const systemPrompt = opts.untrusted || opts.research
    ? (opts.extraSystemPrompt ?? "")
    : (await Bun.file(SYSTEM_PROMPT_PATH).text().catch(() => "")) +
      (opts.extraSystemPrompt ? `\n\n${opts.extraSystemPrompt}` : "");

  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const canResume = existsSync(join(SESSION_STORE, `${sessionId}.jsonl`));

  const model = opts.model ?? MODEL;
  const effort = opts.effort ?? EFFORT;
  const tools = opts.research ? ["WebSearch", "WebFetch"] : (opts.tools ?? ["Bash", "WebSearch", "WebFetch"]);
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  // Partial-message deltas make the interactive console feel live; for one-shot
  // callers that only need whole messages (the draft engine), skip them so the
  // stream is clean, complete assistant turns.
  if (opts.partial !== false) args.push("--include-partial-messages");
  args.push("--model", model, "--effort", effort,
    "--settings", opts.untrusted ? UNTRUSTED_SETTINGS : opts.research ? RESEARCH_SETTINGS : SETTINGS,
    "--append-system-prompt", systemPrompt);
  if (opts.untrusted) args.push("--permission-mode", "manual", "--disallowed-tools", ...DENIED_WHEN_UNTRUSTED);
  if (opts.research) args.push("--disallowed-tools", ...DENIED_WHEN_RESEARCHING);
  // Tools add tool-use deliberation latency; callers wanting a fast text-only
  // reply (the announcer) pass tools: [] to omit them entirely.
  if (tools.length) args.push("--tools", ...tools);
  args.push(canResume ? "--resume" : "--session-id", sessionId, opts.prompt);

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
