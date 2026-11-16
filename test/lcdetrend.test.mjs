// Detrending columns through the analyzer's data path (src/core/data.js applyDetrend, parseLightCurve's extra columns,
// combineEpochs, src/ui/dataedit.js): the columns stay on their points through sorting, epochs and edits, the
// regressors and the kernel are rebuilt for the points they belong to, and a systematic injected into simulated data
// is recovered by buildProblem (the injected coefficient is the reference).
import { parseLightCurve, applyDetrend, combineEpochs, removeEpoch } from '../src/core/data.js';
import { keepPoints, binData } from '../src/ui/dataedit.js';
import { buildProblem } from '../src/core/model.js';
import { makeTransit } from '../src/core/transit.js';
import { makeRng } from '../src/core/stats.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const truth = { rprs: 0.12, ars: 9, inc: 89, per: 3.1, tmid: 0.1, ecc: 0, omega: 90, ld0: 0.4, ld1: 0.25, ld2: 0, ld3: 0 };
const tr = makeTransit({ ...truth, ldLaw: 'quadratic', ld: [0.4, 0.25] });

// a night with a centroid drift that leaks into the flux: f = transit * (1 + 0.003 * standardised xc) + noise; rows shuffled
function night(t0, seed, shuffle = true) {
  const rng = makeRng(seed), n = 300, rows = [];
  for (let i = 0; i < n; i++) {
    const t = 2459000 + t0 + (i / (n - 1) - 0.5) * 0.3, xc = 100 + 0.8 * Math.sin(i / 23) + 0.1 * rng.normal(), yc = 50 + 0.3 * Math.cos(i / 31), sky = 200 + i * 0.1;
    rows.push({ t, xc, yc, sky, i });
  }
  const m = rows.reduce((a, r) => a + r.xc, 0) / n, sd = Math.sqrt(rows.reduce((a, r) => a + (r.xc - m) ** 2, 0) / n);
  for (const r of rows) r.f = tr(r.t - 2459000) * (1 + 0.003 * (r.xc - m) / sd) + 4e-4 * rng.normal();
  if (shuffle) rows.sort((a, b) => ((a.i * 7919) % 301) - ((b.i * 7919) % 301));
  return 'BJD_TDB,flux,err,xcentroid,ycen,sky\n' + rows.map((r) => [r.t.toFixed(7), r.f.toFixed(7), '0.0004', r.xc.toFixed(5), r.yc.toFixed(5), r.sky.toFixed(2)].join(',')).join('\n');
}
const p = parseLightCurve(night(0.1, 3), 'night 1');
check('extra columns kept and named (xcentroid -> xc, ycen -> yc)', p.columns && Object.keys(p.columns).join() === 'xc,yc,sky' && p.columns.xc.length === p.t.length, Object.keys(p.columns || {}).join());
check('columns follow the rows through sorting', p.columns.sky.every((v, i) => i === 0 || v >= p.columns.sky[i - 1]), 'sky rises with time in the file, so it must rise after sorting');

const D = applyDetrend(p, { columns: ['xc', 'yc'], poly: 1 });
check('regressors from columns and a time polynomial', D.regressors.length === 3 && D.detrendInfo.names.join() === 'xc,yc,P1(t)' && !D.kernel && p.regressors === undefined, D.detrendInfo.names.join());
const fit = (data) => buildProblem({ data, values: { ...truth, tmid: truth.tmid + 2459000 - data.tRef }, ldLaw: 'quadratic', free: [], exptime: 0, supersample: 1 }).detail([]);
const det = fit(D), c = det.regCoeffs[0][0] / det.a1;
check('injected centroid systematic recovered', Math.abs(c - 0.003) < 0.0002, `coefficient of xc per standard deviation ${(c * 1e6).toFixed(0)} ppm against 3000 injected; chi2 ${det.chi2.toFixed(1)} for ${D.t.length} points (without the regressors ${fit(applyDetrend(p, null)).chi2.toFixed(0)})`);
check('a name not in the data is dropped with the reason', applyDetrend(p, { columns: ['fwhm'] }).detrendInfo.dropped[0].why === 'not in the data');

// two nights: columns survive combining; the kernel is built night by night
const q = parseLightCurve(night(3.2, 5), 'night 2'), C = combineEpochs([p, q]);
check('combined epochs keep the shared columns in order', C.columns && C.columns.xc.length === C.t.length && C.columns.sky[0] === p.columns.sky[0]);
const K = applyDetrend(C, { columns: [], kernel: { features: ['xc', 'yc'], neighbors: 20 } });
let cross = 0; for (let i = 0; i < K.kernel.n; i++) for (let k = 0; k < K.kernel.k; k++) if (C.epoch[K.kernel.idx[i * K.kernel.k + k]] !== C.epoch[i]) cross++;
check('kernel built per epoch: n is the number of points and no neighbour comes from the other night', K.kernel.n === C.t.length && K.kernel.k === 20 && cross === 0, `n ${K.kernel.n}, k ${K.kernel.k}, cross-night neighbours ${cross}`);
const dk = fit(K);
check('the kernel model is accepted by buildProblem', dk && Number.isFinite(dk.chi2) && dk.kernel && dk.kernel.length === C.t.length, dk ? `chi2 ${dk.chi2.toFixed(1)} for ${C.t.length} points` : 'rejected');

// edits keep the columns on their points and drop the stale model
const E = keepPoints(D, (i) => i % 2 === 0);
check('keepPoints keeps the columns aligned and drops the old regressors', E.columns.xc.length === E.t.length && E.columns.xc[3] === D.columns.xc[6] && !E.regressors && E.detrend);
const B = binData(D, 5 / 1440);
check('binning averages the columns with the same weights', B.columns.sky.length === B.t.length && Math.abs(B.columns.sky[0] - D.columns.sky.slice(0, 5).reduce((a, x) => a + x, 0) / 5) < 0.06, `${B.t.length} bins`);
const R = removeEpoch({ ...C, columns: C.columns }, 1);
check('removing an epoch keeps the other epoch’s columns', R.columns && R.columns.xc.length === R.t.length);
process.exit(ok ? 0 : 1);
