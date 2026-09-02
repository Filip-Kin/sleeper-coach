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
