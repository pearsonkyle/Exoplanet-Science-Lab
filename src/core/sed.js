// A star's parameters from its spectral energy distribution: catalogue magnitudes against the model-atmosphere grid of
// src/core/stellarspec.js, reddened by src/core/extinction.js and seen through the passbands of src/core/passbands.js.
//
// The model. For effective temperature, gravity and metallicity the grid gives the flux leaving the surface; a
// star of angular diameter theta sends (theta / 2)^2 of it to the observer, dimmed by 10^(-0.4 A_V k(lambda)). Each
// band's mean flux density is taken as its detector takes it (photon counting or energy), turned into f_nu at the
// band's pivot wavelength and into a magnitude with the band's zero point.
// What is sampled: Teff, log g, [Fe/H], log10 theta [mas], A_V, the parallax (when one is given, with its Gaussian
// error) and one excess scatter s [mag] added in quadrature to every error bar (zero-point and model errors are
// several hundredths of a magnitude, more than most catalogue errors). The radius is not sampled: it follows from
// theta and the parallax, R = theta d / 2, as the luminosity follows from the bolometric flux.
// The sampler is MiniNest (src/core/nested.js), the one the light-curve fits use.
//
// What photometry does and does not constrain: theta and Teff well (given A_V); log g and [Fe/H] hardly at all, so
// give them priors when a spectroscopic value exists; A_V is degenerate with Teff for hot stars. One grid of models
// only: no averaging over several grids as AstroARIADNE does (Vines & Jenkins 2022).
import { MiniNest } from './nested.js';
import { stellarFlux, bolometric, tailShape } from './stellarspec.js';
import { extinctionF99 } from './extinction.js';
import { planckSI } from './phasecurve.js';
import { PASSBANDS } from './passbands.js';
import { C } from './derive.js';

const C_UM = 2.99792458e14, MAS = Math.PI / 180 / 3600 / 1000, PC = 3.0856775814913673e16, RSUN = C.Rsun, LSUN = 3.828e26;   // the solar radius is the site's one value (derive.js); L_sun is the IAU 2015 nominal, as relations.js
const TAIL = 48, TAIL_END = 40;   // bins added beyond the grid, to 40 micron (WISE W4 ends near 28)

/** Flux density of a magnitude in a band: { fnu [Jy], flam [W m^-2 micron^-1], pivot [micron] }. */
export function magnitudeToFlux(bandName, mag) {
  const b = bandOf(bandName), fnu = b.zp * Math.pow(10, -0.4 * mag);
  return { fnu, flam: (fnu * 1e-26 * C_UM) / (b.pivot * b.pivot), pivot: b.pivot };
}
const BANDS = new Map();
function bandOf(name) {
  let b = BANDS.get(name); if (b) return b;
  const p = PASSBANDS[name]; if (!p) throw new Error(`no passband "${name}" (bands: ${Object.keys(PASSBANDS).join(', ')})`);
  const k = p.photon ? 1 : 0; let a = 0, c = 0;
  for (let i = 1; i < p.wl.length; i++) { const dl = p.wl[i] - p.wl[i - 1], w = 0.5 * (p.wl[i] + p.wl[i - 1]), r = 0.5 * (p.response[i] + p.response[i - 1]); a += r * w ** k * dl; c += r * w ** (k - 2) * dl; }
  b = { ...p, name, pivot: Math.sqrt(a / c) }; BANDS.set(name, b); return b;
}
const respAt = (b, w) => { const x = b.wl, n = x.length; if (w <= x[0] || w >= x[n - 1]) return 0; let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] > w) hi = m; else lo = m; } return b.response[lo] + ((w - x[lo]) / (x[hi] - x[lo])) * (b.response[hi] - b.response[lo]); };

/**
 * Everything that does not change during a fit: the wavelength bins (the grid's, then TAIL more to 40 micron), the
 * extinction curve on them, and each band's weights over the bins.
 *   obs: [{ band, mag, err }]; rv: R_V (3.1)
 */
export function prepareSed(grid, obs, { rv = 3.1 } = {}) {
  const n = grid.nWl, N = n + TAIL, edges = new Float64Array(N + 1); edges.set(grid.edges); for (let i = 1; i <= TAIL; i++) edges[n + i] = grid.edges[n] * Math.pow(TAIL_END / grid.edges[n], i / TAIL);
  const wl = Float64Array.from({ length: N }, (_, i) => Math.sqrt(edges[i] * edges[i + 1])), k = Float64Array.from(wl, (w) => extinctionF99(w, rv));
  const bands = obs.map((o) => {
    const b = bandOf(o.band), p = b.photon ? 1 : 0, w = new Float64Array(N); let sum = 0;
    for (let i = 0; i < N; i++) { if (edges[i + 1] <= b.wl[0] || edges[i] >= b.wl[b.wl.length - 1]) continue; let s = 0; const m = 6; for (let q = 0; q < m; q++) { const x = edges[i] + ((q + 0.5) / m) * (edges[i + 1] - edges[i]); s += respAt(b, x) * x ** p; } w[i] = (s / m) * (edges[i + 1] - edges[i]); sum += w[i]; }
    if (!(sum > 0)) throw new Error(`${o.band} lies outside the model's wavelengths`);
    let i0 = 0, i1 = N; while (w[i0] === 0) i0++; while (w[i1 - 1] === 0) i1--;
    return { band: b, w: w.map((v) => v / sum), i0, i1, toJy: (1e26 * b.pivot * b.pivot) / C_UM };
  });
  return { grid, obs, bands, edges, wl, k, n, N, rv, tail: Float64Array.from({ length: TAIL }, (_, i) => tailShape(wl[n + i])), tailWindow: Array.from({ length: n }, (_, i) => i).filter((i) => wl[i] >= 3.6 && wl[i] <= 4.2) };
}

/** Model magnitudes of the bands of a prepared problem for { teff, logg, feh, theta [mas], av }; also the spectrum at the observer. */
export function sedMagnitudes(P, { teff, logg = 4.5, feh = 0, theta, av = 0 }, out = null) {
  const sp = stellarFlux(P.grid, { teff, logg, feh }), dil = (0.5 * theta * MAS) ** 2, f = (P.scratch ??= new Float64Array(P.N));
  const rat = P.tailWindow.map((i) => sp.flux[i] / planckSI(P.wl[i], teff)).sort((a, b) => a - b), scale = rat[rat.length >> 1];
  for (let i = 0; i < P.N; i++) f[i] = (i < P.n ? sp.flux[i] : scale * P.tail[i - P.n] * planckSI(P.wl[i], teff)) * dil * (av > 0 ? Math.pow(10, -0.4 * av * P.k[i]) : 1);
  const mags = out || new Float64Array(P.bands.length);
  P.bands.forEach((b, j) => { let s = 0; for (let i = b.i0; i < b.i1; i++) s += b.w[i] * f[i]; mags[j] = -2.5 * Math.log10((s * b.toJy) / b.band.zp); });
  return { mags, flux: f, spec: sp };
}

const gauss = (u) => {   // inverse normal CDF (Acklam), |error| < 1.2e-9
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239], b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const p = Math.min(1 - 1e-15, Math.max(1e-15, u));
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q; return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

/**
 * Fit a star.
 *   obs: [{ band (a name of PASSBANDS), mag, err }]   at least three bands
 *   priors: { plx: [mas, err] (optional; without it only theta is found, not the radius),
 *             teff: [lo, hi] (the grid's range), logg: [value, sigma] | null (uniform over the grid),
 *             feh: [value, sigma] | null (uniform over the grid), avMax (0.2 mag; 0 fixes A_V = 0) }
 *   { rv = 3.1, floor = 0.02 (mag, added in quadrature to every error), nlive = 300, seed = 42, maxCalls = 4e5 }
 * Returns { parameters: { teff, logg, feh, theta_mas, av, scatter_mag, plx_mas?, rstar?, lum?, dist_pc?, fbol }: each
 *           { median, lo, hi } (16th and 84th percentiles) and best,
 *           bands: [{ band, pivot, mag, err, model, residual }] at the best point, chi2 (with the fitted scatter),
 *           spectrum: { wl, flux [W m^-2 micron^-1 at the observer] } at the best point,
 *           logZ, converged, ncalls, warnings, sampler: { logZ, logZerr, ess, niter, ncalls, nlive, insertionP, efficiency, stopReason },
 *           posterior: { ndim, n, samples, weights, names, labels } in the quantities of `parameters` (for drawCorner),
 *           samples: { names, values: Float64Array(n * k), weights } as sampled }.
 */
export function fitSed(grid, obs, { priors = {}, rv = 3.1, floor = 0.02, nlive = 300, seed = 42, maxCalls = 4e5 } = {}) {
  if (!obs || obs.length < 3) throw new Error('an SED fit needs at least three magnitudes');
  for (const o of obs) if (!Number.isFinite(o.mag) || !(o.err >= 0)) throw new Error(`${o.band}: a magnitude and its error are needed`);
  const P = prepareSed(grid, obs, { rv }), g = grid, tR = priors.teff || [g.teff[0], g.teff[g.teff.length - 1]], avMax = priors.avMax ?? 0.2, plx = priors.plx || null;
  const names = ['teff', 'logg', 'feh', 'logtheta', 'av', 'lnscatter', ...(plx ? ['plx'] : [])], d = names.length, m = new Float64Array(obs.length);
  // a first guess of theta from the reddest band, to centre its prior (six decades wide)
  const guess = sedMagnitudes(P, { teff: 0.5 * (tR[0] + tR[1]), theta: 1 }).mags, jr = obs.reduce((b, o, j) => (P.bands[j].band.pivot > P.bands[b].band.pivot ? j : b), 0), lt0 = 0.2 * (guess[jr] - obs[jr].mag);
  const transform = (u, t) => {
    t[0] = tR[0] + u[0] * (tR[1] - tR[0]);
    t[1] = priors.logg ? Math.min(g.logg[g.logg.length - 1], Math.max(g.logg[0], priors.logg[0] + priors.logg[1] * gauss(u[1]))) : g.logg[0] + u[1] * (g.logg[g.logg.length - 1] - g.logg[0]);
    t[2] = priors.feh ? Math.min(g.feh[g.feh.length - 1], Math.max(g.feh[0], priors.feh[0] + priors.feh[1] * gauss(u[2]))) : g.feh[0] + u[2] * (g.feh[g.feh.length - 1] - g.feh[0]);
    t[3] = lt0 - 1 + 2 * u[3]; t[4] = avMax * u[4]; t[5] = Math.log(1e-3) + u[5] * Math.log(0.5 / 1e-3);
    if (plx) t[6] = Math.max(1e-6, plx[0] + plx[1] * gauss(u[6]));
  };
  const loglike = (t) => {
    sedMagnitudes(P, { teff: t[0], logg: t[1], feh: t[2], theta: Math.pow(10, t[3]), av: t[4] }, m); const s2 = Math.exp(2 * t[5]); let L = 0;
    for (let j = 0; j < obs.length; j++) { const v = obs[j].err ** 2 + floor * floor + s2, r = obs[j].mag - m[j]; L -= 0.5 * (r * r / v + Math.log(2 * Math.PI * v)); }
    return Number.isFinite(L) ? L : -1e300;
  };
  const ns = new MiniNest({ ndim: d, loglike, transform, nlive, seed, maxCalls, names });
  while (!ns.step(200)) { /* runs to its own end or its budget */ }
  const res = ns.result(), n = res.n, best = res.maxPoint;
  // weighted quantiles of every sampled and derived quantity
  const col = (f) => { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = f(res.samples.subarray(i * d, i * d + d)); return v; };
  const quant = (v) => { const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => v[a] - v[b]); let c = 0; const q = [0.16, 0.5, 0.84], out = []; let k = 0; for (const i of idx) { c += res.weights[i]; while (k < 3 && c >= q[k]) { out.push(v[i]); k++; } } while (out.length < 3) out.push(v[idx[n - 1]]); return out; };
  const fbolOf = (t) => bolometric(stellarFlux(g, { teff: t[0], logg: t[1], feh: t[2] }), t[0]) * (0.5 * Math.pow(10, t[3]) * MAS) ** 2;
  const fb = new Float64Array(n); { let last = null, lastV = 0; for (let i = 0; i < n; i++) { const t = res.samples.subarray(i * d, i * d + d); if (res.weights[i] < 1e-9 && last != null) { fb[i] = lastV; continue; } fb[i] = lastV = fbolOf(t); last = i; } }
  const defs = { teff: [(t) => t[0], best[0]], logg: [(t) => t[1], best[1]], feh: [(t) => t[2], best[2]], theta_mas: [(t) => Math.pow(10, t[3]), Math.pow(10, best[3])], av: [(t) => t[4], best[4]], scatter_mag: [(t) => Math.exp(t[5]), Math.exp(best[5])] };
  const parameters = {}; for (const [k, [f, b]] of Object.entries(defs)) { const [lo, median, hi] = quant(col(f)); parameters[k] = { median, lo, hi, best: b }; }
  { const [lo, median, hi] = quant(fb); parameters.fbol = { median, lo, hi, best: fbolOf(best) }; }
  if (plx) {
    const R = (t) => (0.5 * Math.pow(10, t[3]) * MAS * (1000 / t[6]) * PC) / RSUN, add = (k, v, b) => { const [lo, median, hi] = quant(v); parameters[k] = { median, lo, hi, best: b }; };
    add('plx_mas', col((t) => t[6]), best[6]); add('dist_pc', col((t) => 1000 / t[6]), 1000 / best[6]); add('rstar', col(R), R(best));
    const Lv = new Float64Array(n); for (let i = 0; i < n; i++) { const t = res.samples.subarray(i * d, i * d + d); Lv[i] = (4 * Math.PI * ((1000 / t[6]) * PC) ** 2 * fb[i]) / LSUN; }
    add('lum', Lv, (4 * Math.PI * ((1000 / best[6]) * PC) ** 2 * fbolOf(best)) / LSUN);
  }
  const at = sedMagnitudes(P, { teff: best[0], logg: best[1], feh: best[2], theta: Math.pow(10, best[3]), av: best[4] }), s2 = Math.exp(2 * best[5]); let chi2 = 0;
  const bands = obs.map((o, j) => { const r = o.mag - at.mags[j]; chi2 += (r * r) / (o.err ** 2 + floor * floor + s2); return { band: o.band, pivot: P.bands[j].band.pivot, mag: o.mag, err: o.err, model: at.mags[j], residual: r }; });
  // the posterior in the quantities one reads (not the sampled logs), for corner plots and tables: one row per sample
  const cols = [['teff', 'Teff (K)', (t) => t[0]], ['theta_mas', 'θ (mas)', (t) => Math.pow(10, t[3])], ...(plx ? [['rstar', 'R (R☉)', (t) => (0.5 * Math.pow(10, t[3]) * MAS * (1000 / t[6]) * PC) / RSUN], ['lum', 'L (L☉)', null]] : []),
    ...(avMax > 0 ? [['av', 'A_V (mag)', (t) => t[4]]] : []), ['logg', 'log g', (t) => t[1]], ['feh', '[Fe/H]', (t) => t[2]], ['scatter_mag', 'scatter (mag)', (t) => Math.exp(t[5])]];
  const pv = new Float64Array(n * cols.length);
  for (let i = 0; i < n; i++) { const t = res.samples.subarray(i * d, i * d + d); cols.forEach(([, , f], c) => { pv[i * cols.length + c] = f ? f(t) : (4 * Math.PI * ((1000 / t[6]) * PC) ** 2 * fb[i]) / LSUN; }); }
  const posterior = { ndim: cols.length, n, samples: pv, weights: res.weights, names: cols.map((c) => c[0]), labels: cols.map((c) => c[1]) };
  const sampler = { logZ: res.logZ, logZerr: res.logZerr, ess: res.ess, niter: res.niter, ncalls: res.ncalls, nlive: res.nlive, insertionP: res.insertionP, efficiency: res.efficiency, stopReason: res.stopReason, converged: res.converged, method: res.mode };
  const warnings = [...(res.warnings || [])];
  for (const [k, a] of [['teff', tR]]) if (parameters[k].median - a[0] < 0.02 * (a[1] - a[0]) || a[1] - parameters[k].median < 0.02 * (a[1] - a[0])) warnings.push('The temperature sits at the edge of the model grid: the star may lie outside it.');
  if (parameters.scatter_mag.median > 0.1) warnings.push(`The magnitudes scatter by ${parameters.scatter_mag.median.toFixed(2)} mag about the model, more than photometry should: a band may be saturated, blended or variable, or the star is not a single photosphere.`);
  return { parameters, bands, chi2, spectrum: { wl: Array.from(P.wl), flux: Array.from(at.flux) }, logZ: res.logZ, logZerr: res.logZerr, converged: res.converged, ncalls: res.ncalls, warnings, sampler, posterior, samples: { names, values: res.samples, weights: res.weights } };
}

const TEX_ROWS = [['teff', '$T_{\\rm eff}$', 'K', 0], ['theta_mas', '$\\theta$', 'mas', 4], ['rstar', '$R_\\star$', '$R_\\odot$', 3], ['lum', '$L_\\star$', '$L_\\odot$', 3], ['fbol', '$F_{\\rm bol}$', 'W\\,m$^{-2}$', -1], ['dist_pc', '$d$', 'pc', 2], ['av', '$A_V$', 'mag', 3], ['logg', '$\\log g$', 'cgs', 2], ['feh', '[Fe/H]', 'dex', 2], ['scatter_mag', 'excess scatter', 'mag', 3]];
/**
 * The result of fitSed as LaTeX: a table of the parameters (median, +, -, prior) and one of the magnitudes with the
 * model's. priors: as given to fitSed. Returns a string with two table environments.
 */
export function sedLatex(result, name = 'the star', priors = {}) {
  const p = result.parameters, s = result.sampler || {}, esc = (t) => String(t).replace(/([&%_#])/g, '\\$1');
  const prior = (k) => (k === 'logg' ? (priors.logg ? `$\\mathcal{N}(${priors.logg[0]}, ${priors.logg[1]})$` : 'uniform over the grid') : k === 'feh' ? (priors.feh ? `$\\mathcal{N}(${priors.feh[0]}, ${priors.feh[1]})$` : 'uniform over the grid') : k === 'av' ? `$\\mathcal{U}(0, ${priors.avMax})$` : ['rstar', 'lum', 'dist_pc', 'fbol'].includes(k) ? 'derived' : k === 'teff' ? 'uniform' : k === 'theta_mas' || k === 'scatter_mag' ? 'log-uniform' : '');
  const rows = TEX_ROWS.filter(([k]) => p[k] && !(k === 'av' && !(priors.avMax > 0))).map(([k, sym, unit, d]) => {
    const v = p[k], e = d < 0 ? Math.floor(Math.log10(v.median)) : 0, f = 10 ** e, dg = d < 0 ? 3 : d;
    const num = `${(v.median / f).toFixed(dg)}^{+${((v.hi - v.median) / f).toFixed(dg)}}_{-${((v.median - v.lo) / f).toFixed(dg)}}`;
    return `${sym} (${unit}) & $${d < 0 ? `(${num})\\times10^{${e}}` : num}$ & ${prior(k)} \\\\`;
  });
  const bands = result.bands.map((b) => `${esc(b.band)} & ${b.pivot.toFixed(3)} & $${b.mag.toFixed(3)} \\pm ${b.err.toFixed(3)}$ & ${b.model.toFixed(3)} & $${b.residual >= 0 ? '+' : ''}${b.residual.toFixed(3)}$ \\\\`);
  const lnz = Number.isFinite(s.logZ) ? `$\\ln Z = ${s.logZ.toFixed(2)} \\pm ${(s.logZerr ?? 0).toFixed(2)}$, ` : '';
  return [`% ${name}: spectral energy distribution fit, Exoplanet Science Lab`, '\\begin{table}', '\\centering',
    `\\caption{Stellar parameters of ${esc(name)} from its spectral energy distribution (PHOENIX-ACES models; median and 16th--84th percentiles; nested sampling, ${lnz}${result.bands.length} magnitudes, $\\chi^2 = ${result.chi2.toFixed(1)}$).}`,
    '\\begin{tabular}{lcc}', '\\hline', 'Parameter & Value & Prior \\\\', '\\hline', ...rows, '\\hline', '\\end{tabular}', '\\end{table}', '',
    '\\begin{table}', '\\centering', `\\caption{Photometry of ${esc(name)} and the best-fitting model.}`, '\\begin{tabular}{lcccc}', '\\hline',
    'Band & $\\lambda_{\\rm pivot}$ ($\\mu$m) & Observed (mag) & Model (mag) & O$-$C (mag) \\\\', '\\hline', ...bands, '\\hline', '\\end{tabular}', '\\end{table}', ''].join('\n');
}
