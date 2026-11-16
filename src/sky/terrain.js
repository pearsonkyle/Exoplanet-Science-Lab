// The terrain horizon in the browser: fetches and decodes the elevation tiles that src/core/horizon.js asks for and
// keeps the resulting profile in localStorage, one entry per place (rounded to 0.001 degree, about 100 m).
// Nothing here runs until the Terrain layer is switched on. Offline, or when the tiles cannot be had, the promise
// rejects and the page keeps its flat horizon.
import { horizonProfile, tilesNeeded, terrariumElevation, TILE_URL, TILE_SIZE, ATTRIBUTION } from '../core/horizon.js';

export { ATTRIBUTION };
const KEY = 'esl.sky.horizon.v1', MAX_ENTRIES = 8;
const placeKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
const readAll = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

/** The cached profile of a place, or null. */
export function cachedHorizon(lat, lon) {
  const e = readAll()[placeKey(lat, lon)];
  return e && Array.isArray(e.alt) ? { ...e, alt: Float32Array.from(e.alt, (v) => v / 100), cached: true } : null;
}
function store(lat, lon, p) {
  const all = readAll(); all[placeKey(lat, lon)] = { t: Date.now(), step: p.step, azFrom: p.azFrom, n: p.n, ground: Math.round(p.ground), tiles: p.tiles, tilesFailed: p.tilesFailed, alt: Array.from(p.alt, (v) => Math.round(v * 100)) };
  const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
  for (const k of keys.slice(MAX_ENTRIES)) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the profile is still used for this visit */ }
}

/** Fetch one Terrarium tile and decode it to elevations in metres (Float32Array of 256 * 256). */
export async function fetchTile(z, x, y, signal) {
  const r = await fetch(TILE_URL(z, x, y), { signal, mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // no colour management and no alpha premultiplication: the bytes are numbers, not colours
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE) : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data, e = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < e.length; i++) e[i] = terrariumElevation(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
  if (bmp.close) bmp.close();
  return e;
}

/**
 * The horizon of a place: from the cache, else computed from tiles (and then cached).
 * Resolves to { alt (Float32Array, degrees), step, n, ground, tiles, tilesFailed, cached, ms }. onProgress(done, total).
 */
export async function loadHorizon(lat, lon, { onProgress, signal, force } = {}) {
  if (!force) { const c = cachedHorizon(lat, lon); if (c) return c; }
  const t0 = performance.now();
  const p = await horizonProfile(lat, lon, (z, x, y) => fetchTile(z, x, y, signal), { onProgress });
  p.ms = performance.now() - t0;
  // a profile with holes is shown but not kept, so that a later visit tries again
  if (!p.tilesFailed) store(lat, lon, p);
  return p;
}
export const tileCount = (lat, lon) => tilesNeeded(lat, lon).length;
