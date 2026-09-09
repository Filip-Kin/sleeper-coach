#!/usr/bin/env bash
# Container entrypoint. Ensures the Claude CLI is present in the persistent
# HOME, runs the web dashboard under a tiny supervisor (so it restarts if it
# dies), then execs the daemon in the foreground. If the daemon exits, the
# container exits and Docker's restart policy takes over.
#
# The Xvfb, x11vnc, websockify and browser-server processes that used to start
# here went with the browser on 2026-09-09. The Sleeper session is a token file
# on the volume now (see README, "The Sleeper token").

set -u

supervise() {
    local name=$1; shift
    (
        while true; do
            echo "[entrypoint] starting ${name}"
            "$@"
            echo "[entrypoint] ${name} exited rc=$?, restarting in 2s"
            sleep 2
        done
    ) &
}

mkdir -p "${HOME}"

# Install the native Claude CLI into the persistent HOME on first start, so the
# auto-updater works across container recreates (guest-claude pattern).
if [ ! -x "${HOME}/.local/bin/claude" ]; then
    echo "[entrypoint] installing claude CLI into ${HOME}"
    curl -fsSL https://claude.ai/install.sh | bash || echo "[entrypoint] claude install failed; check on next start"
fi
export PATH="${HOME}/.local/bin:${PATH}"

# Web dashboard in the background; daemon in foreground.
if [ -f /app/src/web/server.ts ]; then
    supervise web bun run /app/src/web/server.ts
fi

exec bun run /app/src/daemon.ts
