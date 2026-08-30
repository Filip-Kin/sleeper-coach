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

// Lightweight, NON-navigating auth check for the daemon's periodic watch. Reads
// the Sleeper JWT straight from the current page's localStorage and checks its
// expiry, without navigating. The old check did a page.goto every 30 min and
// intermittently read the SPA mid-load — seeing the logged-out marketing nav —
// which false-fired "login lost" alerts. Here the token is either present and
// unexpired or it isn't. "unknown" means the page wasn't readable this instant
// (busy/off-site); the caller treats that as inconclusive and never alerts.
export async function authState(page: Page): Promise<"ok" | "logged_out" | "expired" | "unknown"> {
  let token: string | null;
  try {
    token = await page.evaluate(() => {
      try {
        if (!location.hostname.endsWith("sleeper.com")) return "__OFFSITE__";
        return window.localStorage.getItem("token");
      } catch {
        return null;
      }
    });
  } catch {
    return "unknown"; // page busy / navigating — inconclusive
  }
  if (token === "__OFFSITE__") return "unknown";
  if (!token) return "logged_out";
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"));
    const exp = typeof payload.exp === "number" ? payload.exp : 0;
    if (exp && exp * 1000 < Date.now()) return "expired";
    return "ok";
  } catch {
    return "ok"; // token present but opaque — still logged in
  }
}

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
  await page.waitForTimeout(500);
  return page.locator(".player-rank-item2").filter({ hasText: playerName }).first();
}

// Are we on the clock? The pick buttons go live (lose .disable) only on our
// turn. Assumes the draft room is already open (does not navigate).
export async function isOnClock(page: Page): Promise<boolean> {
  return (await page.locator(".draft-button:not(.disable)").count()) > 0;
}

// The LIVE available players, read straight from the draft room's list, which
// only renders undrafted players (drafted ones disappear immediately). This is
// the real-time truth the coach sees — no API lag — so we never target a player
// who's already gone. Returns the currently-rendered rows (top of the list).
export async function liveAvailable(page: Page): Promise<{ name: string; pos: string }[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".player-rank-item2"))
      .map((r) => {
        const nw = r.querySelector(".name-wrapper");
        let name = "";
        if (nw) {
          for (const n of Array.from(nw.childNodes)) {
            if (n.nodeType === 3 && (n.textContent ?? "").trim()) { name = (n.textContent ?? "").trim(); break; }
          }
          if (!name) name = (nw.textContent ?? "").trim().split("\n")[0] ?? "";
        }
        const m = (typeof r.className === "string" ? r.className : "").match(/\b(QB|RB|WR|TE|K|DEF)\b/);
        return { name, pos: m?.[1] ?? "" };
      })
      .filter((x) => x.name);
  });
}

// Scrape the drafted board cells straight from the DOM — the source of truth for
// what's been picked, since the picks API lags badly during a live draft. Each
// .cell.drafted has .pick "R.P" (round.pick-in-round), .player-name (abbreviated,
// e.g. "B. Robinson"), and .position "RB - ATL". Returns them in board order.
export async function draftedCells(page: Page): Promise<{ round: number; pickInRound: number; name: string; pos: string }[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".cell.drafted"))
      .map((c) => {
        const label = (c.querySelector(".pick")?.textContent ?? "").trim();
        const name = (c.querySelector(".player-name")?.textContent ?? "").trim();
        const posRaw = (c.querySelector(".position")?.textContent ?? "").trim();
        const pos = (posRaw.split(/[\s-]/)[0] ?? "").trim();
        const parts = label.split(".");
        return { round: Number(parts[0]) || 0, pickInRound: Number(parts[1]) || 0, name, pos };
      })
      .filter((x) => x.name);
  });
}

// Draft a player. The pick button (.draft-button) is only live when we're on
// the clock; otherwise it carries a .disable class and the click is a no-op.
export async function makePick(page: Page, playerName: string): Promise<void> {
  await requireDraftRoom(page);
  const row = await findPlayerRow(page, playerName);
  // Fail fast if the player isn't in the room (already drafted / not rendered):
  // don't burn the full click timeout on a row that will never appear.
  if ((await row.count()) === 0) throw new Error(`player not in draft room: ${playerName}`);
  const btn = row.locator(".draft-button:not(.disable)");
  await btn.click({ timeout: 5000 });
  await page.waitForTimeout(600);
  // Sleeper shows a confirm ("Draft <player>") for the on-the-clock pick.
  const confirm = page.getByRole("button", { name: /^draft/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await page.waitForTimeout(800);
  await screenshot(page, `picked-${slug(playerName)}`);
}

// React with an emoji to a pick on the draft board — the troll move when a rival
// snipes a player the coach wanted. Each drafted cell (.cell.drafted, text like
// "2.5J. Chase") has a hover-revealed .draft-cell-emoji that opens a picker of
// named options (.draft-emoji[data-emoji-name=...]: heart, poop, crying, shock,
// happy, angry, smart, like, dislike, thinking). Best-effort and non-fatal.
export async function reactToPick(page: Page, playerName: string, emoji: string): Promise<boolean> {
  await requireDraftRoom(page);
  const last = playerName.trim().split(/\s+/).slice(-1)[0] ?? playerName;
  const cell = page.locator(".cell.drafted").filter({ hasText: last }).first();
  if ((await cell.count()) === 0) return false;
  await cell.scrollIntoViewIfNeeded().catch(() => {});
  await cell.hover().catch(() => {});
  await page.waitForTimeout(150);
  await cell.locator(".draft-cell-emoji").click({ timeout: 4000, force: true }).catch(() => {});
  // Wait for the picker to actually open before selecting, then use a real click.
  const selector = page.locator(".draft-emoji-selector").first();
  await selector.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  const opt = selector.locator(`[data-emoji-name="${emoji}"]`).first();
  if ((await opt.count()) === 0) return false;
  await opt.click({ timeout: 3000 }).catch(() => opt.click({ timeout: 2000, force: true }).catch(() => {}));
  // Never leave the picker open over the board — it could sit atop our own pick
  // button when the clock comes back to us.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(120);
  return true; // clicked the emoji; actual persistence is confirmed live
}

// Set the Sleeper draft queue (the autopick fallback) to a ranked list, in
// order. Each player's .queue-action adds them to the queue.
export async function setQueue(page: Page, playerNames: string[]): Promise<void> {
  await requireDraftRoom(page);
  for (const name of playerNames) {
    const row = await findPlayerRow(page, name);
    // Skip fast if the player isn't in the room — never grind on a gone player.
    if ((await row.count()) === 0) continue;
    // The queue "+" is hover-gated (row class show-watchlist-action), so plain
    // clicks hesitate; hover to reveal it, then force the click.
    await row.hover().catch(() => {});
    await row.locator(".queue-action").click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.getByPlaceholder(/find player/i).fill("").catch(() => {});
}

// Set this week's starting lineup. `starters` is an ordered list of player ids
// matching the league's roster slots.
// #region lineup
// Team page structure, mapped from a real 16-round roster in the staging league
// on 2026-08-30. Rows are `.team-roster-item` in roster_positions order: the
// starting slots first (qb, rb, rb, wr, wr, te, flex, flex, k, def), then bn,
// then ir. The slot is the extra class on `.league-slot-position-square`.
//
// Identity comes from the avatar URL (`/players/thumb/<player_id>.jpg`), not the
// visible name, which is abbreviated to "D Montgomery" and would be ambiguous.
// Team defences have no thumbnail; Sleeper uses the team abbreviation as the
// player id and renders it as the name, so fall back to that.
//
// The page says "Click on position buttons to update your lineup": clicking one
// row's position square then another's swaps them. There is NO save step, and
// the write persists across a reload (verified).
export interface RosterRow {
  index: number;
  slot: string; // qb | rb | wr | te | flex | k | def | bn | ir
  playerId: string; // "" for an empty IR slot
  name: string;
}

const ROW = ".team-roster-item";
const SQUARE = ".team-roster-item .league-slot-position-square";
const BENCH_SLOTS = new Set(["bn", "ir"]);

export async function readRoster(page: Page): Promise<RosterRow[]> {
  return (await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".team-roster-item")).map((el, index) => {
      const sq = el.querySelector(".league-slot-position-square");
      const nm = el.querySelector(".player-name");
      const name = nm ? (nm.textContent || "").trim() : "";
      let playerId = "";
      for (const img of Array.from(el.querySelectorAll("img"))) {
        const m = (img.getAttribute("src") || "").match(/\/players\/thumb\/(\w+)\./);
        if (m) { playerId = m[1]!; break; }
      }
      const slot = sq && typeof sq.className === "string"
        ? sq.className.replace("league-slot-position-square", "").trim()
        : "";
      // Team defence: no thumbnail, and the abbreviation IS the player id.
      if (!playerId && slot === "def" && /^[A-Z]{2,4}$/.test(name)) playerId = name;
      return { index, slot, playerId, name };
    });
  })) as RosterRow[];
}

async function openTeamPage(page: Page, leagueId?: string): Promise<RosterRow[]> {
  const url = leagueId ? `${SLEEPER}/leagues/${leagueId}` : leagueUrl();
  await page.goto(`${url}/team`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW, { timeout: 20000 });
  await page.waitForTimeout(1500); // let the rows finish populating
  return readRoster(page);
}

// Set the starting lineup. `starters` is a list of Sleeper player ids in
// STARTING SLOT ORDER, matching the league's roster_positions (so for this
// league: QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF).
//
// Never trust the write: Sleeper's rosters API is heavily cached and still
// served a stale `starters` array minutes after a confirmed change, so
// verification reloads the page and re-reads the DOM instead.
// `leagueId` is explicit on purpose. A write path should never quietly resolve
// its own target from ambient config: that is how a staging test ends up
// rearranging the real team. Callers say which league they mean.
export async function setLineup(page: Page, starters: string[], leagueId?: string): Promise<void> {
  let rows = await openTeamPage(page, leagueId);
  await screenshot(page, "lineup-before");

  const startingCount = rows.filter((r) => !BENCH_SLOTS.has(r.slot)).length;
  if (starters.length !== startingCount) {
    throw new Error(`setLineup: got ${starters.length} starters, the league has ${startingCount} starting slots`);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const wrong: number[] = [];
    for (let i = 0; i < starters.length; i++) {
      if (rows[i]?.playerId !== starters[i]) wrong.push(i);
    }
    if (wrong.length === 0) break;

    for (const i of wrong) {
      const want = starters[i]!;
      const from = rows.findIndex((r) => r.playerId === want);
      if (from < 0) throw new Error(`setLineup: ${want} is not on the roster`);
      if (from === i) continue;
      await page.locator(SQUARE).nth(i).click({ timeout: 8000 });
      await page.waitForTimeout(400);
      await page.locator(SQUARE).nth(from).click({ timeout: 8000 });
      await page.waitForTimeout(700);
      rows = await readRoster(page); // positions shift after each swap
    }
    rows = await openTeamPage(page, leagueId); // reload so the next pass sees persisted truth
  }

  // Final verification against a fresh load. A silently-refused swap (an
  // ineligible position, say) has to fail loudly rather than look applied.
  rows = await openTeamPage(page, leagueId);
  await screenshot(page, "lineup-after");
  const got = rows.slice(0, starters.length).map((r) => r.playerId);
  const mismatch = got.findIndex((id, i) => id !== starters[i]);
  if (mismatch >= 0) {
    throw new Error(
      `setLineup: slot ${mismatch} (${rows[mismatch]?.slot}) is ${got[mismatch] || "empty"}, wanted ${starters[mismatch]}. Full lineup: ${got.join(",")}`,
    );
  }
}
// #endregion

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
