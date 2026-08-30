#!/usr/bin/env bun
// Generates a PUBLIC retrospective blog post — the coach writing, in its own
// voice, about what it just did. Post-draft recap now; weekly reviews once the
// in-season loop lands. The prompt hard-forbids forward-looking strategy so the
// public post never leaks target players, waiver plans, or lineup intentions.
//
//   bun run blog-post draft [draftId]
//   bun run blog-post week  [week]

import { config } from "../config.ts";
import { sleeper } from "../sleeper/client.ts";
import { runAgent } from "../agent/runner.ts";
import { recentEvents } from "../log.ts";
import { addPost } from "./store.ts";
import { logEvent } from "../log.ts";

const type = (process.argv[2] ?? "draft").toLowerCase();
const arg = process.argv[3];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// The team's real name, read live so the post never guesses it.
async function teamName(): Promise<string> {
  try {
    const users = await sleeper.leagueUsers(config.leagueId);
    const name = users.find((u) => u.user_id === config.userId)?.metadata?.team_name;
    if (name) return name;
  } catch {
    /* fall through */
  }
  return "--dangerously-skip-perms";
}

const NO_STRATEGY =
  "This post is PUBLIC and other managers in the league will read it. Do NOT reveal any forward-looking " +
  "strategy: no target players, no waiver-wire plans, no trade intentions, no weekly lineup plans, no ranking of " +
  "who you want next. Only reflect on what has ALREADY happened. Write in first person as the team's AI coach: " +
  "honest, plain, a little fun, a few short paragraphs. No headers or bullet lists. " +
  "Never use em dashes; use a comma, a colon or a full stop instead.";

async function draftRecap(): Promise<{ title: string; body: string }> {
  const draftId = arg ?? config.draftId;
  const [draft, picks] = await Promise.all([sleeper.draft(draftId), sleeper.draftPicks(draftId)]);
  const slot = draft.draft_order?.[config.userId];
  const mine = picks
    .filter((p) => p.draft_slot === slot)
    .sort((a, b) => a.pick_no - b.pick_no)
    .map((p, i) => `R${i + 1} ${p.metadata?.position} ${p.metadata?.first_name} ${p.metadata?.last_name}`);
  // Pull the reasoning we logged per pick, so the recap is grounded in what the
  // coach actually thought at the time (not invented after the fact).
  const notes = recentEvents(300)
    .filter((e) => e.actor === "coach" && e.type === "draft-pick" && e.detail && (e.detail as { reasoning?: string }).reasoning)
    .map((e) => `- ${e.summary}: ${(e.detail as { reasoning?: string }).reasoning}`);
  const prompt =
    `Write a post-draft recap for your fantasy football team's public blog. Your team is named "${await teamName()}". ` +
    `Use that exact name, do not invent another. This is a FULL-PPR, 8-team, 1-QB league (start 1 QB, 2 RB, 2 WR, ` +
    `1 TE, 2 FLEX, K, DEF). Get the scoring right if you mention it.\n\n` +
    `Your final roster, in draft order:\n${mine.join("\n")}\n\n` +
    (notes.length ? `Your own notes from the draft:\n${notes.join("\n")}\n\n` : "") +
    `Talk through how the draft went: your early core, the picks you're happy with, anything risky or that you'd ` +
    `do differently, and grade yourself honestly. ${NO_STRATEGY}`;
  const res = await runAgent({ prompt });
  const title = `Draft recap, ${new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}`;
  return { title, body: res.error ? `(Could not generate: ${res.error})` : res.text };
}

async function weekReview(): Promise<{ title: string; body: string }> {
  const state = await sleeper.nflState();
  const week = Number(arg ?? Math.max(1, (state.week || 1) - 1));
  const events = recentEvents(300).filter((e) => e.actor === "coach");
  const prompt =
    `Write a short weekly review for your fantasy football team's public blog, covering week ${week}. Your team is ` +
    `named "${await teamName()}". Use that exact name. This is a FULL-PPR, 8-team, 1-QB league.\n\n` +
    `Recent decisions you logged:\n${events.slice(-30).map((e) => `- ${e.type}: ${e.summary}`).join("\n")}\n\n` +
    `Reflect on how your lineup and moves worked out and what you learned. ${NO_STRATEGY}`;
  const res = await runAgent({ prompt });
  const title = `Week ${week} review`;
  return { title, body: res.error ? `(Could not generate: ${res.error})` : res.text };
}

const { title, body } = type === "week" ? await weekReview() : await draftRecap();
const date = new Date().toISOString();
const slug = slugify(`${type}-${title}-${date.slice(0, 10)}`);
addPost({ slug, title, date, type, body });
logEvent("coach", "blog-post", `Published: ${title}`, { slug, type });
console.log(`[blog] published "${title}" (${slug})`);
