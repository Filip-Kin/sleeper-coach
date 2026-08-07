import { chromium, type BrowserContext, type Page } from "playwright";
import { unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Headed Chromium on Xvfb (:99 in the container), driven by Playwright, in a
// persistent profile so the Sleeper login survives restarts. Mirrors the
// proven pit-podcast `_launch_browser` pattern: persistent context, the
// singleton-symlink cleanup, and automation-signal-reducing launch args.

const PROFILE_DIR = process.env.BROWSER_PROFILE ?? "/data/sleeper-coach/profile";

// Chromium leaves three singleton symlinks that block re-launch after an
// unclean exit; the profile is on a persistent volume so they outlive the
// container. These are dangling symlinks (they point at a dead host-pid), so
// existsSync returns false for them — we must unlink unconditionally.
function clearSingletons(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      unlinkSync(join(profileDir, name));
    } catch {
      // Not present is the normal case; ignore.
    }
  }
}

// Runs before any page script; erases the usual "this is automation" tells so
// Sleeper's bot checks see an ordinary Chrome. We keep the real user-agent
// (overriding it would desync the Sec-CH-UA client hints and look faker).
const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const _q = navigator.permissions && navigator.permissions.query;
  if (_q) navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _q.call(navigator.permissions, p);
`;

export async function launchContext(opts?: { profileDir?: string }): Promise<BrowserContext> {
  const profileDir = opts?.profileDir ?? PROFILE_DIR;
  mkdirSync(profileDir, { recursive: true });
  clearSingletons(profileDir);

  // Prefer a real Brave build if present (BROWSER_EXECUTABLE), else Playwright's
  // bundled Chromium. Brave's genuine fingerprint clears bot checks the bundled
  // Chromium trips.
  const executablePath = process.env.BROWSER_EXECUTABLE || undefined;

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath,
    slowMo: 80, // human-ish pacing; also gives the UI time to settle
    viewport: { width: 1400, height: 900 },
    // Drop Playwright's automation flags that Sleeper can sniff.
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-restore-last-session",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  await ctx.addInitScript(STEALTH);
  return ctx;
}

// Most helpers want the single page the persistent context opens with.
export async function firstPage(ctx: BrowserContext): Promise<Page> {
  const existing = ctx.pages()[0];
  return existing ?? (await ctx.newPage());
}
