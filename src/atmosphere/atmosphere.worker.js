// Web Worker of the Atmosphere page: holds the opacity tables and runs the forward model (src/core/rtmodel.js).
// In:  { type: 'tables', buffers: [ArrayBuffer] }
//      { type: 'chem', buffer: ArrayBuffer }               the equilibrium chemistry table
//      { type: 'run', id, model, layer, parts: bool }     layer: index for the opacity-by-absorber plot
//      { type: 'opacity', id, layer }                      the opacity-by-absorber plot of the last model at another layer
//      { type: 'decades', id, layers: [index] }            the same at several layers, for the download
//      { type: 'star', buffer }                            the stellar flux grid (optional; without it the star is a blackbody)
//      { type: 'kernel', buffer }                          the WebAssembly mixing kernel (optional; without it the JavaScript loop runs)
//      { type: 'retrieve', id, model, data, free, priors, sampler }   fit the model to spectra (src/core/retrieval.js); nothing else runs meanwhile
// Out: { type: 'ready', species, grid } | { type: 'result', id, ... } | { type: 'part', id, name, depth, fpfs }
//      | { type: 'done', id } | { type: 'error', id, message }
//      | { type: 'retrieveProgress', id, ncalls, logZ, remFrac, elapsed } | { type: 'retrieved', id, result } | { type: 'retrieveError', id, message }
import { parseTable, loadMixKernel } from '../core/opacity.js';
import { parseChem } from '../core/chemistry.js';
import { parseStellar } from '../core/stellarspec.js';
import { dayNightModel, opacityByAbsorber, geometricAlbedo } from '../core/rtmodel.js';
import { withConsistentProfile } from '../core/climate.js';
import { runRetrieval } from '../core/retrieval.js';
import { retrievalData, retrievalSetup, retrievalResult } from '../core/atmoapi.js';

const tables = { lines: [], cia: [] }, cache = {}, memo = {}, climateCache = {};
let latest = 0, kernel = null, lastShown = null;
const pause = () => new Promise((r) => setTimeout(r, 0));   // lets a newer 'run' message arrive between the parts

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'tables') {
      const parsed = m.buffers.map((b) => parseTable(b));   // all of them before any is kept: a bad file leaves the set as it was
      for (const t of parsed) { const list = t.kind === 'cia' ? tables.cia : tables.lines, at = list.findIndex((x) => x.species === t.species); if (at >= 0) list[at] = t; else list.push(t); }
      for (const k of Object.keys(cache)) delete cache[k];
      const g = tables.lines[0] || tables.cia[0];
      self.postMessage({ type: 'ready', species: tables.lines.map((t) => ({ name: t.species, source: t.source, doi: t.doi, licence: t.licence, bytes: t.bytes })), cia: tables.cia.map((t) => ({ name: t.species, source: t.source, licence: t.licence })),
        grid: { nWl: g.nWl, ng: g.ng, wlMin: g.edges ? g.edges[0] : g.wl[0], wlMax: g.edges ? g.edges[g.nWl] : g.wl[g.nWl - 1], nT: g.t.length, nP: g.p ? g.p.length : 0 } });
    } else if (m.type === 'chem') {
      tables.chem = parseChem(m.buffer); for (const k of Object.keys(cache)) delete cache[k];
      self.postMessage({ type: 'chemReady', source: tables.chem.source, coSolar: tables.chem.coSolar });
    } else if (m.type === 'star') {
      tables.star = parseStellar(m.buffer);   // model stellar spectra: eclipse depths are then over a model star, not a blackbody
    } else if (m.type === 'kernel') {
      try { kernel = await loadMixKernel(m.buffer); } catch { kernel = null; }
    } else if (m.type === 'decades') {
      // for the download: the opacity by absorber at the layers asked for (one per decade of pressure)
      self.postMessage({ type: 'decades', id: m.id, decades: lastShown ? m.layers.map((j) => opacityByAbsorber(lastShown, tables, j)) : [] });
    } else if (m.type === 'opacity') {
      if (lastShown) self.postMessage({ type: 'opacity', id: m.id, opacity: opacityByAbsorber(lastShown, tables, m.layer) });
    } else if (m.type === 'retrieve') {
      // the page's model fitted to spectra: the tables cut to the data, 30 layers, the sampler of the light-curve fits
      try {
        const lost = m.free.filter((k) => k.startsWith('logX_') && !tables.lines.some((t) => t.species === k.slice(5))).map((k) => k.slice(5));
        if (lost.length) throw new Error('opacity tables not loaded: ' + lost.join(', '));
        if (m.model.chemistry && !tables.chem) throw new Error('the chemistry table is not loaded');
        const data = retrievalData(m.data), set = retrievalSetup(m.model, tables, data, m.free, { priors: m.priors });
        const r = runRetrieval({ model: set.model, tables: set.tables, free: m.free, priors: set.priors, data, sampler: m.sampler }, { kernel, onProgress: (q) => self.postMessage({ type: 'retrieveProgress', id: m.id, ncalls: q.ncalls, logZ: q.logZ, remFrac: q.remFrac, elapsed: q.elapsed }) });
        self.postMessage({ type: 'retrieved', id: m.id, result: retrievalResult(r, set.priors, set.merge) });
      } catch (err) { self.postMessage({ type: 'retrieveError', id: m.id, message: String((err && err.message) || err) }); }
    } else if (m.type === 'run') {
      latest = m.id;
      // a temperature profile that follows from the gas is solved first (and kept while its inputs stay the same)
      const solved = withConsistentProfile(m.model, tables, { memo, cache: climateCache, kernel }); m.model = solved.model;
      const t0 = performance.now(), r = dayNightModel(m.model, tables, { want: { maps: true, albedo: true }, cache, kernel }), ms = performance.now() - t0;
      const a = r.atm, shown = r.tpTerminator ? { ...m.model, tp: r.tpTerminator } : m.model, op = opacityByAbsorber(shown, tables, m.layer ?? Math.floor(a.n / 2));
      lastShown = shown;
      // the level where the atmosphere turns opaque to visible light from above (vertical optical depth 1 at 0.55 micron,
      // the day side's column): what scatters and absorbs there is shown under "How this is computed"
      const src = r.day && r.day.extinction ? r.day : r, ex = src.extinction, g = src.grid || r.grid, wts = (src.weights || r.weights) ? (src.weights || r.weights).w : [1], ng = g.ng, at = src.atm || a;
      let iv = 0; while (iv < g.nWl - 1 && g.wl[iv] < 0.55) iv++;
      let jv = at.n - 1, tau = 0; for (let j = 0; j < at.n; j++) { let e = 0; for (let q = 0; q < ng; q++) e += wts[q] * ex[(iv * ng + q) * at.n + j]; tau += e * at.dr[j]; if (tau >= 1) { jv = j; break; } }
      const visOpacity = opacityByAbsorber(r.day ? m.model : shown, tables, jv);
      const side = (x) => (x ? { tLay: x.atm.tLay, species: x.atm.species } : null);
      self.postMessage({ type: 'result', id: m.id, ms, wl: r.wl, edges: r.grid.edges, depth: r.depth, fpfs: r.fpfs, flux: r.flux, brightness: r.brightness, trans: r.trans, contribution: r.contribution, topTau: r.topTau, climate: solved.climate, visOpacity, starModel: !!r.starFlux, starFlux: r.starFlux || null, starClamped: r.starClamped || [], albedo: geometricAlbedo(r.day || r), day: side(r.day), night: side(r.nightSide), fpfsNight: r.nightSide ? r.nightSide.fpfs : null, scattering: Float32Array.from(r.scattering),
        atm: { n: a.n, pLev: a.pLev, pLay: a.pLay, tLay: a.tLay, rLev: a.rLev, rLay: a.rLay, mu: a.mu, g: a.g, r0: a.r0, gRef: a.gRef, species: a.species, ionization: a.ionization || null, condensation: a.condensation || null }, opacity: op });
      if (m.parts) {
        const names = [...tables.lines.map((t) => t.species).filter((s) => a.species[s] && a.species[s].some((v) => v > 0) && !(m.model.opacityOff || []).includes(s)), 'continuum'];
        for (const name of names) {
          await pause(); if (latest !== m.id) return;
          const p = dayNightModel(m.model, tables, { only: name === 'continuum' ? ['CIA', 'continuum'] : [name], cache, night: false, kernel });
          self.postMessage({ type: 'part', id: m.id, name, depth: p.depth, fpfs: p.fpfs });
        }
      }
      self.postMessage({ type: 'done', id: m.id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, tables: m.type === 'tables', message: String((err && err.message) || err) });
  }
};
