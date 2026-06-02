// Minimal service worker — makes the app installable (PWA) without caching
// authenticated pages (which would risk serving stale/wrong-user content).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// A fetch handler is required for installability; we pass through to the network.
self.addEventListener("fetch", () => { /* network default */ });
