import { describe, expect, test } from "bun:test";
import { weekSettled, shouldPublish, reviewableWeek, maybePublishWeekly } from "./auto.ts";
import type { BlogPost } from "./store.ts";

const HOUR = 3_600_000;
const SETTLE = 6 * HOUR;
const g = (status: string, startTime: number) => ({ status, startTime });
const done = [g("complete", 0), g("complete", 10 * HOUR)];
const post = (week: number): BlogPost => ({ slug: `w${week}`, title: `Week ${week} review`, date: "", type: "week", body: "", week });

describe("weekSettled", () => {
  test("all complete and past the settle delay", () => {
    expect(weekSettled(done, 16 * HOUR, SETTLE)).toBe(true);
  });
  test("all complete but the stat feed is still moving", () => {
    expect(weekSettled(done, 12 * HOUR, SETTLE)).toBe(false);
  });
  test("one game still to play", () => {
    expect(weekSettled([...done, g("pre_game", 30 * HOUR)], 40 * HOUR, SETTLE)).toBe(false);
  });
  test("a game in progress", () => {
    expect(weekSettled([g("complete", 0), g("in_progress", 10 * HOUR)], 99 * HOUR, SETTLE)).toBe(false);
  });
  test("an empty slate is never settled, because that means the read failed", () => {
    expect(weekSettled([], 99 * HOUR, SETTLE)).toBe(false);
  });
});

describe("shouldPublish", () => {
  test("publishes once the week is settled and nothing is posted", () => {
    expect(shouldPublish(1, done, [], 16 * HOUR, SETTLE)).toBe(true);
  });
  test("never twice for the same week", () => {
    expect(shouldPublish(1, done, [post(1)], 16 * HOUR, SETTLE)).toBe(false);
  });
  test("another week's post does not satisfy this one", () => {
    expect(shouldPublish(2, done, [post(1)], 16 * HOUR, SETTLE)).toBe(true);
  });
  test("week 0 is not reviewable", () => {
    expect(shouldPublish(0, done, [], 16 * HOUR, SETTLE)).toBe(false);
  });
});

describe("reviewableWeek", () => {
  test("week 1 is owed a review once the NFL is in week 2", () => {
    expect(reviewableWeek(2)).toBe(1);
  });
  test("nothing is owed during week 1", () => {
    expect(reviewableWeek(1)).toBe(0);
  });
});

describe("maybePublishWeekly", () => {
  const deps = (over: Partial<Parameters<typeof maybePublishWeekly>[0]> = {}) => {
    const calls: number[] = [];
    return {
      calls,
      deps: {
        now: 16 * HOUR, posts: () => [], currentWeek: async () => 2,
        games: async () => done,
        run: async (w: number) => { calls.push(w); return 0; },
        ...over,
      },
    };
  };
  test("publishes the finished week exactly once", async () => {
    const { calls, deps: d } = deps();
    expect(await maybePublishWeekly(d)).toBe(1);
    expect(calls).toEqual([1]);
  });
  test("does nothing when the week is already posted, without a network call", async () => {
    const { calls, deps: d } = deps({ posts: () => [post(1)] });
    expect(await maybePublishWeekly(d)).toBeNull();
    expect(calls).toEqual([]);
  });
  test("does nothing during week 1", async () => {
    const { calls, deps: d } = deps({ currentWeek: async () => 1 });
    expect(await maybePublishWeekly(d)).toBeNull();
    expect(calls).toEqual([]);
  });
  test("a failing generator publishes nothing and is retried later", async () => {
    const { deps: d } = deps({ run: async () => 1 });
    expect(await maybePublishWeekly(d)).toBeNull();
  });
  test("an unsettled week is not published", async () => {
    const { calls, deps: d } = deps({ now: 12 * HOUR });
    expect(await maybePublishWeekly(d)).toBeNull();
    expect(calls).toEqual([]);
  });
});
