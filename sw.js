/* Folder Player service worker: keeps the app cached so it opens with no connection.
 * Cached files are served first; when online, each request also refreshes the cache
 * in the background, so updates you push show up on the next launch. */
const CACHE = 'folder-player-v4';
const SHELL = [
  './', './index.html', './app.js', './synth.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

// Safari refuses redirected responses for page loads, so store a clean copy.
const unredirect = async res => res.redirected
  ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
  : res;

async function save(cache, url) {
  const res = await fetch(new Request(url, { cache: 'reload' }));
  if (!res.ok) throw new Error(url + ' ' + res.status);
  await cache.put(url, await unredirect(res));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => save(cache, u)));
    // Optional recordings shipped in sounds/ (listed in sounds/sounds.json).
    try {
      const res = await fetch('./sounds/sounds.json', { cache: 'reload' });
      if (res.ok) {
        const list = await res.clone().json();
        await cache.put('./sounds/sounds.json', res);
        await Promise.all(list.map(s => save(cache, './sounds/' + s.file).catch(() => {})));
      }
    } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('folder-player-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || req.headers.has('range')) return;
  const fresh = fetch(req).then(async res => {
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(req, await unredirect(res.clone()));
    }
    return res;
  });
  const cached = caches.open(CACHE).then(async cache =>
    await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? cache.match('./index.html') : undefined));
  e.respondWith(cached.then(hit => hit || fresh));
  e.waitUntil(fresh.catch(() => {}));
});
