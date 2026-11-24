// Web Worker for retrievals (the Retrieval page, and the fit the Atmosphere page's assistant runs): holds the opacity
// tables and fits a model atmosphere to spectra (src/core/retrieval.js). It does nothing else, so that a fit can be
// stopped by ending the worker (src/retrieval/client.js), and the page that started it stays free meanwhile.
// In:  { type: 'tables', buffers: [ArrayBuffer] } | { type: 'chem', buffer } | { type: 'star', buffer } | { type: 'kernel', buffer }
//      { type: 'simulate', id, model, spec: { kind, wlMin, wlMax, R, noise, seed } }     a spectrum from the model, full tables
//      { type: 'retrieve', id, model, data, free, priors, sampler, merge, layers, band, species }   band: draws for the posterior's band (0: none);
//        species: the gases whose opacity is used (default: every table loaded)
// Out: { type: 'loaded', species: [names], chem: bool }
//      { type: 'simulated', id, set } | { type: 'progress', id, ncalls, logZ, remFrac, elapsed }
//      { type: 'retrieved', id, result (retrievalResult), post (retrievalPosterior), band: [{ lo, median, hi }] | null,
//        curve: { wl, transit, eclipse, night } (the best model on the grid the fit ran on) }
//      { type: 'failed', id, message }
import { parseTable, loadMixKernel, prepareTables } from '../core/opacity.js';
import { parseChem } from '../core/chemistry.js';
import { parseStellar } from '../core/stellarspec.js';
import { forwardModel, dayNightModel } from '../core/rtmodel.js';
import { buildRetrieval, runRetrieval, posteriorBand, simulateSpectrum } from '../core/retrieval.js';
import { retrievalData, retrievalSetup, retrievalResult, retrievalPosterior } from '../core/atmoapi.js';

const tables = { lines: [], cia: [] };
let kernel = null;
const said = () => self.postMessage({ type: 'loaded', species: [...tables.lines, ...tables.cia].map((t) => t.species), chem: !!tables.chem });
/** The tables a model needs, or an error that names what is missing. */
function tablesFor(model, free = [], species = null) {
  const gases = new Set([...Object.keys(model.vmr || {}).filter((g) => model.vmr[g] > 0), ...free.filter((k) => k.startsWith('logX_')).map((k) => k.slice(5))]);
  const have = new Set(tables.lines.map((t) => t.species)), lost = [...gases].filter((g) => !have.has(g) && !['H2', 'He', 'N2'].includes(g) && (!species || species.includes(g)));
  if (!model.chemistry && lost.length) throw new Error('opacity tables not loaded: ' + lost.join(', '));
  if ((model.chemistry || free.some((k) => ['mh', 'co', 'logQuench'].includes(k))) && !tables.chem) throw new Error('the chemistry table is not loaded');
  // `species`: the gases whose opacity counts (with chemical equilibrium every loaded table would otherwise be used)
  return species ? { ...tables, lines: tables.lines.filter((t) => species.includes(t.species)) } : tables;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'tables') {
      const parsed = m.buffers.map((b) => parseTable(b));
      for (const t of parsed) { const list = t.kind === 'cia' ? tables.cia : tables.lines, at = list.findIndex((x) => x.species === t.species); if (at >= 0) list[at] = t; else list.push(t); }
      said();
    } else if (m.type === 'chem') { tables.chem = parseChem(m.buffer); said(); }
    else if (m.type === 'star') { tables.star = parseStellar(m.buffer); }
    else if (m.type === 'kernel') { try { kernel = await loadMixKernel(m.buffer); } catch { kernel = null; } }
    else if (m.type === 'simulate') {
      const s = m.spec, use = prepareTables(tablesFor(m.model, [], m.species), { wlMin: 0.97 * s.wlMin, wlMax: 1.03 * s.wlMax, merge: 1 });
      self.postMessage({ type: 'simulated', id: m.id, set: simulateSpectrum({ model: m.model, tables: use, ...s }, { kernel }) });
    } else if (m.type === 'retrieve') {
      const data = retrievalData(m.data), set = retrievalSetup(m.model, tablesFor(m.model, m.free, m.species), data, m.free, { priors: m.priors, merge: m.merge ?? null, layers: m.layers ?? 30 });
      const spec = { model: set.model, tables: set.tables, free: m.free, priors: set.priors, data, sampler: m.sampler }, cache = {};
      const r = runRetrieval(spec, { kernel, cache, onProgress: (q) => self.postMessage({ type: 'progress', id: m.id, ncalls: q.ncalls, logZ: q.logZ, remFrac: q.remFrac, elapsed: q.elapsed }) });
      // what the figures need: the band the posterior gives each spectrum, and the best model on the fit's own grid
      const prob = buildRetrieval(spec, { kernel, cache });
      let band = null; if (m.band > 0 && r.converged) { try { band = posteriorBand(prob, r, { draws: m.band }); } catch { band = null; } }
      const kinds = new Set(data.map((d) => d.kind)), best = prob.modelAt(r.best.theta), night = kinds.has('night') || m.free.includes('nightDT') || !!(best.night && best.night.dT > 0);
      const want = { transmission: kinds.has('transit'), emission: kinds.has('eclipse') || kinds.has('night') };
      const f = night ? dayNightModel(best, set.tables, { want, kernel, night: kinds.has('night') }) : forwardModel(best, set.tables, { want, kernel });
      const curve = { wl: Float64Array.from(f.wl), transit: want.transmission ? Float64Array.from(f.depth) : null, eclipse: want.emission && f.fpfs ? Float64Array.from(f.fpfs) : null, night: f.nightSide && f.nightSide.fpfs ? Float64Array.from(f.nightSide.fpfs) : null };
      self.postMessage({ type: 'retrieved', id: m.id, result: { ...retrievalResult(r, set.priors, set.merge), layers: set.model.nLayers, sampling: r.sampling || null, insertionP: r.insertionP ?? null }, post: retrievalPosterior(r), band, curve });
    }
  } catch (err) {
    self.postMessage({ type: 'failed', id: m.id, message: String((err && err.message) || err) });
  }
};
