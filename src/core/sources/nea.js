// NASA Exoplanet Archive: composite parameters, one row per planet (snapshot built by tools/build_catalog_table.py).
import { readSnapshot, mapQuantities, newRecord } from './snapshot.js';

// common field -> [archive column, scale to ESL units]
const MAP = {
  t14: ['pl_trandur', 1 / 24], depth: ['pl_trandep', 0.01], rprs: ['pl_ratror'], ars: ['pl_ratdor'], b: ['pl_imppar'], inc: ['pl_orbincl'], ecc: ['pl_orbeccen'],
  omega: ['pl_orblper'], K: ['pl_rvamp'], mass: ['pl_bmassj'], rp: ['pl_radj'], teq: ['pl_eqt'], a: ['pl_orbsmax'], insol: ['pl_insol'],
  teff: ['st_teff'], rstar: ['st_rad'], mstar: ['st_mass'], logg: ['st_logg'], feh: ['st_met'],
};
const err = (q) => (q.lo != null || q.hi != null ? ((q.lo ?? q.hi) + (q.hi ?? q.lo)) / 2 : 0);
const pairErr = (q) => (q.lo != null || q.hi != null ? [q.lo ?? q.hi, q.hi ?? q.lo] : null);
const PLAIN = { ra: 'ra', dec: 'dec', dist: 'sy_dist', vmag: 'sy_vmag', gmag: 'sy_gaiamag', tmag: 'sy_tmag', jmag: 'sy_jmag', kmag: 'sy_kmag', year: 'disc_year' };

export default {
  id: 'nea', short: 'NEA', label: 'NASA Exoplanet Archive', file: 'catalog-table/nea.json',
  url: 'https://exoplanetarchive.ipac.caltech.edu/',
  about: 'Planetary Systems Composite Parameters (pscomppars): one row per planet, each value with its own reference. The period and mid-transit time are the pair, from one reference of the Planetary Systems table, with the smallest predicted timing uncertainty today; the default parameter set of the archive is kept as the alternative.',
  acknowledgement: 'This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program.',
  planetUrl: (r) => 'https://exoplanetarchive.ipac.caltech.edu/overview/' + encodeURIComponent(r.name),
  records(json) {
    const S = readSnapshot(json), out = [];
    for (const row of S.rows) {
      const r = newRecord('nea', S.n(row, 'pl_name'), S.n(row, 'hostname'));
      r.hostAliases = ['hd_name', 'hip_name', 'tic_id', 'gaia_dr3_id'].map((c) => S.n(row, c)).filter(Boolean);
      mapQuantities(r, S, row, MAP);
      for (const [f, c] of Object.entries(PLAIN)) { const x = S.n(row, c); if (Number.isFinite(x)) r.v[f] = x; }
      const lum = S.q(row, 'st_lum'); if (lum && !lum.lim) { r.v.lum = 10 ** lum.v; if (lum.ref) r.ref.lum = lum.ref; }
      // ephemeris: the pair from one reference when there is one, else the composite values (possibly from two papers)
      // a paired ephemeris whose period disagrees with the composite one by more than 1% belongs to another planet (rows of
      // the archive's `ps` table taken from ExoFOP for a sibling, e.g. HD 106315 c given 1221 d instead of 21.06 d): ignore it
      const ePer = S.q(row, 'eph_per'), cPer = S.q(row, 'pl_orbper');
      const pairBad = !!(ePer && cPer && ePer.v > 0 && cPer.v > 0 && Math.abs(ePer.v / cPer.v - 1) > 0.01);
      const pair = !pairBad && S.q(row, 'eph_per') && S.q(row, 'eph_tmid');
      if (pairBad) r.info.ephemerisRejected = `best-timed period ${ePer.v} d disagrees with ${cPer.v} d`;
      mapQuantities(r, S, row, pair ? { per: ['eph_per'], tmid: ['eph_tmid'] } : { per: ['pl_orbper'], tmid: ['pl_tranmid'] });
      r.info.ephemerisPaired = !!pair;
      r.info.tsys = pair ? S.s(row, 'eph_tsys') : S.s(row, 'pl_tranmid_systemref');
      r.info.nEphemerisRefs = S.n(row, 'eph_nrefs') || 0;
      // both choices of ephemeris, for the planner: `best` is what r.v.per / r.v.tmid hold (smallest predicted uncertainty
      // today, or the composite values when no reference gives a pair with errors); `default` is the archive's default
      // parameter set (ps default_flag = 1) when it gives both, else the composite values (which may mix two papers)
      const eph = (pc, tc, tsys, kind) => { const p = S.q(row, pc), t = S.q(row, tc); return p && t && p.v > 0 && t.v > 2.2e6 && !p.lim && !t.lim ? { kind, cat: 'nea', per: p.v, tmid: t.v, perE: pairErr(p), tmidE: pairErr(t), perErr: err(p), tmidErr: err(t), hasErr: err(p) > 0 && err(t) > 0, ref: p.ref === t.ref ? p.ref : [p.ref, t.ref].filter(Boolean).join(' + '), refUrl: p.refUrl, mixed: p.ref !== t.ref, tsys: tsys || '' } : null; };
      const comp = eph('pl_orbper', 'pl_tranmid', S.s(row, 'pl_tranmid_systemref'), 'composite');
      r.info.ephemerides = { best: (pair && eph('eph_per', 'eph_tmid', S.s(row, 'eph_tsys'), 'best')) || comp, default: eph('def_per', 'def_tmid', S.s(row, 'def_tsys'), 'default') || comp };
      r.v.status = S.n(row, 'pl_controv_flag') ? 'Confirmed (disputed)' : 'Confirmed';
      r.v.method = S.s(row, 'discoverymethod') || ''; r.v.facility = S.s(row, 'disc_facility') || ''; r.v.sptype = S.s(row, 'st_spectype') || '';
      r.v.transit = S.n(row, 'tran_flag') === 1;
      if (r.v.mass != null) r.v.massKind = S.s(row, 'pl_bmassprov') || 'Mass';
      r.info.rv = S.n(row, 'rv_flag') === 1; r.info.ttv = S.n(row, 'ttv_flag') === 1; r.info.circumbinary = S.n(row, 'cb_flag') === 1; r.info.nplanets = S.n(row, 'sy_pnum');
      out.push(r);
    }
    return { meta: S.meta, records: out };
  },
};
