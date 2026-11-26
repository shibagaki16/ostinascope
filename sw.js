// Ostinascope — service worker: always the newest files, and the last good
// copy when there is no network.
//
// The app is made of many module files, and a browser may keep a file
// without asking (some hosts allow 10 minutes; a phone's own cache can do
// it too): after an update a phone could run a mix of old and new ones,
// with no way to force a reload. Here every request of this site asks the
// server first (a quick "not modified" when nothing changed) and keeps
// what it got; only when the network fails is the kept copy used — so the
// app also opens at a venue with a bad connection.
//
// Requests to other sites (the web font) are left alone.

const CACHE = 'ostinascope-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (!res.ok || res.type !== 'basic') return res;
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
      // the page's own caches must not keep it: if the server allows
      // keeping it for a while, the browser would reuse the old file on a
      // reload without asking here
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-cache');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      const kept = await caches.match(req);
      if (kept) return kept;
      throw err;
    }
  })());
});
