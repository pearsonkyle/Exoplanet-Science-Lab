// The survey image of the Observe page: src/core/healpix.js (HEALPix nested, HiPS tiles) against the analytic
// properties of HEALPix (Górski et al. 2005), and src/core/skyfield.js (TAN cells, separation, position angle)
// against astropy.wcs and astropy.coordinates (make_skyfield_reference.py). Every line prints the largest difference.
import { readFileSync } from 'node:fs';
import * as H from '../src/core/healpix.js';
import * as F from '../src/core/skyfield.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./skyfield_reference.json', import.meta.url)));
const D2R = Math.PI / 180, e = (x) => x.toExponential(1);
let seed = 12345; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };     // mulberry32
const randomDir = () => [rnd() * 360, Math.asin(2 * rnd() - 1) / D2R];

// ---- HEALPix
{
  // the 12 base pixels: centres at z = 2/3, 0, -2/3 (dec 41.81, 0, -41.81 deg), phi = 45 + 90 f in the caps, 90 f on the equator
  let d = 0;
  for (let f = 0; f < 12; f++) {
    const [ra, dec] = H.pix2angNest(0, f), r = Math.floor(f / 4), dec0 = [Math.asin(2 / 3), 0, -Math.asin(2 / 3)][r] / D2R, ra0 = r === 1 ? 90 * (f - 4) : 45 + 90 * (f % 4);
    d = Math.max(d, F.separation(ra, dec, ra0, dec0));
  }
  check('base pixel centres (order 0) at the analytic positions', d < 1e-6, `max ${e(d)}″`);
  // every pixel of orders 0..6: its centre is found in it again
  let bad = 0, n = 0;
  for (let k = 0; k <= 6; k++) for (let p = 0; p < H.npixOf(k); p++) { const [ra, dec] = H.pix2angNest(k, p); if (H.ang2pixNest(k, ra, dec) !== p) bad++; n++; }
  check('centre -> pixel round trip, all pixels of orders 0 to 6', bad === 0, `${n} pixels, ${bad} wrong`);
  bad = 0;
  for (const k of [12, 18, 20, 25]) for (let t = 0; t < 5000; t++) { const p = Math.floor(rnd() * H.npixOf(k)), [ra, dec] = H.pix2angNest(k, p); if (H.ang2pixNest(k, ra, dec) !== p) bad++; }
  check('centre -> pixel round trip, 5000 random pixels at orders 12, 18, 20, 25', bad === 0, `${bad} wrong`);
  // the rings: 4n - 1 latitudes, z = 1 - i^2 / 3n^2 in the caps (4 i pixels), 4/3 - 2 i / 3n in the belt (4 n pixels)
  for (const k of [1, 3, 5]) {
    const n = 2 ** k, zs = [];
    for (let p = 0; p < H.npixOf(k); p++) zs.push(Math.sin(H.pix2angNest(k, p)[1] * D2R));
    zs.sort((a, b) => b - a); const rings = new Map(); let cur = null;
    for (const z of zs) { if (cur == null || Math.abs(z - cur) > 1e-10) cur = z; const key = Math.round(cur * 1e7); rings.set(key, (rings.get(key) || 0) + 1); }
    let good = rings.size === 4 * n - 1;
    for (let i = 1; i < 4 * n; i++) {
      const z = i < n ? 1 - i * i / (3 * n * n) : i <= 3 * n ? 4 / 3 - 2 * i / (3 * n) : -(1 - (4 * n - i) ** 2 / (3 * n * n)), want = i < n ? 4 * i : i <= 3 * n ? 4 * n : 4 * (4 * n - i);
      if (rings.get(Math.round(z * 1e7)) !== want) good = false;
    }
    check(`rings of order ${k}: latitudes and pixel counts as in Górski et al. (2005)`, good, `${rings.size} rings`);
  }
  // nesting: the parent of a pixel is the pixel one order up
  bad = 0; for (let t = 0; t < 20000; t++) { const [ra, dec] = randomDir(), k = 1 + Math.floor(rnd() * 22); if (Math.floor(H.ang2pixNest(k, ra, dec) / 4) !== H.ang2pixNest(k - 1, ra, dec)) bad++; }
  check('hierarchy: pixel(k) / 4 = pixel(k - 1), 20000 random directions and orders', bad === 0, `${bad} wrong`);
  // equal areas: 768 000 uniform directions in the 192 pixels of order 2
  const cnt = new Float64Array(192), M = 768000; for (let t = 0; t < M; t++) { const [ra, dec] = randomDir(); cnt[H.ang2pixNest(2, ra, dec)]++; }
  let chi2 = 0; for (const c of cnt) chi2 += (c - M / 192) ** 2 / (M / 192);
  check('equal areas: chi-square of 768000 uniform directions over the 192 pixels of order 2', chi2 < 191 + 5 * Math.sqrt(2 * 191), `chi2 ${chi2.toFixed(0)} for 191 degrees of freedom`);
  // a direction is near the centre of its pixel: within 0.75 pixel sizes (the largest centre-to-corner distance)
  let far = 0; for (let t = 0; t < 20000; t++) { const [ra, dec] = randomDir(), k = 8, [r2, d2] = H.pix2angNest(k, H.ang2pixNest(k, ra, dec)); far = Math.max(far, F.separation(ra, dec, r2, d2) / H.pixelSizeArcsec(k)); }
  check('a direction lies within its pixel (distance to the centre, order 8)', far < 1.0, `max ${far.toFixed(3)} pixel sizes`);
  // HiPS: the tile and the pixel in it are the upper and lower bits of the pixel at order k + 9
  bad = 0;
  for (let t = 0; t < 20000; t++) {
    const [ra, dec] = randomDir(), k = 3 + Math.floor(rnd() * 9), L = H.hipsLocate(k, 512, ra, dec), f = H.ang2xyf(k + 9, ra, dec), P = H.ang2pixNest(k + 9, ra, dec);
    if (L.tile !== Math.floor(P / 4 ** 9) || L.col !== f.iy % 512 || L.row !== f.ix % 512) bad++;
  }
  check('HiPS tile and pixel inside it (512-pixel tiles, orders 3 to 11)', bad === 0, `${bad} wrong`);
  check('HiPS tile URL', H.hipsTileUrl('https://x/DSS/', 9, 1234567) === 'https://x/DSS/Norder9/Dir1230000/Npix1234567.jpg');
  check('tile order for a pixel scale', H.hipsOrderFor(1.76, 512, 9) === 8 && H.hipsOrderFor(0.5, 512, 9) === 9 && H.hipsOrderFor(100, 512, 9) === 3, `1.76″ -> ${H.hipsOrderFor(1.76, 512, 9)} (pixels ${H.pixelSizeArcsec(17).toFixed(2)}″)`);
}

// ---- TAN cells against astropy.wcs
{
  let sky = 0, pix = 0;
  for (const c of ref.fields) {
    const P = F.makePlane(c.ra0, c.dec0, c.scale);
    for (const [col, row, ra, dec] of c.pix_to_sky) { const [u, v] = F.cellToPlane(col, row, c.i, c.j, c.N), [r2, d2] = P.toSky(u, v); sky = Math.max(sky, F.separation(ra, dec, r2, d2)); }
    for (const [ra, dec, col, row] of c.sky_to_pix) { const [u, v] = P.toPlane(ra, dec), [c2, r2] = F.planeToCell(u, v, c.i, c.j, c.N); pix = Math.max(pix, Math.hypot(c2 - col, r2 - row)); }
  }
  check('cell pixel -> sky vs astropy.wcs (6 fields, RA wrap, pole, south)', sky < 1e-6, `max ${e(sky)}″`);
  check('sky -> cell pixel vs astropy.wcs', pix < 1e-6, `max ${e(pix)} px`);
  // the WCS handed to hips2fits is the one astropy was given
  const c = ref.fields[2], W = F.cellWcs(F.makePlane(c.ra0, c.dec0, c.scale), c.i, c.j, c.N);
  check('cellWcs: CRPIX and CDELT as documented', W.CRPIX1 === (c.N + 1) / 2 + c.i * c.N && W.CRPIX2 === (c.N + 1) / 2 - c.j * c.N && W.CDELT1 === -c.scale / 3600, `CRPIX ${W.CRPIX1}, ${W.CRPIX2}`);
}

// ---- separation and position angle against astropy.coordinates
{
  let ds = 0, dp = 0;
  for (const p of ref.pairs) {
    ds = Math.max(ds, Math.abs(F.separation(p.ra1, p.dec1, p.ra2, p.dec2) - p.sep_arcsec) / Math.max(1, p.sep_arcsec / 3600));
    let d = Math.abs(F.positionAngle(p.ra1, p.dec1, p.ra2, p.dec2) - p.pa_deg); d = Math.min(d, 360 - d); dp = Math.max(dp, d);
  }
  check('separation vs SkyCoord.separation (0.5″ to 170°)', ds < 1e-5, `max ${e(ds)}″ (per degree beyond 1°)`);
  check('position angle vs SkyCoord.position_angle', dp < 1e-6, `max ${e(dp)}°`);
  // measuring on the plane: north is up (PA 0), east is left (PA 90)
  const P = F.makePlane(31.04, 46.69, 1.8), up = F.measure(P, [0, 0], [0, -100]), left = F.measure(P, [0, 0], [-100, 0]);
  check('measure: 100 px up is 180″ at PA 0°, 100 px left is PA 90°', Math.abs(up.sep - 180) < 1e-3 && Math.abs(up.pa) < 1e-6 && Math.abs(left.pa - 90) < 0.01, `${up.text}; ${left.text}`);
}

// ---- scale bar, outline, neighbours
{
  const b = F.scaleBar(1.8, 150), b2 = F.scaleBar(10, 150);
  check('scale bar: the longest round angle that fits', b.label === '2′' && Math.abs(b.px - 120 / 1.8) < 1e-9 && b2.label === '20′', `${b.label} = ${b.px.toFixed(1)} px at 1.8″/px; ${b2.label} at 10″/px`);
  const cam = F.cameraField(0.6, 2048, 1536);
  check('camera field: 0.6″/px x 2048 x 1536 = 20.48′ x 15.36′', Math.abs(cam.w - 20.48) < 1e-9 && Math.abs(cam.h - 15.36) < 1e-9);
  const P = F.makePlane(10, 20, 2), o = F.outlineCorners(P, 10, 5), o90 = F.outlineCorners(P, 10, 5, 90);
  const span = (q, k) => Math.max(...q.map((p) => p[k])) - Math.min(...q.map((p) => p[k]));
  check('outline 10′ x 5′ at 2″/px: 300 x 150 px; turned 90°: 150 x 300', Math.abs(span(o, 0) - 300) < 1e-9 && Math.abs(span(o, 1) - 150) < 1e-9 && Math.abs(span(o90, 0) - 150) < 1e-9 && Math.abs(span(o90, 1) - 300) < 1e-9);
  check('inside the outline', F.insidePolygon([0, 0], o) && F.insidePolygon([149, 74], o) && !F.insidePolygon([151, 0], o) && !F.insidePolygon([0, 76], o));
  const t = { source: 't', ra: 10, dec: 20, g: 11 }, stars = [t, { source: 'a', ra: 10.01, dec: 20, g: 11.5 }, { source: 'b', ra: 10, dec: 20.02, g: 14 }, { source: 'c', ra: 10.001, dec: 20, g: 10.8, variable: true }, { source: 'd', ra: 10.0005, dec: 20.0005, g: 18 }];
  const found = F.findTarget(stars, 10.0003, 20.0003, { mag: 11.1 }), nb = F.neighbours(stars, found, { dgMin: -1, dgMax: 1 });
  check('the target among the Gaia stars (nearest, magnitude preferred)', found === t);
  check('comparison candidates: within ΔG, not variable, not the target', nb.filter((s) => s.comp).map((s) => s.source).join() === 'a', nb.map((s) => `${s.source} ΔG ${s.dG.toFixed(1)} ${s.sep.toFixed(1)}″ PA ${s.pa.toFixed(0)}°`).join('; '));
  const nb2 = F.neighbours(stars, t, { dgMin: -1, dgMax: 1, plane: P, outline: F.outlineCorners(P, 0.5, 0.5) });
  check('comparison candidates: inside the detector outline only', nb2.every((s) => !s.comp), `a at ${nb2[1].sep.toFixed(0)}″, outline 30″`);
}

// ---- the reprojection map of a cell
{
  const P = F.makePlane(31.04273, 46.68784, 1.8), m = F.hipsCellMap(P, 1, 0, 64, { maxOrder: 9 });
  let bad = 0;
  for (const [col, row] of [[0, 0], [63, 0], [0, 63], [63, 63], [31, 17]]) {
    const [u, v] = F.cellToPlane(col, row, 1, 0, 64), [ra, dec] = P.toSky(u, v), L = H.hipsLocate(m.order, 512, ra, dec), k = row * 64 + col;
    if (m.tiles[m.which[k]] !== L.tile || m.off[k] !== L.row * 512 + L.col) bad++;
  }
  check('cell map: tile and offset of each output pixel', bad === 0 && m.order === 8, `order ${m.order}, ${m.tiles.length} tiles: ${m.tiles.join(', ')}`);
}

console.log(ok ? '\nall survey-image geometry tests passed' : '\nSOME TESTS FAILED');
process.exit(ok ? 0 : 1);
