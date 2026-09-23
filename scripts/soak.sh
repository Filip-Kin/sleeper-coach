#!/usr/bin/env bash
# The soak: run the REAL daemon against the STAGING league for a fixed number
# of polls, with every path it can write to pointed at a scratch directory,
# then assert what happened (src/soak/assert.ts). It is the last gate before a
# push to main (scripts/hooks/pre-push) and the first thing to run after a
# change to anything the daemon touches.
#
# Isolation, in one place so it cannot drift:
#   SLEEPER_*          the staging league, draft and roster (roster 1)
#   COACH_STATE etc.   every state path under $SOAK_DIR, never /data
#   STATE_DIR          the same, for the two scripts that still read it
#                      (pickem/run.ts, league/propose-run.ts)
#   BLOG_LOG           the weekly-review publisher's ledger, copied in so it
#                      does not think every week is unpublished
#   DMS_ENABLED=0      no DM replies (they would go to real people)
#   HA_*               unset, and alert.ts refuses to push on staging anyway
#
# Runs in place when inside the coach container (the token is root-owned
# there); from the host it copies the tree into the running container and
# re-executes itself there. Exit code is the assertion result.
set -u
cd "$(dirname "$0")/.."
REPO=$(pwd)

: "${SOAK_DIR:=/tmp/soak}"
: "${SOAK_POLLS:=20}"
: "${POLL_INTERVAL_MS:=5000}"
: "${PROD_STATE:=/data/sleeper-coach}"
: "${COACH_TOKEN_FILE:=${PROD_STATE}/sleeper-token}"
: "${SOAK_FORCE_JOB:=}"

if [ ! -f /.dockerenv ]; then
    # Host: hand the whole thing to the running coach container.
    C=$(docker ps --format '{{.Names}}' | grep -m1 -i '^sleeper-coach')
    if [ -z "${C}" ]; then echo "soak: no running sleeper-coach container" >&2; exit 2; fi
    DEST=/tmp/soak-src
    echo "soak: copying the tree into ${C}:${DEST}"
    docker exec "${C}" rm -rf "${DEST}"
    docker exec "${C}" mkdir -p "${DEST}"
    git ls-files -co --exclude-standard -z | tar --null -T - -cf - | docker exec -i "${C}" tar -xf - -C "${DEST}"
    docker exec "${C}" ln -sfn /app/node_modules "${DEST}/node_modules"
    exec docker exec \
        -e SOAK_DIR="${SOAK_DIR}" -e SOAK_POLLS="${SOAK_POLLS}" -e POLL_INTERVAL_MS="${POLL_INTERVAL_MS}" \
        -e PROD_STATE="${PROD_STATE}" -e COACH_TOKEN_FILE="${COACH_TOKEN_FILE}" -e SOAK_FORCE_JOB="${SOAK_FORCE_JOB}" \
        "${C}" bash "${DEST}/scripts/soak.sh"
fi

export SLEEPER_LEAGUE_ID=1399830848848592896 SLEEPER_DRAFT_ID=1399830849339338752 SLEEPER_ROSTER_ID=1
export COACH_STATE="${SOAK_DIR}" STATE_DIR="${SOAK_DIR}" COACH_DB="${SOAK_DIR}/coach.db" COACH_FREEZE_FILE="${SOAK_DIR}/FREEZE"
export ACTIVITY_LOG="${SOAK_DIR}/activity.jsonl" REASONING_LOG="${SOAK_DIR}/reasoning.jsonl" BLOG_LOG="${SOAK_DIR}/blog.jsonl"
export COACH_TOKEN_FILE POLL_INTERVAL_MS SOAK_POLLS SOAK_DIR PROD_STATE SOAK_FORCE_JOB DMS_ENABLED=0
unset HA_NOTIFY_URL HA_TOKEN COACH_FREEZE
if [ ! -r "${COACH_TOKEN_FILE}" ]; then echo "soak: token ${COACH_TOKEN_FILE} not readable" >&2; exit 2; fi

rm -rf "${SOAK_DIR}"; mkdir -p "${SOAK_DIR}"
cp "${PROD_STATE}/pickem-kickoffs.json" "${SOAK_DIR}/" 2>/dev/null || echo "soak: no pickem-kickoffs.json to copy (lineup guard will treat every player as unlocked)"
cp "${PROD_STATE}/blog.jsonl" "${SOAK_DIR}/" 2>/dev/null || true

echo "soak: staging league ${SLEEPER_LEAGUE_ID}, ${SOAK_POLLS} polls at ${POLL_INTERVAL_MS} ms, state ${SOAK_DIR}, tree ${REPO}"
bun run src/soak/assert.ts before || exit $?

# The daemon exits by itself after SOAK_POLLS polls; the timeout is the net
# under a daemon that does not, so a hung loop is a failed assertion (8), not
# a hung hook. The 300 s margin covers the lineup guard's first pass, which
# loads the player dump and the week projections cold (160 s on 2026-09-23).
LIMIT=$(( SOAK_POLLS * POLL_INTERVAL_MS / 1000 + 300 ))
timeout "${LIMIT}" bun run src/daemon.ts > "${SOAK_DIR}/daemon.log" 2>&1
RC=$?
echo "soak: daemon exited ${RC} (log ${SOAK_DIR}/daemon.log, $(wc -l < "${SOAK_DIR}/daemon.log") lines)"

SOAK_DAEMON_RC="${RC}" bun run src/soak/assert.ts after
