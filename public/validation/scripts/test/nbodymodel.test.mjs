// N-body dynamics inside the shared likelihood (buildProblem with spec.nbody).
import fs from 'fs';
import { buildProblem } from '../src/core/model.js';
import { specFromSession } from '../src/core/session.js';
import { nbody } from '../src/core/nbody.js';

let fail = 0;
const ok = (name, cond, note = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}   ${note}`); if (!cond) fail++; };
const dir = new URL('../public/examples/nbody/', import.meta.url);
const s = JSON.parse(fs.readFileSync(new URL('session.json', dir))), truth = JSON.parse(fs.readFileSync(new URL('truth.json', dir)));
const spec = specFromSession(s), tRef = s.time_reference, N = spec.timing[0].t.length;

// 1. Keplerian reference: the linear ephemeris of the example's notes
const kep = buildProblem({ ...spec, free: [] }).detail([]);
ok('Keplerian chi2 of the stored session = the linear-ephemeris chi2 of truth.json', Math.abs(kep.chi2 - truth.observations.linear_ephemeris.chi2) < 0.5, `${kep.chi2.toFixed(2)} vs ${truth.observations.linear_ephemeris.chi2.toFixed(2)} (the session rounds P and T0)`);

// 2. massless planets: the dynamical model is the Keplerian one
const v0 = { ...spec.values, mplanet: 0 };
const k0 = buildProblem({ ...spec, values: v0, free: [] }).detail([]), d0 = buildProblem({ ...spec, values: v0, free: [], nbody: { epoch: 0 } }).detail([]);
ok('zero masses: N-body chi2 = Keplerian chi2', Math.abs(k0.chi2 - d0.chi2) < 1e-4, `${d0.chi2.toFixed(6)} vs ${k0.chi2.toFixed(6)}`);

// 3. the true two-planet system explains the times; the same two planets without their pull do not
const [b, c] = truth.planets, vals = { ...spec.values };
for (const f of ['per', 'tmid', 'ecc', 'omega', 'inc', 'mplanet', 'rprs']) { vals[f] = f === 'tmid' ? b[f] - tRef : b[f]; vals[f + '@c'] = f === 'tmid' ? c[f] - tRef : c[f]; }
vals['ars@c'] = 14.4;
const two = { ...spec, planets: ['', 'c'], values: vals, free: [] };
const dyn = buildProblem({ ...two, nbody: { epoch: truth.epoch - tRef } }).detail([]), flat = buildProblem(two).detail([]);
ok('true system through the N-body likelihood: chi2 about N', dyn.chi2 > 0.6 * N && dyn.chi2 < 1.5 * N, `chi2 ${dyn.chi2.toFixed(1)} for ${N} times`);
ok('the same planets without dynamics are far worse', flat.chi2 > dyn.chi2 + 150, `chi2 ${flat.chi2.toFixed(1)}`);

// 4. independent of the hook: chi2 from nbody() transit times directly (IAS15, the other integrator)
const sim = nbody({ mstar: vals.mstar, rstar: vals.rstar, epoch: truth.epoch - tRef, planets: [b, c].map((p) => ({ ...p, tmid: p.tmid - tRef })) }, { tStart: truth.epoch - tRef, tEnd: Math.max(...spec.timing[0].t) + 3, integrator: 'ias15', event: 'conjunction' });
const tb = Array.from(sim.transits[0].t); let chi = 0;
spec.timing[0].t.forEach((t, i) => { let best = Infinity; for (const m of tb) if (Math.abs(t - m) < Math.abs(best)) best = t - m; chi += (best / spec.timing[0].e[i]) ** 2; });
ok('chi2 from IAS15 transit times directly agrees with the Wisdom-Holman likelihood', Math.abs(chi - dyn.chi2) < 0.5, `${chi.toFixed(3)} vs ${dyn.chi2.toFixed(3)}`);

// 4b. nbody.linear: a straight line in epoch fitted inside the likelihood can only lower chi2, and absorbs a wrong T0 and period
const lin = buildProblem({ ...two, nbody: { epoch: truth.epoch - tRef, linear: true } }).detail([]);
ok('linear profile: chi2 <= chi2 without it, by at most the two parameters it fits', lin.chi2 <= dyn.chi2 + 1e-9 && dyn.chi2 - lin.chi2 < 12, `${lin.chi2.toFixed(3)} vs ${dyn.chi2.toFixed(3)}`);
const off = buildProblem({ ...two, values: { ...vals, tmid: vals.tmid + 0.004 }, nbody: { epoch: truth.epoch - tRef, linear: true } }).detail([]);
const offRaw = buildProblem({ ...two, values: { ...vals, tmid: vals.tmid + 0.004 }, nbody: { epoch: truth.epoch - tRef } }).detail([]);
ok('linear profile absorbs a 6-minute error of T0', off.chi2 < lin.chi2 + 15 && offRaw.chi2 > 10 * lin.chi2, `${off.chi2.toFixed(1)} with the line, ${offRaw.chi2.toFixed(0)} without`);

// 5. radial velocities: one planet, N-body = Keplerian
const rvT = Float64Array.from({ length: 40 }, (_, i) => 3 + i * 0.37), one = buildProblem({ ...spec, timing: [], values: spec.values, free: [], rv: [{ name: 'x', t: rvT, v: new Float64Array(40), e: new Float64Array(40).fill(3) }] });
const oneD = buildProblem({ ...spec, timing: [], values: spec.values, free: [], nbody: { epoch: 0 }, rv: [{ name: 'x', t: rvT, v: new Float64Array(40), e: new Float64Array(40).fill(3) }] });
const a = one.detail([]), bb = oneD.detail([]);
ok('one planet: N-body radial velocities = Keplerian', Math.abs(a.chi2 - bb.chi2) < 1e-3 * a.chi2, `chi2 ${bb.chi2.toFixed(3)} vs ${a.chi2.toFixed(3)}`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log('nbody model: all ok');
