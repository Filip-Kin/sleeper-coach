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

# Boot frozen. Every container start writes `boot-canary <sha>` into the
# kill-switch file, and the daemon removes it only once its read-only canary
# (src/soak/canary.ts) has passed: token usable, right league, roster legal,
# scores non-zero, schedule readable, log writable. A deploy that cannot see
# its own world therefore stays frozen and alerts rather than acting on it.
#
# A FREEZE with any other content is a human's or an auto-freeze and is left
# exactly as it is: the daemon never lifts those. See DEPLOY.md, "Freeze and
# canary".
FREEZE_FILE="${COACH_FREEZE_FILE:-${COACH_STATE:-/data/sleeper-coach}/FREEZE}"
COACH_SHA="${COACH_SHA:-${SOURCE_COMMIT:-unknown}}"
export COACH_SHA
if [ -e "${FREEZE_FILE}" ] && ! grep -q '^boot-canary' "${FREEZE_FILE}"; then
    echo "[entrypoint] existing freeze kept: $(head -c 200 "${FREEZE_FILE}")"
else
    mkdir -p "$(dirname "${FREEZE_FILE}")"
    printf 'boot-canary %s\n' "${COACH_SHA}" > "${FREEZE_FILE}"
    echo "[entrypoint] frozen until the boot canary passes (sha ${COACH_SHA})"
fi

# Web dashboard in the background; daemon in foreground.
if [ -f /app/src/web/server.ts ]; then
    supervise web bun run /app/src/web/server.ts
fi

exec bun run /app/src/daemon.ts
