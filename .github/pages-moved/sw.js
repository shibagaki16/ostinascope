// The old address no longer has the app: phones that opened it there keep
// its service worker, which would still open the old copy without a
// network. This replaces it, clears what it kept and removes itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
  })());
});
