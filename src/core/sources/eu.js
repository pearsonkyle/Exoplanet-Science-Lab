// The Extrasolar Planets Encyclopaedia, exoplanet.eu (snapshot built by tools/build_catalog_eu.py).
import { readSnapshot, mapQuantities, newRecord } from './snapshot.js';

const MAP = {
  per: ['orbital_period'], a: ['semi_major_axis'], ecc: ['eccentricity'], inc: ['inclination'], omega: ['omega'], b: ['impact_parameter'], K: ['k'],
  rp: ['radius'], teq: ['temp_calculated'], dist: ['star_distance'], feh: ['star_metallicity'], mstar: ['star_mass'], rstar: ['star_radius'], teff: ['star_teff'],
};
const PLAIN = { ra: 'ra', dec: 'dec', vmag: 'mag_v', jmag: 'mag_j', kmag: 'mag_k', year: 'discovered' };
const METHOD = { 'Primary Transit': 'Transit', TTV: 'Transit Timing Variations', Timing: 'Timing', 'Radial Velocity': 'Radial Velocity', Imaging: 'Imaging', Microlensing: 'Microlensing', Astrometry: 'Astrometry' };
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
      mapQuantities(r, S, row, S.q(row, 'tzero_tr') ? { tmid: ['tzero_tr'] } : { tmid: ['tconj'] });
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
