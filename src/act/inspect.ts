#!/usr/bin/env bun
// DOM discovery tool for Phase C: navigate somewhere and dump the facts I need
// to build reliable selectors (inputs, buttons, storage, key texts) instead of
// guessing. Read-only; also screenshots.
//
//   bun run src/act/inspect.ts <url|league|draft>

import { open, screenshot, leagueUrl, draftUrl } from "./sleeper.ts";

const arg = process.argv[2] ?? "league";
const url = arg === "league" ? leagueUrl() : arg === "draft" ? draftUrl() : arg;

const { ctx, page } = await open();
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const facts = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")).map((el) => ({
      type: el.getAttribute("type"),
      placeholder: el.getAttribute("placeholder"),
      name: el.getAttribute("name"),
      visible: !!(el.offsetWidth || el.offsetHeight),
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => (el.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 40)
      .slice(0, 40);
    const storageKeys: string[] = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) storageKeys.push(`${k}(${(window.localStorage.getItem(k) ?? "").length})`);
      }
    } catch {
      /* ignore */
    }
    const bodyText = (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      url: location.href,
      title: document.title,
      inputs,
      buttons,
      storageKeys,
      cookieNames: document.cookie.split(";").map((c) => c.split("=")[0]?.trim()).filter(Boolean),
      hasLoginText: /log in|email, phone/i.test(bodyText),
      bodySample: bodyText.slice(0, 240),
    };
  });

  console.log(JSON.stringify(facts, null, 2));
  const shot = await screenshot(page, `inspect-${arg}`);
  console.log(`screenshot: ${shot}`);
} finally {
  await ctx.close();
}
