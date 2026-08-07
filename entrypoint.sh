#!/usr/bin/env bash
# Container entrypoint. Runs the Xvfb + x11vnc + websockify stack under a tiny
# supervisor (so any of them dying restarts), ensures the Claude CLI is present
# in the persistent HOME, then execs the daemon in the foreground. If the
# daemon exits, the container exits and Docker's restart policy takes over.
# Cloned from the proven pit-podcast entrypoint.

set -u

cleanup_x_state() { rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; }

supervise() {
    local name=$1; shift
    (
        while true; do
            echo "[entrypoint] starting ${name}"
            "$@"
            echo "[entrypoint] ${name} exited rc=$?, restarting in 2s"
            [ "${name}" = "xvfb" ] && cleanup_x_state
            sleep 2
        done
    ) &
}

mkdir -p "${HOME}" /data/sleeper-coach/profile /data/sleeper-coach/shots

cleanup_x_state
supervise xvfb Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset

for i in $(seq 1 40); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.25; done

supervise x11vnc x11vnc -display :99 -rfbport 5900 \
    -passwd "${WEB_PASS:-changeme}" -forever -quiet -noxdamage
supervise websockify websockify --web /usr/share/novnc 6080 localhost:5900

# Install the native Claude CLI into the persistent HOME on first start, so the
# auto-updater works across container recreates (guest-claude pattern).
if [ ! -x "${HOME}/.local/bin/claude" ]; then
    echo "[entrypoint] installing claude CLI into ${HOME}"
    curl -fsSL https://claude.ai/install.sh | bash || echo "[entrypoint] claude install failed; check on next start"
fi
export PATH="${HOME}/.local/bin:${PATH}"

# Web dashboard in the background (Phase D wires the UI); daemon in foreground.
if [ -f /app/src/web/server.ts ]; then
    supervise web bun run /app/src/web/server.ts
fi

exec bun run /app/src/daemon.ts
