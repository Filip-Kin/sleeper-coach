import type { BrowserContext, Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

// (login is done out-of-band: a real Brave logs in and the session is imported
// via importSession, or transplanted with `act import-session`.)

// DOM discovery for Phase C: dump the facts needed to build reliable selectors.
export async function domFacts(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")).map((el) => ({
      type: el.getAttribute("type"),
      placeholder: el.getAttribute("placeholder"),
      name: el.getAttribute("name"),
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => (el.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 40)
      .slice(0, 60);
    return { url: location.href, title: document.title, inputs, buttons };
  });
}

// Import an existing Sleeper session (captured from a browser where the user is
// already logged in) into the container profile, sidestepping the login/captcha
// entirely. `entries` is the logged-in origin's localStorage (key -> value).
// Optionally also seeds cookies. Persists to the profile on success.
export async function importSession(
  ctx: BrowserContext,
  page: Page,
  entries: Record<string, string>,
  cookies?: { name: string; value: string; domain: string; path: string }[],
): Promise<boolean> {
  if (cookies?.length) await ctx.addCookies(cookies);
  await page.goto(SLEEPER, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate((data) => {
    for (const [k, v] of Object.entries(data)) {
      try {
        window.localStorage.setItem(k, v as string);
      } catch {
        /* ignore quota/read-only keys */
      }
    }
  }, entries);
  await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const ok = await currentPageLoggedIn(page);
  await screenshot(page, ok ? "import-success" : "import-failed");
  return ok;
}

// #region actions (selector bodies completed in Phase C against the live DOM)

// Require that we're already in a draft room. We deliberately do NOT navigate
// here: the caller (orchestrator) owns which draft (real vs a mock) we're in.
// Silently jumping to the real draft was a bug that hijacked mock rehearsals.
async function requireDraftRoom(page: Page): Promise<void> {
  if (!page.url().includes("/draft/")) {
    throw new Error(`not in a draft room (on ${page.url()}); navigate to the draft first`);
  }
}

// Locate a player's row in the draft board by name (searches to narrow first).
async function findPlayerRow(page: Page, playerName: string) {
  const search = page.getByPlaceholder(/find player/i);
  await search.click();
  await search.fill("");
  await search.fill(playerName);
  await page.waitForTimeout(800);
  return page.locator(".player-rank-item2").filter({ hasText: playerName }).first();
}

// Are we on the clock? The pick buttons go live (lose .disable) only on our
// turn. Assumes the draft room is already open (does not navigate).
export async function isOnClock(page: Page): Promise<boolean> {
  return (await page.locator(".draft-button:not(.disable)").count()) > 0;
}

// Draft a player. The pick button (.draft-button) is only live when we're on
// the clock; otherwise it carries a .disable class and the click is a no-op.
export async function makePick(page: Page, playerName: string): Promise<void> {
  await requireDraftRoom(page);
  const row = await findPlayerRow(page, playerName);
  const btn = row.locator(".draft-button:not(.disable)");
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(600);
  // Sleeper shows a confirm ("Draft <player>") for the on-the-clock pick.
  const confirm = page.getByRole("button", { name: /^draft/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await page.waitForTimeout(800);
  await screenshot(page, `picked-${slug(playerName)}`);
}

// Set the Sleeper draft queue (the autopick fallback) to a ranked list, in
// order. Each player's .queue-action adds them to the queue.
export async function setQueue(page: Page, playerNames: string[]): Promise<void> {
  await requireDraftRoom(page);
  for (const name of playerNames) {
    const row = await findPlayerRow(page, name);
    await row.locator(".queue-action").click({ timeout: 5000 });
    await page.waitForTimeout(350);
  }
  await page.getByPlaceholder(/find player/i).fill("");
  await screenshot(page, "queue-set");
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
