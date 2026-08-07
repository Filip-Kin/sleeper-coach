#!/usr/bin/env bun
// Verify the anti-detection patches on a throwaway profile (no touch to the
// real login profile). Prints the fingerprints a bot check would read.

import { launchContext, firstPage } from "./browser.ts";

const ctx = await launchContext({ profileDir: "/tmp/stealth-check-profile" });
const page = await firstPage(ctx);
await page.goto("about:blank");
const fp = await page.evaluate(() => ({
  webdriver: navigator.webdriver,
  plugins: navigator.plugins.length,
  languages: navigator.languages,
  hasChrome: typeof (window as unknown as { chrome?: unknown }).chrome !== "undefined",
  ua: navigator.userAgent,
}));
console.log(JSON.stringify(fp, null, 2));
await ctx.close();
