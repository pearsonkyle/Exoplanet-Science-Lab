// Positive planets: phase curves and eclipse maps with no negative brightness (src/core/phasecurve.js, spec.phase.positive_map).
//   1. mapMinimum (exact for degree 1 and 2, grid + pattern search for degree 3) against a 0.25 degree grid polished by
//      Nelder-Mead in numpy (test/make_mappos_reference.py), 120 random maps of which 37 go negative.
//   2. The smallest planet flux over the orbit (always enforced: flux >= 0 at every phase, so the nightside too) against
//      100000 phases; a curve whose nightside dips below zero by 1e-9 of the depth is rejected.
//   3. In buildProblem: a map that is negative somewhere is accepted without positive_map and has zero prior mass with it;
//      phaseSummary(requirePositive) gives no temperatures for it.
//   4. WASP-43 b (public/examples/phasecurve): the eclipse map refitted with positive_map, degree 1 and degree 2, against
//      the stored unconstrained result; what happens to Y1,-1 (unconstrained in HANDOFF) and to the evidence.
//      Runs only with PHASEPOS_FULL=1 (about nine minutes); the numbers are quoted in README.
import { readFileSync } from 'node:fs';
import { mapMinimum, mapTensors, makePhaseCurve, phaseSummary } from '../src/core/phasecurve.js';
import { buildProblem } from '../src/core/model.js';
import { specFromSession, runSession } from '../src/core/session.js';
import { physicalPriorVolume } from '../src/core/physical.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// ---- 1. map minimum
{
  const R = JSON.parse(readFileSync(new URL('./mappos_reference.json', import.meta.url)));
  const worst = { 1: 0, 2: 0, 3: 0 }; let flips = 0, below = 0;
  for (const c of R.cases) {
    const m = mapMinimum(c.y), d = Math.abs(m - c.min);
    worst[c.lmax] = Math.max(worst[c.lmax], d); if ((m < 0) !== (c.min < 0)) flips++; if (m < c.min - 1e-12) below++;
  }
  check('smallest brightness of 120 random maps against a dense numpy grid polished by Nelder-Mead', worst[1] < 1e-12 && worst[2] < 1e-10 && worst[3] < 1e-8 && flips === 0,
    `largest difference ${worst[1].toExponential(1)} (degree 1, closed form), ${worst[2].toExponential(1)} (degree 2, trust-region solve), ${worst[3].toExponential(1)} (degree 3, grid + pattern search); ${R.cases.filter((c) => c.min < 0).length} negative maps, none classified differently`);
  // hard case of the trust-region problem: v orthogonal to the lowest eigenvector of Q
  const y = { y22: 0.3, y11: 0.05 }, mt = mapTensors(y); let g = Infinity;
  for (let la = -90; la <= 90; la += 0.1) for (let lo = -180; lo < 180; lo += 0.1) { const cl = Math.cos(la * Math.PI / 180); const x = cl * Math.sin(lo * Math.PI / 180), yy = Math.sin(la * Math.PI / 180), z = cl * Math.cos(lo * Math.PI / 180); const I = 1 + mt.v[0] * x + mt.Q[0] * x * x + mt.Q[4] * yy * yy + mt.Q[8] * z * z; if (I < g) g = I; }
  check('degree 2, the "hard case" (linear term orthogonal to the lowest eigenvector)', Math.abs(mapMinimum(y) - g) < 1e-6, `${mapMinimum(y).toFixed(8)} against ${g.toFixed(8)} on a 0.1 degree grid`);
}

// ---- 2. phase-curve flux
{
  const base = { rprs: 0.1, ars: 5, inc: 88, per: 1, tmid: 0, ecc: 0, omega: 0, ldLaw: 'quadratic', ld: [0.1, 0.1], fpfs: 0.2 };
  let worst = 0;
  for (const [C, hs, h2c, h2s] of [[0.5, 10, 0.02, -0.03], [0.9, -20, -0.05, 0.04], [1, 0, 0, 0], [0.3, 40, 0.1, 0.1]]) {
    const pc = makePhaseCurve({ ...base, contrast: C, hotspot: hs, h2c, h2s }); let g = Infinity;
    for (let i = 0; i < 100000; i++) g = Math.min(g, pc.phaseFlux((2 * Math.PI * i) / 100000));
    worst = Math.max(worst, Math.abs(pc.minFlux - g) / pc.depth);
  }
  check('smallest planet flux over the orbit against 100000 phases (harmonic model with second harmonics)', worst < 1e-9, `largest difference ${worst.toExponential(1)} of the depth`);
  // contrast 1 puts the nightside exactly at 0; a cos 2 phi term of -1e-9 of the depth (cos 2 phi - 1 = 0 at phi = 0, -2 at 90 deg)
  // with a tiny sin term shifts the minimum; the nightside of 1 - cos(phi) + h2c (cos 2 phi - 1) is h2c x 0 = 0, so use h2s
  const neg = makePhaseCurve({ ...base, contrast: 1, hotspot: 0, h2c: 0, h2s: 1e-6 }), pos = makePhaseCurve({ ...base, contrast: 0.999, hotspot: 0 });
  check('a nightside that dips below zero is rejected, one just above is not', !neg.ok && neg.negative && pos.ok, `min flux ${(neg.minFlux / neg.depth).toExponential(2)} and ${(pos.minFlux / pos.depth).toExponential(2)} of the depth`);
}

// ---- 3. buildProblem and the derived quantities
const root = new URL('../public/examples/phasecurve/', import.meta.url);
const mapSession = JSON.parse(readFileSync(new URL('wasp43b_eclipse_map.json', root)));
{
  const spec = specFromSession(mapSession), v = spec.values;
  const minI = mapMinimum({ y10: v.y10, y11: v.y11, y1m1: v.y1m1 || 0 });
  const off = buildProblem({ ...spec, free: [] }).loglike([]), on = buildProblem({ ...spec, phase: { ...spec.phase, positive_map: true }, free: [] }).loglike([]);
  check('WASP-43 b stored map (y10 0.693 > 1/√3) is negative on the night side: accepted without positive_map, zero prior mass with it', minI < 0 && off > -1e99 && on < -1e99, `smallest brightness ${minI.toFixed(3)} of the mean`);
  const pp = { rprs: v.rprs, ars: v.ars, inc: v.inc, per: v.per, tmid: v.tmid, ecc: 0, omega: 0, ldLaw: spec.ldLaw, ld: [v.ld0, v.ld1], fpfs: v.fpfs, y10: v.y10, y11: v.y11 };
  const s0 = phaseSummary(pp, { map: true, tstar: 4400, band: [4, 5] }), s1 = phaseSummary(pp, { map: true, tstar: 4400, band: [4, 5], requirePositive: true });
  const s2 = phaseSummary({ ...pp, y10: 0.5 }, { map: true, tstar: 4400, band: [4, 5], requirePositive: true });
  check('phaseSummary(requirePositive): no temperatures or hot spot from a negative map; a positive one keeps them', !s0.physical && Number.isFinite(s0.tday) && Number.isNaN(s1.tday) && Number.isNaN(s1.hotspotOffset) && s2.physical && Number.isFinite(s2.tday) && Number.isFinite(s2.tnight),
    `without the switch: dayside ${s0.tday.toFixed(0)} K, nightside ${s0.tnight.toFixed(0)} K from a map ${(100 * s0.map.negativeFraction).toFixed(1)}% negative`);
  const vol = physicalPriorVolume(buildProblem({ ...spec, phase: { ...spec.phase, positive_map: true } }), { n: 20000 });
  const free2 = [...spec.free, ...['y20', 'y22', 'y21'].map((k) => ({ key: k, prior: { type: 'uniform', a: -0.3, b: 0.3 } }))];
  const vol2 = physicalPriorVolume(buildProblem({ ...spec, values: { ...v, y20: 0, y22: 0, y21: 0 }, free: free2, phase: { ...spec.phase, lmax: 2, positive_map: true } }), { n: 20000 });
  // analytic check of the degree-1 volume: the ball |y| <= 1/sqrt(3) inside the box y10 in (0, 0.9), y11 in (-0.3, 0.3),
  // y1m1 in (-0.5, 0.5), among the maps whose phase curve is non-negative (the model's own condition, always applied):
  // 1 + (2/sqrt 3) (y1m1 cos i - sin i sqrt(y10^2 + y11^2)) >= 0, with i uniform in (80, 86) deg as in the session
  let inside = 0, base = 0; const n1 = 90;
  for (let q = 0; q < 12; q++) { const I = (80 + (6 * (q + 0.5)) / 12) * Math.PI / 180, ci = Math.cos(I), si = Math.sin(I);
    for (let a = 0; a < n1; a++) for (let b = 0; b < n1; b++) for (let c = 0; c < n1; c++) {
      const y10 = 0.9 * (a + 0.5) / n1, y11 = -0.3 + 0.6 * (b + 0.5) / n1, y1m1 = -0.5 + (c + 0.5) / n1;
      if (1 + (2 / Math.sqrt(3)) * (y1m1 * ci - si * Math.hypot(y10, y11)) < 0) continue;
      base++; if (y10 * y10 + y11 * y11 + y1m1 * y1m1 <= 1 / 3) inside++;
    } }
  const V1 = inside / base;
  check('prior mass of positive degree-1 maps in the session\'s box (y10 0..0.9, y11 ±0.3, y1m1 ±0.5) against the volume of the ball |y| ≤ 1/√3 (among maps with a non-negative phase curve)', Math.abs(vol.V - V1) < 4 * vol.V * vol.lnVerr + 2e-3,
    `V = ${vol.V.toFixed(4)} ± ${(vol.V * vol.lnVerr).toFixed(4)} (ln V ${vol.lnV.toFixed(3)}) against ${V1.toFixed(4)}; degree 2 with y20, y22, y21 in ±0.3: ln V ${vol2.lnV.toFixed(3)} ± ${vol2.lnVerr.toFixed(3)}`);
}

// ---- 4. WASP-43 b refits
if (process.env.PHASEPOS_FULL === '1') {
  const stored = JSON.parse(readFileSync(new URL('../public/examples/results/eclipsemap.json', import.meta.url))).result;
  const par = (r, k) => r.parameters.find((p) => p.key === k);
  const fmt = (r, k) => { const p = par(r, k); return p ? `${p.median.toFixed(3)} +${p.plus.toFixed(3)} −${p.minus.toFixed(3)}` : '—'; };
  const rows = [`stored, degree 1, unconstrained: ln Z ${stored.logZ.toFixed(2)}, y10 ${fmt(stored, 'y10')}, y11 ${fmt(stored, 'y11')}, y1m1 ${fmt(stored, 'y1m1')}, fpfs ${fmt(stored, 'fpfs')}`];
  const results = {};
  for (const [name, lmax, extra] of [['degree 1, positive_map', 1, []], ['degree 2, positive_map', 2, [['y20', -0.3, 0.3], ['y22', -0.3, 0.3], ['y21', -0.3, 0.3]]]]) {
    const s = JSON.parse(JSON.stringify(mapSession));
    s.phase = { ...s.phase, lmax, positive_map: true };
    for (const [k, a, b] of extra) { s.fit.free.push({ key: k, prior: { type: 'uniform', a, b } }); s.planets[0].parameters[k] = 0; }
    s.fit.sampler = { ...s.fit.sampler, nlive: 400 };
    const t0 = performance.now(), { session, spec, res } = await runSession(s);
    const r = session.result; results[name] = r;
    // smallest brightness of the posterior's best point
    const best = r.best, mi = mapMinimum(Object.fromEntries(['y1m1', 'y10', 'y11', 'y20', 'y21', 'y22'].map((k) => [k, best[k] || 0])));
    const vol = physicalPriorVolume(buildProblem(spec), { n: 20000 });
    rows.push(`${name}: ln Z ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)} (ln V ${vol.lnV.toFixed(2)}), y10 ${fmt(r, 'y10')}, y11 ${fmt(r, 'y11')}, y1m1 ${fmt(r, 'y1m1')}, fpfs ${fmt(r, 'fpfs')}${lmax > 1 ? `, y20 ${fmt(r, 'y20')}, y22 ${fmt(r, 'y22')}, y21 ${fmt(r, 'y21')}` : ''}; best point's smallest brightness ${mi.toFixed(3)}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.log('     WASP-43 b eclipse map (7 Spitzer observations at 4.5 µm):\n       ' + rows.join('\n       '));
  const d1 = results['degree 1, positive_map'], d2 = results['degree 2, positive_map'];
  const w = (r) => par(r, 'y1m1').plus + par(r, 'y1m1').minus, ws = w(stored);
  check('degree 1 with positive_map: y10 is held at the positivity edge (≤ 1/√3) and Y1,-1 is no longer the prior', par(d1, 'y10').median + par(d1, 'y10').plus <= 0.5774 + 1e-3 && w(d1) < 0.5 * ws, `y1m1 68% width ${w(d1).toFixed(3)} against ${ws.toFixed(3)} unconstrained`);
  check('degree 1 positive costs evidence (the data want a day-night contrast a positive degree-1 map cannot make); degree 2 positive recovers it', d1.logZ < stored.logZ - 2 && d2.logZ > d1.logZ + 2, `Δ ln Z ${(d1.logZ - stored.logZ).toFixed(1)} (degree 1), ${(d2.logZ - stored.logZ).toFixed(1)} (degree 2) against the stored unconstrained run`);
}

process.exit(ok ? 0 : 1);
