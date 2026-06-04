// Service worker — makes the app installable (PWA). Chrome requires the app to
// work offline, so we serve a cached offline fallback for navigations when the
// network is unavailable. We do NOT cache authenticated pages (stale/wrong-user risk).
const CACHE = "folkpath-v5";
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

// Push: show a notification on the device's home/lock screen (e.g. a job offer).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "Folkpath", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Folkpath";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag,
    renotify: true,
    data: { url: data.url || "/" },
  }));
});

// Tapping the notification opens (or focuses) the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
      return self.clients.openWindow(url);
    }),
  );
});
