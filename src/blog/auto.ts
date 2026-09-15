// Publish the weekly review by itself, once the week is actually over.
// Filip: "Have it generate blog posts automatically once the scores are final."
//
// "Final" is deliberately stricter than "the last game ended". Sleeper keeps
// moving fantasy points after the whistle: our own week 1 total read 163.32
// while Monday night was still going, then 164.72, then 165.52 once the stat
// feed settled. A review published into that window would quote a score that
// stops being true an hour later, in public, where the league reads it. So the
// publisher waits for every game of the week to report complete AND for a
// settle delay past the last kickoff before it writes anything.
//
// The trigger is the 90-second daemon poll rather than a fixed Tuesday timer,
// because the week does not end at a fixed time: a Saturday slate in December
// finishes two days earlier than a Monday night one.

import { publicGql } from "../sleeper/graphql.ts";
import { hasWeekPost, type BlogPost } from "./store.ts";
import { logEvent } from "../log.ts";
import { config } from "../config.ts";

/** How long after the last kickoff of the week before the score is trusted.
 *  Six hours clears a full game plus the stat corrections that follow it. */
export const SETTLE_MS = Number(process.env.BLOG_SETTLE_MS ?? 6 * 60 * 60 * 1000);

export interface WeekGame { status: string; startTime: number }

// #region pure
/** Is the NFL week finished and settled? Needs every game complete (an empty
 *  slate is NOT finished, it means the read failed or the week has no games)
 *  and the last kickoff far enough back for the stat feed to stop moving. */
export function weekSettled(games: WeekGame[], now: number, settleMs = SETTLE_MS): boolean {
  if (games.length === 0) return false;
  if (!games.every((g) => g.status === "complete")) return false;
  const last = Math.max(...games.map((g) => g.startTime));
  return now - last >= settleMs;
}

/** Should the publisher write the review for this week right now? */
export function shouldPublish(
  week: number, games: WeekGame[], posts: BlogPost[], now: number, settleMs = SETTLE_MS,
): boolean {
  if (week < 1) return false;
  if (hasWeekPost(week, posts)) return false;
  return weekSettled(games, now, settleMs);
}
// #endregion

/** Every NFL game of a week, from the public scores feed (no token). */
export async function weekGames(week: number, season = config.season): Promise<WeekGame[]> {
  if (!Number.isInteger(week) || week < 1 || week > 22) throw new Error(`bad week: ${week}`);
  if (!/^[0-9]{4}$/.test(season)) throw new Error(`bad season: ${season}`);
  const data = await publicGql(
    `{scores(sport:"nfl",season:"${season}",season_type:"regular",week:${week}){status start_time}}`,
  );
  const raw = data.scores;
  if (!Array.isArray(raw)) throw new Error("sleeper graphql: scores missing from response");
  return (raw as Record<string, unknown>[]).map((s) => ({
    status: String(s.status ?? ""),
    startTime: typeof s.start_time === "number" ? s.start_time : 0,
  }));
}

/** Which week a review is owed for: the one before the week now in progress.
 *  Week 1's review is owed while the NFL is in week 2. */
export function reviewableWeek(currentWeek: number): number {
  return Math.max(0, currentWeek - 1);
}

export interface PublishDeps {
  now?: number;
  posts: () => BlogPost[];
  currentWeek: () => Promise<number>;
  run: (week: number) => Promise<number>; // spawn the generator, resolve with its exit code
  games?: (week: number) => Promise<WeekGame[]>; // defaults to the live scores feed
}

/** One pass, called from the daemon poll. Returns the week published, or null. */
export async function maybePublishWeekly(deps: PublishDeps): Promise<number | null> {
  const now = deps.now ?? Date.now();
  const week = reviewableWeek(await deps.currentWeek());
  if (week < 1) return null;
  const posts = deps.posts();
  if (hasWeekPost(week, posts)) return null; // cheap exit before any network call
  const games = await (deps.games ?? weekGames)(week);
  if (!shouldPublish(week, games, posts, now)) return null;

  console.log(`[blog] week ${week} is final; writing the review.`);
  const code = await deps.run(week);
  if (code !== 0) {
    // Not alerted and not retried this pass: the next poll tries again, and a
    // missing blog post costs nothing that matters.
    console.error(`[blog] week ${week} review exited ${code}; retrying on a later poll`);
    logEvent("coach", "blog-failed", `Week ${week} review failed to generate (exit ${code}).`, { week, code });
    return null;
  }
  return week;
}
