import { readFileSync } from "node:fs";
import { pickemTriggerDue } from "./pickem/strategy.ts";
import { zonedInstant, lastOccurrence, isDue, dayLabel, jitterFor, JOBS, type Job } from "./schedule.ts";

let pass = 0, fail = 0;
const t = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
const et = (at: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(at));

// 1. A summer Sunday (EDT, UTC-4): 11:00 ET should be 15:00 UTC.
const summer = zonedInstant(2026, 9, 13, 11, 0);
t("summer Sunday 11:00 ET maps to 15:00 UTC", new Date(summer).toISOString() === "2026-09-13T15:00:00.000Z", new Date(summer).toISOString());

// 2. THE CASE THAT MATTERS. US DST ends on the first Sunday of November, which in
//    2026 is 1 November, mid-season. After it, ET is UTC-5, so the same 11:00 ET
//    lock must move to 16:00 UTC. A fixed offset would silently fire an hour
//    early for the whole back half of the season.
const afterDst = zonedInstant(2026, 11, 8, 11, 0);
t("post-DST Sunday 11:00 ET maps to 16:00 UTC", new Date(afterDst).toISOString() === "2026-11-08T16:00:00.000Z", new Date(afterDst).toISOString());
const onDstDay = zonedInstant(2026, 11, 1, 11, 0);
t("on the changeover day itself 11:00 ET is still 11:00 ET", et(onDstDay).includes("11:00"), et(onDstDay));

// 3. lastOccurrence lands on the right weekday and at or before now.
const sundayJob = JOBS.find((j) => j.name === "lineup-sunday")!;
const nowThu = zonedInstant(2026, 10, 1, 9, 30); // a Thursday morning ET
const occ = lastOccurrence(sundayJob, nowThu)!;
t("from Thursday, the last Sunday lock is the previous Sunday", et(occ).startsWith("Sun") && occ <= nowThu, et(occ));

// 4. Due logic.
const justAfter = occ + 5 * 60_000;
t("due when it has not run this occurrence", isDue(sundayJob, justAfter, occ - 86_400_000).due);
t("not due when it already ran this occurrence", !isDue(sundayJob, justAfter, occ).due);

// 5. LATE RUNS ARE SKIPPED, not caught up: a lineup set after kickoff is worse
//    than not setting one. Sunday lock allows 2h; 3h late must be refused.
const wayLate = occ + 3 * 60 * 60_000;
const v = isDue(sundayJob, wayLate, occ - 86_400_000);
t("a lock missed past its useful window is skipped", !v.due && v.reason.includes("skipping"), v.reason);
// A read-only job may run much later without harm.
const compute = JOBS.find((j) => j.name === "waiver-compute")!;
const cOcc = lastOccurrence(compute, zonedInstant(2026, 10, 6, 8, 0))!;
t("a read-only job tolerates being hours late", isDue(compute, cOcc + 5 * 60 * 60_000, 0).due);

// 6. Every job is self-documenting and internally sane.
for (const j of JOBS) {
  // dow -1 is legal and means "every day", used by jobs not tied to the NFL week.
  t(`${j.name} declares why and a sane window`, j.why.length > 20 && j.maxLateMs > 0 && j.dow >= -1 && j.dow <= 6 && j.hour < 24);
}

// A daily job (dow -1) must fire every day, not only on one weekday.
const daily = JOBS.find((j) => j.dow === -1);
if (daily) {
  const days = new Set<string>();
  for (let d = 0; d < 7; d++) {
    const now = zonedInstant(2026, 10, 5 + d, 23, 0);
    const occ = lastOccurrence(daily, now);
    if (occ !== null) days.add(new Date(occ).toISOString().slice(0, 10));
  }
  t(`${daily.name} has a distinct occurrence on each of 7 consecutive days`, days.size === 7, `${days.size}`);
}

// 7. Every job renders a readable day label in the boot banner. The banner used a
//    bare ["Sun",...][dow] lookup, so the dow -1 daily job printed "undefined
//    03:30 ET"; assert no job ever yields an empty or undefined label again.
for (const j of JOBS) {
  const label = dayLabel(j);
  t(`${j.name} renders a non-empty day label`, typeof label === "string" && label.length > 0 && label !== "undefined", label);
}
t("the daily (dow -1) job renders as 'daily'", JOBS.filter((j) => j.dow === -1).every((j) => dayLabel(j) === "daily"));

// 8. Every job must have a command wired in the daemon. A job with no command logs
// "has no command; skipping" and silently never runs, so a job can look
// scheduled while doing nothing at all. Checked against the daemon source
// because JOB_COMMAND lives next to a module with start-up side effects.
{
  const daemon = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
  const missing = JOBS.filter((j) => !daemon.includes(`"${j.name}":`)).map((j) => j.name);
  t("every scheduled job has a command in the daemon", missing.length === 0, missing.join(", "));
}

// 9. Every real NFL kickoff slot must actually get a final pick'em pass. The
//    first cut used a fixed daily timetable and left the Sunday 16:25 ET slate
//    with no pass inside its window at all, so those games would have kept
//    provisional favourites all season. Passes are now driven off kickoff times,
//    so what has to hold is that the daemon's poll rate reaches every slot.
{
  const WINDOW_MIN = Number(process.env.PICKEM_FINAL_WINDOW_MIN ?? "20");
  const POLL_MS = 90_000;
  const slots: [string, number][] = [
    ["London 09:30", 9.5], ["Sunday early 13:00", 13], ["Sunday 16:05", 16 + 5 / 60],
    ["Sunday late 16:25", 16 + 25 / 60], ["Sunday night 20:20", 20 + 20 / 60],
    ["Monday night 20:15", 20.25], ["Thursday night 20:15", 20.25], ["Thursday 20:35", 20 + 35 / 60],
    ["Thanksgiving 12:30", 12.5], ["Thanksgiving 16:30", 16.5],
    ["Black Friday 15:00", 15], ["Christmas 13:00", 13], ["Saturday 20:15", 20.25],
  ];
  for (const [label, kickoffHour] of slots) {
    // Simulate the daemon polling through the window before this kickoff and
    // count the passes it would spawn. Kickoff-driven means the hour of day is
    // irrelevant, which is the whole point, so assert that directly.
    const kickoff = zonedInstant(2026, 11, 15, 0, 0) + kickoffHour * 3_600_000;
    let last = kickoff - 24 * 3_600_000;
    let attempts = 0;
    for (let now = kickoff - WINDOW_MIN * 60_000; now < kickoff; now += POLL_MS) {
      if (pickemTriggerDue([kickoff], now, last)) { attempts++; last = now; }
    }
    t(`${label} ET gets a final pass before kickoff`, attempts >= 5, `${attempts} attempts`);
  }
  t("the pick'em backstop is daily, so no day of the week is uncovered",
    JOBS.filter((j) => j.name.startsWith("pickem-")).every((j) => j.dow === -1));
}

// 10. FREE-AGENT RANDOMISATION. Filip's one condition for letting the coach
//     manage the team: it must not take every dropped player the instant he
//     appears. Claims are unaffected and deliberately so; verified from the live
//     league that waiver_type is 0 (rolling priority) with an explicit
//     waiver_position per roster, a strict 1..8 order, so cross-team claims
//     resolve by that number and submission time changes nothing for anyone.
//     Free-agent adds are first come first served, so THAT is what is randomised.
{
  const fa = JOBS.find((j) => j.name === "free-agent");
  t("there is a free-agent job", fa !== undefined);
  if (fa) {
    t("free agents are randomised across a window", (fa.jitterMs ?? 0) >= 8 * 60 * 60 * 1000,
      `${Math.round((fa.jitterMs ?? 0) / 3_600_000)}h`);
    t("the free-agent job is daily, since free agents appear every day", fa.dow === -1);

    // Stability: the same occurrence must always give the same offset, or a
    // restart would re-roll and could buy an earlier slot than the one we drew.
    const occ = zonedInstant(2026, 10, 7, 10, 0);
    t("the offset is stable for one occurrence", jitterFor(fa, occ) === jitterFor(fa, occ));

    // Spread: different days must land in genuinely different places, otherwise
    // the others can just learn the time.
    const offsets = new Set<number>();
    let min = Infinity, max = -Infinity;
    for (let d = 0; d < 60; d++) {
      const o = jitterFor(fa, zonedInstant(2026, 10, 1 + d, 10, 0));
      offsets.add(Math.floor(o / 3_600_000));
      min = Math.min(min, o); max = Math.max(max, o);
    }
    t("offsets spread across most hours of the window", offsets.size >= 7, `${offsets.size} distinct hours`);
    t("offsets stay inside the window", min >= 0 && max < (fa.jitterMs ?? 0), `${min}..${max}`);

    // And the job must not be considered due before its drawn slot.
    const occ2 = zonedInstant(2026, 10, 8, 10, 0);
    const drawn = jitterFor(fa, occ2);
    t("not due before the drawn slot", isDue(fa, occ2 + drawn - 60_000, 0).due === false);
    t("due at the drawn slot", isDue(fa, occ2 + drawn + 1000, 0).due === true);
  }

  const submit = JOBS.find((j) => j.name === "waiver-submit");
  t("waiver-submit is NOT randomised, because claim timing changes nothing",
    submit !== undefined && !submit.jitterMs);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
