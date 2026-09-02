import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// Any model run whose prompt embeds text an outsider wrote MUST be sandboxed.
// This exists because the obvious-looking guard was wrong: passing `tools: []`
// does NOT disable tools, since omitting --tools falls back to the CLI default
// set, and claude-settings.json allows Bash(act:*) with defaultMode dontAsk.
// Verified live on 2026-09-02 that the model could run `coach ping` from a
// supposedly tool-free call, which means a rival DM or a voice line could have
// reached `act trade-respond <id> accept` against the real league.
//
// These are the two paths fed by strangers: DMs from rivals, and speech-to-text
// from a live voice channel.
const UNTRUSTED_CALLERS = [
  "src/league/dm-watch.ts",
  "src/announcer/persona.ts",
];

for (const file of UNTRUSTED_CALLERS) {
  test(`${file} sandboxes its model run`, () => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    const call = src.slice(src.indexOf("runAgent({"));
    expect(call).toContain("untrusted: true");
  });
}

test("untrusted-settings.json allows nothing and denies the dangerous tools", () => {
  const cfg = JSON.parse(readFileSync(new URL("../../untrusted-settings.json", import.meta.url), "utf8"));
  expect(cfg.permissions.allow).toEqual([]);
  expect(cfg.permissions.defaultMode).not.toBe("dontAsk");
  expect(cfg.permissions.defaultMode).not.toBe("bypassPermissions");
  for (const tool of ["Bash", "Edit", "Write", "WebFetch"]) {
    expect(cfg.permissions.deny).toContain(tool);
  }
});

test("the runner denies tools by name and swaps the settings file when untrusted", () => {
  const src = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  // Belt: an explicit deny list. Braces: a settings file that allows nothing.
  expect(src).toContain("--disallowed-tools");
  expect(src).toContain("UNTRUSTED_SETTINGS");
  expect(src).toContain("--permission-mode");
});

test("an untrusted run does not receive the coach system prompt", () => {
  // system-prompt.md names the league, the roster and every act subcommand, so
  // sending it to a run driven by a rival hands them the map.
  const src = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const systemPrompt"), src.indexOf("const sessionId"));
  expect(block).toContain("opts.untrusted");
  expect(block).toContain("SYSTEM_PROMPT_PATH");
});
