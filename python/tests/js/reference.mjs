// What Node gets from src/core directly (no bundle), as JSON on stdout: the reference the Python tests compare
// the package with. usage: node python/tests/js/reference.mjs
import { readFileSync } from 'node:fs';
import { transitModel } from '../../../src/core/transit.js';
import { autoSupersample, buildProblem } from '../../../src/core/model.js';
import { makeRV } from '../../../src/core/rv.js';
import { specFromSession, runSession } from '../../../src/core/session.js';
import { toySession } from './toy_session.mjs';

const pub = (p) => JSON.parse(readFileSync(new URL('../../../public/validation/' + p, import.meta.url), 'utf8'));
const grid = (c) => Array.from({ length: c.n }, (_, i) => c.t0 + ((c.t1 - c.t0) * i) / (c.n - 1));
const T = pub('transit.json'), V = pub('rv.json');
const transit = T.cases.map((c) => { const times = grid(c), p = { rprs: c.rprs, ars: c.ars, inc: c.inc, per: c.per, tmid: c.tmid, ecc: c.ecc, omega: c.omega, ldLaw: c.law, ld: c.ld }; return { label: c.label, params: p, times, flux: Array.from(transitModel(times, p)), truth: c.truth }; });
const exposure = T.exposure.map((c) => { const times = grid(c), p = { ...c.p, ldLaw: c.p.law }, ns = autoSupersample(c.exptime, p); return { label: c.label, params: p, exptime: c.exptime, supersample: ns, times, flux: Array.from(transitModel(times, p, null, { exptime: c.exptime, supersample: ns })), truth: c.truth }; });
const rv = V.cases.map((c) => { const times = grid(c), f = makeRV(c); return { label: c.label, params: { per: c.per, tmid: c.tmid, ecc: c.ecc, omega: c.omega, K: c.K }, times, rv: times.map(f), truth: c.truth }; });
const { session } = toySession('masses'), spec = specFromSession(session), det = buildProblem({ ...spec, free: [] }).detail([]);
const out = await runSession(session, { keepSamples: false });
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, transit, exposure, rv,
  toy: { session, chi2: det.chi2, chi2lc: det.chi2lc, chi2rv: det.chi2rv, lnL: det.lnL, result: out.session.result } }));
