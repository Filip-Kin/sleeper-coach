import type { BrowserContext, Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchContext, firstPage } from "./browser.ts";
import { config } from "../config.ts";

// Page-object layer over the Sleeper web app (https://sleeper.com). The action
// selectors are finalised in Phase C by observing the live DOM via noVNC; until
// then each action navigates to the right place and screenshots so we can read
// the page rather than guess. Login is a one-time human step over noVNC; the
// persistent profile keeps the session.

export const SLEEPER = "https://sleeper.com";
const SHOTS_DIR = process.env.SHOTS_DIR ?? "/data/sleeper-coach/shots";

export function leagueUrl(): string {
  return `${SLEEPER}/leagues/${config.leagueId}`;
}
export function draftUrl(): string {
  return `${SLEEPER}/draft/nfl/${config.draftId}`;
}

export async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

// Logged-out Sleeper renders the marketing page with "Log In" / "Sign Up"
// buttons in the nav (confirmed via DOM inspection). Logged in, those are
// replaced by the app, so their absence is the reliable signal.
async function currentPageLoggedIn(page: Page): Promise<boolean> {
  const hasAuthButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, [role="button"], a')).some((b) =>
      /^(log ?in|sign ?up)$/i.test((b.textContent ?? "").trim()),
    ),
  );
  return !hasAuthButtons;
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  return currentPageLoggedIn(page);
}

// Open the Sleeper login page and hold the browser open on the display so a
// human can sign in over noVNC. Polls the *current* page (no navigation, so it
// never disrupts typing) until signed in, then persists the profile. Returns
// true on success, false on timeout.
export async function openForLogin(timeoutMs = 15 * 60 * 1000): Promise<boolean> {
  const ctx = await launchContext();
  const page = await firstPage(ctx);
  await page.goto(`${SLEEPER}/login`, { waitUntil: "domcontentloaded" }).catch(() => page.goto(SLEEPER));
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      if (await currentPageLoggedIn(page).catch(() => false)) {
        await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        await screenshot(page, "login-success");
        return true;
      }
    }
    return false;
  } finally {
    await ctx.close();
  }
}

// Open a context+page ready for use. Callers close the context when done.
export async function open(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await launchContext();
  const page = await firstPage(ctx);
  return { ctx, page };
}

// #region actions (selector bodies completed in Phase C against the live DOM)

// Draft a specific player by name from the draft board.
export async function makePick(page: Page, playerName: string): Promise<void> {
  await page.goto(draftUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await screenshot(page, `pick-before-${slug(playerName)}`);
  throw new Error("makePick: selectors pending Phase C DOM capture");
}

// Set the Sleeper draft queue (the autopick fallback) to a ranked list.
export async function setQueue(page: Page, playerNames: string[]): Promise<void> {
  await page.goto(draftUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await screenshot(page, "queue-before");
  throw new Error(`setQueue: selectors pending Phase C (${playerNames.length} players)`);
}

// Set this week's starting lineup. `starters` is an ordered list of player ids
// matching the league's roster slots.
export async function setLineup(page: Page, starters: string[]): Promise<void> {
  await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await screenshot(page, "lineup-before");
  throw new Error(`setLineup: selectors pending Phase C (${starters.length} starters)`);
}

// Accept or reject a pending trade by its Sleeper transaction id.
export async function respondTrade(page: Page, transactionId: string, decision: "accept" | "reject"): Promise<void> {
  await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await screenshot(page, `trade-${decision}-${transactionId}`);
  throw new Error("respondTrade: selectors pending Phase C DOM capture");
}

// Send a trade offer. `spec` describes what each side gives/gets.
export async function sendTrade(page: Page, spec: unknown): Promise<void> {
  await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await screenshot(page, "trade-send");
  throw new Error(`sendTrade: selectors pending Phase C (${JSON.stringify(spec).slice(0, 80)})`);
}
// #endregion

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
