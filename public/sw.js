// Service worker for the in-season coach PWA.
//
// Filip installs this to his phone home screen, so it has to behave like an app:
// open instantly, survive a dead cell connection, and never show a browser error
// page. Three caching rules, each matched to what the request is for.
//
//  1. The app shell (HTML, icons, manifest) is precached and served cache-first.
//     Opening the app never waits on the network.
//  2. Navigations are network-first with the cached shell as fallback, so a new
//     build is picked up on the next open but a tunnel does not break the app.
//  3. The season API is network-first with a cache fallback. A stale scoreboard
//     is far better than an error, and the page stamps how old it is so a cached
//     answer is never mistaken for a live one.
//
// The API is NEVER served cache-first: on a Sunday a stale score is actively
// misleading, so the network always gets first refusal and the cache only catches
// the failure.

const VERSION = "season-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

const SHELL = [
  "/season",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // One missing shell entry must not fail the whole install and leave the app
      // uncontrolled, so each is added independently.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network, fall back to the cached shell so the app opens
  // offline instead of showing a browser error page.
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, SHELL_CACHE).catch(async () => (await caches.match("/season")) ?? Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith("/api/season")) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Everything else (icons, manifest): cache-first, refreshed in the background.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        }),
    ),
  );
});
