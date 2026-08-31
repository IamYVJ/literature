// ============================================================================
// sw.js — Service worker. Precaches the full app shell so the site loads
// instantly and works offline after the first visit.
//
// All precache paths are RELATIVE so the worker functions correctly under a
// GitHub Pages subpath (e.g. https://user.github.io/literature/). The SW's scope
// is its own directory, so relative URLs resolve against that.
//
// NOTE: caching the shell does NOT make multiplayer fully offline — PeerJS still
// needs to reach a signaling broker to set up the WebRTC handshake. What you do
// get offline is the shell itself, which is what makes the app openable from a
// home screen. See js/net.js for self-hosting a broker on the LAN.
//
// AND NOTHING HERE MAY CACHE THE SERVER'S /health. The client decides whether to
// offer server mode at all on the strength of that one request, so a cached "yes"
// would strand a player in a mode whose server is switched off — offering a Host
// online button that can only ever time out. See the fetch handler below and the
// note on SERVER_HEALTH in js/config.js.
// ============================================================================

// Bump this version to invalidate old caches on the next activate.
//
// Usually you don't need to: same-origin assets are stale-while-revalidate, so a
// redeploy heals itself (see the fetch handler). The EXCEPTION is a release that
// changes the module import graph. Re-installing over a live cache rewrites the
// shell entry by entry, so a page loading during that window can pull a new
// main.js against an old cards.js and die on a missing export — a blank screen
// until the next reload. A new cache NAME is built to one side and swapped in
// whole at activate, which cannot half-apply.
//
// The same hazard applies to any two shell files that only work as a pair, not
// just to ES imports: ui.js opens the <dialog> that lives in index.html, so a
// new ui.js against an old index.html gives a How-to-play button that silently
// does nothing.
//
// So: change what modules import from each other, or split a feature across two
// shell files -> bump this.
const CACHE = 'literature-v4';

// Core app shell (same-origin). Relative to the SW's scope.
//
// This must list EVERY module in the import graph, not just the entry point: the
// browser resolves `import` statements one file at a time, so a single missing
// module leaves the app unable to boot offline even though everything else is
// cached. Add new js/ files here as they are created.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/ui.js',
  './js/state.js',
  './js/rules.js',
  './js/cards.js',
  './js/bots.js',
  './js/botdriver.js',
  './js/net.js',
  './js/config.js',
  './js/intents.js',
  './js/guards.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// Cross-origin assets we want available offline (the PeerJS lib). The actual
// font files are cached lazily at runtime on first fetch.
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Same-origin shell: fail the install if any of these are missing.
    await cache.addAll(SHELL);
    // External libs: best-effort, so a CDN hiccup doesn't block the install.
    await Promise.allSettled(EXTERNAL.map((url) => fetch(url, { mode: 'cors' })
      .then((r) => r.ok && cache.put(url, r.clone()))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // THE LIVENESS PROBE IS NEVER CACHED, whoever is serving it.
  //
  // js/config.js points the probe at another origin, so today this request would
  // fall through to the network anyway — the same-origin branch below would not
  // claim it. This is here because that is a coincidence of one config value and
  // not a property of the app: serve the client from the same host as the server
  // and a cached `{"ok":true}` would survive the Pi being switched off, leaving
  // every visit offering a Host online button that can only ever time out. A
  // stale "no" costs one refresh; a stale "yes" costs the player the whole join.
  if (url.pathname.endsWith('/health')) return;

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname === 'unpkg.com';

  // Fonts and the version-pinned PeerJS URL are immutable, so cache-first with
  // no revalidation is right: the bytes behind these URLs never change.
  if (isFont || isCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Cache successful and opaque (font) responses for next time.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  // Our own assets: stale-while-revalidate. Serve the cache for an instant,
  // offline-capable load, then refresh it in the background so the NEXT load
  // picks up a redeploy on its own.
  //
  // This applies to navigations too, deliberately. Going network-first for HTML
  // while the modules came from cache would serve a new index.html against old
  // js/ — a half-updated app. Updating everything from one cache generation
  // keeps the shell and its import graph in step.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req)
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);

      const fresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });

      if (cached) {
        // Keep the worker alive long enough to finish the background refresh,
        // and swallow its failure — we already have a good response to return.
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      try {
        return await fresh;
      } catch (_) {
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
  }
  // Everything else (signaling, WebRTC) falls through to the network.
});
