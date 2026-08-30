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

## Announcer (Discord voice)

A separate service (`src/announcer/`, compose service `announcer`) joins a
Discord voice channel and SPEAKS the coach's draft picks out loud in a cocky
AI-overlord voice. It tails `activity.jsonl` (mounted read-only), composes a
short line per pick with the claude runner, and plays it via local Piper TTS.
Scope is announce-our-picks only; listening/replying is a later phase.

To make it talk, the human provides: a Discord app + bot; the Guilds and
GuildVoiceStates gateway intents enabled (Message Content NOT needed); the bot
invited with Connect + Speak; and `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_VOICE_CHANNEL_ID` set in `/data/sleeper-coach/env`. With any of those
missing the service logs what's absent and exits cleanly. Full details are in
the header comment of `src/announcer/index.ts`.

## The news layer

Projections and ADP cannot see a pending suspension, a PUP list or a
depth-chart change, and Sleeper's own `injury_status` is close to useless in
preseason: on 30 August 2026 it tagged 33 of the top 150 by ADP "Questionable",
including Patrick Mahomes and a placekicker. The draft agent had no way to tell
camp maintenance from a torn ACL.

`src/data/news.ts` reads a hand-curated dossier from
`/data/sleeper-coach/news.json` on the persistent state volume, so news can be
updated minutes before a draft with no rebuild and no redeploy. Each entry has a
`status` and a `note`:

| status | meaning | effect on value |
| --- | --- | --- |
| `out` | done for the season | points x0.05 |
| `risk` | real chance of missing games (pending suspension, multi-week injury) | points x0.85, or an explicit `multiplier` |
| `watch` | playing, but carrying a knock worth knowing | none |
| `soft` | Sleeper flags him, the reporting says he is fine | none, and the shortlist says so explicitly |

The two effects are deliberately separate. The `note` is advisory text on the
agent's shortlist and can only break a near-tie inside the existing
`VONA_PLAN_EPS` window. Points are only scaled where reporting states a concrete
absence, because a player who is out for the season is worth nothing and leaving
him atop the board is a bug rather than a strategy choice.

One trap worth knowing: the news multiplier is applied to individual players,
but VOR measures each player against the *replacement level* at his position
(RB23's points in this league). Devaluing a handful of fringe RBs therefore
drags that baseline down and silently inflates the VOR of every healthy RB. So
`rankByVor` takes a `baselineFrom` list and computes replacement from the
UNADJUSTED projections. Without it, docking four injured backs lifted Gibbs from
135 to 157 VOR and tilted the whole board toward RB for no football reason.

Bye weeks (`src/data/byes.ts`) are shown per player on the shortlist, and the
agent is told its own roster's bye concentration so it stops stacking starters
onto one dead week.

## Layout

```
src/
  config.ts            league / draft / user identifiers
  sleeper/client.ts    read-only API client (no write path exists)
  sleeper/types.ts     typed API shapes
  data/players.ts      cached player + injury dump (daily TTL)
  data/byes.ts         2026 bye week per team (static, ESPN-derived)
  data/news.ts         the qualitative news layer (see below)
  analysis/scoring.ts  fantasy points from a league's scoring settings
  analysis/board.ts    value board
  cli.ts               read-only inspection commands
```
