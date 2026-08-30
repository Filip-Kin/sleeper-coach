#!/usr/bin/env bash
# Install the sleeper-coach in-season timers on the NAS HOST (not in the
# container). Run as root, from anywhere:
#
#   sudo bash deploy/systemd/install.sh
#
# It copies the unit files to /etc/systemd/system, reloads systemd, and enables
# (and starts) every timer. Re-run it after editing a unit; it is idempotent.
#
# Preconditions, verified below:
#  - the host timezone is America/New_York (the OnCalendar times assume ET);
#  - the sleeper-coach container is running (the services docker exec into it).
#
# These timers issue LIVE writes to the real league on their schedule (lineups
# live; waivers shadow until you add --live to the submit unit). The kill switch
# stops all writes without touching any of this:
#   docker exec <coach> touch /data/sleeper-coach/FREEZE   # freeze
#   docker exec <coach> rm    /data/sleeper-coach/FREEZE   # resume

set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/etc/systemd/system

if [ "$(id -u)" != "0" ]; then echo "run as root (sudo)"; exit 1; fi

TZ_NOW=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)
if [ "$TZ_NOW" != "America/New_York" ]; then
  echo "WARNING: host timezone is '$TZ_NOW', not America/New_York."
  echo "The OnCalendar times are written in US Eastern and will be wrong on this host."
  echo "Fix the host timezone or re-anchor the .timer files before enabling."
  read -r -p "Continue anyway? [y/N] " ans; [ "$ans" = "y" ] || exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q '^sleeper-coach'; then
  echo "WARNING: no running sleeper-coach container found. The timers will fail"
  echo "until it is up, but installing them now is fine."
fi

echo "Installing units to $DEST ..."
cp -v "$SRC"/sleeper-coach-*.service "$SRC"/sleeper-coach-*.timer "$DEST/"
systemctl daemon-reload

for t in "$SRC"/sleeper-coach-*.timer; do
  name=$(basename "$t")
  systemctl enable --now "$name"
  echo "enabled $name"
done

echo
echo "Installed. Scheduled runs:"
systemctl list-timers 'sleeper-coach-*' --all --no-pager || true
echo
echo "Watch a run:   journalctl -u sleeper-coach-lineup-sunday.service -f"
echo "Flip waivers live (after reviewing a shadow cycle): add ' --live' to the"
echo "ExecStart in $DEST/sleeper-coach-waiver-submit.service, then daemon-reload."
