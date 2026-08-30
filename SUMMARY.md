# Trade handling — build summary

Branch `feat/trades`. Built most-testable-first, per the plan. Nothing here is
enabled for live writes: `TRADES_ENABLED` stays off (Filip's call) and the two
browser write paths are additionally gated behind `TRADE_WRITE_ARMED` until their
selectors are verified against a real offer.

## What landed

**1. Trade evaluation engine (pure, fully tested).** `src/analysis/trade.ts`.
A trade's value is the change in our best STARTING LINEUP, not the sum of the
player values that change hands. `bestLineup` fills slots most-restrictive-first
(QB/RB/WR/TE/K/DEF, then FLEX), which is optimal for these slots. `evaluateTrade`
runs the drop rails on every outgoing player, computes the lineup delta, and
returns accept / reject / surface with reasons. This is what makes an eighth
receiver worth ~0 to us and a second startable tight end worth a lot, for free.
22 tests in `src/analysis/trade.test.ts`, including the asymmetric-position cases
and the rail gates. `src/analysis/rails.ts` is reused unchanged (its 10 tests
still pass); a trade that gives up a protected player, the injured stash, or an
unknown name fails exactly as a waiver drop would.

**2. The rails around it.** Incoming bands live in `evaluateTrade`: at/below
`rejectBelowPts` reject, at/above `acceptAbovePts` accept, between the two
surface for a human. Outgoing proposals get the two-pass "look good twice" gate
in `src/analysis/trade-intent.ts`: `gateOutgoing` (pure state machine) plus a
durable `IntentStore` with an explicit path. An outgoing offer is recorded on one
pass and only sent on a later, separate pass, and only if it still evaluates as a
clear win. 14 tests in `src/analysis/trade-intent.test.ts`.

**3. DOM write paths (defensive, gated).** `respondTrade` and `sendTrade` in
`src/act/sleeper.ts`. Both take an explicit `leagueId` (like `setLineup`/`addPlayer`),
match players on the loose abbreviated form cross-checked against position and
team, REFUSE rather than guess when more than one card matches, and verify by
reading state back from the DOM (never the rosters API, which served a stale
roster for 5+ minutes on 2026-08-30). Both are GATED: with `TRADE_WRITE_ARMED`
unset they navigate, screenshot and throw a clear message without clicking,
because the accept/reject and propose-flow selectors have never run end to end
(the staging league has no trade partner). `respondTrade` also refuses unless
there is exactly one pending offer, since Sleeper does not expose the transaction
id in the DOM.

**4. Capture tool.** `captureTradeDom` + the `/trade-capture` browser-server
endpoint + `act trade-capture [leagueId] [outfile]`. Run it the moment a real
offer or a real partner exists; it dumps the trades-page DOM (propose modal,
partner columns, player cards, buttons, main HTML) to a JSON file so the gated
selectors can be finished from real markup.

**Bonus, read-only:** `coach trade-eval <txid>` (`src/analysis/trade-live.ts`)
bridges the live API to the pure engine and prints the deterministic verdict for
a pending offer. This is the "surface for a human" view and the verdict the
daemon's agent should defer to. It only reads; it never accepts, rejects or sends.

## Deliberately NOT done (left for Filip)

- **`src/daemon.ts` is untouched.** Coordinated with the `inseason` session to
  keep the shared file conflict-free. When you want the shadow log to show the
  code verdict on real offers, it is a one-line call in the shadow branch of
  `handlePendingTrade`:
  `const { evaluateTransactionForUs } = await import("./analysis/trade-live.ts");`
  then include its `summary` in the log/alert. (Note: the existing `describeTrade`
  lists both sides of a 2-team trade as ours; `evaluateTransactionForUs` splits
  by roster id correctly, so it is the better source for the alert text.)
- **`TRADES_ENABLED` not flipped.** Stays off.
- **`TRADE_WRITE_ARMED` not set anywhere.** The write paths stay gated.

## To finish trades when a real offer arrives

1. Run `act trade-capture <realLeagueId> offer.json` (or from staging once a
   partner exists). Read `offer.json`.
2. Finish the accept/reject button selectors in `respondTrade` and the
   partner-select / add-player selectors in `sendTrade` from that markup.
3. Verify against the offer with `TRADE_WRITE_ARMED` still unset (it will
   navigate and dump without clicking).
4. Only then set `TRADE_WRITE_ARMED=1`, and separately `TRADES_ENABLED=1`, to go
   live. Every write still verifies by DOM read-back and refuses on ambiguity.

## Known limitation

`points` in the live bridge is the full-season projection used as a
rest-of-season proxy. Pre-season the two are identical; in-season it overstates
remaining value, though it is applied to both sides so the lineup DELTA stays a
fair comparison. When weekly projections are wired for lineups, rest-of-season
should become the sum of the remaining weeks. Flagged in the `trade-eval` output.

## Tests

    bun run src/analysis/rails.test.ts         # 10 passed (unchanged)
    bun run src/analysis/trade.test.ts         # 22 passed
    bun run src/analysis/trade-intent.test.ts  # 14 passed
    bun run typecheck                          # clean
