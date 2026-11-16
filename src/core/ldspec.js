// Limb darkening for ANY bandpass from the wavelength-resolved table (src/data/ld_spectral.js, built from
// PHOENIX specific intensities by tools/build_ld_spectral.py; accuracy measured in test/ldspec.test.mjs).
//
// The table holds, for each stellar model node (Teff, log g, [Fe/H]) and each of 357 wavelength bins from 200
// to 5500 nm (about lambda / 120 wide: 5 nm below 900 nm, 45 nm at 5.4 micron), the four Claret coefficients of
// the bin's intensity profile and the bin's photon-weighted centre intensity F, compressed as a mean plus 40
// principal components.
//
// A band is a set of weights w_b over the bins: the fraction of each bin inside a wavelength range, or a
// response curve averaged over each bin. Its profile is the photon-weighted mean of the bins' profiles,
//     I_band(mu) = sum_b w_b F_b I_b(mu) / sum_b w_b F_b,
// and because every I_b is 1 at the centre and the Claret law is linear in its coefficients, the band's
// four coefficients are the same weighted mean of the bins' coefficients. Nothing is fitted to combine bins.
//
// The stellar dependence is handled exactly as for the bundled 37-band table, by the same code: bandTable()
// evaluates the band at every model node and returns a table in that format, so gridFromTable(),
// interpLDGrid() and makeLDTie() of ldest.js give the other laws, the trilinear interpolation with its
// `clamped` flag, and the function a fit calls. A custom band therefore behaves like a listed one.
//
// No DOM, no three.js. The table module is data only; load it lazily:
//     const { LD_SPECTRAL_COMPACT } = await import('../data/ld_spectral.js');
//     const spectral = expandSpectral(LD_SPECTRAL_COMPACT);
import { expandLDTable, gridFromTable, interpLDGrid, makeLDTie } from './ldest.js';
import { intensity } from './limbdark.js';

const MISSING = -32768;
const FILE_BIN = 5;          // nm: bin width of the model files; the table's bin edges are multiples of it

function int16FromBase64(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) { const u = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); out[i] = u >= 0x8000 ? u - 0x10000 : u; }
  return out;
}

/**
 * Decode the compact table (format 'esl-ld-spectral-1') into typed arrays. The result is what every other
 * function here takes as `table`; treat it as read-only. About 1 ms.
 */
export function expandSpectral(t) {
  if (!t || t.format !== 'esl-ld-spectral-1') throw new Error('Not a spectral limb darkening table (format esl-ld-spectral-1).');
  const nb = t.edges.length - 1, K = t.ncomp, nNodes = t.teff.length * t.logg.length * t.feh.length;
  const mean = Float64Array.from(int16FromBase64(t.mean16), (v) => v * t.meanScale);
  const basis = Float64Array.from(int16FromBase64(t.basis16), (v) => v * t.basisScale);
  const s16 = int16FromBase64(t.scores16);
  if (mean.length !== nb * 5 || basis.length !== K * nb * 5 || s16.length !== nNodes * K) throw new Error('Spectral limb darkening table: array sizes do not match its axes.');
  const scores = new Float64Array(nNodes * K), held = new Uint8Array(nNodes);
  for (let n = 0; n < nNodes; n++) {
    held[n] = s16[n * K] !== MISSING ? 1 : 0;
    if (held[n]) for (let c = 0; c < K; c++) scores[n * K + c] = s16[n * K + c] * t.scoreScale[c];
  }
  return {
    format: t.format, source: t.source, built: t.built, mu_min: t.mu_min ?? 0.1,
    teff: t.teff.slice(), logg: t.logg.slice(), feh: t.feh.slice(), filled: t.filled,
    edges: Float64Array.from(t.edges), nb, K, range: [t.edges[0], t.edges[nb]], split: t.split,
    mean, basis, scores, held, toClaret: t.toClaret.map((r) => r.slice()), lnFScale: t.lnFScale,
  };
}

// ---- bands ------------------------------------------------------------------------------------

const isRange = (band) => Array.isArray(band) && band.length === 2 && typeof band[0] === 'number';

/**
 * Weights of a band over the table's bins.
 *   band = [wlMinNm, wlMaxNm]                 a boxcar (equal limits: the bin holding that wavelength)
 *   band = { wl: [nm...], response: [...] }   a response curve (per photon), linear between its points, 0 outside
 * Returns { w, b0, b1, coverage, key }: w[b] for b0 <= b < b1 is the mean response over bin b; `coverage` is the
 * fraction of the band's integrated response that lies inside the table's wavelength range (1 when all of it).
 * Throws if none of the band is inside.
 */
export function bandWeights(table, band) {
  const { edges, nb } = table, w = new Float64Array(nb);
  let inside = 0, total = 0, key;
  if (isRange(band)) {
    let [lo, hi] = band; if (hi < lo) [lo, hi] = [hi, lo];
    if (!(Number.isFinite(lo) && Number.isFinite(hi))) throw new Error('The wavelength range is not a pair of numbers.');
    key = 'r' + lo + ':' + hi;
    if (hi === lo) {
      if (lo >= edges[0] && lo <= edges[nb]) { let b = 0; while (b < nb - 1 && edges[b + 1] <= lo) b++; w[b] = 1; inside = total = 1; }
    } else {
      total = hi - lo;
      for (let b = 0; b < nb; b++) {
        const o = Math.min(edges[b + 1], hi) - Math.max(edges[b], lo);
        if (o > 0) { w[b] = o / (edges[b + 1] - edges[b]); inside += o; }
      }
    }
  } else if (band && band.wl && band.response && band.wl.length === band.response.length && band.wl.length > 1) {
    const x = band.wl, y = band.response, n = x.length;
    key = 'c' + n + ':' + Array.prototype.join.call(x, ',') + ':' + Array.prototype.join.call(y, ',');
    const up = x[n - 1] >= x[0];
    const R = (wl) => {   // linear interpolation, 0 outside; the curve may be listed in either direction
      let i0 = 0, i1 = n - 1; const a = up ? x[0] : x[n - 1], z = up ? x[n - 1] : x[0];
      if (!(wl >= a && wl <= z)) return 0;
      while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if ((x[m] <= wl) === up) i0 = m; else i1 = m; }
      const d = x[i1] - x[i0]; return Math.max(0, d === 0 ? y[i0] : y[i0] + ((y[i1] - y[i0]) * (wl - x[i0])) / d);
    };
    // integral of the whole curve (trapezoid), and its mean over each bin sampled at the centres of the model
    // files' 5 nm bins (what tools/build_ld_table.py does for the listed bands)
    for (let i = 1; i < n; i++) total += 0.5 * (Math.max(0, y[i]) + Math.max(0, y[i - 1])) * Math.abs(x[i] - x[i - 1]);
    for (let b = 0; b < nb; b++) {
      const m = Math.max(1, Math.round((edges[b + 1] - edges[b]) / FILE_BIN)), h = (edges[b + 1] - edges[b]) / m;
      let s = 0; for (let i = 0; i < m; i++) s += R(edges[b] + (i + 0.5) * h);
      w[b] = s / m; inside += s * h;
    }
    // a curve narrower than the sampling can fall between the sample points: use its centroid's bin
    if (!(inside > 0) && total > 0) {
      let c = 0; for (let i = 1; i < n; i++) c += 0.25 * (Math.max(0, y[i]) + Math.max(0, y[i - 1])) * Math.abs(x[i] - x[i - 1]) * (x[i] + x[i - 1]);
      c /= total;
      if (c >= edges[0] && c <= edges[nb]) { let b = 0; while (b < nb - 1 && edges[b + 1] <= c) b++; w[b] = 1; inside = total; }
    }
  } else throw new Error('A band is [wlMinNm, wlMaxNm] or { wl: [...], response: [...] }.');
  let b0 = 0, b1 = nb; while (b0 < nb && !(w[b0] > 0)) b0++; while (b1 > b0 && !(w[b1 - 1] > 0)) b1--;
  if (b0 >= b1) throw new Error(`The band lies outside the wavelength range of the limb darkening table (${edges[0]} to ${edges[nb]} nm).`);
  return { w, b0, b1, coverage: Math.min(1, inside / total), key };
}

// ---- keeping a combined profile physical ------------------------------------------------------------
// The model treats a profile that goes negative or brightens toward the limb as outside the prior
// (checkProfile in limbdark.js, sampled at mu = i/200), so coefficients handed out for a star must do neither,
// including below mu = 0.1 where the law is an extrapolation. The 37-band builder refits such profiles under
// linear inequality constraints: I(mu_j+1) - I(mu_j) >= 3e-5 on mu = i/200 and i/24, I(0) >= 0.002. The
// constrained least-squares fit is the point of that convex region nearest the unconstrained fit a in the
// norm of the fit's normal matrix H, so it can be found here from a alone: Hildreth's row-action method,
// 4 unknowns and 222 constraints. H is taken for the 15 points evenly spaced in mu from 0.1285 to 1 that the
// model files give above mu = 0.1.
const basisRow = (m) => { const s = Math.sqrt(m); return [1 - s, 1 - m, 1 - m * s, 1 - m * m]; };
const MARGIN_STEP = 3e-5, MARGIN_LIMB = 2e-3;
let PHYS = null;
function physSetup() {
  const mus = new Set(); for (let i = 0; i <= 200; i++) mus.add(i / 200); for (let i = 0; i <= 24; i++) mus.add(i / 24);
  const mu = [...mus].sort((a, b) => a - b), rows = mu.map(basisRow);
  // constraints C a <= d: -(I_j+1 - I_j) = (B_j+1 - B_j) a ... written with I = 1 - B a: I_j+1 - I_j = (B_j - B_j+1) a
  const C = [], d = [];
  for (let j = 0; j + 1 < mu.length; j++) { C.push(rows[j].map((v, k) => rows[j + 1][k] - v)); d.push(-MARGIN_STEP); }
  C.push(rows[0].slice()); d.push(1 - MARGIN_LIMB);
  const H = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 15; i++) { const g = basisRow(1 - 0.06225 * i); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) H[r][c] += g[r] * g[c]; }
  const Hi = invert4(H), nC = C.length, HiC = new Float64Array(nC * 4), den = new Float64Array(nC), Cf = new Float64Array(nC * 4);
  for (let i = 0; i < nC; i++) {
    for (let r = 0; r < 4; r++) { let s = 0; for (let c = 0; c < 4; c++) s += Hi[r][c] * C[i][c]; HiC[i * 4 + r] = s; Cf[i * 4 + r] = C[i][r]; }
    for (let r = 0; r < 4; r++) den[i] += C[i][r] * HiC[i * 4 + r];
  }
  return { nC, C: Cf, d: Float64Array.from(d), HiC, den, lam: new Float64Array(nC) };
}
function invert4(M) {
  const n = 4, A = M.map((r, i) => [...r, ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    const f = A[i][i]; for (let c = 0; c < 2 * n; c++) A[i][c] /= f;
    for (let r = 0; r < n; r++) if (r !== i) { const g = A[r][i]; if (g !== 0) for (let c = 0; c < 2 * n; c++) A[r][c] -= g * A[i][c]; }
  }
  return A.map((r) => r.slice(n));
}
/**
 * Make the Claret coefficients a (array of 4, modified in place) physical in the sense above.
 * Returns true if they had to be changed. `margin` scales the room kept from the boundary (1: as the builder).
 */
export function keepPhysical(a, margin = 1) {
  const { nC, C, HiC, den, lam } = PHYS || (PHYS = physSetup());
  // g(i, m) <= 0 is constraint i with m times the builder's margin
  const g = (i, m) => C[i * 4] * a[0] + C[i * 4 + 1] * a[1] + C[i * 4 + 2] * a[2] + C[i * 4 + 3] * a[3] - (i === nC - 1 ? 1 - m * MARGIN_LIMB : -m * MARGIN_STEP);
  let bad = false; for (let i = 0; i < nC && !bad; i++) if (g(i, margin) > 1e-9) bad = true;
  if (!bad) return false;
  lam.fill(0);
  for (let sweep = 0; sweep < 4000; sweep++) {
    let moved = 0;
    for (let i = 0; i < nC; i++) {
      const v = g(i, margin); if (v <= 0 && lam[i] === 0) continue;
      const nl = Math.max(0, lam[i] + v / den[i]), dl = nl - lam[i];
      if (dl !== 0) { for (let r = 0; r < 4; r++) a[r] -= HiC[i * 4 + r] * dl; lam[i] = nl; moved = Math.max(moved, Math.abs(dl) * den[i]); }
    }
    if (moved < 1e-10) break;
  }
  // The iteration approaches the region from outside. Whatever is left of a violation (measured with half the
  // margin) is removed by moving toward a linear law, which is strictly inside: the region is convex, so the
  // segment from a to it crosses the boundary once.
  const u = Math.min(0.9, Math.max(0.1, a[0] + a[1] + a[2] + a[3])), h = 0.5 * margin;
  let s = 0;
  for (let i = 0; i < nC; i++) {
    const v = g(i, h);
    if (v > 0) { const vt = C[i * 4 + 1] * u - (i === nC - 1 ? 1 - h * MARGIN_LIMB : -h * MARGIN_STEP); s = Math.max(s, v / (v - vt)); }
  }
  if (s > 0) { s = Math.min(1, s); a[0] *= 1 - s; a[1] = a[1] * (1 - s) + u * s; a[2] *= 1 - s; a[3] *= 1 - s; }
  return true;
}

// ---- a band at every model node ----------------------------------------------------------------------

/** Unconstrained Claret coefficients of the band (weights from bandWeights) at node index n, into out[0..3]. */
function nodeBand(table, n, W, out) {
  const { K, nb, mean, basis, scores, toClaret, lnFScale } = table, nx = nb * 5, so = n * K;
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0, sw = 0, ref = 0;
  for (let b = W.b0; b < W.b1; b++) {
    if (!(W.w[b] > 0)) continue;
    const o = b * 5;
    let x0 = mean[o], x1 = mean[o + 1], x2 = mean[o + 2], x3 = mean[o + 3], x4 = mean[o + 4];
    for (let c = 0; c < K; c++) { const s = scores[so + c], q = c * nx + o; x0 += s * basis[q]; x1 += s * basis[q + 1]; x2 += s * basis[q + 2]; x3 += s * basis[q + 3]; x4 += s * basis[q + 4]; }
    const lnF = x4 / lnFScale; if (sw === 0) ref = lnF;                 // F relative to the first bin: no overflow
    const f = W.w[b] * Math.exp(lnF - ref);
    c0 += f * x0; c1 += f * x1; c2 += f * x2; c3 += f * x3; sw += f;
  }
  c0 /= sw; c1 /= sw; c2 /= sw; c3 /= sw;
  for (let r = 0; r < 4; r++) out[r] = toClaret[r][0] * c0 + toClaret[r][1] * c1 + toClaret[r][2] * c2 + toClaret[r][3] * c3;
  return out;
}

const bandCache = new WeakMap();
const CACHE_MAX = 64;       // bands kept per table (a spectroscopic data set can ask for many channels)

/**
 * The band evaluated at every stellar model node, as a table in the format of the bundled 37-band table
 * (what expandLDTable() returns: rows with teff, logg, feh, filter, linear, quadratic, nonlinear; one filter,
 * named `name`). Pass it to gridFromTable() / interpLDGrid() / makeLDTie() of ldest.js, or keep it where the
 * app keeps a loaded table. Profiles are kept physical (keepPhysical); `constrained` counts the nodes where
 * that changed something, and `coverage` is the fraction of the band inside the table's wavelength range.
 * Results are cached per table and band (the name is not part of the key: the first name given is kept).
 * Cost: a few ms for a filter, about 40 ms for a band spanning the whole table (plus the constraint, where needed).
 */
export function bandTable(table, band, name = 'band') {
  let cache = bandCache.get(table);
  if (!cache) bandCache.set(table, (cache = new Map()));
  const W = bandWeights(table, band);
  const hit = cache.get(W.key);
  if (hit) { cache.delete(W.key); cache.set(W.key, hit); return hit; }       // most recently used last
  const nT = table.teff.length, nG = table.logg.length, nZ = table.feh.length, a = new Float64Array(nT * nG * nZ * 4), tmp = [0, 0, 0, 0];
  let constrained = 0;
  for (let n = 0; n < nT * nG * nZ; n++) {
    if (!table.held[n]) { a.fill(MISSING, n * 4, n * 4 + 4); continue; }
    nodeBand(table, n, W, tmp);
    if (keepPhysical(tmp)) constrained++;
    a.set(tmp, n * 4);
  }
  const lo = isRange(band) ? Math.min(band[0], band[1]) : Math.min(band.wl[0], band.wl[band.wl.length - 1]);
  const hi = isRange(band) ? Math.max(band[0], band[1]) : Math.max(band.wl[0], band.wl[band.wl.length - 1]);
  const t = expandLDTable({
    format: 'esl-ld-compact-1', source: table.source, built: table.built, mu_min: table.mu_min, nmu: 200, sampling: 'r',
    teff: table.teff, logg: table.logg, feh: table.feh, filled: table.filled,
    filters: { [name]: { band: [lo, hi], passband: isRange(band) ? `boxcar ${lo}-${hi} nm` : 'response curve', dataset: 'spectral', scale: 1, a } },
  });
  t.spectral = { band: [lo, hi], bins: [W.b0, W.b1], nBins: W.b1 - W.b0, coverage: W.coverage, constrained, name };
  cache.set(W.key, t);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return t;
}

/**
 * Coefficients of `law` ('linear', 'quadratic', 'kipping', 'sqrt', 'nonlinear', 'uniform') for a star in a band.
 *   star = { teff, logg, feh };  band = [wlMinNm, wlMaxNm] or { wl: [...], response: [...] }
 * Returns { coeffs, clamped, method, coverage, nBins, law }. `clamped` is true when the star is outside the
 * table (Teff 2300-8000 K, log g 4.0-5.0 or 5.5 below 4000 K, [Fe/H] -0.5 to 0.5; the nearest edge is used)
 * or when part of the band is outside 200-5500 nm (`coverage` < 1; only the part inside is used).
 */
export function bandCoefficients(table, star, band, law = 'nonlinear') {
  const t = bandTable(table, band), sp = t.spectral;
  if (law === 'uniform') return { coeffs: [], clamped: sp.coverage < 0.999, method: 'uniform', coverage: sp.coverage, nBins: sp.nBins, law };
  const r = interpLDGrid(gridFromTable(t, law), star.teff, star.logg, star.feh ?? 0, sp.name);
  return { coeffs: r.coeffs, clamped: r.clamped || sp.coverage < 0.999, starClamped: r.clamped, method: r.method, coverage: sp.coverage, nBins: sp.nBins, law };
}

/**
 * I(mu)/I(1) of the band for a star, for plotting: { mu, I, coeffs (four Claret coefficients), clamped, coverage }.
 * mu runs evenly from muMin to 1, the same shape greyProfile() returns. Below mu = 0.1 the law is an
 * extrapolation of the fit (the model atmospheres have almost no points there).
 */
export function bandProfile(table, star, band, { nmu = 60, muMin = 0.02 } = {}) {
  const r = bandCoefficients(table, star, band, 'nonlinear');
  const mu = new Float64Array(nmu), I = new Float64Array(nmu);
  for (let k = 0; k < nmu; k++) { mu[k] = muMin + ((1 - muMin) * k) / (nmu - 1); I[k] = intensity(mu[k], r.coeffs); }
  return { mu, I, coeffs: r.coeffs, clamped: r.clamped, coverage: r.coverage };
}

/**
 * The `ldTie` entry of a fit specification for a custom band: a plain object that survives structured cloning
 * to the fit worker, in the form makeLDTie() of ldest.js (and so buildProblem) already understands.
 *   opts = { law, band, logg, teffRange: [lo, hi], fehRange: [lo, hi] }
 */
export function spectralTieSpec(table, { law, band, logg, teffRange, fehRange }) {
  const t = bandTable(table, band);
  return { law, source: 'grid', band: t.spectral.band, grid: gridFromTable(t, law), filter: t.spectral.name, logg, teffRange, fehRange: fehRange || [0, 0] };
}

/** (teff, feh, out) -> out for a custom band: what makeLDTie() returns. Allocation-free, about 10 ns a call. */
export function makeSpectralTie(table, opts) {
  return makeLDTie(spectralTieSpec(table, opts));
}

/** Wavelength (nm) at the middle of each bin and the bins' edges, for plotting coefficients against wavelength. */
export function binCentres(table) {
  return Float64Array.from({ length: table.nb }, (_, b) => 0.5 * (table.edges[b] + table.edges[b + 1]));
}
