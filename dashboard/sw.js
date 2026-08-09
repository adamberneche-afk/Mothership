// Minimal app-shell service worker - only what makes this page installable
// and reloadable while briefly offline. Deliberately does NOT cache
// anything from api.github.com: this dashboard's entire purpose is to show
// current health/decision-log status, so serving stale API data back from
// a cache would defeat the point of it existing.
const CACHE_NAME = 'mothership-dashboard-v1';
const APP_SHELL = ['./', './index.html', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept GitHub API calls
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
