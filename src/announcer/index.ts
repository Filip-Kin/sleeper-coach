#!/usr/bin/env bun
// The announcer: a Discord voice bot that SPEAKS the coach's draft picks out
// loud in a cocky AI-overlord voice. It tails the coach's activity log, and for
// each of OUR draft picks it composes a short line (via the claude runner) and
// plays it into a Discord voice channel using local Piper TTS.
//
// SCOPE: announce-our-picks by default. An optional LISTEN + COMEBACK phase
// (listen.ts + whisper.ts) lets the bot hear the voice channel and fire back a
// spoken insult when someone addresses or trash-talks it. That phase is gated
// behind LISTENER_ENABLED and is OFF by default: with it off the bot behaves
// exactly as announce-only, never subscribing to audio or running whisper.
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
import { loadConfig, discordNames, ROOM_FEED_IDS } from "./config.ts";
import { startTail } from "./tail.ts";
import { connectVoice, type VoiceHandle } from "./voice.ts";
import { synthesize } from "./tts.ts";
import { announcePickLine, announceCompleteLine, announceComebackLine, type ComebackContext } from "./persona.ts";
import { startListener } from "./listen.ts";
import type { ActivityEvent } from "../log.ts";

const config = loadConfig();
if (!config) process.exit(0); // clean exit: nothing to crash-loop on
// Capture here where the null-guard has narrowed `config`; a hoisted function
// declaration below (resolveSpeaker) can't see that narrowing on its own.
const guildId = config.guildId;

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
    lastSpokeEndAt = Date.now();
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

// #region draft memory — track the board so comebacks can cite specific picks
interface BoardPick { round: number; slot: number; name: string; pos: string; mine: boolean }
const draftMemory: BoardPick[] = [];
function recordBoardPick(detail: unknown): void {
  const p = (detail ?? {}) as Partial<BoardPick>;
  if (typeof p.name !== "string" || !p.name) return;
  draftMemory.push({ round: Number(p.round) || 0, slot: Number(p.slot) || 0, name: p.name, pos: String(p.pos ?? ""), mine: p.mine === true });
  if (draftMemory.length > 240) draftMemory.shift();
}
// Compact board summary the overlord can use for accurate, pick-specific jabs.
function draftContext(): string {
  if (!draftMemory.length) return "";
  const mine = draftMemory.filter((p) => p.mine).map((p) => `${p.name} (${p.pos})`);
  const recent = draftMemory.slice(-12).map((p) => `R${p.round} ${p.mine ? "US" : `team ${p.slot}`}: ${p.name} (${p.pos})`);
  return `Our team so far: ${mine.join(", ") || "nothing yet"}. Recent picks around the room: ${recent.join("; ")}.`;
}
// #endregion

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function handleEvent(ev: ActivityEvent): void {
  if (ev.actor !== "coach") return;

  // Silent: just remember the board for later pick-specific comebacks.
  if (ev.type === "board-pick") {
    recordBoardPick(ev.detail);
    return;
  }

  // Announce on the pre-pick INTENT (logged right before the coach clicks), so
  // the call lands as it picks, like a manager announcing their pick.
  if (ev.type === "pick-intent") {
    const detail = (ev.detail ?? {}) as PickDetail;
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

// #region listener (LISTEN + COMEBACK), gated behind LISTENER_ENABLED
// True while the bot is speaking (its queue is draining). The listener consults
// this so it never captures or reacts to audio while we're mid-announcement,
// which also keeps it from reacting to our own voice bleeding back.
// Busy while speaking AND for a grace window after, so the room mic streaming
// the bot's own voice back (delayed) can't make it react to itself.
const POST_SPEAK_GRACE_MS = Number(process.env.LISTENER_POST_SPEAK_GRACE_MS ?? 1500);
let lastSpokeEndAt = 0;
function isBusy(): boolean {
  return draining || Date.now() - lastSpokeEndAt < POST_SPEAK_GRACE_MS;
}

// Comebacks ride the SAME single queue as announcements, so they can never talk
// over a pick call: they simply wait their turn like any other spoken line.
function enqueueComeback(ctx: ComebackContext): void {
  const withBoard: ComebackContext = { ...ctx, context: draftContext() };
  enqueue(async () => {
    const line = await announceComebackLine(withBoard);
    await speak(line);
  });
}

// Name a speaker, or return "" when we genuinely can't know who it is. For a
// room-feed account (one Discord user streaming the whole room's mic), every
// voice looks like that one user, so we must NOT name them — the comeback
// addresses the room generically instead.
async function resolveSpeaker(userId: string): Promise<string> {
  if (ROOM_FEED_IDS.has(userId)) return "";
  const names = discordNames();
  const mapped = names[userId];
  if (mapped) return mapped;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.displayName || member.user.username || "";
  } catch {
    return "";
  }
}
// #endregion

// #region wiring
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let stopTail: (() => void) | null = null;
let stopListener: (() => void) | null = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`[announcer] logged in as ${c.user.tag}`);
  try {
    voice = await connectVoice(client, config.guildId, config.voiceChannelId);
    console.log(`[announcer] joined voice channel ${config.voiceChannelId}; tailing ${config.activityLog}`);
  } catch (err) {
    // A bad guild/channel or an un-invited bot is a permanent misconfig — exit
    // CLEANLY so `restart: on-failure` doesn't hammer Discord's login. Fix the
    // config (invite the bot / correct the IDs) and start the service again.
    console.error(`[announcer] could not join voice: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[announcer] check the bot is invited to the guild and DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID are correct, then restart.");
    await shutdown(0);
    return;
  }
  stopTail = startTail({
    path: config.activityLog,
    onEvent: handleEvent,
    onError: (err) => console.error(`[announcer] tail error: ${err.message}`),
  });

  // Listener is OFF unless LISTENER_ENABLED is set. When off we behave exactly
  // as before: announce-only, never subscribe to audio, never run whisper.
  if (config.listenerEnabled && voice) {
    stopListener = startListener({
      connection: voice.connection,
      botUserId: c.user.id,
      isBusy,
      resolveSpeaker,
      onComeback: enqueueComeback,
    });
  } else {
    console.log("[announcer] listener disabled (set LISTENER_ENABLED=1 to enable comebacks).");
  }
});

client.on(Events.Error, (err) => console.error(`[announcer] discord client error: ${err.message}`));

async function shutdown(code: number): Promise<void> {
  console.log("[announcer] shutting down");
  stopListener?.();
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
