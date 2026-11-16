// Fixtures for the whole-circle check of test/horizon.test.mjs: every Terrarium tile that the profile of two
// observatories needs (Kitt Peak, Mauna Kea), as compact fixtures (../tiles.mjs) that keep only the pixels the
// profile reads. The PNGs are kept in a cache folder for the Python reference (make_reference.py, which decodes them
// itself). Also writes js_profiles.json: the profile with the pyramid of horizon.js and with the earlier one
// (BANDS_V1, 150 km; its tiles are not kept as fixtures), for the record.
//   node test/data/terrain/full/make_fixtures.mjs [cache folder, default $TMPDIR/esl-terrain-cache]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { horizonProfile, TILE_URL, BANDS_V1 } from '../../../../src/core/horizon.js';
import { elevationsFromPng, packTile } from '../tiles.mjs';
const here = new URL('./', import.meta.url), cache = process.argv[2] || (process.env.TMPDIR || '/tmp') + '/esl-terrain-cache';
const sites = JSON.parse(readFileSync(new URL('sites.json', here))).sites;
async function png(z, x, y) {
  const f = `${cache}/${z}-${x}-${y}.png`;
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(TILE_URL(z, x, y)); if (!r.ok) throw new Error(`${z}/${x}/${y}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer()); mkdirSync(cache, { recursive: true }); writeFileSync(f, b); return b;
}
const out = { about: 'Profiles of src/core/horizon.js from the tiles of this folder: "pyramid" with the default bands and march length, "v1" with BANDS_V1 to 150 km (the method before 2026-11-15).', sites: {} };
for (const s of sites) {
  const used = new Map(), elev = new Map();
  // every read of a tile goes through a Proxy that notes the pixel, so that only those are kept
  const getTile = async (z, x, y) => {
    const k = `${z}-${x}-${y}`;
    if (!elev.has(k)) { elev.set(k, elevationsFromPng(await png(z, x, y))); used.set(k, new Uint8Array(65536)); }
    const e = elev.get(k), u = used.get(k);
    return new Proxy(e, { get(a, p) { if (typeof p === 'string' && p.charCodeAt(0) < 58) u[+p] = 1; return a[p]; } });
  };
  // the earlier method first; then only what the present one reads is kept
  const v1 = await horizonProfile(s.lat, s.lon, getTile, { eye: s.eye, elev: s.elev, step: s.step, bands: BANDS_V1, maxDist: 150000 });
  for (const u of used.values()) u.fill(0);
  const p = await horizonProfile(s.lat, s.lon, getTile, { eye: s.eye, elev: s.elev, step: s.step });
  const keep = [];
  mkdirSync(new URL(s.id + '/', here), { recursive: true });
  let bytes = 0;
  for (const [k, e] of elev) {
    const u = used.get(k); if (!u.some((x) => x)) continue;
    // a pixel that is never read takes the value of the one before it in its row: runs of zero differences compress well
    const c = new Float32Array(65536); for (let i = 0; i < 65536; i++) c[i] = u[i] ? e[i] : i % 256 ? c[i - 1] : 0;
    const packed = packTile(c);
    writeFileSync(new URL(`${s.id}/${k}.i16.gz`, here), packed); bytes += packed.length; keep.push(k);
  }
  out.sites[s.id] = { ground: p.ground, maxDist: p.maxDist, tiles: keep.sort(), step: p.step, pyramid: Array.from(p.alt, (v) => +v.toFixed(4)), v1: Array.from(v1.alt, (v) => +v.toFixed(4)), v1Tiles: v1.tiles, pyramidTiles: p.tiles };
  console.log(s.id, `ground ${p.ground.toFixed(1)} m, march ${(p.maxDist / 1000).toFixed(0)} km, ${p.tiles} tiles (v1: ${v1.tiles}), ${keep.length} fixtures, ${bytes} bytes`);
}
writeFileSync(new URL('js_profiles.json', here), JSON.stringify(out));
