#!/usr/bin/env bun
// The `act` CLI: a thin client of the browser-server's local HTTP API. This is
// the only surface that touches the Sleeper account. Claude calls these as its
// hands. All browser work happens in the browser-server process.
//
//   act login-check                    is the browser logged in?
//   act dom [url]                      dump DOM facts (selector discovery)
//   act goto <url>                     navigate the persistent browser
//   act shot [name]                    screenshot the current page
//   act pick <player>                  draft a player
//   act queue <p1;p2;...>              set the autopick draft queue
//   act lineup <id1,id2,...>           set the week's starters
//   act trade-respond <txid> accept|reject
//   act trade-send <json>              send a trade offer
//   act import-session [file]          transplant a logged-in session

const API = process.env.BROWSER_API ?? "http://127.0.0.1:9223";
const [command, ...args] = process.argv.slice(2);

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.error) throw new Error(String(j.error ?? res.statusText));
  return j;
}

async function main(): Promise<void> {
  switch (command) {
    case "login-check": {
      const ok = (await call("/login-check")).loggedIn === true;
      console.log(ok ? "LOGGED_IN" : "LOGGED_OUT");
      process.exit(ok ? 0 : 3);
    }
    case "on-clock": {
      const on = (await call("/on-clock")).onClock === true;
      console.log(on ? "ON_CLOCK" : "NOT_ON_CLOCK");
      process.exit(on ? 0 : 3);
    }
    case "dom": {
      console.log(JSON.stringify(await call("/dom", args[0] ? { url: args[0] } : {}), null, 2));
      break;
    }
    case "goto": {
      console.log((await call("/goto", { url: args[0] })).url);
      break;
    }
    case "shot": {
      console.log(`saved ${(await call("/shot", { name: args[0] ?? "current" })).path}`);
      break;
    }
    case "pick": {
      const player = args.join(" ").trim();
      if (!player) throw new Error("usage: act pick <player name>");
      await call("/pick", { player });
      console.log(`picked ${player}`);
      break;
    }
    case "queue": {
      const players = args.join(" ").split(";").map((s) => s.trim()).filter(Boolean);
      await call("/queue", { players });
      console.log(`queued ${players.length} players`);
      break;
    }
    case "lineup": {
      const ids = (args[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      await call("/lineup", { ids });
      console.log(`set lineup: ${ids.length} starters`);
      break;
    }
    case "trade-respond": {
      const [txid, decision] = args;
      if (!txid || (decision !== "accept" && decision !== "reject")) throw new Error("usage: act trade-respond <txid> accept|reject");
      await call("/trade-respond", { txid, decision });
      console.log(`${decision}ed trade ${txid}`);
      break;
    }
    case "trade-send": {
      const spec = JSON.parse(args.join(" ") || "{}");
      await call("/trade-send", { spec });
      console.log("trade sent");
      break;
    }
    case "import-session": {
      const file = args[0] ?? "/data/sleeper-coach/session.json";
      const raw = (await Bun.file(file).json()) as Record<string, unknown>;
      const entries = (raw.localStorage && typeof raw.localStorage === "object" ? raw.localStorage : raw) as Record<string, string>;
      const cookies = Array.isArray(raw.cookies) ? raw.cookies : undefined;
      const ok = (await call("/import-session", { entries, cookies })).ok === true;
      console.log(ok ? "SESSION_OK" : "SESSION_FAILED");
      process.exit(ok ? 0 : 5);
    }
    default:
      console.log("commands: login-check | dom [url] | goto <url> | shot [name] | pick <player> | queue <p1;p2> | lineup <ids> | trade-respond <txid> accept|reject | trade-send <json> | import-session [file]");
      process.exit(command ? 1 : 0);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`act failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
