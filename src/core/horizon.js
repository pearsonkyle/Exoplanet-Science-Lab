// The apparent horizon of a place from terrain elevation tiles: for every azimuth, the highest elevation angle of
// the ground along that bearing, with the curvature of the Earth and terrestrial refraction. No DOM, no three.js:
// the caller supplies getTile(z, x, y) (the browser decodes PNGs in src/sky/terrain.js, the test reads fixtures).
//
// Data: "Terrarium" tiles of the Mapzen / Tilezen terrain tiles hosted in the AWS Open Data registry
// (https://registry.opendata.aws/terrain-tiles/). Web-Mercator XYZ tiles of 256 x 256 pixels,
// elevation [m] = R * 256 + G + B / 256 - 32768. The sources behind them (SRTM, 3DEP, EU-DEM, GMTED2010, ETOPO1,
// ...) and the attribution they require are in ATTRIBUTION below, from
// https://github.com/tilezen/joerd/blob/master/docs/attribution.md.
//
// Method
//   A ray leaves the observer along each azimuth on a great circle of a spherical Earth (radius 6371.0088 km; the
//   ellipsoid changes distances by at most 0.3%). Elevations are read bilinearly from a pyramid of zooms (BANDS):
//   fine tiles near the observer (zoom 13, 16 m pixels at 30 degrees latitude, out to 3 km), coarse ones far away,
//   so a profile needs some tens of tiles. The step is half a pixel of the zoom in use or 0.8% of the distance,
//   whichever is larger.
//   How far: the distance at which a sea-level horizon lies from the eye, plus 100 km for the mountains beyond it,
//   at least 150 km and at most 300 km (radiusFor): 150 km from the plains, 275 km from Kitt Peak (2100 m), 300 km
//   from Mauna Kea (4200 m), where the farther ground (Haleakala, 150 km from it) still shows.
//   The elevation angle of a point of height h at ground distance d seen from height h0 is that of a straight ray
//   over an Earth of radius Re = R / (1 - k):  atan2((Re + h) cos(d / Re) - (Re + h0), (Re + h) sin(d / Re)).
//   k = 0.13 is the standard coefficient of terrestrial refraction (rays curve with 1/7.7 of the Earth's curvature);
//   it varies with the weather (0.1 to 0.2 by day, more over cold ground), which moves a ridge 100 km away by
//   about 0.03 deg.
//   The observer stands `eye` metres (2 by default; the Observe page lets it be set) above the terrain at the
//   place, or above `ground` when that is given, or above `elev` (the published elevation of an observatory) when
//   that is higher than the tiles' ground: observatory coordinates are rounded, and a point 50 m off a summit can sit
//   on its slope, where the summit itself makes a 20-degree horizon (Kitt Peak at the planner's 31.96333, -111.6:
//   the tiles give 2059 m, the site 2120 m). Sea floor in the tiles is raised to sea level (or to the
//   observer's level if that is below the sea). Beyond the end of the march the profile is never taken lower than
//   the dip of a sea-level horizon, -acos(Re / (Re + h0)).
// What it is not: buildings and trees are not in the data (SRTM is a radar surface, so forest partly is), and the
// nearest few pixels (30 m each at zoom 12 on the equator) cannot show a wall or a house next to the observer.
// Checked in test/horizon.test.mjs against peaks of known position and height, and over the whole circle against an
// independent implementation in Python (WGS84 geodesics, its own PNG decoding and sampling; test/data/terrain/full/).

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
export const EARTH_RADIUS_M = 6371008.8;
export const TILE_SIZE = 256;
export const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
/** Elevation in metres of a Terrarium pixel. */
export const terrariumElevation = (r, g, b) => r * 256 + g + b / 256 - 32768;
/** Zoom pyramid: [zoom, used out to this ground distance in metres]; a profile stops at maxDist (radiusFor). */
export const BANDS = [[13, 3000], [12, 8000], [10, 30000], [9, 75000], [8, 150000], [7, 300000]];
/** The pyramid before 2026-11-15 (zoom 12 to 6 km, then 10, 9, 8 to 150 km), for comparisons. */
export const BANDS_V1 = [[12, 6000], [10, 30000], [9, 75000], [8, 150000]];
/**
 * How far a profile marches for an eye at height h0 metres above sea level: the distance of the sea horizon
 * sqrt(2 Re h0) (Re with refraction) plus 100 km, within 150 to 300 km.
 */
export const radiusFor = (h0, k = 0.13) => Math.max(150000, Math.min(300000, Math.sqrt(2 * (EARTH_RADIUS_M / (1 - k)) * Math.max(0, h0)) + 100000));
/**
 * The pyramid for a latitude: Mercator pixels shrink with cos(latitude), so beyond 60 degrees one zoom less (two
 * beyond 75.5) gives the same ground resolution with a quarter of the tiles.
 */
export const bandsFor = (lat, bands = BANDS) => { const dz = Math.max(0, Math.floor(Math.log2(1 / Math.max(0.05, Math.cos(lat * RAD))))); return bands.map(([z, d]) => [Math.max(0, z - dz), d]); };
export const DEFAULTS = { step: 0.5, bands: null, k: 0.13, eye: 2, minDist: 60, azFrom: 0, azTo: 360, maxDist: null, elev: null };
// the bands cut at maxDist (when given; else they run to their last distance)
const options = (lat, opts) => {
  const o = { ...DEFAULTS, ...opts }; let b = o.bands || bandsFor(lat);
  if (o.maxDist > 0) { const cut = []; for (const [z, d] of b) { cut.push([z, Math.min(d, o.maxDist)]); if (d >= o.maxDist) break; } b = cut; }
  o.bands = b; return o;
};

export const ATTRIBUTION = {
  short: 'Terrain: Mapzen / Tilezen terrain tiles (AWS Open Data); SRTM, 3DEP and GMTED2010 courtesy of the U.S. Geological Survey, and others',
  url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  lines: [
    'Mapzen',
    'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736',
    'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017',
    'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich',
    'Canada terrain data contains information licensed under the Open Government Licence – Canada',
    'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers',
    'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
    'Mexico terrain data source: INEGI, Continental relief, 2016',
    'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)',
    'Norway terrain data © Kartverket',
    'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved',
    'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey',
  ],
};

/** Fractional Web-Mercator tile coordinates of a latitude and longitude in degrees at zoom z. */
export function tileXY(lat, lon, z) {
  const n = 2 ** z, s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * RAD);
  return { x: ((((lon + 180) / 360) % 1) + 1) % 1 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}
/** Ground size in metres of a pixel at zoom z and latitude (degrees). */
export const pixelSize = (lat, z) => 2 * Math.PI * 6378137 * Math.cos(lat * RAD) / (TILE_SIZE * 2 ** z);
/** The point reached from (lat, lon) after `dist` metres along the great circle of initial azimuth az (degrees). */
export function destination(lat, lon, az, dist) {
  const p = lat * RAD, d = dist / EARTH_RADIUS_M, a = az * RAD, sp = Math.sin(p), cp = Math.cos(p), sd = Math.sin(d), cd = Math.cos(d);
  const s2 = sp * cd + cp * sd * Math.cos(a);
  return { lat: Math.asin(Math.max(-1, Math.min(1, s2))) * DEG, lon: lon + Math.atan2(Math.sin(a) * sd * cp, cd - sp * s2) * DEG };
}
/** Apparent elevation angle (degrees) of a point of height h at ground distance d from an eye at height h0 (metres). */
export function elevationAngle(h0, h, d, k = 0.13) {
  const Re = EARTH_RADIUS_M / (1 - k), t = d / Re;
  return Math.atan2((Re + h) * Math.cos(t) - (Re + h0), (Re + h) * Math.sin(t)) * DEG;
}

const key = (z, x, y) => (z * 16384 + x) * 16384 + y;       // zooms up to 14 (16384 tiles a side); exact below 2^53
export const tileKey = key;
const zoomAt = (bands, d) => { for (const b of bands) if (d <= b[1]) return b[0]; return bands[bands.length - 1][0]; };

// The sample distances of one ray: the same for every azimuth, apart from the pixel size at the observer's latitude.
function distances(lat, o) {
  const out = [], max = o.bands[o.bands.length - 1][1];
  for (let d = o.minDist; d <= max;) { const z = zoomAt(o.bands, d); out.push([d, z]); d += Math.max(0.5 * pixelSize(lat, z), 0.008 * d); }
  return out;
}
const azimuths = (o) => { const n = Math.round((o.azTo - o.azFrom) / o.step) + (o.azTo - o.azFrom >= 360 ? 0 : 1), out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = o.azFrom + i * o.step; return out; };

/** The tiles a profile needs: [[z, x, y], ...], nearest zoom first. */
export function tilesNeeded(lat, lon, opts = {}) {
  const o = options(lat, opts), seen = new Set(), out = [], dist = distances(lat, o);
  const add = (z, la, lo) => { const t = tileXY(la, lo, z), x = Math.floor(t.x), y = Math.floor(t.y), k = key(z, x, y); if (!seen.has(k)) { seen.add(k); out.push([z, x, y]); } };
  add(o.bands[0][0], lat, lon);
  for (const az of azimuths(o)) for (const [d, z] of dist) { const p = destination(lat, lon, az, d); add(z, p.lat, p.lon); }
  return out.sort((a, b) => b[0] - a[0]);
}

/**
 * The horizon profile. tiles: Map(tileKey(z, x, y) -> Float32Array or Int16Array of 256 * 256 elevations in metres,
 * row by row from the north-west corner); a missing tile is skipped and counted.
 * Returns { lat, lon, step, azFrom, n, alt: Float32Array (degrees, apparent), dist: Float32Array (m, to the point
 * that makes the horizon), elev: Float32Array (its elevation, m), ground: elevation at the observer (m),
 * eye: height of the eye (m), samples, missing: number of samples that fell on a missing tile }.
 */
export function horizonFromTiles(lat, lon, tiles, opts = {}) {
  const o = options(lat, opts), dist = distances(lat, o), azs = azimuths(o), n = azs.length;
  let missing = 0, samples = 0;
  // a tile that could not be had is replaced by a coarser zoom of the pyramid that covers the same place, if loaded
  const zooms = [...new Set(o.bands.map((b) => b[0]))].sort((a, b) => b - a);
  const one = (z, la, lo) => { const t = tileXY(la, lo, z); return elevationAt(la, lo, z, tiles.get(key(z, Math.floor(t.x), Math.floor(t.y)))); };
  const sample = (z, la, lo) => { let h = one(z, la, lo); if (h === h) return h; for (const z2 of zooms) if (z2 < z && (h = one(z2, la, lo)) === h) return h; return NaN; };
  const here = sample(o.bands[0][0], lat, lon), ground = Number.isFinite(o.ground) ? o.ground : Math.max(Number.isFinite(here) ? here : 0, Number.isFinite(o.elev) ? o.elev : -Infinity);
  const floor = Math.min(0, ground), h0 = Math.max(ground, floor) + o.eye, Re = EARTH_RADIUS_M / (1 - o.k);
  const alt = new Float32Array(n), far = new Float32Array(n), elev = new Float32Array(n);
  // the dip of a horizon at the lowest level there can be ground (sea level): nothing is ever seen below it
  const above = h0 - floor, dipTan = -Math.tan(Math.acos(Re / (Re + above))), dipDist = Math.sqrt(2 * Re * above);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bd = 0, bh = 0;
    for (const [d, z] of dist) {
      const p = destination(lat, lon, azs[i], d); let h = sample(z, p.lat, p.lon); samples++;
      if (!(h === h)) { missing++; continue; }
      if (h < floor) h = floor;
      const t = d / Re, tan = ((Re + h) * Math.cos(t) - (Re + h0)) / ((Re + h) * Math.sin(t));
      if (tan > best) { best = tan; bd = d; bh = h; }
    }
    // nothing sampled along this bearing, or only ground seen from far above that ends before the horizon
    if (best < dipTan) { best = dipTan; bd = dipDist; bh = floor; }
    alt[i] = Math.atan(best) * DEG; far[i] = bd; elev[i] = bh;
  }
  return { lat, lon, step: o.step, azFrom: o.azFrom, n, alt, dist: far, elev, ground, eye: o.eye, k: o.k, samples, missing, maxDist: o.bands[o.bands.length - 1][1] };
}

/** Elevation (m) at a place from one tile's elevations (bilinear), or NaN. */
export function elevationAt(lat, lon, z, data) {
  if (!data) return NaN;
  const t = tileXY(lat, lon, z), tx = Math.floor(t.x), ty = Math.floor(t.y);
  const px = Math.max(0, Math.min(TILE_SIZE - 1, (t.x - tx) * TILE_SIZE - 0.5)), py = Math.max(0, Math.min(TILE_SIZE - 1, (t.y - ty) * TILE_SIZE - 0.5));
  const x0 = Math.min(TILE_SIZE - 2, Math.floor(px)), y0 = Math.min(TILE_SIZE - 2, Math.floor(py)), fx = px - x0, fy = py - y0, i = y0 * TILE_SIZE + x0;
  return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + TILE_SIZE] * (1 - fx) + data[i + TILE_SIZE + 1] * fx) * fy;
}

/**
 * Fetch what is needed and compute the profile. getTile(z, x, y) resolves to the elevations of a tile (see
 * horizonFromTiles) or rejects / resolves to null when it cannot be had. onProgress(done, total) is optional.
 * Unless opts.maxDist is given, the tile under the observer is read first and the march goes as far as
 * radiusFor(its height + eye). Rejects only when no tile at all could be loaded.
 */
export async function horizonProfile(lat, lon, getTile, opts = {}) {
  if (!(opts.maxDist > 0)) {
    const z0 = options(lat, opts).bands[0][0], t = tileXY(lat, lon, z0);
    let d = null; try { d = await getTile(z0, Math.floor(t.x), Math.floor(t.y)); } catch { d = null; }
    const g = Number.isFinite(opts.ground) ? opts.ground : Math.max(elevationAt(lat, lon, z0, d) || 0, Number.isFinite(opts.elev) ? opts.elev : -Infinity);
    opts = { ...opts, maxDist: radiusFor((Number.isFinite(g) ? Math.max(0, g) : 0) + (opts.eye ?? DEFAULTS.eye), opts.k ?? DEFAULTS.k) };
  }
  const need = tilesNeeded(lat, lon, opts), tiles = new Map(), conc = opts.concurrency || 6;
  let next = 0, done = 0, failed = 0;
  const worker = async () => {
    while (next < need.length) {
      const [z, x, y] = need[next++];
      try { const d = await getTile(z, x, y); if (d) tiles.set(key(z, x, y), d); else failed++; } catch { failed++; }
      done++; if (opts.onProgress) opts.onProgress(done, need.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, need.length) }, worker));
  if (!tiles.size) throw new Error('no terrain tiles could be loaded');
  return { ...horizonFromTiles(lat, lon, tiles, opts), tiles: need.length, tilesFailed: failed, maxDist: opts.maxDist };
}

/** Horizon altitude in degrees at an azimuth in degrees, linearly between the samples of a full-circle profile. */
export function horizonAt(profile, azDeg) {
  const x = ((((azDeg - profile.azFrom) / profile.step) % profile.n) + profile.n) % profile.n, i = Math.floor(x), f = x - i;
  return profile.alt[i] * (1 - f) + profile.alt[(i + 1) % profile.n] * f;
}
