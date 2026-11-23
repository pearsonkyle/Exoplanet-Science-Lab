// Web Worker of the Star page: holds the stellar flux grid and runs the SED fit (src/core/sed.js).
// In:  { type: 'grid', buffer } | { type: 'fit', id, obs, priors, options }
// Out: { type: 'ready', grid: { teff, logg, feh } } | { type: 'result', id, ms, ...fitSed's result } | { type: 'error', id, message }
import { parseStellar } from '../core/stellarspec.js';
import { fitSed } from '../core/sed.js';

let grid = null;
self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'grid') { grid = parseStellar(m.buffer); self.postMessage({ type: 'ready', grid: { teff: [grid.teff[0], grid.teff[grid.teff.length - 1]], logg: [grid.logg[0], grid.logg[grid.logg.length - 1]], feh: [grid.feh[0], grid.feh[grid.feh.length - 1]], source: grid.source } }); }
    else if (m.type === 'fit') { const t0 = performance.now(), r = fitSed(grid, m.obs, { priors: m.priors, ...(m.options || {}) }); const { samples, ...out } = r; self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, ...out }); }   // the posterior goes in the quantities one reads; the raw samples stay here
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) }); }
};
