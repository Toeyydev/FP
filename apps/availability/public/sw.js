// Service worker — makes the app installable (PWA) and SELF-HEALS: when a new
// version activates it wipes old caches and reloads any wedged tab into the live
// app, so a stuck "Reconnecting…" page recovers on its own after one reload.
const CACHE = "folkpath-v6";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icon-192.png"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop every old cache (including any stale offline page).
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Force any open tab to reload into the fresh, live app.
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { try { c.navigate(c.url); } catch (e) { /* ignore */ } }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Page navigations: always go to the network (no-store) so reloads pick up new
  // deploys; only fall back to the offline page on a genuine network failure.
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
