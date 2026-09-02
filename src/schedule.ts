// In-container scheduling for the weekly in-season locks.
//
// WHY NOT SYSTEMD. Filip: "I want this to run containerized so it's not using my
// systemd timer." So the schedule lives here, driven by the daemon poll loop that
// already runs inside the coach container, with durable state in the coach.db
// that is already there. No cron, no host units, nothing to install, and it
// survives a container restart because "have I run this occurrence yet" is a row
// in SQLite rather than in memory.
//
// WHY THE TIMEZONE WORK IS NOT OPTIONAL. The container runs UTC (verified:
// /etc/timezone is Etc/UTC, TZ unset) while the NFL schedule is Eastern. Worse,
// the 2026 season CROSSES the US DST boundary on 1 November, so a fixed UTC
// offset would silently shift every lock by an hour for the back half of the
// season, including the Sunday main lock. Every occurrence is therefore computed
// against the real IANA zone.
//
// WHY LATE RUNS ARE SKIPPED, not caught up. systemd's Persistent=true is the
// wrong semantic for a lineup lock: setting a lineup AFTER kickoff is worse than
// not setting one, because it can only shuffle players whose games have started.
// Each job declares how late it may still usefully run, and a missed occurrence
// beyond that is skipped with a log line rather than fired.

const ZONE = process.env.SCHEDULE_TZ ?? "America/New_York";

// The ET wall-clock parts of an instant.
function partsInZone(at: number, zone = ZONE): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) got[p.type] = p.value;
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(got.year), m: Number(got.month), d: Number(got.day),
    hh: Number(got.hour === "24" ? "0" : got.hour), mm: Number(got.minute),
    dow: DOW[got.weekday ?? "Sun"] ?? 0,
  };
}

// The instant at which the given ET wall-clock time occurs. Solved by iteration
// because the offset depends on the answer: guess UTC, see what ET that lands on,
// correct, repeat. Two passes settle it everywhere including DST changeovers.
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, zone = ZONE): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(guess, zone);
    const drift =
      (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(y, m - 1, d, hh, mm));
    if (drift === 0) break;
    guess -= drift;
  }
  return guess;
}

export interface Job {
  name: string;
  dow: number; // 0 = Sunday, in the schedule timezone
  hour: number; // schedule-timezone wall clock
  minute: number;
  // How late this occurrence may still run and be worth running.
  maxLateMs: number;
  // Why this time, so nobody has to re-derive it later.
  why: string;
}

// Human-readable day for a job's dow, for the boot banner and logs. dow -1 means
// "every day" (see the engineer job), which the raw ["Sun",...][dow] lookup rendered
// as "undefined 03:30 ET"; render it as "daily" and any weekday by name.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function dayLabel(job: Job): string {
  return job.dow === -1 ? "daily" : WEEKDAYS[job.dow] ?? "?";
}

// The most recent scheduled occurrence at or before `now`, or null if none in the
// last 8 days (which cannot happen for a weekly job, but keeps the search bounded).
export function lastOccurrence(job: Job, now: number, zone = ZONE): number | null {
  for (let back = 0; back <= 8; back++) {
    const probe = now - back * 86_400_000;
    const p = partsInZone(probe, zone);
    // dow -1 means "every day", used by jobs that are not tied to the NFL week.
    if (job.dow >= 0 && p.dow !== job.dow) continue;
    const at = zonedInstant(p.y, p.m, p.d, job.hour, job.minute, zone);
    if (at <= now) return at;
  }
  return null;
}

export interface DueVerdict {
  due: boolean;
  occurrence: number | null;
  reason: string;
}

// Should this job run right now, given when it last ran?
export function isDue(job: Job, now: number, lastRun: number, zone = ZONE): DueVerdict {
  const occ = lastOccurrence(job, now, zone);
  if (occ === null) return { due: false, occurrence: null, reason: "no occurrence in the search window" };
  if (lastRun >= occ) return { due: false, occurrence: occ, reason: "already ran this occurrence" };
  const late = now - occ;
  if (late > job.maxLateMs) {
    return {
      due: false,
      occurrence: occ,
      reason: `missed by ${Math.round(late / 60000)} min, past the ${Math.round(job.maxLateMs / 60000)} min useful window; skipping rather than acting late`,
    };
  }
  return { due: true, occurrence: occ, reason: `due, ${Math.round(late / 60000)} min after the ${job.hour}:${String(job.minute).padStart(2, "0")} ${zone} lock` };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// The weekly locks. Times are Eastern because the NFL schedule is.
export const JOBS: Job[] = [
  {
    // Hourly would be wasteful and nightly too slow to matter, so it runs twice a
    // day: once in the small hours when nothing else is competing for the shared
    // browser, and once in the early evening so a request filed during a Sunday
    // does not wait until Monday. Requests are also filed automatically, so this
    // is the loop that makes the system self-repairing rather than a manual tool.
    name: "engineer", dow: -1, hour: 3, minute: 30, maxLateMs: 12 * HOUR,
    why: "Drains the improvement queue. Daily, off-peak, and late-tolerant because it writes no game state.",
  },
  {
    name: "lineup-thursday", dow: 4, hour: 16, minute: 0, maxLateMs: 4 * HOUR,
    why: "Thursday Night Football kicks off 20:15 ET, so 16:00 leaves four hours and the late window closes before kickoff.",
  },
  {
    name: "lineup-sunday", dow: 0, hour: 11, minute: 0, maxLateMs: 2 * HOUR,
    why: "The main lock. Sunday early games start 13:00 ET, so 11:00 gives two hours and the late window ends at kickoff.",
  },
  {
    name: "inactive-sunday", dow: 0, hour: 18, minute: 45, maxLateMs: 1 * HOUR,
    why: "Late-window games start 20:20 ET; catch confirmed inactives among late starters.",
  },
  {
    name: "inactive-monday", dow: 1, hour: 19, minute: 0, maxLateMs: 1 * HOUR,
    why: "Monday Night Football kicks off 20:15 ET.",
  },
  {
    // The pick'em pool keeps only ONE scheduled pass. The passes that matter are
    // driven off real kickoff times by the daemon (pickemTriggerDue), because a
    // fixed timetable cannot support a tight window: with passes hours apart, a
    // twenty-minute window would mean almost no game ever got its final pick.
    //
    // This daily pass is the backstop that makes the tight window safe. It
    // guarantees a full provisional slate exists, and it refreshes the kickoff
    // cache the trigger reads, which is also how flex scheduling gets picked up.
    name: "pickem-slate", dow: -1, hour: 9, minute: 0, maxLateMs: 14 * HOUR,
    why: "Daily backstop: fills any blank game with a favourite (which leaks nothing) and refreshes the kickoff cache that drives the real pre-kickoff passes.",
  },
  {
    // Offers of our own. Wednesday morning, after Tuesday night waivers have
    // settled, so the rosters it reasons about are the ones people actually
    // have. Late tolerance is generous because being a few hours late costs
    // nothing: this is not a deadline, it is an opportunity.
    name: "trade-propose", dow: 3, hour: 10, minute: 0, maxLateMs: 10 * HOUR,
    why: "Weekly outbound offers, after waivers settle so rosters are stable. Self-limiting: at most two of our offers outstanding, one per rival, nothing repeated for 21 days, and nothing sent unless the other side gains too.",
  },
  {
    name: "waiver-compute", dow: 2, hour: 2, minute: 0, maxLateMs: 12 * HOUR,
    why: "Read-only planning, so being late costs nothing; it just needs to precede the submit.",
  },
  {
    name: "waiver-submit", dow: 2, hour: 20, minute: 0, maxLateMs: 6 * HOUR,
    why: "Waivers clear Wednesday 07:00 GMT, which is Wednesday 02:00 ET in winter and 03:00 ET in summer, so Tuesday 20:00 ET is six to seven hours ahead of the cutoff.",
  },
];
