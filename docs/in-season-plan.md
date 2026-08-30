# In-season plan

Written 30 August 2026, the afternoon of the draft. The 2026 regular season
starts 9 September, so the first lineup lock is about ten days after the draft.

## The constraint that shapes everything

The draft was safe to get wrong. Mock drafts are free, so the engine was tested
across three of them this morning and two real bugs fell out. Nothing in-season
works like that. A dropped player is gone the moment someone else claims him, an
accepted trade cannot be unwound, and FAAB spent is spent. Filip dropped a good
player last season for exactly this reason.

So the design rule for every in-season action is: **the model proposes, code
decides what is permitted.** An agent that is having a bad day should be unable
to do lasting damage, not merely unlikely to.

## Actions ranked by how bad a mistake is

This ordering drives the whole rollout.

| Action | Reversible? | Worst case |
| --- | --- | --- |
| Set a lineup | Yes, until kickoff | Points left on the bench for one week |
| Add from waivers into a free slot | Effectively yes | A wasted roster spot and some FAAB |
| Bid FAAB | No, once processed | Overpaid for a marginal player |
| **Drop a player** | **No** | **Lose a real asset for nothing** |
| Accept or propose a trade | No | Lose a real asset for nothing |

Lineups are pure upside and get automated first. Drops and trades are where the
rails go.

## Rails that are code, not judgement

These are deterministic checks in front of the write path. The agent's reasoning
never overrides them.

**Protected list.** A player may not be dropped if any of these hold:
- he is in the top N of our roster by rest-of-season projection (N sized to
  starters plus a small buffer),
- his rostered percentage across Sleeper is high (he is a player other managers
  clearly want),
- he is injured but projected back before the week 16 playoffs, meaning he is a
  stash rather than dead weight.

That last clause is the one that matters most. A hurt starter looks worthless to
a naive weekly projection and is exactly the player you must not cut.

**A drop must be a clear upgrade.** The incoming player has to beat the dropped
player's rest-of-season projection by a margin, not merely tie. Ties keep the
incumbent.

**Prefer paths that drop nobody.** In order: an empty bench slot, then the two
IR slots for genuinely injured players, then a FAAB bid (which only costs a drop
if the claim actually wins). Only after all of those does a straight drop get
considered.

**One transaction per wake-up.** Do a thing, re-read the roster from Sleeper,
confirm it matches intent, stop. No batching several moves on one pass, because
a half-applied batch is the hardest state to reason about.

**Read-back verification on every write.** No action counts as done until the
resulting state has been fetched back and matches what was intended. On a
mismatch: change nothing further, log it, alert. This turns a silent partial
failure into a loud stop, which is the single most valuable property when there
is no test environment.

**Trades need to survive twice.** An outgoing offer is logged as an intent on one
pass and only sent on the next, so a bad idea has to look good twice. Incoming
offers auto-reject below a margin, auto-accept above a clear threshold, and
anything in between is left pending and surfaced rather than guessed at.

**Kill switch.** A file on the state volume disables all writes. Filip can freeze
the coach instantly without stopping the container or touching Coolify.

## There is more of a test environment than it first appears

Two of the three untestable things turn out to be testable.

**A staging league.** Sleeper lets anyone create a private league. An 8-team
full-PPR league with identical roster slots, auto-drafted and then abandoned,
gives a real DOM to exercise lineup setting and add/drop against with zero
consequence. That covers the two highest-frequency write paths. Trades need a
counterparty so they stay only partly testable, which is why trades get the
strictest rail.

**Offline replay for the decision layer.** The lineup logic can be scored against
weeks that have already happened: feed it a past week's roster and projections,
let it pick a lineup, then compare against what actually scored. The measure is
points left on the bench versus perfect hindsight. That is a real regression test
for the part of the system most likely to be subtly wrong, and it needs no live
writes at all. Sleeper's per-week projections endpoint
(`/projections/nfl/<season>/<week>`) already returns 746 rows with opponent and
game id, and `sleeper.weekProjections` is already in the client.

**Shadow mode.** The first cycle of waivers and trades runs the full pipeline and
writes nothing, logging what it would have done. Flip to live once a cycle looks
sensible. Lineups skip shadow mode because they are reversible and the cost of
not automating them is a real weekly loss.

## Rollout

- **Week 1:** lineups live with read-back verification. Waivers and trades in
  shadow mode.
- **After reviewing the first shadow cycle:** waivers live, with the drop rails
  above.
- **Then:** incoming trade evaluation live. Outgoing proposals stay in shadow for
  a couple more cycles, since they are the least testable and the least urgent.
- **Trade deadline is week 11**, so there is no rush on proposals.

## Weekly calendar

League settings that matter: FAAB budget 100, waiver day Tuesday with a two day
clear, trade deadline week 11, playoffs start week 16 with four teams.

- **Thursday afternoon:** set the lineup for anyone playing on Thursday night.
- **Sunday late morning:** the main lock. Final lineup for the week.
- **Sunday and Monday evening:** check starters in the late games against
  confirmed inactives.
- **Monday night, after the last game:** review the week, compute waiver targets.
- **Tuesday, before processing:** submit FAAB claims.
- **Once a week:** publish the retro to the public blog.
- **Continuously:** the daemon already polls for incoming trades.

Timers use `OnCalendar` with `Persistent=true`, so a missed wake-up from a reboot
still fires rather than silently skipping a week.

## Build order

1. Capture DOM selectors for the team and lineup pages, and the add, drop and
   trade flows. This needs a real post-draft roster, so it is the first job after
   tonight.
2. Fill the `setLineup` stub in `src/act/sleeper.ts` plus read-back verification.
3. Weekly projection model per slot, from the per-week endpoint.
4. Offline replay harness and the points-left-on-bench measure.
5. Waiver and FAAB engine behind the drop rails.
6. Incoming trade evaluation, then outgoing proposals.
7. Timers for each lock, and the weekly blog schedule.

## Tonight, once the draft finishes

The draft engine already publishes the recap automatically on a real, non
rehearsal completion, so the blog is not a manual step. What does need checking:

- the recap actually published, and says full PPR and the right team and league
  names, all of which were wrong in earlier samples and were fixed today,
- the roster on Sleeper matches what the activity log says we drafted,
- the `draft-active` lock cleared so the daemon resumes,
- the three test mock drafts get left alone or tidied, they are harmless either
  way.
