// Matching a star's spectrum against the model grid of src/core/stellarspec.js: effective temperature, gravity and
// metallicity from the shape of a low-resolution spectrum, as SpecMatch-type codes do at high resolution with lines.
//
// What this can and cannot do. The grid is sampled every 5 nm (resolving power about 100 at 0.5 micron), so it matches
// spectrophotometry: Gaia XP, SpeX prism, a flux-calibrated low-resolution or JWST prism spectrum of the star. It cannot
// match an echelle spectrum line by line (NEID, HARPS: R of 100 000): that needs high-resolution models or a library of
// observed stars, which are not shipped. A spectrum finer than the grid is binned down to it first.
//
// The model: the grid's spectrum for (Teff, log g, [Fe/H]) averaged over the data's bins, times a smooth function of
// wavelength, a polynomial of degree `degree` in ln(wavelength), found by linear least squares at every trial star.
// Degree 0 is one scale factor: for a flux-calibrated spectrum it is (theta / 2)^2 and gives the angular diameter. A
// higher degree absorbs slit losses, reddening and calibration slopes, at the cost of the information the overall
// slope carried (the temperature then rests on bands and breaks alone). One scatter term, a fraction of the flux, is
// fitted and added to the errors. The sampler is MiniNest.
import { MiniNest } from './nested.js';
import { stellarFlux, resampleFlux } from './stellarspec.js';

const MAS = Math.PI / 180 / 3600 / 1000;

/**
 * spec: { wl: [micron, ascending], flux: [any unit; W m^-2 micron^-1 for an angular diameter], err: [] | null }
 * { degree = 0, priors: { teff: [lo, hi], logg: [value, sigma] | null, feh: [value, sigma] | null }, nlive = 250, seed = 42, maxCalls = 3e5 }
 * Returns { parameters: { teff, logg, feh, scatter (fraction), theta_mas (degree 0 only) }: { median, lo, hi, best },
 *           wl, flux, err (as fitted, after any binning), model (best), chi2, n, binned: bins joined per point | 1,
 *           converged, ncalls, warnings }.
 */
export function matchSpectrum(grid, spec, { degree = 0, priors = {}, nlive = 250, seed = 42, maxCalls = 3e5 } = {}) {
  let wl = Array.from(spec.wl, Number), fl = Array.from(spec.flux, Number), er = spec.err ? Array.from(spec.err, Number) : null;
  const keep = wl.map((w, i) => Number.isFinite(w) && Number.isFinite(fl[i]) && w >= grid.edges[0] && w <= grid.edges[grid.nWl] && (!er || er[i] > 0));
  wl = wl.filter((_, i) => keep[i]); fl = fl.filter((_, i) => keep[i]); if (er) er = er.filter((_, i) => keep[i]);
  if (wl.length < 8) throw new Error('a spectrum needs at least 8 points between 0.1 and 5.5 micron');
  for (let i = 1; i < wl.length; i++) if (!(wl[i] > wl[i - 1])) throw new Error('wavelengths must increase');
  // a spectrum sampled finer than the grid is binned to the grid's step (5 nm of raw sampling: nothing finer is real in the models)
  const step = Math.log(grid.edges[grid.nWl] / grid.edges[0]) / grid.nWl, mine = Math.log(wl[wl.length - 1] / wl[0]) / (wl.length - 1), join = Math.max(1, Math.round(step / mine));
  if (join > 1) { const W = [], F = [], E = []; for (let i = 0; i + join <= wl.length; i += join) { let sw = 0, sf = 0, se = 0; for (let k = i; k < i + join; k++) { sw += wl[k]; sf += fl[k]; if (er) se += er[k] * er[k]; } W.push(sw / join); F.push(sf / join); E.push(Math.sqrt(se) / join); } wl = W; fl = F; er = er ? E : null; }
  const n = wl.length, edges = new Float64Array(n + 1); edges[0] = wl[0] - 0.5 * (wl[1] - wl[0]); edges[n] = wl[n - 1] + 0.5 * (wl[n - 1] - wl[n - 2]); for (let i = 1; i < n; i++) edges[i] = 0.5 * (wl[i - 1] + wl[i]);
  const g = grid, tR = priors.teff || [g.teff[0], g.teff[g.teff.length - 1]], p = degree + 1, x0 = Math.log(wl[0]), x1 = Math.log(wl[n - 1]);
  const basis = Array.from({ length: p }, (_, k) => Float64Array.from(wl, (w) => Math.pow((2 * (Math.log(w) - x0)) / (x1 - x0) - 1, k)));
  const scale0 = fl.reduce((a, b) => a + Math.abs(b), 0) / n;
  /** Best smooth factor for a model, and chi2 with it; var_i = err_i^2 + (s flux_i)^2. Returns the fitted model in `out`. */
  const solve = (m, s, out) => {
    const A = new Float64Array(p * p), b = new Float64Array(p); let logdet = 0;
    const v = (i) => (er ? er[i] * er[i] : 0) + (s * Math.max(Math.abs(fl[i]), 1e-3 * scale0)) ** 2;
    for (let i = 0; i < n; i++) { const w = 1 / v(i); logdet += Math.log(2 * Math.PI * v(i)); for (let a = 0; a < p; a++) { const fa = basis[a][i] * m[i]; b[a] += w * fa * fl[i]; for (let c = a; c < p; c++) A[a * p + c] += w * fa * basis[c][i] * m[i]; } }
    for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[a * p + c] = A[c * p + a];
    const coef = Float64Array.from(b);   // Gaussian elimination (p <= 5)
    for (let a = 0; a < p; a++) { let piv = a; for (let r = a + 1; r < p; r++) if (Math.abs(A[r * p + a]) > Math.abs(A[piv * p + a])) piv = r; if (!(Math.abs(A[piv * p + a]) > 0)) return { chi2: Infinity, logdet, coef: null };
      if (piv !== a) { for (let c = 0; c < p; c++) { const t = A[a * p + c]; A[a * p + c] = A[piv * p + c]; A[piv * p + c] = t; } const t = coef[a]; coef[a] = coef[piv]; coef[piv] = t; }
      for (let r = a + 1; r < p; r++) { const f = A[r * p + a] / A[a * p + a]; for (let c = a; c < p; c++) A[r * p + c] -= f * A[a * p + c]; coef[r] -= f * coef[a]; } }
    for (let a = p - 1; a >= 0; a--) { let t = coef[a]; for (let c = a + 1; c < p; c++) t -= A[a * p + c] * coef[c]; coef[a] = t / A[a * p + a]; }
    let chi2 = 0; for (let i = 0; i < n; i++) { let f = 0; for (let a = 0; a < p; a++) f += coef[a] * basis[a][i]; const mod = f * m[i]; if (out) out[i] = mod; chi2 += (fl[i] - mod) ** 2 / v(i); }
    return { chi2, logdet, coef };
  };
  const modelOf = (t) => resampleFlux(stellarFlux(g, { teff: t[0], logg: t[1], feh: t[2] }), edges, t[0]);
  const gauss = (u) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, u)), s = q < 0.5 ? -1 : 1, r = Math.sqrt(-2 * Math.log(q < 0.5 ? q : 1 - q)); return s * (r - (2.515517 + 0.802853 * r + 0.010328 * r * r) / (1 + 1.432788 * r + 0.189269 * r * r + 0.001308 * r ** 3)); };   // Abramowitz & Stegun 26.2.23, error < 4.5e-4: a prior, not a result
  const clampTo = (a, v) => Math.min(a[a.length - 1], Math.max(a[0], v));
  const transform = (u, t) => { t[0] = tR[0] + u[0] * (tR[1] - tR[0]); t[1] = priors.logg ? clampTo(g.logg, priors.logg[0] + priors.logg[1] * gauss(u[1])) : g.logg[0] + u[1] * (g.logg[g.logg.length - 1] - g.logg[0]); t[2] = priors.feh ? clampTo(g.feh, priors.feh[0] + priors.feh[1] * gauss(u[2])) : g.feh[0] + u[2] * (g.feh[g.feh.length - 1] - g.feh[0]); t[3] = Math.log(1e-4) + u[3] * Math.log(0.5 / 1e-4); };
  const loglike = (t) => { const r = solve(modelOf(t), Math.exp(t[3]), null); return Number.isFinite(r.chi2) ? -0.5 * (r.chi2 + r.logdet) : -1e300; };
  const ns = new MiniNest({ ndim: 4, loglike, transform, nlive, seed, maxCalls, names: ['teff', 'logg', 'feh', 'lnscatter'] });
  while (!ns.step(200)) { /* to its end or its budget */ }
  const res = ns.result(), N = res.n, best = res.maxPoint, model = new Float64Array(n), at = solve(modelOf(best), Math.exp(best[3]), model);
  const quant = (f) => { const v = new Float64Array(N); for (let i = 0; i < N; i++) v[i] = f(res.samples.subarray(4 * i, 4 * i + 4)); const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => v[a] - v[b]), out = []; let c = 0, k = 0; for (const i of idx) { c += res.weights[i]; while (k < 3 && c >= [0.16, 0.5, 0.84][k]) { out.push(v[i]); k++; } } while (out.length < 3) out.push(v[idx[N - 1]]); return { lo: out[0], median: out[1], hi: out[2], best: f(best) }; };
  const parameters = { teff: quant((t) => t[0]), logg: quant((t) => t[1]), feh: quant((t) => t[2]), scatter: quant((t) => Math.exp(t[3])) };
  if (degree === 0 && at.coef && at.coef[0] > 0) {
    // theta from the scale factor: its spread over the posterior needs the factor at each sample; taken on a thinned set
    const th = (t) => { const r = solve(modelOf(t), Math.exp(t[3]), null); return r.coef && r.coef[0] > 0 ? (2 * Math.sqrt(r.coef[0])) / MAS : NaN; }, heavy = Array.from({ length: N }, (_, i) => i).filter((i) => res.weights[i] > 1e-6);
    const v = heavy.map((i) => th(res.samples.subarray(4 * i, 4 * i + 4))), w = heavy.map((i) => res.weights[i]), idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]), tot = w.reduce((a, b) => a + b, 0), out = []; let c = 0, k = 0;
    for (const i of idx) { c += w[i] / tot; while (k < 3 && c >= [0.16, 0.5, 0.84][k]) { out.push(v[i]); k++; } } while (out.length < 3) out.push(v[idx[idx.length - 1]]);
    parameters.theta_mas = { lo: out[0], median: out[1], hi: out[2], best: (2 * Math.sqrt(at.coef[0])) / MAS };
  }
  const warnings = [];
  if (join > 1) warnings.push(`The spectrum is sampled finer than the models (5 nm): ${join} points were averaged into each fitted point. Lines narrower than that carry no weight here.`);
  if (parameters.teff.median - tR[0] < 0.02 * (tR[1] - tR[0]) || tR[1] - parameters.teff.median < 0.02 * (tR[1] - tR[0])) warnings.push('The temperature sits at the edge of the model grid: the star may lie outside it.');
  if (parameters.scatter.median > 0.05) warnings.push(`The spectrum departs from the best model by ${(100 * parameters.scatter.median).toFixed(0)}% of the flux: the models do not describe it well (calibration, a companion, or a star outside the grid), and the error bars reflect that.`);
  if (degree > 0) warnings.push('A smooth factor was fitted with the star: no angular diameter follows, and the temperature rests on the spectrum\'s features, not its overall slope.');
  return { parameters, wl, flux: fl, err: er, model: Array.from(model), chi2: at.chi2, n, binned: join, degree, converged: res.converged, ncalls: res.ncalls, warnings };
}
