// The worked examples added for real EXOTIC data and the timing chain: TOI-1873 (TESS + NEID) and its O − C, Kepler-88
// (a hidden planet weighed by transit timing, Holczer et al. 2016 times), a simulated near-resonant pair weighed by timing alone, and the Rossiter–McLaughlin effect
// of HD 80606 b. For each stored result (public/examples/results/<id>.json, made in the browser by
// tools/build_example_results.py):
//   1. the session as stored, re-read, gives the stored chi-square at the stored best point (the likelihood is the same);
//   2. the sampler run again on the stored session reproduces the stored medians (always, except toi1873, about 2 hours,
//      and kepler88, about 40 minutes: those with ESL_FULL=1);
//   3. the numbers are compared with their independent references: the published pyaneti fit of TOI-1873
//      (EXOTIC/examples/toi-3planet/2p_circ_prod_params.dat, values typed below), EXOTIC's own per-transit ephemerides and
//      O − C periodogram (toi1873_transit_fits.json), the injected masses (public/examples/ttvpair/truth.json), and
//      Hébrard et al. 2010 for HD 80606 b (λ = 42 ± 8°, v sin i★ about 1.7 km/s taken as ± 0.3, as in test/hd80606rm.test.mjs).
//   node test/examples_real.test.mjs          ESL_FULL=1 node test/examples_real.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { buildProblem } from '../src/core/model.js';
import { specFromSession, runSession } from '../src/core/session.js';
import { timingPeriodogram } from '../src/core/periodogram.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const P = (p) => new URL('../public/examples/' + p, import.meta.url);
const stored = (id) => JSON.parse(readFileSync(P(`results/${id}.json`), 'utf8'));
const par = (r) => Object.fromEntries(r.parameters.map((p) => [p.key, p]));
const sig = (p) => 0.5 * (p.plus + p.minus);
/** The best point of a stored result, times relative to the session's reference (as the likelihood takes them). */
const bestOf = (doc) => Object.fromEntries(doc.result.parameters.map((p) => [p.key, p.key.split('@')[0] === 'tmid' ? p.best - (doc.time_reference || 0) : p.best]));
const FULL = !!process.env.ESL_FULL, MJ = 317.828;   // Earth masses per Jupiter mass (IAU)

/** 1 and 2: likelihood at the stored best point, and (when asked) a new run against the stored medians. */
async function reproduce(id, rerun) {
  const doc = stored(id), r = doc.result, fresh = { ...doc, result: null };
  const spec = specFromSession(fresh), prob = buildProblem(spec);
  const best = bestOf(doc), th = spec.free.map((f) => best[f.key]);
  const det = prob.detail(th);
  check(`${id}: the stored session gives the stored chi2 at its best point`, det && Math.abs(det.chi2 - r.chi2) < 1e-6 * Math.max(1, r.chi2), `${det && det.chi2.toFixed(4)} vs ${r.chi2.toFixed(4)} for ${r.n_data} measurements; ${r.ncalls} calls, converged ${r.converged}`);
  if (!rerun) { console.log(`     (${id}: sampler not rerun; ESL_FULL=1 reruns it)`); return r; }
  const t0 = Date.now(), out = await runSession(fresh, { keepSamples: true }), q = out.session.result, a = par(r), b = par(q);
  const worst = Math.max(...Object.keys(a).map((k) => Math.abs(a[k].median - b[k].median) / sig(a[k])));
  check(`${id}: a new run reproduces the stored medians`, q.converged && worst < 0.1, `largest shift ${worst.toFixed(4)}σ; ${q.ncalls} calls (stored ${r.ncalls}), lnZ ${q.logZ.toFixed(2)} (stored ${r.logZ.toFixed(2)}), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return r;
}

// ---- TOI-1873: O − C and periodogram of the real mid-times
{
  const r = await reproduce('toi1873-oc', true), m = par(r);
  // EXOTIC's per-transit linear ephemerides (toi1873_transit_fits.json, planets.<p>.ephemeris) and pyaneti
  const ex = { per: [7.005754496, 1.82e-5], 'per@c': [24.933973836, 5.28e-5] }, py = { per: [7.0057048, 2.4e-5], 'per@c': [24.9339464, 5.5e-5] };
  for (const k of ['per', 'per@c']) {
    const dEx = (m[k].median - ex[k][0]) / sig(m[k]), dPy = (m[k].median - py[k][0]) / Math.hypot(sig(m[k]), py[k][1]);
    check(`toi1873-oc: ${k} agrees with EXOTIC's weighted least squares on the same times`, Math.abs(dEx) < 0.2, `${m[k].median.toFixed(7)} ± ${sig(m[k]).toExponential(2)} d vs ${ex[k][0]} (${dEx.toFixed(2)}σ); pyaneti ${py[k][0]} (${dPy.toFixed(2)}σ, from the light curves directly)`);
  }
  const rows = readFileSync(P('toi1873/transit_times.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  for (const [p, per] of [['b', m.per.median], ['c', m['per@c'].median]]) {
    const x = rows.filter((y) => y[0] === p), t = x.map((y) => +y[1]), e = x.map((y) => +y[2]), E = t.map((y) => Math.round((y - t[0]) / per));
    const pg = timingPeriodogram(E, t, e), g = pg.periodograms[0], pk = g.peaks[0];
    check(`toi1873-oc: no significant periodicity in the O − C of ${p}`, !pg.significant && pk.fap > 0.01, `${x.length} times, χ² ${pg.linear.chi2.toFixed(1)} for ${pg.linear.dof}; strongest peak ${pk.period.toFixed(2)} epochs (${pk.periodDays.toFixed(1)} d), power ${pk.power.toFixed(3)}, FAP ${pk.fap.toFixed(2)} (1% level at ${g.fapLevels[1].power.toFixed(3)}). EXOTIC: ${p === 'b' ? '3.25 epochs, power 0.31, 99% level 0.45 (one time clipped)' : '12.47 epochs, power 0.80, 99% level 0.98'}`);
  }
}

// ---- Kepler-88 (KOI-142): the non-transiting planet c weighed by b's transit timing (Holczer et al. 2016 times)
{
  const r = await reproduce('kepler88', FULL), m = par(r);
  // published (NASA Exoplanet Archive snapshot in public/catalog, rows of Nesvorný et al. 2013 and Weiss et al. 2020)
  const pub = { 'Nesvorný et al. 2013': { m: [0.626, 0.033, 0.029], P: [22.3395, 0.0017, 0.0019], eb: 0.05593, ec: 0.05628 }, 'Weiss et al. 2020': { m: [0.674, 0.016, 0.016], P: [22.26492, 0.00067, 0.00067], eb: 0.05561, ec: 0.05724 } };
  // eccentricities from the draws of sqrt(e) cos(omega), sqrt(e) sin(omega)
  const S = r.samples, col = (k) => S.values.map((x) => x[S.keys.indexOf(k)]), q = (a) => { const x = [...a].sort((u, v) => u - v), at = (f) => x[Math.floor(f * (x.length - 1))]; return { median: at(0.5), plus: at(0.8413) - at(0.5), minus: at(0.5) - at(0.1587) }; };
  const eOf = (sx) => { const h = col('secosw' + sx), k = col('sesinw' + sx); return q(h.map((x, i) => x * x + k[i] * k[i])); };
  const eb = eOf(''), ec = eOf('@c');
  for (const [ref, p] of Object.entries(pub)) {
    const dm = (m['mplanet@c'].median - p.m[0]) / Math.hypot(sig(m['mplanet@c']), 0.5 * (p.m[1] + p.m[2]));
    const dP = (m['per@c'].median - p.P[0]) / Math.hypot(sig(m['per@c']), 0.5 * (p.P[1] + p.P[2]));
    console.log(`     against ${ref}: Mp c ${m['mplanet@c'].median.toFixed(3)} ± ${sig(m['mplanet@c']).toFixed(3)} vs ${p.m[0]} (${dm.toFixed(2)}σ); P c ${m['per@c'].median.toFixed(4)} ± ${sig(m['per@c']).toFixed(4)} vs ${p.P[0]} (${dP.toFixed(2)}σ); e b ${eb.median.toFixed(4)} vs ${p.eb}, e c ${ec.median.toFixed(4)} vs ${p.ec}`);
  }
  const dmN = (m['mplanet@c'].median - 0.626) / Math.hypot(sig(m['mplanet@c']), 0.031), dmW = (m['mplanet@c'].median - 0.674) / Math.hypot(sig(m['mplanet@c']), 0.016);
  check('kepler88: the hidden planet\'s mass agrees with Nesvorný et al. 2013 and Weiss et al. 2020 within 2σ', Math.abs(dmN) < 2 && Math.abs(dmW) < 2, `${m['mplanet@c'].median.toFixed(3)} +${m['mplanet@c'].plus.toFixed(3)} −${m['mplanet@c'].minus.toFixed(3)} M Jup: ${dmN.toFixed(2)}σ and ${dmW.toFixed(2)}σ; χ² ${r.chi2.toFixed(1)} for ${r.n_data} times with ${(doc88().fit.timing_noise * 1440).toFixed(2)} min of timing noise`);
  check('kepler88: both eccentricities near the published 0.056 and 0.057', Math.abs(eb.median - 0.0559) < 0.01 && Math.abs(ec.median - 0.0572) < 0.01, `e b ${eb.median.toFixed(4)} ± ${sig(eb).toFixed(4)}, e c ${ec.median.toFixed(4)} ± ${sig(ec).toFixed(4)}`);
}
function doc88() { return stored('kepler88'); }

// ---- simulated pair near 2:1: masses from timing alone
{
  const r = await reproduce('ttvpair', true), m = par(r), truth = JSON.parse(readFileSync(P('ttvpair/truth.json'), 'utf8'));
  const inj = { mplanet: truth.planets[0].mplanet, 'mplanet@c': truth.planets[1].mplanet };
  check('ttvpair: both injected masses recovered from the times alone', Object.keys(inj).every((k) => Math.abs(m[k].median - inj[k]) < 3 * sig(m[k])),
    Object.keys(inj).map((k) => `${k} ${m[k].median.toFixed(4)} ± ${sig(m[k]).toFixed(4)} (injected ${inj[k]}, ${((m[k].median - inj[k]) / sig(m[k])).toFixed(2)}σ)`).join('; ') + `; χ² ${r.chi2.toFixed(1)} for ${r.n_data} times`);
}

// ---- HD 80606 b: the Rossiter–McLaughlin effect in the HIRES velocities of 2009 June 5
{
  const r = await reproduce('hd80606-rm', true), m = par(r), lam = m.lambda, vs = m.vsini;
  const d = (lam.median - 42) / Math.hypot(sig(lam), 8);
  const dv = (vs.median - 1.7) / Math.hypot(sig(vs), 0.3);
  check('hd80606-rm: λ agrees with Hébrard et al. 2010 (42 ± 8°) and v sin i★ with 1.7 ± 0.3 km/s', Math.abs(d) < 2 && Math.abs(dv) < 2, `λ = ${lam.median.toFixed(1)} +${lam.plus.toFixed(1)} −${lam.minus.toFixed(1)}° (${d.toFixed(2)}σ combined); v sin i★ = ${vs.median.toFixed(2)} +${vs.plus.toFixed(2)} −${vs.minus.toFixed(2)} km/s (${dv.toFixed(2)}σ); test/hd80606rm.test.mjs (orbit fixed) gives 1.47 km/s and 58°`);
  // the anomaly is detected: the same best orbit without it fits the eight in-transit velocities far worse
  const doc = stored('hd80606-rm'), spec = specFromSession({ ...doc, result: null });
  const vals = { ...spec.values, ...bestOf(doc) };
  const chiRV = (vsini) => buildProblem({ ...spec, values: { ...vals, vsini }, free: [] }).detail([]).chi2rv;
  const c1 = chiRV(vals.vsini), c0 = chiRV(0);
  check('hd80606-rm: removing the anomaly from the best fit raises the velocity χ² by more than 25 (the two transit nights)', c0 - c1 > 25 && vs.median > 3 * vs.minus, `χ²(velocities) ${c1.toFixed(1)} with, ${c0.toFixed(1)} without (Δ ${(c0 - c1).toFixed(1)}); v sin i★ ${(vs.median / vs.minus).toFixed(1)}σ above zero`);
}

// ---- TOI-1873: TESS + NEID against the published two-planet pyaneti fit (2p_circ_prod_params.dat)
if (existsSync(P('results/toi1873.json'))) {
  const r = await reproduce('toi1873', FULL), m = par(r);
  const pub = {   // median, minus, plus as printed in 2p_circ_prod_params.dat; masses in M Jup from M_earth / 317.828
    per: [7.0057048, 2.08e-5, 2.65e-5], tmid: [2459583.7146029, 0.0016299, 0.0015434], rprs: [0.0268254, 7.323e-4, 7.399e-4], inc: [88.9098679, 0.42842, 0.45398], mplanet: [9.071724 / MJ, 2.368 / MJ, 2.405 / MJ],
    'per@c': [24.9339464, 5.51e-5, 5.48e-5], 'tmid@c': [2459753.6774537, 0.0013899, 0.0013977], 'rprs@c': [0.0397857, 8.216e-4, 8.545e-4], 'inc@c': [89.7156222, 0.23769, 0.18535], 'mplanet@c': [27.6893594 / MJ, 5.022 / MJ, 4.988 / MJ],
  };
  const rows = Object.entries(pub).map(([k, [v, lo, hi]]) => ({ k, d: (m[k].median - v) / Math.hypot(sig(m[k]), 0.5 * (lo + hi)), txt: `${k} ${m[k].median.toPrecision(k.startsWith('tmid') ? 12 : 6)} ± ${sig(m[k]).toPrecision(2)} vs ${v.toPrecision(k.startsWith('tmid') ? 12 : 6)}` }));
  for (const x of rows) console.log(`     ${x.txt}  (${x.d.toFixed(2)}σ)`);
  const geo = rows.filter((x) => !x.k.startsWith('mplanet')), mass = rows.filter((x) => x.k.startsWith('mplanet'));
  check('toi1873: ephemerides, radii and inclinations of b and c agree with the published fit within 2.5σ', geo.every((x) => Math.abs(x.d) < 2.5), 'worst ' + geo.reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a)).k + ` ${Math.max(...geo.map((x) => Math.abs(x.d))).toFixed(2)}σ`);
  check('toi1873: masses of b and c agree with the published fit within 2σ (white jitter here, a Gaussian process there)', mass.every((x) => Math.abs(x.d) < 2), mass.map((x) => `${x.k} ${(m[x.k].median * MJ).toFixed(1)} ± ${(sig(m[x.k]) * MJ).toFixed(1)} Earth masses (${x.d.toFixed(2)}σ)`).join('; '));
  const doc = stored('toi1873'), iN = doc.result.samples.keys.indexOf('nalias@d'), Ns = doc.result.samples.values.map((x) => Math.round(x[iN]));
  const prob = Object.fromEntries([1, 2, 3, 4, 7].map((N) => [N, Ns.filter((x) => x === N).length / Ns.length]));
  check('toi1873: planet d\'s alias probabilities from the categorical prior (EXOTIC: 128.6 d preferred, 900 d disfavoured)', prob[7] >= Math.max(prob[1], prob[2], prob[3], prob[4]) * 0.5 && prob[1] < 0.2, Object.entries(prob).map(([N, x]) => `N=${N} (${(900.1885 / N).toFixed(1)} d) ${(100 * x).toFixed(0)}%`).join(', ') + (doc.result.prior_volume ? `; physical prior volume ${doc.result.prior_volume.V.toFixed(3)}` : ''));
  const md = m['mplanet@d'], j = m['jit@rv1'];
  console.log(`     candidate d: Mp ${(md.median * MJ).toFixed(1)} +${(md.plus * MJ).toFixed(1)} −${(md.minus * MJ).toFixed(1)} Earth masses, Rp/R★ ${m['rprs@d'].median.toFixed(4)}, P × N ${m['palias@d'].median.toFixed(4)} d; NEID jitter ${j.median.toFixed(2)} +${j.plus.toFixed(2)} −${j.minus.toFixed(2)} m/s (pyaneti 0.97 +1.08 −0.72, with its GP)`);
} else check('toi1873: stored result present', false, 'run node tools/build_example_results_node.mjs toi1873');

process.exit(ok ? 0 : 1);
