# In-season timers

Host-level systemd timers that drive the weekly coach cadence. They run on the
NAS host and `docker exec` into the `sleeper-coach` container (its name is looked
up each run, because Coolify renames it on every rebuild). Install with
`sudo bash deploy/systemd/install.sh`.

## Schedule

All times are US Eastern. The host is on `America/New_York`, and this host's
systemd (247) evaluates `OnCalendar` in the host timezone, so the times stay
correct across the EDT/EST change on their own. Every timer is `Persistent=true`,
so a lock missed because the box was rebooting fires on wake rather than skipping
the week.

| Timer | When (ET) | Does |
| --- | --- | --- |
| `lineup-thursday` | Thu 16:00 | Sets the lineup before Thursday Night Football. |
| `lineup-sunday` | Sun 11:00 | The main lock. Final lineup before the 13:00 kickoffs. |
| `inactive-sunday` | Sun 18:45 | Re-solves with fresh inactives before the late/SNF games. |
| `inactive-monday` | Mon 19:00 | Re-solves before Monday Night Football. |
| `waiver-compute` | Tue 02:00 | After the last MNF game: computes and logs waiver targets (shadow). |
| `waiver-submit` | Tue 20:00 | Before the Wed 07:00 GMT clear: waiver moves (shadow by default). |

The lineup runner is idempotent: an inactive re-check that finds nothing changed
sets nothing (the DOM-verified `setLineup` only clicks slots that differ).

## Lineups are live, waivers start in shadow

Lineups are reversible until kickoff and pure upside, so they run `--live` from
day one. Waivers are priced in queue position and go live only after a human has
reviewed a shadow cycle (per `docs/in-season-plan.md`). To flip the Tuesday
submission live, add ` --live` to the `ExecStart` in
`sleeper-coach-waiver-submit.service` and `systemctl daemon-reload`. Even then,
`--live` performs only costless free-agent adds; a waiver **claim** is always
surfaced by alert for manual submission, because its DOM flow is not yet verified
(the same bar the trade write paths are held to).

## Kill switch

One file freezes every write, no container restart:

```
docker exec <coach> touch /data/sleeper-coach/FREEZE   # freeze all writes
docker exec <coach> rm    /data/sleeper-coach/FREEZE   # resume
```

A frozen runner still computes and logs what it would do, then stops before the
write with a clear message.

## Watch / debug

```
systemctl list-timers 'sleeper-coach-*' --all
journalctl -u sleeper-coach-lineup-sunday.service -f
systemctl start sleeper-coach-lineup-sunday.service    # run one now (LIVE write)
```

To dry-run a lineup by hand without writing, exec the runner in the container
with no `--live`:

```
docker exec <coach> bash -lc 'cd /app && bun run src/act/lineup-run.ts'
```
