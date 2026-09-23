// The soak's two halves. `before` seeds the scratch state and snapshots what
// must not change; `after` reads everything back and prints one PASS/FAIL
// line per assertion, exiting non-zero if any failed. scripts/soak.sh runs the
// real daemon between the two with the staging isolation env.
//
// Everything here is a read, except the writes into the scratch state dir
// (SOAK_DIR). The production state dir (PROD_STATE) is only ever stat'ed and
// read. The real league is only ever read over the public REST API.
//
// Why each assertion exists is next to it. The short version: every one of
// them is a thing that went wrong in September 2026 without any test noticing.

import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config, isStagingTarget, REAL_LEAGUE_ID } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { leagueRosters } from "../sleeper/graphql.ts";
import { buildRosterView } from "../analysis/roster-view.ts";
import { activeCapacity } from "../analysis/roster-fit.ts";
import { SLOT_ELIGIBILITY, startingSlots } from "../analysis/lineup.ts";
import { JOBS } from "../schedule.ts";
import { tokenGql, pendingClaimSlots, pendingTrades } from "../league/api.ts";
import { FINAL_WINDOW_MIN } from "../pickem/strategy.ts";
import { readHeartbeat } from "../heartbeat.ts";
import { DB_PATH, KICKOFF_CACHE, ACTIVITY_LOG } from "../paths.ts";
import type { ActivityEvent } from "../log.ts";

const SOAK_DIR = process.env.SOAK_DIR ?? "/tmp/soak";
const PROD_STATE = process.env.PROD_STATE ?? "/data/sleeper-coach";
const SOAK_POLLS = Number(process.env.SOAK_POLLS ?? 20);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const SNAPSHOT = join(SOAK_DIR, "before.json");
const DAEMON_LOG = process.env.SOAK_LOG ?? join(SOAK_DIR, "daemon.log");

interface TxSnap { id: string; status: string }
interface RosterSnap { players: string[]; starters: string[]; reserve: string[] }
interface Snapshot {
  at: number;
  week: number;
  prodTransactions: TxSnap[];
  stagingRoster: RosterSnap;
  prodMtimes: Record<string, number>;
  prodActivityBytes: number;
  prodAutoDrops: number | null;
}

// #region helpers
function fail(msg: string): never {
  console.error(`soak: ${msg}`);
  process.exit(2);
}

async function prodTransactions(week: number): Promise<TxSnap[]> {
  const out: TxSnap[] = [];
  for (const w of new Set([week, Math.max(1, week - 1)])) {
    const rows = (await sleeper.transactions(REAL_LEAGUE_ID, w)) as { transaction_id?: string; status?: string }[];
    for (const r of rows) if (r.transaction_id) out.push({ id: r.transaction_id, status: String(r.status ?? "") });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function stagingRoster(): Promise<{ snap: RosterSnap; cap: number; slots: string[] }> {
  const [league, rosters] = await Promise.all([sleeper.league(config.leagueId), leagueRosters(config.leagueId)]);
  const mine = rosters.find((r) => r.roster_id === config.rosterId);
  if (!mine) fail(`roster ${config.rosterId} not in league ${config.leagueId}`);
  return {
    snap: { players: (mine.players ?? []).map(String), starters: (mine.starters ?? []).map(String), reserve: (mine.reserve ?? []).map(String) },
    cap: activeCapacity(league.roster_positions),
    slots: startingSlots(league.roster_positions),
  };
}

function walkMtimes(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const visit = (dir: string): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p);
      else out[relative(root, p)] = st.mtimeMs;
    }
  };
  visit(root);
  return out;
}

function prodAutoDrops(): number | null {
  const p = join(PROD_STATE, "coach.db");
  if (!existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true });
    try {
      const has = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'auto_drops'").get();
      if (!has?.n) return 0;
      return db.query<{ n: number }, []>("SELECT count(*) AS n FROM auto_drops").get()?.n ?? 0;
    } finally { db.close(); }
  } catch {
    return null;
  }
}

function readEvents(path: string): ActivityEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as ActivityEvent]; } catch { return []; }
  });
}

/** Files the frozen production daemon and dashboard write on their own while
 *  the soak runs, so a changed mtime there proves nothing either way. The
 *  content checks below cover them instead. */
const PROD_ALLOWED = new Set(["activity.jsonl", "reasoning.jsonl", "heartbeat", "coach.db", "coach.db-journal", "coach.db-wal", "coach.db-shm"]);
function prodAllowed(rel: string): boolean {
  return PROD_ALLOWED.has(rel) || rel.startsWith("config/");
}
// #endregion

// #region before
async function before(): Promise<void> {
  if (!isStagingTarget) fail(`refusing: config points at league ${config.leagueId}, which is not staging`);
  const now = Date.now();
  const state = await sleeper.nflState();
  const week = Math.max(1, state.week || 1);

  // The pick'em pool has no staging twin: a pre-kickoff pass fired during the
  // soak would submit REAL picks. Refuse to start inside the window.
  if (existsSync(KICKOFF_CACHE)) {
    const cache = JSON.parse(readFileSync(KICKOFF_CACHE, "utf8")) as { games?: { startTime?: number; label?: string }[] };
    const horizon = now + FINAL_WINDOW_MIN * 60_000 + SOAK_POLLS * POLL_MS + 120_000;
    const soon = (cache.games ?? []).filter((g) => typeof g.startTime === "number" && g.startTime > now && g.startTime <= horizon);
    if (soon.length) fail(`a pick'em kickoff is inside the window (${soon.map((g) => g.label ?? "?").join(", ")}); the daemon would submit real picks. Run the soak later.`);
  }

  // Seed the scratch DB so nothing fires on poll 1: every job reads as having
  // run this occurrence, every existing staging transaction as already seen.
  const db = new Database(DB_PATH);
  db.run("CREATE TABLE IF NOT EXISTS scheduled_runs (job TEXT PRIMARY KEY, last_run INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS seen_transactions (transaction_id TEXT PRIMARY KEY, status TEXT, first_seen INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS drop_reactions (transaction_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  const force = process.env.SOAK_FORCE_JOB ?? "";
  for (const j of JOBS) {
    if (j.name === force) continue;
    db.run("INSERT OR REPLACE INTO scheduled_runs (job, last_run) VALUES (?, ?)", [j.name, now]);
  }
  for (const w of new Set([week, Math.max(1, week - 1)])) {
    const rows = (await sleeper.transactions(config.leagueId, w)) as { transaction_id?: string; status?: string }[];
    for (const r of rows) {
      if (!r.transaction_id) continue;
      db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [r.transaction_id, String(r.status ?? ""), now]);
      db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [`done:${r.transaction_id}`, "completed", now]);
      db.run("INSERT OR REPLACE INTO drop_reactions (transaction_id, at) VALUES (?, ?)", [r.transaction_id, now]);
    }
  }
  // Proposed trades are NOT in the REST transaction list (the 2026-09-02
  // blind spot), so read them the way the daemon does and mark them seen too:
  // an open offer on staging must not wake the agent during a soak.
  try {
    for (const t of await pendingTrades(tokenGql(), week)) {
      db.run("INSERT OR REPLACE INTO seen_transactions (transaction_id, status, first_seen) VALUES (?, ?, ?)", [t.transactionId, t.status, now]);
    }
  } catch (err) {
    console.log(`soak: could not read proposed trades on staging (${err instanceof Error ? err.message : String(err)}); continuing`);
  }
  db.close();

  const snap: Snapshot = {
    at: now, week,
    prodTransactions: await prodTransactions(week),
    stagingRoster: (await stagingRoster()).snap,
    prodMtimes: walkMtimes(PROD_STATE),
    prodActivityBytes: existsSync(join(PROD_STATE, "activity.jsonl")) ? statSync(join(PROD_STATE, "activity.jsonl")).size : 0,
    prodAutoDrops: prodAutoDrops(),
  };
  await Bun.write(SNAPSHOT, JSON.stringify(snap));
  console.log(`soak: seeded ${JOBS.length - (force ? 1 : 0)} job(s)${force ? ` (forcing ${force})` : ""}, snapshot of ${Object.keys(snap.prodMtimes).length} production files, ${snap.prodTransactions.length} real-league transaction(s), staging roster ${snap.stagingRoster.players.length}/${snap.stagingRoster.reserve.length} (players/IR)`);
}
// #endregion

// #region after
interface Check { name: string; ok: boolean; detail: string }

async function after(): Promise<void> {
  if (!isStagingTarget) fail(`refusing: config points at league ${config.leagueId}, which is not staging`);
  if (!existsSync(SNAPSHOT)) fail(`no snapshot at ${SNAPSHOT}; run \`before\` first`);
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  const log = existsSync(DAEMON_LOG) ? readFileSync(DAEMON_LOG, "utf8") : "";
  const lines = log.split("\n");
  const events = readEvents(ACTIVITY_LOG);
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

  // 1. The very first thing the process said was which league it is on.
  {
    const first = lines.find((l) => l.trim().length > 0) ?? "";
    push("1 first line names the staging target", first.includes("STAGING TARGET") && first.includes(config.leagueId), first.slice(0, 120) || "(empty log)");
  }

  // 2. No alert escaped the staging guard.
  {
    const bad = lines.filter((l) => l.includes("[alert]") && !l.includes("(staging, not sent)"));
    push("2 every [alert] line is marked (staging, not sent)", bad.length === 0, bad.length ? bad.slice(0, 3).join(" | ") : `${lines.filter((l) => l.includes("[alert]")).length} alert line(s), all guarded`);
  }

  // 3. The loop never threw and no job failed.
  {
    const evs = events.filter((e) => e.type === "poll-error" || e.type === "schedule-failed");
    const logHits = lines.filter((l) => l.includes("[daemon] poll error"));
    push("3 zero poll-error / schedule-failed", evs.length === 0 && logHits.length === 0, evs.length || logHits.length ? `${evs.map((e) => `${e.type}: ${e.summary}`).concat(logHits).slice(0, 3).join(" | ")}` : "none");
  }

  const live = await stagingRoster();
  const view = buildRosterView({ roster_id: config.rosterId, owner_id: null, players: live.snap.players, starters: live.snap.starters, reserve: live.snap.reserve, keepers: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0 }, player_map: {} }, { allowRest: true });

  // 4. At most one automatic drop, and only as a reconcile that left us legal.
  {
    const dropped = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "roster-dropped");
    let ok = dropped.length <= 1;
    let detail = `${dropped.length} roster-dropped event(s)`;
    if (dropped.length === 1) {
      const idx = dropped[0]!.i;
      const preceded = events.slice(0, idx).some((e) => e.type === "roster-reconcile");
      const atCap = view.active.length === live.cap;
      ok = preceded && atCap;
      detail += `; reconcile before it: ${preceded}; active ${view.active.length}/${live.cap} after`;
    }
    push("4 roster-dropped <= 1, reconcile-led, at cap after", ok, detail);
  }

  // 5. The staging roster is structurally legal.
  {
    const playerSet = new Set(live.snap.players);
    const reserveSet = new Set(live.snap.reserve);
    const problems: string[] = [];
    if (view.active.length > live.cap) problems.push(`${view.active.length} active > cap ${live.cap}`);
    const notOwned = live.snap.reserve.filter((id) => !playerSet.has(id));
    if (notOwned.length) problems.push(`reserve not in players: ${notOwned.join(",")}`);
    const irStarters = live.snap.starters.filter((s) => reserveSet.has(s));
    if (irStarters.length) problems.push(`starters on IR: ${irStarters.join(",")}`);
    const starterSet = new Set(live.snap.starters.filter((s) => s !== "0"));
    // Positions come from the live player_map; the roster read above went
    // through leagueRosters so it has one.
    const rosters = await leagueRosters(config.leagueId);
    const mine = rosters.find((r) => r.roster_id === config.rosterId);
    const pm = mine?.player_map ?? {};
    live.slots.forEach((slot, i) => {
      if ((live.snap.starters[i] ?? "0") !== "0") return;
      const bench = view.active.filter((e) => !starterSet.has(e.playerId));
      const fit = bench.filter((e) => {
        const pos = pm[e.playerId]?.position ?? (/^[A-Z]{2,4}$/.test(e.playerId) ? "DEF" : "?");
        return SLOT_ELIGIBILITY[slot]?.has(pos);
      });
      if (fit.length) problems.push(`${slot} empty with ${fit.length} eligible on the bench`);
    });
    push("5 staging roster legal (cap, reserve subset, no IR starter, no fillable 0)", problems.length === 0, problems.join("; ") || `${view.active.length}/${live.cap} active, ${live.snap.reserve.length} IR, ${live.snap.starters.filter((s) => s !== "0").length} starters`);
  }

  // 6. What the log says was written is what the site holds.
  {
    const writes = events.filter((e) => e.type === "lineup-auto" || e.type === "lineup-set");
    if (!writes.length) push("6 lineup events match the read-back", true, "no lineup writes during the run");
    else {
      const last = writes[writes.length - 1]!;
      const ids = ((last.detail as { ids?: unknown })?.ids ?? []) as unknown[];
      const want = ids.map(String).join(",");
      const got = live.snap.starters.join(",");
      const wrongLeague = writes.filter((e) => { const l = (e.detail as { leagueId?: unknown })?.leagueId; return l !== undefined && String(l) !== config.leagueId; });
      push("6 lineup events match the read-back", want === got && wrongLeague.length === 0, want === got ? `${writes.length} write(s); last matches the site` : `event ids ${want} vs site ${got}`);
    }
  }

  // 7. Every pending claim has a slot to land in.
  {
    let detail = "";
    let ok = true;
    try {
      const claims = await pendingClaimSlots(tokenGql(), snap.week);
      const open = Math.max(0, live.cap - view.active.length);
      ok = claims.count <= open;
      detail = `${claims.count} pending claim(s), ${open} open slot(s)`;
    } catch (err) {
      ok = false;
      detail = `read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    push("7 pending claims each have a slot", ok, detail);
  }

  // 8. The loop ran every poll it was asked to and exited on its own.
  {
    const hb = readHeartbeat();
    const rc = process.env.SOAK_DAEMON_RC ?? "?";
    const ok = hb !== null && hb.poll === SOAK_POLLS && rc === "0";
    push("8 poll count == SOAK_POLLS and clean exit", ok, hb ? `heartbeat poll ${hb.poll}/${SOAK_POLLS}, daemon rc ${rc}` : `no heartbeat file (daemon not wired with heartbeat()/SOAK_POLLS), daemon rc ${rc}`);
  }

  // 9. Nothing on the production volume was touched by this process.
  {
    const now = walkMtimes(PROD_STATE);
    const changed = Object.keys({ ...snap.prodMtimes, ...now }).filter((k) => snap.prodMtimes[k] !== now[k] && !prodAllowed(k));
    const problems: string[] = [];
    if (changed.length) problems.push(`changed: ${changed.slice(0, 5).join(", ")}`);
    // The frozen production daemon appends to its own log during the run, so
    // read what it appended and make sure none of it is ours: a daemon start
    // always logs `online`, and a deploy logs `deploy`.
    const actPath = join(PROD_STATE, "activity.jsonl");
    if (existsSync(actPath)) {
      const size = statSync(actPath).size;
      if (size > snap.prodActivityBytes) {
        const buf = Buffer.alloc(size - snap.prodActivityBytes);
        const fd = openSync(actPath, "r");
        readSync(fd, buf, 0, buf.length, snap.prodActivityBytes);
        closeSync(fd);
        const mine = buf.toString("utf8").split("\n").filter((l) => /"type":"(online|deploy)"/.test(l));
        if (mine.length) problems.push(`${mine.length} daemon-start event(s) appended to the production activity log`);
      }
    }
    const drops = prodAutoDrops();
    if (drops !== snap.prodAutoDrops) problems.push(`production auto_drops ${snap.prodAutoDrops} -> ${drops}`);
    push("9 production state dir untouched", problems.length === 0, problems.join("; ") || `${Object.keys(now).length} files, none outside the daemon's own allowlist changed`);
  }

  // 10. The real league saw no transaction from us.
  {
    const now = await prodTransactions(snap.week);
    const same = JSON.stringify(now) === JSON.stringify(snap.prodTransactions);
    push("10 real-league transaction list unchanged", same, same ? `${now.length} transaction(s), identical` : `${snap.prodTransactions.length} before, ${now.length} after`);
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
    if (!c.ok) failed += 1;
  }
  console.log(`soak: ${checks.length - failed}/${checks.length} assertions passed`);
  process.exit(failed ? 1 : 0);
}
// #endregion

const mode = process.argv[2];
if (mode === "before") await before();
else if (mode === "after") await after();
else fail("usage: assert.ts before|after");
