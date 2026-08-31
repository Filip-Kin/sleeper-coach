# In-season automation — summary

Branch `feat/inseason`. Built the in-season decision layer and the automation
that runs it, in the order the brief asked. 67 offline tests pass, `tsc --noEmit`
is clean. No live writes were issued; every browser-driving check was done in dry
run / shadow, and only ever against the staging league.

## What was built

**1. Weekly projection layer** — `src/analysis/week-projections.ts`.
Per-week projections scored under the league's exact rules, carrying opponent,
game id, injury status and bye. A missing row means no game that week (bye / not
playing), so it scores as an honest 0. Cached 30 min per week.

**2. Lineup solver** — `src/analysis/lineup.ts`.
Greedy, filling slots most-restrictive-first, which is optimal here because every
dedicated slot's eligibility set is a strict subset of FLEX. Anyone OUT / IR / on
bye / confirmed inactive is zeroed out *before* a single slot is assigned.
`lineup.test.ts` proves optimality by brute force over 40 random rosters and pins
the never-start-a-non-player property. Questionable is deliberately NOT benched
(Sleeper blanket-tags half the league Q).

**3. Offline replay harness** — `src/analysis/replay.ts`, committed test
`replay.test.ts` over frozen fixtures in `src/analysis/fixtures/`.
Fixtures are real weeks from the completed 2025 previous-season league (Filip =
roster_id 3): roster + that week's projections + what actually scored under real
league rules. The solver picks on projections; the score is points-left-on-bench
versus perfect hindsight, on complete starting lineups only (never a
cross-position value gap). Over the five committed weeks the solver matched or
beat the human's real lineup every time, averaging 7.05 points left on the bench.
Regenerate fixtures with `scripts/build-replay-fixture.ts` (not run by the test).

**4. Waiver engine** — `src/analysis/waivers.ts`, on top of the existing rails.
Priced in rolling waiver priority, not FAAB: costless free-agent adds are
preferred, and an on-waivers claim is proposed only when it clears a high bar,
because a successful claim sends us to the back of the queue. At most one claim
per cycle. Every drop goes through `canDrop`, so the injured-returns stash cannot
be cut. The claim/free-add gate is the **starting-lineup delta**, not the raw
point gap to whoever gets dropped — this is what stops the draft-night
capped-position trap (dropping our only kicker to roster a third QB because
250 > 130 on raw points; that move is −125 to the lineup and is now correctly
skipped).

**5. systemd timers** — `deploy/systemd/` (six timer/service pairs + install.sh +
README). Thursday lineup, Sunday main lock, Sunday/Monday inactive re-checks,
Tuesday waiver compute, Tuesday waiver submit. `OnCalendar` in US Eastern (the
host is on America/New_York; validated with systemd-analyze), `Persistent=true`
so a reboot-missed lock fires on wake.

## Runners and supporting modules

- `src/act/lineup-run.ts` — computes and (with `--live`) sets the lineup via the
  DOM-verified `/lineup`. Dry run by default. Refuses a partial lineup; alerts on
  any write failure.
- `src/act/waiver-run.ts` — shadow by default; `--live` performs only costless
  free-agent adds (verified `addPlayer`), never auto-submits a claim.
- `src/analysis/roster-week.ts` — joins roster ids + player dump + week
  projections into the solver's input.
- `src/analysis/ros-projections.ts` — rest-of-season points (through the wk17
  championship) as the keep/drop currency, with a data-driven stash flag.
- `src/killswitch.ts` — one `FREEZE` file on the state volume disables every
  write; recoverable from a phone, no container restart.

## Verified

- Full dry-run lineup pipeline end-to-end against the **staging** league: fills
  all ten slots correctly, right slot order, sensible totals.
- Waiver shadow run against staging: on the competitive full roster it correctly
  recommends nothing (after the cross-position fix).
- `setLineup` / `addPlayer` were left untouched (already verified per the brief).

## Not done / deferred (by design)

- The **live browser write paths were not exercised this session** to avoid
  colliding with the other sessions on the shared browser; `setLineup`/`addPlayer`
  were already staging-verified, and the runners only call those. Worth one
  staging `--live` lineup run before week 1 to confirm the runner→/lineup wiring.
- **Waiver claim submission** has no verified DOM flow yet (like trades). Claims
  are surfaced by alert for manual submission. Build + staging-verify that flow
  before flipping waivers fully live.
- `onWaivers` detection in the waiver runner is a labelled heuristic (a player
  dropped in the current scoring period is treated as still on waivers). It only
  affects whether a move is called a claim vs a free-add, never whether the rails
  permit it. Shadow mode is where to confirm it reads right.
- Rollout stays as the plan says: lineups live from week 1, waivers shadow until a
  reviewed cycle. The Tuesday submit unit ships in shadow.

## How to run

```
bun run test                                   # all 67 offline tests
bun run src/analysis/replay.test.ts            # the replay report card
bun run src/act/lineup-run.ts                  # dry-run this week's lineup
bun run src/act/waiver-run.ts                  # shadow this week's waivers
sudo bash deploy/systemd/install.sh            # install the timers (host)
```
