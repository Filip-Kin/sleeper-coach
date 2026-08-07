import { chromium, type BrowserContext, type Page } from "playwright";
import { unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The browser layer. A single long-lived process (browser-server) launches the
// persistent Brave via launchPersistentContext and owns it for the process
// lifetime; the short-lived `act` commands talk to that server over a local
// HTTP API (see browser-server.ts / cli.ts). We deliberately do NOT use
// connectOverCDP: it hangs under Bun. launchPersistentContext works under Bun.

const PROFILE_DIR = process.env.BROWSER_PROFILE ?? "/data/sleeper-coach/profile";

// Runs before any page script; erases the usual automation tells.
export const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
`;

// Dangling singleton symlinks (dead host-pid target) block relaunch and return
// false from existsSync, so unlink unconditionally.
function clearSingletons(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      unlinkSync(join(profileDir, name));
    } catch {
      /* not present is normal */
    }
  }
}

// Launch the persistent headed Brave. Called once by the browser-server.
export async function launchContext(): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  clearSingletons(PROFILE_DIR);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined, // real Brave
    slowMo: 80,
    viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-restore-last-session",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  // Stealth is vestigial now that we authenticate via a transplanted session,
  // and its navigator/chrome shims appear to break Sleeper's mock-draft
  // creation (an internal "reading 'type'" error). Leave it off unless a
  // detection problem returns. (STEALTH kept exported for that case.)
  void STEALTH;
  return ctx;
}

export async function firstPage(ctx: BrowserContext): Promise<Page> {
  return ctx.pages()[0] ?? (await ctx.newPage());
}
