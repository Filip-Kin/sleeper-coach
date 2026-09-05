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

import { config } from "../config.ts";

export type Gql = (query: string) => Promise<Record<string, unknown>>;

export function browserGql(api = process.env.BROWSER_API ?? "http://127.0.0.1:9223"): Gql {
  return async (query: string) => {
    const res = await fetch(`${api}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.error) throw new Error(`graphql transport: ${String(j.error ?? res.statusText)}`);
    return (j.result ?? {}) as Record<string, unknown>;
  };
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
}

/** Trades awaiting a response. Sleeper calls this status "proposed". */
export async function pendingTrades(gql: Gql, leg: number, leagueId = config.leagueId): Promise<PendingTrade[]> {
  const body = await gql(
    `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"proposed",leg:${Math.trunc(leg)})` +
    `{transaction_id status type roster_ids consenter_ids adds drops created}}`,
  );
  const raw = (unwrap(body, "league_transactions_by_status") ?? []) as Record<string, unknown>[];
  return raw
    .filter((t) => t.type === "trade")
    .map((t) => ({
      transactionId: String(t.transaction_id ?? ""),
      status: String(t.status ?? ""),
      type: String(t.type ?? ""),
      rosterIds: (t.roster_ids as number[]) ?? [],
      consenterIds: (t.consenter_ids as number[]) ?? [],
      adds: (t.adds as Record<string, number>) ?? {},
      drops: (t.drops as Record<string, number>) ?? {},
      created: Number(t.created ?? 0),
    }));
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

export const acceptTrade = (gql: Gql, txId: string, leg: number, leagueId = config.leagueId): Promise<string> =>
  respond(gql, "accept_trade", txId, leg, leagueId);
export const rejectTrade = (gql: Gql, txId: string, leg: number, leagueId = config.leagueId): Promise<string> =>
  respond(gql, "reject_trade", txId, leg, leagueId);

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
  const addKeys = Object.keys(spec.adds);
  const dropKeys = Object.keys(spec.drops);
  if (!addKeys.length || !dropKeys.length) throw new Error("proposeTrade: empty offer");
  for (const id of [...addKeys, ...dropKeys]) safeId(id);
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
    args.push(`reject_transaction_id:"${safeId(spec.rejectTransactionId)}"`);
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
export async function submitWaiverClaim(
  gql: Gql, addPlayerId: string, dropPlayerId: string | null,
  rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ transactionId: string; status: string }> {
  const args = [
    `league_id:"${safeId(leagueId)}"`,
    `k_adds:["${safeId(addPlayerId)}"]`,
    `v_adds:[${Math.trunc(rosterId)}]`,
  ];
  if (dropPlayerId) {
    args.push(`k_drops:["${safeId(dropPlayerId)}"]`, `v_drops:[${Math.trunc(rosterId)}]`);
  }
  const body = await gql(`mutation{submit_waiver_claim(${args.join(",")}){transaction_id status}}`);
  const r = (unwrap(body, "submit_waiver_claim") ?? {}) as { transaction_id?: string; status?: string };
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
    `k_adds:["${safeId(addPlayerId)}"]`,
    `v_adds:[${Math.trunc(rosterId)}]`,
  ];
  if (dropPlayerId) {
    args.push(`k_drops:["${safeId(dropPlayerId)}"]`, `v_drops:[${Math.trunc(rosterId)}]`);
  }
  const body = await gql(`mutation{league_create_transaction(${args.join(",")}){transaction_id status}}`);
  const r = (unwrap(body, "league_create_transaction") ?? {}) as { transaction_id?: string; status?: string };
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
  gql: Gql, playerIds: string[], rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<{ transactionId: string; status: string }> {
  if (!playerIds.length) throw new Error("dropPlayers: nothing to drop");
  for (const id of playerIds) safeId(id);
  const kDrops = `[${playerIds.map((x) => `"${x}"`).join(",")}]`;
  const vDrops = `[${playerIds.map(() => Math.trunc(rosterId)).join(",")}]`;
  const body = await gql(
    `mutation{league_create_transaction(type:"free_agent",league_id:"${safeId(leagueId)}",k_drops:${kDrops},v_drops:${vDrops}){transaction_id status}}`,
  );
  const r = (unwrap(body, "league_create_transaction") ?? {}) as { transaction_id?: string; status?: string };
  return { transactionId: String(r.transaction_id ?? ""), status: String(r.status ?? "") };
}

/** Completed trades involving a roster, so we can react when one processes. */
export async function completedTrades(gql: Gql, leg: number, leagueId = config.leagueId): Promise<PendingTrade[]> {
  const out: PendingTrade[] = [];
  for (const status of ["complete", "processed"]) {
    const body = await gql(
      `{league_transactions_by_status(league_id:"${safeId(leagueId)}",status:"${status}",leg:${Math.trunc(leg)})` +
      `{transaction_id status type roster_ids consenter_ids adds drops created}}`,
    ).catch(() => ({} as Record<string, unknown>));
    const data = (body.data ?? {}) as Record<string, unknown>;
    const raw = (data.league_transactions_by_status ?? []) as Record<string, unknown>[];
    for (const t of raw) {
      if (t.type !== "trade") continue;
      out.push({
        transactionId: String(t.transaction_id ?? ""), status: String(t.status ?? ""), type: "trade",
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
  const res = await fetch(`https://api.sleeper.app/v1/league/${safeId(leagueId)}/rosters`, { signal: AbortSignal.timeout(10_000) });
  const rosters = (await res.json()) as { roster_id: number; players?: string[]; reserve?: string[] | null }[];
  const mine = rosters.find((r) => r.roster_id === rosterId);
  return { players: mine?.players ?? [], reserve: mine?.reserve ?? [] };
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
export async function updateStarters(
  gql: Gql, starters: string[], rosterId = config.rosterId, leagueId = config.leagueId,
): Promise<string[]> {
  for (const id of starters) if (id && id !== "0") safeId(id);
  const list = `[${starters.map((x) => `"${x}"`).join(",")}]`;
  const body = await gql(
    `mutation{roster_update_starters(league_id:"${safeId(leagueId)}",roster_id:${Math.trunc(rosterId)},starters:${list}){roster_id starters}}`,
  );
  const r = (unwrap(body, "roster_update_starters") ?? {}) as { starters?: string[] };
  return r.starters ?? [];
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
