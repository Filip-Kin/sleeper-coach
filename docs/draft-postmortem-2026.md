# Draft post-mortem, 30 August 2026

Slot 4 of 8, full PPR, 16 rounds, 128 picks. The engine made all 16 of our picks
autonomously. Zero failed picks, zero crashes, one logged error which was the
SIGTERM from a deliberate mid-draft restart.

Final roster: McCaffrey, Chase Brown, Nico Collins, Kenneth Walker, DeVonta
Smith, Travis Etienne, LaPorta, Hurts, Mike Evans, Parker Washington, Jayden
Reed, DK Metcalf, Seattle DEF, Josh Downs, Dak Prescott, Jake Bates.

We finished **first of eight** on projected starting lineup (2011 points, next
best 1985) and first on roster VOR (335, next best 290). The league spread is only
6% top to bottom, so this means "drafted well", not "favourite".

## The headline finding: I misdiagnosed the agent mid-draft

During the draft I told Filip the agent had a systematic blind spot, quoted a
20 VOR override cost, and recommended reverting to fully deterministic picking.
The data says the opposite.

Seven of sixteen picks were agent overrides of the value board. Accounting for
what we actually got afterwards rather than the raw VOR gap at the moment:

| round | agent took | board wanted | raw gap | real outcome |
| --- | --- | --- | --- | --- |
| R3 | Nico Collins | Derrick Henry | 2.7 | roughly neutral, and WR was the need |
| R6 | Travis Etienne | Tyler Warren | 20.1 | **real cost ~5**, LaPorta backfilled TE at R7 |
| R7 | Sam LaPorta | Drake Maye | **−9.8** | **agent GAINED value**, took Hurts at R8 anyway |
| R10 | Parker Washington | Houston DEF | 13.4 | **cost 0**, took Seattle DEF at R13 |
| R11 | Jayden Reed | Houston DEF | 28.2 | **cost 0**, took Seattle DEF at R13 |
| R12 | DK Metcalf | Seattle DEF | 41.5 | **cost 0**, took Seattle DEF at R13 anyway |
| R14 | Josh Downs | Harrison Mevis (K) | 45.5 | **cost ~1**, took Bates K at R16 |

Net across all seven overrides: approximately zero, possibly positive. The agent
was right to defer kickers and defences, and right to take the tight end over a
second-tier QB at R7.

**The one genuinely bad pick came from the deterministic layer, not the agent.**
Dak Prescott, a second QB in a one-QB league, at R15. So the fix I proposed
would have made the draft worse.

## Why the metric misled me

The `agent call:` log line reports the raw VOR gap between the agent's pick and
the board's top pick. That number is meaningless when the board's top pick is a
kicker or a defence, because **those positions are capped at one starter**. A
kicker can be genuinely 45 VOR "better" than the 33rd receiver and still be worth
almost nothing to take early, because you will take a kicker eventually and the
spread between kickers is about four points a season.

Fix: the override log should report the gap against the best pick at a position
we still have room to use, and should exclude capped positions we intend to fill
later. Better still, exclude K and DEF from the shortlist entirely until the
reserved must-fill window, so they never appear as the board's "top pick".

## Bug 1: stale plans silently fall back to the raw board

Plan age at each of our sixteen picks: 3, 13, 7, 11, 20, 37, 3, 29, 7, 12, 1, 24,
19, 31, **116**, 11 seconds.

Fifteen picks were fine. The 116-second outlier is exactly the pick that went
wrong. With no usable fresh plan the engine fell back to the raw VOR board, where
Dak Prescott at +1 was the only positive-value player left, so it took a backup
QB.

Two things to fix:
1. Treat a plan older than about 45 seconds as absent, and do a **blocking**
   refresh once we are on the clock. There is a 90 second clock and we already
   pause 5 seconds deliberately, so there is time.
2. The fallback needs the same positional sanity the agent has. It should never
   take a second QB in a one-QB league.

## Bug 2: guidance cannot reach the deterministic fallback

The live guidance channel (rewriting `system-prompt.md`, which `runAgent` re-reads
on every call) worked well and reached the agent in about 20 seconds. But it only
ever influences the agent's plan. When the plan was stale, guidance had no effect
at all, which is precisely how a pick I had explicitly forbidden twice still
happened.

Fix: a machine-readable constraint file the DETERMINISTIC layer reads too, for
example `{"forbidPositions": ["QB"], "maxAt": {"RB": 4}}`. Advice to a model is
not a control surface. This is the same lesson as the bye-stacking bug found in
mock 1 this morning, which I had written down and then relied on advice anyway.

## Bug 3: guidance has a one-cycle latency and cannot catch an imminent pick

Guidance to take a second tight end at pick 109 was applied at roughly pick 102
to 105. The plan for 109 had already been computed, so it missed and we took a
seventh receiver instead. Nothing is broken here, but the channel needs a visible
"this will apply from your next refresh, not this pick" property, and ideally a
way to invalidate the current plan on the spot.

## Bug 4: the position caps allowed a worthless pick

`positionCap` permits QB=2 from round 15. In a one-QB, eight-team league a backup
QB is worth close to nothing: only eight of about thirty-two starting QBs are
rostered, so a replacement is always on waivers. That cap should be 1, or 2 only
in the final round when nothing else has value.

TE=2 from round 13 is correct and we should have used it. Andrews at VOR −7 was
the best available player at our last two picks, 23 better than the best RB and
35 better than the best WR.

## Bug 5: bye-week handling is too weak

We finished with **four players on the week 8 bye**: McCaffrey, Collins, Etienne,
Evans. That costs about 10.7 points in that week (118.3 down to 107.6) and is the
worst single-week hole in the league.

The bye veto only fires at three or more on a week, and only as a near-tie
breaker. It also does not distinguish a bye that hits four *starters* from one
that hits four bench players. It should score the actual starting-lineup impact
per week, and should weight early picks more heavily since those are the players
that cannot be replaced.

The must-fill path DID get this right: it took Bates (bye 6) over Mevis (bye 11,
where we already had two) despite Mevis projecting higher. That was the fix from
mock 4 working exactly as intended.

## What worked and should not be touched

- **Must-fill.** One firing, correct, bye-aware. It guaranteed a kicker at the
  last pick after the Dak Prescott mistake had left the slot empty.
- **The news dossier.** 46 entries, 15 players devalued. The `soft` status
  correctly stopped it fading McCaffrey and Chase off Sleeper's blanket
  "Questionable" tag, and McCaffrey was our best pick.
- **VONA over raw VOR.** Deferring the board's top pick cost nothing repeatedly,
  most clearly at R12 where it took a receiver over the defence it then got
  anyway one round later.
- **The stale-reasoning guard** added hours before the draft. Every logged
  rationale actually names the player we took, so the public recap is not
  explaining picks we never made.
- **Live guidance via `system-prompt.md`.** Genuinely useful, about 20 second
  latency, and `coach-say` plus the `GUIDANCE:` acknowledgement line made it
  observable.

## Smaller items

- The recap says McCaffrey was taken at "1.03". We picked at 1.04. The generator
  should be given the real pick numbers rather than letting the model infer them.
- A stray `Plan @R17` was logged after the draft completed, from a detached
  refresh landing late. Harmless, untidy.
- `announcer-recreate.sh` copies image-baked ENV forward, which silently masked a
  changed Dockerfile default and made a WHISPER_MODEL swap appear to work when it
  had not. Documented in the script now.

## Priority order for next time

1. Blocking plan refresh when stale on the clock, plus positional sanity in the
   fallback. This is the only change that would have prevented the one bad pick.
2. Exclude capped positions from the shortlist until their must-fill window, and
   fix the override log to compare like with like.
3. A machine-readable constraint file the deterministic layer respects.
4. QB cap to 1. Bye scoring on starting-lineup impact rather than raw counts.
