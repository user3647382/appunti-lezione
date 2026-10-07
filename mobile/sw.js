// Tiene una copia dell'app sul dispositivo, così si apre e funziona anche senza rete (in aula capita).
// Con la rete si prende sempre la versione più recente; senza rete, o se la rete è lentissima, la copia salvata.
const CACHE = 'appunti-lezione-3.0';
const SHELL = [
  './', 'mobile.css', 'mobile.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  '../shared.js', '../vendor/pdf.min.js', '../vendor/pdf.worker.min.js', '../vendor/fflate.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(rej, 3500))]);
      if (fresh.ok) cache.put(e.request, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
