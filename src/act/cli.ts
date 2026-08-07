#!/usr/bin/env bun
// The `act` CLI: the ONLY surface that touches the Sleeper account. Claude
// calls these commands as its hands. Every command opens the persistent
// browser, performs one action, reads the result back, and reports.
//
//   bun run act login-check          is the browser logged in to Sleeper?
//   bun run act shot <name>          screenshot the current league/draft page
//   bun run act pick <player>        draft a player
//   bun run act queue <p1;p2;...>    set the autopick draft queue
//   bun run act lineup <id1,id2,...> set the week's starters (player ids)
//   bun run act trade-respond <txid> accept|reject
//   bun run act trade-send <json>    send a trade offer
//
// Kept intentionally small and explicit so the agent's authority is auditable.

import { open, isLoggedIn, openForLogin, screenshot, makePick, setQueue, setLineup, respondTrade, sendTrade, leagueUrl } from "./sleeper.ts";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "login-check": {
      const { ctx, page } = await open();
      try {
        const ok = await isLoggedIn(page);
        console.log(ok ? "LOGGED_IN" : "LOGGED_OUT");
        process.exit(ok ? 0 : 3);
      } finally {
        await ctx.close();
      }
      break;
    }
    case "login-open": {
      console.log("Opening Sleeper login. Sign in via noVNC (coach-vnc.filipkin.com). Waiting up to 15 min…");
      const ok = await openForLogin();
      console.log(ok ? "LOGIN_SUCCESS" : "LOGIN_TIMEOUT");
      process.exit(ok ? 0 : 4);
      break;
    }
    case "shot": {
      const { ctx, page } = await open();
      try {
        await page.goto(leagueUrl(), { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);
        const path = await screenshot(page, args[0] ?? "current");
        console.log(`saved ${path}`);
      } finally {
        await ctx.close();
      }
      break;
    }
    case "pick": {
      const player = args.join(" ").trim();
      if (!player) throw new Error("usage: act pick <player name>");
      await withPage((page) => makePick(page, player));
      console.log(`picked ${player}`);
      break;
    }
    case "queue": {
      const players = args.join(" ").split(";").map((s) => s.trim()).filter(Boolean);
      await withPage((page) => setQueue(page, players));
      console.log(`queued ${players.length} players`);
      break;
    }
    case "lineup": {
      const ids = (args[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      await withPage((page) => setLineup(page, ids));
      console.log(`set lineup: ${ids.length} starters`);
      break;
    }
    case "trade-respond": {
      const [txid, decision] = args;
      if (!txid || (decision !== "accept" && decision !== "reject")) throw new Error("usage: act trade-respond <txid> accept|reject");
      await withPage((page) => respondTrade(page, txid, decision));
      console.log(`${decision}ed trade ${txid}`);
      break;
    }
    case "trade-send": {
      const spec = JSON.parse(args.join(" ") || "{}");
      await withPage((page) => sendTrade(page, spec));
      console.log("trade sent");
      break;
    }
    default:
      console.log("commands: login-check | shot <name> | pick <player> | queue <p1;p2> | lineup <ids> | trade-respond <txid> accept|reject | trade-send <json>");
      process.exit(command ? 1 : 0);
  }
}

async function withPage(fn: (page: import("playwright").Page) => Promise<void>): Promise<void> {
  const { ctx, page } = await open();
  try {
    await fn(page);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(`act failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
