// The terrain horizon in the browser: fetches and decodes the elevation tiles that src/core/horizon.js asks for,
// keeps the tiles in IndexedDB (the PNG bytes as they came, at most MAX_TILES of them, the least recently used
// dropped first) and the resulting profile in localStorage, one entry per place (rounded to 0.001 degree, about
// 100 m) and eye height. Used by the Observe page (the Terrain layer) and the planner ("use the terrain horizon").
// Nothing here runs until one of those is switched on. Offline, or when the tiles cannot be had, the promise rejects
// and the page keeps its flat horizon.
import { horizonProfile, tilesNeeded, terrariumElevation, TILE_URL, TILE_SIZE, ATTRIBUTION } from '../core/horizon.js';

export { ATTRIBUTION };
// v2: the pyramid with zoom 13 near the observer and a march of up to 300 km (horizon.js, 2026-11-15)
const KEY = 'esl.sky.horizon.v2', MAX_ENTRIES = 8, DB = 'esl-terrain', STORE = 'tiles', MAX_TILES = 600;
const placeKey = (lat, lon, eye = 2, elev = null) => `${lat.toFixed(3)},${lon.toFixed(3)},${(+eye).toFixed(1)}${Number.isFinite(elev) ? ',' + Math.round(elev) : ''}`;
const readAll = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

/** The cached profile of a place (and eye height, and stated elevation), or null. */
export function cachedHorizon(lat, lon, eye = 2, elev = null) {
  const e = readAll()[placeKey(lat, lon, eye, elev)];
  return e && Array.isArray(e.alt) ? { ...e, alt: Float32Array.from(e.alt, (v) => v / 100), cached: true } : null;
}
function store(lat, lon, eye, elev, p) {
  const all = readAll(); all[placeKey(lat, lon, eye, elev)] = { t: Date.now(), step: p.step, azFrom: p.azFrom, n: p.n, ground: Math.round(p.ground), eye: p.eye, maxDist: p.maxDist, tiles: p.tiles, tilesFailed: p.tilesFailed, alt: Array.from(p.alt, (v) => Math.round(v * 100)) };
  const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
  for (const k of keys.slice(MAX_ENTRIES)) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the profile is still used for this visit */ }
}

// ---- the tile cache (IndexedDB): { k: 'z/x/y', png: Blob, t: last use }. Any failure means "not cached".
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'k' }); s.createIndex('t', 't'); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
const tx = async (mode, f) => { const d = await db(); if (!d) return null; return new Promise((res) => { try { const t = d.transaction(STORE, mode), s = t.objectStore(STORE), out = f(s); t.oncomplete = () => res(out && 'result' in out ? out.result : true); t.onerror = t.onabort = () => res(null); } catch { res(null); } }); };
async function cachedPng(k) { const r = await tx('readonly', (s) => s.get(k)); return r && r.png ? r.png : null; }
async function keepPng(k, png) { await tx('readwrite', (s) => s.put({ k, png, t: Date.now() })); }
/** Drop the least recently used tiles beyond MAX_TILES. */
async function trim() {
  const n = await tx('readonly', (s) => s.count()); if (!(n > MAX_TILES)) return;
  await tx('readwrite', (s) => { let left = n - MAX_TILES; s.index('t').openCursor().onsuccess = (e) => { const c = e.target.result; if (c && left-- > 0) { c.delete(); c.continue(); } }; });
}
/** How many tiles the cache holds (for the page's note). */
export const cachedTileCount = async () => (await tx('readonly', (s) => s.count())) || 0;

/** Decode a Terrarium PNG (Blob) to elevations in metres (Float32Array of 256 * 256). */
async function decode(blob) {
  // no colour management and no alpha premultiplication: the bytes are numbers, not colours
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE) : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data, e = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < e.length; i++) e[i] = terrariumElevation(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
  if (bmp.close) bmp.close();
  return e;
}
const stats = { fromCache: 0, fetched: 0 };
/** One Terrarium tile as elevations in metres: from the IndexedDB cache, else fetched (and then cached). */
export async function fetchTile(z, x, y, signal) {
  const k = `${z}/${x}/${y}`, hit = await cachedPng(k);
  if (hit) { try { const e = await decode(hit); stats.fromCache++; return e; } catch { /* a broken entry: fetch it again */ } }
  const r = await fetch(TILE_URL(z, x, y), { signal, mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob(), e = await decode(blob); stats.fetched++;
  keepPng(k, blob);
  return e;
}

/**
 * The horizon of a place: from the cache, else computed from tiles (and then cached).
 * opts: eye (m above the ground, default 2), elev (the site's stated elevation, m: the eye is above it when it is
 * higher than the tiles' ground), onProgress(done, total), signal, force.
 * Resolves to { alt (Float32Array, degrees), step, n, ground, eye, maxDist, tiles, tilesFailed, fromCache, cached, ms }.
 */
export async function loadHorizon(lat, lon, { onProgress, signal, force, eye = 2, elev = null } = {}) {
  const el = Number.isFinite(elev) && elev > 0 ? elev : null;
  if (!force) { const c = cachedHorizon(lat, lon, eye, el); if (c) return c; }
  const t0 = performance.now(), s0 = { ...stats };
  const memo = new Map(), get = (z, x, y) => { const k = `${z}/${x}/${y}`; if (!memo.has(k)) memo.set(k, fetchTile(z, x, y, signal)); return memo.get(k); };     // the tile under the observer is asked for twice
  const p = await horizonProfile(lat, lon, get, { onProgress, eye, elev: el });
  p.ms = performance.now() - t0; p.fromCache = stats.fromCache - s0.fromCache; p.fetchedTiles = stats.fetched - s0.fetched;
  // a profile with holes is shown but not kept, so that a later visit tries again
  if (!p.tilesFailed) store(lat, lon, eye, el, p);
  trim();
  return p;
}
export const tileCount = (lat, lon) => tilesNeeded(lat, lon).length;
