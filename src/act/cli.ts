#!/usr/bin/env bun
// The `act` CLI: the hands on the Sleeper account, every one a GraphQL call
// with the session token. Claude and Filip call these; the daemon's jobs call
// the same league/api.ts helpers directly.
//
//   act token import <token|->        save a fresh session token (stdin with -), then verify it with `me`
//   act token check                   does `me` answer, and when does the JWT expire
//   act login-check                   same check; exits 0 LOGGED_IN or 3 LOGGED_OUT
//   act lineup <id1,id2,...>          set the week's starters (order = league slot order)
//   act trade-respond <txid> accept|reject <week> [leagueId]
//   act trade-send <json>             propose a trade; json is a ProposalSpec (adds/drops maps of player_id -> roster_id)
//
// The browser commands (pick, queue, shot, dom, goto, console, import-session,
// trade-capture) went with the browser on 2026-09-09.

import { config } from "../config.ts";
import { acceptTrade, probeToken, proposeTrade, rejectTrade, tokenGql, updateStarters, type ProposalSpec } from "../league/api.ts";
import { assessToken, jwtExpiry, TOKEN_FILE, writeToken } from "../league/token.ts";

const [command, ...args] = process.argv.slice(2);

async function readTokenArg(arg: string | undefined): Promise<string> {
  if (!arg) throw new Error("usage: act token import <token|->");
  const raw = arg === "-" ? await Bun.stdin.text() : arg;
  const tok = raw.trim();
  if (!tok) throw new Error("empty token");
  if (tok.split(".").length !== 3) throw new Error("that does not look like a JWT (expected three dot-separated parts)");
  return tok;
}

async function checkToken(): Promise<boolean> {
  const verdict = assessToken(await probeToken(), Date.now());
  console.log(`token: ${verdict.summary}`);
  if (verdict.alert) console.log(verdict.alert);
  return verdict.usable;
}

async function main(): Promise<void> {
  switch (command) {
    case "token": {
      const [sub, value] = args;
      if (sub === "import") {
        const tok = await readTokenArg(value);
        // Verify BEFORE writing, so a typo cannot overwrite a working token.
        const body = await tokenGql({ token: tok })("{me{user_id display_name}}");
        const me = (body.data as { me?: { user_id?: string; display_name?: string } } | undefined)?.me;
        if (!me?.user_id) throw new Error("me returned nothing for that token");
        if (me.user_id !== config.userId) {
          throw new Error(`that token belongs to ${me.display_name ?? me.user_id}, not ${config.username} (${config.userId})`);
        }
        writeToken(tok);
        const exp = jwtExpiry(tok);
        console.log(`saved ${TOKEN_FILE} (mode 600) for ${me.display_name ?? me.user_id}; expires ${exp ? new Date(exp).toISOString() : "unknown"}`);
        break;
      }
      if (sub === "check") {
        process.exit((await checkToken()) ? 0 : 3);
      }
      throw new Error("usage: act token import <token|-> | act token check");
    }
    case "login-check": {
      const ok = await checkToken();
      console.log(ok ? "LOGGED_IN" : "LOGGED_OUT");
      process.exit(ok ? 0 : 3);
    }
    case "lineup": {
      const ids = (args[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new Error("usage: act lineup <id1,id2,...>");
      const back = await updateStarters(tokenGql(), ids);
      console.log(`set lineup: ${back.length} starters (${back.join(",")})`);
      break;
    }
    case "trade-respond": {
      const [txid, decision, week, leagueId] = args;
      const leg = Number(week);
      if (!txid || (decision !== "accept" && decision !== "reject") || !Number.isInteger(leg)) {
        throw new Error("usage: act trade-respond <txid> accept|reject <week> [leagueId]");
      }
      const fn = decision === "accept" ? acceptTrade : rejectTrade;
      const status = await fn(tokenGql(), txid, leg, leagueId ?? config.leagueId);
      console.log(`${decision}ed trade ${txid}: ${status}`);
      break;
    }
    case "trade-send": {
      const spec = JSON.parse(args.join(" ") || "{}") as ProposalSpec & { leagueId?: string };
      const { leagueId, ...rest } = spec;
      const r = await proposeTrade(tokenGql(), rest, leagueId ?? config.leagueId);
      console.log(`trade sent: ${r.transactionId} ${r.status}`);
      break;
    }
    default:
      console.log("commands: token import <token|-> | token check | login-check | lineup <ids> | trade-respond <txid> accept|reject <week> [leagueId] | trade-send <json>");
      process.exit(command ? 1 : 0);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`act failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
