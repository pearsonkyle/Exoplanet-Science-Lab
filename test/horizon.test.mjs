// The terrain horizon (src/core/horizon.js) against peaks of known position and height seen from three places, and
// over the whole circle from Kitt Peak and Mauna Kea against an independent Python implementation (see below):
// Mauna Kea from Hilo, Mount Wrightson from Tucson, Mont Blanc from Geneva. The expected bearing, distance and
// elevation angle of each summit come from WGS84 geodesy in astropy (test/data/terrain/make_reference.py), not from
// the tiles. The tiles are fixtures of the real Terrarium tiles (test/data/terrain/, written by make_fixtures.mjs:
// only the sector toward each peak, elevations rounded to 1 m), so nothing is fetched here.
import { readFileSync, readdirSync } from 'node:fs';
import * as H from '../src/core/horizon.js';
import { unpackTile } from './data/terrain/tiles.mjs';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const dir = new URL('./data/terrain/', import.meta.url), sites = JSON.parse(readFileSync(new URL('sites.json', dir))).sites, ref = JSON.parse(readFileSync(new URL('reference.json', dir)));
const tiles = new Map();
for (const f of readdirSync(dir)) { const m = /^(\d+)-(\d+)-(\d+)\.i16\.gz$/.exec(f); if (m) tiles.set(H.tileKey(+m[1], +m[2], +m[3]), unpackTile(readFileSync(new URL(f, dir)))); }
const getTile = async (z, x, y) => tiles.get(H.tileKey(z, x, y)) || null;
const SECTOR = 3;

// --- pieces with exact answers
{
  const t = H.tileXY(0, 0, 1); check('tile coordinates of (0, 0) at zoom 1', Math.abs(t.x - 1) < 1e-12 && Math.abs(t.y - 1) < 1e-12);
  const g = H.tileXY(46.2074, 6.1559, 12); check('tile of Geneva at zoom 12 is 2118/1453', Math.floor(g.x) === 2118 && Math.floor(g.y) === 1453);
  check('Terrarium encoding', H.terrariumElevation(128, 0, 0) === 0 && H.terrariumElevation(144, 110, 128) === 4206.5);
  const d = H.destination(0, 0, 90, H.EARTH_RADIUS_M * Math.PI / 2); check('a quarter of the equator east', Math.abs(d.lat) < 1e-9 && Math.abs(d.lon - 90) < 1e-9);
  const p = H.destination(10, 20, 0, H.EARTH_RADIUS_M * Math.PI / 180); check('one degree north', Math.abs(p.lat - 11) < 1e-9 && Math.abs(p.lon - 20) < 1e-9);
  // sea horizon: dip = acos(Re / (Re + h)) with Re = R / (1 - k); for 100 m and k = 0.13 that is 0.2996 deg (1.76' sqrt(h) x sqrt(1 - k))
  const Re = H.EARTH_RADIUS_M / 0.87, dip = Math.acos(Re / (Re + 100)) * 180 / Math.PI;
  let best = -90; for (let x = 1000; x < 80000; x += 50) best = Math.max(best, H.elevationAngle(100, 0, x));
  check('dip of a sea horizon from 100 m', Math.abs(best + dip) < 1e-5, `${(-best).toFixed(4)} deg, closed form ${dip.toFixed(4)}`);
  check('elevation angle without curvature at short range', Math.abs(H.elevationAngle(0, 100, 1000, 0) - Math.atan(0.1) * 180 / Math.PI) < 0.005);
  // a flat sea of tiles: the horizon of an eye 2 m up is the dip, the same in every direction
  const sea = new Map(H.tilesNeeded(10, 10, { azFrom: 0, azTo: 10 }).map(([z, x, y]) => [H.tileKey(z, x, y), new Int16Array(65536)]));
  const f = H.horizonFromTiles(10, 10, sea, { azFrom: 0, azTo: 10 }), want = -Math.acos(Re / (Re + 2)) * 180 / Math.PI;
  check('flat sea: horizon is the dip of the eye height', Math.max(...f.alt) - Math.min(...f.alt) < 2e-3 && Math.abs(f.alt[0] - want) < 2e-3, `${f.alt[0].toFixed(4)} deg, closed form ${want.toFixed(4)}`);
  // the same sea from 4000 m: its horizon is 242 km away, past the end of the march (150 km), and must still be the dip
  const hi = H.horizonFromTiles(10, 10, sea, { azFrom: 0, azTo: 10, ground: 4000 }), wantHi = -Math.acos(Re / (Re + 4002)) * 180 / Math.PI;
  check('sea horizon beyond the march, from 4000 m', Math.abs(hi.alt[0] - wantHi) < 1e-4 && Math.abs(hi.dist[0] - Math.sqrt(2 * Re * 4002)) < 1, `${hi.alt[0].toFixed(4)} deg, closed form ${wantHi.toFixed(4)}; at 150 km the sea is ${H.elevationAngle(4002, 0, 150000).toFixed(3)} deg`);
  // high latitudes use one zoom less, so that the number of tiles does not grow as 1 / cos^2(latitude)
  const nEq = H.tilesNeeded(0.3, 10).length, n46 = H.tilesNeeded(46.2, 6.2).length, n70 = H.tilesNeeded(69.65, 18.96).length;
  check('tiles for a whole horizon to 300 km: equator, 46 and 70 degrees', nEq < 50 && n46 < 70 && n70 < 75 && H.bandsFor(59)[0][0] === 13 && H.bandsFor(61)[0][0] === 12 && H.bandsFor(80)[0][0] === 11, `${nEq}, ${n46}, ${n70} tiles; to 150 km: ${H.tilesNeeded(0.3, 10, { maxDist: 150000 }).length}, ${H.tilesNeeded(46.2, 6.2, { maxDist: 150000 }).length}, ${H.tilesNeeded(69.65, 18.96, { maxDist: 150000 }).length}`);
  // how far the march goes: the sea horizon of the eye plus 100 km, 150 to 300 km
  check('march length: 150 km from sea level, sea horizon + 100 km from a mountain, 300 km at most', H.radiusFor(2) === 150000 && Math.abs(H.radiusFor(2122) - (Math.sqrt(2 * Re * 2122) + 1e5)) < 1e-6 && H.radiusFor(4207) === 300000, `from 2122 m (Kitt Peak): ${(H.radiusFor(2122) / 1000).toFixed(0)} km; from 4207 m: ${(H.radiusFor(4207) / 1000).toFixed(0)} km`);
  // a synthetic hill on that sea: a Gaussian 1000 m high with sigma 1.5 km, 20 km due north
  const cone = new Map(); const c = H.destination(10, 10, 0, 20000);
  for (const [z, x, y] of H.tilesNeeded(10, 10, { azFrom: -3, azTo: 3 })) {
    const a = new Float32Array(65536), n = 2 ** z;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const lon = (x + (i + 0.5) / 256) / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (j + 0.5) / 256) / n))) * 180 / Math.PI;
      const dx = (lon - c.lon) * Math.cos(lat * Math.PI / 180) * 111195, dy = (lat - c.lat) * 111195; a[j * 256 + i] = 1000 * Math.exp(-(dx * dx + dy * dy) / (2 * 1500 * 1500));
    }
    cone.set(H.tileKey(z, x, y), a);
  }
  const pc = H.horizonFromTiles(10, 10, cone, { azFrom: -3, azTo: 3 }), i0 = pc.alt.indexOf(Math.max(...pc.alt)), wantC = H.elevationAngle(2, 1000, 20000);
  check('synthetic hill 20 km north: bearing and height of its top', Math.abs(pc.azFrom + i0 * pc.step) < 0.01 && Math.abs(pc.alt[i0] - wantC) < 0.01, `top at az ${(pc.azFrom + i0 * pc.step).toFixed(1)}, ${pc.alt[i0].toFixed(4)} deg, expected ${wantC.toFixed(4)}`);
}

// --- real skylines
for (const s of sites) {
  const r = ref.sites[s.id], b = Math.round(r.bearing * 2) / 2;
  const need = H.tilesNeeded(s.lat, s.lon, { azFrom: b - SECTOR, azTo: b + SECTOR });
  check(`${s.id}: every tile of the sector is a fixture`, need.every(([z, x, y]) => tiles.has(H.tileKey(z, x, y))), `${need.length} tiles`);
  const p = await H.horizonProfile(s.lat, s.lon, getTile, { azFrom: b - SECTOR, azTo: b + SECTOR });
  check(`${s.id}: no sample fell outside the fixtures`, p.missing === 0 && p.tilesFailed === 0, `${p.samples} samples`);
  check(`${s.id}: ground at the viewpoint`, Math.abs(p.ground - s.height) < 25, `tiles ${p.ground.toFixed(0)} m, published ${s.height} m`);
  // the summit: the highest point of the profile within 1.5 deg of the expected bearing
  let im = -1; for (let i = 0; i < p.n; i++) { const az = p.azFrom + i * p.step; if (Math.abs(az - r.bearing) <= 1.5 && (im < 0 || p.alt[i] > p.alt[im])) im = i; }
  const az = p.azFrom + im * p.step, at = p.alt[Math.round((r.bearing - p.azFrom) / p.step)];
  console.log(`     ${s.peak.name} from ${s.name}: expected bearing ${r.bearing.toFixed(2)}, distance ${(r.distance / 1000).toFixed(1)} km, apparent elevation ${r.apparent.toFixed(3)} deg`);
  console.log(`     profile: top at ${az.toFixed(1)} deg, ${p.alt[im].toFixed(3)} deg, made by ground at ${(p.dist[im] / 1000).toFixed(1)} km and ${p.elev[im].toFixed(0)} m (summit ${s.peak.height} m); at the expected bearing ${at.toFixed(3)} deg`);
  check(`${s.id}: the skyline toward ${s.peak.name} is the mountain itself`, Math.abs(p.dist[im] - r.distance) < 0.06 * r.distance, `skyline ${(p.dist[im] / 1000).toFixed(1)} km away, summit ${(r.distance / 1000).toFixed(1)} km`);
  check(`${s.id}: bearing of the top`, Math.abs(az - r.bearing) <= 0.75, `${(az - r.bearing).toFixed(2)} deg from the summit's bearing (profile step ${p.step} deg)`);
  check(`${s.id}: elevation angle of the top`, Math.abs(p.alt[im] - r.apparent) < 0.15, `${(p.alt[im] - r.apparent >= 0 ? '+' : '') + (p.alt[im] - r.apparent).toFixed(3)} deg against the summit from its coordinates`);
}
// --- the whole circle from two observatories against an independent implementation in Python (full/make_reference.py:
// WGS84 geodesics, Pillow, ECEF vectors, sampling across tile edges), on the same tiles ("same") and on tiles one zoom
// finer everywhere ("fine": what the coarser zooms of the browser's pyramid lose). Fixtures: full/<site>/.
{
  const fdir = new URL('./data/terrain/full/', import.meta.url), fsites = JSON.parse(readFileSync(new URL('sites.json', fdir))).sites;
  const fref = JSON.parse(readFileSync(new URL('reference.json', fdir))), fjs = JSON.parse(readFileSync(new URL('js_profiles.json', fdir)));
  const stats = (a, b) => { const d = Array.from(a, (v, i) => v - b[i]), ab = d.map(Math.abs).sort((x, y) => x - y); return { max: ab[ab.length - 1], rms: Math.sqrt(d.reduce((t, v) => t + v * v, 0) / d.length), mean: d.reduce((t, v) => t + v, 0) / d.length, p95: ab[Math.floor(0.95 * ab.length)] }; };
  const txt = (st) => `rms ${st.rms.toFixed(3)}°, 95% within ${st.p95.toFixed(3)}°, max ${st.max.toFixed(3)}°, mean ${st.mean >= 0 ? '+' : ''}${st.mean.toFixed(3)}°`;
  for (const s of fsites) {
    const ft = new Map(); for (const f of readdirSync(new URL(s.id + '/', fdir))) { const m = /^(\d+)-(\d+)-(\d+)\.i16\.gz$/.exec(f); if (m) ft.set(H.tileKey(+m[1], +m[2], +m[3]), unpackTile(readFileSync(new URL(`${s.id}/${f}`, fdir)))); }
    const p = await H.horizonProfile(s.lat, s.lon, async (z, x, y) => ft.get(H.tileKey(z, x, y)) || null, { eye: s.eye, elev: s.elev, step: s.step });
    const R2 = fref.sites[s.id], same = stats(p.alt, R2.same.alt), fine = stats(p.alt, R2.fine.alt), v1 = stats(fjs.sites[s.id].v1, R2.fine.alt);
    check(`${s.name}: whole circle from the fixtures, nothing missing`, p.missing === 0 && p.tilesFailed === 0 && p.n === R2.same.alt.length, `${p.tiles} tiles, march ${(p.maxDist / 1000).toFixed(0)} km (Python: ${(R2.same.maxDist / 1000).toFixed(0)} km), eye at ${(p.ground + p.eye).toFixed(0)} m; horizon ${Math.min(...p.alt).toFixed(2)}° to ${Math.max(...p.alt).toFixed(2)}°`);
    check(`${s.name}: against the Python reference on the same tiles`, same.rms < 0.04 && same.max < 0.15, txt(same));
    check(`${s.name}: against the Python reference one zoom finer`, fine.rms < 0.06 && fine.p95 < 0.1, txt(fine));
    check(`${s.name}: closer to the finer reference than the earlier method (zoom 12 to 6 km, 150 km)`, fine.rms < v1.rms, `earlier: ${txt(v1)}`);
  }
}

// --- interpolation and failure
{
  const prof = { azFrom: 0, step: 90, n: 4, alt: Float32Array.from([0, 2, 4, 2]) };
  check('horizonAt interpolates and wraps', H.horizonAt(prof, 45) === 1 && H.horizonAt(prof, 315) === 1 && H.horizonAt(prof, -90) === 2 && H.horizonAt(prof, 720) === 0);
  let threw = false; try { await H.horizonProfile(0, 0, async () => { throw new Error('offline'); }, { azFrom: 0, azTo: 2 }); } catch { threw = true; }
  check('no tiles at all: rejects (the page keeps the flat horizon)', threw);
  const some = await H.horizonProfile(sites[0].lat, sites[0].lon, async (z, x, y) => (z === 12 ? getTile(z, x, y) : null), { azFrom: 280, azTo: 284 });
  check('some tiles missing: a profile from what there is, with the gap counted', some.missing > 0 && some.tilesFailed > 0 && Number.isFinite(some.alt[0]));
}
console.log(ok ? '\nhorizon: all passed' : '\nhorizon: FAILED'); process.exit(ok ? 0 : 1);
