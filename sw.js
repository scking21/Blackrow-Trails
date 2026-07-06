/* Blackrow Trails service worker — offline app shell + map tile caching.
 * Lets previously-viewed areas load with no signal (backcountry use). */
const SHELL_CACHE = 'trail-shell-v5';   // bumped: net-fallback module + fallback wiring
const TILE_CACHE  = 'trail-tiles-v1';   // never rename — holds users' offline map tiles
const ASSET_CACHE = 'trail-assets-v1';  // vendored pdf.js / tesseract / jeep-sqlite
const DATA_CACHE  = 'trail-data-v1';    // page-side last-good overlay GeoJSON (must survive SW updates)
const MAX_TILES   = 2000;            // ~ a few regions at trail zooms (+ shared slope terrain tiles)

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
      .then((c) => Promise.allSettled(SHELL_ASSETS.map((u) => c.add(u))))
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
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        // Terrain-RGB tiles must stay CORS-mode (see isCorsTile) and only be
        // cached on success; other basemap tiles can use no-cors (opaque OK).
        if (isCorsTile(url)) {
          const res = await fetch(req);
          if (res.ok) { cache.put(req, res.clone()); trimTiles(); }
          return res;
        }
        const res = await fetch(req, { mode: 'no-cors' });
        cache.put(req, res.clone());
        trimTiles();
        return res;
      } catch {
        return hit || Response.error();
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
