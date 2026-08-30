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
import { existsSync } from "node:fs";
import sodium from "libsodium-wrappers";
import { loadConfig, discordNames, ROOM_FEED_IDS } from "./config.ts";
import { startTail } from "./tail.ts";
import { connectVoice, type VoiceHandle } from "./voice.ts";
import { synthesize } from "./tts.ts";
import { announcePickLine, announceCompleteLine, announceComebackLine, snipeLine, draftOpenerLine, type ComebackContext } from "./persona.ts";
import { config as leagueConfig } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { MANAGER_NAMES } from "./config.ts";
import { startListener } from "./listen.ts";
import { startFaceServer, publishSpeech, publishState, type FaceState } from "./face.ts";
import type { ActivityEvent } from "../log.ts";

const config = loadConfig();
if (!config) process.exit(0); // clean exit: nothing to crash-loop on
// Capture here where the null-guard has narrowed `config`; a hoisted function
// declaration below (resolveSpeaker) can't see that narrowing on its own.
const guildId = config.guildId;
// Same reason: capture the fields the hoisted join/leave/poll helpers use, so
// they see the non-null values rather than the un-narrowed `config`.
const voiceChannelId = config.voiceChannelId;
const listenerEnabled = config.listenerEnabled;
const draftLock = config.draftLock;
const idleLeaveMs = config.idleLeaveMs;
const draftPollMs = config.draftPollMs;
const activityLog = config.activityLog;

// The voice encryption backend must be initialised before we join.
await sodium.ready;

// How often a sniped pick gets a spoken grumble as well as a scowl.
const SNIPE_SPEAK_CHANCE = Number(process.env.SNIPE_SPEAK_CHANCE ?? 0.35);
// How often an insult actually gets under its skin. Leaning smug is the funnier
// default and the more in-character one: being unbothered is the flex, and the
// occasional crack in it lands precisely because it is rare.
const INSULT_ANGRY_CHANCE = Number(process.env.INSULT_ANGRY_CHANCE ?? 0.3);

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
    publishState("idle");
  }
}

async function speak(line: string, mood?: FaceState): Promise<void> {
  console.log(`[announcer] speaking${mood ? ` (${mood})` : ""}: ${line}`);
  const speech = await synthesize(line);
  try {
    // The face page is handed the audio and its lip-sync table BEFORE Discord
    // starts playing, so the page's own <audio> element and the voice channel
    // begin within a few milliseconds of each other. Doing it in this order also
    // means a Discord problem leaves the face talking rather than dead.
    const durationMs = publishSpeech(line, await Bun.file(speech.path).arrayBuffer(), mood);
    if (voice) {
      await voice.speakFile(speech.path);
    } else {
      // No voice connection: hold the queue for the clip's real length anyway,
      // or every remaining line would fire at once and the face would flicker
      // through all of them.
      console.error("[announcer] not connected to voice; face only.");
      await Bun.sleep(durationMs ?? 2_000);
    }
  } finally {
    speech.cleanup();
  }
}
// #endregion

// #region event handling
interface PickDetail {
  target?: unknown;
  reasoning?: unknown;
  team?: unknown;
  bye?: unknown;
  adp?: unknown;
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


// #region round one opener
// Round one gets the formal broadcast read. Everything it needs beyond the pick
// itself (our slot, and who is up next) comes from draft_order, which is
// authoritative. Resolved once and cached; any failure returns null so the
// normal composed line still goes out and a bad lookup cannot silence round one.
let openerCtx: { slot: number; nextManager?: string; nextTeam?: string } | null = null;
async function openerContext(): Promise<typeof openerCtx> {
  if (openerCtx) return openerCtx;
  const draft = await sleeper.draft(leagueConfig.draftId);
  const order = draft.draft_order ?? {};
  const slot = order[leagueConfig.userId];
  if (typeof slot !== "number") return null;
  // Round one only, so the next pick is simply the next slot up.
  const nextUid = Object.entries(order).find(([, v]) => v === slot + 1)?.[0];
  let nextManager: string | undefined;
  let nextTeam: string | undefined;
  if (nextUid) {
    const users = await sleeper.leagueUsers(leagueConfig.leagueId);
    const u = users.find((x) => x.user_id === nextUid);
    if (u) {
      nextManager = MANAGER_NAMES[u.display_name ?? ""] ?? u.display_name ?? undefined;
      nextTeam = u.metadata?.team_name?.trim() || undefined;
    }
  }
  openerCtx = { slot, nextManager, nextTeam };
  return openerCtx;
}

async function openerLine(player: string, position: string | undefined, nflTeam: string | undefined): Promise<string | null> {
  const ctx = await openerContext();
  if (!ctx) return null;
  const users = await sleeper.leagueUsers(leagueConfig.leagueId);
  const ourTeam = users.find((u) => u.user_id === leagueConfig.userId)?.metadata?.team_name?.trim();
  return draftOpenerLine({
    pick: ctx.slot,
    ourTeam: ourTeam ?? "dangerously-skip-perms",
    player,
    position: position ?? "",
    nflTeam,
    nextManager: ctx.nextManager,
    nextTeam: ctx.nextTeam,
  });
}
// #endregion

function handleEvent(ev: ActivityEvent): void {
  if (ev.actor !== "coach") return;

  // Any coach event means the draft is live: keep the bot in the call.
  markActivity();

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
    lastOwnPickAt = Date.now();
    enqueue(async () => {
      const team = str(detail.team);
      const bye = Number(detail.bye) || undefined;
      // Round one is read to a script; every other round is composed.
      const opener =
        round === 1
          ? await openerLine(player, position, team).catch((e) => {
              console.error(`[announcer] opener lookup failed, falling back: ${e instanceof Error ? e.message : String(e)}`);
              return null;
            })
          : null;
      const line = opener ?? (await announcePickLine({ player, round, position, team, bye, reasoning }));
      await speak(line);
      // A player who fell a full round past his ADP is a genuine steal, and the
      // face should look like it knows. Sent after the line so it lands as it
      // stops talking; the page holds it until the mouth is actually finished.
      const adp = Number(detail.adp);
      if (round && round >= 2 && Number.isFinite(adp) && adp < 999 && Math.ceil(adp / 8) <= round - 1) {
        publishState("pleased", `${player} at ADP ${Math.round(adp)}`);
      }
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

  // Our button just went live. Show the working face immediately; the decision
  // takes a few seconds and a still face during it looks like a hung process.
  if (ev.type === "on-clock") {
    publishState("thinking");
    return;
  }

  // A rival just took someone we wanted. The draft engine already distinguishes
  // how much it stings (crying for a top-three target, shock for top-eight), so
  // reuse that rather than inventing a second scale. Face only: it must NOT say
  // anything, because a line for every sniped pick would have it talking through
  // the whole draft.
  if (ev.type === "troll") {
    const detail = (ev.detail ?? {}) as { player?: unknown; emoji?: unknown };
    const player = str(detail.player);
    publishState(detail.emoji === "crying" ? "angry" : "annoyed", player ? `${player} taken` : "one of mine gone");
    // Sometimes it grumbles out loud. Deliberately occasional: every snipe would
    // be relentless, and never would waste the moment. The empty-queue check
    // matters more than the dice roll, because it means a grumble can never
    // delay our own pick announcement or stack up behind one.
    if (player && queue.length === 0 && !draining && Math.random() < SNIPE_SPEAK_CHANCE) {
      // Still scowling while it grumbles about the pick it just lost.
      enqueue(() => speak(snipeLine(player), "angry"));
    }
    return;
  }

  // Other event types (plan, etc.) are intentionally ignored for now.
}
// #endregion

// #region listener (LISTEN + COMEBACK), gated behind LISTENER_ENABLED
// True while the bot is speaking (its queue is draining). The listener consults
// this so it never captures or reacts to audio while we're mid-announcement,
// which also keeps it from reacting to our own voice bleeding back.
// Busy while speaking AND for a grace window after, so the room mic streaming
// the bot's own voice back (delayed) can't make it react to itself.
const POST_SPEAK_GRACE_MS = Number(process.env.LISTENER_POST_SPEAK_GRACE_MS ?? 1500);
// How long after announcing our own pick that overheard trash talk is treated as
// being about that pick.
const PICK_HECKLE_MS = Number(process.env.PICK_HECKLE_MS ?? 30_000);
let lastOwnPickAt = 0;
let lastSpokeEndAt = 0;
function isBusy(): boolean {
  return draining || Date.now() - lastSpokeEndAt < POST_SPEAK_GRACE_MS;
}

// Comebacks ride the SAME single queue as announcements, so they can never talk
// over a pick call: they simply wait their turn like any other spoken line.
function enqueueComeback(ctx: ComebackContext): void {
  const withBoard: ComebackContext = { ...ctx, context: draftContext() };
  // Wear the reply. An insult answered by a completely neutral face wastes the
  // line. Which face it wears is a coin weighted toward smug, so most jabs get
  // the unbothered smirk and every so often one visibly gets to it.
  const mood: FaceState | undefined = ctx.insulted
    ? Math.random() < INSULT_ANGRY_CHANCE
      ? "angry"
      : "pleased"
    : ctx.praised
      ? "pleased"
      : undefined;
  enqueue(async () => {
    const line = await announceComebackLine(withBoard);
    await speak(line, mood);
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
let botUserId = "";

// #region call presence — join for the draft, idle-leave when it's over
// The bot no longer sits in the voice channel forever. It leaves after
// config.idleLeaveMs with no draft activity, and rejoins the moment the draft
// engine's lock (config.draftLock) reappears — "draft mode". A poll loop
// (config.draftPollMs) drives both transitions. Speech is dropped safely while
// disconnected (speak() guards on `voice`), so nothing crashes between drafts.
let lastActivityAt = Date.now();
let joining = false;
function markActivity(): void {
  lastActivityAt = Date.now();
}

async function joinCall(reason: string): Promise<void> {
  if (voice || joining) return;
  joining = true;
  try {
    voice = await connectVoice(client, guildId, voiceChannelId);
    markActivity();
    console.log(`[announcer] joined voice channel ${voiceChannelId} (${reason}).`);
    if (listenerEnabled) {
      stopListener = startListener({
        connection: voice.connection,
        botUserId,
        isBusy,
        resolveSpeaker,
        onComeback: enqueueComeback,
        justPicked: () => Date.now() - lastOwnPickAt < PICK_HECKLE_MS,
      });
    }
  } catch (err) {
    // A transient join failure is not fatal here: the poll loop will retry on
    // the next tick. (A permanent misconfig — un-invited bot / wrong IDs — just
    // means it never manages to join, which is logged each attempt.)
    voice = null;
    console.error(`[announcer] could not join voice (${reason}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    joining = false;
  }
}

function leaveCall(reason: string): void {
  if (!voice) return;
  console.log(`[announcer] leaving voice channel (${reason}).`);
  stopListener?.();
  stopListener = null;
  voice.destroy();
  voice = null;
}

// Decide join/leave each tick. Lock present -> draft mode: stay/rejoin. Lock
// absent and idle past the window -> leave. Never leave mid-speech.
async function pollPresence(): Promise<void> {
  const draftMode = existsSync(draftLock);
  if (draftMode) {
    markActivity();
    if (!voice) await joinCall("draft mode");
    return;
  }
  if (voice && !draining && Date.now() - lastActivityAt >= idleLeaveMs) {
    leaveCall(`idle ${Math.round(idleLeaveMs / 60_000)}m with no draft`);
  }
}
// #endregion

client.once(Events.ClientReady, async (c) => {
  console.log(`[announcer] logged in as ${c.user.tag}`);
  botUserId = c.user.id;

  // Tail the activity log immediately; speaking is a no-op until we're in voice.
  stopTail = startTail({
    path: activityLog,
    onEvent: handleEvent,
    onError: (err) => console.error(`[announcer] tail error: ${err.message}`),
  });
  if (!listenerEnabled) {
    console.log("[announcer] listener disabled (set LISTENER_ENABLED=1 to enable comebacks).");
  }

  // Join on boot so we're present (and, if a draft is already running, ready to
  // call picks); the idle timer then leaves us out after idleLeaveMs if no draft
  // shows up, and the poll loop rejoins whenever the draft lock appears.
  await joinCall(existsSync(draftLock) ? "boot: draft active" : "boot");
  if (idleLeaveMs <= 0) {
    console.log("[announcer] idle-leave disabled (IDLE_LEAVE_MINUTES<=0); staying in the call.");
  } else {
    console.log(`[announcer] tailing ${activityLog}; will leave after ${Math.round(idleLeaveMs / 60_000)}m idle, rejoin on draft mode.`);
    setInterval(() => void pollPresence(), draftPollMs);
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

// Up before the Discord login, so the face is reachable even if the bot cannot
// connect (wrong guild id, revoked token, Discord having a bad day).
startFaceServer();

try {
  await client.login(config.token);
} catch (err) {
  console.error(`[announcer] login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// #endregion
