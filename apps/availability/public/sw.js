// Service worker — PWA install + push + SELF-HEAL. Navigation handling passes the
// ORIGINAL request to fetch() so redirects (e.g. auth → /start) work natively;
// a previous version re-fetched the URL string with redirect:follow, which made
// Chrome reject the redirected response and break every page load.
const CACHE = "folkpath-v7";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icon-192.png"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Reload any open tab so a wedged one recovers into the live app.
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { try { c.navigate(c.url); } catch (e) { /* ignore */ } }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only navigations; pass the original request so redirect mode ("manual") is
  // preserved and the browser performs auth redirects itself. Offline fallback
  // only on a real network error.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
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
