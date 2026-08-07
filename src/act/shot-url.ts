#!/usr/bin/env bun
// Dev helper: screenshot any URL with a throwaway (non-persistent) browser, so
// it never touches the logged-in Sleeper profile. Used to self-review the
// dashboard UI.  bun run src/act/shot-url.ts <url> <name>

import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8770";
const name = process.argv[3] ?? "shot";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const path = `/data/sleeper-coach/shots/${name}.png`;
await page.screenshot({ path });
console.log(`saved ${path}`);
await browser.close();
