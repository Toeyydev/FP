// Service worker — makes the app installable (PWA). Chrome requires the app to
// work offline, so we serve a cached offline fallback for navigations when the
// network is unavailable. We do NOT cache authenticated pages (stale/wrong-user risk).
const CACHE = "folkpath-v4";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icon-192.png"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Page navigations: always fetch fresh HTML (no-store) so a reload picks up a
  // new deploy; fall back to the offline page when there's no network.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req.url, { cache: "no-store", credentials: "include" }).catch(() => caches.match(OFFLINE)),
    );
  }
});
