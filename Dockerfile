# The coach image: Bun plus git (the in-container engineer clones and commits)
# and curl (the Claude CLI installer). Nothing else. Until 2026-09-09 this was
# the Playwright image with Brave, Xvfb, x11vnc and noVNC on top, because the
# Sleeper session lived in a headed browser. Every Sleeper action is now a
# direct GraphQL request with the session token (see src/league/api.ts), so the
# browser stack is gone and the image is a few hundred MB instead of two GB.
FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN chmod +x bin/coach bin/act entrypoint.sh scripts/soak.sh scripts/hooks/pre-push
ENV PATH="/app/bin:${PATH}"

# The git SHA this image was built from. Coolify passes SOURCE_COMMIT as a
# build arg; a hand build can pass --build-arg COACH_SHA=$(git rev-parse HEAD).
# The daemon logs a `deploy` event with it and the boot canary writes it into
# the kill-switch file, so "what is running" is answerable from the activity
# log and from `docker exec <c> env | grep COACH_SHA`. See DEPLOY.md.
ARG SOURCE_COMMIT=unknown
ARG COACH_SHA=$SOURCE_COMMIT
ENV COACH_SHA=$COACH_SHA

# Persistent state (the session token, SQLite, claude HOME, brain notes) lives
# on a bind-mount at /data/sleeper-coach; the defaults in code point there.
ENV HOME=/data/sleeper-coach/config

CMD ["bash", "/app/entrypoint.sh"]
