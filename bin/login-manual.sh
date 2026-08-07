#!/usr/bin/env bash
# Launch a plain, NON-Playwright Brave for a human Sleeper login over noVNC.
#
# Why: Cloudflare Turnstile rejects logins from a Playwright-driven browser even
# with a correct captcha solve, because it detects the automation. A genuine
# Brave (no CDP, no automation flags) passes. The session persists in the shared
# profile, which Playwright then reuses for all subsequent actions.
#
# --disable-dev-shm-usage is required: Docker's default /dev/shm is 64M and
# Brave crashes ("No space left on device") without it.
set -u
PROFILE="${BROWSER_PROFILE:-/data/sleeper-coach/profile}"
rm -f "$PROFILE"/Singleton*
exec env DISPLAY=:99 /usr/bin/brave-browser \
  --user-data-dir="$PROFILE" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check \
  "https://sleeper.com/login"
