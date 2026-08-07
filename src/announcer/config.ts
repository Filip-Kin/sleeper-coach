// Config + static maps for the announcer. Values come from the environment so
// no secrets live in the repo. If a required Discord value is missing, loadConfig
// returns null and the caller exits cleanly (never crash-loops).

// #region types
export interface AnnouncerConfig {
  token: string;
  guildId: string;
  voiceChannelId: string;
  activityLog: string;
}
// #endregion

// #region people (future listener phase)
// Sleeper display name -> the human's real name. Not needed to announce OUR
// picks, but kept here so the later listener phase (voicing rivals' picks and
// replying to chat) can name people correctly.
export const MANAGER_NAMES: Record<string, string> = {
  cookieeater45: "Ian",
  OwenMurray1515: "Owen",
  Filip96: "us",
  ChingDing69: "Chris",
  Majoma: "Matt",
  BlueDefender: "Kevin",
  ngonzal987: "Nate",
  Kronos27: "Michel",
};

// Our team's name in the league. Used when the announcer refers to itself.
export const OUR_TEAM_NAME = "--dangerously-skip-perms";
// #endregion

// #region loader
export function loadConfig(): AnnouncerConfig | null {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID?.trim();

  const required: Record<string, string | undefined> = {
    DISCORD_BOT_TOKEN: token,
    DISCORD_GUILD_ID: guildId,
    DISCORD_VOICE_CHANNEL_ID: voiceChannelId,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.log(
      `[announcer] missing required env: ${missing.join(", ")}. ` +
        "Set them in the env file (see env.example), then restart. Exiting cleanly.",
    );
    return null;
  }

  return {
    token: token as string,
    guildId: guildId as string,
    voiceChannelId: voiceChannelId as string,
    activityLog: process.env.ACTIVITY_LOG?.trim() || "/data/sleeper-coach/activity.jsonl",
  };
}
// #endregion
