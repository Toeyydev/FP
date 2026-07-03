// Folkpaths PWA service worker — install + push + self-heal + fast loads.
// A guide opens this on their phone: the old worker fetched every page network-first,
// so a cold Railway container meant a white wait on every open. Now:
//   • build assets (/_next/static, icons, fonts) → cache-first (immutable, instant);
//   • navigations → network-first but fall back to the last-cached page after a short
//     wait, so a cold/slow server never blocks the paint. Data (/api) is never cached,
//     so it always loads fresh and auth/redirects stay correct on a normal load.
const CACHE = "folkpath-v29";
const OFFLINE = "/offline.html";
const NAV_TIMEOUT = 3500; // ms to wait for the server before painting the cached page

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
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { try { c.navigate(c.url); } catch (e) { /* ignore */ } }
  })());
});

// Immutable, content-hashed assets — serve from cache, fetch once.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
  return res;
}

// Pages — prefer a fresh server response, but never let a cold server block the
// paint: if we have a cached copy and the server is slow, show the cached page and
// let the network refresh the cache in the background for next time.
async function handleNavigate(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req)
    .then((res) => {
      // Only cache a clean, non-redirected page (never an auth redirect to /start).
      if (res && res.status === 200 && !res.redirected) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  const cached = await cache.match(req);
  if (!cached) {
    const res = await network;
    return res || (await cache.match(OFFLINE));
  }
  const timeout = new Promise((r) => setTimeout(() => r(null), NAV_TIMEOUT));
  const fresh = await Promise.race([network, timeout]);
  return fresh || cached;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // ignore cross-origin
  if (url.pathname.startsWith("/api/")) return;     // data is always network-fresh
  if (url.pathname.startsWith("/_next/static/") || /\.(?:woff2?|png|svg|ico|jpe?g|webp)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req));
  }
});

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
