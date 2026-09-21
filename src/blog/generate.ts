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
import { tokenGql, completedTrades } from "../league/api.ts";
import { loadPlayers } from "../data/players.ts";
import { loadWeekProjections, byPlayerId } from "../analysis/week-projections.ts";
import { buildRosterWeek } from "../analysis/roster-week.ts";
import { solveLineup, startingSlots } from "../analysis/lineup.ts";
import { buildRosterView } from "../analysis/roster-view.ts";
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
  "This post is PUBLIC and every other manager in the league reads it. Do NOT reveal forward-looking strategy: " +
  "no players you are targeting, no waiver plans, no trade intentions, no who-you-want-next ranking. A plain " +
  "projected score for next week is fine, that number is on everyone's screen already. " +
  "Never use em dashes; use a comma, a colon or a full stop instead.";

// Funny was requested, and a model told only "be funny" writes stand-up. The
// rule that actually works is: the jokes come from the real numbers, and the
// team you are hardest on is your own. Filip: "make the blog post more funny,
// maybe mention stuff about your opponents or the trades it did that week."
const VOICE =
  "Write in first person as the team's AI coach, for a public league blog. Be genuinely funny: dry, quick, a bit " +
  "cocky when you have earned it. Every joke has to come off a real number or a real event in the notes below, " +
  "never a made-up bit. Roast your rivals the way a friend does, by the scoreboard, and never meanly or about " +
  "anything outside fantasy. Be hardest on yourself: if you left points on the bench or a trade you made looks " +
  "bad now, say so first and without excuses. A few short paragraphs, no headers, no bullet lists.";

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
  // Names come from EVERY roster's player_map, not just ours. Built from ours
  // alone, a player we traded away resolved to a bare numeric id, and the model
  // wrote "I sent Cloud Nine a player for Mark Andrews" because that is
  // genuinely all it had. A trade has two sides and the post should name both.
  const pm: Record<string, { first_name: string; last_name: string; position: string | null }> = {};
  for (const r of rosters) Object.assign(pm, r.player_map ?? {});
  const named = (id: string) => {
    const p = pm[id];
    if (p) return `${p.first_name} ${p.last_name}${p.position ? ` (${p.position})` : ""}`;
    return /^[A-Z]{2,4}$/.test(id) ? `${id} defense` : `player ${id}`;
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
    const ourView = ours ? buildRosterView(ours) : null;
    const benchIds = [...(ourView?.activeIds ?? [])].filter((id) => !mine.starters.includes(id));
    if (ourView?.reserve.length) lines.push(`On injured reserve: ${ourView.reserve.map((e) => e.name).join(", ")}`);
    if (benchIds.length) {
      lines.push("On your bench:");
      for (const id of benchIds.sort((a, b) => (mine.players_points[b] ?? 0) - (mine.players_points[a] ?? 0))) {
        lines.push(`  ${named(id)}: ${(mine.players_points[id] ?? 0).toFixed(1)}`);
      }
    }
  }
  // Everyone else's week, so the post can talk about the league and not just
  // stare at its own roster.
  const seen = new Set<number>();
  lines.push("Every other matchup this week:");
  for (const m of matchups) {
    if (m.matchup_id == null || seen.has(m.matchup_id)) continue;
    seen.add(m.matchup_id);
    const other = matchups.find((x) => x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id);
    if (!other) continue;
    if (m.roster_id === config.rosterId || other.roster_id === config.rosterId) continue;
    const [hi, lo] = m.points >= other.points ? [m, other] : [other, m];
    lines.push(`  ${teamOf(hi.roster_id)} beat ${teamOf(lo.roster_id)}, ${hi.points.toFixed(2)} to ${lo.points.toFixed(2)}`);
  }

  const standings = buildStandings(rosters, users, league);
  lines.push("Standings after this week:");
  for (const row of standings) lines.push(`  ${row.rank}. ${row.teamName} ${row.wins}-${row.losses}, ${row.pointsFor.toFixed(2)} points for`);

  // Trades that actually processed this week, ours and everyone else's.
  try {
    const trades = await completedTrades(tokenGql(), week);
    if (trades.length) {
      lines.push("Trades that went through this week:");
      for (const t of trades) {
        const byTeam = new Map<number, string[]>();
        for (const [pid, rid] of Object.entries(t.adds)) byTeam.set(rid, [...(byTeam.get(rid) ?? []), named(pid)]);
        const legs = [...byTeam.entries()].map(([rid, got]) => `${teamOf(rid)} got ${got.join(" and ")}`);
        lines.push(`  ${legs.join("; ")}${t.rosterIds.includes(config.rosterId) ? "  (this one was yours)" : ""}`);
      }
    } else {
      lines.push("No trades went through in the league this week.");
    }
  } catch {
    /* a trade read failure must not stop the post */
  }

  // Next week's projection. Allowed in public: it is the same number Sleeper
  // shows everyone. The LINEUP behind it is not named, that would be strategy.
  try {
    const next = week + 1;
    const nextMatch = await sleeper.matchups(config.leagueId, next) as { roster_id: number; matchup_id: number | null }[];
    const ourNext = nextMatch.find((m) => m.roster_id === config.rosterId);
    const oppNext = ourNext?.matchup_id != null
      ? nextMatch.find((m) => m.matchup_id === ourNext.matchup_id && m.roster_id !== config.rosterId)
      : undefined;
    const [dump, proj] = await Promise.all([
      loadPlayers(),
      loadWeekProjections(state.season || config.season, next, league.scoring_settings),
    ]);
    const idx = byPlayerId(proj);
    const slots = startingSlots(league.roster_positions as string[]);
    const bestFor = (rid: number) => {
      const r = rosters.find((x) => x.roster_id === rid);
      if (!r?.players) return null;
      return solveLineup(buildRosterWeek([...buildRosterView(r).activeIds], dump, idx, next), slots).total;
    };
    const usProj = bestFor(config.rosterId);
    const themProj = oppNext ? bestFor(oppNext.roster_id) : null;
    if (usProj != null) {
      lines.push(`Next week (week ${next}): you are projected for about ${usProj.toFixed(1)}` +
        (oppNext && themProj != null
          ? `, against ${teamOf(oppNext.roster_id)} at about ${themProj.toFixed(1)}.`
          : "."));
    }
  } catch {
    /* no projection is better than a wrong one */
  }

  const events = recentEvents(300).filter((e) => e.actor === "coach");
  const prompt =
    `Write a short weekly review for your fantasy football team's public blog, covering week ${week}. Your team is ` +
    `named "${await teamName()}". Use that exact name. This is a FULL-PPR, 8-team, 1-QB league.\n\n` +
    `WHAT ACTUALLY HAPPENED (these numbers are final, use them and do not invent others):\n${lines.join("\n")}\n\n` +
    `Decisions you logged this week:\n${events.slice(-30).map((e) => `- ${e.type}: ${e.summary}`).join("\n")}\n\n` +
    `Lead with the result. Name who won you the week and who let you down, with their scores. If a bench player ` +
    `outscored someone you started, own that before anything else. Say something about how the rest of the league ` +
    `did, and about any trade that went through, especially one of yours. Close on what you are projected to score ` +
    `next week and who you draw.\n\n${VOICE}\n\n${NO_STRATEGY}`;
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
