// Config + static maps for the announcer. Values come from the environment so
// no secrets live in the repo. If a required Discord value is missing, loadConfig
// returns null and the caller exits cleanly (never crash-loops).

// #region types
export interface AnnouncerConfig {
  token: string;
  guildId: string;
  voiceChannelId: string;
  activityLog: string;
  // Listener (LISTEN + COMEBACK) phase. OFF by default: when false the bot is
  // announce-only and never subscribes to audio or runs speech-to-text.
  listenerEnabled: boolean;
}
// #endregion

// #region people (listener phase)
// Sleeper display name -> the human's real name. Not needed to announce OUR
// picks, but kept for voicing rivals' picks and naming managers in chat. NOTE:
// this map is keyed by SLEEPER username, which the voice receiver does NOT know.
// The listener names speakers from Discord instead: see DISCORD_NAMES below
// (keyed by Discord user id), which can be filled out further later.
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

// #region discord names (listener phase)
// Discord user id -> the human's real name, for naming people in comebacks.
// This is a DIFFERENT keying from MANAGER_NAMES above (which is by Sleeper
// username): the voice receiver only knows Discord ids, so we need this map.
// Seeded with the one known id; the rest can be filled in later. When an id is
// not here we fall back to the speaker's Discord display name at runtime, so
// this map is purely an override for nicer/known names.
export const DISCORD_NAMES: Record<string, string> = {
  "216346350936260611": "Filip", // team owner
};

// Optional runtime override/extension: DISCORD_NAME_MAP is a JSON object of
// { "<discord-id>": "<name>" }. Merged over the seeds above so operators can add
// ids without a code change. Malformed JSON is surfaced (logged) and ignored.
export function discordNames(): Record<string, string> {
  const raw = process.env.DISCORD_NAME_MAP?.trim();
  if (!raw) return { ...DISCORD_NAMES };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DISCORD_NAME_MAP must be a JSON object of id -> name");
    }
    const extra: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && name.trim()) extra[id] = name.trim();
    }
    return { ...DISCORD_NAMES, ...extra };
  } catch (err) {
    console.error(`[announcer] ignoring invalid DISCORD_NAME_MAP: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DISCORD_NAMES };
  }
}
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

  // LISTENER_ENABLED gates the whole LISTEN + COMEBACK phase. Default OFF: only
  // an explicit "1" / "true" / "yes" / "on" turns it on. Anything else (unset,
  // "0", empty) keeps the announce-only behaviour unchanged.
  const listenerRaw = process.env.LISTENER_ENABLED?.trim().toLowerCase() ?? "";
  const listenerEnabled = listenerRaw === "1" || listenerRaw === "true" || listenerRaw === "yes" || listenerRaw === "on";

  return {
    token: token as string,
    guildId: guildId as string,
    voiceChannelId: voiceChannelId as string,
    activityLog: process.env.ACTIVITY_LOG?.trim() || "/data/sleeper-coach/activity.jsonl",
    listenerEnabled,
  };
}
// #endregion
