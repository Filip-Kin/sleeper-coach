import type { BrowserContext, Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { assertWritesAllowed } from "../killswitch.ts";

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
// Sleeper's own GraphQL API, called from inside the page so the session token
// never leaves the browser profile and the request carries the site's origin.
// The pick'em game is GraphQL-only (no REST at all), so this is the only way to
// read the week's lines, read every rival's picks, or submit our own.
export async function graphql(page: Page, query: string): Promise<unknown> {
  if (!page.url().includes("sleeper.com")) {
    await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
  }
  return await page.evaluate(async (q) => {
    const token = window.localStorage.getItem("token");
    if (!token) return { errors: [{ code: "no_token", message: "no session token in localStorage" }] };
    const res = await fetch("https://sleeper.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query: q }),
    });
    return await res.json();
  }, query);
}

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
  // The kill switch is checked HERE, in the write function itself, not only in
  // the scheduled orchestration above it. Guarding lineup-run and waiver-run
  // alone left FREEZE bypassable by the agent calling the browser API directly,
  // by a manual curl to /lineup or /add, and by anything else that reaches these
  // functions without going through a timer. "Freeze everything" has to mean
  // everything, so the check sits at the chokepoint every write passes through.
  assertWritesAllowed("set the lineup");
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


// #region add / drop  (waivers and free agency)
//
// DOM captured against the staging league on 2026-08-30. The flow is: the
// players tab lists free agents as `.player-list-item`, each with a `+` button
// at `.owner-cell a.player-action-button.add`; clicking it opens a `.modal-item`
// titled "Add Player"; if the roster is full the modal shows "Your roster is
// full, please select a player to drop" plus a table of our own players; then
// `.form-elements.button` labelled "Add Player" commits it.
//
// Two different name formats appear on the same screen, which is the trap here.
// The FREE AGENT list abbreviates ("B. Purdy"), so an incoming name has to be
// matched as first-initial + surname and cross-checked against the position and
// team or it is genuinely ambiguous. The DROP TABLE inside the modal uses FULL
// names ("Jayden Daniels"), so the dangerous half of the operation is the
// unambiguous half. Anything ambiguous throws rather than guessing, because the
// cost of dropping the wrong player is a whole asset.

export interface AddDropSpec {
  add: string; // full name of the free agent to add, e.g. "Brock Purdy"
  drop?: string; // full name of the player to drop; required only if the roster is full
  leagueId?: string; // explicit, so a write path never resolves its own target
}

// "Brock Purdy" -> /^B\.?\s*Purdy$/i, to match the abbreviated list form.
function abbrevMatcher(full: string): RegExp {
  const parts = full.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const last = parts.slice(1).join(" ") || first;
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(first[0] ?? "")}\\.?\\s*${esc(last)}$`, "i");
}

export async function addPlayer(page: Page, spec: AddDropSpec): Promise<void> {
  // The kill switch is checked HERE, in the write function itself, not only in
  // the scheduled orchestration above it. Guarding lineup-run and waiver-run
  // alone left FREEZE bypassable by the agent calling the browser API directly,
  // by a manual curl to /lineup or /add, and by anything else that reaches these
  // functions without going through a timer. "Freeze everything" has to mean
  // everything, so the check sits at the chokepoint every write passes through.
  assertWritesAllowed(`add ${spec.add}${spec.drop ? ` and drop ${spec.drop}` : ""}`);
  const league = spec.leagueId ?? config.leagueId;
  await page.goto(`${SLEEPER}/leagues/${league}/players`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Narrow to free agents, then search, because the list is long and virtualised
  // so the target row may simply not be in the DOM yet.
  await page.getByText(/^Free agents$/i).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const surname = spec.add.trim().split(/\s+/).slice(-1)[0] ?? spec.add;
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.count().catch(() => 0)) {
    await search.fill(surname).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const wanted = abbrevMatcher(spec.add).source;
  const found = (await page.evaluate((src: string) => {
    const re = new RegExp(src, "i");
    const rows = Array.from(document.querySelectorAll(".player-list-item"));
    const hits: { name: string; position: string }[] = [];
    let idx = -1;
    rows.forEach((r, i) => {
      const name = (r.querySelector(".name")?.textContent ?? "").trim();
      if (!re.test(name)) return;
      hits.push({ name, position: (r.querySelector(".position")?.textContent ?? "").trim() });
      if (idx < 0) idx = i;
    });
    return { hits, idx };
  }, wanted)) as { hits: { name: string; position: string }[]; idx: number };

  if (found.hits.length === 0) throw new Error(`addPlayer: no free agent row matched "${spec.add}"`);
  if (found.hits.length > 1) {
    throw new Error(
      `addPlayer: "${spec.add}" is ambiguous in the free agent list (${found.hits
        .map((h) => `${h.name} ${h.position}`)
        .join(" | ")}); refusing to guess`,
    );
  }

  await page.locator(".player-list-item a.player-action-button.add").nth(found.idx).click({ timeout: 8000 });
  await page.waitForTimeout(2000);

  const modal = page.locator(".modal-item").filter({ hasText: /Add Player/i }).first();
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  const modalText = (await modal.innerText().catch(() => "")) ?? "";
  const rosterFull = /roster is full/i.test(modalText);

  if (rosterFull) {
    if (!spec.drop) {
      throw new Error(`addPlayer: roster is full and no drop was specified for "${spec.add}"`);
    }
    // The drop table uses full names, so this match is exact.
    const dropRow = modal.getByText(new RegExp(`^\\s*${spec.drop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i")).first();
    const n = await dropRow.count().catch(() => 0);
    if (n === 0) throw new Error(`addPlayer: "${spec.drop}" is not in the drop list; refusing to drop anyone else`);
    await dropRow.click({ timeout: 8000 });
    await page.waitForTimeout(800);
  } else if (spec.drop) {
    throw new Error(`addPlayer: a drop of "${spec.drop}" was requested but the roster is not full; refusing`);
  }

  await modal.locator(".form-elements.button").filter({ hasText: /Add Player/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3500);

  // Read back from the DOM. The rosters API served a stale `starters` array more
  // than five minutes after a confirmed change on 2026-08-30, so it cannot be
  // used to confirm a write.
  await openTeamPage(page, league);
  const after = await readRoster(page);
  const names = after.map((r) => r.name.toLowerCase());
  const addedOk = names.some((n) => abbrevMatcher(spec.add).test(n) || n.includes(surname.toLowerCase()));
  if (!addedOk) {
    throw new Error(`addPlayer: "${spec.add}" is not on the roster after the add. Roster: ${after.map((r) => r.name).join(", ")}`);
  }
  if (spec.drop) {
    const dropSurname = spec.drop.trim().split(/\s+/).slice(-1)[0]?.toLowerCase() ?? "";
    if (names.some((n) => n.includes(dropSurname))) {
      throw new Error(`addPlayer: "${spec.drop}" is STILL on the roster after the add; state is now unknown, stopping`);
    }
  }
}
// #endregion

// #region trades
//
// The trade UI lives at /leagues/<id>/trades. Selectors observed on 2026-08-30
// against the staging league: `.propose-trade-partners` is the propose modal,
// `.trade-partners-container` holds the columns, `.trade-partner-roster-item.is-owner`
// is OUR column, `.trade-center-player-box` is a player card.
//
// Two things make this the strictest write path, and both are honoured here:
//
//   1. It cannot be fully exercised yet. The staging league has no trade
//      partner at all (all seven other teams are orphans with owner_id null), so
//      the click path has never run end to end. Everything below is therefore
//      GATED behind TRADE_WRITE_ARMED and refuses to click until a real offer
//      has let us verify the selectors with `captureTradeDom`. Off by default,
//      it still does the safe half: navigate, screenshot, dump the DOM.
//
//   2. The trade UI shows NO player avatar. Identity there is position + team +
//      an ABBREVIATED name like "J. Daniels", which is ambiguous in principle
//      (two J. Daniels could exist). So a card is matched on the loose form AND
//      cross-checked on position and team, and anything that matches more than
//      one card throws rather than guesses, the exact discipline addPlayer uses
//      on the free-agent list. The cost of clicking the wrong player into a
//      trade is a whole asset.

const tradeWriteArmed = () => /^(1|true|yes|on)$/i.test(process.env.TRADE_WRITE_ARMED ?? "");

function tradesUrl(leagueId?: string): string {
  const base = leagueId ? `${SLEEPER}/leagues/${leagueId}` : leagueUrl();
  return `${base}/trades`;
}

// A player card as read off the trade UI: abbreviated name plus the position and
// team we disambiguate on.
interface TradeCard {
  index: number;
  name: string; // abbreviated, e.g. "J. Daniels"
  pos: string;
  team: string;
  text: string;
}

// Read every `.trade-center-player-box` within a scope (a column, or the whole
// page). The internal structure is not yet confirmed, so this is written to
// degrade gracefully: it pulls the visible text and best-effort position/team,
// and `captureTradeDom` exists to finish it against real markup.
async function readTradeCards(page: Page, scopeSelector: string): Promise<TradeCard[]> {
  return (await page.evaluate((scopeSel: string) => {
    const scope = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!scope) return [];
    return Array.from(scope.querySelectorAll(".trade-center-player-box")).map((el, index) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const name = (el.querySelector(".player-name")?.textContent ?? "").trim();
      const posRaw = (el.querySelector(".position")?.textContent ?? "").trim();
      // "RB - SEA" or "RB SEA": split position from team.
      const parts = posRaw.split(/[\s-]+/).filter(Boolean);
      const pos = parts[0] ?? "";
      const team = parts[1] ?? "";
      return { index, name: name || text, pos, team, text };
    });
  }, scopeSelector)) as TradeCard[];
}

// Find the single card matching a full name, position and team. Refuses on more
// than one match (the abbreviated-name ambiguity) and on none.
function matchCard(cards: TradeCard[], full: string, position?: string, team?: string): TradeCard {
  const re = abbrevMatcher(full);
  const hits = cards.filter((c) => {
    if (!re.test(c.name)) return false;
    if (position && c.pos && c.pos.toUpperCase() !== position.toUpperCase()) return false;
    if (team && c.team && c.team.toUpperCase() !== team.toUpperCase()) return false;
    return true;
  });
  if (hits.length === 0) throw new Error(`trade: no card matched "${full}"${position ? ` (${position})` : ""}${team ? ` ${team}` : ""}`);
  if (hits.length > 1) {
    throw new Error(
      `trade: "${full}" is ambiguous in the trade UI (${hits.map((h) => `${h.name} ${h.pos} ${h.team}`).join(" | ")}); refusing to guess`,
    );
  }
  return hits[0]!;
}

// A best-effort read of the pending INCOMING offers on the trades page. Selectors
// unconfirmed, so this is heuristic: a block that offers both an Accept and a
// Reject affordance is a pending offer awaiting our decision. Returns how many
// there are so the caller can refuse to act when it cannot tell them apart.
async function pendingOfferCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll("[class*='trade']"));
    let n = 0;
    for (const b of blocks) {
      const txt = (b.textContent ?? "").toLowerCase();
      const hasAccept = /\baccept\b/.test(txt);
      const hasReject = /\b(reject|decline)\b/.test(txt);
      // Only count a block that is itself the offer, not an ancestor that
      // contains one: require it to be reasonably small.
      if (hasAccept && hasReject && txt.length < 800) n++;
    }
    return n;
  });
}

// Accept or reject a pending incoming trade. `leagueId` is explicit, like every
// other write path, so a staging test can never rearrange the real team.
//
// GATED: with TRADE_WRITE_ARMED unset this navigates, screenshots and then
// throws without clicking, because the accept/reject selectors have not been
// verified against a real offer. Arm it only after `captureTradeDom` on a live
// offer confirms them.
export async function respondTrade(
  page: Page,
  transactionId: string,
  decision: "accept" | "reject",
  leagueId?: string,
): Promise<void> {
  // One FREEZE file must stop every write, including trades. See killswitch.ts.
  assertWritesAllowed(`${decision} trade ${transactionId}`);
  await page.goto(tradesUrl(leagueId), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await screenshot(page, `trade-${decision}-${transactionId}`);

  const pendingBefore = await pendingOfferCount(page).catch(() => 0);

  if (!tradeWriteArmed()) {
    throw new Error(
      `respondTrade is GATED (set TRADE_WRITE_ARMED=1 to enable). Saw ~${pendingBefore} pending offer block(s). ` +
        `Run \`act trade-capture ${leagueId ?? ""}\` on a real offer and finish the accept/reject selectors before arming.`,
    );
  }

  // Sleeper does not expose the transaction id in the DOM, so we cannot target a
  // specific offer by id. Refuse unless there is exactly one pending offer to
  // act on; batching or guessing which of several is "the" one is precisely the
  // ambiguity these rails exist to stop.
  if (pendingBefore !== 1) {
    throw new Error(`respondTrade: expected exactly one pending offer to ${decision}, saw ~${pendingBefore}; refusing to guess which`);
  }

  const label = decision === "accept" ? /^accept$/i : /^(reject|decline)$/i;
  const btn = page.getByRole("button", { name: label }).first();
  if ((await btn.count().catch(() => 0)) === 0) {
    throw new Error(`respondTrade: no ${decision} button found; selectors need finishing from a real offer capture`);
  }
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  // Sleeper usually shows a confirm dialog; accept it if present.
  const confirm = page.getByRole("button", { name: decision === "accept" ? /^(accept|confirm|yes)$/i : /^(reject|decline|confirm|yes)$/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await page.waitForTimeout(2500);

  // Read back from the DOM, never the rosters API (it served a stale roster for
  // over five minutes after a confirmed change on 2026-08-30). The offer must no
  // longer be pending. A silent no-op has to fail loudly rather than look done.
  await page.goto(tradesUrl(leagueId), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await screenshot(page, `trade-${decision}-${transactionId}-after`);
  const pendingAfter = await pendingOfferCount(page).catch(() => 1);
  if (pendingAfter >= pendingBefore) {
    throw new Error(`respondTrade: the offer is still pending after ${decision} (before ~${pendingBefore}, after ~${pendingAfter}); state is now unknown, stopping`);
  }
}

// What a proposed outgoing trade offers. Player identity is a loose (name, pos,
// team) triple, matched against the abbreviated cards in the trade UI.
export interface TradePlayerRef {
  name: string; // full name, e.g. "Jayden Daniels"
  position?: string;
  team?: string;
}

export interface TradeSendSpec {
  leagueId?: string; // explicit, so a write path never resolves its own target
  partnerRosterId?: number; // the partner to trade with, by roster id
  partnerTeam?: string; // or by team/display name, if the roster id is unknown
  give: TradePlayerRef[]; // our players to send
  receive: TradePlayerRef[]; // their players to request
}

// Propose an outgoing trade. GATED behind TRADE_WRITE_ARMED for the same reason
// as respondTrade: the propose flow has never run against a real partner (the
// staging league has none), so until it is verified this refuses to click.
export async function sendTrade(page: Page, spec: TradeSendSpec): Promise<void> {
  // One FREEZE file must stop every write, including trades. See killswitch.ts.
  assertWritesAllowed("send a trade offer");
  if (!spec || !Array.isArray(spec.give) || !Array.isArray(spec.receive)) {
    throw new Error(`sendTrade: malformed spec ${JSON.stringify(spec).slice(0, 120)}`);
  }
  await page.goto(tradesUrl(spec.leagueId), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await screenshot(page, "trade-send-before");

  if (!tradeWriteArmed()) {
    throw new Error(
      "sendTrade is GATED (set TRADE_WRITE_ARMED=1 to enable). The propose flow has not been verified against a real trade partner. " +
        "Run `act trade-capture` with the propose modal open and finish the partner-select and add-player selectors before arming.",
    );
  }

  // 1. Open the propose flow and confirm the modal rendered.
  const proposeBtn = page.getByRole("button", { name: /propose( a)? trade|new trade|create trade/i }).first();
  if (await proposeBtn.count().catch(() => 0)) await proposeBtn.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const modal = page.locator(".propose-trade-partners").first();
  await modal.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error("sendTrade: the .propose-trade-partners modal did not open; selectors need finishing from a real capture");
  });

  // 2. Select the partner. Preferring the roster id keeps this unambiguous;
  //    a team name is a fallback that must still resolve to exactly one option.
  const partnerKey = spec.partnerTeam ?? (spec.partnerRosterId != null ? String(spec.partnerRosterId) : "");
  if (!partnerKey) throw new Error("sendTrade: no partner specified (partnerRosterId or partnerTeam)");
  const partnerOpt = page.getByText(new RegExp(partnerKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first();
  if ((await partnerOpt.count().catch(() => 0)) === 0) {
    throw new Error(`sendTrade: no partner matched "${partnerKey}"`);
  }
  await partnerOpt.click({ timeout: 8000 });
  await page.waitForTimeout(1500);

  // 3. Add players from each column. Our players come from the .is-owner column;
  //    theirs from the other column. Each match refuses on ambiguity.
  const ourCol = ".trade-partner-roster-item.is-owner";
  const theirCol = ".trade-partner-roster-item:not(.is-owner)";
  const addFrom = async (colSel: string, refs: TradePlayerRef[]): Promise<void> => {
    if (refs.length === 0) return;
    const cards = await readTradeCards(page, colSel);
    for (const ref of refs) {
      const card = matchCard(cards, ref.name, ref.position, ref.team);
      await page.locator(`${colSel} .trade-center-player-box`).nth(card.index).click({ timeout: 8000 });
      await page.waitForTimeout(500);
    }
  };
  await addFrom(ourCol, spec.give);
  await addFrom(theirCol, spec.receive);
  await screenshot(page, "trade-send-filled");

  // 4. Send.
  const sendBtn = page.getByRole("button", { name: /^(send|propose|review)( trade| offer)?$/i }).first();
  if ((await sendBtn.count().catch(() => 0)) === 0) {
    throw new Error("sendTrade: no send/propose button found; selectors need finishing from a real capture");
  }
  await sendBtn.click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  const confirm = page.getByRole("button", { name: /^(send|confirm|yes|propose)$/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await page.waitForTimeout(2500);

  // Read back: a pending outgoing offer should now exist on the trades page.
  await page.goto(tradesUrl(spec.leagueId), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await screenshot(page, "trade-send-after");
  const pending = await pendingOfferCount(page).catch(() => 0);
  if (pending === 0) {
    throw new Error("sendTrade: no pending trade is visible after sending; the proposal may not have gone through, state is unknown, stopping");
  }
}

// Discovery tool for finishing the trade selectors from real markup. Navigates
// to the trades page and dumps the structured facts and raw HTML of the trade
// containers, so respondTrade/sendTrade can be completed the moment a real offer
// or a real partner exists. Read-only: it clicks nothing.
export async function captureTradeDom(page: Page, leagueId?: string): Promise<unknown> {
  await page.goto(tradesUrl(leagueId), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await screenshot(page, "trade-capture");
  return page.evaluate(() => {
    const clip = (el: Element | null, n = 20000): string => (el ? (el.outerHTML ?? "").slice(0, n) : "");
    const cards = Array.from(document.querySelectorAll(".trade-center-player-box")).map((el) => ({
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      classes: typeof el.className === "string" ? el.className : "",
      html: (el as HTMLElement).outerHTML.slice(0, 600),
    }));
    const partnerItems = Array.from(document.querySelectorAll(".trade-partner-roster-item")).map((el) => ({
      classes: typeof el.className === "string" ? el.className : "",
      isOwner: el.classList.contains("is-owner"),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0 && t.length < 40);
    return {
      url: location.href,
      title: document.title,
      proposeModal: clip(document.querySelector(".propose-trade-partners")),
      partnersContainer: clip(document.querySelector(".trade-partners-container")),
      cards,
      partnerItems,
      buttons: Array.from(new Set(buttons)).slice(0, 80),
      mainHtml: clip(document.querySelector("main") ?? document.body, 60000),
    };
  });
}
// #endregion

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
