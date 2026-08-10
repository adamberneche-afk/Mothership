// Minimal app-shell service worker - only what makes this page installable
// and reloadable while briefly offline. Deliberately does NOT cache
// anything from api.github.com: this dashboard's entire purpose is to show
// current health/decision-log status, so serving stale API data back from
// a cache would defeat the point of it existing.
//
// Bump CACHE_NAME on every deploy that changes index.html/app.js/manifest.json
// - skipWaiting()/clients.claim() below mean a bumped version takes over on
// the very next load (no longer stuck "waiting" until every tab closes), but
// an *unbumped* CACHE_NAME still means the old cached files, not the new
// ones, keep getting served.
const CACHE_NAME = 'mothership-dashboard-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];
const OFFLINE_FALLBACK = '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:40px;text-align:center;color:#5c5f57">Mothership Health Dashboard is offline and this page was not cached yet. Reconnect and reload.</body>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // A single failed app-shell fetch (a network blip during first
      // install, a renamed file) used to fail the whole install silently,
      // leaving offline support and installability broken with no signal
      // anywhere. Logging and continuing means install still succeeds -
      // best-effort caching, not all-or-nothing.
      .catch((err) => console.warn('mothership-dashboard: app-shell cache failed', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept GitHub API calls
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).catch(
          () =>
            new Response(OFFLINE_FALLBACK, { status: 200, headers: { 'Content-Type': 'text/html' } })
        )
    )
  );
});
