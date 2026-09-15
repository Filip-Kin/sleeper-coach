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
import { leagueRosters } from "../sleeper/graphql.ts";
import { buildStandings } from "../web/seasonview.ts";
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

interface Generated { title: string; body: string; week?: number }

async function draftRecap(): Promise<Generated> {
  const draftId = arg ?? config.draftId;
  const [draft, picks] = await Promise.all([sleeper.draft(draftId), sleeper.draftPicks(draftId)]);
  const slot = draft.draft_order?.[config.userId];
  const ourPicks = picks.filter((p) => p.draft_slot === slot).sort((a, b) => a.pick_no - b.pick_no);
  const mine = ourPicks.map(
    (p, i) => `R${i + 1} ${p.metadata?.position} ${p.metadata?.first_name} ${p.metadata?.last_name}`,
  );
  // Only reasoning for players we ACTUALLY drafted in THIS draft. The activity
  // log is append-only and shared with every rehearsal, so after an afternoon of
  // mock drafts it held 221 draft-pick events. Without this the recap would
  // explain picks from a mock as if they were ours, in a public post.
  const ourNames = new Set(
    ourPicks.map((p) => `${p.metadata?.first_name ?? ""} ${p.metadata?.last_name ?? ""}`.trim()),
  );
  // Pull the reasoning we logged per pick, so the recap is grounded in what the
  // coach actually thought at the time (not invented after the fact).
  const notes = recentEvents(300)
    .filter((e) => e.actor === "coach" && e.type === "draft-pick" && e.detail && (e.detail as { reasoning?: string }).reasoning)
    .filter((e) => {
      const t = (e.detail as { target?: unknown }).target;
      return typeof t === "string" && ourNames.has(t);
    })
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

async function weekReview(): Promise<Generated> {
  const state = await sleeper.nflState();
  const week = Number(arg ?? Math.max(1, (state.week || 1) - 1));

  // The review is about the RESULT, not about the coach's own paperwork. The
  // first version fed the model nothing but the last thirty activity-log
  // summaries, so it could only write about the moves it made, never about
  // whether they worked. Everything below is what a human would look at first:
  // the final score, who each starter actually scored, and what sat on the
  // bench instead.
  const [league, users, rosters, matchups] = await Promise.all([
    sleeper.league(config.leagueId),
    sleeper.leagueUsers(config.leagueId),
    leagueRosters(config.leagueId),
    sleeper.matchups(config.leagueId, week) as Promise<{
      roster_id: number; matchup_id: number | null; points: number;
      starters: string[]; starters_points: number[]; players_points: Record<string, number>;
    }[]>,
  ]);
  const ours = rosters.find((r) => r.roster_id === config.rosterId);
  const pm = ours?.player_map ?? {};
  const named = (id: string) => {
    const p = pm[id];
    return p ? `${p.first_name} ${p.last_name} (${p.position})` : id;
  };
  const nameOf = new Map(users.map((u) => [u.user_id, u.metadata?.team_name || u.display_name]));
  const teamOf = (rid: number) => nameOf.get(rosters.find((r) => r.roster_id === rid)?.owner_id ?? "") ?? `roster ${rid}`;

  const mine = matchups.find((m) => m.roster_id === config.rosterId);
  const theirs = mine && mine.matchup_id != null
    ? matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== config.rosterId)
    : undefined;

  const lines: string[] = [];
  if (mine && theirs) {
    const verdict = mine.points > theirs.points ? "WON" : mine.points < theirs.points ? "LOST" : "TIED";
    lines.push(`Result: you ${verdict}, ${mine.points.toFixed(2)} to ${theirs.points.toFixed(2)}, against ${teamOf(theirs.roster_id)}.`);
  }
  if (mine) {
    const ranked = [...matchups].sort((a, b) => b.points - a.points);
    const place = ranked.findIndex((m) => m.roster_id === config.rosterId) + 1;
    lines.push(`Your score ranked ${place} of ${ranked.length} in the league this week. Highest was ${ranked[0]!.points.toFixed(2)} by ${teamOf(ranked[0]!.roster_id)}.`);
    lines.push("Your starters and what they actually scored:");
    mine.starters.forEach((id, i) => lines.push(`  ${named(id)}: ${(mine.starters_points[i] ?? 0).toFixed(1)}`));
    const benchIds = (ours?.players ?? []).filter((id) => !mine.starters.includes(id));
    if (benchIds.length) {
      lines.push("On your bench:");
      for (const id of benchIds.sort((a, b) => (mine.players_points[b] ?? 0) - (mine.players_points[a] ?? 0))) {
        lines.push(`  ${named(id)}: ${(mine.players_points[id] ?? 0).toFixed(1)}`);
      }
    }
  }
  const standings = buildStandings(rosters, users, league);
  lines.push("Standings after this week:");
  for (const row of standings) lines.push(`  ${row.rank}. ${row.teamName} ${row.wins}-${row.losses}, ${row.pointsFor.toFixed(2)} points for`);

  const events = recentEvents(300).filter((e) => e.actor === "coach");
  const prompt =
    `Write a short weekly review for your fantasy football team's public blog, covering week ${week}. Your team is ` +
    `named "${await teamName()}". Use that exact name. This is a FULL-PPR, 8-team, 1-QB league.\n\n` +
    `WHAT ACTUALLY HAPPENED (these numbers are final, use them and do not invent others):\n${lines.join("\n")}\n\n` +
    `Decisions you logged this week:\n${events.slice(-30).map((e) => `- ${e.type}: ${e.summary}`).join("\n")}\n\n` +
    `Lead with the result. Be specific about who won you the week and who let you down, name them and their scores. ` +
    `If a bench player outscored someone you started, own it. Then say what you learned. ${NO_STRATEGY}`;
  const res = await runAgent({ prompt });
  const title = `Week ${week} review`;
  return { title, body: res.error ? `(Could not generate: ${res.error})` : res.text, week };
}

const out = type === "week" ? await weekReview() : await draftRecap();
const { title, body } = out;
const week = out.week;
const date = new Date().toISOString();
const slug = slugify(`${type}-${title}-${date.slice(0, 10)}`);
addPost({ slug, title, date, type, body, ...(week !== undefined ? { week } : {}) });
logEvent("coach", "blog-post", `Published: ${title}`, { slug, type, week });
console.log(`[blog] published "${title}" (${slug})`);
