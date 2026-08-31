# Arm checklist

The in-season timers are NOT installed. This is the exact sequence to arm them,
what to watch on the first firing of each, and how to abort. Read
`docs/in-season-readiness.md` first. Do the install only when you mean to go live.

## Before you install

```
timedatectl show -p Timezone --value          # must print America/New_York
docker ps --format '{{.Names}}' | grep '^sleeper-coach'   # container must be up
cd <repo> && bun run test                      # all suites pass
```

The staging league (`1399830848848592896`) is the safe place to rehearse any run:
add `--league 1399830848848592896 --roster 1` to any runner. Never pass a
`--league` without a `--roster`; the runner refuses it, because our roster_id is 3
in the real league and 1 in staging.

## Install (host, as root)

```
sudo bash deploy/systemd/install.sh
```

It verifies the timezone and the container, copies the six unit pairs to
`/etc/systemd/system`, reloads systemd, and enables every timer. It is idempotent;
re-run after editing a unit. Confirm the schedule:

```
systemctl list-timers 'sleeper-coach-*' --all --no-pager
```

Lineups are live from the first firing. Waivers ship in SHADOW: the Tuesday submit
writes nothing until you add ` --live` to the `ExecStart` in
`sleeper-coach-waiver-submit.service` and `systemctl daemon-reload`, and only after
you have read one shadow cycle and it looked sensible.

## First firing of each: what to watch

Watch a unit live with `journalctl -u <unit>.service -f`. The durable record is
`/data/sleeper-coach/activity.jsonl`.

| First firing | ET | Look for | Bad sign |
| --- | --- | --- | --- |
| `lineup-thursday` | Thu 16:00 | `lineup-set` event, projected total, all 10 slots filled | `lineup-failed`, or an "unfillable slot" alert |
| `lineup-sunday` | Sun 11:00 | `lineup-set` before the 13:00 kickoffs | any run starting after 13:00 (should not happen; Persistent=false) |
| `inactive-sunday` | Sun 18:45 | either a fresh `lineup-set` or a clean no-op (nothing changed) | a verification throw on a now-locked player |
| `inactive-monday` | Mon 19:00 | same, before the 20:15 MNF | same |
| `waiver-compute` | Tue 02:00 | `waiver-shadow` event with the watch summary (byes, IR, best available) | an exception in the journal |
| `waiver-submit` | Tue 20:00 | `waiver-shadow`; a claim or IR opportunity comes as an ALERT for you to action by hand | a `waiver-add-failed` once you go live |

On the first waiver cycle, read the shadow output and the alerts before doing
anything live. A recommended claim and an IR move are surfaced for you to submit in
Sleeper; the coach does not submit either.

## Abort

One file freezes every write instantly, no restart:

```
docker exec <coach> touch /data/sleeper-coach/FREEZE   # freeze all writes
docker exec <coach> rm    /data/sleeper-coach/FREEZE   # resume
```

`<coach>` is the container name from the `docker ps` above. A frozen run still
computes and logs what it would do, then stops before the write. To stop the
schedule entirely instead:

```
sudo systemctl disable --now 'sleeper-coach-*.timer'
```

Never trigger a lineup unit by hand after that day's kickoff: the solver is blind
to in-game locks, so a post-kickoff run can fail verification and leave a
half-rearranged lineup. Before kickoff it is safe to run one now with
`systemctl start sleeper-coach-lineup-sunday.service`.
