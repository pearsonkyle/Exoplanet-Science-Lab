// TESS Objects of Interest, from the NASA Exoplanet Archive's `toi` table (snapshot built by tools/build_catalog_table.py).
import { readSnapshot, mapQuantities, newRecord } from './snapshot.js';
import { C } from '../derive.js';

const MAP = {
  per: ['pl_orbper'], tmid: ['pl_tranmid'], t14: ['pl_trandurh', 1 / 24], depth: ['pl_trandep', 1e-6], rp: ['pl_rade', C.Rearth / C.Rjup],
  teff: ['st_teff'], rstar: ['st_rad'], logg: ['st_logg'], dist: ['st_dist'], tmag: ['st_tmag'],
};
const STATUS = { PC: 'Candidate', APC: 'Candidate (ambiguous)', CP: 'Known planet (TOI entry)', KP: 'Known planet (TOI entry)', FP: 'False positive', FA: 'False alarm' };

export default {
  id: 'toi', short: 'TOI', label: 'TESS Objects of Interest', file: 'catalog-table/toi.json',
  url: 'https://exofop.ipac.caltech.edu/tess/',
  about: 'TESS Project candidates with the TFOPWG disposition, as mirrored by the NASA Exoplanet Archive. Values are pipeline estimates, not published fits; a period of 0 means a single transit.',
  acknowledgement: 'This research has made use of the Exoplanet Follow-up Observation Program (ExoFOP) website and the NASA Exoplanet Archive.',
  planetUrl: (r) => 'https://exofop.ipac.caltech.edu/tess/target.php?id=' + encodeURIComponent(r.info.tic || ''),
  records(json) {
    const S = readSnapshot(json), out = [];
    for (const row of S.rows) {
      const toi = S.n(row, 'toi'), tic = S.n(row, 'tid');
      const r = newRecord('toi', 'TOI-' + Number(toi).toFixed(2), 'TIC ' + tic);
      r.hostAliases = ['TOI-' + Math.floor(toi)];
      mapQuantities(r, S, row, MAP);
      if (!(r.v.per > 0)) { delete r.v.per; delete r.e.per; }
      for (const f of ['ra', 'dec']) { const x = S.n(row, f); if (Number.isFinite(x)) r.v[f] = x; }
      for (const [f, c] of [['insol', 'pl_insol'], ['teq', 'pl_eqt']]) { const x = S.n(row, c); if (Number.isFinite(x) && x > 0) r.v[f] = x; }
      const disp = S.s(row, 'tfopwg_disp') || '';
      r.v.status = STATUS[disp] || 'Candidate (no disposition)';
      r.v.method = 'Transit'; r.v.facility = 'TESS'; r.v.transit = true;
      const y = /^(\d{4})/.exec(S.n(row, 'toi_created') || ''); if (y) r.v.year = +y[1];
      r.info.disposition = disp; r.info.tic = tic; r.info.updated = S.n(row, 'rowupdate') || ''; r.info.tsys = 'BJD';
      out.push(r);
    }
    return { meta: S.meta, records: out };
  },
};
