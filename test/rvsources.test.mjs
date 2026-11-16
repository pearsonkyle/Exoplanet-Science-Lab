// Radial velocities from archives (src/core/rvsources.js): query building, the parsers against saved VizieR responses
// (test/data/rv/, fetched 2026-11-16), the search driver with a fake fetch, and two systems end to end: the archive's
// velocities fitted here, K compared with the value published from the same data.
//   51 Peg b, HIRES (Butler et al. 2017 table): Butler et al. (2017) Table 2 give K = 56.05 ± 0.60 m/s from these 43 velocities.
//   HD 80606 b, HIRES (Tal-Or et al. 2019): published K from other data sets 465.5-476.1 m/s (NASA Exoplanet Archive
//   rows); this repository's stored fit of the EXOTIC compilation (public/examples/results/hd80606-rv.json) 469.6 ± 0.4.
import { readFileSync } from 'node:fs';
import { RV_SOURCES, sourceById, listQuery, dataQuery, parseASU, parseStarList, parseRVTable, findRadialVelocities, provenanceOf, VIZIER_MIRRORS } from '../src/core/rvsources.js';
import { runSession, FORMAT, FORMAT_VERSION } from '../src/core/session.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const fx = (f) => readFileSync(new URL('./data/rv/' + f, import.meta.url), 'utf8');
const talor = sourceById('hires-talor2019'), butler = sourceById('hires-butler2017'), bank = sourceById('harps-rvbank'), lick = sourceById('lick-fischer2014');

// ---- queries
{
  const u = listQuery(talor, 344.36754, 20.769096, { base: VIZIER_MIRRORS[0] });
  check('star-list query', u === 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J%2FMNRAS%2F484%2FL8%2Fstars&-c=344.367540%20%2B20.769096&-c.rs=10&-out=Name&-out.add=_r&-sort=_r', u);
  const d = dataQuery(bank, 'GJ882');
  check('data query (HARPS RVBank, with its flag column)', d.includes('-source=J%2FA%2BA%2F636%2FA74%2Frvbank') && d.includes('Name=GJ882') && d.includes('-out=Name%2CBJD%2CDRVmlcnzp%2Ce_DRVmlcnzp%2CFlag') && d.endsWith('-out.max=unlimited'), d);
  let threw = false; try { listQuery(talor, NaN, 1); } catch { threw = true; } check('a search without coordinates is refused', threw);
}

// ---- parsers
{
  check('server fault is an error, not an empty answer', parseASU(fx('server_error.tsv')).status === 'error');
  check('valid answer with no rows is empty', parseASU(fx('hd80606_lick_list_norows.tsv')).status === 'empty' && parseASU(fx('empty_result.tsv')).status === 'empty');
  check('an HTML page is an error', parseASU('<!doctype html><html>Page unavailable</html>').status === 'error');
  let threw = false; try { parseStarList(fx('server_error.tsv'), talor); } catch { threw = true; } check('star list throws on a server fault (the driver then tries another mirror)', threw);
  const sl = parseStarList(fx('51peg_rvbank_list.tsv'), bank);
  check('star list by position: 51 Peg is GJ 882 in the RVBank', sl.length === 1 && sl[0].name === 'GJ882' && Math.abs(sl[0].sep - 3.356) < 1e-9, JSON.stringify(sl));
  const sl2 = parseStarList(fx('51peg_lick_list.tsv'), lick);
  check('star list: Lick names stars by HD number', sl2[0].name === '217014', JSON.stringify(sl2));

  const a = parseRVTable(fx('51peg_talor_data.tsv'), talor, 'HD217014'), a2 = parseRVTable(fx('51peg_butler_data.tsv'), butler, 'HD217014');
  check('51 Peg, HIRES: one set after the CCD upgrade; 43 velocities in Butler 2017, 46 in Tal-Or 2019', a.sets.length === 1 && a.sets[0].name === 'HIRES post-2004' && a.sets[0].n === 46 && a2.sets.length === 1 && a2.sets[0].n === 43, `${a.sets.map((s) => s.name + ' ' + s.n).join(', ')}; ${a2.sets[0].n}`);
  check('51 Peg, HIRES: first row as in the files (Tal-Or corrects the velocity)', Math.abs(a.sets[0].t[0] - 2453927.05042) < 1e-9 && a.sets[0].v[0] === 39.999 && a.sets[0].e[0] === 0.998 && a2.sets[0].v[0] === 40.54 && a2.sets[0].e[0] === 0.97, `t0 ${a.sets[0].t[0]} v0 ${a.sets[0].v[0]} / ${a2.sets[0].v[0]}`);
  const b = parseRVTable(fx('hd80606_talor_data.tsv'), talor, 'HD80606');
  check('HD 80606, HIRES: split at the 2004 CCD upgrade', b.sets.length === 2 && b.sets[0].name === 'HIRES pre-2004' && b.sets[0].t1 < 2453225 && b.sets[1].t0 > 2453225, b.sets.map((s) => `${s.name} ${s.n} pts ${s.span.toFixed(0)} d`).join(', '));
  const nb = b.sets.reduce((x, s) => x + s.n, 0), bb = parseRVTable(fx('hd80606_butler_data.tsv'), butler, 'HD80606');
  check('HD 80606: Butler 2017 and Tal-Or 2019 hold the same 97 epochs', nb === 97 && bb.sets.reduce((x, s) => x + s.n, 0) === 97 && bb.sets[1].t.every((t, i) => t === b.sets[1].t[i]), `${nb} and ${bb.sets.reduce((x, s) => x + s.n, 0)}`);
  const c = parseRVTable(fx('51peg_rvbank_data.tsv'), bank, 'GJ882');
  const nc = c.sets.reduce((x, s) => x + s.n, 0);
  check('51 Peg, HARPS RVBank: NZP-corrected velocities, flagged points out', c.sets.length >= 1 && nc === 87 && c.dropped.flagged === 4 && c.sets.every((s) => s.medErr > 0.3 && s.medErr < 3), `${c.sets.map((s) => s.name + ' ' + s.n).join(', ')}; dropped ${JSON.stringify(c.dropped)}`);
  const d = parseRVTable(fx('51peg_lick_data.tsv'), lick, '217014');
  check('51 Peg, Lick: one set per dewar, times + 2400000', d.sets.map((s) => s.name).sort().join() === 'Lick dewar 13,Lick dewar 6,Lick dewar 8' && d.sets.reduce((x, s) => x + s.n, 0) === 354 && d.sets.every((s) => s.t0 > 2.44e6 && s.t1 < 2.46e6), `${d.sets.map((s) => s.name + ' ' + s.n).join(', ')}; missing ${d.dropped.missing}`);
  const pv = provenanceOf(talor, a.sets[0], { star: 'HD217014', url: 'u', retrieved: '2026-11-16' });
  check('provenance carries the reference and bibcode', pv.bibcode === '2019MNRAS.484L...8T' && pv.doi === '10.1093/mnrasl/sly227' && pv.n === 46 && pv.time_standard.startsWith('BJD'));
}

// ---- the search driver with saved responses; the first mirror always fails
{
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (url.startsWith(VIZIER_MIRRORS[0])) return fx('server_error.tsv');
    const src = RV_SOURCES.find((s) => url.includes(encodeURIComponent(s.list)) || url.includes(encodeURIComponent(s.data)));
    const key = { 'hires-talor2019': 'talor', 'hires-butler2017': 'butler', 'harps-rvbank': 'rvbank', 'lick-fischer2014': 'lick' }[src.id];
    return fx(`51peg_${key}_${url.includes(encodeURIComponent(src.list)) ? 'list' : 'data'}.tsv`);
  };
  const out = await findRadialVelocities({ ra: 344.36754, dec: 20.769096, fetchText, now: () => '2026-11-16T00:00:00Z' });
  const by = Object.fromEntries(out.map((r) => [r.source.id, r]));
  check('search: every source found 51 Peg via the second mirror', out.every((r) => r.status === 'found' && r.mirror === VIZIER_MIRRORS[1]), out.map((r) => `${r.source.id} ${r.status} ${r.sets.map((s) => s.n).join('+')}`).join('; '));
  check('search: sets carry provenance', by['lick-fischer2014'].sets[0].provenance.retrieved === '2026-11-16T00:00:00Z' && by['harps-rvbank'].star === 'GJ882');
  const none = await findRadialVelocities({ ra: 140.6566, dec: 50.6036, fetchText: async () => fx('empty_result.tsv'), sources: [bank] });
  check('search: no star at the position (on two mirrors) is "none"', none[0].status === 'none');
  const flaky = await findRadialVelocities({ ra: 344.36754, dec: 20.769096, sources: [bank], fetchText: async (u) => (u.startsWith(VIZIER_MIRRORS[0]) ? fx('empty_result.tsv') : u.includes('rvbank') ? fx('51peg_rvbank_data.tsv') : fx('51peg_rvbank_list.tsv')) });
  check('search: an empty answer from one mirror is checked on the next', flaky[0].status === 'found' && flaky[0].mirror === VIZIER_MIRRORS[1], `${flaky[0].status} via ${flaky[0].mirror}`);
  const bad = await findRadialVelocities({ ra: 1, dec: 1, fetchText: async () => { throw new Error('Failed to fetch'); }, sources: [bank] });
  check('search: a cross-origin refusal on every mirror is "error", said as such', bad[0].status === 'error' && /cannot be reached from a browser/.test(bad[0].message), bad[0].message);
  const one = await findRadialVelocities({ ra: 1, dec: 1, sources: [bank], fetchText: async (u) => { if (u.startsWith(VIZIER_MIRRORS[0])) return fx('empty_result.tsv'); throw new TypeError('Failed to fetch'); } });
  check('search: "none" from one mirror while the others are unreachable says so', one[0].status === 'none' && /one mirror answered/.test(one[0].message), one[0].message);
}

// ---- end to end: fit the archive's velocities and compare K
const session = (name, star, planet, sets, free, extraPriors = {}) => ({
  format: FORMAT, version: FORMAT_VERSION, name, star, planets: [{ letter: 'b', parameters: planet }], kepler: true, time_reference: 0,
  limb_darkening: { law: 'quadratic', coefficients: [0.4, 0.25] },
  data: { light_curve: null, radial_velocity: sets.map((s) => ({ name: s.name, time: Array.from(s.t), velocity: Array.from(s.v), velocity_err: Array.from(s.e) })), timing: [] },
  fit: { use: { lc: false, rv: true, timing: false }, free, fixed: { rvlin: 0, rvquad: 0, ...Object.fromEntries(sets.map((_, k) => [`jit@rv${k + 1}`, 0])) }, priors: extraPriors, sampler: { nlive: 300, fracRemain: 0.01, seed: 11, maxCalls: 4e5 } },
});
const U = (a, b) => ({ type: 'uniform', a, b });
{
  const sets = parseRVTable(fx('51peg_butler_data.tsv'), butler, 'HD217014').sets, t0 = sets[0].t[0];
  const s = session('51 Peg', { teff: 5768, mstar: 1.09, rstar: 1.15, feh: 0.2 }, { rprs: 0.1, ars: 9, inc: 90, per: 4.2307969, tmid: t0, ecc: 0, omega: 90, mplanet: 0.46 }, sets,
    [{ key: 'per', prior: U(4.2306, 4.2310) }, { key: 'tmid', prior: U(t0 - 2.2, t0 + 2.2) }, { key: 'mplanet', prior: U(0.2, 0.8) }, { key: 'jit@rv1', prior: U(0, 15) }]);
  const t = Date.now(), r = (await runSession(s)).session.result, K = r.derived.K;
  const z = (K.median - 56.05) / Math.hypot(0.5 * (K.plus + K.minus), 0.60);
  check('51 Peg b from the archive’s HIRES velocities (Butler 2017 table): K against Butler et al. 2017 (same 43 velocities)', r.converged && Math.abs(z) < 2,
    `K = ${K.median.toFixed(2)} +${K.plus.toFixed(2)} −${K.minus.toFixed(2)} m/s against 56.05 ± 0.60 (${z.toFixed(2)}σ); P = ${r.parameters[0].median.toFixed(6)} d; ${r.ncalls} calls, ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
{
  const sets = parseRVTable(fx('hd80606_talor_data.tsv'), talor, 'HD80606').sets;
  const s = session('HD 80606', { teff: 5565, mstar: 1.05, rstar: 1.066, feh: 0.35 }, { rprs: 0.1, ars: 94.45, inc: 89.269, per: 111.4367, tmid: 2458888.0757, ecc: 0.9316, omega: -58.8, mplanet: 4.19 }, sets,
    [{ key: 'per', prior: U(111.40, 111.47) }, { key: 'tmid', prior: U(2458887.0757, 2458889.0757) }, { key: 'ecc', prior: U(0.90, 0.96) }, { key: 'omega', prior: U(-70, -50) }, { key: 'mplanet', prior: U(3, 5.5) }, { key: 'jit@rv1', prior: U(0, 40) }, { key: 'jit@rv2', prior: U(0, 40) }]);
  const t = Date.now(), r = (await runSession(s)).session.result, K = r.derived.K, sk = 0.5 * (K.plus + K.minus);
  const z = (K.median - 469.62) / Math.hypot(sk, 0.39);
  const ecc = r.parameters.find((p) => p.key === 'ecc');
  check('HD 80606 b from the archive’s HIRES velocities (two eras): K against the compilation fit and the published range', r.converged && Math.abs(z) < 3 && K.median > 462 && K.median < 480,
    `K = ${K.median.toFixed(1)} ± ${sk.toFixed(1)} m/s; compilation fit 469.6 ± 0.4 (${z.toFixed(2)}σ); published 465.5-476.1; e = ${ecc.median.toFixed(4)} ± ${(0.5 * (ecc.plus + ecc.minus)).toFixed(4)}; ${sets.map((x) => x.name + ' ' + x.n).join(', ')}; ${r.ncalls} calls, ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
process.exit(ok ? 0 : 1);
