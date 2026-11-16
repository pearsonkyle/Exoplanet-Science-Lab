// Gap filling: estimate what a catalogue row lacks from what it has, with a named relation for every estimate.
// No DOM. The relations and their citations are in src/core/relations.js.
//
// fillGaps(v) never overwrites a catalogue value. It returns { field: { value, rel, from, note } } where rel is a
// key of RELATIONS, `from` lists the fields used and note says what was assumed. An estimate built on another
// estimate says so (chain: true): a K from a mass from a radius is two relations deep.

import * as R from '../relations.js';
import { torres } from '../stellar.js';
import { C } from '../derive.js';

const fin = Number.isFinite;

/**
 * v: common fields of one row (see fields.js). opts.transit overrides v.transit.
 * Returns the estimates only; the caller decides how to show them.
 */
export function fillGaps(v, opts = {}) {
  const est = {}, has = (k) => fin(v[k]) || (est[k] && fin(est[k].value)), val = (k) => (fin(v[k]) ? v[k] : est[k] ? est[k].value : NaN);
  const put = (key, value, rel, from, note = '') => {
    if (fin(v[key]) || est[key] || !fin(value)) return false;
    const chain = from.filter((k) => est[k]);
    est[key] = { value, rel, from, note: note + (chain.length ? (note ? '; ' : '') + `built on the estimated ${chain.join(', ')}` : ''), chain: chain.length > 0 };
    return true;
  };
  const transit = opts.transit ?? !!v.transit;

  // ---- star
  if (!has('mstar') && has('logg') && has('rstar')) put('mstar', R.massFromLogg(val('logg'), val('rstar')), 'gravity', ['logg', 'rstar']);
  if (!has('rstar') && has('logg') && has('mstar')) put('rstar', R.radiusFromLogg(val('logg'), val('mstar')), 'gravity', ['logg', 'mstar']);
  if (has('teff') && (!has('rstar') || !has('mstar'))) {
    const t = val('teff'), g = val('logg');
    if (!has('rstar') && !has('mstar') && fin(g) && t >= 4000 && t <= 10000) {
      const x = torres(t, g, fin(v.feh) ? v.feh : 0);
      if (x.mstar >= 0.6 && x.mstar < 5) {
        const from = ['teff', 'logg'].concat(fin(v.feh) ? ['feh'] : []), n = fin(v.feh) ? '' : 'solar metallicity assumed';
        put('mstar', x.mstar, 'torres10', from, n); put('rstar', x.rstar, 'torres10', from, n);
      }
    }
    const d = R.dwarfFromTeff(t);
    if (d && !(g < 4.0)) {                                    // not for evolved stars
      const note = `main-sequence star assumed (${d.sptype})` + (fin(g) ? '' : '; no log g to confirm it');
      // with one of the two known, only fill the other if the known one looks like a dwarf of this temperature
      const okR = !fin(v.rstar) || Math.abs(Math.log10(v.rstar / d.rstar)) < 0.12, okM = !fin(v.mstar) || Math.abs(Math.log10(v.mstar / d.mstar)) < 0.12;
      if (!has('rstar') && okM) put('rstar', d.rstar, 'pm13', ['teff'], note);
      if (!has('mstar') && okR) put('mstar', d.mstar, 'pm13', ['teff'], note);
    }
  }
  if (!has('logg') && has('mstar') && has('rstar')) put('logg', R.loggFromMassRadius(val('mstar'), val('rstar')), 'gravity', ['mstar', 'rstar']);
  if (!has('lum') && has('rstar') && has('teff')) put('lum', R.luminosity(val('rstar'), val('teff')), 'sb', ['rstar', 'teff']);

  // ---- planet size
  if (!has('rprs') && has('depth') && val('depth') > 0 && val('depth') < 0.5) put('rprs', Math.sqrt(val('depth')), 'depth', ['depth'], 'a limb-darkened depth overestimates it');
  if (!has('rprs') && has('rp') && has('rstar')) put('rprs', R.radiusRatio(val('rp'), val('rstar')), 'depth', ['rp', 'rstar'], 'Rp / R*');
  if (!has('rp') && has('rprs') && has('rstar')) put('rp', val('rprs') * val('rstar') * C.Rsun / C.Rjup, 'depth', ['rprs', 'rstar'], 'Rp = (Rp/R*) R*');
  if (!has('mass') && has('rp')) {
    const m = R.massFromRadiusCK17(val('rp') * R.RJUP_REARTH);
    if (m) put('mass', m.value / R.MJUP_MEARTH, 'ck17', ['rp'], `${m.regime} branch, scatter ${m.sigmaLog.toFixed(2)} dex`);
  } else if (!has('rp') && has('mass')) {
    const r = R.radiusFromMassCK17(val('mass') * R.MJUP_MEARTH);
    if (r) put('rp', r.value / R.RJUP_REARTH, 'ck17', ['mass'], `${r.regime} branch, scatter ${r.sigmaLog.toFixed(2)} dex` + (/sin/i.test(v.massKind || '') ? '; from M sin i, a lower limit on the mass' : ''));
    if (!has('rprs') && has('rp') && has('rstar')) put('rprs', R.radiusRatio(val('rp'), val('rstar')), 'depth', ['rp', 'rstar'], 'Rp / R*');
  }
  if (!has('depth') && has('rprs') && transit) put('depth', R.transitDepth(val('rprs')), 'depth', ['rprs']);

  // ---- orbit
  const mp = fin(v.mass) ? v.mass * C.Mjup_Msun : 0;
  if (!has('a') && has('ars') && has('rstar')) put('a', val('ars') * val('rstar') * C.Rsun / C.AU, 'kepler3', ['ars', 'rstar'], 'a = (a/R*) R*');
  if (!has('a') && has('per') && has('mstar')) put('a', R.semiMajorAxis(val('mstar') + mp, val('per')), 'kepler3', ['per', 'mstar']);
  if (!has('ars') && has('a') && has('rstar')) put('ars', R.scaledAxis(val('a'), val('rstar')), 'kepler3', ['a', 'rstar'], 'a / R*');
  const e = fin(v.ecc) ? Math.min(Math.max(v.ecc, 0), 0.99) : 0, w = fin(v.omega) ? v.omega : 0;
  if (!has('b') && has('inc') && has('ars')) put('b', Math.abs(R.impactParameter(val('ars'), val('inc'), e, w)), 'impact', ['ars', 'inc']);
  if (!has('inc') && has('b') && has('ars')) put('inc', R.inclinationFromImpact(val('ars'), val('b'), e, w), 'impact', ['ars', 'b']);
  if (transit && !has('t14') && has('per') && has('ars') && has('rprs')) {
    const b = has('b') ? val('b') : 0;
    const t = R.transitDuration(val('per'), val('ars'), val('rprs'), b, e, w);
    if (t > 0) put('t14', t, 't14', ['per', 'ars', 'rprs'].concat(has('b') ? ['b'] : []), has('b') ? '' : 'no impact parameter: central transit assumed, so this is the longest it can be');
  }
  if (!has('teq') && has('teff') && has('ars')) put('teq', R.equilibriumTemperature(val('teff'), val('ars')), 'teq', ['teff', 'ars'], 'albedo 0, heat spread over the whole planet');
  if (!has('insol') && has('teff') && has('rstar') && has('a')) put('insol', R.insolation(val('teff'), val('rstar'), val('a')), 'sb', ['teff', 'rstar', 'a']);
  if (!has('K') && has('mass') && has('mstar') && has('per')) {
    const msini = /sin/i.test(v.massKind || ''), inc = !msini && has('inc') ? val('inc') : 90;
    put('K', R.rvSemiAmplitude(val('mass'), val('mstar'), val('per'), e, inc), 'rvk', ['mass', 'mstar', 'per'], est.mass ? 'expected, not measured' : msini ? 'from M sin i' : '');
  }
  return est;
}
