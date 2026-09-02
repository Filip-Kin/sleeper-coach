// DM conversations for the coach UI.
//
// WHY THIS EXISTS. Filip was reading the DMs in the Sleeper app to follow what
// the coach was saying, and reading a thread marks it read, which used to cancel
// the reply entirely. That gate is gone (dm-watch keys off our own reply state
// now, not Sleeper's), but he still should not have to open the app to see a
// conversation his own bot is having. This is read-only: replying stays the
// coach's job.

import { config } from "../config.ts";
import { browserGql, listDms, threadMessages, type Gql } from "../league/api.ts";

export interface DmMessageView {
  id: string;
  author: string;
  text: string;
  at: number;
  isUs: boolean;
  /** Trade offers arrive as an attachment rather than as text. */
  isTradeOffer: boolean;
}

export interface DmThreadView {
  dmId: string;
  who: string;
  lastAt: number;
  /** True when they spoke last, so the coach still owes an answer. */
  awaitingUs: boolean;
  messages: DmMessageView[];
}

export interface DmView {
  generatedAt: number;
  threads: DmThreadView[];
}

interface Cached { at: number; view: DmView }
let cache: Cached | null = null;
const TTL_MS = 20_000;

export async function dmView(gql: Gql = browserGql()): Promise<DmView> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.view;

  const threads = await listDms(gql, 25);
  const out: DmThreadView[] = [];
  for (const t of threads) {
    let msgs: Awaited<ReturnType<typeof threadMessages>> = [];
    try {
      msgs = await threadMessages(gql, t.dmId);
    } catch {
      // A thread we cannot read should not blank the whole page.
    }
    // Name the human, not whoever spoke last.
    const them = msgs.find((m) => !m.isUs)?.authorName ?? t.lastAuthorName ?? "unknown";
    out.push({
      dmId: t.dmId,
      who: them,
      lastAt: t.lastTime,
      awaitingUs: t.lastAuthorId !== config.userId,
      messages: msgs.map((m) => ({
        id: m.messageId,
        author: m.isUs ? "Coach" : m.authorName,
        text: m.text,
        at: m.created,
        isUs: m.isUs,
        isTradeOffer: m.tradeTransactionId !== null,
      })),
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);

  const view: DmView = { generatedAt: Date.now(), threads: out };
  cache = { at: Date.now(), view };
  return view;
}
