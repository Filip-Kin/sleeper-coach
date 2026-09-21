import { isStagingTarget } from "./config.ts";
// Home Assistant push notifications. Wired via env at deploy time (Phase F):
//   HA_NOTIFY_URL  e.g. https://ha.filipkin.com/api/services/notify/mobile_app_x
//   HA_TOKEN       a long-lived HA access token
// If unset, alerts just log, so the daemon runs fine in development.

export async function sendAlert(title: string, message: string): Promise<void> {
  const url = process.env.HA_NOTIFY_URL;
  const token = process.env.HA_TOKEN;
  const line = `[alert] ${title}: ${message}`;
  // A process pointed at the staging league never pushes to Filip's phone. On
  // 2026-09-20 a verification run against staging sent "IR opportunity: Jayden
  // Daniels" three times and a failed add for a player who is not on his team.
  if (isStagingTarget) {
    console.log(`${line} (staging, not sent)`);
    return;
  }
  if (!url || !token) {
    console.log(line);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Coach: ${title}`, message }),
    });
    if (!res.ok) console.error(`${line} (HA ${res.status})`);
  } catch (err) {
    console.error(`${line} (HA send failed: ${err instanceof Error ? err.message : String(err)})`);
  }
}
