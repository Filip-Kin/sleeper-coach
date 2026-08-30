# In-season plan

Written 30 August 2026, the afternoon of the draft. The 2026 regular season
starts 9 September, so the first lineup lock is about ten days after the draft.

## The constraint that shapes everything

The draft was safe to get wrong. Mock drafts are free, so the engine was tested
across three of them this morning and two real bugs fell out. Nothing in-season
works like that. A dropped player is gone the moment someone else claims him, an
accepted trade cannot be unwound, and a waiver claim spends a queue position you
do not get back. Filip dropped a good
player last season for exactly this reason.

So the design rule for every in-season action is: **the model proposes, code
decides what is permitted.** An agent that is having a bad day should be unable
to do lasting damage, not merely unlikely to.

## Actions ranked by how bad a mistake is

This ordering drives the whole rollout.

| Action | Reversible? | Worst case |
| --- | --- | --- |
| Set a lineup | Yes, until kickoff | Points left on the bench for one week |
| Add a free agent into a free slot | Effectively yes | A wasted roster spot |
| Make a waiver claim | No, once processed | Burned waiver priority on a marginal player |
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
IR slots for genuinely injured players, then a waiver claim (which only costs a
drop if the claim actually wins). Only after all of those does a straight drop
get considered.

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

**A staging league.** Built 30 August: `coach-staging DO NOT USE`, league id
`1399830848848592896`. Sleeper's create flow can copy settings from an existing
league, so it is an exact clone of the real one, verified field by field against
the API. It gives a real DOM to exercise lineup setting and add/drop against with
zero consequence. That covers the two highest-frequency write paths. Trades need a
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

League settings that matter, read from the live API rather than assumed:
**rolling waiver priority, NOT FAAB** (`waiver_type: 0`; the stored
`waiver_budget: 100` is a default Sleeper keeps regardless of type and is not
used). Waivers clear **Wednesday 07:00 GMT** with a two day hold. Trade deadline
week 11, playoffs start week 16 with four teams.

Rolling priority changes the waiver problem completely. There is no bidding and
no budget to pace. Instead you hold a position in a queue, and a successful claim
sends you to the back of it. So the question on every claim is not "what is he
worth" but "is he worth going last for weeks". That argues for claiming rarely
and decisively: a genuine starter or a league-winning upside play, not a
streaming defence you could pick up as a free agent anyway. Free agent adds, once
waivers have cleared on a player, cost nothing and should be preferred.

- **Thursday afternoon:** set the lineup for anyone playing on Thursday night.
- **Sunday late morning:** the main lock. Final lineup for the week.
- **Sunday and Monday evening:** check starters in the late games against
  confirmed inactives.
- **Monday night, after the last game:** review the week, compute waiver targets.
- **Tuesday evening, before Wednesday 07:00 GMT:** submit waiver claims.
- **Once a week:** publish the retro to the public blog.
- **Continuously:** the daemon already polls for incoming trades.

Timers use `OnCalendar` with `Persistent=true`, so a missed wake-up from a reboot
still fires rather than silently skipping a week.

## The lineup assignment, precisely

Starting slots are QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF, where FLEX takes
an RB, WR or TE. Picking the best lineup is an assignment problem, and the naive
"sort everyone by projection and fill top down" is wrong because it can strand a
required slot.

Greedy is optimal here provided you fill slots from most restrictive to least
restrictive, because every dedicated slot's eligibility set is a strict subset of
FLEX's. So: QB, then K, then DEF, then TE, then the two RB slots, then the two WR
slots, then both FLEX slots from whatever RB, WR or TE remains. Within each slot,
take the highest weekly projection among players not already assigned.

Worth noting why a subtlety that looks like a problem is not one. If your two
tight ends are one elite and one mediocre, it makes no difference whether the
elite one occupies the TE slot or a FLEX slot: the same two players are started
either way and the total is identical. Ordering by restrictiveness handles it.

Before any of that, zero out anyone who cannot play: OUT, IR, on bye, or
confirmed inactive. A player projected well who is not playing is the single
most expensive mistake available, and it is entirely avoidable.

## Build order

1. Capture DOM selectors for the team and lineup pages, and the add, drop and
   trade flows. This needs a real post-draft roster, so it is the first job after
   tonight.
2. Fill the `setLineup` stub in `src/act/sleeper.ts` plus read-back verification.
3. Weekly projection model per slot, from the per-week endpoint.
4. Offline replay harness and the points-left-on-bench measure.
5. Waiver engine behind the drop rails, priced in waiver priority rather than dollars.
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
