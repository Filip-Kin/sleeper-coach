# Deploy runbook

The coach is one container on the NAS, built and run by Coolify from
`docker-compose.coolify.yml`. State lives on a bind mount at
`/data/sleeper-coach`. The dashboard is `coach.filipkin.com` (Zoraxy to
`127.0.0.1:8770`, Authelia in front).

## How a push deploys

1. `git push origin main` from the PRIMARY checkout. Worktrees are refused by
   the hook (`scripts/hooks/pre-push`; install it once per clone with
   `bun run setup-hooks`). Before the push goes out the hook runs, in order:
   `bun run tsc --noEmit`, `NODE_ENV=test bash scripts/run-tests.sh`, then
   `bash scripts/soak.sh` (the real daemon, 20 polls against the staging
   league, inside the running container). Any failure blocks the push.
   `COACH_PUSH_OVERRIDE="<why>" git push` skips the gate for one push and
   records `{ts, sha, reason}` in `.git/pushes.jsonl`. `--no-verify` cannot be
   stopped; do not use it.
2. Coolify sees the push (GitHub webhook), builds the image with
   `SOURCE_COMMIT` as a build arg (the Dockerfile bakes it into `COACH_SHA`),
   and recreates the container. The old one is stopped first, so there is
   never a second daemon on the state volume.
3. `entrypoint.sh` writes `boot-canary <sha>` into `/data/sleeper-coach/FREEZE`
   (unless a freeze with other content is already there) and execs the daemon.
4. The daemon runs the boot canary (`src/soak/canary.ts`): token usable,
   `league_id` is the real league, roster read has a `player_map` and is
   legal, the scored week's points are non-zero, `scheduled_runs` readable
   with nothing overdue, activity log appendable. Pass: it removes its own
   freeze and logs `deploy` with the SHA. Fail: it stays frozen, alerts with
   the failures, and retries every poll. Nothing is written to Sleeper until
   the canary passes.

## What is running

```sh
C=$(docker ps --format '{{.Names}}' | grep '^sleeper-coach')
docker exec "$C" env | grep -E '^(COACH_SHA|SOURCE_COMMIT)='
docker exec "$C" tail -n 200 /data/sleeper-coach/activity.jsonl | grep '"deploy"' | tail -1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8770/health   # 200 fresh, 503 stale
```

The Coolify UI (resource `sleeper-coach`, project `personal`) shows the same
SHA under Deployments.

## Roll back

Coolify, resource `sleeper-coach`, Deployments, pick the last good deployment,
Redeploy. That rebuilds from that commit and recreates the container; the
boot canary runs again on the old code and the state volume is untouched.
There is no compose file to run by hand, on purpose: a hand-run
`docker compose up` next to the Coolify container put two daemons on one
state volume.

If the rollback target is older than a schema change, check `coach.db` still
opens (`docker exec "$C" bun -e 'import {Database} from "bun:sqlite"; new Database("/data/sleeper-coach/coach.db", {readonly: true})'`).
Tables are only ever added, never renamed, so an older build ignores what it
does not know.

## Freeze and canary

`/data/sleeper-coach/FREEZE` is the kill switch. Present means no writes.

| Content | Who wrote it | Who removes it |
| --- | --- | --- |
| `boot-canary <sha>` | entrypoint at every container start | the daemon, once the canary passes |
| anything else, or empty (`touch`) | Filip, or the coach freezing itself | Filip |

A human freeze always wins: entrypoint leaves it alone and the daemon never
removes a file that does not start with `boot-canary`. To hold a deploy
frozen after its canary passes, write your own reason into the file before
or after the push:

```sh
echo "frozen by Filip: reviewing $(date -u +%F)" > /data/sleeper-coach/FREEZE
rm /data/sleeper-coach/FREEZE          # writes resume on the next poll
```

Auto-freezes (`... auto-frozen: <reason>`) come from the drop circuit breaker
and the `drops` invariant (`src/invariants.ts`). Read the reason in the
activity log before removing the file.

## Health monitor

`GET /health` on the dashboard returns `200 ok <age>s` while the daemon's
heartbeat file is under five minutes old, otherwise `503 heartbeat <age>s old`
(or `503 no heartbeat`). No auth, no league data.

- Local: `http://127.0.0.1:8770/health`.
- Through Zoraxy: `https://coach.filipkin.com/health` sits behind Authelia like
  the rest of the site. For an external monitor either add a Zoraxy bypass
  rule for the `/health` path on that host, or point a Home Assistant
  `rest` binary sensor at the loopback URL from the NAS with an automation
  that notifies on `off` for more than ten minutes. The heartbeat is written
  every poll (90 s in production) by `heartbeat()` in `src/heartbeat.ts`.

## Alerts

Every alert is written to the `alerts` table in `coach.db` before it is sent.
`now` alerts push to Home Assistant (`HA_NOTIFY_URL`, `HA_TOKEN` in the
Coolify env), ten per hour, then one "muted for an hour" push. `digest`
alerts never push; the `alert-digest` job (09:00 ET) sends them as one
message. A process pointed at the staging league never pushes.

## Refresh the Sleeper token

The token is a JWT that lasts about a year. The daemon checks it every 30
minutes and alerts once a day when it is missing, rejected, or inside 14 days
of expiry; the boot canary refuses to lift the freeze without a usable one.

1. Log in at https://sleeper.com, DevTools, Application, Local Storage,
   `https://sleeper.com`, copy the value of the key `token`.
2. `docker exec -i "$C" bun run src/act/cli.ts token import -`, paste, Ctrl-D.
   It verifies the token with `me`, refuses another account, and writes
   `/data/sleeper-coach/sleeper-token` mode 600.
3. `docker exec "$C" bun run src/act/cli.ts token check`.

No restart is needed; the next auth check picks it up.

## The soak by hand

```sh
bun run soak                      # from the checkout; runs inside the container
SOAK_FORCE_JOB=lineup-sunday bun run soak   # let one scheduled job fire
```

It prints one `PASS`/`FAIL` line per assertion (`src/soak/assert.ts`) and
leaves its state in `/tmp/soak` inside the container. It refuses to start
inside twenty minutes of a pick'em kickoff, because the pick'em pool has no
staging twin.

## One-time setup (already done)

- State dir `/data/sleeper-coach` with `config/` as the Claude HOME.
- Coolify resource with the env from `env.example` plus `HA_NOTIFY_URL`,
  `HA_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`.
- Zoraxy route `coach.filipkin.com` to `127.0.0.1:8770`, Authelia forward-auth.
- Cloudflare CNAME `coach` to `n.filipkin.com`, DNS only.
