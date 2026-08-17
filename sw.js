/* Blackrow Trails service worker — offline app shell + map tile caching.
 * Lets previously-viewed areas load with no signal (backcountry use). */
const SHELL_CACHE = 'trail-shell-v7';   // bumped: T-Satellite analytics event wiring
const TILE_CACHE  = 'trail-tiles-v1';   // never rename — holds users' offline map tiles
// ASSET_CACHE holds vendored code (pdf.js / tesseract / jeep-sqlite / sql-wasm.wasm
// — see isResAsset), NOT user data. It is served cache-first with no revalidation,
// and activate keeps it across SW updates, so its NAME is the only thing that can
// force the browser to drop stale bytes. The name therefore tracks the contents:
// at build time scripts/emit-sw.mjs hashes the vendored asset trees and substitutes
// the placeholder below, so any vendored update produces a new cache name and the
// stale bytes are evicted on the next activate. This is deliberately derived, not
// hand-bumped — the manual discipline failed for this cache (the sql.js WASM fix
// shipped under a constant `trail-assets-v1` and never reached a cached browser).
//
// TRADEOFF: renaming evicts vendored code, so the first online load after an update
// re-downloads pdf.js / tesseract / jeep-sqlite. That is correct (they are code,
// not user data), but a user who updates and immediately goes offline loses those
// vendored features until they are online once. We state it; we do not solve it.
// TILE_CACHE and DATA_CACHE hold genuine USER DATA and must never be renamed.
const ASSET_CACHE = 'trail-assets-7dd85ddd2748';  // substituted by scripts/emit-sw.mjs from asset bytes
const DATA_CACHE  = 'trail-data-v1';    // page-side last-good overlay GeoJSON (must survive SW updates)
const MAX_TILES   = 4000;            // shared ceiling with page-side offline region downloads

// Dev cache-buster: on localhost, serve the app shell network-first so edits show
// immediately. In the packaged native app (capacitor:// / https://localhost is the
// app's own origin but served from disk) this stays cache-first for offline use.
const DEV = /^(localhost|127\.0\.0\.1)$/.test(self.location.hostname) &&
            self.location.port !== '';   // a real dev server has a port; native build does not

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  // App modules — load order mirrors the <script> tags in index.html.
  './geo.js',
  './ar.js',
  './billing.js',
  './share.js',
  './analytics.js',
  './reservations.js',
  './app.js',
];

// Vendored reservations assets (loaded on demand). Cached on first fetch so the
// Travel feature keeps working offline afterwards.
const isResAsset = (url) =>
  /\/vendor\/(pdfjs|tesseract|jeep-sqlite)\//.test(url) ||
  /\/assets\/sql-wasm\.wasm$/.test(url);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // The shell is a single offline unit. Let addAll reject the install if
      // any required asset cannot be cached; a partially installed shell must
      // never activate.
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE && k !== ASSET_CACHE && k !== DATA_CACHE)
        .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

const isTile = (url) =>
  /tile\.opentopomap\.org/.test(url) ||
  /\.tile\.openstreetmap\.org/.test(url) ||
  /s3\.amazonaws\.com\/elevation-tiles-prod\//.test(url) ||   // slope-shading terrain tiles
  /\/tile[s]?\//.test(url);

// Terrain-RGB slope tiles are fetched as CORS images (crossOrigin='anonymous');
// an opaque no-cors response would taint/blank them, so keep their mode intact.
const isCorsTile = (url) => /s3\.amazonaws\.com\/elevation-tiles-prod\//.test(url);

// Trim the tile cache so it can't grow without bound.
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Map tiles: cache-first (serve offline), then network + store.
  if (isTile(url)) {
    // FetchEvent.waitUntil must be registered while handling the event. The
    // promise is completed after a cache miss's write and trim have settled,
    // but it is deliberately not awaited by respondWith's network response.
    let completePersistence;
    const persistence = new Promise((resolve) => { completePersistence = resolve; });
    e.waitUntil(persistence);
    const persist = (work) => {
      Promise.resolve(work)
        .catch(() => undefined)
        .then(() => completePersistence());
    };

    e.respondWith((async () => {
      let cache;
      let hit;
      try {
        cache = await caches.open(TILE_CACHE);
        hit = await cache.match(req);
      } catch (error) {
        completePersistence();
        throw error;
      }
      if (hit) {
        completePersistence();
        return hit;
      }

      try {
        // Terrain-RGB tiles must stay CORS-mode (see isCorsTile) and only be
        // cached on success; other basemap tiles can use no-cors (opaque OK).
        const network = isCorsTile(url) ? fetch(req) : fetch(req, { mode: 'no-cors' });
        persist(network.then((res) => {
          if (isCorsTile(url) && !res.ok) return undefined;
          return Promise.resolve(cache.put(req, res.clone())).then(() => trimTiles());
        }));
        return await network;
      } catch {
        completePersistence();
        return Response.error();
      }
    })());
    return;
  }

  // Vendored reservations assets: cache-first, store on first fetch.
  if (isResAsset(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()); // never cache 404s/errors
        return res;
      } catch {
        return hit || Response.error();
      }
    })());
    return;
  }

  // App shell (same-origin + Leaflet CDN).
  if (req.destination === 'document' || SHELL_ASSETS.some((a) => url.endsWith(a.replace('./', '')))) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const fromNet = () => fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
      if (DEV) {
        // Dev: network-first so edits show on reload; fall back to cache if offline.
        try { return await fromNet(); } catch { return (await cache.match(req, { ignoreSearch: true })) || Response.error(); }
      }
      // Prod: cache-first with background refresh.
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || (await fromNet().catch(() => null)) || Response.error();
    })());
  }

  // Live data API calls (USGS/PAD-US) are intentionally NOT cached — always fresh.
});
