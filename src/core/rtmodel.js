// The atmosphere forward model in one call: structure (atmosphere.js), gas and continuum extinction (opacity.js,
// continuum.js), then the transmission and emission spectra (transmission.js, emission.js).
//
// A model description (plain JSON, so it can be stored in a session and sent to a worker):
//   { planet: { mplanet [M Jup], rplanet [R Jup], pRef [bar] },
//     star: { rstar [R Sun], teff [K], logg (4.5), feh (0), spectrum: 'blackbody' to refuse the model spectrum of tables.star },
//     tp: { kind: 'isothermal' | 'guillot' | 'ms09' | 'table', ... }   (atmosphere.js, profileFrom)
//     vmr: { H2O: 1e-3, ... }   volume mixing ratios, constant with height; H2 and He fill the rest
//     heH2, pTop, pBottom [bar], nLayers, bulk: 'N2' | 'CO2' | ... (the gas that takes the rest; default H2 and He)
//     condensation: { rainout: true, humidity: 1, only: [names] } | null (condensation.js): gases limited by their vapour pressure or removed by the solids they form
//     opacityOff: [names], chemistry: { mh, co, quench, exclude, scale } | null (needs tables.chem), ionization: { mu0, fxuv } | null (needs star.ars), night: { dT } | null (dayNightModel),
//     rayleigh (true), rayleighFactor (1: the gas alone; more: a haze of small particles), haze: { factor, slope } | null, cloudTop [bar] | null,
//     cloud: { top, base, tau, radius, q0, albedo } | null (a particle layer, continuum.js; or { follow: 'MgSiO3', extent: 1, tau, ... }:
//            at the base of that condensate's cloud, needs `condensation`), cloudFraction (1) }
// Tables: { lines: [parsed 'xsec' or 'ktable' tables], cia: [parsed 'cia' tables] } on one wavelength grid.

import { buildAtmosphere, pressureLevels } from './atmosphere.js';
import { addContinuum } from './continuum.js';
import { gasExtinction, addPerWavelength, commonGrid, crossSection } from './opacity.js';
import { transmissionSpectrum, chordGeometry } from './transmission.js';
import { emissionSpectrum, fluxRatio, brightnessOf } from './emission.js';
import { C } from './derive.js';
import { equilibriumProfile } from './chemistry.js';
import { ionizeAtmosphere } from './ionization.js';
import { rainOut } from './condensation.js';
import { stellarFlux, resampleFlux } from './stellarspec.js';

export const DEFAULT_MODEL = {
  planet: { mplanet: 0.28, rplanet: 1.27, pRef: 0.01 },
  star: { rstar: 0.9, teff: 5400 },
  tp: { kind: 'guillot', teq: 1100, tint: 100, kappaIR: 1e-3, gamma: 0.4 },
  vmr: { H2O: 1e-3, CO2: 1e-5, CO: 1e-3, CH4: 1e-7 },
  heH2: 0.17, pTop: 1e-6, pBottom: 100, nLayers: 60,
  bulk: null, chemistry: null, condensation: null, ionization: null, night: null, rayleigh: true, rayleighFactor: 1, haze: null, cloudTop: null, cloud: null, cloudFraction: 1,
};

/**
 * The layered atmosphere of a model description. With `model.chemistry` ({ mh, co, quench, exclude, scale }) and a
 * chemistry table (tables.chem, src/core/chemistry.js) the mixing ratios come from chemical equilibrium on the
 * model's own temperatures and pressures, layer by layer, in place of `model.vmr`; `model.chemistryOverride`
 * ({ name: number | one value per layer }) replaces single species afterwards (the mean molecular weight stays the table's).
 */
export function atmosphereOf(model, tables = null) {
  const m = { ...DEFAULT_MODEL, ...model };
  let levels = m.levels;
  // a level is moved onto the top of the cloud deck, so that the deck does not snap to the grid as its top is varied
  if (!levels && m.cloudTop != null && m.cloudTop > m.pTop && m.cloudTop < m.pBottom && m.nLayers > 1) {
    levels = pressureLevels({ pTop: m.pTop, pBottom: m.pBottom, nLayers: m.nLayers });
    let k = 1; for (let i = 2; i < m.nLayers; i++) if (Math.abs(Math.log(levels[i] / m.cloudTop)) < Math.abs(Math.log(levels[k] / m.cloudTop))) k = i;
    levels[k] = m.cloudTop;
  }
  const base = { ...m.planet, tp: m.tp, heH2: m.heH2, pTop: m.pTop, pBottom: m.pBottom, nLayers: m.nLayers, levels }, fill = m.bulk && m.bulk !== 'H2He' ? m.bulk : true;
  const cond = m.condensation ? { mh: m.chemistry ? m.chemistry.mh ?? 0 : m.condensation.mh ?? 0, ...m.condensation } : null;
  // temperatures and pressures do not depend on the composition: build once for them, then again with the gases as
  // the chemistry and the condensation leave them
  if (!(m.chemistry && tables && tables.chem)) {
    const first = buildAtmosphere({ ...base, vmr: m.vmr, fill });
    if (!cond) return ionize(first, m);
    const listed = Object.fromEntries(Object.keys(m.vmr || {}).map((k) => [k, first.species[k]])), r = rainOut(first.tLay, Array.from(first.pLay, (p) => p / 1e5), listed, cond);
    return ionize(Object.assign(buildAtmosphere({ ...base, vmr: r.species, fill }), { condensation: { clouds: r.clouds, kept: r.kept } }), m);
  }
  const first = buildAtmosphere({ ...base, vmr: {} }), pBar = Array.from(first.pLay, (p) => p / 1e5), eq = equilibriumProfile(tables.chem, first.tLay, pBar, m.chemistry);
  let vmr = { ...eq.species }, condensation = null;
  for (const [s, v] of Object.entries(m.chemistryOverride || {})) vmr[s] = v;
  if (cond) { const r = rainOut(first.tLay, pBar, eq.species, cond); vmr = { ...vmr, ...Object.fromEntries(Object.keys(r.kept).filter((k) => !(m.chemistryOverride && k in m.chemistryOverride)).map((k) => [k, r.species[k]])) }; condensation = { clouds: r.clouds, kept: r.kept }; }
  const atm = buildAtmosphere({ ...base, vmr, mu: eq.mu, fill: false });
  if (condensation) atm.condensation = condensation;
  return ionize(atm, m);
}
/**
 * With `model.ionization` ({ mu0, fxuv [W m^-2 at the planet] }) hydrogen and sodium are reduced to their neutral
 * parts layer by layer (src/core/ionization.js, ionizeAtmosphere); the star is model.star (teff, ars). The atmosphere
 * gains `ionization` = { Na: { neutral, ion, half }, H: {...}, electrons }.
 */
function ionize(atm, m) {
  if (!m.ionization) return atm;
  atm.ionization = ionizeAtmosphere(atm, { teff: m.star.teff, ars: m.star.ars, fxuv: m.ionization.fxuv || 0, mu0: m.ionization.mu0 ?? 0.5 });
  return atm;
}
/**
 * A particle layer that follows a condensate ({ follow: 'MgSiO3', extent: 1, tau, ... }) put where the atmosphere says
 * that cloud begins: base at the condensate's base, top `extent` decades of pressure higher. null where it condenses
 * nowhere in the model. Other layers are returned as they are.
 */
export function placedCloud(cloud, atm) {
  if (!cloud || !cloud.follow) return cloud;
  const c = atm.condensation && atm.condensation.clouds.find((x) => x.name === cloud.follow);
  return c ? { ...cloud, base: c.base, top: c.base * Math.pow(10, -(cloud.extent ?? 1)) } : null;
}
/** Index of the level at the top of the deck (the first level at or below it in altitude), or null. */
function deckLevel(atm, cloudTop) {
  if (cloudTop == null) return null;
  const p = cloudTop * 1e5; let k = 0; while (k <= atm.n && atm.pLev[k] < p * (1 - 1e-9)) k++;
  return k > atm.n ? null : k;
}

/**
 * Run the model.
 *   want: { transmission: true, emission: true, maps: false, albedo: false }   maps adds the transmittance map and the
 *         contribution function; albedo keeps the absorption apart from the extinction (for geometricAlbedo)
 *   only: restrict the line opacity to these species (for per-species spectra); cache, interpolation, kernel: see gasExtinction
 * Returns { atm, grid, wl, extinction (all sources, as the transit sees it), scattering (with maps), weights, depth, radius, trans, flux,
 *           fpfs, brightness, contribution }. Emission is computed first, from absorption alone; scattering is then
 *           added to the same array for the transmission spectrum.
 */
export function forwardModel(model, tables, { want = {}, only = null, cache = null, greyBelow = 1e-2, interpolation = 'invT', kernel = null } = {}) {
  const m = { ...DEFAULT_MODEL, ...model }, atm = atmosphereOf(m, tables);
  // opacityOff: gases that stay in the atmosphere (its weight, its chemistry) but whose lines are left out
  const lineTables = m.opacityOff && m.opacityOff.length ? tables.lines.filter((t) => !m.opacityOff.includes(t.species)) : tables.lines;
  const gas = gasExtinction(atm, lineTables, { cia: only && !only.includes('CIA') ? [] : tables.cia || [], cache, only, greyBelow, interpolation, kernel });
  const { grid, weights } = gas, n = atm.n, ng = grid.ng;
  // scattering (Rayleigh, haze, the scattering share of a particle layer) removes light from the transit beam but
  // is no thermal source: it enters the transmission spectrum only. Absorbing continuum (H-, the cloud deck, the
  // absorbing share of the particles) enters both.
  const all = !only || only.includes('continuum'), rstar = m.star.rstar * C.Rsun, geom = want.transmission !== false ? chordGeometry(atm) : null;
  const deck = deckLevel(atm, m.cloudTop);
  // a particle layer that follows a condensate: its base at that cloud's base, its top `extent` decades of pressure higher
  m.cloud = placedCloud(m.cloud, atm);
  const spectra = (aerosol, gasExt) => {
    const scat = new Float64Array(grid.nWl * n), absb = new Float64Array(grid.nWl * n), o = {};
    if (all) addContinuum(atm, grid.wl, scat, { rayleigh: m.rayleigh && (aerosol ? m.rayleighFactor ?? 1 : 1), haze: aerosol ? m.haze : null, hminus: false, cloud: aerosol ? m.cloud : null, cloudShare: 'scattering' });
    addContinuum(atm, grid.wl, absb, { rayleigh: false, hminus: all, cloudTop: aerosol ? m.cloudTop : null, cloud: aerosol && all ? m.cloud : null, cloudShare: 'absorption' });
    if (want.emission !== false) {
      const ext = addPerWavelength(gasExt, absb, grid.nWl, ng, n);
      const e = emissionSpectrum(atm, grid.wl, ext, { weights, contribution: !!want.maps });
      o.flux = e.flux; o.brightness = e.brightness; o.contribution = e.contribution; o.absorption = ext;
    } else addPerWavelength(gasExt, absb, grid.nWl, ng, n);
    o.extinction = addPerWavelength(want.emission !== false && want.albedo ? gasExt.slice() : gasExt, scat, grid.nWl, ng, n);
    if (!(want.emission !== false && want.albedo)) o.absorption = null;   // the same array went on to hold scattering too
    if (want.maps) o.scattering = scat;   // scattering coefficient per wavelength and layer [m^-1], for the 3D view
    if (want.transmission !== false) {
      const t = transmissionSpectrum(atm, o.extinction, rstar, { weights, map: !!want.maps, geom: aerosol && deck != null ? { ...geom, opaqueFrom: deck } : geom });
      o.depth = t.depth; o.radius = t.radius; o.trans = t.trans; o.topTau = t.topTau;
    }
    return o;
  };
  // Patchy aerosols (Line & Parmentier 2016): a fraction of the limb, or of the disc, carries the haze, particles
  // and deck, the rest is clear; the spectrum is the mix of the two. Extinction and absorption are the cloudy column's.
  const hasAerosol = !!(m.haze || m.cloud || m.cloudTop != null || (m.rayleighFactor ?? 1) !== 1), f = hasAerosol ? Math.max(0, Math.min(1, m.cloudFraction ?? 1)) : 1;
  const clear = f < 1 ? spectra(false, gas.extinction.slice()) : null;
  const out = Object.assign({ atm, grid, wl: grid.wl, weights, cloudFraction: f }, spectra(true, gas.extinction));
  if (clear) {
    const mix = (a, b) => { if (a && b) for (let i = 0; i < a.length; i++) a[i] = f * a[i] + (1 - f) * b[i]; };
    // contribution rows are each normalised to their own flux: mix them by flux, then normalise again
    if (out.contribution && clear.contribution) { const nc = atm.n + 1; for (let i = 0; i < grid.nWl; i++) { const a = f * out.flux[i], b = (1 - f) * clear.flux[i], t = a + b || 1; for (let k = 0; k < nc; k++) out.contribution[i * nc + k] = (a * out.contribution[i * nc + k] + b * clear.contribution[i * nc + k]) / t; } }
    mix(out.depth, clear.depth); mix(out.trans, clear.trans); mix(out.flux, clear.flux);
    if (out.depth) for (let i = 0; i < out.depth.length; i++) out.radius[i] = Math.sqrt(out.depth[i]) * rstar;
    if (out.flux) for (let i = 0; i < out.flux.length; i++) out.brightness[i] = brightnessOf(out.flux[i] / Math.PI, grid.wl[i]);
  }
  // the star: a model spectrum when the tables carry a stellar grid (tables.star, src/core/stellarspec.js) and the model
  // does not ask for a blackbody; the grid's bins are averaged onto this model's, with a Rayleigh-Jeans tail beyond 5.5 micron
  if (out.flux) {
    let star = m.star;
    if (tables.star && grid.edges && m.star.spectrum !== 'blackbody' && !m.star.flux) { const sp = stellarFlux(tables.star, { teff: m.star.teff, logg: m.star.logg ?? 4.5, feh: m.star.feh ?? 0 }); star = { ...m.star, flux: resampleFlux(sp, grid.edges, m.star.teff) }; out.starFlux = star.flux; out.starClamped = sp.clamped; }
    out.fpfs = fluxRatio(grid.wl, out.flux, (m.planet.rplanet * C.Rjup) / rstar, star);
  }
  return out;
}

/** The night side's temperature profile: the day's, with its irradiation (or its temperature) lowered by dT kelvin. */
export function nightProfile(tp, dT) {
  if (typeof tp === 'number') return Math.max(50, tp - dT);
  if (tp.kind === 'isothermal') return { ...tp, t: Math.max(50, tp.t - dT) };
  if (tp.kind === 'guillot') return { ...tp, teq: Math.max(50, tp.teq - dT) };
  if (tp.kind === 'ms09') return { ...tp, t0: Math.max(50, tp.t0 - dT) };
  if (tp.kind === 'table') return { ...tp, t: tp.t.map((v) => Math.max(50, v - dT)) };
  throw new Error('no night side for this temperature profile');
}

/**
 * A planet whose night side is cooler: three columns of the same one-dimensional model.
 *   day         model.tp as given: the emission spectrum (an eclipse shows the day side)
 *   night       nightProfile(model.tp, model.night.dT): its own emission, for the 3D view and the cutaway
 *   terminator  each layer at the mean of the day and night temperatures: the transmission spectrum (a transit shows the limb)
 * Chemistry and opacity follow each column's own temperatures. Photoionization acts on the day side and on the limb (which
 * the star lights at grazing incidence; it is given the day side's mean slant, an upper estimate); the night side has none
 * (ions carried round by winds are not modelled). This is an interpolation between two
 * profiles, not a circulation model: no winds, no hot-spot offset, one limb for both terminators.
 * Without model.night (or dT = 0) it is forwardModel. opts as forwardModel, plus { night: false } to skip the night column.
 * Returns the terminator's result with flux, fpfs, brightness, contribution of the day side, and
 *   { day: { atm, extinction, absorption }, nightSide: { atm, flux, fpfs } | null, tpTerminator }.
 */
export function dayNightModel(model, tables, opts = {}) {
  const dT = model.night && model.night.dT;
  if (!(dT > 0)) return forwardModel(model, tables, opts);
  const want = opts.want || {}, sub = (k) => (opts.cache ? (opts.cache[k] ??= {}) : null);
  const day = want.emission !== false ? forwardModel(model, tables, { ...opts, cache: sub('day'), want: { ...want, transmission: false } }) : null;
  const atmD = day ? day.atm : atmosphereOf(model, tables), dark = { ...model, tp: nightProfile(model.tp, dT), ionization: null }, atmN = atmosphereOf(dark, tables);
  const tpTerminator = { kind: 'table', p: Array.from(atmD.pLay, (p) => p / 1e5), t: Array.from(atmD.tLay, (t, j) => 0.5 * (t + atmN.tLay[j])) };
  const term = forwardModel({ ...model, tp: tpTerminator }, tables, { ...opts, cache: sub('term'), want: { ...want, emission: false } });
  const night = opts.night !== false && want.emission !== false ? forwardModel(dark, tables, { ...opts, cache: sub('night'), want: { transmission: false } }) : null;
  const out = { ...term, tpTerminator, nightSide: night ? { atm: night.atm, flux: night.flux, fpfs: night.fpfs } : null };
  if (day) Object.assign(out, { flux: day.flux, fpfs: day.fpfs, starFlux: day.starFlux, starClamped: day.starClamped, brightness: day.brightness, contribution: day.contribution, day: { atm: day.atm, grid: day.grid, weights: day.weights, extinction: day.extinction, absorption: day.absorption } });
  return out;
}

/**
 * Extinction of one layer by absorber [m^-1], averaged over the g-points of each bin (the bin-mean opacity).
 * Returns { wl, parts: [{ name, y }], total, layer, p [bar], t [K] }. Collision-induced absorption is one part ('CIA').
 */
export function opacityByAbsorber(model, tables, layer) {
  const m = { ...DEFAULT_MODEL, ...model }, atm = atmosphereOf(m, tables), j = Math.max(0, Math.min(atm.n - 1, layer));
  const lines = tables.lines.filter((t) => atm.species[t.species] && !(m.opacityOff || []).includes(t.species)), grid = commonGrid(lines.length ? [...lines, ...(tables.cia || [])] : tables.cia);
  const { nWl, ng } = grid, w = grid.weights, parts = [], total = new Float64Array(nWl), buf = new Float64Array(nWl * ng);
  const push = (name, y) => { let any = false; for (let i = 0; i < nWl; i++) { total[i] += y[i]; if (y[i] > 0) any = true; } if (any) parts.push({ name, y }); };
  for (const t of lines) {
    crossSection(t, atm.tLay[j], atm.pLay[j] / 1e5, buf);
    const f = atm.nd[j] * atm.species[t.species][j], y = new Float64Array(nWl);
    for (let i = 0; i < nWl; i++) { let s = 0; if (ng === 1) s = buf[i]; else for (let q = 0; q < ng; q++) s += w[q] * buf[i * ng + q]; y[i] = f * s; }
    push(t.species, y);
  }
  const cia = new Float64Array(nWl), one = new Float64Array(nWl);
  for (const t of tables.cia || []) {
    const [a, b] = t.species.split('-'); if (!atm.species[a] || !atm.species[b]) continue;
    crossSection(t, atm.tLay[j], 1, one);
    const f = atm.nd[j] * atm.nd[j] * atm.species[a][j] * atm.species[b][j]; for (let i = 0; i < nWl; i++) cia[i] += f * one[i];
  }
  push('CIA', cia);
  const cont = new Float64Array(nWl * atm.n), split = addContinuum(atm, grid.wl, cont, { rayleigh: m.rayleigh && (m.rayleighFactor ?? 1), haze: m.haze, cloudTop: m.cloudTop, cloud: placedCloud(m.cloud, atm), parts: true }).parts || {};
  for (const [name, arr] of Object.entries(split)) { const y = new Float64Array(nWl); for (let i = 0; i < nWl; i++) y[i] = arr[i * atm.n + j]; push(name, y); }
  return { wl: grid.wl, parts, total, layer: j, p: atm.pLay[j] / 1e5, t: atm.tLay[j] };
}

/**
 * What the day side reflects, as a rough estimate for display (not validated against a scattering code): at each
 * wavelength the single-scattering albedo w of the gas above vertical optical depth 1 (scattering over extinction,
 * weighted by column), then the two-stream albedo of a deep scattering atmosphere, (1 - s) / (1 + s) with
 * s = sqrt(1 - w), times 2/3 for a Lambert sphere seen at full phase.
 * r: a forwardModel result run with want.albedo (and emission), so that r.absorption is kept apart from r.extinction.
 * Returns Float64Array(nWl).
 */
export function geometricAlbedo(r) {
  if (!r.absorption || !r.extinction) throw new Error('geometricAlbedo needs a result of forwardModel run with want: { albedo: true }');
  const { atm, grid, weights } = r, n = atm.n, ng = grid.ng, out = new Float64Array(grid.nWl);
  for (let i = 0; i < grid.nWl; i++) {
    let tau = 0, sExt = 0, sAbs = 0;
    for (let j = 0; j < n && tau < 1; j++) {
      let e = 0, a = 0;
      for (let q = 0; q < ng; q++) { const w = weights ? weights.w[q] : 1, o = (i * ng + q) * n + j; e += w * r.extinction[o]; a += w * r.absorption[o]; }
      tau += e * atm.dr[j]; sExt += e * atm.dr[j]; sAbs += a * atm.dr[j];
    }
    const w0 = sExt > 0 ? Math.max(0, 1 - sAbs / sExt) : 0, s = Math.sqrt(1 - w0);
    out[i] = (2 / 3) * (1 - s) / (1 + s);
  }
  return out;
}
