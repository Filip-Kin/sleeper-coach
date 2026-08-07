#!/usr/bin/env bun
// The announcer: a Discord voice bot that SPEAKS the coach's draft picks out
// loud in a cocky AI-overlord voice. It tails the coach's activity log, and for
// each of OUR draft picks it composes a short line (via the claude runner) and
// plays it into a Discord voice channel using local Piper TTS.
//
// SCOPE: announce-our-picks only. No microphone/listening/speech-to-text yet;
// the code is split into modules (tail, persona, tts, voice) so a listener can
// be added later without reworking this path.
//
// ------------------------------------------------------------------------------
// WHAT THE HUMAN MUST PROVIDE to make it talk:
//   1. Create a Discord application + bot at https://discord.com/developers.
//      Copy the bot token (Bot -> Reset Token).
//   2. Enable the Privileged/Gateway intents it needs: GUILDS and
//      GUILD_VOICE_STATES. (Message Content is NOT needed for announce-only.)
//   3. Invite the bot to your server with the Connect and Speak voice
//      permissions (OAuth2 URL generator: scope "bot", perms Connect + Speak).
//   4. Set these env vars in the env file (/data/sleeper-coach/env), never in
//      the repo:
//        DISCORD_BOT_TOKEN         the bot token from step 1
//        DISCORD_GUILD_ID          right-click the server -> Copy Server ID
//        DISCORD_VOICE_CHANNEL_ID  right-click the voice channel -> Copy Channel ID
//      (Developer Mode must be on in Discord to copy IDs.)
//   The same env file already holds CLAUDE_CODE_OAUTH_TOKEN, which the runner
//   uses to compose the lines. With any required Discord var missing, the
//   announcer logs what's missing and exits cleanly (no crash-loop).
// ------------------------------------------------------------------------------

import { Client, GatewayIntentBits, Events } from "discord.js";
import sodium from "libsodium-wrappers";
import { loadConfig } from "./config.ts";
import { startTail } from "./tail.ts";
import { connectVoice, type VoiceHandle } from "./voice.ts";
import { synthesize } from "./tts.ts";
import { announcePickLine, announceCompleteLine } from "./persona.ts";
import type { ActivityEvent } from "../log.ts";

const config = loadConfig();
if (!config) process.exit(0); // clean exit: nothing to crash-loop on

// The voice encryption backend must be initialised before we join.
await sodium.ready;

// #region speech queue — one line at a time, never overlapping
const queue: Array<() => Promise<void>> = [];
let draining = false;
let voice: VoiceHandle | null = null;

function enqueue(job: () => Promise<void>): void {
  queue.push(job);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (!job) continue;
      try {
        await job();
      } catch (err) {
        console.error(`[announcer] speak job failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    draining = false;
  }
}

async function speak(line: string): Promise<void> {
  if (!voice) {
    console.error("[announcer] not connected to voice; dropping line.");
    return;
  }
  console.log(`[announcer] speaking: ${line}`);
  const speech = await synthesize(line);
  try {
    await voice.speakFile(speech.path);
  } finally {
    speech.cleanup();
  }
}
// #endregion

// #region event handling
interface PickDetail {
  target?: unknown;
  reasoning?: unknown;
}
interface CompleteDetail {
  roster?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function handleEvent(ev: ActivityEvent): void {
  if (ev.actor !== "coach") return;

  if (ev.type === "draft-pick") {
    const detail = (ev.detail ?? {}) as PickDetail;
    // Player name: prefer detail.target (full name); fall back to the summary.
    const player = str(detail.target) ?? str(ev.summary.split(":").slice(1).join(":"))?.replace(/\s*\([A-Z]+\)\s*$/, "");
    if (!player) return;
    const round = Number(/R(\d+)/.exec(ev.summary)?.[1] ?? "") || undefined;
    const position = /\(([A-Z]+)\)/.exec(ev.summary)?.[1];
    const reasoning = str(detail.reasoning);
    enqueue(async () => {
      const line = await announcePickLine({ player, round, position, reasoning });
      await speak(line);
    });
    return;
  }

  if (ev.type === "draft-complete") {
    const detail = (ev.detail ?? {}) as CompleteDetail;
    const roster = Array.isArray(detail.roster) ? detail.roster.filter((n): n is string => typeof n === "string") : [];
    enqueue(async () => {
      const line = await announceCompleteLine(roster);
      await speak(line);
    });
    return;
  }

  // Other event types (troll, plan, etc.) are intentionally ignored for now.
}
// #endregion

// #region wiring
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let stopTail: (() => void) | null = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`[announcer] logged in as ${c.user.tag}`);
  try {
    voice = await connectVoice(client, config.guildId, config.voiceChannelId);
    console.log(`[announcer] joined voice channel ${config.voiceChannelId}; tailing ${config.activityLog}`);
  } catch (err) {
    console.error(`[announcer] could not join voice: ${err instanceof Error ? err.message : String(err)}`);
    await shutdown(1);
    return;
  }
  stopTail = startTail({
    path: config.activityLog,
    onEvent: handleEvent,
    onError: (err) => console.error(`[announcer] tail error: ${err.message}`),
  });
});

client.on(Events.Error, (err) => console.error(`[announcer] discord client error: ${err.message}`));

async function shutdown(code: number): Promise<void> {
  console.log("[announcer] shutting down");
  stopTail?.();
  voice?.destroy();
  try {
    await client.destroy();
  } catch {
    // already gone
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  await client.login(config.token);
} catch (err) {
  console.error(`[announcer] login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// #endregion
