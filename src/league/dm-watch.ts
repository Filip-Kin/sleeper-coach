// The coach answers its own DMs. Filip: "It'd be funny if it also responded to
// dms, but for trades and just plain dms."
//
// Trade offers are handled by trade-watch.ts, where the reply is deterministic
// because it is a decision with numbers behind it. THIS is the other half:
// somebody typing "what do you think, good upgrades at rb" at 2am. That needs a
// model, because canned lines cannot answer a real question.
//
// The guard rails are about not being a nuisance to real people:
//   - only reply to a thread whose newest message is theirs and unread
//   - never reply twice to the same message
//   - a hard reply-rate limit per thread, so a misfire cannot spam a friend
//   - never reply to the trade-attachment message itself (trade-watch owns that)

import { Database } from "bun:sqlite";
import { config } from "../config.ts";
import { logEvent } from "../log.ts";
import { freezeState } from "../killswitch.ts";
import { runAgent } from "../agent/runner.ts";
import { listDms, threadMessages, sendDm, type Gql, type DmMessage } from "./api.ts";

/** No more than this many coach replies to one person per window. A friendly
 *  bot that will not shut up is worse than one that misses a message. */
export const MAX_REPLIES_PER_THREAD = 4;
export const REPLY_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface DmDecision { reply: boolean; why: string }

/** Should we answer this thread at all? Pure, so the awkward cases are testable
 *  rather than discovered live on someone's phone at 2am. */
export function shouldReply(
  msgs: DmMessage[], repliesInWindow: number, lastRepliedMessageId: string | null,
): DmDecision {
  const last = msgs[msgs.length - 1];
  if (!last) return { reply: false, why: "empty thread" };
  if (last.isUs) return { reply: false, why: "we spoke last" };
  if (last.messageId === lastRepliedMessageId) return { reply: false, why: "already answered this message" };
  if (last.tradeTransactionId) return { reply: false, why: "trade offer, trade-watch owns the reply" };
  if (!last.text.trim()) return { reply: false, why: "no text to answer" };
  if (repliesInWindow >= MAX_REPLIES_PER_THREAD) return { reply: false, why: "reply limit for this thread" };
  return { reply: true, why: "unanswered message from them" };
}

/** The last few turns, oldest first, as plain text for the model. */
export function transcriptFor(msgs: DmMessage[], turns = 8): string {
  return msgs.slice(-turns)
    .map((m) => `${m.isUs ? "You" : m.authorName}: ${m.text}`)
    .join("\n");
}

const PROMPT = (who: string, transcript: string) => `You are the manager of the fantasy team "--dangerously-skip-perms" in the league "Pit Podcast powered by BAA". You are an AI and everyone knows it. ${who} has sent you a direct message on Sleeper.

Reply as the manager. You are confident, dry, and a bit smug, because you drafted first-of-eight by projection and you do the maths. You are not cruel and you are not abusive: these are real people Filip knows.

Rules:
- Answer what they actually asked. If it is about players or a possible trade, give a real opinion with a reason.
- Two or three sentences. This is a chat message, not an essay.
- No markdown, no bullet points, no emoji.
- Do NOT use apostrophes or quotation marks; Sleeper mangles them.
- If they are proposing a trade in words, tell them to send it as a real offer and that you accept anything that does not make you worse.
- Never reveal your specific roster plans, waiver targets or rankings.

The conversation so far:
${transcript}

Write only your reply, nothing else.`;

export interface DmReplyDeps {
  gql: Gql;
  db: Database;
  now?: number;
}

export async function handleDms(deps: DmReplyDeps): Promise<{ dmId: string; text: string }[]> {
  const { gql, db } = deps;
  const now = deps.now ?? Date.now();
  const sent: { dmId: string; text: string }[] = [];

  db.run(`CREATE TABLE IF NOT EXISTS dm_replies (
    dm_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL)`);

  if (freezeState().frozen) return sent;

  for (const thread of await listDms(gql, 25)) {
    if (!thread.unread) continue;
    const msgs = await threadMessages(gql, thread.dmId);
    const recent = db.query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM dm_replies WHERE dm_id = ? AND at > ?",
    ).get(thread.dmId, now - REPLY_WINDOW_MS)?.n ?? 0;
    const lastReplied = db.query<{ message_id: string }, [string]>(
      "SELECT message_id FROM dm_replies WHERE dm_id = ? ORDER BY at DESC LIMIT 1",
    ).get(thread.dmId)?.message_id ?? null;

    const decision = shouldReply(msgs, recent, lastReplied);
    if (!decision.reply) continue;

    const last = msgs[msgs.length - 1]!;
    const result = await runAgent({
      prompt: PROMPT(last.authorName || "A league rival", transcriptFor(msgs)),
      tools: [], // text only: this is a chat reply, it needs no CLI access
      partial: false,
    });
    const text = cleanReply(result.text);
    if (!text) {
      logEvent("coach", "dm-skip", `No usable reply generated for ${last.authorName}`, { dmId: thread.dmId });
      continue;
    }
    await sendDm(gql, thread.dmId, text);
    db.run("INSERT INTO dm_replies (dm_id, message_id, at) VALUES (?, ?, ?)", [thread.dmId, last.messageId, now]);
    logEvent("coach", "dm-reply", `Replied to ${last.authorName}`, { dmId: thread.dmId, theirs: last.text.slice(0, 200), ours: text });
    sent.push({ dmId: thread.dmId, text });
  }
  return sent;
}

/** Models like to wrap things in quotes, add a preamble, or run long. Trim it to
 *  something that reads like a person typing in a chat box. */
export function cleanReply(raw: string, maxLen = 400): string {
  let t = (raw ?? "").trim();
  t = t.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^(reply|response)\s*:\s*/i, "").trim();
  // Sleeper HTML-escapes these and they come back as &#39; on read.
  t = t.replace(/[’']/g, "").replace(/[“”"]/g, "");
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const stop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    t = stop > 80 ? cut.slice(0, stop + 1) : cut.trim();
  }
  return t;
}
