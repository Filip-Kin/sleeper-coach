# Playwright's Node image ships Chromium + all browser deps at /ms-playwright,
# matching the pinned playwright npm version (1.50.0). We add the noVNC stack
# (so the browser is viewable/controllable in a tab) and Bun (the coach's
# runtime). The Claude CLI installs into the persistent HOME at first start.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify curl unzip ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# Brave: a real Chromium-based browser with a genuine fingerprint, driven by
# Playwright via executablePath. Same anti-bot-detection reason as pit-podcast.
RUN curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/brave-browser-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=amd64] https://brave-browser-apt-release.s3.brave.com/ stable main" \
      > /etc/apt/sources.list.d/brave-browser.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends brave-browser \
 && rm -rf /var/lib/apt/lists/*
ENV BROWSER_EXECUTABLE=/usr/bin/brave-browser

# Bun (the coach runtime).
RUN curl -fsSL https://bun.sh/install | bash \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Browsers are already in the image; don't re-download on npm install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN chmod +x bin/coach bin/act entrypoint.sh
ENV PATH="/app/bin:${PATH}"

# Persistent state (browser profile, SQLite, claude HOME, brain notes) lives on
# a bind-mount at /data/sleeper-coach; the defaults in code point there.
ENV HOME=/data/sleeper-coach/config
ENV DISPLAY=:99
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["bash", "/app/entrypoint.sh"]
