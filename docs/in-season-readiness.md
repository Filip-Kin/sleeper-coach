> **SUPERSEDED, 31 August 2026.** Everything below about host systemd timers is
> out of date. Filip asked for this to run containerized: "I want this to run
> containerized so it's not using my systemd timer." The schedule now lives in
> `src/schedule.ts`, driven by the daemon poll loop inside the coach container,
> with "have I handled this occurrence" as a row in `coach.db`. There is nothing
> to install on the host and `deploy/systemd/` has been deleted.
>
> Two behaviours changed with it, both deliberate:
> - **Timezone is computed against the real IANA zone**, not a fixed offset. The
>   container is UTC while the NFL schedule is Eastern, and the 2026 season crosses
>   the DST boundary on 1 November, so a fixed offset would have fired every lock
>   an hour early for the back half of the season.
> - **A missed lock is SKIPPED, not caught up.** systemd's `Persistent=true` is the
>   wrong semantic for a lineup: one set after kickoff can only shuffle players
>   whose games have started, so it is worse than not setting one. Each job
>   declares how late it may still usefully run.
>
> Arming is now just "the container is running", so the arm checklist below reduces
> to the kill switch: `touch /data/sleeper-coach/FREEZE` stops every write.

# In-season readiness

Written 31 August 2026, nine days before the season opens (9 September). Audit of
the whole scheduled in-season path end to end: what each job reads, what it
writes, what happens when it fails halfway, and how to tell afterwards whether it
worked. This is a go/no-go document, so the failure modes are stated plainly
rather than reassured away.

## Verdict

The lineup and waiver paths are ready to arm. Nothing is installed yet: with no
timers, the coach does nothing on 9 September, which is the safe default but not
the intended one. The `deploy/systemd/install.sh` step is the whole arming
action, and it is deliberately a separate human decision (see
`docs/arm-checklist.md`).

Two rollout facts hold from the plan: lineups run live from week 1 (reversible,
pure upside); waivers ship in shadow and go live only after a human reviews a
shadow cycle. The waiver claim and IR-move write paths are not built, so those are
surfaced by alert for manual action, never issued blind.

Confirmed live on 31 August against the read-only API and the staging league:

- Host timezone is `America/New_York` (EDT, -0400); systemd is 247. Every
  `OnCalendar` normalises to the intended weekday and time (checked with
  `systemd-analyze calendar`).
- Both the real league (`1389357604773322752`) and the staging clone
  (`1399830848848592896`) are `waiver_type: 0` (rolling priority, NOT FAAB). The
  stored `waiver_budget: 100` is a Sleeper default and is not used.
- Both leagues have `reserve_slots: 2` (two IR slots), which is NOT listed in
  `roster_positions` and lives only in `settings.reserve_slots`. This was a real
  bug: the waiver runner read IR capacity off `roster_positions` and always got 0,
  so the IR path was dead. Fixed (see the week-7 mission below).
- All four live write/refusal paths exercised against staging (timings below).

## The scheduled jobs

Six host-level systemd timers `docker exec` into the coach container (its name is
looked up each run because Coolify renames it on rebuild). Times are US Eastern.

| Timer | When (ET) | Runs | Writes? |
| --- | --- | --- | --- |
| `lineup-thursday` | Thu 16:00 | `lineup-run.ts --live` | Yes, lineup |
| `lineup-sunday` | Sun 11:00 | `lineup-run.ts --live` | Yes, lineup (the main lock) |
| `inactive-sunday` | Sun 18:45 | `lineup-run.ts --live --refresh` | Yes, lineup |
| `inactive-monday` | Mon 19:00 | `lineup-run.ts --live --refresh` | Yes, lineup |
| `waiver-compute` | Tue 02:00 | `waiver-run.ts` (shadow) | No |
| `waiver-submit` | Tue 20:00 | `waiver-run.ts` (shadow until `--live` added) | Costless free adds only when live |

### lineup-thursday / lineup-sunday / inactive-sunday / inactive-monday

**Reads.** The read-only public Sleeper API: NFL state (current week/season), the
league (roster positions, scoring), and our roster's `players` membership array
(never the `starters` array, which is the stale one). Plus the per-week
projections endpoint and the cached daily player dump (positions, injury status).
The two inactive re-checks pass `--refresh` to force-refresh those caches so a
late scratch is seen.

**Writes.** One write: the ordered starter ids posted to the browser server's
`/lineup`, which drives the Sleeper DOM and verifies by reloading the team page
and re-reading it. Idempotent: a slot already correct is not clicked, so an
inactive re-check that finds nothing changed writes nothing.

**Failure halfway.** The important failure modes, not reassurance:

1. **The solver is blind to in-game locks.** `solveLineup` zeroes out anyone
   OUT/IR/on-bye/inactive, but it has no concept of "this player's game has
   already kicked off and is locked". If a run happens after kickoff (a late
   catch-up, or a manual `systemctl start` at the wrong time), the solver can want
   to move a locked player, `setLineup` cannot, and the read-back verification
   throws after three attempts. It leaves whatever partial rearrangement the
   unlocked swaps produced and alerts. This is why the lineup timers are
   `Persistent=false` (below): a lineup is only valid before kickoff.
2. **Partial write then a loud stop.** `setLineup` swaps only the slots that
   differ, re-reads after each swap, retries up to three times, then verifies
   against a fresh page load. A silently refused swap (an ineligible position, a
   locked player) makes the final verification throw. The runner catches that,
   logs `lineup-failed`, and alerts. It does not attempt to undo the swaps that
   did land, so the roster can be left mid-rearrangement. The signal is loud (an
   alert), but the state is not guaranteed clean; a human should look.
3. **An unfillable slot is refused, not half-set.** If the roster cannot fill
   every starting slot with a healthy body, the runner alerts and refuses to write
   at all rather than set a partial lineup (`starterIds` throws on an empty slot).
4. **The rosters API lag is real and was reproduced live.** On 31 August, after a
   confirmed staging add, the public rosters API still served the pre-add roster on
   two successive polls minutes later while the DOM showed the change. The coach's
   own read-back is DOM-based and correct; the trap is for a HUMAN checking "did it
   work?" in the Sleeper app or API, who may see stale data for minutes. Trust the
   activity log and the DOM, not a quick API glance.

**How to tell afterwards.** `journalctl -u sleeper-coach-lineup-sunday.service`
for the run, and the activity log at `/data/sleeper-coach/activity.jsonl`: a
`lineup-set` event with the projected total means it landed and verified; a
`lineup-failed` or `lineup-plan` with no following `lineup-set` means it did not.
An alert fires on any write failure or unfillable slot.

### waiver-compute (Tue 02:00) and waiver-submit (Tue 20:00)

**Reads.** NFL state, the league, all rosters (to compute who is available), the
player dump, and rest-of-season projections (summed through the week-17
championship, the correct currency for keep/drop). Recent transactions to guess
whether a player is still on a waiver hold or has cleared. Bye weeks from the
static `src/data/byes.ts`.

**Writes.** `waiver-compute` writes nothing (shadow review only). `waiver-submit`
writes nothing in shadow. When flipped to `--live`, it performs only costless
free-agent ADDS through the verified `addPlayer` path, at most stopping after the
first successful add (one transaction per run). A waiver CLAIM and an IR move are
never auto-submitted; both are surfaced by alert.

**Failure halfway.** A free-agent add that fails read-back throws, logs
`waiver-add-failed`, alerts, and stops before any further move, so a batch can
never leave a half-applied state (it does one add per run by design). The
`onWaivers` claim-vs-free-add label is a documented heuristic (a player dropped in
the current scoring period is treated as still on hold); it only affects whether a
move is called a claim or a free add, never whether the rails permit it. Shadow
mode is where to confirm it reads right.

**How to tell afterwards.** The activity log: `waiver-shadow` (or `waiver-run`
when live) carries the free adds, the single best claim, the upcoming crowded-bye
watch, and any IR opportunity. A recommended claim or IR move also fires an alert
for manual action.

## Timer verification

Checked every `OnCalendar` against the stated facts: Sunday games start 13:00 ET,
Thursday night 20:15 ET, waivers clear Wednesday 07:00 GMT (which is Wed 03:00 EDT
in September, Wed 02:00 EST from November).

| Timer | OnCalendar | Against the fact | Verdict |
| --- | --- | --- | --- |
| `lineup-thursday` | Thu 16:00 ET | 4h15m before the 20:15 TNF lock | correct |
| `lineup-sunday` | Sun 11:00 ET | 2h before the 13:00 kickoffs | correct |
| `inactive-sunday` | Sun 18:45 ET | after the afternoon games, before SNF (~20:20) | correct |
| `inactive-monday` | Mon 19:00 ET | 1h15m before the 20:15 MNF | correct |
| `waiver-compute` | Tue 02:00 ET | after Monday's MNF finishes (~23:30) | correct |
| `waiver-submit` | Tue 20:00 ET | 6-7h before the Wed 07:00 GMT clear | correct |

DST is handled by systemd evaluating `OnCalendar` in the host timezone. None of
the times land in the March spring-forward gap or the early-November fall-back
overlap (both happen at 02:00-03:00 on a Sunday; only `waiver-compute` is near
02:00 and it runs on Tuesday), so no time doubles or is skipped.

## Persistent: correct for waivers, wrong for lineups (fixed)

The units previously set `Persistent=true` on every timer. That is wrong for a
lineup lock and I have changed the four lineup timers to `Persistent=false`.

The reasoning is Filip's own test: a lineup set AFTER kickoff is worse than not
setting one. `Persistent=true` replays a timer missed during downtime when the box
comes back. For a lineup, that catch-up can land after kickoff, where the
lock-blind solver wants to move players who are now locked, `setLineup` cannot, and
the run fails verification and can leave a half-rearranged lineup. A missed lock is
therefore better skipped: Thursday already sets a complete lineup that stands, and
any lock can be re-run by hand before its own kickoff.

This is a genuine trade-off, stated honestly. `Persistent=false` also drops the
good catch-up (box down over the exact lock minute, revived still before kickoff,
would now skip rather than fire). That case is rare on a home server that is up
almost continuously, its downside is bounded (the previous full lineup stands), and
it is recoverable by hand, so trading it away to remove the after-kickoff hazard is
the right call. A kickoff-aware cutoff inside the runner would preserve both, but
the container runs UTC (no `TZ` set), which makes an in-runner Eastern cutoff
error-prone; the blunt, safe lever is preferred over new untestable time code on
the live write path.

Waiver timers keep `Persistent=true`: a waiver run is deadline-bound, not
kickoff-bound, so a submit missed Tuesday and replayed before the Wednesday clear
is still useful.

## The waiver engine is priced for rolling priority

Confirmed the code reflects `waiver_type: 0`, not FAAB. `src/analysis/waivers.ts`
prices every move in queue position, not dollars:

- A successful claim sends us to the back of the queue, so at most ONE claim is
  proposed per cycle (`bestClaim`), and only when the starting-lineup gain clears a
  deliberately high bar (`claimMarginPts` 15 ROS) and the player would actually
  start (`claimMustStart`). Anything under that bar returns "wait": do not claim,
  wait for him to clear, then free-add at no cost.
- A player who has cleared waivers is a free agent and costs nothing. Free adds are
  ranked ahead of claims in `planWaivers` and are the only thing `--live` performs
  automatically. This is the "prefer costless adds" rule made mechanical.
- Every drop goes through `canDrop`, which protects the top-12 by ROS, the
  never-drop list, and above all the injured-but-returns stash. The engine chooses
  the drop by starting-lineup delta, never the raw cross-position point gap, which
  is the draft-night capped-position trap (dropping our only kicker to roster a
  higher-ROS third QB is a lineup loss, and is now skipped).

The `waiver_budget: 100` field is present but unused at `waiver_type: 0`, so no
code reads it. That is correct.

## The week-7 mission: carry the week-8 hole forward

Four of our starters share the week-8 bye. It costs about 10.7 points that week and
is the worst single-week hole in the league. It could not be fixed on draft night
(every free agent off that bye was worse than our worst week-8 starter, and IR
cannot park a healthy player), so it is a week-7 job and the system now remembers
it rather than relying on a human noticing. Built into the weekly waiver cycle and
tested in `src/analysis/waivers.test.ts`:

1. **Upcoming-bye lookahead** (`upcomingByeCrunch`). Each run scans the next two
   weeks for any week where our projected STARTERS on bye reach three or more, and
   treats relieving it as an objective. It counts starters, not roster bodies: four
   bench players on one bye costs nothing, so a raw count would fire on harmless
   weeks. Starters are our optimal ROS lineup, the honest proxy that far out.
   Verified live: at week 6 against staging it flagged "week 8 bye: 4 of our
   starters off" and named the best available body that plays that week.
2. **Bye-relief tie-break** (mirrors `trade-fair.ts`: `crowdedByeAt` 3,
   `byeReliefPts` 4). A candidate who plays through a crowded upcoming bye is
   credited and one on it is debited, but ONLY on the ranking score, never on an
   accept gate. It breaks ties between comparable adds and can never turn a
   lineup-negative move into an accepted one. Tested both directions.
3. **IR opportunity detection** (`irOpportunities`). An IR slot is a costless
   roster expansion. Each run finds rostered players a designation makes
   IR-eligible IN THIS LEAGUE (the eligibility set is read from the
   `reserve_allow_*` flags: our league allows OUT and SUS onto IR, not NA/DNR/
   DOUBTFUL) and, if a slot is free, surfaces moving them to IR to free an active
   slot for the best available add. It respects the rails: an injured-but-returns
   stash belongs on IR, kept cheaply, never dropped. The IR-move DOM flow is not
   built, so this is alerted for manual action, not executed.
4. **The weekly output says what it is watching**, not only what it did: even a run
   that acts on nothing prints the upcoming crowded bye, the best relief candidate
   considered, any IR opportunity, and the best available player. This is the
   draft-night lesson (Filip having to ask repeatedly what the engine was about to
   do) made into a standing report.

## Live staging exercises (item 3)

All against the staging league `1399830848848592896`, our roster_id 1, full 16-man
roster, on 31 August. Timings are wall-clock.

| Exercise | Result | Time |
| --- | --- | --- |
| Live lineup write (`lineup-run --live`) | Set and verified, 149.5 projected | 6.0s |
| Read-back catches a deliberate mismatch | Illegal QB/K permutation refused by the DOM; read-back threw `slot 0 (qb) is 11566, wanted 4227`; lineup left unchanged | 18.7s |
| Add with a forced drop | Added Jared Goff, dropped Kenny Gainwell; addPlayer's DOM read-back confirmed both | 13.5s |
| Rails / guard refusal | Write path refused a drop of a player not on the roster (`not in the drop list; refusing to drop anyone else`), no state change; and the engine `canDrop` refused to drop the #1 ROS player and skipped a redundant high-ROS add on the live roster | 6.9s + engine |

The mismatch test doubles as proof the lineup fails safe: an impossible swap leaves
the lineup as it was rather than corrupting it. The add test doubles as a live
reproduction of the stale rosters-API cache (DOM changed, API did not).

Residual staging state: roster 1 now carries Jared Goff instead of Kenny Gainwell
and holds the week-1 optimal lineup. Staging is disposable ("coach-staging DO NOT
USE"), so this was left as-is.

## Kill switch

One file freezes every write with no container restart:
`docker exec <coach> touch /data/sleeper-coach/FREEZE`. The check
(`assertWritesAllowed`) sits inside `setLineup` and `addPlayer` themselves, the
chokepoint every write passes through, so a manual curl to the browser API is
frozen too, not just the scheduled runners. A frozen run still computes and logs
what it would do, then stops before the write. Filip verified live that it refuses
a write and leaves the roster unchanged. Remove the file to resume.

## Known gaps (not armed, by design)

- **Waiver claim submission** has no verified DOM flow. Claims are surfaced by
  alert for manual submission. Build and staging-verify that flow before flipping
  waivers fully live for claims.
- **IR moves** have no DOM flow either; surfaced by alert.
- **Outgoing trade proposals** stay in shadow (least testable, least urgent; trade
  deadline is week 11). Incoming trade evaluation is two-sided and rail-guarded.
- **The Discord announcer is intentionally down** and stays down.

## What would make this a no-go

If the host timezone were not `America/New_York` (it is), if a lineup timer were
`Persistent=true` (fixed), if `setLineup` did not verify against the DOM (it does),
or if the kill switch did not gate the write functions themselves (it does). None
of these hold, so the path is armable. The remaining risk is the lock-blindness
described above, which `Persistent=false` and the read-back verification contain
but do not eliminate; a lineup run should never be triggered by hand after kickoff.
