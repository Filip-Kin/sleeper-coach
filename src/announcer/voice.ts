import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import type { VoiceConnection, AudioPlayer } from "@discordjs/voice";
import { createReadStream } from "node:fs";
import { Client, ChannelType } from "discord.js";

// The Discord voice layer: join the configured voice channel, hold one audio
// player, and play a WAV to completion. selfDeaf stays false so a later listener
// phase can receive audio without reconnecting. WAV is transcoded to Opus by
// ffmpeg (present in the image) via @discordjs/voice.

export interface VoiceHandle {
  connection: VoiceConnection;
  player: AudioPlayer;
  speakFile: (wavPath: string) => Promise<void>;
  destroy: () => void;
}

export async function connectVoice(client: Client, guildId: string, channelId: string): Promise<VoiceHandle> {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`channel ${channelId} is not a joinable voice channel`);
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // keep receive open for the future listener phase
    selfMute: false,
  });

  // Best-effort auto-recover from a transient disconnect; give up (destroy) if
  // it does not come back, so we do not sit half-connected and silent.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.error("[announcer] voice connection lost and did not recover; destroying.");
      connection.destroy();
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(player);

  async function speakFile(wavPath: string): Promise<void> {
    const resource = createAudioResource(createReadStream(wavPath), { inputType: StreamType.Arbitrary });
    player.play(resource);
    // Wait until it actually starts (ignore if it never leaves Idle, e.g. empty
    // audio), then block until playback finishes.
    await entersState(player, AudioPlayerStatus.Playing, 10_000).catch(() => {});
    await entersState(player, AudioPlayerStatus.Idle, 5 * 60_000);
  }

  function destroy(): void {
    try {
      connection.destroy();
    } catch {
      // already torn down
    }
  }

  return { connection, player, speakFile, destroy };
}
