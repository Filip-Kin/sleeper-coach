#!/usr/bin/env bun
// Owns the one persistent headed Brave (visible over noVNC, holds the Sleeper
// session) and exposes a tiny local HTTP API. The `act` CLI commands are thin
// clients of this API, so all Playwright work happens in this single Bun
// process — no cross-process CDP (which hangs under Bun) and no relaunch during
// the draft. Supervised by entrypoint.sh.

import { launchContext, firstPage } from "./browser.ts";
import {
  leagueUrl, isLoggedIn, domFacts, screenshot,
  makePick, setQueue, setLineup, respondTrade, sendTrade, importSession,
} from "./sleeper.ts";

const PORT = Number(process.env.BROWSER_API_PORT ?? 9223);

const ctx = await launchContext();
const page = await firstPage(ctx);
// Playwright auto-DISMISSES native dialogs by default, which silently cancels
// confirmations like "Start the draft?". Auto-accept them instead.
const acceptDialogs = (p: import("playwright").Page) => p.on("dialog", (d) => d.accept().catch(() => {}));
acceptDialogs(page);
ctx.on("page", acceptDialogs);
await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" }).catch(() => {});
console.log("[browser-server] launched; league open");

// Serialise all browser ops onto one chain (single page, one actor at a time).
let chain: Promise<unknown> = Promise.resolve();
function run<T>(fn: () => Promise<T>): Promise<T> {
  const r = chain.then(fn);
  chain = r.then(() => {}, () => {});
  return r as Promise<T>;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const b = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    try {
      switch (url.pathname) {
        case "/login-check":
          return Response.json({ loggedIn: await run(() => isLoggedIn(page)) });
        case "/goto":
          await run(async () => { await page.goto(str(b.url), { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2500); });
          return Response.json({ url: page.url() });
        case "/dom": {
          const target = str(b.url) || url.searchParams.get("url") || "";
          if (target) await run(async () => { await page.goto(target, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3500); });
          return Response.json(await run(() => domFacts(page)) as object);
        }
        case "/shot":
          return Response.json({ path: await run(() => screenshot(page, str(b.name, "current"))) });
        case "/eval":
          // Dev/authoring tool: evaluate an expression in the page. Internal only.
          return Response.json({ result: await run(() => page.evaluate(str(b.expr))) });
        case "/click":
          await run(async () => {
            if (b.text) await page.getByText(new RegExp(str(b.text), "i")).first().click({ timeout: 8000 });
            else await page.click(str(b.selector), { timeout: 8000 });
          });
          return Response.json({ ok: true });
        case "/pick":
          await run(() => makePick(page, str(b.player))); return Response.json({ ok: true });
        case "/queue":
          await run(() => setQueue(page, (b.players as string[]) ?? [])); return Response.json({ ok: true });
        case "/lineup":
          await run(() => setLineup(page, (b.ids as string[]) ?? [])); return Response.json({ ok: true });
        case "/trade-respond":
          await run(() => respondTrade(page, str(b.txid), b.decision === "accept" ? "accept" : "reject")); return Response.json({ ok: true });
        case "/trade-send":
          await run(() => sendTrade(page, b.spec)); return Response.json({ ok: true });
        case "/import-session":
          return Response.json({ ok: await run(() => importSession(ctx, page, (b.entries as Record<string, string>) ?? {}, b.cookies as never)) });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});
console.log(`[browser-server] HTTP API on 127.0.0.1:${PORT}`);
