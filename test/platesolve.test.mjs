// Plate solving (src/core/platesolve.js): the WCS least-squares fit against astropy.wcs.utils.fit_wcs_from_points on
// the same star lists (TAN and TAN-SIP; reference test/make_platesolve_reference.py), the projection against its
// closed-form inverse, the header against src/core/fits.js readWcs, the matcher on synthetic fields with random
// rotation, mirror, scale error, pointing error, missing and spurious stars, and the real HAT-P-32 b frame against
// an independent astropy solution (photutils detection, brute-force match), with the Gaia DR3 cone saved offline.
import { readFileSync } from 'node:fs';
import { tanProject, tanDeproject, separation, makeWcs, fitWcs, wcsFromHeader, solveField, matchCatalog, parseGaia, parseVsx, parseSesame, gaiaConeUrl, atEpoch, wcsThrough } from '../src/core/platesolve.js';
import { optimalAperture, radialProfile, psfShape, gainFromSky } from '../src/core/imexam.js';
import { rankWithCatalog, crossMatch } from '../src/core/fieldstars.js';
import { readWcs, openFits, readImage } from '../src/core/fits.js';
import { starsForSolving } from '../src/core/platesolve.js';
import { detectSources, fitSimilarity, matchAsterism, addStars, addNoise, fitPsf } from '../src/core/photometry.js';
import { parseASU } from '../src/core/rvsources.js';
import { makeRng } from '../src/core/stats.js';
import { splitFits } from '../src/photometry/pipeline.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./platesolve_reference.json', import.meta.url)));
const cats = JSON.parse(readFileSync(new URL('./data/platesolve_hatp32_catalogs.json', import.meta.url)));

// --- projection: inverse, and known values
{
  const rng = makeRng(3); let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const ra0 = 360 * rng.next(), de0 = -89 + 178 * rng.next(), ra = ra0 + (rng.next() - 0.5) * 6, de = Math.max(-89.9, Math.min(89.9, de0 + (rng.next() - 0.5) * 6));
    const [x, y] = tanProject(ra, de, ra0, de0), [r2, d2] = tanDeproject(x, y, ra0, de0); worst = Math.max(worst, separation(ra, de, r2, d2));
  }
  check('gnomonic projection and its inverse', worst < 1e-6, `2000 random points within 3° of random tangent points; largest round-trip error ${worst.toExponential(1)}″`);
  const [x, y] = tanProject(10, 0, 0, 0);
  check('projection of a point on the equator', Math.abs(x - Math.tan(10 * Math.PI / 180) * 180 / Math.PI) < 1e-12 && Math.abs(y) < 1e-12, `xi = tan(10°) in degrees (${x.toFixed(9)})`);
}

// --- WCS fit = astropy fit_wcs_from_points (same stars, same tangent point)
for (const c of ref.fits) {
  const pairs = c.stars.map(([x, y, ra, dec]) => ({ x, y, ra, dec }));
  const W = fitWcs(pairs, { crval: c.proj, sipOrder: c.sipOrder, width: c.width, height: c.height });
  let dA = 0, dT = 0;
  c.grid.forEach(([x, y], k) => { const [r, d] = W.pixToSky(x, y); dA = Math.max(dA, separation(r, d, ...c.gridAstropy[k])); dT = Math.max(dT, separation(r, d, ...c.gridTruth[k])); });
  const tolA = c.noise ? 0.02 * c.scale : 1e-3;
  check(`fitted WCS = astropy, ${c.name}`, dA < tolA, `largest difference on a 5 × 5 grid ${dA.toExponential(2)}″ (${(dA / c.scale).toExponential(1)} px; tolerance ${(tolA / c.scale).toFixed(3)} px); from the true WCS ${(dT / c.scale).toFixed(4)} px; rms ${W.rms.toFixed(4)}″ here, ${c.astropy.rms.toFixed(4)}″ astropy; CRPIX ${W.crpix.map((v) => v.toFixed(3)).join(', ')} vs ${c.astropy.crpix.map((v) => v.toFixed(3)).join(', ')}`);
  if (!c.noise) {
    // with its own tangent point (the default: CRVAL fitted) exact positions give back the true TAN solution
    const F = fitWcs(pairs, { width: c.width, height: c.height }); let d0 = 0; c.grid.forEach(([x, y], k) => { d0 = Math.max(d0, separation(...F.pixToSky(x, y), ...c.gridTruth[k])); });
    check(`exact positions give the true WCS, ${c.name}`, d0 < 1e-5, `largest difference ${d0.toExponential(1)}″ (astropy's tangent point is not the true one, hence its ${dT.toExponential(1)}″)`);
  }
  // round trip through skyToPix (Newton for SIP) and through the header (readWcs for the linear part, wcsFromHeader for SIP)
  let rt = 0; for (const [x, y] of c.grid) { const [r, d] = W.pixToSky(x, y), [x2, y2] = W.skyToPix(r, d); rt = Math.max(rt, Math.hypot(x2 - x, y2 - y)); }
  check(`sky to pixel inverts pixel to sky, ${c.name}`, rt < 1e-6, `largest round trip ${rt.toExponential(1)} px`);
  const H = W.header(), W2 = wcsFromHeader(H), L = readWcs(H);
  let dh = 0, dl = 0; for (const [x, y] of c.grid) { const a = W.pixToSky(x, y), b = W2.pixToSky(x, y); dh = Math.max(dh, separation(...a, ...b)); if (!c.sipOrder) { const q = L.pixToSky(x, y); dl = Math.max(dl, separation(...a, ...q)); } }
  check(`header keywords read back, ${c.name}`, dh < 1e-9 && dl < 1e-6, `wcsFromHeader ${dh.toExponential(1)}″${c.sipOrder ? '' : `, src/core/fits.js readWcs ${dl.toExponential(1)}″`}`);
  if (c.sipOrder) {
    // the inverse polynomials in the header: AP, BP as astropy reads them should invert A, B to well below a pixel
    let ap = 0; const ord = H.AP_ORDER;
    for (const [x, y] of c.grid) { const [r, d] = W.pixToSky(x, y), [xi, eta] = tanProject(r, d, H.CRVAL1, H.CRVAL2), det = H.CD1_1 * H.CD2_2 - H.CD1_2 * H.CD2_1, U = (H.CD2_2 * xi - H.CD1_2 * eta) / det, V = (-H.CD2_1 * xi + H.CD1_1 * eta) / det; let du = 0, dv = 0; for (let n = 1; n <= ord; n++) for (let p = n; p >= 0; p--) { du += (H[`AP_${p}_${n - p}`] || 0) * U ** p * V ** (n - p); dv += (H[`BP_${p}_${n - p}`] || 0) * U ** p * V ** (n - p); } ap = Math.max(ap, Math.hypot(U + du + H.CRPIX1 - 1 - x, V + dv + H.CRPIX2 - 1 - y)); }
    check('inverse SIP (AP, BP) written to the header', ap < 0.01, `largest error of the inverse polynomials ${ap.toExponential(1)} px over the frame`);
  }
}

// --- default mode (CRPIX at the centre, CRVAL fitted) gives the same mapping as astropy's parameterisation
{
  const c = ref.fits[1], pairs = c.stars.map(([x, y, ra, dec]) => ({ x, y, ra, dec })), W = fitWcs(pairs, { width: c.width, height: c.height });
  let d = 0; c.grid.forEach(([x, y], k) => d = Math.max(d, separation(...W.pixToSky(x, y), ...c.gridAstropy[k])));
  check('CRPIX at the centre and CRVAL fitted = astropy (CRVAL fixed, CRPIX fitted)', d < 0.02 * c.scale, `largest difference ${(d / c.scale).toFixed(4)} px; CRPIX ${W.crpix.join(', ')}`);
}

// --- synthetic fields: random rotation, mirror, 3% scale error, pointing off by up to 40% of the field, 25% of the
// catalogue stars not detected, 15% spurious detections, magnitudes scrambled by 0.4 mag, 0.2 px centroid noise
{
  const rng = makeRng(77), nTrial = 24; let solved = 0, worst = 0, worstRms = 0, ms = 0; const fails = [];
  for (let t = 0; t < nTrial; t++) {
    const W = [1024, 2048, 640][t % 3], H = [768, 1365, 480][t % 3], scale = [1.1, 0.42, 3.2][t % 3], rot = 360 * rng.next(), mirror = rng.next() < 0.5, sip = t % 4 === 3;
    const ra0 = 360 * rng.next(), de0 = -80 + 160 * rng.next(), s = scale / 3600, th = rot * Math.PI / 180, m = mirror ? 1 : -1;
    const truth = makeWcs({ crval: [ra0, de0], crpix: [W / 2 + 0.5, H / 2 + 0.5], cd: [m * s * Math.cos(th), -s * Math.sin(th), m * s * Math.sin(th), s * Math.cos(th)], sip: sip ? { order: 2, a: { '2_0': 1.2e-6 * 1024 / W, '1_1': 0, '0_2': 9e-7 * 1024 / W }, b: { '2_0': 0, '1_1': 1.2e-6 * 1024 / W, '0_2': 0 } } : null, width: W, height: H });
    // catalogue over a circle 1.6 times the half-diagonal, brightest first
    const R = 1.6 * 0.5 * Math.hypot(W, H) * scale / 3600, nCat = 500, catalog = [];
    for (let i = 0; i < nCat; i++) { const r = R * Math.sqrt(rng.next()), a = 2 * Math.PI * rng.next(), [ra, dec] = tanDeproject(r * Math.cos(a), r * Math.sin(a), ra0, de0); catalog.push({ ra, dec, g: 9 + 8 * Math.pow(rng.next(), 0.35) }); }
    catalog.sort((a, b) => a.g - b.g);
    const stars = [];
    for (const c of catalog) { const [x, y] = truth.skyToPix(c.ra, c.dec); if (!(x > 4 && y > 4 && x < W - 5 && y < H - 5) || rng.next() < 0.25) continue; stars.push({ x: x + 0.2 * rng.normal(), y: y + 0.2 * rng.normal(), m: c.g + 0.4 * rng.normal(), ra: c.ra, dec: c.dec }); }
    const nSp = Math.round(0.15 * stars.length); for (let i = 0; i < nSp; i++) stars.push({ x: W * rng.next(), y: H * rng.next(), m: 10 + 7 * rng.next() });
    stars.sort((a, b) => a.m - b.m);
    const off = 0.4 * Math.min(W, H) * scale / 3600, [pra, pde] = tanDeproject(off * (rng.next() - 0.5) * 2, off * (rng.next() - 0.5) * 2, ra0, de0);
    const t0 = performance.now(), r = solveField(stars.slice(0, 120), catalog, { width: W, height: H, ra: pra, dec: pde, scale: scale * (1 + 0.03 * (rng.next() - 0.5) * 2), scaleTol: 0.08 }); ms = Math.max(ms, performance.now() - t0);
    if (!r.ok) { fails.push(`${t}: ${r.message}`); continue; }
    // against the truth at the corners and centre, and against the best possible: the same model fitted to the true pairs
    const oracle = fitWcs(stars.filter((q) => q.ra != null), { width: W, height: H, sipOrder: sip ? 2 : 0 }), err = (Wc) => { let d = 0; for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) d = Math.max(d, separation(...Wc.pixToSky(x, y), ...truth.pixToSky(x, y)) / scale); return d; };
    const d = err(r.wcs), d0 = err(oracle);
    worst = Math.max(worst, d - d0); worstRms = Math.max(worstRms, r.rmsPx);
    if (d < Math.max(0.25, d0 + 0.1) && r.flipped === truth.flipped) solved++; else fails.push(`${t}: off by ${d.toFixed(2)} px, ${d0.toFixed(2)} px from the true pairs (${r.nMatch} stars, SIP ${r.sip}${sip ? ', SIP put in' : ''})`);
  }
  check('synthetic fields solved (any rotation, mirror, scale error, pointing error, missing and spurious stars, SIP in a quarter)', solved === nTrial, `${solved} / ${nTrial} within 0.25 px (or 0.1 px of a fit to the true pairs) at the corners; largest excess over that fit ${worst.toFixed(3)} px; largest rms ${worstRms.toFixed(3)} px (0.2 px noise put in); slowest ${ms.toFixed(0)} ms${fails.length ? '; ' + fails.join('; ') : ''}`);
}

// --- no false solution on an unrelated field
{
  const rng = makeRng(5), catalog = [], stars = [];
  for (let i = 0; i < 400; i++) { const [ra, dec] = tanDeproject((rng.next() - 0.5) * 0.6, (rng.next() - 0.5) * 0.6, 120, 10); catalog.push({ ra, dec, g: 9 + 8 * rng.next() }); }
  for (let i = 0; i < 60; i++) stars.push({ x: 1000 * rng.next(), y: 800 * rng.next() });
  catalog.sort((a, b) => a.g - b.g);
  const r = solveField(stars, catalog, { width: 1000, height: 800, ra: 120, dec: 10, scale: 1.2 });
  check('random stars against an unrelated catalogue: no solution claimed', !r.ok, r.message);
}

// --- catalogue answers
{
  const gaia = parseGaia(cats.gaia.tsv, parseASU), vsx = parseVsx(cats.vsx.tsv, parseASU);
  check('Gaia DR3 cone read from the saved VizieR answer', gaia.length > 600 && gaia.every((s, i) => !i || s.g >= gaia[i - 1].g) && gaia.some((s) => s.variable), `${gaia.length} stars, G ${gaia[0].g.toFixed(2)} to ${gaia[gaia.length - 1].g.toFixed(2)}, ${gaia.filter((s) => s.variable).length} flagged VARIABLE; query ${cats.made}`);
  check('VSX cone read', vsx.length >= 1 && vsx.every((v) => v.name && Number.isFinite(v.ra)), `${vsx.length} variables within ${cats.radius_arcmin}′ (${vsx.slice(0, 3).map((v) => `${v.name} ${v.type}`).join('; ')})`);
  const ses = parseSesame('# HAT-P-32\t#Q366913\n#=Sc=Simbad (CDS, via client/server):    1    64ms\n%@ @6140027\n%C.0 *  \n%J 31.04282266 +46.68783675 = 02 04 10.277  +46 41 16.21 \n');
  check('Sesame answer read', ses && Math.abs(ses.ra - 31.04282266) < 1e-9 && Math.abs(ses.dec - 46.68783675) < 1e-9, `${ses.ra}, ${ses.dec}`);
  check('Gaia query URL', /I%2F355%2Fgaiadr3/.test(gaiaConeUrl('https://vizier.cfa.harvard.edu', 31.0417, 46.6897, 15)) && /-sort=Gmag/.test(gaiaConeUrl('https://x', 1, -2, 3)));
  const moved = atEpoch([{ ra: 10, dec: 60, pmra: 1000, pmdec: -2000 }], 2026.0)[0];
  check('proper motion to the epoch of the frame', Math.abs((moved.ra - 10) * Math.cos(60 * Math.PI / 180) * 3600 - 10) < 1e-9 && Math.abs((moved.dec - 60) * 3600 + 20) < 1e-9, '1″/yr east and 2″/yr south for 10 yr');
}

// --- the real frame: HAT-P-32 b, MicroObservatory, 5.2″/px, against astropy's independent solution
const raw = readFileSync(new URL('./data/hatp32_exotic_sample.fits', import.meta.url));
const parts = await splitFits(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'hatp32');
const gaia = parseGaia(cats.gaia.tsv, parseASU), R0 = ref.real;
let sol0 = null, im0 = null;
{
  const im = im0 = readImage(await openFits(parts[0].buffer)), det = starsForSolving(im.data, im.width, im.height);
  const runs = [['the catalogue position of HAT-P-32', 31.04282266, 46.68783675, 5.21], ['the header RA, DEC (15′ off)', 31.312099, 46.769087, 5.21], ['no scale (1 to 20″/px tried)', 31.04282266, 46.68783675, null]];
  for (const [what, ra, dec, sc] of runs) {
    const t0 = performance.now(), r = solveField(det.sources, gaia, { width: im.width, height: im.height, ra, dec, ...(sc ? { scale: sc } : { scaleMin: 1, scaleMax: 20 }) }), ms = performance.now() - t0;
    if (!sol0) sol0 = r;
    let d = 0; R0.grid.forEach(([x, y], k) => { d = Math.max(d, separation(...r.wcs.pixToSky(x, y), ...R0.gridAstropy[k])); });
    const [tx, ty] = r.wcs.skyToPix(...R0.targetSky);
    check(`real frame solved from ${what}`, r.ok && r.rms < 1.2 && d < 0.3 * 5.2 && Math.hypot(tx - R0.target[0], ty - R0.target[1]) < 0.3, `${r.nMatch} of ${det.sources.length} stars matched, rms ${r.rms.toFixed(2)}″ (${r.rmsPx.toFixed(2)} px), ${r.scale.toFixed(3)}″/px, ${r.flipped ? 'mirrored' : 'not mirrored'}, north ${r.rotation.toFixed(1)}° from +y, ${ms.toFixed(0)} ms; astropy (DAOStarFinder, brute force, fit_wcs_from_points): ${R0.nMatch} stars, rms ${R0.rms.toFixed(2)}″; largest difference over the frame ${d.toFixed(2)}″ (${(d / r.scale).toFixed(2)} px); HAT-P-32 at (${tx.toFixed(2)}, ${ty.toFixed(2)}) here, (${R0.target[0].toFixed(2)}, ${R0.target[1].toFixed(2)}) astropy`);
  }
  // other frames (the window follows the target in 8 px steps): solved directly, and through the frame-to-frame transform
  const dets = [], ws = [];
  for (const fi of [20, 47]) {
    const im = readImage(await openFits(parts[fi].buffer)), d2 = starsForSolving(im.data, im.width, im.height);
    const r = solveField(d2.sources, gaia, { width: im.width, height: im.height, ra: 31.0428, dec: 46.6878, scale: 5.21 });
    const T = matchAsterism(d2.sources, det.sources, { mirror: true, tol: 3 }), Wt = wcsThrough(sol0.wcs, T);
    let dd = 0; for (const [x, y] of [[10, 10], [140, 10], [10, 155], [140, 155], [76, 83]]) dd = Math.max(dd, separation(...r.wcs.pixToSky(x, y), ...Wt.pixToSky(x, y)));
    dets.push(`frame ${fi + 1}: ${r.nMatch} stars, rms ${r.rms.toFixed(2)}″; WCS of frame 1 carried by the tracking transform (${T ? T.nMatch : 0} stars) differs by ${dd.toFixed(2)}″ at most`); ws.push(r.ok && dd < 3);
  }
  check('other frames: own solution and frame 1 carried over agree', ws.every(Boolean), dets.join('; '));
}

// --- the SNR-optimal aperture: 0.67 FWHM in radius for a faint Gaussian star on a sky-limited frame (Howell 1989; Naylor 1998)
{
  const W = 96, H = 96, rng = makeRng(11);
  // expected: the maximum of F (1 - exp(-r²/2σ²)) / sqrt(F (1 - exp(-r²/2σ²)) / g + π r² sky²) for a continuous Gaussian
  // with σ² + 1/12 (the pixel's own width), found on a fine grid; F → 0 gives 1.585 σ = 0.673 FWHM
  const expect = (F, sky, sg, g) => { const s2 = sg * sg + 1 / 12; let br = 0, bs = -1; for (let r = 0.2; r < 12 * sg; r += 1e-3) { const S = F * (1 - Math.exp(-r * r / (2 * s2))), q = S / Math.sqrt(S / g + Math.PI * r * r * sky); if (q > bs) { bs = q; br = r; } } return br; };
  for (const [what, flux, sky, sigma, gain] of [['sky-limited (faint star)', 150, 400, 2.0, 1], ['faint star, wide PSF', 300, 400, 3.2, 1], ['sky and photon noise comparable', 3000, 400, 2.0, 1], ['bright (photon-limited)', 3e6, 400, 2.0, 1]]) {
    const img = new Float32Array(W * H).fill(sky); addStars(img, W, H, [{ x: 47.3, y: 48.6, flux, sigma }]);
    const prof = radialProfile(img, W, H, 47.3, 48.6, { rmax: Math.ceil(7 * sigma), recentre: false, background: sky, growthStep: 0.05 });
    const o = optimalAperture(prof, { skySigma: Math.sqrt(sky / gain), gain });
    const fw = 2.3548 * sigma, want = expect(flux, sky / gain, sigma, gain);
    check(`optimal aperture radius, ${what}`, Math.abs(o.radius / want - 1) < 0.02, `${o.radius.toFixed(3)} px = ${(o.radius / fw).toFixed(3)} FWHM; expected ${want.toFixed(3)} px = ${(want / fw).toFixed(3)} FWHM (sky-limited limit 0.673 FWHM); SNR ${o.snr.toFixed(1)}, ${(100 * o.fraction).toFixed(0)}% of the flux; tolerance 2%`);
  }
  // the gain bound from the sky when no GAIN keyword is known: Poisson sky at gain 2.5 e-/ADU, read noise 3 e-
  const sky = new Float64Array(200 * 200).fill(800); for (let i = 0; i < sky.length; i++) sky[i] += Math.sqrt(800 / 2.5 + (3 / 2.5) ** 2) * rng.normal();
  const pr = radialProfile(sky, 200, 200, 100, 100, { rmax: 10, recentre: false, skyWidth: 30 }), gb = gainFromSky(pr.background, pr.backgroundSigma);
  check('gain bound from the sky noise', gb.bound && Math.abs(gb.gain / (800 / (800 / 2.5 + (3 / 2.5) ** 2)) - 1) < 0.02, `${gb.gain.toFixed(3)} e⁻/ADU from a sky of 800 ADU at 2.5 e⁻/ADU with 3 e⁻ read noise (the bound sky / variance is ${(800 / (800 / 2.5 + (3 / 2.5) ** 2)).toFixed(3)}; the 3σ-clipped σ corrected by 1.3%); tolerance 2%`);
  check('a sky-subtracted frame gives no gain bound (sky-limited)', !gainFromSky(0.3, 5).bound && gainFromSky(0.3, 5).gain === Infinity);
  void addNoise;
}

// --- comparison ranking with Gaia: magnitude, colour, variables, faint neighbours
{
  const vsx = parseVsx(cats.vsx.tsv, parseASU), det = starsForSolving(im0.data, im0.width, im0.height).sources;
  const X = crossMatch(det, sol0.wcs, gaia, { radius: 1.5 * sol0.scale });
  const [tx, ty] = sol0.wcs.skyToPix(31.04282266, 46.68783675), ti = X.findIndex((s) => Math.hypot(s.x - tx, s.y - ty) < 2);
  check('cross-match of detected stars with Gaia', X.filter((s) => s.gaia).length >= 50 && ti >= 0 && X[ti].gaia && Math.abs(X[ti].gaia.g - 11.2) < 0.4, `${X.filter((s) => s.gaia).length} of ${X.length} detected stars have a Gaia counterpart within 1.5 px; the target is G ${ti >= 0 && X[ti].gaia ? X[ti].gaia.g.toFixed(2) : '?'}, BP−RP ${ti >= 0 && X[ti].gaia ? X[ti].gaia.bprp.toFixed(2) : '?'}`);
  const rk = rankWithCatalog(X, X[ti], { w: im0.width, h: im0.height, fwhm: 2.6, wcs: sol0.wcs, gaia, vsx, scale: sol0.scale });
  const vari = rk.filter((q) => q.variable), top = rk.slice(0, 5);
  check('Gaia-flagged and VSX variables are not offered', rk.filter((q) => q.usable).every((q) => !q.variable), `${vari.length} candidates marked variable (${vari.slice(0, 3).map((q) => q.notes.find((n) => /variable|VSX/i.test(n))).join('; ')})`);
  check('ranked candidates carry G, BP−RP and reasons', top.every((q) => q.gaia && Number.isFinite(q.gaia.g) && Array.isArray(q.notes)), top.map((q) => `(${q.x.toFixed(0)}, ${q.y.toFixed(0)}) G ${q.gaia.g.toFixed(2)} BP−RP ${q.gaia.bprp.toFixed(2)}${q.notes.length ? ' ' + q.notes.join(', ') : ''}`).join(' | '));
  // the two comparison stars of the EXOTIC demo are among the usable candidates
  // the two comparison stars of the EXOTIC demo: one is HAT-125-0001606, a BY Dra variable in VSX (0.02 mag in V)
  const demo = [[465 - 392, 183 - 152], [512 - 392, 263 - 152]], at = ([x, y]) => rk.findIndex((q) => Math.hypot(q.x - x, q.y - y) < 4), k0 = at(demo[0]), k1 = at(demo[1]);
  check("EXOTIC's comparison stars: one usable, one a VSX variable", k0 >= 0 && k1 >= 0 && rk[k0].vsx && /HAT-125-0001606/.test(rk[k0].vsx.name) && !rk[k0].usable && rk[k1].usable && k1 < 5, demo.map(([x, y], i) => { const k = [k0, k1][i]; return k < 0 ? 'not ranked' : `(${x}, ${y}) rank ${k + 1} of ${rk.length}${rk[k].notes.length ? ' (' + rk[k].notes.join(', ') + ')' : ''}`; }).join('; '));
  // with PSF shapes (as the page measures them): every star of this frame is stretched the same way (e ~ 0.43 at 155°),
  // which must not make every star "elongated"
  const f0 = fitPsf(im0.data, im0.width, im0.height, X[ti].x, X[ti].y, 8, { model: 'gaussian', rotate: true }), fwT = psfShape(f0).fwhm;
  const shaped = det.map((q, i) => { if (i >= 40) return q; const g = fitPsf(im0.data, im0.width, im0.height, q.x, q.y, Math.max(5, Math.round(2 * fwT)), { model: 'gaussian', rotate: true, sigma: fwT / 2.3548 }); return g.ok ? { ...q, ...psfShape(g) } : q; });
  const rs = rankWithCatalog(crossMatch(shaped, sol0.wcs, gaia, { radius: 1.5 * sol0.scale }), X[ti], { w: im0.width, h: im0.height, fwhm: fwT, wcs: sol0.wcs, gaia, vsx, scale: sol0.scale });
  const medE = shaped.slice(0, 40).map((q) => q.ellipticity).filter(Number.isFinite).sort((a, b) => a - b);
  check('a field-wide PSF stretch does not mark every star elongated', rs.filter((q) => q.usable).length >= 5, `median ellipticity ${medE[medE.length >> 1].toFixed(2)}; ${rs.filter((q) => q.usable).length} usable, ${rs.filter((q) => q.notes.some((n) => /elongated/.test(n))).length} marked elongated`);
  // a synthetic neighbour test: a star with a Gaia neighbour of half its flux 1 FWHM away is marked crowded
  const fakeG = [{ ra: 0, dec: 0, g: 12, bprp: 0.8 }, { ra: 0.0006, dec: 0, g: 12.75, bprp: 0.8 }, { ra: 0.01, dec: 0.01, g: 12, bprp: 0.8 }];
  const fw = makeWcs({ crval: [0, 0], crpix: [51, 51], cd: [-1 / 3600, 0, 0, 1 / 3600], width: 100, height: 100 });
  const fx = fakeG.map((g) => { const [x, y] = fw.skyToPix(g.ra, g.dec); return { x, y, flux: 10 ** (-0.4 * (g.g - 12)) * 1e4, peak: 100 }; });
  const fr = rankWithCatalog(crossMatch([fx[0], fx[2]], fw, fakeG, { radius: 1.5 }), { ...fx[2], gaia: fakeG[2] }, { w: 100, h: 100, fwhm: 2, wcs: fw, gaia: fakeG, scale: 1 });
  check('a faint Gaia neighbour inside the aperture is counted', fr.length === 1 && fr[0].contamination > 0.3 && fr[0].notes.some((n) => /Gaia neighbour/.test(n)), fr[0] ? `contamination ${(100 * fr[0].contamination).toFixed(0)}%: ${fr[0].notes.join(', ')}` : 'none');
  void fitSimilarity;
}

process.exit(ok ? 0 : 1);
