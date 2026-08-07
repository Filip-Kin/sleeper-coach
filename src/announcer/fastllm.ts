// Fast line composer: calls the Anthropic Messages API directly instead of
// spawning the `claude` CLI. The CLI cold-start costs ~3.8s per line; a direct
// call is ~1s, which is the difference between snappy banter and an awkward lag.
// Uses ANNOUNCER_API_KEY (an sk-ant-oat OAuth token or an sk-ant-api key). If no
// key is set, hasFastLlm() is false and callers fall back to the CLI runner.

const KEY = process.env.ANNOUNCER_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANNOUNCER_MODEL ?? "claude-haiku-4-5-20251001";

export function hasFastLlm(): boolean {
  return KEY.length > 0;
}

// Compose one short line. Returns the text, or null on timeout/error/no-key so
// the caller can fall back to the CLI runner or a canned line.
export async function fastCompose(system: string, prompt: string, timeoutMs: number): Promise<string | null> {
  if (!KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    // OAuth (oat) tokens authenticate as a Bearer with the oauth beta header;
    // raw API keys use x-api-key.
    if (KEY.startsWith("sk-ant-oat")) {
      headers["authorization"] = `Bearer ${KEY}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      headers["x-api-key"] = KEY;
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`[announcer] fastllm HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (j.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim();
    return text || null;
  } catch (err) {
    console.error(`[announcer] fastllm error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
