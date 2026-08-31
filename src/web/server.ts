import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { loadSeasonProjections } from "../analysis/projections.ts";
import { rankByVor } from "../analysis/vor.ts";
import { loadPlayers } from "../data/players.ts";
import { describeScoring } from "../analysis/scoring.ts";
import { runAgent, type AgentEvent } from "../agent/runner.ts";
import { recentEvents } from "../log.ts";
import { allPosts } from "../blog/store.ts";
import { readGuidanceState, setGuidance } from "./guidance.ts";
import { draftView } from "./draftview.ts";
import { seasonWeek, seasonIntent } from "./seasonview.ts";
import { statSync, openSync, readSync, closeSync } from "node:fs";

const ACTIVITY_LOG = process.env.ACTIVITY_LOG ?? "/data/sleeper-coach/activity.jsonl";
const REASONING_LOG = process.env.REASONING_LOG ?? "/data/sleeper-coach/reasoning.jsonl";

// The dashboard server. Serves the single-page UI, a state endpoint for the
// board/roster panels, and an SSE chat endpoint that streams the agent's
// reasoning live (spotify-dj pattern). idleTimeout: 0 so SSE survives long
// thinking pauses.

const PORT = Number(process.env.WEB_PORT ?? 8770);
const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;
// Build the noVNC embed URL, auto-supplying the VNC password from the server's
// own env so the takeover tab connects with no prompt (behind Authelia + HTTPS).
const NOVNC_BASE = process.env.NOVNC_BASE ?? "https://coach-vnc.filipkin.com/vnc.html";
const NOVNC_URL = (() => {
  const q = new URLSearchParams({ autoconnect: "1", resize: "scale" });
  if (process.env.WEB_PASS) q.set("password", process.env.WEB_PASS);
  return `${NOVNC_BASE}?${q.toString()}`;
})();

async function stateJson(): Promise<Response> {
  const [league, users, rosters, players] = await Promise.all([
    sleeper.league(config.leagueId),
    sleeper.leagueUsers(config.leagueId),
    sleeper.rosters(config.leagueId),
    loadPlayers(),
  ]);
  const projections = await loadSeasonProjections(config.season, league.scoring_settings);
  const ranked = rankByVor(projections, league).slice(0, 60);

  const me = rosters.find((r) => r.roster_id === config.rosterId);
  const myPlayers = (me?.players ?? []).map((pid) => {
    const p = players[pid];
    return { id: pid, name: p ? (p.full_name ?? `${p.first_name} ${p.last_name}`) : pid, pos: p?.position ?? "?", team: p?.team ?? "?", injury: p?.injury_status ?? null };
  });

  const draft = await sleeper.draft(config.draftId);

  return Response.json({
    league: { name: league.name, teams: league.total_rosters, scoring: describeScoring(league.scoring_settings), status: league.status },
    draft: { type: draft.type, status: draft.status, rounds: draft.settings.rounds, clock: draft.settings.pick_timer, startTime: draft.start_time },
    team: { name: users.find((u) => u.user_id === me?.owner_id)?.metadata?.team_name ?? "--dangerously-skip-perms", rosterId: config.rosterId },
    roster: myPlayers,
    board: ranked.map((r) => ({ name: r.name, pos: `${r.position}${r.posRank}`, team: r.team, pts: r.points, vor: r.vor, adp: r.adp >= 999 ? null : r.adp, tier: r.tier, injury: r.injuryStatus })),
    novncUrl: NOVNC_URL,
  });
}

function sseChat(req: Request): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const ping = setInterval(() => controller.enqueue(enc.encode(`: ping\n\n`)), 15000);
      try {
        const body = (await req.json()) as { message: string; sessionId?: string };
        send("session", { sessionId: body.sessionId ?? null });
        const result = await runAgent({
          prompt: body.message,
          sessionId: body.sessionId,
          onEvent: (ev: AgentEvent) => send("message", ev),
        });
        send("done", { sessionId: result.sessionId, exitCode: result.exitCode });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

// Live activity stream: tail the append-only JSONL and push each new event over
// SSE as it's written. The draft engine runs in a SEPARATE process and only
// shares the log file, so we tail the file (poll its size) rather than an
// in-process bus. This is what makes the coach's draft thinking — its live board
// view, plans and picks — visible in the dashboard console in real time.
function sseActivityStream(): Response {
  const enc = new TextEncoder();
  let tick: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  // Tail both the durable activity log and the transient reasoning channel, each
  // with its own byte offset, so decisions and live model thinking interleave.
  const files = [ACTIVITY_LOG, REASONING_LOG];
  const offsets = files.map((f) => { try { return statSync(f).size; } catch { return 0; } });
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      // Seed with recent decision history so a freshly-opened console isn't blank
      // (reasoning is transient — not replayed).
      for (const ev of recentEvents(40)) send("event", ev);
      const drain = (path: string, i: number) => {
        let off = offsets[i] ?? 0;
        let size: number;
        try { size = statSync(path).size; } catch { return; }
        if (size < off) off = 0; // truncated/rotated
        if (size <= off) { offsets[i] = off; return; }
        try {
          const fd = openSync(path, "r");
          const buf = Buffer.allocUnsafe(size - off);
          const read = readSync(fd, buf, 0, buf.length, off);
          closeSync(fd);
          const chunk = buf.subarray(0, read).toString("utf8");
          const lastNl = chunk.lastIndexOf("\n");
          if (lastNl === -1) { offsets[i] = off; return; } // no complete line yet
          offsets[i] = off + Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
          for (const line of chunk.slice(0, lastNl).split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try { send("event", JSON.parse(t)); } catch { /* skip bad line */ }
          }
        } catch { /* ignore read races */ }
      };
      tick = setInterval(() => files.forEach(drain), 1000);
      ping = setInterval(() => controller.enqueue(enc.encode(`: ping\n\n`)), 15000);
    },
    cancel() { if (tick) clearInterval(tick); if (ping) clearInterval(ping); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    // Public (no-auth at nginx) blog surface: the reader-facing retrospectives.
    if (url.pathname === "/api/blog") return Response.json({ posts: allPosts() });
    if (url.pathname === "/blog" || url.pathname === "/blog/") {
      const file = Bun.file(`${PUBLIC_DIR}blog.html`);
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
    }
    // The IN-SEASON app: the replacement for the Sleeper app on Filip's phone.
    // Served at /season rather than / so the draft dashboard (and its tested
    // guidance box) keeps working untouched; the PWA manifest's start_url points
    // here, so the installed home-screen icon opens straight to it.
    // THE SEASON VIEW IS THE HOME PAGE. Filip: "the main page is still not very
    // mobile optimised", and he is right, because I scoped the season UI brief to
    // /season and never mentioned the existing dashboard. In-season the season
    // view IS what he opens on a phone, and the draft dashboard is a once-a-year
    // tool, so the fix is the routing rather than retrofitting the old page.
    // The draft dashboard stays reachable at /draft, unchanged.
    if (url.pathname === "/" || url.pathname === "/season" || url.pathname === "/season/") {
      const file = Bun.file(`${PUBLIC_DIR}season.html`);
      if (await file.exists()) {
        return new Response(file, {
          // The service worker owns the offline copy, so the browser should always
          // revalidate this shell rather than hold its own stale one.
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
    }
    // Read-only season endpoints. /week is the hot path during live scoring and is
    // server-cached inside seasonview.ts, so any number of polling clients cannot
    // rate-limit Sleeper. /intent is the slower trade and waiver analysis (it needs
    // rest-of-season projections) and is fetched separately so the scoreboard never
    // waits on it.
    if (url.pathname === "/api/season/week") {
      const w = Number(url.searchParams.get("w"));
      return seasonWeek(Number.isFinite(w) && w > 0 ? w : undefined)
        .then((v) => Response.json(v, { headers: { "Cache-Control": "no-store" } }))
        .catch((e) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
    }
    if (url.pathname === "/api/season/intent") {
      const w = Number(url.searchParams.get("w"));
      return seasonIntent(Number.isFinite(w) && w > 0 ? w : undefined)
        .then((v) => Response.json(v, { headers: { "Cache-Control": "no-store" } }))
        .catch((e) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
    }
    if (url.pathname === "/api/stream") return sseActivityStream();
    if (url.pathname === "/api/activity") return Response.json({ events: recentEvents(150) });
    if (url.pathname === "/api/state") return stateJson().catch((e) => Response.json({ error: String(e) }, { status: 500 }));
    // Problem 2: everything the engine is about to do, read-only (plan + age,
    // backstop queue, roster byes, recent overrides).
    if (url.pathname === "/api/draftview") return draftView().then((v) => Response.json(v)).catch((e) => Response.json({ error: String(e) }, { status: 500 }));
    // Problem 1: live guidance to the draft agent. GET the guidance in effect;
    // POST { guidance } to rebuild system-prompt.md from the pristine base so the
    // agent picks it up on its next plan refresh (about 20s). This is the channel
    // that actually reaches a running draft; the /api/chat box below does not.
    if (url.pathname === "/api/guidance" && req.method === "GET")
      return readGuidanceState().then((g) => Response.json(g)).catch((e) => Response.json({ error: String(e) }, { status: 500 }));
    if (url.pathname === "/api/guidance" && req.method === "POST")
      return req.json()
        .then((b) => setGuidance(String((b as { guidance?: unknown }).guidance ?? "")))
        .then((g) => Response.json(g))
        .catch((e) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
    if (url.pathname === "/api/chat" && req.method === "POST") return sseChat(req);
    // Static: index at root, else serve files from public/.
    // /draft serves the draft-day dashboard that used to live at /.
    const rel =
      url.pathname === "/draft" || url.pathname === "/draft/"
        ? "index.html"
        : url.pathname === "/"
          ? "index.html" // unreachable now, kept so a routing change cannot 404 the root
          : url.pathname.slice(1);
    const file = Bun.file(`${PUBLIC_DIR}${rel}`);
    if (await file.exists()) {
      // A cached service worker is a stuck app: the browser keeps serving the old
      // one and a new build never lands. Always revalidate it.
      if (url.pathname === "/sw.js") {
        return new Response(file, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return new Response(file);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[web] dashboard on http://127.0.0.1:${PORT}`);
