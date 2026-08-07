import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Headed Chromium on Xvfb (:99 in the container), driven by Playwright, in a
// persistent profile so the Sleeper login survives restarts. Mirrors the
// proven pit-podcast `_launch_browser` pattern: persistent context, the
// singleton-symlink cleanup, and automation-signal-reducing launch args.

const PROFILE_DIR = process.env.BROWSER_PROFILE ?? "/data/sleeper-coach/profile";

// Chromium leaves three singleton symlinks that block re-launch after an
// unclean exit; the profile is on a persistent volume so they outlive the
// container. Clear them before every launch.
function clearSingletons(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = join(profileDir, name);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Missing is fine; anything else surfaces on launch.
    }
  }
}

export async function launchContext(opts?: { profileDir?: string }): Promise<BrowserContext> {
  const profileDir = opts?.profileDir ?? PROFILE_DIR;
  mkdirSync(profileDir, { recursive: true });
  clearSingletons(profileDir);

  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    slowMo: 80, // human-ish pacing; also gives the UI time to settle
    viewport: { width: 1400, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-restore-last-session",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

// Most helpers want the single page the persistent context opens with.
export async function firstPage(ctx: BrowserContext): Promise<Page> {
  const existing = ctx.pages()[0];
  return existing ?? (await ctx.newPage());
}
