// The Extrasolar Planets Encyclopaedia, exoplanet.eu (snapshot built by tools/build_catalog_eu.py).
import { readSnapshot, mapQuantities, newRecord } from './snapshot.js';

const MAP = {
  per: ['orbital_period'], a: ['semi_major_axis'], ecc: ['eccentricity'], inc: ['inclination'], omega: ['omega'], b: ['impact_parameter'], K: ['k'],
  rp: ['radius'], teq: ['temp_calculated'], dist: ['star_distance'], feh: ['star_metallicity'], mstar: ['star_mass'], rstar: ['star_radius'], teff: ['star_teff'],
};
const PLAIN = { ra: 'ra', dec: 'dec', vmag: 'mag_v', jmag: 'mag_j', kmag: 'mag_k', year: 'discovered' };
const METHOD = { 'Primary Transit': 'Transit', TTV: 'Transit Timing Variations', Timing: 'Timing', 'Radial Velocity': 'Radial Velocity', Imaging: 'Imaging', Microlensing: 'Microlensing', Astrometry: 'Astrometry' };
// Sanity rules on the period and epoch of exoplanet.eu (snapshot of 2026-11-15; test/sources.test.mjs counts them):
//  - 117 Kepler planets and KOIs carry the error of tzero_tr with the Kepler time offset added: 2454833 ± 0.00867
//    for ±0.00867 d (KOI-6256 b; the archive's KOI table gives koi_time0_err 0.00867). The offset (BJD - BKJD) is
//    taken off; any other epoch error larger than 1e5 d (Kepler-504 Ab: the error equals the epoch) is dropped.
//  - 16 epochs are not Julian dates (TOI-1266 d 1729.03, a BTJD; Kepler-1843 b 25.54; TOI-1444 c 2577713): not used.
//  - 25 period errors are larger than the period itself (HAT-P-15 b: 10.86 ± 27 d): no ephemeris can be propagated
//    with them, so they are dropped (the period is kept).
// Every rule applied is noted in rec.info.ephemerisNotes; rec.info.ephemeris is the pair that survives, or null
// with rec.info.ephemerisRejected saying why.
const BKJD = 2454833, JD_MIN = 2.2e6, JD_MAX = 2.5e6;
const symErr = (e) => (e ? (e[0] + e[1]) / 2 : 0);
function sanitizeEphemeris(r, tcol) {
  const notes = [];
  if (r.e.tmid) {
    const e = r.e.tmid;
    if (e.some((x) => x > 1e5)) {
      if (e.every((x) => Math.abs(x - BKJD) < 1)) { r.e.tmid = e.map((x) => Math.abs(x - BKJD)); notes.push(`epoch error had the Kepler offset ${BKJD} added (taken off)`); }
      else { delete r.e.tmid; notes.push('epoch error larger than 1e5 d (dropped)'); }
    }
  }
  if (Number.isFinite(r.v.tmid) && !(r.v.tmid > JD_MIN && r.v.tmid < JD_MAX)) {
    r.info.ephemerisRejected = `epoch ${r.v.tmid} is not a Julian date`;
    delete r.v.tmid; delete r.e.tmid; delete r.lim.tmid;
  }
  if (r.v.per > 0 && r.e.per && Math.max(...r.e.per) >= r.v.per) { delete r.e.per; notes.push('period error larger than the period (dropped)'); }
  r.info.ephemerisNotes = notes;
  r.info.ephemeris = r.v.per > 0 && Number.isFinite(r.v.tmid) ? {
    kind: 'eu', cat: 'eu', per: r.v.per, tmid: r.v.tmid, perE: r.e.per || null, tmidE: r.e.tmid || null, perErr: symErr(r.e.per), tmidErr: symErr(r.e.tmid),
    hasErr: !!(r.e.per && r.e.tmid), ref: '', refUrl: '', mixed: false, tsys: '', epoch: tcol === 'tzero_tr' ? 'transit' : 'conjunction', notes,
  } : null;
  if (!r.info.ephemeris && !r.info.ephemerisRejected) r.info.ephemerisRejected = r.v.per > 0 ? 'no epoch (tzero_tr or tconj)' : 'no period';
}
const split = (s) => (typeof s === 'string' ? s.split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean) : []);

export default {
  id: 'eu', short: 'EU', label: 'exoplanet.eu', file: 'catalog-eu/planets.json',
  url: 'https://exoplanet.eu/',
  about: 'The Extrasolar Planets Encyclopaedia: one row per object, no reference per value. Its upper mass limit is 60 Mjup, so it lists brown dwarfs the NASA archive leaves out.',
  acknowledgement: 'This research has made use of data obtained from or tools provided by the portal exoplanet.eu of The Extrasolar Planets Encyclopaedia.',
  planetUrl: (r) => 'https://exoplanet.eu/catalog/?q=' + encodeURIComponent(r.name),
  records(json) {
    const S = readSnapshot(json), out = [];
    for (const row of S.rows) {
      const r = newRecord('eu', S.n(row, 'name'), S.n(row, 'star_name'));
      r.aliases = split(S.n(row, 'alternate_names')); r.hostAliases = split(S.n(row, 'star_alternate_names'));
      mapQuantities(r, S, row, MAP);
      // the transit epoch when given, else the time of conjunction
      const tcol = S.q(row, 'tzero_tr') ? 'tzero_tr' : 'tconj';
      mapQuantities(r, S, row, { tmid: [tcol] });
      sanitizeEphemeris(r, tcol);
      // a true mass when given, else M sin i
      if (S.q(row, 'mass')) { mapQuantities(r, S, row, { mass: ['mass'] }); r.v.massKind = S.s(row, 'mass_measurement_type') || 'Mass'; }
      else if (S.q(row, 'mass_sini')) { mapQuantities(r, S, row, { mass: ['mass_sini'] }); r.v.massKind = 'Msini'; }
      for (const [f, c] of Object.entries(PLAIN)) { const x = S.n(row, c); if (Number.isFinite(x)) r.v[f] = x; }
      const det = S.s(row, 'detection_type') || '';
      r.v.status = S.s(row, 'planet_status') || '';
      r.v.method = det.split(',').map((x) => METHOD[x.trim()] || x.trim()).join(', ');
      r.v.sptype = S.s(row, 'star_sp_type') || '';
      r.v.transit = /Primary Transit/.test(det) || !!S.q(row, 'tzero_tr') || /Transit/.test(S.s(row, 'radius_measurement_type') || '');
      r.info.publication = S.s(row, 'publication') || ''; r.info.updated = S.n(row, 'updated') || '';
      out.push(r);
    }
    return { meta: S.meta, records: out };
  },
};
