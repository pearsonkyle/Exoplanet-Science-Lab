// Rossiter–McLaughlin anomaly (src/core/rm.js) and its place in buildProblem's velocity model.
//   1. The integral over the occulted area at given sky positions against a brute-force pixel sum
//      (test/make_rm_reference.py, .venv/bin/python): three limb-darkening laws, Rp/R* 0.01 to 0.2, inside the disc,
//      on the limb, in ingress and egress, four obliquities.
//   2. Exact limits: a uniform star with the planet inside the disc, dV = -v sin i x_s p^2 / (1 - p^2).
//   3. The small-planet limit of Ohta et al. (2005): the relative difference falls as p^2.
//   4. Whole curves from an orbit against ellc (Maxted 2016; test/make_rm_ellc_reference.py): sign of lambda and geometry.
//   5. buildProblem: the anomaly is added to the velocities only when vsini is set, and a fit recovers vsini and lambda.
import { readFileSync } from 'node:fs';
import { rmAnomaly, rmSmallPlanet, occultedMoment, makeRM } from '../src/core/rm.js';
import { prepareLD, toClaret } from '../src/core/limbdark.js';
import { buildProblem, activeParams } from '../src/core/model.js';
import { makeRV } from '../src/core/rv.js';
import { runFit } from '../src/core/fitRunner.js';
import { weightedQuantiles, makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- 1. pixel reference
{
  const R = JSON.parse(readFileSync(new URL('./rm_reference.json', import.meta.url)));
  let worstRel = 0, worstAbs = 0, beyond = 0, n = 0;
  for (const c of R.cases) {
    const dv = rmAnomaly(c.X, c.Y, c.p, prepareLD(c.claret), 1, c.lambda), d = Math.abs(dv - c.dv);
    worstAbs = Math.max(worstAbs, d); if (Math.abs(c.dv) > 1e-6) worstRel = Math.max(worstRel, d / Math.abs(c.dv));
    if (d > Math.max(c.pixel_err, 1e-12)) beyond++; n++;
  }
  check('anomaly matches the brute-force pixel integration in every case', beyond === 0, `${n} cases (uniform, quadratic, Claret 4; Rp/R* 0.01-0.2; inside, limb, ingress, egress); largest difference ${worstAbs.toExponential(2)} v sin i, ${(worstRel * 1e6).toFixed(1)} ppm of the anomaly; all within the pixel sum's own error (N vs N/2)`);
}

// ---- 2. uniform star, planet on the disc: exact
{
  const u = prepareLD([0, 0, 0, 0]); let w = 0;
  for (const [X, Y, p] of [[0.3, -0.2, 0.1], [-0.5, 0.4, 0.2], [0.02, 0.01, 0.15]]) for (const lam of [0, 40, -120]) {
    const l = lam * Math.PI / 180, exact = -(X * Math.cos(l) - Y * Math.sin(l)) * p * p / (1 - p * p);
    w = Math.max(w, Math.abs(rmAnomaly(X, Y, p, u, 1, lam) - exact));
  }
  check('uniform star, planet inside the disc: dV = -v sin i x_s p^2 / (1 - p^2)', w < 1e-15, `largest difference ${w.toExponential(1)}`);
  check('moment of a uniform disc is its area times its centre', Math.abs(occultedMoment(0.4, 0.1, u) - Math.PI * 0.4 * 0.01) < 1e-16);
}

// ---- 3. Ohta et al. 2005, small planet
{
  const a = toClaret('nonlinear', [0.4939, -0.0729, 0.4578, -0.2158]), L = prepareLD(a), rel = [];
  for (const p of [0.03, 0.01, 0.003]) {
    let w = 0; for (const [X, Y] of [[0.3, -0.2], [-0.6, -0.4], [0.75, 0.3]]) { const x = rmAnomaly(X, Y, p, L, 1, 25), y = rmSmallPlanet(X, Y, p, a, 1, 25); w = Math.max(w, Math.abs(x / y - 1)); }
    rel.push(w);
  }
  check('Ohta et al. (2005) small-planet limit, difference falling as p^2', rel[1] < 2e-3 && rel[2] < 2e-4 && rel[0] / rel[1] > 7 && rel[1] / rel[2] > 7, `relative difference ${rel.map((x) => x.toExponential(1)).join(', ')} at Rp/R* = 0.03, 0.01, 0.003`);
}

// ---- 4. ellc
{
  const E = JSON.parse(readFileSync(new URL('./rm_ellc_reference.json', import.meta.url)));
  let worst = 0, flip = Infinity; const rows = [];
  for (const c of E.cases) {
    const curve = (lam) => { const f = makeRM({ rprs: c.rprs, per: c.per, tmid: 0, ars: c.ars, inc: c.inc, ecc: 0, omega: 0, vsini: c.vsini, lambda: lam, ldLaw: 'quadratic', ld: c.u }); return c.t.map(f); };
    const m = curve(c.lambda), amp = Math.max(...c.rm.map(Math.abs)), d = Math.max(...m.map((x, i) => Math.abs(x - c.rm[i])));
    worst = Math.max(worst, d / amp); rows.push(`λ ${c.lambda}°, i ${c.inc}°: ${d.toFixed(3)} of ${amp.toFixed(1)} m/s`);
    if (c.lambda !== 0) { const mm = curve(-c.lambda); flip = Math.min(flip, Math.max(...mm.map((x, i) => Math.abs(x - c.rm[i])))); }
  }
  check('whole curves match ellc (flux-weighted velocities) to 0.1% of the amplitude', worst < 1e-3, rows.join('; '));
  check('lambda has ellc\'s sign: the opposite sign misses by metres per second', flip > 3, `smallest miss with -lambda ${flip.toFixed(2)} m/s`);
}

// ---- 5. in buildProblem
{
  const pl = { rprs: 0.1, ars: 10, inc: 87, per: 3, tmid: 0, ecc: 0, omega: 0, mplanet: 1 }, K = 120, vsini = 5, lam = 30, ld = [0.4, 0.26];
  const t = Float64Array.from({ length: 70 }, (_, i) => -0.1 + 0.2 * i / 69), rng = makeRng(5), sig = 2;
  const kep = makeRV({ ...pl, K }), rm = makeRM({ ...pl, vsini, lambda: lam, ldLaw: 'quadratic', ld });
  const rv = [{ name: 'spectrograph', t, v: Float64Array.from(t, (x) => 50 + kep(x) + rm(x) + sig * rng.normal()), e: new Float64Array(t.length).fill(sig) }];
  const values = { ...pl, K, ld0: ld[0], ld1: ld[1], 'jit@rv1': 0 };
  const det = (v) => buildProblem({ data: null, rv, values: v, ldLaw: 'quadratic', free: [] }).detail([]);
  const off = det(values), on = det({ ...values, vsini, lambda: lam });
  let w = 0; for (let i = 0; i < t.length; i++) w = Math.max(w, Math.abs(on.rv[0].model[i] - off.rv[0].model[i] - rm(t[i])), Math.abs(on.rv[0].rm[i] - rm(t[i])));
  check('with vsini set the velocity model is Keplerian + rm.js anomaly; without it unchanged', w < 1e-12 && !off.rv[0].rm, `largest difference ${w.toExponential(1)} m/s; chi2 ${off.chi2rv.toFixed(1)} without, ${on.chi2rv.toFixed(1)} with the anomaly for ${t.length} points`);
  const spec = { data: null, rv, values, ldLaw: 'quadratic', sampler: { nlive: 300, seed: 9 },
    free: [{ key: 'vsini', prior: { type: 'uniform', a: 0, b: 15 } }, { key: 'lambda', prior: { type: 'uniform', a: -180, b: 180 } }, { key: 'K', prior: { type: 'uniform', a: 0, b: 300 } }] };
  const r = await runFit(spec, () => {}, () => false);
  const q = (k) => { const col = Float64Array.from({ length: r.n }, (_, i) => r.samples[i * r.ndim + k]); const [lo, med, hi] = weightedQuantiles(col, r.weights, [0.1587, 0.5, 0.8413]); return { med, s: 0.5 * (hi - lo), lo, hi }; };
  const qv = q(0), ql = q(1);
  check('a fit to simulated in-transit velocities recovers v sin i and lambda', r.stopReason === 'converged' && Math.abs(qv.med - vsini) < 3 * qv.s && Math.abs(ql.med - lam) < 3 * ql.s,
    `v sin i ${qv.med.toFixed(2)} +${(qv.hi - qv.med).toFixed(2)} -${(qv.med - qv.lo).toFixed(2)} km/s (5), λ ${ql.med.toFixed(1)} +${(ql.hi - ql.med).toFixed(1)} -${(ql.med - ql.lo).toFixed(1)}° (30)`);
  const keys = activeParams('quadratic', false, { planets: [{ sfx: '', letter: 'b' }, { sfx: 'c', letter: 'c' }], rv: ['HARPS'], rm: true }).filter((p) => p.group === 'rv').map((p) => p.key);
  check('activeParams lists vsini and one lambda per planet', keys.join() === 'rvlin,rvquad,jit@rv1,vsini,lambda,lambda@c', keys.join(' '));
}
process.exit(ok ? 0 : 1);
