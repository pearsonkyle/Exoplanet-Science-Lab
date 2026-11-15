// Catalogue lookup, reference selection, gap filling and consistency checks.
// Independent reference for the physics: astropy 7 constants and units (G, M_sun, R_sun, R_jup, M_jup, au), evaluated once
// in Python and pasted below (see REF); the circular-orbit duration is Winn (2010) eq. 14, exact for e = 0.
// Real systems come from the snapshot in public/catalog (skipped with a FAIL if it has not been built).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { normalizeName, loadIndex, searchNames, resolveName, lookupHost, chooseParameters, suggestPriors, systemFromRows, runChecks,
  arsKepler, rhoFromArs, rhoFromMR, loggFromMR, impactParameter, rvAmplitude, transitDuration } from '../src/core/catalog.js';
import { validatePrior } from '../src/core/priors.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const withPlanet = (ars, mp, ms) => ars * Math.cbrt(1 + mp * 9.5458e-4 / ms);   // Kepler with M* + Mp instead of M*: a scales as the cube root of the total mass

// --- astropy reference values: M* = 1 Msun, R* = 1 Rsun, P = 3 d, i = 87 deg, Rp/R* = 0.1, Mp = 1 Mjup, e = 0
const REF = {
  ars: 8.753571710059788, aAU: 0.04070819865411757, rho: 1.4097798243075257, logg: 4.438067627303133,
  b: 0.45812654598716124, t14: 0.10948627288533416, K: 140.636849834564, Kmsini: 140.82985225259472,
  rprsJupSun: 0.10276268506540175,                      // 1 Rjup / 1 Rsun
  // the same star with a/R* inflated by 1.3
  ars13: 11.379643223077725, rho13: 3.0972862740036207, t14_13: 0.07779986828084368, b13: 0.5955645097833097,
  mFromLogg: 1.0478397387180372,                        // M* for log g = 4.3, R* = 1.2 Rsun
  // HD 80606 with M* = R* = 1.05, P = 111.436765 d, e = 0.93183, omega = -58.887 deg, i = 89.24 deg, a/R* = 94.452, Mp = 4.1641 Mjup
  hdArs: 94.33305992112659, hdB: 0.8159069620536539, hdK: 467.89692467309237,
};

// --- formulas against astropy
check('a/R* from Kepler', rel(arsKepler(1, 1, 3), REF.ars) < 2e-6, `${arsKepler(1, 1, 3).toFixed(6)} vs ${REF.ars.toFixed(6)} (astropy)`);
check('stellar density from a/R*, P and from M*, R*', rel(rhoFromArs(REF.ars, 3), REF.rho) < 5e-6 && rel(rhoFromMR(1, 1), REF.rho) < 5e-6, `${rhoFromArs(REF.ars, 3).toFixed(6)}, ${rhoFromMR(1, 1).toFixed(6)} vs ${REF.rho.toFixed(6)} g/cm^3`);
check('log g from M*, R*', Math.abs(loggFromMR(1, 1) - REF.logg) < 1e-5, `${loggFromMR(1, 1).toFixed(6)} vs ${REF.logg.toFixed(6)}`);
check('impact parameter', rel(impactParameter(REF.ars, 87), REF.b) < 1e-9 && rel(impactParameter(94.452, 89.24, 0.93183, -58.887), REF.hdB) < 1e-9, `${impactParameter(94.452, 89.24, 0.93183, -58.887).toFixed(6)} vs ${REF.hdB.toFixed(6)} (HD 80606 b)`);
check('transit duration, circular', rel(transitDuration(3, REF.ars, 87, 0.1), REF.t14) < 1e-7, `${transitDuration(3, REF.ars, 87, 0.1).toFixed(8)} vs ${REF.t14.toFixed(8)} d (Winn 2010 eq. 14)`);
check('RV semi-amplitude', rel(rvAmplitude(1, 3, 0, Math.sin(87 * Math.PI / 180), 1), REF.K) < 5e-5 && rel(rvAmplitude(4.1641, 111.436765, 0.93183, Math.sin(89.24 * Math.PI / 180), 1.05), REF.hdK) < 5e-5,
  `${rvAmplitude(1, 3, 0, Math.sin(87 * Math.PI / 180), 1).toFixed(3)} vs ${REF.K.toFixed(3)}; HD 80606 b ${rvAmplitude(4.1641, 111.436765, 0.93183, Math.sin(89.24 * Math.PI / 180), 1.05).toFixed(2)} vs ${REF.hdK.toFixed(2)} m/s`);

// --- names
check('normalizeName', normalizeName('HAT-P-32 b') === 'hatp32b' && normalizeName(' hat-p-32B ') === 'hatp32b' && normalizeName('TRAPPIST-1') === 'trappist1' && normalizeName(null) === '');

// --- hand-made rows -------------------------------------------------------------------------------------------
const pm = (o, col, v, e) => { o[col] = v; if (e != null) { o[col + 'err1'] = e; o[col + 'err2'] = -e; } };
function row(ref, pubdate, spec, extra = {}) {
  const o = { pl_name: 'Fix-1 b', hostname: 'Fix-1', pl_ref: ref, pl_refurl: '', st_ref: ref, st_refurl: '', pl_pubdate: pubdate, default_flag: 0, tran_flag: 1, rv_flag: 1, soltype: 'Published Confirmed', lim: {}, ...extra };
  for (const [col, v] of Object.entries(spec)) Array.isArray(v) ? pm(o, col, v[0], v[1]) : pm(o, col, v);
  return o;
}
const STAR = { st_mass: [1, 0.05], st_rad: [1, 0.03], st_logg: [4.438, 0.03], st_teff: [5772, 60], st_met: [0, 0.05], st_dens: [1.41, 0.1] };
const FULL = { pl_orbper: [3, 1e-5], pl_tranmid: [2457000.5, 3e-4], pl_ratdor: [8.7536, 0.15], pl_ratror: [0.1, 0.002], pl_orbincl: [87, 0.3], pl_imppar: [0.458, 0.03],
  pl_trandur: [REF.t14 * 24, 0.05], pl_trandep: [1.0, 0.03], pl_radj: [0.1 / REF.rprsJupSun, 0.02], pl_orbsmax: [0.040708, 0.0007], pl_rvamp: [140.64, 3], pl_bmassj: [1, 0.03], pl_orbeccen: [0, 0], ...STAR };
const good = row('Good et al. 2015', '2015-03', FULL, { pl_bmassprov: 'Mass', pl_tsystemref: 'BJD-TDB' });
// newer, equally complete, but its a/R* is 30% too large for its own star and period
const bad = row('Newer et al. 2022', '2022-06', { ...FULL, pl_ratdor: [REF.ars13, 0.1] }, { pl_bmassprov: 'Mass', pl_tsystemref: 'BJD-TDB' });
// newest and the archive default, with the best period, but nothing else
const sparse = row('Sparse et al. 2024', '2024-01', { pl_orbper: [3.0000004, 2e-7], pl_tranmid: [2459000.5003, 1e-4] }, { default_flag: 1, pl_tsystemref: 'HJD' });
// no a/R*, inclination, Rp/R* or eccentricity: all must be derived from its own numbers
const { pl_ratdor: _a, pl_ratror: _k, pl_orbincl: _i, pl_orbeccen: _e, pl_orbsmax: _s, pl_trandur: _t, pl_rvamp: _K, ...PART } = FULL;
const noars = row('Noars et al. 2010', '2010-01', PART, { pl_bmassprov: 'Mass' });
// RV-only solution whose stellar values come from a catalogue, with no log g
const rv = row('Rv et al. 2012', '2012-05', { pl_orbper: [3.00002, 2e-5], pl_rvamp: [141, 2], pl_orbeccen: [0.1, 0.02], pl_orblper: [45, 10], pl_msinij: [1.0, 0.03], pl_bmassj: [1.0, 0.03], st_mass: [1, 0.1], st_rad: [1, 0.05] },
  { st_ref: 'TICv8', pl_bmassprov: 'Msini', tran_flag: 0 });
const FIX = [sparse, bad, good, noars, rv];

{
  const r = chooseParameters(FIX, 'fix1b', { use: 'transit' });
  const alt = Object.fromEntries(r.alternatives.map((a) => [a.reference, a]));
  check('transit: the self-consistent reference beats the newer inconsistent one and the sparse default', r.reference.label === 'Good et al. 2015',
    r.alternatives.map((a) => `${a.reference} ${a.score.toFixed(1)}`).join(' | '));
  const kep = alt['Newer et al. 2022'].checks.find((c) => c.name === 'kepler'), den = alt['Newer et al. 2022'].checks.find((c) => c.name === 'density'), dur = alt['Newer et al. 2022'].checks.find((c) => c.name === 'duration');
  check('inflated a/R* fails Kepler with the right numbers', kep.status === 'fail' && rel(kep.computed, withPlanet(REF.ars, 1, 1)) < 2e-6 && rel(kep.reported, REF.ars13) < 1e-12 && Math.abs(kep.nsigma - 6.96) < 0.05, kep.detail);
  check('... and the density comparison', den.status === 'fail' && rel(den.reported, REF.rho13) < 1e-5 && rel(den.computed, REF.rho) < 1e-5, den.detail);
  check('... and the duration', dur.status !== 'ok' && rel(dur.computed, REF.t14_13) < 1e-6, dur.detail);
  check('the consistent reference passes every check', alt['Good et al. 2015'].failed.length === 0 && alt['Good et al. 2015'].warned.length === 0 && alt['Good et al. 2015'].nOk >= 11, `${alt['Good et al. 2015'].nOk} ok: ${alt['Good et al. 2015'].checks.map((c) => c.name).join(', ')}`);
  check('alternatives list every reference with what it lacks', r.alternatives.length === 5 && alt['Sparse et al. 2024'].missing.includes('ars') && alt['Sparse et al. 2024'].isDefault && r.alternatives.filter((a) => a.chosen).length === 1);
  check('values carry source and kind', ['per', 'tmid', 'rprs', 'ars', 'inc', 'b', 't14', 'K', 'mplanet', 'teff', 'logg', 'feh', 'rstar', 'mstar'].every((k) => r.values[k].kind === 'reference' && r.values[k].source === 'Good et al. 2015') && r.values.omega.kind === 'default' && r.values.t14.value > 0.109 && r.values.t14.value < 0.11);
  console.log('info why: ' + r.reference.why);

  const eph = chooseParameters(FIX, 'Fix-1 b', { use: 'ephemeris' });
  check('ephemeris: the reference with the best period wins instead', eph.reference.label === 'Sparse et al. 2024' && /HJD/.test(eph.values.tmid.note), eph.reference.why);
  check('... and what it lacks is filled from the best other reference and flagged', eph.values.ars.kind === 'other' && eph.values.ars.source === 'Good et al. 2015' && eph.values.rstar.kind === 'other' && eph.values.inc.kind === 'other');
  const rvr = chooseParameters(FIX, 'Fix-1 b', { use: 'rv' });
  check('rv: needs K, e, omega', ['Good et al. 2015', 'Rv et al. 2012'].includes(rvr.reference.label) && rvr.values.K.kind === 'reference', rvr.reference.why);
}
{ // gap filling from the reference's own numbers
  const r = chooseParameters(FIX, 'Fix-1 b', { reference: 'Noars et al. 2010' }), v = r.values;
  check('a/R* derived by Kepler from the reference\'s own M*, R*, P', v.ars.kind === 'derived' && rel(v.ars.value, withPlanet(REF.ars, 1, 1)) < 2e-6 && /Kepler/.test(v.ars.note), `${v.ars.value.toFixed(5)} ± ${v.ars.err.toFixed(3)}: ${v.ars.note}`);
  check('... with the propagated error', rel(v.ars.err, v.ars.value * Math.hypot(0.05 / 3, 0.03)) < 1e-9, `${v.ars.err.toFixed(4)} = a/R* x sqrt((sigma_M / 3M)^2 + (sigma_R / R)^2)`);
  const incRef = Math.acos(0.458 / withPlanet(REF.ars, 1, 1)) * 180 / Math.PI;
  check('inclination derived from b and a/R*', v.inc.kind === 'derived' && Math.abs(v.inc.value - incRef) < 1e-5 && v.inc.err > 0.1 && v.inc.err < 0.4, `${v.inc.value.toFixed(4)} ± ${v.inc.err.toFixed(2)} vs ${incRef.toFixed(4)} deg: ${v.inc.note}`);
  check('Rp/R* from the depth', v.rprs.kind === 'derived' && Math.abs(v.rprs.value - 0.1) < 1e-12 && rel(v.rprs.err, 0.0015) < 1e-9, v.rprs.note);
  check('e taken from another reference, omega defaulted, both labelled', v.ecc.kind === 'other' && v.ecc.source === 'Good et al. 2015' && v.ecc.value === 0 && v.omega.kind === 'default' && v.omega.value === 0, `${v.ecc.note} | ${v.omega.note}`);
  check('duration and K computed', v.t14.kind === 'derived' && rel(v.t14.value, transitDuration(3, v.ars.value, v.inc.value, 0.1)) < 1e-9 && rel(v.t14.value, REF.t14) < 2e-3 && v.K.kind === 'derived' && rel(v.K.value, REF.K) < 2e-4, `T14 ${v.t14.value.toFixed(5)} d, K ${v.K.value.toFixed(2)} m/s`);
  check('user-chosen reference is reported as such', /chosen by the user/.test(r.reference.why) && r.alternatives.find((a) => a.chosen).reference === 'Noars et al. 2010');
}
{ // a reference whose star is from a catalogue: stellar values are 'other', a/R* is taken from a paper rather than mixed
  const r = chooseParameters(FIX, 'Fix-1 b', { reference: 'Rv et al. 2012', use: 'rv' }), v = r.values;
  check('stellar values from another source are flagged', v.mstar.kind === 'other' && v.mstar.source === 'TICv8' && v.logg.kind === 'derived' && Math.abs(v.logg.value - REF.logg) < 1e-5, v.mstar.note);
  check('a/R* comes from the best other reference, not a mixed derivation', v.ars.kind === 'other' && v.ars.source === 'Good et al. 2015');
  check('M sin i is labelled', /M sin i/.test(v.mplanet.note) && v.omega.value === 45 && v.ecc.value === 0.1);
  const kc = r.checks.find((c) => c.name === 'rv-amplitude');
  check('K against M sin i uses sin i = 1', kc && kc.status === 'ok' && rel(kc.computed, REF.Kmsini / Math.sqrt(1 - 0.01)) < 1e-4, kc && kc.detail);
}
{ // M* from log g and R* (the gap filling used in the owner's notebook), when no reference gives a mass
  const r = chooseParameters([row('Nomass 2019', '2019-01', { pl_orbper: 3, pl_tranmid: 2457000.5, pl_ratror: 0.1, st_rad: [1.2, 0.05], st_logg: [4.3, 0.05], st_teff: 6000 })], 'Fix-1 b');
  check('M* from log g and R*', r.values.mstar.kind === 'derived' && rel(r.values.mstar.value, REF.mFromLogg) < 2e-6 && r.values.ars.kind === 'derived' && r.values.inc.kind === 'default' && r.values.inc.value === 90 && r.values.feh.kind === 'default',
    `${r.values.mstar.value.toFixed(4)} ± ${r.values.mstar.err.toFixed(3)} vs ${REF.mFromLogg.toFixed(4)} Msun; then a/R* = ${r.values.ars.value.toFixed(3)} (${r.values.ars.note})`);
}
{ // single inconsistencies, one at a time
  const one = (name, change, extra) => { const r = chooseParameters([row('X 2020', '2020-01', { ...FULL, ...change }, { pl_bmassprov: 'Mass', ...extra })], 'Fix-1 b'); return r.checks.find((c) => c.name === name) || { status: 'missing', detail: '' }; };
  let c = one('geometry', { pl_orbincl: [80, 0.3], pl_imppar: undefined, pl_trandur: undefined });
  check('non-transiting geometry with tran_flag = 1 fails', c.status === 'fail' && /does not transit/.test(c.detail), c.detail);
  c = one('geometry', { pl_orbincl: [83.5, 0.1], pl_imppar: undefined, pl_trandur: undefined });
  check('grazing geometry warns', c.status === 'warn' && /grazing/.test(c.detail), c.detail);
  c = one('eccentricity', { pl_orbeccen: [1.2, 0.1] });
  check('e outside [0, 1) fails', c.status === 'fail', c.detail);
  c = one('periastron', { pl_orbeccen: [0.9, 0.01], pl_orblper: [90, 1] });
  check('periastron inside the star fails', c.status === 'fail', c.detail);
  c = one('logg', { st_logg: [4.0, 0.05] });
  check('log g 0.44 dex off fails', c.status === 'fail' && Math.abs(c.computed - REF.logg) < 1e-5, c.detail);
  c = one('depth', { pl_trandep: [3.0, 0.1] });
  check('depth three times (Rp/R*)^2 fails', c.status === 'fail', c.detail);
  c = one('depth', { pl_trandep: [1.2, 0.03] });
  check('depth 20% above (Rp/R*)^2 passes (limb darkening)', c.status === 'ok', c.detail);
  c = one('radius-ratio', { pl_radj: [1.5, 0.03] });
  check('Rp/R* against Rp and R* fails', c.status === 'fail' && rel(c.computed, 1.5 * REF.rprsJupSun) < 1e-6, c.detail);
  c = one('rv-amplitude', { pl_rvamp: [200, 3] });
  check('K against the mass fails', c.status === 'fail' && rel(c.computed, REF.K) < 5e-5, c.detail);
  c = one('impact', { pl_imppar: [0.8, 0.03] });
  check('impact parameter against a/R* and i fails', c.status === 'fail' && rel(c.computed, 8.7536 * Math.cos(87 * Math.PI / 180)) < 1e-9, c.detail);
  c = one('semi-major-axis', { pl_orbsmax: [0.05, 0.0005] });
  check('a against (a/R*) R* fails', c.status === 'fail' && rel(c.computed, REF.aAU) < 1e-4, c.detail);
  c = one('density-reported', { st_dens: [2.5, 0.1] });
  check('reported density against M*, R* fails', c.status === 'fail', c.detail);
  // large reported errors make a 10% offset acceptable; tiny ones do not make a 3% offset fail (floor)
  check('agreement is judged in sigma, with a floor', one('kepler', { pl_ratdor: [9.6, 0.5] }).status === 'ok' && one('kepler', { pl_ratdor: [9.0, 1e-4], st_mass: [1, 1e-4], st_rad: [1, 1e-4] }).status === 'ok' && one('kepler', { pl_ratdor: [9.9, 1e-4], st_mass: [1, 1e-4], st_rad: [1, 1e-4] }).status !== 'ok',
    one('kepler', { pl_ratdor: [9.0, 1e-4], st_mass: [1, 1e-4], st_rad: [1, 1e-4] }).detail);
  // an upper limit on e is not a value
  const lim = chooseParameters([row('L 2020', '2020-01', { ...FULL, pl_orbeccen: 0.3 }, { lim: { pl_orbeccen: true } })], 'Fix-1 b');
  check('an eccentricity limit is not used as a measurement', lim.values.ecc.value === 0 && lim.values.ecc.kind === 'default' && /e < 0.3/.test(lim.values.ecc.note), lim.values.ecc.note);
  check('runChecks lists nothing it cannot compute', runChecks({ per: { value: 3 } }).length === 0);
}
{ // priors
  const r = chooseParameters(FIX, 'Fix-1 b'), p = suggestPriors(r.values), v = r.values;
  check('every prior is valid in the app format and has a reason', Object.values(p).every((x) => validatePrior(x) === null && x.why.length > 5), Object.keys(p).join(', '));
  check('Rp/R*, i, T_mid, a/R* are uniform and contain the value', ['rprs', 'inc', 'tmid', 'ars'].every((k) => p[k].type === 'uniform' && p[k].a < v[k].value && p[k].b >= v[k].value));
  check('Rp/R* prior spans at least ±50%', p.rprs.a <= 0.05 + 1e-12 && p.rprs.b >= 0.15 - 1e-12, `[${p.rprs.a}, ${p.rprs.b}]`);
  const graze = Math.acos((1 + 0.1) / p.ars.a) * 180 / Math.PI;
  check('inclination prior reaches from the grazing limit to 90 deg', p.inc.b === 90 && Math.abs(p.inc.a - graze) < 1e-9 && p.inc.a < 87 - 5 * 0.3, `[${p.inc.a.toFixed(2)}, 90]; ${p.inc.why}`);
  check('T_mid prior at least half a duration wide each side', p.tmid.b - p.tmid.a >= v.t14.value - 1e-9, `± ${((p.tmid.b - p.tmid.a) / 2).toFixed(4)} d; ${p.tmid.why}`);
  const far = suggestPriors(r.values, { epochs: 20000 });
  check('... and wider when the period error is propagated', rel((far.tmid.b - far.tmid.a) / 2, 10 * Math.hypot(3e-4, 20000 * 1e-5)) < 1e-9, `± ${((far.tmid.b - far.tmid.a) / 2).toFixed(3)} d after 20000 orbits`);
  check('normal priors are never narrower than their floors', p.per.type === 'normal' && p.per.b >= 5e-5 - 1e-15 && p.teff.b >= 180 - 1e-9 && p.logg.b >= 0.15 && p.rstar.b >= 0.1 && p.mstar.b >= 0.15 - 1e-12, `per ${p.per.b}, Teff ${p.teff.b}, log g ${p.logg.b}, R* ${p.rstar.b}, M* ${p.mstar.b}`);
}
{ // a shared star for two planets
  const c2 = { ...FULL, pl_orbper: [8, 1e-4], pl_ratdor: [arsKepler(1, 1, 8), 0.3], pl_orbincl: [88.5, 0.2], pl_imppar: undefined, pl_trandur: undefined, pl_orbsmax: undefined, pl_rvamp: undefined, pl_bmassj: undefined };
  const rows = [...FIX, { ...row('Good et al. 2015', '2015-03', c2), pl_name: 'Fix-1 c' }, { ...row('Other et al. 2020', '2020-01', { ...c2, st_mass: [2, 0.05], st_rad: [1, 0.03], st_logg: undefined, st_dens: undefined }), pl_name: 'Fix-1 c' }];
  const s = systemFromRows(rows);
  check('system: one star for all planets, inner planet first', s.planets.length === 2 && s.planets[0].planet === 'Fix-1 b' && s.star.reference === 'Good et al. 2015' && s.planets.every((p) => p.values.mstar.value === 1 && p.values.mstar.source === 'Good et al. 2015' && p.priors.rprs), s.star.how);
  const forced = systemFromRows(rows, { stellarReference: 'Other et al. 2020', references: { 'Fix-1 c': 'Other et al. 2020' } });
  const kc = forced.planets[1].checks.find((c) => c.name === 'kepler');
  check('system: checks are redone against the shared star', forced.planets[0].values.mstar.value === 2 && forced.planets[0].values.mstar.kind === 'other' && kc.status === 'fail' && rel(kc.computed, arsKepler(2, 1, 8)) < 1e-9, kc.detail);
}

// --- the snapshot ----------------------------------------------------------------------------------------------
const dir = new URL('../public/catalog/', import.meta.url);
if (!existsSync(new URL('index.json', dir))) check('snapshot present (run tools/build_catalog.py)', false);
else {
  let fetched = 0, bytes = 0;
  const fetchJson = async (name) => { const b = readFileSync(new URL(name, dir)); fetched++; bytes += b.length; return JSON.parse(b); };
  const index = await loadIndex(fetchJson);
  const files = readdirSync(dir).filter((f) => /^shard-\d+\.json$/.test(f)), sizes = files.map((f) => statSync(new URL(f, dir)).size), idxSize = statSync(new URL('index.json', dir)).size;
  check('index is small and dated', idxSize < 1e6 && /^\d{4}-\d\d-\d\d$/.test(index.date) && index.rows > 30000 && files.length === index.nshards,
    `${(idxSize / 1024).toFixed(0)} kB, snapshot ${index.date}, ${index.rows} rows, ${index.nplanets} planets, ${index.nhosts} hosts, ${files.length} shards (${(sizes.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)} MB, largest ${(Math.max(...sizes) / 1024).toFixed(0)} kB)`);
  check('shards are 50-200 kB', Math.max(...sizes) < 200e3 && sizes.filter((s) => s < 50e3).length <= 1);
  const s = searchNames(index, 'hat-p-32', 5);
  check('autocomplete', s.length >= 2 && s[0].label === 'HAT-P-32' && s.some((x) => x.label === 'HAT-P-32 b' && x.transit) && searchNames(index, 'trappist1', 20).length === 8 && searchNames(index, '', 5).length === 0, s.map((x) => x.label).join(', '));
  check('names resolve whatever the spelling', resolveName(index, 'hatp32b').planet === 'HAT-P-32 b' && resolveName(index, 'WASP 12B').planet === 'WASP-12 b' && resolveName(index, 'trappist-1').planet === null && resolveName(index, 'HIP 108859 b').planet === 'HD 209458 b' && resolveName(index, 'no such star') === null &&
    resolveName(index, '55 Cnc B').host === '55 Cnc B' && resolveName(index, '55 Cnc b').host === '55 Cnc' && resolveName(index, '55cncb').planet === '55 Cnc b', 'exact spelling first: 55 Cnc B is a star, 55 Cnc b a planet');
  bytes = 0; fetched = 0;
  const hd = await lookupHost(index, 'hd80606b', fetchJson);
  await lookupHost(index, 'HD 80606', fetchJson);
  check('one lookup fetches one shard, then it is cached', fetched === 1 && bytes < 200e3 && hd.planet === 'HD 80606 b' && hd.rows.length >= 5 && hd.rows.every((r) => r.hostname === 'HD 80606' && r.pl_ref && !/[<>]/.test(r.pl_ref)) && hd.system.ra > 140 && hd.system.ra < 141, `${(bytes / 1024).toFixed(0)} kB, ${hd.rows.length} rows, refs: ${[...new Set(hd.rows.map((r) => r.pl_ref))].join('; ')}`);
  check('reference links are ADS URLs', hd.rows.filter((r) => /^https:\/\/ui\.adsabs\.harvard\.edu\/abs\//.test(r.pl_refurl)).length >= hd.rows.length - 1);
  check('every indexed planet is in its shard', await (async () => { for (const n of ['Kepler-11 g', '55 Cnc e', 'TOI-1873 b', 'Proxima Cen b', 'KELT-9 b', 'bet Pic b']) { const r = await lookupHost(index, n, fetchJson); if (!r || !r.rows.some((x) => x.pl_name === n)) return false; } return true; })());

  const show = (r) => {
    console.log(`info ${r.planet} [${r.use}]: ${r.reference.label} (${r.reference.pubdate}${r.reference.isDefault ? ', archive default' : ''}); ${r.reference.why}`);
    console.log('     ' + ['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'omega', 'b', 't14', 'K', 'mplanet', 'rstar', 'mstar'].filter((k) => r.values[k]).map((k) => `${k}=${+r.values[k].value.toPrecision(k === 'tmid' ? 12 : k === 'per' ? 9 : 5)}${r.values[k].kind === 'reference' ? '' : '[' + r.values[k].kind + (r.values[k].kind === 'other' ? ':' + r.values[k].source : '') + ']'}`).join(' '));
    const bad = r.checks.filter((c) => c.status !== 'ok');
    console.log(`     checks: ${r.checks.filter((c) => c.status === 'ok').length} ok` + bad.map((c) => `\n       ${c.status.toUpperCase()} ${c.name}: ${c.detail}`).join(''));
    const flagged = r.alternatives.filter((a) => a.failed.length);
    if (flagged.length) console.log('     references with failed checks: ' + flagged.map((a) => `${a.reference} (${a.failed.join(', ')})`).join('; '));
  };

  { // HD 80606 b against Table 7 of Pearson et al. 2022 (the values used in physics.test.mjs)
    const T7 = { per: 111.436765, tmid: 2458888.07466, rprs: Math.sqrt(0.01019), ars: 94.452, inc: 89.24, ecc: 0.93183, omega: -58.887, K: 469.22, mplanet: 4.1641, t14: 0.4990 };
    const r = chooseParameters(hd.rows, 'HD 80606 b', { use: 'transit' }), v = r.values;
    show(r);
    const wrap = (x) => ((x % 360) + 540) % 360 - 180;
    const d = { per: Math.abs(v.per.value - T7.per), ars: rel(v.ars.value, T7.ars), inc: Math.abs(v.inc.value - T7.inc), ecc: Math.abs(v.ecc.value - T7.ecc), omega: Math.abs(wrap(v.omega.value - T7.omega)), rprs: rel(v.rprs.value, T7.rprs), K: rel(v.K.value, T7.K), t14: rel(v.t14.value, T7.t14) };
    check('HD 80606 b: chosen set agrees with Pearson et al. 2022 Table 7', d.per < 2e-3 && d.ars < 0.03 && d.inc < 0.15 && d.ecc < 0.005 && d.omega < 1.5 && d.rprs < 0.03 && d.K < 0.02 && d.t14 < 0.03,
      `dP ${d.per.toExponential(1)} d, a/R* ${(100 * d.ars).toFixed(2)}%, i ${d.inc.toFixed(3)} deg, e ${d.ecc.toExponential(1)}, omega ${d.omega.toFixed(2)} deg, Rp/R* ${(100 * d.rprs).toFixed(2)}%, K ${(100 * d.K).toFixed(2)}%, T14 ${(100 * d.t14).toFixed(2)}%`);
    check('HD 80606 b: the chosen reference is Pearson et al. 2022 and it is self-consistent', r.reference.label === 'Pearson et al. 2022' && r.checks.every((c) => c.status !== 'fail'), r.alternatives.map((a) => `${a.reference} ${a.score.toFixed(1)}`).join(' | '));
    const kep = r.checks.find((c) => c.name === 'kepler');
    check('HD 80606 b: a/R* against Kepler matches the astropy value', kep && rel(kep.computed, withPlanet(REF.hdArs, 4.1641, 1.05)) < 2e-6, kep && kep.detail);
    show(chooseParameters(hd.rows, 'HD 80606 b', { use: 'rv' }));
  }
  for (const [name, use] of [['HAT-P-32 b', 'transit'], ['WASP-12 b', 'transit'], ['WASP-12 b', 'ephemeris']]) {
    const h = await lookupHost(index, name, fetchJson), r = chooseParameters(h.rows, name, { use });
    show(r);
    check(`${name} [${use}]: complete and usable`, ['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'omega', 'teff', 'logg', 'rstar', 'mstar'].every((k) => r.values[k] && Number.isFinite(r.values[k].value)) && !r.checks.some((c) => c.status === 'fail') &&
      Object.values(suggestPriors(r.values)).every((p) => validatePrior(p) === null), `${r.alternatives.length} references, ${r.alternatives.filter((a) => a.failed.length).length} with failed checks`);
  }
  for (const host of ['TOI-1873', 'TRAPPIST-1', '55 Cnc']) {
    const h = await lookupHost(index, host, fetchJson), s = systemFromRows(h.rows, { use: host === '55 Cnc' ? 'all' : 'transit' });
    console.log(`info ${host}: ${s.star.how}`);
    console.log('     star: ' + Object.entries(s.star.values).map(([k, v]) => `${k}=${v.value}`).join(' '));
    s.planets.forEach(show);
    check(`${host}: every planet assembled around one star`, s.planets.length === h.planets.length && s.planets.every((p) => p.values.per && p.values.rstar.value === s.star.values.rstar.value && p.values.rstar.source === s.star.reference) && s.planets.every((p, i) => i === 0 || p.values.per.value >= s.planets[i - 1].values.per.value),
      `${s.planets.length} planets, P = ${s.planets.map((p) => +p.values.per.value.toPrecision(4)).join(', ')} d`);
  }

  { // how often do archive references fail their own Kepler check? (informational; over a sample of shards)
    let nRef = 0, nKep = 0, nFail = 0, nGeom = 0, worst = [];
    for (let id = 0; id < index.nshards; id += 6) {
      const first = index.hosts.find((h) => h.shard === id);
      await lookupHost(index, first.name, fetchJson);
      for (const h of index.hosts.filter((x) => x.shard === id)) {
        const hr = await lookupHost(index, h.name, fetchJson);
        for (const pl of hr.planets) {
          const r = chooseParameters(hr.rows, pl);
          for (const a of r.alternatives) {
            nRef++;
            const k = a.checks.find((c) => c.name === 'kepler');
            if (k) { nKep++; if (k.status === 'fail') { nFail++; worst.push([k.nsigma, `${pl} / ${a.reference}: ${k.detail}`]); } }
            if (a.failed.includes('geometry')) nGeom++;
          }
        }
      }
    }
    worst.sort((a, b) => b[0] - a[0]);
    console.log(`info sample of ${Math.ceil(index.nshards / 6)} shards: ${nRef} planet references, ${nKep} with a/R*, M*, R*, P; ${nFail} (${(100 * nFail / nKep).toFixed(1)}%) fail Kepler's third law at > 5 sigma; ${nGeom} listed as transiting with b > 1 + Rp/R*`);
    worst.slice(0, 4).forEach((w) => console.log('     ' + w[1]));
    check('selection runs on every planet of the sample', nRef > 1000);
  }
}

console.log(ok ? '\ncatalog tests passed' : '\ncatalog tests FAILED');
process.exit(ok ? 0 : 1);
