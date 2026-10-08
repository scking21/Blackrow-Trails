/* Blackrow Trails service worker — offline app shell + map tile caching.
 * Lets previously-viewed areas load with no signal (backcountry use). */
// SHELL_CACHE holds the app shell (index.html / styles.css / the app bundles —
// see SHELL_ASSETS). Like ASSET_CACHE it is served cache-first and survives SW
// updates, and it is refilled ONLY by install's addAll — which a browser runs
// only when sw.js's own bytes change. A hand-bumped name therefore pins every
// returning visitor to the old shell whenever a shell file moves without a bump.
// That is not hypothetical: the map fix deployed 2026-09-03 changed styles.css
// but not sw.js, so every returning browser kept serving the broken stylesheet
// out of 'trail-shell-v8'. Derived from the shell bytes for exactly the reason
// ASSET_CACHE is — the manual discipline has now failed for both caches.
const SHELL_CACHE = 'trail-shell-8ebb1bbcb5e7';  // substituted by scripts/emit-sw.mjs from shell bytes
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
const ASSET_CACHE = 'trail-assets-632618428bc7';  // substituted by scripts/emit-sw.mjs from asset bytes
const DATA_CACHE  = 'trail-data-v1';    // page-side last-good overlay GeoJSON (must survive SW updates)
const MAX_TILES   = 4000;            // shared ceiling with page-side offline region downloads
// How long a network-first page or asset may take before a stored copy is served
// (backcountry signal can stall a request far longer than it takes to fail).
const NETWORK_WAIT_MS = 3000;

// Dev cache-buster: on localhost, serve the app shell network-first so edits show
// immediately. In the packaged native app (capacitor:// / https://localhost is the
// app's own origin but served from disk) this stays cache-first for offline use.
const DEV = /^(localhost|127\.0\.0\.1)$/.test(self.location.hostname) &&
            self.location.port !== '';   // a real dev server has a port; native build does not
// Native files already ship on disk. Never let a worker pin an older app shell
// or vendored library across an APK/IPA upgrade. Remote map caching stays active.
const NATIVE = self.location.search === '?native=1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './licenses.html',
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

// Exact shell addresses, resolved against this worker's own URL so './' is the
// site root (not an empty suffix that matches every URL) and a sub-path
// deployment resolves under its own prefix.
const SHELL_URLS = new Set(SHELL_ASSETS.map((a) => new URL(a, self.location.href).href));

// SRI digests of the built shell files, substituted by scripts/emit-sw.mjs from
// the final www/ bytes. Install refuses a file the CDN has not yet updated, so a
// half-propagated deploy leaves the previous worker in place instead of caching
// a mixed shell under the new name. Empty in source, so tests and dev skip it.
const SHELL_INTEGRITY = {"./":"sha256-D6O91oXdrbt9cVW+StMMPgirIj6w1tTOwoN73NVRgHQ=","./index.html":"sha256-D6O91oXdrbt9cVW+StMMPgirIj6w1tTOwoN73NVRgHQ=","./licenses.html":"sha256-jUvY/PCZ0gkB4h8RsB/3J0OEOXv8+7Bd1OkwRwe2KQs=","./styles.css":"sha256-6w4zi+w0GpmePFuVNqPzRzH14WRgwB9I1nLXON13HhE=","./vendor/leaflet/leaflet.css":"sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=","./vendor/leaflet/leaflet.js":"sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=","./geo.js":"sha256-dkNkAjs10NsEVPvF6wmdsQwccBw6sTeM77gOMM37XCw=","./ar.js":"sha256-2EkEN+HzDChlM56X2e/y6+Uf65c8BIK5tNHpFdwdOCA=","./billing.js":"sha256-NiaHeSNOUa3MSWoF6FS2+Hd/nEYloqHdDbo+0s+4Wgo=","./share.js":"sha256-tv0b9YhHuJC03U54FB1rM0cQKAkw5bx5U4kqDYGrLWM=","./analytics.js":"sha256-X6j+VKBZCHw075BwLHcN4e1JDqRB30QUxuSN4d6fPw0=","./reservations.js":"sha256-Mt/UHFHu8E64ICP5pB46e0gY1+ToJAAexUGrD/MmycA=","./app.js":"sha256-FA6uOqvWsw9A6WxK8MpDM5m8SgU6yYmQpUVFz2Hbv00="};

// Vendored reservations assets (loaded on demand). Cached on first fetch so the
// Travel feature keeps working offline afterwards.
const isResAsset = (url) =>
  /\/vendor\/(pdfjs|tesseract|jeep-sqlite)\//.test(url) ||
  /\/assets\/sql-wasm\.wasm$/.test(url);

self.addEventListener('install', (e) => {
  if (NATIVE) {
    e.waitUntil(self.skipWaiting());
    return;
  }
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // The shell is a single offline unit. Let addAll reject the install if
      // any required asset cannot be cached; a partially installed shell must
      // never activate.
      // A new shell cache must not inherit still-fresh HTTP-cache bytes from
      // the previous release (new HTML with old JavaScript breaks the UI).
      .then((c) => c.addAll(SHELL_ASSETS.map(url => new Request(url, { cache: 'reload', integrity: SHELL_INTEGRITY[url] || '' }))))
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
// Evictions run in bounded-parallel chunks: a big offline-region download can
// leave thousands of keys over the ceiling, and the old strictly-sequential
// loop held each delete's async overhead end-to-end (~60x slower in the A/B
// model, scripts/bench-trim-tiles.mjs). Unbounded Promise.all was faster
// still but can saturate storage I/O on low-end devices mid-session — the
// chunk cap keeps the trim polite.
const TRIM_CHUNK = 64;
let pendingTrim = null;
let trimRequested = false;
function trimTiles() {
  trimRequested = true;
  if (!pendingTrim) {
    // Many tile misses finish together. Sharing one trim keeps the 64-operation
    // budget global and avoids enumerating/deleting the same keys for each tile.
    pendingTrim = Promise.resolve().then(async () => {
      try {
        const cache = await caches.open(TILE_CACHE);
        do {
          trimRequested = false;
          const keys = await cache.keys();
          const doomed = keys.slice(0, Math.max(0, keys.length - MAX_TILES));
          for (let i = 0; i < doomed.length; i += TRIM_CHUNK) {
            // Wait for the whole chunk even if storage rejects a deletion. A
            // failed trim must not leave work running outside the shared budget.
            const results = await Promise.allSettled(doomed.slice(i, i + TRIM_CHUNK).map((k) => cache.delete(k)));
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
          }
        } while (trimRequested); // Include writes that arrived after the snapshot.
      } finally {
        // Clear inside this async turn: a later writer starts a fresh trim even
        // if it arrives just before this promise's completion handlers run.
        pendingTrim = null;
      }
    });
  }
  return pendingTrim;
}

// Cache storage may be unavailable (private browsing, eviction, or I/O errors).
// A healthy network response must still be usable when its offline copy is not.
async function openCache(name) {
  try { return await caches.open(name); } catch { return null; }
}
async function matchCache(cache, request, options) {
  try { return cache ? await cache.match(request, options) : undefined; } catch { return undefined; }
}

// Register while the fetch event is active, before the first async cache read.
// Storage failures never reject the network response or leave an unhandled task.
function keepAlive(event) {
  let complete;
  event.waitUntil(new Promise(resolve => { complete = resolve; }));
  return work => Promise.resolve(work).catch(() => undefined).then(() => complete());
}

function cacheFirst(event, name, load, accepts, afterWrite) {
  const persist = keepAlive(event);
  event.respondWith((async () => {
    const cache = await openCache(name);
    const hit = await matchCache(cache, event.request, { ignoreSearch: name !== TILE_CACHE });
    if (hit) {
      persist();
      return hit;
    }
    try {
      const response = await load();
      persist(cache && accepts(response)
        ? Promise.resolve().then(() => cache.put(event.request, response.clone())).then(() => afterWrite?.())
        : undefined);
      return response;
    } catch {
      persist();
      return Response.error();
    }
  })());
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (NATIVE && new URL(url).origin === self.location.origin) return;

  // Map tiles: cache-first (serve offline), then network + store.
  if (isTile(url)) {
    const terrain = isCorsTile(url);
    cacheFirst(e, TILE_CACHE,
      () => terrain ? fetch(req) : fetch(req, { mode: 'no-cors' }),
      response => !terrain || response.ok, trimTiles);
    return;
  }

  // Vendored reservations assets: cache-first, store on first successful fetch.
  if (isResAsset(url)) {
    cacheFirst(e, ASSET_CACHE, () => fetch(req), response => response.ok);
    return;
  }

  // Cross-origin requests that are not tiles (live APIs, radar images) are
  // always fresh: no respondWith, so the browser fetches them directly.
  const target = new URL(url, self.location.href);
  if (target.origin !== self.location.origin) return;
  target.search = '';

  // Prod: the shell is cache-first. It changes only when install fills a NEW
  // SHELL_CACHE name, which happens whenever a shell file's bytes change.
  if (!DEV && SHELL_URLS.has(target.href)) {
    cacheFirst(e, SHELL_CACHE, () => fetch(req), response => response.ok);
    return;
  }

  const persist = keepAlive(e);
  e.respondWith((async () => {
    const cache = await openCache(SHELL_CACHE);
    const stored = () => matchCache(cache, req, { ignoreSearch: true });
    // Everything else same-origin (terms/privacy/support, icons, JSON) can change
    // without renaming the shell cache, so it is network-first and revalidated
    // past the HTTP cache. Dev treats the shell the same way so edits show on
    // reload. A navigation keeps its 'manual' redirect mode: a followed redirect
    // cannot answer a navigation. On weak signal the network gets NETWORK_WAIT_MS
    // before a stored copy is served; a late response still refreshes the cache.
    // A network answer only counts once its whole body has arrived and been
    // stored: headers alone can arrive promptly while the body stalls, and the
    // worker must stay alive until the refreshed copy is actually written.
    // Opaque redirects and errors are not ok, so they pass through uncached.
    const complete = async (res) => {
      if (!res.ok) return res;
      const full = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
      if (cache) await cache.put(req, full.clone()).catch(() => undefined);
      return full;
    };
    const network = Promise.resolve().then(() =>
      fetch(url, { cache: 'no-cache', redirect: req.redirect || 'follow' })).then(complete);
    persist(network);
    const copy = await stored();
    if (!copy) return network.catch(() => Response.error());
    let timer;
    const waited = new Promise((resolve) => { timer = setTimeout(() => resolve(copy), NETWORK_WAIT_MS); });
    return Promise.race([network, waited]).catch(() => copy).finally(() => clearTimeout(timer));
  })());
});
