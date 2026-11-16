// The wavelength-resolved limb darkening table (src/data/ld_spectral.js, built by tools/build_ld_spectral.py) and
// the code that serves any bandpass from it (src/core/ldspec.js), against
//   (a) the bundled 37-band table for the same stars: same model files, so this tests the binning, the compression
//       and the combination of bins into a band;
//   (b) ExoTETHyS/PHOENIX through pylightcurve: a different code on the same model family;
//   (c) ExoTETHyS/ATLAS: different atmosphere physics, the honest size of the uncertainty;
//   (d) narrow channels integrated directly from the PHOENIX files (test/make_ldspec_reference.py);
//   (e) speed of the function a fit calls, and of setting it up.
// Profiles are compared, not coefficients (the four Claret basis functions are nearly collinear). "rms" is the rms of
// the difference in I(mu)/I(1) over mu in [0.1, 1], the range the models are fitted on; "depth" is the relative
// difference in mid-transit depth of a planet with Rp/R* = 0.1 (the larger of b = 0 and b = 0.5).
// Tolerances are the worst values this test printed when the table was built (November 2026, lambda / 120 bins,
// 40 components) times about 1.5.
import { readFileSync } from 'node:fs';
import { LD_SPECTRAL_COMPACT } from '../src/data/ld_spectral.js';
import { LD_TABLE } from '../src/data/ld_table.js';
import { expandSpectral, bandWeights, bandTable, bandCoefficients, bandProfile, spectralTieSpec, makeSpectralTie, keepPhysical } from '../src/core/ldspec.js';
import { FILTERS, fitLaw, greyProfile, gridFromTable, interpLDGrid, makeLDTie } from '../src/core/ldest.js';
import { intensity, toClaret, checkProfile } from '../src/core/limbdark.js';
import { makeTransit } from '../src/core/transit.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./ldspec_reference.json', import.meta.url)));
const ref37 = JSON.parse(readFileSync(new URL('./limbdark_reference.json', import.meta.url)));
const e1 = (x) => x.toExponential(1), f4 = (x) => x.toFixed(4), pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);

// ---- comparison tools ---------------------------------------------------------------------------
const MU = Float64Array.from({ length: 91 }, (_, i) => 0.1 + (0.9 * i) / 90);
/** rms and largest difference of two profiles over mu in [0.1, 1]. */
function profDiff(lawA, a, lawB, b) {
  const ca = toClaret(lawA, a), cb = toClaret(lawB, b); let s = 0, m = 0;
  for (const mu of MU) { const d = intensity(mu, ca) - intensity(mu, cb); s += d * d; m = Math.max(m, Math.abs(d)); }
  return { rms: Math.sqrt(s / MU.length), max: m };
}
/** Relative difference in mid-transit depth, Rp/R* = 0.1, a/R* = 10, the larger of b = 0 and b = 0.5. */
function depthDiff(lawA, a, lawB, b) {
  let depth = 0;
  for (const imp of [0, 0.5]) {
    const p = { rprs: 0.1, ars: 10, per: 3, tmid: 0, ecc: 0, omega: 0, inc: Math.acos(imp / 10) * 180 / Math.PI };
    depth = Math.max(depth, Math.abs((1 - makeTransit({ ...p, ldLaw: lawA, ld: a })(0)) / (1 - makeTransit({ ...p, ldLaw: lawB, ld: b })(0)) - 1));
  }
  return depth;
}
const CLASSES = ['M late', 'M', 'K', 'G', 'F-A'];
const cls = (teff) => (teff < 3000 ? 'M late' : teff < 3900 ? 'M' : teff < 5300 ? 'K' : teff < 6000 ? 'G' : 'F-A');
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
/** Collects { rms, depth } by (row, column) and prints "median / worst" tables. */
function Stats() {
  const cells = new Map();
  return {
    add(row, col, rms, depth) { const k = row + '|' + col; if (!cells.has(k)) cells.set(k, { rms: [], depth: [] }); const c = cells.get(k); c.rms.push(rms); if (depth !== undefined) c.depth.push(depth); },
    get(row, col) { return cells.get(row + '|' + col); },
    worst(what = 'rms', rows = null, cols = null) { let w = 0; for (const [k, c] of cells) { const [r, cl] = k.split('|'); if ((!rows || rows.includes(r)) && (!cols || cols.includes(cl))) for (const v of c[what]) w = Math.max(w, v); } return w; },
    med(what = 'rms', rows = null, cols = null) { const all = []; for (const [k, c] of cells) { const [r, cl] = k.split('|'); if ((!rows || rows.includes(r)) && (!cols || cols.includes(cl))) all.push(...c[what]); } return median(all); },
    print(title, rows, cols, what = 'rms') {
      console.log(`     ${title} (median / worst${what === 'depth' ? ', relative depth' : ''})`);
      console.log('       ' + pad('', 8) + cols.map((c) => lpad(c, 19)).join(''));
      for (const r of rows) console.log('       ' + pad(r, 8) + cols.map((c) => { const x = cells.get(r + '|' + c); return lpad(x && x[what].length ? e1(median(x[what])) + ' / ' + e1(Math.max(...x[what])) : '-', 19); }).join(''));
    },
  };
}

// ---- the table -------------------------------------------------------------------------------------
let t0 = performance.now();
const S = expandSpectral(LD_SPECTRAL_COMPACT);
const tExpand = performance.now() - t0;
{
  const nodes = S.held.reduce((s, v) => s + v, 0), widths = Array.from({ length: S.nb }, (_, b) => S.edges[b + 1] - S.edges[b]);
  const kB = JSON.stringify(LD_SPECTRAL_COMPACT).length / 1024;
  check('spectral table decodes', S.nb > 40 && nodes === LD_TABLE.rows.filter((r) => r.filter === 'Johnson V').length && S.scores.every(Number.isFinite) && S.basis.every(Number.isFinite),
    `${S.nb} bins ${S.range[0]}-${S.range[1]} nm (${Math.min(...widths)} to ${Math.max(...widths)} nm wide), ${nodes} stellar nodes (those of the 37-band table), ${S.K} components, ${kB.toFixed(0)} kB as JSON, decoded in ${tExpand.toFixed(1)} ms`);
  check('table is about the size of the 37-band table', kB < 300, `${kB.toFixed(0)} kB against 252 kB`);
}

// ---- do bins combine linearly? -------------------------------------------------------------------------
// Algebra: the F-weighted mean of the bins' Claret coefficients gives the F-weighted mean of their profiles (identity,
// to rounding). Physics: that mean is the Claret fit of the band-integrated profile, except that each bin has its own
// limb radius (steepest gradient of its own profile) and its own fit: `direct` against `combined`, before compression.
{
  let ident = 0, worst = 0, at = null; const all = [];
  for (const c of ref.linearity) {
    ident = Math.max(ident, c.identity);
    const d = profDiff('nonlinear', c.direct, 'nonlinear', c.combined).rms; all.push(d);
    if (d > worst) { worst = d; at = c; }
  }
  check('weighted mean of coefficients = coefficients of the weighted mean profile', ident < 1e-12, `largest difference in I(mu) ${e1(ident)} (${ref.linearity.length} cases, 2 to ${Math.max(...ref.linearity.map((c) => c.nbins))} bins)`);
  check('bins fitted separately combine to the fit of the band-integrated profile', worst < 3e-4, `I(mu) rms median ${e1(median(all))}, worst ${e1(worst)} (${at.teff} K, ${at.band.join('-')} nm): the cost of one limb radius per bin, before compression`);
}

// ---- (a) against the 37-band table ---------------------------------------------------------------------
const band37 = (name) => ref.curves[name] || FILTERS[name];
const kind37 = (name) => (name.startsWith('JWST') ? 'JWST' : FILTERS[name][1] - FILTERS[name][0] < 25 ? 'narrow' : 'broad');
const grids37 = Object.fromEntries(['nonlinear', 'quadratic', 'linear', 'sqrt'].map((law) => [law, gridFromTable(LD_TABLE, law)]));
{
  // at every model node: no interpolation on either side
  const st = Stats(), names = Object.keys(LD_TABLE.bands);
  let tBuild = 0, nCon = 0, nUnphys = 0, nProf = 0;
  for (const name of names) {
    t0 = performance.now(); const bt = bandTable(S, band37(name), name); tBuild += performance.now() - t0;
    nCon += bt.spectral.constrained;
    const mine = new Map(bt.rows.map((r) => [r.teff + '|' + r.logg + '|' + r.feh, r]));
    for (const r of LD_TABLE.rows) if (r.filter === name) {
      const m = mine.get(r.teff + '|' + r.logg + '|' + r.feh);
      st.add(cls(r.teff), kind37(name), profDiff('nonlinear', m.nonlinear, 'nonlinear', r.nonlinear).rms);
      nProf++;
      for (const law of ['nonlinear', 'quadratic', 'linear']) if (!checkProfile(toClaret(law, m[law])).ok) nUnphys++;
    }
  }
  st.print('(a) against the 37-band table at every model node, four-coefficient law, I(mu) rms', CLASSES, ['broad', 'narrow', 'JWST']);
  check('(a) broad bands of the 37-band table are reproduced at every node', st.worst('rms', null, ['broad']) < 1.3e-2 && st.med('rms', null, ['broad']) < 6e-4,
    `${nProf} profiles in ${names.length} bands; broad (25 nm and wider, 23 bands): median ${e1(st.med('rms', null, ['broad']))}, worst ${e1(st.worst('rms', null, ['broad']))}; above 3000 K worst ${e1(st.worst('rms', CLASSES.slice(1), ['broad']))}`);
  check('(a) JWST white-light bands', st.worst('rms', null, ['JWST']) < 1.1e-2, `median ${e1(st.med('rms', null, ['JWST']))}, worst ${e1(st.worst('rms', null, ['JWST']))} (the 37-band table uses the "visir" files below 2.6 micron for these, this table the "vis" files)`);
  check('(a) narrow bands (Stromgren, Optec Wing: 3 to 23 nm wide, 14 bands)', st.worst('rms', null, ['narrow']) < 1.5e-2 && st.med('rms', null, ['narrow']) < 1.1e-3, `median ${e1(st.med('rms', null, ['narrow']))}, worst ${e1(st.worst('rms', null, ['narrow']))}; above 3000 K worst ${e1(st.worst('rms', CLASSES.slice(1), ['narrow']))}`);
  check('every band profile is physical at every node (non-negative, no limb brightening), all laws', nUnphys === 0, `${nUnphys} failures of checkProfile; ${nCon} of ${nProf} four-coefficient profiles needed the constraint`);
  console.log(`     building all ${names.length} bands at ${S.held.reduce((s, v) => s + v, 0)} nodes took ${tBuild.toFixed(0)} ms (${(tBuild / names.length).toFixed(1)} ms per band, cached afterwards)`);
}
const STARS = [
  ['TRAPPIST-1 (M8)', 2566, 5.24, 0.04], ['LHS 1140 (M4.5)', 3096, 5.04, -0.15], ['GJ 1214-like (M4)', 3250, 4.95, 0.20], ['GJ 436 (M2.5)', 3586, 4.84, 0.02],
  ['WASP-43 (K7)', 4400, 4.65, -0.05], ['HD 189733 (K2)', 5052, 4.59, -0.03], ['HD 80606 (G5)', 5565, 4.40, 0.35], ['Sun (G2)', 5772, 4.44, 0.00],
  ['HD 209458 (F9)', 6091, 4.45, 0.00], ['WASP-12 (F9)', 6360, 4.16, 0.30], ['WASP-121 (F6)', 6459, 4.24, 0.13], ['WASP-33 (A5)', 7430, 4.30, 0.10],
].map(([name, teff, logg, feh]) => ({ name, teff, logg, feh }));
{
  // at real stars, off the nodes, every law, with the effect on a transit
  const st = Object.fromEntries(['nonlinear', 'quadratic', 'linear', 'sqrt'].map((l) => [l, Stats()]));
  for (const star of STARS) for (const name of Object.keys(LD_TABLE.bands)) for (const law of Object.keys(st)) {
    const mine = bandCoefficients(S, star, band37(name), law), tab = interpLDGrid(grids37[law], star.teff, star.logg, star.feh, name);
    st[law].add(cls(star.teff), kind37(name), profDiff(law, mine.coeffs, law, tab.coeffs).rms, depthDiff(law, mine.coeffs, law, tab.coeffs));
  }
  st.nonlinear.print('(a) at 12 stars off the nodes, four-coefficient law, I(mu) rms', CLASSES, ['broad', 'narrow', 'JWST']);
  st.nonlinear.print('(a) the same', CLASSES, ['broad', 'narrow', 'JWST'], 'depth');
  st.quadratic.print('(a) quadratic law, I(mu) rms', CLASSES, ['broad', 'narrow', 'JWST']);
  for (const law of Object.keys(st)) {
    const s = st[law], bj = ['broad', 'JWST'];
    check(`(a) ${law} law at 12 stars, broad and JWST bands`, s.worst('rms', null, bj) < 7.5e-3 && s.worst('depth', null, bj) < 5e-3 && s.worst('rms', null, ['narrow']) < 4e-3,
      `I(mu) rms median ${e1(s.med('rms', null, bj))}, worst ${e1(s.worst('rms', null, bj))}; depth median ${e1(s.med('depth', null, bj))}, worst ${e1(s.worst('depth', null, bj))}; narrow bands worst ${e1(s.worst('rms', null, ['narrow']))}, depth ${e1(s.worst('depth', null, ['narrow']))}`);
  }
}

// ---- (b) ExoTETHyS / PHOENIX and (c) ExoTETHyS / ATLAS ---------------------------------------------------
{
  const inGrid = (c) => c.teff >= 2300 && c.teff <= 8000 && c.logg >= 4.0;
  const stP = Stats(), stP37 = Stats(), stA = Stats(), stA37 = Stats(), stH = Stats(), stHA = Stats();
  const groupOf = (f) => (/_h\d+$/.test(f) ? 'WFC3 22 nm' : /_w$/.test(f) ? 'WFC3 white' : 'clear');
  for (const c of ref37.cases) {
    if (!inGrid(c) || !ref.curves[c.filter]) continue;
    const star = { teff: c.teff, logg: c.logg, feh: c.feh };
    const mine = bandCoefficients(S, star, ref.curves[c.filter], 'nonlinear').coeffs, tab = interpLDGrid(grids37.nonlinear, c.teff, c.logg, c.feh, c.filter).coeffs;
    const [a, b] = c.model === 'phoenix' ? [stP, stP37] : [stA, stA37];
    a.add(cls(c.teff), 'this table', profDiff('nonlinear', mine, 'nonlinear', c.nonlinear).rms, depthDiff('nonlinear', mine, 'nonlinear', c.nonlinear));
    b.add(cls(c.teff), '37-band table', profDiff('nonlinear', tab, 'nonlinear', c.nonlinear).rms, depthDiff('nonlinear', tab, 'nonlinear', c.nonlinear));
  }
  for (const c of ref.exotethys) {
    const mine = bandCoefficients(S, { teff: c.teff, logg: c.logg, feh: c.feh }, ref.curves[c.filter], 'nonlinear').coeffs;
    (c.model === 'phoenix' ? stH : stHA).add(cls(c.teff), groupOf(c.filter), profDiff('nonlinear', mine, 'nonlinear', c.nonlinear).rms, depthDiff('nonlinear', mine, 'nonlinear', c.nonlinear));
  }
  const both = (x, y, title, what) => { for (const r of CLASSES) { const q = y.get(r, '37-band table'); if (q) for (let i = 0; i < q.rms.length; i++) x.add(r, '37-band table', q.rms[i], q.depth[i]); } x.print(title, CLASSES, ['this table', '37-band table'], what); };
  both(stP, stP37, '(b) against ExoTETHyS/PHOENIX, 16 bands with response curves, [Fe/H] = 0, I(mu) rms');
  stP.print('(b) the same', CLASSES, ['this table', '37-band table'], 'depth');
  check('(b) ExoTETHyS/PHOENIX, 16 photometric bands', stP.worst('rms', null, ['this table']) < 9e-3 && stP.worst('depth', null, ['this table']) < 9e-3 && stP.med('rms', null, ['this table']) < 5e-4,
    `I(mu) rms median ${e1(stP.med('rms', null, ['this table']))}, worst ${e1(stP.worst('rms', null, ['this table']))} (37-band table: ${e1(stP.med('rms', null, ['37-band table']))}, ${e1(stP.worst('rms', null, ['37-band table']))}); depth worst ${e1(stP.worst('depth', null, ['this table']))} (${e1(stP.worst('depth', null, ['37-band table']))})`);
  stH.print('(b) against ExoTETHyS/PHOENIX, HST WFC3 G141 and G102 channels (22 nm wide, 1.1-1.65 and 0.8-1.15 micron) and wide bands, I(mu) rms', CLASSES, ['WFC3 22 nm', 'WFC3 white', 'clear']);
  stH.print('(b) the same', CLASSES, ['WFC3 22 nm', 'WFC3 white', 'clear'], 'depth');
  check('(b) ExoTETHyS/PHOENIX, 39 WFC3 spectroscopic channels', stH.worst('rms', null, ['WFC3 22 nm']) < 1.4e-2 && stH.med('rms', null, ['WFC3 22 nm']) < 8e-4,
    `I(mu) rms median ${e1(stH.med('rms', null, ['WFC3 22 nm']))}, worst ${e1(stH.worst('rms', null, ['WFC3 22 nm']))}; depth median ${e1(stH.med('depth', null, ['WFC3 22 nm']))}, worst ${e1(stH.worst('depth', null, ['WFC3 22 nm']))}`);
  check('(b) ExoTETHyS/PHOENIX, WFC3 white light and clear filters', stH.worst('rms', null, ['WFC3 white', 'clear']) < 7.5e-3, `I(mu) rms worst ${e1(stH.worst('rms', null, ['WFC3 white', 'clear']))}, depth worst ${e1(stH.worst('depth', null, ['WFC3 white', 'clear']))}`);
  both(stA, stA37, '(c) against ExoTETHyS/ATLAS (different atmosphere code), 15 bands, Teff >= 3500 K, I(mu) rms');
  stA.print('(c) the same', CLASSES, ['this table', '37-band table'], 'depth');
  stHA.print('(c) against ExoTETHyS/ATLAS, WFC3 channels and wide bands, I(mu) rms', CLASSES, ['WFC3 22 nm', 'WFC3 white', 'clear']);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length, allA = CLASSES.flatMap((r) => (stA.get(r, 'this table') || { rms: [] }).rms), allA37 = CLASSES.flatMap((r) => (stA.get(r, '37-band table') || { rms: [] }).rms);
  check('(c) ExoTETHyS/ATLAS: the model-to-model spread is the same as for the 37-band table', Math.abs(mean(allA) - mean(allA37)) < 1e-3 && stA.worst('rms', null, ['this table']) < 0.05 && stHA.worst() < 0.05,
    `photometric bands: mean ${f4(mean(allA))} rms, worst ${f4(stA.worst('rms', null, ['this table']))} (37-band table: ${f4(mean(allA37))}, ${f4(stA.worst('rms', null, ['37-band table']))}); WFC3 channels: median ${f4(stHA.med('rms', null, ['WFC3 22 nm']))}, worst ${f4(stHA.worst('rms', null, ['WFC3 22 nm']))}; depth worst ${e1(Math.max(stA.worst('depth', null, ['this table']), stHA.worst('depth')))}`);
}

// ---- (d) narrow channels against direct integration of the model files -----------------------------------
const region = ([lo, hi]) => (hi - lo === 100 ? '2.6-5.5um/100nm' : lo >= 2900 ? '2.9-5.1um/20nm' : lo >= 1000 ? '1-2.6um/40nm' : lo >= 700 ? '700-1000/20nm' : lo >= 400 ? '400-700/20nm' : lo >= 300 ? '300-400/20nm' : '200-300/20nm');
const REGIONS = ['200-300/20nm', '300-400/20nm', '400-700/20nm', '700-1000/20nm', '1-2.6um/40nm', '2.9-5.1um/20nm', '2.6-5.5um/100nm'];
{
  const st = Stats(), stQ = Stats();
  for (const node of ref.direct) ref.channels.forEach((ch, i) => {
    const mine = bandCoefficients(S, node, ch, 'nonlinear').coeffs;
    st.add(cls(node.teff), region(ch), profDiff('nonlinear', mine, 'nonlinear', node.a[i]).rms, depthDiff('nonlinear', mine, 'nonlinear', node.a[i]));
    const q = bandCoefficients(S, node, ch, 'quadratic').coeffs;
    stQ.add(cls(node.teff), region(ch), profDiff('quadratic', q, 'nonlinear', node.a[i]).rms);
  });
  st.print(`(d) ${ref.channels.length} narrow channels at ${ref.direct.length} model nodes against direct integration, four-coefficient law, I(mu) rms`, CLASSES, REGIONS);
  st.print('(d) the same', CLASSES, REGIONS, 'depth');
  stQ.print('(d) for scale: what a quadratic law loses on the same profiles (its own misfit, not an error of the table), I(mu) rms', CLASSES, REGIONS);
  const warm = CLASSES.slice(1), vis = ['400-700/20nm', '700-1000/20nm'], ir = ['1-2.6um/40nm', '2.9-5.1um/20nm', '2.6-5.5um/100nm'];
  check('(d) 20 nm channels, 400-1000 nm, Teff >= 3000 K', st.worst('rms', warm, vis) < 4e-3 && st.med('rms', warm, vis) < 8e-4 && st.worst('depth', warm, vis) < 3.5e-3,
    `I(mu) rms median ${e1(st.med('rms', warm, vis))}, worst ${e1(st.worst('rms', warm, vis))}; depth median ${e1(st.med('depth', warm, vis))}, worst ${e1(st.worst('depth', warm, vis))}`);
  check('(d) infrared channels (40 nm to 2.6 micron; 20 and 100 nm to 5.5 micron), Teff >= 3000 K', st.worst('rms', warm, ir) < 9e-3 && st.med('rms', warm, ir) < 6e-4 && st.worst('depth', warm, ir) < 5.5e-3,
    `I(mu) rms median ${e1(st.med('rms', warm, ir))}, worst ${e1(st.worst('rms', warm, ir))}; depth median ${e1(st.med('depth', warm, ir))}, worst ${e1(st.worst('depth', warm, ir))}`);
  check('(d) late M dwarfs (2500, 2800 K), 400 nm to 5.5 micron', st.worst('rms', ['M late'], [...vis, ...ir]) < 7e-3 && st.med('rms', ['M late'], [...vis, ...ir]) < 1.1e-3,
    `I(mu) rms median ${e1(st.med('rms', ['M late'], [...vis, ...ir]))}, worst ${e1(st.worst('rms', ['M late'], [...vis, ...ir]))}; depth median ${e1(st.med('depth', ['M late'], [...vis, ...ir]))}, worst ${e1(st.worst('depth', ['M late'], [...vis, ...ir]))}`);
  const uv = ['200-300/20nm', '300-400/20nm'];
  check('(d) ultraviolet, 200-400 nm, 20 nm channels, all stars', st.worst('rms', null, uv) < 6e-3 && st.med('rms', null, uv) < 1.4e-3,
    `I(mu) rms median ${e1(st.med('rms', null, uv))}, worst ${e1(st.worst('rms', null, uv))}; depth median ${e1(st.med('depth', null, uv))}, worst ${e1(st.worst('depth', null, uv))} (agreement with the model files only: below about 300 nm cool-star models are not to be trusted)`);

  // what a custom range got before: the grey atmosphere, against the same direct integrations
  const g = Stats(), sub = ref.channels.map((ch, i) => [ch, i]).filter(([ch], i) => ch[0] >= 300 && i % 6 === 0);
  for (const node of ref.direct.filter((n) => n.feh === 0 && [2800, 3500, 4400, 5800, 6600].includes(n.teff))) for (const [ch, i] of sub) {
    const grey = fitLaw('nonlinear', greyProfile(node.teff, ch[0], ch[1], { nmu: 40 })).coeffs, mine = bandCoefficients(S, node, ch, 'nonlinear').coeffs;
    g.add('grey', 'all', profDiff('nonlinear', grey, 'nonlinear', node.a[i]).rms, depthDiff('nonlinear', grey, 'nonlinear', node.a[i]));
    g.add('table', 'all', profDiff('nonlinear', mine, 'nonlinear', node.a[i]).rms, depthDiff('nonlinear', mine, 'nonlinear', node.a[i]));
  }
  check('a custom range is far closer to the models than the grey estimate it replaces', g.med('rms', ['table']) < 0.1 * g.med('rms', ['grey']),
    `${g.get('grey', 'all').rms.length} channels from 300 nm, 5 stars: grey atmosphere I(mu) rms median ${f4(g.med('rms', ['grey']))}, worst ${f4(g.worst('rms', ['grey']))}, depth median ${e1(g.med('depth', ['grey']))}; this table ${f4(g.med('rms', ['table']))}, ${f4(g.worst('rms', ['table']))}, ${e1(g.med('depth', ['table']))}`);
}

// ---- the interface -----------------------------------------------------------------------------------
{
  const sun = { teff: 5772, logg: 4.44, feh: 0 };
  // a response curve that is flat between two wavelengths is that boxcar
  const box = bandCoefficients(S, sun, [600, 1000]).coeffs, flat = bandCoefficients(S, sun, { wl: [600, 600.001, 999.999, 1000], response: [0, 1, 1, 0] }).coeffs;
  check('a flat response curve equals the boxcar', profDiff('nonlinear', box, 'nonlinear', flat).max < 1e-4, `largest I(mu) difference ${e1(profDiff('nonlinear', box, 'nonlinear', flat).max)}`);
  const rev = bandCoefficients(S, sun, { wl: [...ref.curves['TESS (approx.)'].wl].reverse(), response: [...ref.curves['TESS (approx.)'].response].reverse() }).coeffs;
  check('a response curve may be listed in either direction', profDiff('nonlinear', rev, 'nonlinear', bandCoefficients(S, sun, ref.curves['TESS (approx.)']).coeffs).max < 1e-12);
  const W = bandWeights(S, [500, 510]);
  check('weights of a range are the fraction of each bin inside it', Math.abs(W.w.reduce((s, w, b) => s + w * (S.edges[b + 1] - S.edges[b]), 0) - 10) < 1e-9 && W.coverage === 1);
  const mono = bandCoefficients(S, sun, [656.3, 656.3]);
  check('a single wavelength takes the bin that holds it', mono.nBins === 1 && mono.coeffs.every(Number.isFinite) && !mono.clamped);
  const part = bandCoefficients(S, sun, [5000, 6000]), far = (() => { try { bandCoefficients(S, sun, [6000, 7000]); return false; } catch (e) { return /outside/.test(e.message); } })();
  check('a band reaching beyond 5500 nm is flagged, one wholly outside is refused', part.clamped && Math.abs(part.coverage - 0.5) < 1e-9 && far, `coverage ${part.coverage}`);
  const hot = bandCoefficients(S, { teff: 9600, logg: 4.1, feh: 0 }, [500, 600]), giant = bandCoefficients(S, { teff: 4800, logg: 2.5, feh: 0 }, [500, 600]), inside = bandCoefficients(S, sun, [500, 600]);
  check('stars outside the grid are clamped and flagged', hot.clamped && giant.clamped && !inside.clamped && inside.coverage === 1);
  const laws = { linear: 1, quadratic: 2, kipping: 2, sqrt: 2, nonlinear: 4, uniform: 0 };
  check('every law is served', Object.entries(laws).every(([law, n]) => { const c = bandCoefficients(S, sun, [430, 890], law).coeffs; return c.length === n && c.every(Number.isFinite); }));
  const p = bandProfile(S, sun, [430, 890]);
  check('profile for plotting', p.mu.length === 60 && Math.abs(p.I[59] - 1) < 1e-12 && p.I[0] > 0 && p.I[0] < p.I[30] && p.coeffs.length === 4);
  // the star matters: gravity and metallicity change a custom range (the grey estimate ignored both)
  const dg = profDiff('nonlinear', bandCoefficients(S, { ...sun, logg: 4.0 }, [400, 480]).coeffs, 'nonlinear', bandCoefficients(S, { ...sun, logg: 5.0 }, [400, 480]).coeffs).rms;
  const dz = profDiff('nonlinear', bandCoefficients(S, { ...sun, feh: -0.5 }, [400, 480]).coeffs, 'nonlinear', bandCoefficients(S, { ...sun, feh: 0.5 }, [400, 480]).coeffs).rms;
  check('a custom range responds to log g and [Fe/H]', dg > 1e-3 && dz > 1e-3, `Sun, 400-480 nm: 1 dex in log g moves I(mu) by ${f4(dg)} rms, 1 dex in [Fe/H] by ${f4(dz)}`);
  // keepPhysical leaves a physical profile alone and repairs an unphysical one with little change above mu = 0.1
  const good = [0.5, -0.1, 0.45, -0.2], g0 = good.slice(), bad = [1.9, -2.6, 2.9, -1.1], b0 = bad.slice();
  const touchedGood = keepPhysical(good), touchedBad = keepPhysical(bad);
  check('keepPhysical', !touchedGood && good.every((v, i) => v === g0[i]) && touchedBad && !checkProfile(b0).ok && checkProfile(bad).ok, `repair moved I(mu) by ${e1(profDiff('nonlinear', bad, 'nonlinear', b0).rms)} rms on mu >= 0.1`);
}

// ---- (e) following the star in a fit ----------------------------------------------------------------------
// The tie as it was before this table existed: 17 x 7 evenly spaced points over the prior range.
function oldTie(tie) {
  const nT = 17, [t0, t1] = tie.teffRange, nZ = 7, [z0, z1] = tie.fehRange;
  const at = (T, Z) => interpLDGrid(tie.grid, T, tie.logg, Z, tie.filter).coeffs;
  const nc = at(0.5 * (t0 + t1), 0.5 * (z0 + z1)).length, tab = new Float64Array(nT * nZ * nc);
  for (let i = 0; i < nT; i++) for (let j = 0; j < nZ; j++) tab.set(at(t0 + ((t1 - t0) * i) / (nT - 1), z0 + ((z1 - z0) * j) / (nZ - 1)), (i * nZ + j) * nc);
  return (teff, feh, out) => {
    let x = ((teff - t0) / (t1 - t0)) * (nT - 1); x = x < 0 ? 0 : x > nT - 1 ? nT - 1 : x;
    const i = Math.min(nT - 2, Math.floor(x)), fx = x - i;
    let y = ((feh - z0) / (z1 - z0)) * (nZ - 1); y = y < 0 ? 0 : y > nZ - 1 ? nZ - 1 : y; const j = Math.min(nZ - 2, Math.floor(y)), fy = y - j;
    for (let k = 0; k < nc; k++) {
      const a = tab[(i * nZ + j) * nc + k], b = tab[((i + 1) * nZ + j) * nc + k], c = tab[(i * nZ + j + 1) * nc + k], d = tab[((i + 1) * nZ + j + 1) * nc + k];
      out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return out;
  };
}
{
  const out = [0, 0, 0, 0];
  // accuracy of the lookup against the direct interpolation, old and new, for three prior widths
  const rows = [];
  let worstNew = 0;
  for (const [label, logg, tr] of [['G dwarf, 600 K wide', 4.4, [5265, 5865]], ['M dwarf, 600 K wide', 4.9, [2800, 3400]], ['M dwarf, 2000 K wide', 4.9, [2300, 4300]], ['whole table', 4.5, [2300, 8000]]]) {
    let wOld = 0, wNew = 0;
    for (const band of [[600, 1000], [500, 520], [1100, 1700]]) {
      const spec = spectralTieSpec(S, { law: 'nonlinear', band, logg, teffRange: tr, fehRange: [-0.4, 0.4] }), tNew = makeLDTie(spec), tOld = oldTie(spec);
      for (let T = tr[0]; T <= tr[1]; T += (tr[1] - tr[0]) / 331) for (const Z of [-0.4, -0.13, 0.02, 0.29]) {
        const direct = bandCoefficients(S, { teff: T, logg, feh: Z }, band, 'nonlinear').coeffs;
        wNew = Math.max(wNew, profDiff('nonlinear', tNew(T, Z, out), 'nonlinear', direct).rms);
        wOld = Math.max(wOld, profDiff('nonlinear', tOld(T, Z, out), 'nonlinear', direct).rms);
      }
    }
    rows.push(`${label}: 17 x 7 points ${e1(wOld)}, now ${e1(wNew)}`); worstNew = Math.max(worstNew, wNew);
  }
  check('the tie reproduces the direct interpolation for any prior width', worstNew < 1e-9, 'worst I(mu) rms. ' + rows.join('; '));
  // the same repair applies to listed bands of the 37-band table
  {
    const spec = { law: 'nonlinear', source: 'grid', grid: grids37.nonlinear, filter: 'TESS (approx.)', logg: 4.9, teffRange: [2300, 4300], fehRange: [-0.4, 0.4] }, tNew = makeLDTie(spec), tOld = oldTie(spec);
    let wOld = 0, wNew = 0;
    for (let T = 2300; T <= 4300; T += 6.1) for (const Z of [-0.4, -0.13, 0.02, 0.29]) {
      const direct = interpLDGrid(grids37.nonlinear, T, 4.9, Z, 'TESS (approx.)').coeffs;
      wNew = Math.max(wNew, profDiff('nonlinear', tNew(T, Z, out), 'nonlinear', direct).rms); wOld = Math.max(wOld, profDiff('nonlinear', tOld(T, Z, out), 'nonlinear', direct).rms);
    }
    check('makeLDTie on the 37-band table, M dwarf with a 2000 K wide prior', wNew < 1e-9, `worst I(mu) rms ${e1(wNew)} (17 x 7 points: ${e1(wOld)})`);
  }
  // grey fallback (no table nodes): unchanged, 17 points
  {
    const tie = makeLDTie({ law: 'quadratic', source: 'grey', band: [500, 900], logg: 4.4, teffRange: [5300, 5900], fehRange: [0, 0] });
    const c = fitLaw('quadratic', greyProfile(5519, 500, 900, { nmu: 40 })).coeffs; tie(5519, 0, out);
    check('grey tie still works', Math.abs(out[0] - c[0]) < 2e-4 && Math.abs(out[1] - c[1]) < 2e-4);
  }
  // the spec crosses to the fit worker by structured cloning and still gives the same function
  {
    const spec = spectralTieSpec(S, { law: 'quadratic', band: [430, 890], logg: 4.4, teffRange: [5265, 5865], fehRange: [0.05, 0.65] });
    const a = makeLDTie(spec)(5565, 0.35, [0, 0]), b = makeLDTie(structuredClone(spec))(5565, 0.35, [0, 0]), c = bandCoefficients(S, { teff: 5565, logg: 4.4, feh: 0.35 }, [430, 890], 'quadratic').coeffs;
    check('tie specification survives structured cloning', a[0] === b[0] && a[1] === b[1] && Math.abs(a[0] - c[0]) < 1e-12 && Math.abs(a[1] - c[1]) < 1e-12, `${(JSON.stringify(spec).length / 1024).toFixed(0)} kB as JSON`);
  }

  // speed: a million calls of the function the likelihood uses
  const N = 1e6;
  const NA = 4096, argT = new Float64Array(NA), argZ = new Float64Array(NA);
  const bench = (tie, tr) => {
    for (let i = 0; i < NA; i++) { argT[i] = tr[0] + (((i * 7919) % 4093) / 4093) * (tr[1] - tr[0]); argZ[i] = ((i % 97) - 48) / 120; }   // arguments in scrambled order
    for (let i = 0; i < 2e5; i++) tie(argT[i & 4095], 0.1, out);                      // warm up
    let best = Infinity, s = 0;
    for (let rep = 0; rep < 7; rep++) {
      const t = performance.now();
      for (let i = 0; i < N; i++) { tie(argT[i & 4095], argZ[i & 4095], out); s += out[0]; }
      best = Math.min(best, performance.now() - t);
    }
    return { ns: (best / N) * 1e6, s };
  };
  const tr = [5265, 5865], opts = { law: 'nonlinear', band: [512, 878], logg: 4.4, teffRange: tr, fehRange: [0.05, 0.65] };
  t0 = performance.now(); const spec = spectralTieSpec(S, opts); const tSpec = performance.now() - t0;         // a band not used above: not cached
  t0 = performance.now(); const tie = makeLDTie(spec); const tTie = performance.now() - t0;
  const now = bench(tie, tr), old = bench(oldTie(spec), tr), wide = bench(makeSpectralTie(S, { ...opts, teffRange: [2300, 8000], fehRange: [-0.5, 0.5] }), [2300, 8000]);
  const quad = bench(makeSpectralTie(S, { ...opts, law: 'quadratic' }), tr);
  const h0 = process.memoryUsage().heapUsed; for (let i = 0; i < N; i++) tie(5300 + (i % 500), 0.2, out); const grew = process.memoryUsage().heapUsed - h0;
  check('tie: a million calls, under 100 ns each', now.ns < 100 && wide.ns < 100 && quad.ns < 100,
    `${now.ns.toFixed(1)} ns per call (four coefficients, 600 K prior), ${quad.ns.toFixed(1)} ns (quadratic), ${wide.ns.toFixed(1)} ns (prior over the whole table, 73 x 9 knots); the 17 x 7 lookup it replaces: ${old.ns.toFixed(1)} ns`);
  check('tie: no allocation in the call', grew < 2e6 && tie(5500, 0.2, out) === out, `heap changed by ${(grew / 1024).toFixed(0)} kB over a million calls`);
  // setting up: once per fit (and once per band the user picks)
  t0 = performance.now(); const greyTie = makeLDTie({ law: 'nonlinear', source: 'grey', band: [512, 878], logg: 4.4, teffRange: tr, fehRange: [0, 0] }); const tGrey = performance.now() - t0;
  greyTie(5500, 0, out);
  t0 = performance.now(); for (let i = 0; i < 2000; i++) bandCoefficients(S, { teff: 5300 + (i % 500), logg: 4.4, feh: 0.2 }, [512, 878], 'nonlinear'); const tCoef = (performance.now() - t0) / 2000;
  check('setting up a tie for a custom band is quick', tSpec + tTie < 500, `band at every node ${tSpec.toFixed(0)} ms + lookup ${tTie.toFixed(1)} ms; the grey estimate it replaces took ${tGrey.toFixed(0)} ms. Outside a fit, bandCoefficients() on a cached band costs ${(tCoef * 1e3).toFixed(1)} microseconds`);
}
process.exit(ok ? 0 : 1);
