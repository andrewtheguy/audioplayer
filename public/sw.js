// Minimal service worker - no caching, network-first only
// This enables PWA installability without offline support

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass through all requests to the network - no caching
  event.respondWith(fetch(event.request));
});
