// A temperature-pressure profile that follows from the atmosphere's own gas: the irradiated semi-grey solution of
// Guillot (2010), with its two opacities taken, layer by layer, from the model's opacity tables and composition and
// iterated with the chemistry and the ionization until the temperatures stop changing; then a convective adjustment.
//
// What is and is not solved
//   - Each layer gets two mean extinctions from the absorption the spectrum itself is computed from (line tables,
//     collision-induced absorption, H-, absorbing cloud): a Rosseland mean over the layer's own thermal emission
//     (of absorption plus scattering: both impede the flow of heat), and a mean of the absorption over the star's
//     spectrum (a blackbody of its effective temperature; scattered starlight heats nothing).
//   - Guillot's eq. 29 is written for constant opacities. Here its optical depths are grey-equivalent ones taken
//     from the real gas (effectiveDepths): tau_v from the starlight that gets down to a level, tau from the heat that
//     gets out of it; gamma = tau_v / tau at each level. Given optical depths proportional to
//     pressure this is the original formula exactly (test/climate.test.mjs).
//   - The level of the profile (one factor c on T^4) is found so that the atmosphere's own emission spectrum,
//     integrated, equals the flux the planet must lose. Inversions (gamma > 1) form and settle like any other profile.
//   - Where the profile is steeper than an adiabat, d ln T / d ln P > nablaAd, the layers below follow the adiabat.
//   - Above 1e-5 bar (tp.pIso; the opacity tables end there) the profile is held at its value there: no thermosphere, and no trust in the closure
//     where lines scatter instead of heating.
//   - This is not radiative-convective equilibrium. The whole planet's energy budget is met, with the model's real
//     spectrum; the budget of each layer is not. A full solution would move every layer's temperature until its net
//     flux is constant, and gives cooler upper layers than a grey closure does (Parmentier & Guillot 2014).
//
// References: Guillot (2010, A&A 520, A27); Heng, Hayek, Pont & Sing (2012, MNRAS 420, 20) for depth-dependent
// opacities in the same closure; Parmentier & Guillot (2014, A&A 562, A133) for what the grey closure misses.

import { atmosphereOf, forwardModel, placedCloud, DEFAULT_MODEL } from './rtmodel.js';
import { gasExtinction, addPerWavelength } from './opacity.js';
import { addContinuum } from './continuum.js';
import { planckSI } from './phasecurve.js';
import { emissionSpectrum } from './emission.js';

const SIGMA = 5.670374419e-8;

/**
 * Mean extinctions of every layer [m^-1] from an extinction array (nWl * ng * n, as gasExtinction returns):
 *   rosseland   harmonic mean weighted by dB/dT at the layer's temperature (the opacity of diffusing heat)
 *   stellar     arithmetic mean weighted by the star's blackbody (the opacity starlight is absorbed with)
 *   planck      arithmetic mean weighted by the layer's own blackbody
 * scat: scattering per wavelength and layer (nWl * n), added to the extinction in the Rosseland mean only.
 * grid: { wl, edges, nWl, ng, weights }; floor [m^-1] keeps a bin without any opacity from making the harmonic mean zero.
 */
export function meanExtinctions(ext, grid, tLay, teffStar, { floor = null, nd = null, scat = null } = {}) {
  const { nWl, ng } = grid, n = tLay.length, w = grid.weights || [1], dl = new Float64Array(nWl), star = new Float64Array(nWl);
  for (let i = 0; i < nWl; i++) { dl[i] = grid.edges ? grid.edges[i + 1] - grid.edges[i] : i > 0 ? grid.wl[i] - grid.wl[i - 1] : grid.wl[1] - grid.wl[0]; star[i] = planckSI(grid.wl[i], teffStar) * dl[i]; }
  const sStar = star.reduce((a, b) => a + b, 0), rosseland = new Float64Array(n), stellar = new Float64Array(n), planck = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const T = tLay[j], lo = floor != null ? floor : nd ? nd[j] * 1e-34 : 1e-30; let inv = 0, sd = 0, pl = 0, sb = 0, st = 0;
    for (let i = 0; i < nWl; i++) {
      const b = planckSI(grid.wl[i], T) * dl[i], db = (planckSI(grid.wl[i], T + 1) - planckSI(grid.wl[i], T - 1)) * dl[i];
      let mean = 0, hinv = 0;
      const sc = scat ? scat[i * n + j] : 0;   // scattering impedes the diffusion of heat (Rosseland) but absorbs nothing
      for (let q = 0; q < ng; q++) { const a = Math.max(ext[(i * ng + q) * n + j], lo); mean += w[q] * a; hinv += w[q] / (a + sc); }
      inv += db * hinv; sd += db; pl += b * mean; sb += b; st += star[i] * mean;
    }
    rosseland[j] = sd / inv; planck[j] = pl / sb; stellar[j] = st / sStar;
  }
  return { rosseland, stellar, planck };
}

/**
 * Grey-equivalent optical depths of every layer centre, from what actually gets through the real, non-grey gas:
 *   tauV  starlight: the star's blackbody attenuated along a slant mu0, wavelength by wavelength and g-point by
 *         g-point; tauV = -mu0 ln(transmitted share). Strong lines saturate and stop counting, as they should;
 *         an arithmetic mean opacity would let them dominate.
 *   tau   heat: the layer's own blackbody radiation escaping to space along the mean slant muTh (1/1.66, the usual
 *         diffusivity factor); tau = -muTh ln(escaping share). Bands close first, windows last.
 * ext: absorption (nWl * ng * n); scat: scattering (nWl * n), which counts for the heat (it holds it in) and not for
 * the starlight; grid; atm: { n, dr, tLay }. Returns { tau, tauV, absorbed: share of the starlight
 * absorbed above each layer centre }.
 */
export function effectiveDepths(ext, grid, atm, teffStar, { mu0 = 0.5, muTh = 1 / 1.66, scat = null } = {}) {
  const { nWl, ng } = grid, n = atm.n, w = grid.weights || [1], run = new Float64Array(nWl * ng), runS = new Float64Array(nWl), dl = new Float64Array(nWl), star = new Float64Array(nWl);
  for (let i = 0; i < nWl; i++) { dl[i] = grid.edges[i + 1] - grid.edges[i]; star[i] = planckSI(grid.wl[i], teffStar) * dl[i]; }
  const sStar = star.reduce((a, b) => a + b, 0), tau = new Float64Array(n), tauV = new Float64Array(n), absorbed = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let tv = 0, tt = 0, sb = 0; const T = atm.tLay[j], h = 0.5 * atm.dr[j];
    for (let i = 0; i < nWl; i++) {
      const b = planckSI(grid.wl[i], T) * dl[i]; let ev = 0, et = 0;
      const sc = scat ? scat[i * n + j] : 0, ds = runS[i] + sc * h; runS[i] += sc * atm.dr[j];   // scattering holds heat in, and absorbs no starlight
      for (let q = 0; q < ng; q++) { const k = i * ng + q, a = ext[k * n + j], d = run[k] + a * h; ev += w[q] * Math.exp(-d / mu0); et += w[q] * Math.exp(-(d + ds) / muTh); run[k] += a * atm.dr[j]; }
      tv += star[i] * ev; tt += b * et; sb += b;
    }
    tauV[j] = -mu0 * Math.log(Math.max(tv / sStar, 1e-300)); tau[j] = -muTh * Math.log(Math.max(tt / sb, 1e-300)); absorbed[j] = 1 - tv / sStar;
    if (j > 0) { tau[j] = Math.max(tau[j], tau[j - 1]); tauV[j] = Math.max(tauV[j], tauV[j - 1]); }   // the weights change with the layer's temperature: keep the depths from turning back
  }
  return { tau, tauV, absorbed };
}

/**
 * Guillot's eq. 29 with optical depths that are given, not assumed proportional to pressure:
 *   T^4 = 3/4 Tint^4 (2/3 + tau) + 3/4 Tirr^4 f [2/3 + 1/(g sqrt3) + (g/sqrt3 - 1/(g sqrt3)) e^(-sqrt3 tau_v)], g = tau_v / tau,
 * Tirr^4 = 4 Teq^4. tau, tauV: thermal and visible optical depths at the layers' centres.
 */
export function guillotFromDepths(tau, tauV, { teq, tint = 100, f = 0.25 }) {
  const s3 = Math.sqrt(3), out = new Float64Array(tau.length); let gPrev = Infinity;
  for (let j = 0; j < tau.length; j++) {
    // below visible depth 1, where most of the starlight has been absorbed, gamma is not let rise again with depth:
    // the temperature there is set by the heat diffusing out and must not fall inward
    let g = Math.max(tauV[j] / Math.max(tau[j], 1e-300), 1e-6);
    if (tauV[j] > 1) { g = Math.min(g, gPrev); gPrev = g; }
    const irr = 2 / 3 + 1 / (g * s3) + (g / s3 - 1 / (g * s3)) * Math.exp(-s3 * tauV[j]);
    out[j] = Math.pow(0.75 * tint ** 4 * (2 / 3 + tau[j]) + 0.75 * 4 * teq ** 4 * f * irr, 0.25);
  }
  return out;
}

/**
 * Convective adjustment, top down: where a layer is warmer than the adiabat through the layer above allows,
 * T_j > T_(j-1) (P_j / P_(j-1))^nablaAd, it is put on that adiabat. Returns { t, top: index of the first adjusted layer or -1 }.
 * nablaAd = d ln T / d ln P of an adiabat: 2/7 for a diatomic gas without vibration; lower where H2 dissociates.
 */
export function convectiveAdjustment(tLay, pLay, nablaAd = 2 / 7) {
  const t = Float64Array.from(tLay); let top = -1;
  for (let j = 1; j < t.length; j++) { const lim = t[j - 1] * Math.pow(pLay[j] / pLay[j - 1], nablaAd); if (t[j] > lim * (1 + 1e-12)) { t[j] = lim; if (top < 0) top = j; } }
  return { t, top };
}

/**
 * The absorption of every layer of an atmosphere, and its scattering per wavelength, with or without the aerosols:
 * { ext (absorption, nWl * ng * n), scat (nWl * n), grid }.
 */
function absorptionOf(m, atm, tables, cache, kernel, aerosol) {
  m = { ...m, cloud: placedCloud(m.cloud, atm) };
  const lines = m.opacityOff && m.opacityOff.length ? tables.lines.filter((t) => !m.opacityOff.includes(t.species)) : tables.lines;
  const gas = gasExtinction(atm, lines, { cia: tables.cia || [], cache, kernel }), cont = new Float64Array(gas.grid.nWl * atm.n);
  if (!gas.grid.edges) throw new Error('the self-consistent profile needs binned opacity tables (k-tables)');
  addContinuum(atm, gas.grid.wl, cont, { rayleigh: false, hminus: true, cloudTop: aerosol ? m.cloudTop : null, cloud: aerosol ? m.cloud : null, cloudShare: 'absorption' });
  const scat = new Float64Array(gas.grid.nWl * atm.n);
  addContinuum(atm, gas.grid.wl, scat, { rayleigh: m.rayleigh && (aerosol ? m.rayleighFactor ?? 1 : 1), haze: aerosol ? m.haze : null, hminus: false, cloud: aerosol ? m.cloud : null, cloudShare: 'scattering' });
  return { ext: addPerWavelength(gas.extinction, cont, gas.grid.nWl, gas.grid.ng, atm.n), scat, grid: gas.grid };
}

/**
 * The self-consistent profile of a model.
 *   model: as forwardModel takes it, with tp = { kind: 'consistent', teq, tint = 100, f = 0.25, nablaAd = 2/7,
 *          convection = true, pIso = 1e-5 bar, where the opacity tables end (above it the profile is held at its value there; null: no hold) } and star.teff; chemistry, ionization, clouds as set.
 *   { maxIter = 30, tol = 2 K, balanceTol = 0.02, damping = 0.5, gain = 0.7, cache, kernel }
 * Each pass: build the atmosphere on the current temperatures (so the chemistry and ionization follow them); take
 * its mean extinctions; integrate them to optical depths; evaluate the profile; compute the emission spectrum of the
 * atmosphere as it stands and compare its integral with the energy the planet must lose.
 *
 * The two optical depths of the grey solution are the grey-equivalent ones of effectiveDepths: what the real gas lets
 * through of the starlight coming in and of each layer's heat going out. T^4 of the result is multiplied by one number
 * c, moved until the emitted flux equals sigma (4 f Teq^4 + Tint^4); c near 1 means the closure needed little help.
 * (Mean opacities do not do: a Rosseland mean of these tables is set by the floor of the windows between bands, whose
 * line wings are cut in the source data, and is orders of magnitude too small; a Planck or stellar mean is set by the
 * strongest line cores, which are saturated, and is orders of magnitude too large. meanExtinctions computes them.)
 * So the profile has the grey solution's shape, the model's own opacities in it, and the planet's energy budget met
 * by the model's own non-grey spectrum. Where the gas absorbs starlight better than it holds heat (gamma > 1: TiO and
 * VO in an ultra-hot Jupiter, a haze over a cold one) the temperature rises with height: an inversion.
 *
 * Aerosols: the grey deck, the particle layer and the haze enter (the deck as an opaque floor, the particles'
 * absorbing share as absorption, scattering as what holds heat in). With cloudFraction f < 1 the emitted flux is the
 * mix f x cloudy + (1 - f) x clear, as forwardModel's, and the depths are those of the column that covers more.
 *
 * Returns { tp: { kind: 'table', p [bar], t [K] } (use it as model.tp), iterations, change (K, the last pass),
 *           balance (emitted / required, of the returned profile itself), scale (c), converged, gamma: tau_v / tau per layer, tau, tauV, absorbed
 *           (share of the starlight absorbed above each layer), convectiveTop [bar] | null, history: [{ change, balance, scale }] }.
 */
export function consistentProfile(model, tables, { maxIter = 30, tol = 2, balanceTol = 0.02, damping = 0.5, gain = 0.7, cache = null, kernel = null } = {}) {
  const m = { ...DEFAULT_MODEL, ...model }, c = m.tp;
  if (!c || c.kind !== 'consistent') throw new Error('consistentProfile needs tp.kind = "consistent"');
  if (!(c.teq > 0)) throw new Error('the self-consistent profile needs an equilibrium temperature (tp.teq)');
  const par = { teq: c.teq, tint: c.tint ?? 100, f: c.f ?? 0.25 }, required = SIGMA * (4 * par.f * par.teq ** 4 + par.tint ** 4);
  const hasAerosol = !!(m.haze || m.cloud || m.cloudTop != null || (m.rayleighFactor ?? 1) !== 1), cover = hasAerosol ? Math.max(0, Math.min(1, m.cloudFraction ?? 1)) : 0;
  let tp = { kind: 'guillot', teq: par.teq, tint: par.tint, kappaIR: 1e-3, gamma: 0.4, f: par.f }, t = null, out = null, scale = 1, change = Infinity; const history = [];
  const emittedBy = (atm, x) => { const flux = emissionSpectrum(atm, x.grid.wl, x.ext, { weights: x.grid.weights ? { ng: x.grid.ng, w: x.grid.weights } : null }).flux; let e = 0; for (let i = 0; i < x.grid.nWl; i++) e += flux[i] * (x.grid.edges[i + 1] - x.grid.edges[i]); return e; };
  for (let it = 0; it <= maxIter; it++) {
    // the atmosphere on the profile as it stands: its chemistry and ionization, its absorption, and the energy it loses
    const atm = atmosphereOf({ ...m, tp }, tables), n = atm.n, pBar = Array.from(atm.pLay, (p) => p / 1e5);
    const cloudy = cover > 0 ? absorptionOf(m, atm, tables, cache, kernel, true) : null, clear = cover < 1 ? absorptionOf(m, atm, tables, cache, kernel, false) : null;
    const balance = (cover * (cloudy ? emittedBy(atm, cloudy) : 0) + (1 - cover) * (clear ? emittedBy(atm, clear) : 0)) / required;
    const main = cover >= 0.5 ? cloudy : clear, eff = effectiveDepths(main.ext, main.grid, atm, m.star.teff, { scat: main.scat }), tau = eff.tau, tauV = eff.tauV;
    if (!t) t = Float64Array.from(atm.tLay);
    if (it > 0) {   // `balance` and the depths belong to the profile the last pass produced: report that profile
      history.push({ change, balance, scale });
      const converged = it > 1 && change < tol && Math.abs(balance - 1) < balanceTol;
      out = { tp, iterations: it, change, balance, scale, converged, gamma: Float64Array.from(tau, (v, j) => tauV[j] / Math.max(v, 1e-300)), tau, tauV, absorbed: eff.absorbed, convectiveTop: out ? out.convectiveTop : null, history };
      if (converged || it === maxIter) break;
      // The level of the profile: T^4 of the grey solution is multiplied by one number c, moved until the emitted
      // flux equals the required one. Emission rises with c whatever the shape of the profile, inverted or not
      // (scaling the thermal depths instead, as an earlier version did, has no hold on an atmosphere whose hot upper
      // layers do the emitting). c is held within a factor of 3: beyond that the closure, not c, is at fault.
      scale = Math.min(3, Math.max(1 / 3, scale * Math.exp(Math.max(-0.5, Math.min(0.5, -gain * Math.log(balance))))));
    }
    const c4 = Math.pow(scale, 0.25), raw = guillotFromDepths(tau, tauV, par), mixed = Float64Array.from(raw, (v, j) => (it === 0 ? v * c4 : damping * v * c4 + (1 - damping) * t[j]));
    const adj = c.convection === false ? { t: mixed, top: -1 } : convectiveAdjustment(mixed, atm.pLay, c.nablaAd ?? 2 / 7);
    // Above pIso the profile is held at its value there. In gas that thin the closure's answer is not to be believed:
    // it rests on local thermodynamic equilibrium, and there the strong lines of sodium and potassium scatter
    // starlight rather than turn it into heat (the excited atom re-emits before a collision takes its energy), while
    // counted as absorbers they heat the top layers by hundreds of kelvin and, through the chemistry, turn their H2
    // into atoms. A real planet does have a hot, atomic upper atmosphere, but from extreme-ultraviolet heating, which
    // this model does not have.
    const pIso = c.pIso === undefined ? 1e-5 : c.pIso;
    if (pIso != null) { let k = 0; while (k < n - 1 && pBar[k] < pIso) k++; for (let j = 0; j < k; j++) adj.t[j] = adj.t[k]; }
    change = 0; for (let j = 0; j < n; j++) change = Math.max(change, Math.abs(adj.t[j] - t[j]));
    t = adj.t; tp = { kind: 'table', p: pBar, t: Array.from(t) };
    out = { convectiveTop: adj.top >= 0 ? pBar[adj.top] : null };
  }
  return out;
}

/**
 * How far a model is from losing the energy it must: its emission spectrum integrated over the table's wavelengths,
 * against sigma (4 f Teq^4 + Tint^4), the absorbed starlight (no reflection) plus the heat from below.
 *   model: with a tp that has teq, tint (and f), or pass them in `budget`.
 * Returns { emitted, required [W m^-2], ratio, teff: the temperature of a blackbody with the emitted flux, missing:
 *           the share of a blackbody's flux at that temperature that lies outside the tables' wavelengths }.
 */
export function energyBalance(model, tables, { budget = null, result = null } = {}) {
  const m = { ...DEFAULT_MODEL, ...model }, r = result || forwardModel(m, tables, { want: { transmission: false } }), b = budget || m.tp;
  const edges = r.grid.edges; let emitted = 0; for (let i = 0; i < r.wl.length; i++) emitted += r.flux[i] * (edges ? edges[i + 1] - edges[i] : r.wl[Math.min(i + 1, r.wl.length - 1)] - r.wl[Math.max(i - 1, 0)]) * (edges ? 1 : 0.5);
  const required = SIGMA * (4 * (b.f ?? 0.25) * b.teq ** 4 + (b.tint ?? 100) ** 4), teff = Math.pow(emitted / SIGMA, 0.25);
  let inside = 0; for (let i = 0; i < r.wl.length; i++) inside += Math.PI * planckSI(r.wl[i], teff) * (edges ? edges[i + 1] - edges[i] : 0);
  return { emitted, required, ratio: emitted / required, teff, missing: edges ? 1 - inside / (SIGMA * teff ** 4) : NaN };
}

/**
 * A model whose profile is 'consistent', made ready for forwardModel or dayNightModel: its tp replaced by the solved
 * table. Other models are returned as they are. `memo` (an object kept between calls) holds the last solution, reused
 * while nothing that enters it has changed.
 * Returns { model, climate: the consistentProfile result without its large arrays, or null }.
 */
export function withConsistentProfile(model, tables, { memo = null, cache = null, kernel = null } = {}) {
  if (!model.tp || model.tp.kind !== 'consistent') return { model, climate: null };
  const { night, ...rest } = model, key = JSON.stringify(rest) + '|' + (tables.lines || []).map((t) => t.species).join(',') + '|' + (tables.chem ? 1 : 0);
  let r = memo && memo.key === key ? memo.value : null;
  if (!r) { r = consistentProfile(model, tables, { cache, kernel }); if (memo) { memo.key = key; memo.value = r; } }
  let j1 = 0; while (j1 < r.tp.p.length - 1 && r.tp.p[j1] < 1) j1++;
  return { model: { ...model, tp: r.tp }, climate: { iterations: r.iterations, converged: r.converged, change: r.change, balance: r.balance, scale: r.scale, gamma1bar: r.gamma[j1], tau1bar: r.tau[j1], absorbed1bar: r.absorbed[j1], convectiveTop: r.convectiveTop } };
}
