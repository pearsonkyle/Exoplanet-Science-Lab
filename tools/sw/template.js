// Exoplanet Science Lab service worker: keeps the whole site usable without a connection.
// Generated into dist/sw.js by tools/sw/build.mjs, which prepends VERSION, SHELL and DATA (lists of
// [path relative to this file, sha256 prefix]) read from the built dist/. Do not edit dist/sw.js.
//
// - install: the shell (every page, its scripts, styles, workers, images and the small data each page opens with)
//   goes into the cache `esl-<VERSION>`; files whose bytes did not change since the previous version are copied from
//   its cache instead of downloaded. Every download is checked against the manifest's hash, so a file from a newer
//   deploy never lands in this version's cache (no mixed versions).
// - activate: the caches of other versions are deleted.
// - 'warm' message (sent by src/site/nav.js once a page is idle): the rest (catalogue snapshots, examples, sample
//   FITS, validation data, the docs) is saved in the background, a few files at a time, resuming where it stopped.
// - fetch: same-origin GETs are answered from the cache first; anything not yet saved goes to the network and is
//   saved if it belongs to this version. Requests to other sites (archives, tiles, the assistant's model server) are
//   not touched: the page sees their failures and says so (src/site/net.js).
// - revalidation is per version, not per file: on a navigation the worker asks the browser to re-check sw.js
//   (at most every 5 minutes); a new deploy gives a new sw.js, which installs a complete new cache next to the old one
//   and takes over when the page agrees (nav.js offers "Reload") or no page is open.

const CACHE = 'esl-' + VERSION;
const BASE = new URL('./', self.location).href;
const ALL = new Map([...SHELL, ...DATA].map(([p, h]) => [new URL(p, BASE).href, h]));
const HASH_HEADER = 'x-esl-hash';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(buf) { return hex(await crypto.subtle.digest('SHA-256', buf)).slice(0, 16); }

/** A copy of the file with this hash from an older version's cache, or null. */
async function fromOld(url, hash) {
  for (const name of await caches.keys()) {
    if (!name.startsWith('esl-') || name === CACHE) continue;
    const r = await (await caches.open(name)).match(url);
    if (r && r.headers.get(HASH_HEADER) === hash) return r;
  }
  return null;
}

/** Put one manifest file into this version's cache. Returns true when it is there. */
async function save(cache, url, hash, { network = true } = {}) {
  if (await cache.match(url)) return true;
  const old = await fromOld(url, hash);
  if (old) { await cache.put(url, old); return true; }
  if (!network) return false;
  const r = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (await sha(buf) !== hash) { self.registration.update().catch(() => {}); throw new Error(`${url}: changed on the server (a newer version is deployed)`); }
  const headers = new Headers(r.headers); headers.set(HASH_HEADER, hash); headers.delete('content-encoding'); headers.delete('content-length');
  await cache.put(url, new Response(buf, { status: 200, statusText: 'OK', headers }));
  return true;
}

async function pool(items, n, fn) {
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { failed++; } } }));
  return failed;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // the shell must be complete or this version does not install
    let err = null;
    await pool(SHELL, 6, async ([p, h]) => { try { await save(cache, new URL(p, BASE).href, h); } catch (e) { err = err || e; } });
    if (err) throw err;
    // what an older version had already saved of the rest: copied now, while its cache still exists
    await pool(DATA, 8, ([p, h]) => save(cache, new URL(p, BASE).href, h, { network: false }));
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!open.length) self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('esl-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

let warming = null;
async function warm() {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const [p, h] of DATA) { const u = new URL(p, BASE).href; if (!(await cache.match(u))) missing.push([u, h]); }
  const failed = await pool(missing, 3, ([u, h]) => save(cache, u, h));
  return { total: SHELL.length + DATA.length, missing: missing.length, failed };
}

async function status() {
  const cache = await caches.open(CACHE), keys = new Set((await cache.keys()).map((r) => r.url));
  let have = 0; for (const u of ALL.keys()) if (keys.has(u)) have++;
  return { type: 'esl-sw-status', version: VERSION, have, total: ALL.size, bytes: BYTES };
}

self.addEventListener('message', (event) => {
  const d = event.data || {}, reply = (m) => { const to = (event.ports && event.ports[0]) || event.source; if (to) to.postMessage(m); };
  if (d.type === 'skip-waiting') self.skipWaiting();
  else if (d.type === 'status') event.waitUntil(status().then(reply));
  else if (d.type === 'warm') {
    warming = warming || warm().finally(() => { warming = null; });
    event.waitUntil(warming.then(async (r) => reply({ ...(await status()), ...r, type: 'esl-sw-warmed' }), () => {}));
  }
});

let lastCheck = 0;
function revalidate() {
  if (Date.now() - lastCheck < 300000) return;
  lastCheck = Date.now(); self.registration.update().catch(() => {});
}

/** The cached file for a navigation: the path, its index.html, or path.html (as the static host resolves them). */
async function matchPage(cache, url) {
  const u = new URL(url); u.search = ''; u.hash = '';
  const tries = [u.href];
  if (u.pathname.endsWith('/')) tries.push(u.href + 'index.html');
  else if (!/\.[a-z0-9]+$/i.test(u.pathname)) tries.push(u.href + '.html', u.href + '/index.html');
  for (const t of tries) { const r = await cache.match(t); if (r) return r; }
  return null;
}

const offlinePage = (url) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>
<body style="font:15px/1.5 system-ui;background:#0b0f18;color:#dfe6f3;padding:40px;max-width:640px;margin:auto">
<h2>This page is not saved on this device</h2><p>You are offline, and <code>${new URL(url).pathname.replace(/[<>&]/g, '')}</code> was not part of the saved copy of Exoplanet Science Lab.</p>
<p><a style="color:#5fd4ff" href="${BASE}">Go to the home page</a>: everything linked from there works offline.</p>`, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(BASE) || req.headers.has('range')) return;
  const nav = req.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = nav ? await matchPage(cache, req.url)
      : (await cache.match(req, { ignoreSearch: !ALL.has(req.url) && ALL.has(req.url.split('?')[0]) })) || (/\/$|\/[^./]+$/.test(new URL(req.url).pathname) ? await matchPage(cache, req.url) : null);
    if (hit) { if (nav) revalidate(); return hit; }
    try {
      const r = await fetch(req);
      const key = req.url.split('#')[0];
      if (r.ok && ALL.has(key) && !nav) {
        const copy = r.clone(); event.waitUntil(copy.arrayBuffer().then(async (buf) => { const h = ALL.get(key); if (await sha(buf) !== h) return; const headers = new Headers(copy.headers); headers.set(HASH_HEADER, h); headers.delete('content-encoding'); headers.delete('content-length'); await cache.put(key, new Response(buf, { status: 200, headers })); }).catch(() => {}));
      }
      return r;
    } catch (err) {
      if (nav) return offlinePage(req.url);
      throw err;
    }
  })());
});
