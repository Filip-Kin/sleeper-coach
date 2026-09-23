// League operations that the public REST API cannot do, over Sleeper's GraphQL.
//
// WHY THIS EXISTS. On 2026-09-02 a real trade offer arrived and the coach never
// saw it. Two separate faults in one line of the old poll:
//
//   1. `GET /v1/league/<id>/transactions/<week>` does NOT return proposed
//      trades. The offer was live for hours and the endpoint listed only two
//      unrelated free-agent moves. Polling REST for pending trades cannot work.
//   2. The code tested `status === "pending"`. Sleeper's status string for an
//      offer awaiting a response is "proposed".
//
// GraphQL has all of it, and it also removes the fragile part of the design:
// `accept_trade` / `reject_trade` are plain mutations, so responding to an offer
// no longer needs the trades-page DOM that was never successfully built.
//
// Trade negotiation in this league happens in DMs, not the trade UI, so the DM
// surface is here too.
//
// TRANSPORT. Every call here is a direct HTTPS POST to https://sleeper.app/graphql
// with the session token as an `authorization` header. Until 2026-09-09 the
// same requests were relayed through a headed Brave (page.evaluate inside a
// logged-in profile) on the theory that Cloudflare would block a server-side
// fetch. Measured from the host with a bare fetch: me, my_dms and a no-op
// roster_update_starters all answered errors: null. The browser, its Xvfb and
// noVNC stack and the DOM code were then removed. Filip: "I want to get rid of
// all dom manipulation since it seems we can do everything through graphql."

import { config } from "../config.ts";
import { assertWritesAllowed, freezeNow } from "../killswitch.ts";
import { sendAlert } from "../alert.ts";
import { logEvent } from "../log.ts";
import { legsToScan, tradeInFlight as ruleTradeInFlight } from "../sleeper/rules.ts";
import { dropVerdict, recordDrop, DropRefused } from "./drop-ledger.ts";
import { leagueRosters, sportInfo, SLEEPER_GRAPHQL } from "../sleeper/graphql.ts";
import { buildRosterView, type RosterView } from "../analysis/roster-view.ts";
import { jwtExpiry, MissingTokenError, readToken, type TokenProbe } from "./token.ts";

export type Gql = (query: string) => Promise<Record<string, unknown>>;

/** Sleeper answered `code: "unauthorized"`: the token is missing server-side,
 *  revoked or expired. Distinct from a transport failure so the daemon can
 *  alert on it instead of retrying. */
export class SleeperAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SleeperAuthError";
  }
}

export interface TokenGqlOptions {
  /** Explicit token; default reads SLEEPER_TOKEN then the state file, once,
   *  on the first request. */
  token?: string;
  /** Where to read the token from when `token` is not given. */
  tokenFile?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type GqlBody = { data?: Record<string, unknown>; errors?: { code?: string; message?: string }[] | null };

/** A Gql that carries the session token. Returns the raw GraphQL body
 *  ({data, errors}) so the helpers below keep unwrapping it as before. 15 s
 *  timeout, one retry on 429 and 5xx, and a typed throw on a missing token or
 *  an unauthorized answer. */
export function tokenGql(opts: TokenGqlOptions = {}): Gql {
  const endpoint = opts.endpoint ?? SLEEPER_GRAPHQL;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let token = opts.token;
  return async (query: string) => {
    if (!token) token = readToken(opts.tokenFile); // throws MissingTokenError
    const post = () => doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token as string },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await post();
    if (res.status === 429 || res.status >= 500) {
      await Bun.sleep(500);
      res = await post();
    }
    if (!res.ok) throw new Error(`graphql transport: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as GqlBody;
    const unauthorized = (body.errors ?? []).find((e) => e.code === "unauthorized");
    if (unauthorized) {
      throw new SleeperAuthError(`graphql unauthorized: ${unauthorized.message ?? "the Sleeper token was rejected"}`);
    }
    return body as Record<string, unknown>;
  };
}

/** @deprecated The browser is gone. Same transport as tokenGql(); kept so
 *  callers written against the passthrough keep compiling. */
export const browserGql = (): Gql => tokenGql();

/** One probe for the daemon's auth check: does `me` answer, and when does the
 *  JWT expire. Never throws; every failure is a probe kind. */
export async function probeToken(gql?: Gql): Promise<TokenProbe> {
  let token: string;
  try {
    token = readToken();
  } catch (err) {
    if (err instanceof MissingTokenError) return { kind: "missing" };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const body = await (gql ?? tokenGql({ token }))("{me{user_id}}");
    const me = (body.data as { me?: { user_id?: string } } | undefined)?.me;
    if (!me?.user_id) return { kind: "error", message: "me returned no user_id" };
    return { kind: "ok", expMs: jwtExpiry(token) };
  } catch (err) {
    if (err instanceof SleeperAuthError) return { kind: "unauthorized" };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function unwrap(body: Record<string, unknown>, field: string): unknown {
  const errs = body.errors as { code?: string; message?: string }[] | undefined;
  const err = errs?.[0];
  if (err) throw new Error(`graphql ${field}: ${err.code ?? ""} ${err.message ?? ""}`.trim());
  return (body.data as Record<string, unknown> | undefined)?.[field];
}

function safeId(v: string): string {
  if (!/^[0-9]{1,25}$/.test(v)) throw new Error(`unsafe id: ${v}`);
  return v;
}
/** A Sleeper PLAYER id: numeric for people, the team code for a defense
 *  ("SEA", "KC"). safeId alone rejected every defense, so the streaming path
 *  that exists to cover the week-11 DEF bye would have thrown "unsafe id: SEA"
 *  on the write, after correctly planning the whole move. League, roster and
 *  transaction ids stay numeric-only. */
function safePlayerId(v: string): string {
  if (!/^([0-9]{1,25}|[A-Z]{2,4})$/.test(v)) throw new Error(`unsafe player id: ${v}`);
  return v;
}
/** GraphQL string literals take JSON escaping, which also neutralises quotes and
 *  newlines in anything a rival typed at us. */
const str = (v: string): string => JSON.stringify(v);

export interface PendingTrade {
  transactionId: string;
  status: string;
  type: string;
  rosterIds: number[];
  consenterIds: number[];
  /** player_id -> roster_id receiving him. */
  adds: Record<string, number>;
  drops: Record<string, number>;
  created: number;
  /** Sleeper's own expiry for a proposal (settings.expires_at, seconds), when present. */
  expiresAt?: number | null;
}

/** Trades awaiting a response. Sleeper calls this status "proposed". */
export async function pendingTrades(gql: Gql, leg: number, leagueId = config.leagueId): Promise<PendingTrade[]> {
  // Scan this leg and the previous one: an offer filed before the Tuesday
  // rollover is still open on Wednesday and lives under last week's leg.
  const seen = new Set<string>();
  const out: PendingTrade[] = [];
  for (const l of legsToScan(leg)) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"proposed",leg:${l})` +
      `{transaction_id status type roster_ids consenter_ids adds drops created settings}}`,
    );
    const raw = (unwrap(body, "league_transactions_by_status") ?? []) as Record<string, unknown>[];
    for (const t of raw) {
      if (t.type !== "trade") continue;
      const id = String(t.transaction_id ?? "");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        transactionId: id, status: String(t.status ?? ""), type: String(t.type ?? ""),
        rosterIds: (t.roster_ids as number[]) ?? [], consenterIds: (t.consenter_ids as number[]) ?? [],
        adds: (t.adds as Record<string, number>) ?? {}, drops: (t.drops as Record<string, number>) ?? {},
        created: Number(t.created ?? 0),
        expiresAt: typeof (t.settings as { expires_at?: unknown } | null)?.expires_at === "number" ? (t.settings as { expires_at: number }).expires_at : null,
      });
    }
  }
  return out;
}

async function respond(
  gql: Gql, action: "accept_trade" | "reject_trade", transactionId: string, leg: number, leagueId: string,
): Promise<string> {
  const body = await gql(
    `mutation{${action}(league_id:"${safeId(leagueId)}",transaction_id:"${safeId(transactionId)}",leg:${Math.trunc(leg)})` +
    `{transaction_id status}}`,
  );
  const r = (unwrap(body, action) ?? {}) as { status?: string };
  return String(r.status ?? "");
}

/** Accepting removes the players we give, so it passes the drop breaker too.
 *  `giveIds` is what leaves our roster; the caller knows it from the offer. A
 *  refusal throws DropRefused, which the caller treats as "defer", never as
 *  "reject": the offer is still good, the roster just moved too much this hour. */
export async function acceptTrade(gql: Gql, txId: string, leg: number, giveIds: string[] = [], leagueId = config.leagueId): Promise<string> {
  guardDrop("accept a trade", giveIds, "trade");
  const status = await respond(gql, "accept_trade", txId, leg, leagueId);
  recordDrops(giveIds, "trade");
  logEvent("coach", "write-trade-accept", `Accepted trade ${txId} (${status}).`, { transactionId: txId, give: giveIds, status, leg });
  return status;
}
export async function rejectTrade(gql: Gql, txId: string, leg: number, leagueId = config.leagueId): Promise<string> {
  assertWritesAllowed("reject a trade");
  const status = await respond(gql, "reject_trade", txId, leg, leagueId);
  logEvent("coach", "write-trade-reject", `Rejected trade ${txId} (${status}).`, { transactionId: txId, status, leg });
  return status;
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

export interface DmThread {
  dmId: string;
  title: string | null;
  lastText: string | null;
  lastTime: number;
  lastAuthorId: string | null;
  lastAuthorName: string | null;
  lastMessageId: string | null;
  lastReadId: string | null;
  /** True when the newest message is not one we have already read, and is not
   *  ours. Sleeper tracks read state per thread, which is what stops the coach
   *  answering the same message forever. */
  unread: boolean;
}

export async function listDms(gql: Gql, limit = 25): Promise<DmThread[]> {
  const body = await gql(
    `{my_dms(limit:${Math.trunc(limit)}){dm_id title last_message_text last_message_time` +
    ` last_author_id last_author_display_name last_message_id last_read_id}}`,
  );
  const raw = (unwrap(body, "my_dms") ?? []) as Record<string, unknown>[];
  return raw.map((d) => {
    const lastMessageId = d.last_message_id ? String(d.last_message_id) : null;
    const lastReadId = d.last_read_id ? String(d.last_read_id) : null;
    const lastAuthorId = d.last_author_id ? String(d.last_author_id) : null;
    return {
      dmId: String(d.dm_id ?? ""),
      title: d.title ? String(d.title) : null,
      lastText: d.last_message_text ? String(d.last_message_text) : null,
      lastTime: Number(d.last_message_time ?? 0),
      lastAuthorId,
      lastAuthorName: d.last_author_display_name ? String(d.last_author_display_name) : null,
      lastMessageId,
      lastReadId,
      unread: lastAuthorId !== config.userId && lastMessageId !== null && lastMessageId !== lastReadId,
    };
  });
}

export interface DmMessage {
  messageId: string;
  text: string;
  created: number;
  authorId: string;
  authorName: string;
  isUs: boolean;
  /** Trade offers arrive as a message with a structured attachment rather than
   *  as text, which is how we tie a DM conversation to a real transaction. */
  tradeTransactionId: string | null;
}

export async function threadMessages(gql: Gql, dmId: string): Promise<DmMessage[]> {
  const body = await gql(
    `{messages(parent_id:"${safeId(dmId)}"){message_id text created author_id author_display_name attachment}}`,
  );
  const raw = (unwrap(body, "messages") ?? []) as Record<string, unknown>[];
  return raw
    .map((m) => {
      const att = m.attachment as { data?: Record<string, unknown> } | null;
      const data = att?.data;
      return {
        messageId: String(m.message_id ?? ""),
        text: decodeEntities(String(m.text ?? "")),
        created: Number(m.created ?? 0),
        authorId: String(m.author_id ?? ""),
        authorName: String(m.author_display_name ?? ""),
        isUs: String(m.author_id ?? "") === config.userId,
        tradeTransactionId: data?.transaction_id ? String(data.transaction_id) : null,
      };
    })
    .sort((a, b) => a.created - b.created);
}

/** Sleeper stores message text HTML-escaped. Reading it back raw shows &#39;
 *  where an apostrophe was, so anything we feed to a model or match against
 *  needs decoding first. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'");
}

export async function sendDm(gql: Gql, dmId: string, text: string): Promise<string> {
  const body = await gql(
    `mutation{create_message(parent_id:"${safeId(dmId)}",parent_type:"dm",text:${str(text)}){message_id}}`,
  );
  const r = (unwrap(body, "create_message") ?? {}) as { message_id?: string };
  return String(r.message_id ?? "");
}

/** Send a trade offer.
 *
 *  The arguments are PARALLEL ARRAYS, and every player appears in BOTH lists:
 *  once in adds keyed to the roster receiving him, once in drops keyed to the
 *  roster losing him. A one-for-one where we (roster 3) get B from roster 2 and
 *  give A is therefore:
 *      k_adds  ["B","A"]   v_adds  [3,2]
 *      k_drops ["B","A"]   v_drops [2,3]
 *  which is exactly the shape a received offer reads back as.
 *
 *  `rejectTransactionId` turns this into a counter-offer: their offer is
 *  rejected and ours proposed in the same call. */
export interface ProposalSpec {
  /** player_id -> roster_id receiving him. */
  adds: Record<string, number>;
  /** player_id -> roster_id losing him. */
  drops: Record<string, number>;
  expiresAt?: number;
  rejectTransactionId?: string;
  rejectTransactionLeg?: number;
}

export async function proposeTrade(
  gql: Gql, spec: ProposalSpec, leagueId = config.leagueId,
): Promise<{ transactionId: string; status: string }> {
  assertWritesAllowed("propose a trade");
  const addKeys = Object.keys(spec.adds);
  const dropKeys = Object.keys(spec.drops);
  if (!addKeys.length || !dropKeys.length) throw new Error("proposeTrade: empty offer");
  for (const id of [...addKeys, ...dropKeys]) safePlayerId(id);
  const list = (xs: string[]) => `[${xs.map((x) => `"${x}"`).join(",")}]`;
  const ints = (xs: number[]) => `[${xs.map((x) => Math.trunc(x)).join(",")}]`;

  const args = [
    `league_id:"${safeId(leagueId)}"`,
    `k_adds:${list(addKeys)}`,
    `v_adds:${ints(addKeys.map((k) => spec.adds[k] as number))}`,
    `k_drops:${list(dropKeys)}`,
    `v_drops:${ints(dropKeys.map((k) => spec.drops[k] as number))}`,
  ];
  if (spec.expiresAt) args.push(`expires_at:${Math.trunc(spec.expiresAt)}`);
  if (spec.rejectTransactionId) {
    args.push(`reject_transaction_id:"${safePlayerId(spec.rejectTransactionId)}"`);
    if (spec.rejectTransactionLeg) args.push(`reject_transaction_leg:${Math.trunc(spec.rejectTransactionLeg)}`);
  }
  const body = await gql(`mutation{propose_trade(${args.join(",")}){transaction_id status}}`);
  const r = (unwrap(body, "propose_trade") ?? {}) as { transaction_id?: string; status?: string };
  return { transactionId: String(r.transaction_id ?? ""), status: String(r.status ?? "") };
}

/** Offers WE sent that are still awaiting their answer. Needed so the proposer
 *  does not pile a second offer on someone who has not answered the first. */
export async function outstandingOffers(gql: Gql, leg: number, leagueId = config.leagueId): Promise<PendingTrade[]> {
  const all = await pendingTrades(gql, leg, leagueId);
  return all.filter((t) => t.consenterIds.includes(config.rosterId));
}

// ---------------------------------------------------------------------------
// Roster moves: waiver claims, free-agent adds, lineups
// ---------------------------------------------------------------------------
//
// These replace the browser paths one by one. The claim flow in particular was
// never verified through the DOM, which is why every waiver claim was shadowed
// and WAIVERS_LIVE stayed off: the coach could work out the right claim and then
// not make it. submit_waiver_claim removes that.

/** A waiver claim: add one player, optionally dropping one to make room.
 *
 *  This league uses ROLLING WAIVER PRIORITY, not FAAB, so there is no bid to
 *  set; a successful claim simply sends us to the back of the queue. That is
 *  also why the analysis only ever proposes ONE claim per cycle. */
/** Every write that can remove a player from our roster passes through here.
 *  The kill switch, the drop circuit breaker and the activity event live INSIDE
 *  the write, not in the caller, so a scheduled job, the daemon, the CLI and a
 *  one-off script all get the same rails. Before 2026-09-23 the breaker guarded
 *  one of four drop paths, and a manual script dropped a real player with no
 *  event and no alert. */
function guardDrop(action: string, dropIds: string[], via: string): void {
  assertWritesAllowed(action);
  if (!dropIds.length) return;
  const verdict = dropVerdict();
  if (!verdict.allowed) {
    logEvent("coach", "drop-blocked", `Refused ${action}: ${verdict.reason}`, { wanted: dropIds, via, reason: verdict.reason, freeze: verdict.freeze });
    // A second automatic drop inside the window is a runaway loop, not a
    // decision. The coach freezes itself here, at the chokepoint, so every
    // caller gets the same protection. Removing the FREEZE file lifts it.
    if (verdict.freeze) {
      void freezeNow(verdict.reason).catch(() => {});
      void sendAlert("Coach froze itself: repeated drops", `${verdict.reason}. It wanted to ${action} (${dropIds.join(", ")}). Writes are frozen until the FREEZE file is removed.`, { key: "cascade" }).catch(() => {});
    }
    throw new DropRefused(verdict, dropIds);
  }
}
function recordDrops(dropIds: string[], via: string, names?: string[]): void {
  dropIds.forEach((id, i) => recordDrop(names?.[i] ?? id, via));
}

export async function submitWaiverClaim(
  gql: Gql, addPlayerId: string, dropPlayerId: string | null,
  rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ transactionId: string; status: string }> {
  const args = [
    `league_id:"${safeId(leagueId)}"`,
    `k_adds:["${safePlayerId(addPlayerId)}"]`,
    `v_adds:[${Math.trunc(rosterId)}]`,
  ];
  if (dropPlayerId) {
    args.push(`k_drops:["${safePlayerId(dropPlayerId)}"]`, `v_drops:[${Math.trunc(rosterId)}]`);
  }
  guardDrop("submit a waiver claim", dropPlayerId ? [dropPlayerId] : [], "claim");
  const body = await gql(`mutation{submit_waiver_claim(${args.join(",")}){transaction_id status}}`);
  const r = (unwrap(body, "submit_waiver_claim") ?? {}) as { transaction_id?: string; status?: string };
  // A claim's drop is counted when it is FILED: Wednesday processes every claim
  // at once, and three claims naming three drops is the cascade shape again.
  if (dropPlayerId) recordDrops([dropPlayerId], "claim");
  logEvent("coach", "write-claim", `Waiver claim filed: add ${addPlayerId}${dropPlayerId ? `, drop ${dropPlayerId}` : ""}.`, { add: addPlayerId, drop: dropPlayerId, rosterId, leagueId, transactionId: r.transaction_id, status: r.status });
  return { transactionId: String(r.transaction_id ?? ""), status: String(r.status ?? "") };
}

/** A costless free-agent add. Unlike a claim this does not burn waiver priority,
 *  which is why the analysis prefers it whenever the player is unclaimed. */
export async function addFreeAgent(
  gql: Gql, addPlayerId: string, dropPlayerId: string | null,
  rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ transactionId: string; status: string }> {
  const args = [
    `type:"free_agent"`,
    `league_id:"${safeId(leagueId)}"`,
    `k_adds:["${safePlayerId(addPlayerId)}"]`,
    `v_adds:[${Math.trunc(rosterId)}]`,
  ];
  if (dropPlayerId) {
    args.push(`k_drops:["${safePlayerId(dropPlayerId)}"]`, `v_drops:[${Math.trunc(rosterId)}]`);
  }
  guardDrop("add a free agent", dropPlayerId ? [dropPlayerId] : [], "free-add");
  const body = await gql(`mutation{league_create_transaction(${args.join(",")}){transaction_id status}}`);
  const r = (unwrap(body, "league_create_transaction") ?? {}) as { transaction_id?: string; status?: string };
  if (dropPlayerId) recordDrops([dropPlayerId], "free-add");
  logEvent("coach", "write-add", `Free agent added: ${addPlayerId}${dropPlayerId ? `, dropped ${dropPlayerId}` : ""}.`, { add: addPlayerId, drop: dropPlayerId, rosterId, leagueId, transactionId: r.transaction_id, status: r.status });
  return { transactionId: String(r.transaction_id ?? ""), status: String(r.status ?? "") };
}

/** Drop players outright, no add. Used by the post-trade reconciliation loop to
 *  get back under the roster limit. A free-agent transaction with only drops.
 *
 *  UNVERIFIED WRITE against Sleeper as of 2026-09-04: no trade has completed yet
 *  to exercise it, and staging cannot (its other teams are orphans). The caller
 *  alerts on the outcome either way, so a wrong shape surfaces loudly rather than
 *  corrupting the roster silently. */
export async function dropPlayers(
  gql: Gql, playerIds: string[], rosterId = config.rosterId, leagueId = config.leagueId, via = "reconcile",
): Promise<{ transactionId: string; status: string }> {
  if (!playerIds.length) throw new Error("dropPlayers: nothing to drop");
  for (const id of playerIds) safePlayerId(id);
  guardDrop("drop players", playerIds, via);
  const kDrops = `[${playerIds.map((x) => `"${x}"`).join(",")}]`;
  const vDrops = `[${playerIds.map(() => Math.trunc(rosterId)).join(",")}]`;
  const body = await gql(
    `mutation{league_create_transaction(type:"free_agent",league_id:"${safeId(leagueId)}",k_drops:${kDrops},v_drops:${vDrops}){transaction_id status}}`,
  );
  const r = (unwrap(body, "league_create_transaction") ?? {}) as { transaction_id?: string; status?: string };
  recordDrops(playerIds, via);
  logEvent("coach", "write-drop", `Dropped ${playerIds.join(", ")} (${via}).`, { drops: playerIds, via, rosterId, leagueId, transactionId: r.transaction_id, status: r.status });
  return { transactionId: String(r.transaction_id ?? ""), status: String(r.status ?? "") };
}

/** Completed trades involving a roster, so we can react when one processes. */
/** Players moving on/off OUR roster from trades we have already agreed to but
 *  that have not finished processing (proposed, and in commish review). All of
 *  our decisions read the CURRENT roster, so without this the coach would, e.g.,
 *  grab a tight end off waivers while a tight end we traded for sits in review.
 *  Filip: "make sure trading takes into account trades that are processing so
 *  if you already traded for a TE you are not trying to pick up another one."
 *
 *  Only trades EVERY party has consented to count. A proposal carries the
 *  proposer's consent from the moment it is sent, so "we consented" is true of
 *  every offer we make. On 2026-09-23 that pre-applied our own outgoing offer
 *  to Cloud Nine: the brief listed Harold Fannin as ours, the DM bot told
 *  Cookie he was "getting my WR1 and my TE1" when Chase and Fannin are his,
 *  and the waiver engine planned around three players we do not have. A trade
 *  changes what we will hold only once the other side has said yes too. */
/** Re-exported from sleeper/rules.ts so existing imports keep working. */
export const tradeInFlight = ruleTradeInFlight;

export async function pendingRosterDelta(
  gql: Gql, leg: number, rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ incoming: string[]; outgoing: string[] }> {
  const incoming: string[] = [];
  const outgoing: string[] = [];
  const seen = new Set<string>();
  for (const status of ["proposed", "processing", "in_progress"]) for (const l of legsToScan(leg)) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"${status}",leg:${l})` +
      `{transaction_id status type roster_ids consenter_ids adds drops}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const data = (body.data ?? {}) as Record<string, unknown>;
    const raw = (data.league_transactions_by_status ?? []) as Record<string, unknown>[];
    for (const t of raw) {
      if (t.type !== "trade") continue;
      const id = String(t.transaction_id ?? "");
      if (seen.has(id)) continue;
      seen.add(id);
      if (!ruleTradeInFlight(t)) continue;
      for (const [pid, rid] of Object.entries((t.adds ?? {}) as Record<string, number>)) if (rid === rosterId) incoming.push(pid);
      for (const [pid, rid] of Object.entries((t.drops ?? {}) as Record<string, number>)) if (rid === rosterId) outgoing.push(pid);
    }
  }
  return { incoming, outgoing };
}

/** Apply an incoming/outgoing delta to a list of player ids. Pure. */
export function applyRosterDelta(players: string[], delta: { incoming: string[]; outgoing: string[] }): string[] {
  const out = new Set(players);
  for (const id of delta.outgoing) out.delete(id);
  for (const id of delta.incoming) out.add(id);
  return [...out];
}

export async function completedTrades(gql: Gql, leg: number, leagueId = config.leagueId): Promise<PendingTrade[]> {
  const out: PendingTrade[] = [];
  const seenDone = new Set<string>();
  for (const status of ["complete", "processed"]) for (const l of legsToScan(leg)) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"${status}",leg:${l})` +
      `{transaction_id status type roster_ids consenter_ids adds drops created settings}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const data = (body.data ?? {}) as Record<string, unknown>;
    const raw = (data.league_transactions_by_status ?? []) as Record<string, unknown>[];
    for (const t of raw) {
      if (t.type !== "trade") continue;
      const doneId = String(t.transaction_id ?? "");
      if (seenDone.has(doneId)) continue;
      seenDone.add(doneId);
      out.push({
        transactionId: doneId, status: String(t.status ?? ""), type: "trade",
        rosterIds: (t.roster_ids as number[]) ?? [], consenterIds: (t.consenter_ids as number[]) ?? [],
        adds: (t.adds as Record<string, number>) ?? {}, drops: (t.drops as Record<string, number>) ?? {},
        created: Number(t.created ?? 0),
      });
    }
  }
  return out;
}

/** Our current active roster (the players array) and IR, straight from REST. */
export async function myRoster(rosterId = config.rosterId, leagueId = config.leagueId): Promise<{ players: string[]; reserve: string[] }> {
  const v = await myRosterView(rosterId, leagueId);
  return { players: [...v.ownedIds], reserve: [...v.reserveIds] };
}

/** THE roster read for every decision path. Live GraphQL (the REST endpoint
 *  sits behind a five-minute CDN cache and reported 16 players seconds after
 *  the league held 17), built into the one RosterView every module shares. */
export async function myRosterView(rosterId = config.rosterId, leagueId = config.leagueId): Promise<RosterView> {
  const mine = (await leagueRosters(leagueId)).find((r) => r.roster_id === rosterId);
  if (!mine) throw new Error(`roster ${rosterId} not found in league ${leagueId}`);
  return buildRosterView(mine);
}

/** Our own waiver claims still waiting to process, and how many roster slots
 *  they will need when they do. A claim with no drop attached consumes an open
 *  slot; one that names a drop is self-financing.
 *
 *  Without this the coach spends slots it has already committed. On 2026-09-19
 *  two claims were filed with no drop, and the daily free-agent job would have
 *  filled both open slots with +0-value depth the next morning, leaving the
 *  claims to fail on Wednesday for want of room. */
export async function pendingClaimSlots(
  gql: Gql, leg: number, rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ count: number; adds: string[] }> {
  const adds: string[] = [];
  // A claim is filed under the leg it was made in and stays there until the
  // waiver run processes it, which is after the NFL week has rolled over. On
  // 2026-09-22 (week 3) the Reed and Downs claims sat under leg 2, this read
  // leg 3 only, saw no claims, released the hold, and the free-agent job tried
  // to spend both slots. Look one leg back as well.
  const legs = [...new Set([Math.trunc(leg), Math.max(1, Math.trunc(leg) - 1)])];
  const seen = new Set<string>();
  for (const status of ["pending", "processing"]) for (const l of legs) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"${status}",leg:${l})` +
      `{transaction_id status type roster_ids adds drops}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const raw = ((body.data as Record<string, unknown> | undefined)?.league_transactions_by_status ?? []) as Record<string, unknown>[];
    for (const t of raw) {
      if (t.type !== "waiver") continue;
      if (!((t.roster_ids as number[]) ?? []).includes(rosterId)) continue;
      const txId = String(t.transaction_id ?? "");
      if (seen.has(txId)) continue;
      seen.add(txId);
      const ourAdds = Object.entries((t.adds ?? {}) as Record<string, number>).filter(([, r]) => r === rosterId);
      const ourDrops = Object.entries((t.drops ?? {}) as Record<string, number>).filter(([, r]) => r === rosterId);
      // Net slots this claim needs when it lands.
      const net = ourAdds.length - ourDrops.length;
      if (net > 0) for (const [pid] of ourAdds) adds.push(pid);
    }
  }
  return { count: adds.length, adds };
}

/** Is the league inside its waiver window, where every unrostered player is
 *  on waivers and free adds are refused? True from the week's first kickoff
 *  until the waiver run clears. There is no direct flag, but an unprocessed
 *  waiver claim from ANY roster under this leg or the last one means the run
 *  has not happened yet, and in an 8-team league somebody always has one in.
 *  When this is wrong the write-time fallback in waiver-run still catches it. */
export async function waiverWindowOpen(gql: Gql, leg: number, leagueId = config.leagueId): Promise<boolean> {
  for (const l of new Set([Math.trunc(leg), Math.max(1, Math.trunc(leg) - 1)])) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"pending",leg:${l}){transaction_id type}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const raw = ((body.data as Record<string, unknown> | undefined)?.league_transactions_by_status ?? []) as Record<string, unknown>[];
    if (raw.some((t) => t.type === "waiver")) return true;
  }
  return false;
}

export async function cancelWaiverClaim(
  gql: Gql, transactionId: string, leg: number, leagueId = config.leagueId,
): Promise<string> {
  const body = await gql(
    `mutation{cancel_waiver_claim(league_id:"${safeId(leagueId)}",transaction_id:"${safeId(transactionId)}",leg:${Math.trunc(leg)}){transaction_id status}}`,
  );
  const r = (unwrap(body, "cancel_waiver_claim") ?? {}) as { status?: string };
  return String(r.status ?? "");
}

/** Set the week's starters. Order matters and must match the league's slot
 *  order exactly; Sleeper positions by index, not by player position. */
/** The starters Sleeper will actually score this week: the matchup leg's
 *  array, not the roster's.
 *
 *  Found 2026-09-23, week 3. roster_update_starters had put Collins at WR2
 *  and every read-back agreed, while the app showed him on the bench. The
 *  app and the scorer read `matchup_legs[round].starters`, which that
 *  mutation never touches (proved on staging: the roster array changed, the
 *  leg did not). So the leg is the truth for the current week and the roster
 *  array is only the default a new leg is seeded from. Returns null when the
 *  week has no leg yet (pre-season). */
export async function matchupLegStarters(
  gql: Gql, round: number, rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ leg: number; starters: string[] } | null> {
  const body = await gql(
    `{matchup_legs(league_id:"${safeId(leagueId)}",round:${Math.trunc(round)}){leg roster_id starters}}`,
  );
  const legs = (unwrap(body, "matchup_legs") ?? []) as { leg: number; roster_id: number; starters?: string[] }[];
  const mine = legs.find((l) => l.roster_id === rosterId);
  return mine ? { leg: mine.leg, starters: mine.starters ?? [] } : null;
}

/** What is set on the site for this week: the leg when there is one, else
 *  the roster array. Every planner starts from this. */
export async function currentStarters(
  gql: Gql, round: number, rosterStarters: string[], rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<string[]> {
  const leg = await matchupLegStarters(gql, round, rosterId, leagueId);
  return leg?.starters.length ? leg.starters : rosterStarters;
}

const starterList = (starters: string[]): string => `[${starters.map((x) => `"${x}"`).join(",")}]`;

/** Set the lineup: the roster array AND this week's matchup leg, then read
 *  the leg back. `round` is the week; pass it from the caller's NFL state so
 *  the write and the plan agree on the week. Throws when the leg does not
 *  echo the array, which is the only read-back that means anything. */
export async function updateStarters(
  gql: Gql, starters: string[], rosterId = config.rosterId, leagueId = config.leagueId, round?: number,
): Promise<string[]> {
  // The kill switch is checked at the chokepoint, same as the DOM setLineup:
  // the lineup guard, the scheduled locks and a manual script all pass here.
  assertWritesAllowed("set starters");
  // A starter is a numeric player id, a 2-3 letter team code for a defense
  // (SEA, KC), or "0" for an empty slot. safeId alone rejects the defenses.
  for (const id of starters) {
    if (!id || id === "0") continue;
    if (/^[A-Z]{2,3}$/.test(id)) continue;
    safeId(id);
  }
  const week = round ?? (await sportInfo("nfl")).week;
  const list = starterList(starters);
  const body = await gql(
    `mutation{roster_update_starters(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},starters:${list}){roster_id starters}}`,
  );
  const r = (unwrap(body, "roster_update_starters") ?? {}) as { starters?: string[] };

  const leg = await matchupLegStarters(gql, week, rosterId, leagueId);
  if (!leg) return r.starters ?? []; // no matchup this week; the roster array is all there is
  const legBody = await gql(
    `mutation{update_matchup_leg(league_id:"${safeId(leagueId)}",round:${Math.trunc(week)},leg:${Math.trunc(leg.leg)},roster_id:${Math.trunc(rosterId)},starters:${list}){roster_id starters}}`,
  );
  unwrap(legBody, "update_matchup_leg");
  const back = await matchupLegStarters(gql, week, rosterId, leagueId);
  const got = back?.starters ?? [];
  if (got.join(",") !== starters.join(",")) {
    throw new Error(`week ${week} matchup leg read-back mismatch: site has ${got.join(",")}`);
  }
  logEvent("coach", "write-starters", `Week ${week} starters set on the roster and the matchup leg.`, { starters, week, rosterId, leagueId });
  return got;
}

/** Set the roster's injured-reserve list. Same shape as updateStarters, and
 *  proven the same way: a no-op write of the existing reserve on 2026-09-19
 *  returned the list and read back unchanged.
 *
 *  This is the move the coach could see but not make. A free IR slot is a
 *  costless roster expansion: stash a player who is Out, and the active slot he
 *  vacates takes a free agent with nobody dropped. Without it the planner chose
 *  that path, submitted the add into a still-full roster, and Sleeper answered
 *  "Your roster is either invalid or will be invalid after this move". The
 *  alert then told Filip to go do it in Sleeper by hand. */
export async function updateReserve(
  gql: Gql, reserve: string[], rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<string[]> {
  assertWritesAllowed("set injured reserve");
  for (const id of reserve) safePlayerId(id);
  const list = `[${reserve.map((x) => str(x)).join(",")}]`;
  const body = await gql(
    `mutation{roster_update_reserve(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},reserve:${list}){roster_id reserve}}`,
  );
  const r = (unwrap(body, "roster_update_reserve") ?? {}) as { reserve?: string[] };
  logEvent("coach", "write-reserve", `Injured reserve set to [${(r.reserve ?? []).join(", ")}].`, { reserve: r.reserve ?? [], rosterId, leagueId });
  return r.reserve ?? [];
}

// ---------------------------------------------------------------------------
// Chat requests
// ---------------------------------------------------------------------------
//
// A DM from someone who is not a Sleeper friend arrives as a PENDING REQUEST,
// not as a thread. Until it is accepted the conversation is invisible to
// my_dms, so the coach cannot see it, cannot reply in it, and cannot even find
// it to explain a trade decision. That happened on 2026-09-02: cookieeater45
// proposed a trade and messaged about it, the trade was correctly rejected from
// the transactions API, and the explanation never went out because the thread
// did not exist yet as far as the API was concerned.
//
// The type string is "dm_single" and it is not guessable; "dm", "chat",
// "friend" and "league_dm" all return an empty list quite happily. It was found
// by hooking XMLHttpRequest in the page and reading the query the Sleeper web
// app sends for itself.

export interface ChatRequest {
  typeId: string;
  requesterId: string;
  requesterName: string;
  description: string;
  created: number;
}

/** "dm_single" is a one-on-one DM invite; "dm_group" is a multi-person one
 *  (found the same way as dm_single: it is not a guessable name, and hooking
 *  the Sleeper web app's own XHR calls is what surfaced it). Both arrive the
 *  same way and accept the same way, just with a different request_type. */
export type ChatRequestType = "dm_single" | "dm_group";

export async function pendingChatRequests(gql: Gql, requestType: ChatRequestType = "dm_single"): Promise<ChatRequest[]> {
  const body = await gql(
    `{inbound_requests(request_type:"${requestType}"){type_id requester_id requester_display_name type_description created}}`,
  );
  const raw = (unwrap(body, "inbound_requests") ?? []) as Record<string, unknown>[];
  return raw.map((r) => ({
    typeId: String(r.type_id ?? ""),
    requesterId: String(r.requester_id ?? ""),
    requesterName: String(r.requester_display_name ?? ""),
    description: String(r.type_description ?? ""),
    created: Number(r.created ?? 0),
  })).filter((r) => r.typeId && r.requesterId);
}

export async function acceptChatRequest(gql: Gql, req: ChatRequest, requestType: ChatRequestType = "dm_single"): Promise<boolean> {
  const body = await gql(
    `mutation{accept_request(request_type:"${requestType}",type_id:"${safeId(req.typeId)}",requester_id:"${safeId(req.requesterId)}")}`,
  );
  return unwrap(body, "accept_request") === true;
}
