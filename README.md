# sleeper-coach

An autonomous fantasy football coach for a Sleeper league, run by Claude Opus.
It prepares for the draft, drafts live, sets weekly lineups, works the waiver
wire, and evaluates and proposes trades. It runs on the NAS with scheduled
wakeups for deadlines and a poller that wakes it when a trade offer arrives.

## The one hard constraint

Sleeper's public API is **read-only**. There is no official way to set a
lineup, make a draft pick, or accept, reject, or send a trade. So this project
has two halves:

- **Read + reason** (this repo, safe): everything analytical, wired to the live
  league via the public API. No auth, no side effects.
- **Act** (later, supervised): a headed browser on the NAS, driven by the agent
  and watchable/seizable over noVNC, that performs the actual clicks. Sleeper's
  own CPU-autopick plus a preset draft queue are the safety net if automation
  stalls.

## The league (2026)

- Pit Podcast keeper league, 8 teams, **full PPR**, single QB.
- Starters: QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF. 6 bench, 2 IR.
- Draft: snake, 16 rounds, **90-second** pick clock, CPU autopick on.
- Keepers: to be confirmed live (stored setting says 1; may be 2). The coach
  reads designated keepers off the rosters rather than assuming.

## Usage (read-only inspection)

```sh
bun install
bun run coach league      # scoring, roster slots, keeper rules
bun run coach managers    # the eight teams
bun run coach draft       # type, clock, rounds, order
bun run coach board       # value board (top 30); board WR 40 for one position
bun run coach roster      # your roster (or: roster 5)
bun run coach players --refresh   # refresh the player cache
```

## Build order

1. **Read-only analysis core** (this stage) — Sleeper client, player cache,
   first-pass value board, CLI.
2. **Projection + real board** — points from this league's exact scoring,
   positional scarcity for 8-team PPR, ADP blend, qualitative news layer.
3. **Mock-draft harness** — headed browser on NAS via noVNC; benchmark real
   pick latency and rehearse takeover before the real draft.
4. **Live draft dashboard** — reasoning stream, about-to-pick countdown with
   Pause / Take-over, and an input box to feed the agent info mid-draft.
5. **In-season** — scheduled lineup + waiver wakeups, trade poller and
   evaluator, proactive trade proposals shaped by manager tendencies.

## Layout

```
src/
  config.ts            league / draft / user identifiers
  sleeper/client.ts    read-only API client (no write path exists)
  sleeper/types.ts     typed API shapes
  data/players.ts      cached player + injury dump (daily TTL)
  analysis/scoring.ts  fantasy points from a league's scoring settings
  analysis/board.ts    value board
  cli.ts               read-only inspection commands
```
