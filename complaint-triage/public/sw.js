// App-shell cache: the station app opens and triages with no network (or even with the server stopped).
const CACHE = 'sunvai-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'classifier.js', 'samples.js', 'manifest.webmanifest', 'icon.svg'];
// Behind an ngrok free tunnel, requests without this header get ngrok's warning page instead of the file.
const HDR = { 'ngrok-skip-browser-warning': '1' };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { headers: HDR }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { headers: HDR });
  // Network-first so updates show up when online; cache fallback when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
