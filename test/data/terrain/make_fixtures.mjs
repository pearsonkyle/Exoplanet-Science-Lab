// Downloads the Terrarium tiles that test/horizon.test.mjs needs (a sector of +-SECTOR degrees around the bearing of
// each peak) and writes them as compact fixtures (see tiles.mjs). To keep them small, the pixels that the profile of
// that sector never reads are set to zero: the fixtures are the real tiles inside the wedge and blank outside it.
//   node test/data/terrain/make_fixtures.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { tilesNeeded, horizonFromTiles, tileKey, TILE_URL } from '../../../src/core/horizon.js';
import { elevationsFromPng, packTile } from './tiles.mjs';
export const SECTOR = 3;
const here = new URL('./', import.meta.url), sites = JSON.parse(readFileSync(new URL('sites.json', here))).sites, ref = JSON.parse(readFileSync(new URL('reference.json', here)));
let n = 0, bytes = 0, png = 0;
for (const s of sites) {
  const b = Math.round(ref.sites[s.id].bearing * 2) / 2;
  const got = [];
  for (const [z, x, y] of tilesNeeded(s.lat, s.lon, { azFrom: b - SECTOR, azTo: b + SECTOR })) {
    const r = await fetch(TILE_URL(z, x, y)); if (!r.ok) throw new Error(`${z}/${x}/${y}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer()); png += buf.length;
    got.push({ z, x, y, elev: elevationsFromPng(buf), used: new Uint8Array(65536) });
  }
  // which pixels does the profile read? (a Proxy that notes every index)
  const spy = new Map(got.map((t) => [tileKey(t.z, t.x, t.y), new Proxy(t.elev, { get(a, k) { if (typeof k === 'string' && k.charCodeAt(0) < 58) t.used[+k] = 1; return a[k]; } })]));
  horizonFromTiles(s.lat, s.lon, spy, { azFrom: b - SECTOR, azTo: b + SECTOR });
  for (const t of got) {
    for (let i = 0; i < 65536; i++) if (!t.used[i]) t.elev[i] = 0;
    const packed = packTile(t.elev); writeFileSync(new URL(`${t.z}-${t.x}-${t.y}.i16.gz`, here), packed); n++; bytes += packed.length;
    console.log(s.id, `${t.z}/${t.x}/${t.y}`, '->', packed.length, 'bytes,', t.used.reduce((a, v) => a + v, 0), 'pixels kept');
  }
}
console.log(`${n} tiles, ${bytes} bytes (PNG: ${png})`);
