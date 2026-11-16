// Ephemeris fitting against an independent reference (exact rational arithmetic, cross-checked with numpy.polyfit; see make_ephemeris_reference.py),
// exact recovery without noise, error-bar coverage by Monte Carlo, and published period-change rates.
import { readFileSync } from 'node:fs';
import { fitEphemeris, assignEpochs, parseTimings, MS_PER_YEAR } from '../src/core/ephemeris.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./ephemeris_reference.json', import.meta.url)));

// --- exact reference: coefficients, covariance, chi2 and a propagated prediction
let worst = { coef: 0, cov: 0, chi2: 0, pred: 0, sig: 0 };
for (const c of ref.cases) for (const deg of [1, 2]) {
  if (c.epochs.length < deg + 1) continue;
  const r = c.fits[deg], f = fitEphemeris(c.epochs, c.times, c.errs, deg);
  const mine = [f.t0 - c.tref, f.per, f.dPdE / 2].slice(0, deg + 1), sd = r.cov.map((row, i) => Math.sqrt(row[i]));
  // coefficients compared in units of their own 1-sigma uncertainty; covariance relatively
  mine.forEach((v, i) => (worst.coef = Math.max(worst.coef, Math.abs(v - r.coef[i]) / sd[i])));
  const scale = [1, 1, 0.5];   // the reference fits dPdE/2
  for (let i = 0; i <= deg; i++) for (let j = 0; j <= deg; j++) worst.cov = Math.max(worst.cov, Math.abs(f.cov[i][j] * scale[i] * scale[j] - r.cov[i][j]) / (sd[i] * sd[j]));
  if (c.epochs.length > deg + 1) worst.chi2 = Math.max(worst.chi2, Math.abs(f.chi2 - r.chi2) / Math.max(1, r.chi2));
  const p = f.predict(r.predictEpoch);
  worst.pred = Math.max(worst.pred, Math.abs(p.t - c.tref - r.predictT) / r.predictSigma);
  worst.sig = Math.max(worst.sig, Math.abs(p.sigma / r.predictSigma - 1));
}
check('coefficients match the exact solution', worst.coef < 1e-5, `max difference ${worst.coef.toExponential(1)} sigma (the floor is T0 stored as a float64 Julian date, 5e-10 d)`);
check('covariance matches the exact solution', worst.cov < 1e-9, `max relative difference ${worst.cov.toExponential(1)}`);
check('chi2 matches', worst.chi2 < 1e-5, `max relative difference ${worst.chi2.toExponential(1)}`);
check('predicted time and its uncertainty match', worst.pred < 1e-5 && worst.sig < 1e-9, `${worst.pred.toExponential(1)} sigma, ${worst.sig.toExponential(1)} relative`);

// --- exact recovery without noise, at Julian-date magnitudes
{
  const t0 = 2459000.123456, per = 3.52474859, dPdE = -2.5e-9, E = Array.from({ length: 30 }, (_, i) => 37 * i - 400);
  const T = E.map((e) => t0 + per * e + 0.5 * dPdE * e * e), s = E.map(() => 3e-4);
  const q = fitEphemeris(E, T, s, 2);
  check('noise-free quadratic recovered', Math.abs(q.t0 - t0) < 2e-9 && Math.abs(q.per - per) < 1e-11 && Math.abs(q.dPdE - dPdE) < 1e-13, `dT0 ${(q.t0 - t0).toExponential(1)} d, dP ${(q.per - per).toExponential(1)} d, d(dP/dE) ${(q.dPdE - dPdE).toExponential(1)}`);
  const Tl = E.map((e) => t0 + per * e), l = fitEphemeris(E, Tl, s, 1);
  check('noise-free linear recovered', Math.abs(l.t0 - t0) < 2e-9 && Math.abs(l.per - per) < 1e-11 && l.chi2 < 1e-6);
}

// --- error bars: pulls of P and dP/dE over many noise realisations should have unit scatter
{
  const rng = makeRng(3), t0 = 2456305.455, per = 1.0914203, dPdE = -1.0e-9, E = Array.from({ length: 45 }, (_, i) => 60 * i), s = E.map((_, i) => 2e-4 * (1 + (i % 4)));
  let sp = 0, sq = 0, sc = 0; const N = 4000;
  for (let k = 0; k < N; k++) {
    const T = E.map((e, i) => t0 + per * e + 0.5 * dPdE * e * e + s[i] * rng.normal());
    const f = fitEphemeris(E, T, s, 2);
    sp += ((f.per - per) / f.err.per) ** 2; sq += ((f.dPdE - dPdE) / f.err.dPdE) ** 2; sc += f.chi2 / f.dof;
  }
  const rp = Math.sqrt(sp / N), rq = Math.sqrt(sq / N);
  check('reported uncertainties have the right coverage', Math.abs(rp - 1) < 0.04 && Math.abs(rq - 1) < 0.04 && Math.abs(sc / N - 1) < 0.02, `pull rms: P ${rp.toFixed(3)}, dP/dE ${rq.toFixed(3)}; mean reduced chi2 ${(sc / N).toFixed(3)}`);
}

// --- dP/dE to dP/dt: published WASP-12 b decay rates (TASTE V, Leonardi et al. 2024, arXiv:2402.12120)
{
  const pub = [
    { P: 1.0914192185, dPdE: -1.063e-9, e: 0.093e-9, rate: -30.72, rateErr: 2.67, name: 'own data' },
    { P: 1.091418901, dPdE: -1.082e-9, e: 0.042e-9, rate: -31.27, rateErr: 1.23, name: 'combined' },
  ];
  for (const p of pub) {
    const rate = (p.dPdE / p.P) * MS_PER_YEAR, re = (p.e / p.P) * MS_PER_YEAR;
    check(`dP/dt conversion, WASP-12 b ${p.name}`, Math.abs(rate - p.rate) < 0.03 && Math.abs(re - p.rateErr) < 0.03, `${rate.toFixed(2)} ± ${re.toFixed(2)} vs ${p.rate} ± ${p.rateErr} ms/yr published`);
  }
  // and through the fitter: dPdt and its error are dPdE/P and its error (the period terms enter at the 1e-6 level)
  const E = Array.from({ length: 60 }, (_, i) => 50 * i), T = E.map((e) => 2456305.455 + 1.0914192185 * e - 0.5 * 1.063e-9 * e * e);
  const f = fitEphemeris(E, T, E.map(() => 3e-4), 2);
  check('fit reports dP/dt = (dP/dE)/P', Math.abs(f.dPdt * MS_PER_YEAR + 30.72) < 0.03 && Math.abs(f.dPdtErr / (f.err.dPdE / f.per) - 1) < 1e-4, `${(f.dPdt * MS_PER_YEAR).toFixed(2)} ms/yr`);
}

// --- epoch counting and the text reader
{
  const per = 2.1500082, t0 = 2455867.4, E = [0, 3, 10, 171, 172, 900], T = E.map((e, i) => t0 + per * e + 0.002 * Math.sin(i));
  const a = assignEpochs(T, per, T[0]);
  check('epochs counted from the period', a.epochs.join() === E.join() && a.maxFrac < 0.002, `max offset ${a.maxFrac.toFixed(4)} periods`);
  check('ambiguous epochs are flagged', assignEpochs([0, 10.0], 0.8, 0).maxFrac > 0.4);
  const p2 = parseTimings('# BJD_TDB, err\ntime,err\n2455870.1234, 0.0005\n2455867.9734 0.0007\n');
  check('reader: two columns, header skipped, sorted', p2.rows.length === 2 && p2.rows[0].t === 2455867.9734 && p2.rows[0].e === 0.0007 && p2.rows[0].epoch === null && p2.skipped === 1);
  const p3 = parseTimings('0\t2455867.9734\t0.0007\n12\t2455893.7735\t0.0004');
  check('reader: epoch column found', p3.rows[1].epoch === 12 && p3.rows[1].t === 2455893.7735 && p3.rows[1].e === 0.0004);
  const p4 = parseTimings('0.0007 2455867.9734 0\n0.0004 2455893.7735 12');
  check('reader: column order does not matter', p4.rows[1].epoch === 12 && p4.rows[1].t === 2455893.7735 && p4.rows[1].e === 0.0004);
  let threw = 0;
  for (const bad of ['', 'a b c', '2455867.9 0', '1 2\n1 2 3']) { try { parseTimings(bad); } catch { threw++; } }
  try { fitEphemeris([0], [1], [0.1], 1); } catch { threw++; }
  try { fitEphemeris([5, 5], [1, 1], [0.1, 0.1], 1); } catch { threw++; }
  check('bad input is refused with a message', threw === 6);
}
process.exit(ok ? 0 : 1);
