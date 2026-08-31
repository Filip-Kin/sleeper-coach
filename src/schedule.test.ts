import { zonedInstant, lastOccurrence, isDue, JOBS, type Job } from "./schedule.ts";

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
  t(`${j.name} declares why and a sane window`, j.why.length > 20 && j.maxLateMs > 0 && j.dow >= 0 && j.dow <= 6 && j.hour < 24);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
