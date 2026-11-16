// Periodogram analysis of timing residuals against independent references (see make_periodogram_reference.py):
// astropy.timeseries.LombScargle for the power, the false-alarm statistics and the model at the peak;
// EXOTIC's ephemeris_fitter.plot_periodogram on the mid-transit times of its two examples; then recovery of
// injected timing variations, the coverage of the reported uncertainties, and the false-alarm rate on noise.
import { readFileSync } from 'node:fs';
import { lombScargle, frequencyGrid, timingFrequencyGrid, falseAlarmProbability, falseAlarmLevel, bootstrapFalseAlarm, fitSinusoids, bicScaled, timingPeriodogram, gammaln } from '../src/core/periodogram.js';
import { fitEphemeris, assignEpochs, parseTimings } from '../src/core/ephemeris.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./periodogram_reference.json', import.meta.url)));
const ex = (x) => x.toExponential(1), maxOf = (a) => a.reduce((m, v) => Math.max(m, v), -Infinity);

// --- ln Gamma, which the false-alarm formulae need: exact values Gamma(1/2) = sqrt(pi), Gamma(n) = (n-1)!, Gamma(n + 1/2)
{
  const cases = [[0.5, 0.5 * Math.log(Math.PI)], [1, 0], [5, Math.log(24)], [19.5, Math.log(Math.sqrt(Math.PI)) + [...Array(19)].reduce((s, _, i) => s + Math.log(i + 0.5), 0)], [171, [...Array(170)].reduce((s, _, i) => s + Math.log(i + 1), 0)]];
  const w = Math.max(...cases.map(([x, v]) => Math.abs(gammaln(x) - v) / Math.max(1, Math.abs(v))));
  check('ln Gamma against exact values', w < 1e-13, `max error ${ex(w)}`);
}

// --- astropy: power, grid, false alarms, model at the peak
{
  const w = { grid: 0, power: 0, nofit: 0, fap: 0, level: 0, model: 0, coef: 0 }; let npow = 0, nfap = 0;
  for (const c of ref.astropy) {
    const opt = { samplesPerPeak: c.samplesPerPeak, nyquistFactor: c.nyquistFactor }; if (c.minFrequency != null) opt.minFrequency = c.minFrequency; if (c.maxFrequency != null) opt.maxFrequency = c.maxFrequency;
    const fr = frequencyGrid(c.t, opt);
    w.grid = Math.max(w.grid, fr.length === c.freq.length ? maxOf(c.freq.map((f, i) => Math.abs(fr[i] - f) / f)) : 1);
    const ctx = { t: c.t, dy: c.dy, fmax: c.fapFmax };   // astropy rounds the maximum frequency onto its default grid
    for (const norm of ['standard', 'model', 'log', 'psd']) {
      // power compared relative to the highest peak of that periodogram
      const p = lombScargle(c.t, c.y, c.dy, c.freq, { normalization: norm }), top = maxOf(c.power[norm]);
      c.power[norm].forEach((v, i) => { w.power = Math.max(w.power, Math.abs(p[i] - v) / top); npow++; });
      for (const m of ['baluev', 'davies', 'naive', 'single']) c.fap[norm][m].forEach((v, i) => { const d = Math.abs(falseAlarmProbability(c.fap[norm].z[i], ctx, { normalization: norm, method: m }) / v - 1); if (c.name.includes('Julian')) w.fapJD = Math.max(w.fapJD || 0, d); else w.fap = Math.max(w.fap, d); nfap++; });
      for (const m of ['baluev', 'davies', 'naive']) c.level[norm][m].forEach((v, i) => { w.level = Math.max(w.level, Math.abs(falseAlarmLevel(c.level[norm].p[i], ctx, { normalization: norm, method: m }) / v - 1)); });
    }
    const q = lombScargle(c.t, c.y, c.dy, c.freq, { fitMean: false });
    c.powerNoFitMean.forEach((v, i) => (w.nofit = Math.max(w.nofit, Math.abs(q[i] - v))));
    // least-squares sinusoid + constant at astropy's peak frequency: the model curve, and its sine and cosine coefficients
    const f = fitSinusoids(c.t, c.y, c.dy, [1 / c.peak.freq], { order: 0, refine: false }), amp = Math.hypot(c.peak.sin, c.peak.cos);
    c.peak.tq.forEach((t, i) => (w.model = Math.max(w.model, Math.abs(f.model(t) - c.peak.model[i]) / amp)));
    w.coef = Math.max(w.coef, Math.abs(f.terms[0].amp / amp - 1));
  }
  // The reference is astropy's method='slow' (the exact sums). Its default, 'auto', switches to the FFT-based 'fast'
  // approximation above 200 frequencies, which is off by up to 1e-2 in power on these sets (printed below).
  // Tolerances: the power is a ratio of sums of ~50 products, so agreement should be near rounding (1e-10 allows
  // for the Julian-date case, where astropy does not centre the times and loses digits itself). The false-alarm
  // probabilities are closed forms: 1e-10, except with Julian-date sample times, where astropy forms the variance
  // of the times as mean(t^2) - mean(t)^2 and keeps only ~8 digits of it: 1e-6 there.
  // astropy finds the levels with a root finder (default tolerance ~1e-8): 1e-6.
  check('frequency grid follows astropy autofrequency', w.grid < 1e-12, `max relative difference ${ex(w.grid)}`);
  check('power matches astropy, four normalisations', w.power < 1e-10, `${npow} values, max difference ${ex(w.power)} of the peak`);
  check('power without the floating mean matches astropy', w.nofit < 1e-10, `max difference ${ex(w.nofit)}`);
  check('false-alarm probabilities match astropy (baluev, davies, naive, single)', w.fap < 1e-10 && w.fapJD < 1e-6, `${nfap} values, max relative difference ${ex(w.fap)} (${ex(w.fapJD)} with Julian-date times)`);
  check('false-alarm levels match astropy', w.level < 1e-6, `max relative difference ${ex(w.level)}`);
  console.log(`     (astropy's default 'fast' method differs from its own exact sums by up to ${ex(Math.max(...ref.astropy.map((c) => c.fastMinusExact)))} in power on these sets)`);
  check('sinusoid at the peak matches astropy model()', w.model < 1e-8 && w.coef < 1e-8, `curve ${ex(w.model)} of the amplitude; amplitude ${ex(w.coef)} relative`);
}

// --- EXOTIC plot_periodogram on its own example times
const min = 1440;
for (const e of ref.exotic) {
  const E = e.epochs, T = e.times, S = e.errs, n = T.length, tag = e.name.replace(/ as shipped.*/, ' (clipped)').replace(', all 40 times', ' (all 40)');
  // its periodogram is astropy's standard GLS of the linear-fit residuals against epoch
  const lin = fitEphemeris(E, T, S, 1), res = E.map((_, i) => lin.residual(i));
  const p = lombScargle(E, res, S, e.freq), dp = maxOf(e.powerExact.map((v, i) => Math.abs(p[i] - v))), dfast = maxOf(e.power.map((v, i) => Math.abs(p[i] - v)));
  // EXOTIC calls autopower() with astropy's default method, which is the approximate 'fast' one on these grids.
  // Against the exact sums for EXOTIC's own LombScargle object: 1e-6 in power (the residuals are differences of
  // Julian dates, 4e-10 d resolution against ~1e-3 d of signal). Against what EXOTIC plots: within the error of
  // the approximation itself, which the reference script measured (fastMinusExact).
  check(`${tag}: periodogram of the residuals`, dp < 1e-6 && dfast < e.fastMinusExact + 1e-6, `${e.power.length} of ${e.nFreq} frequencies, max power difference ${ex(dp)} from astropy exact; ${ex(dfast)} from EXOTIC's curve, whose own approximation error is ${ex(e.fastMinusExact)}`);
  // its three least-squares models at its own periods: chi2, BIC (statsmodels definition), amplitudes
  const y = T.map((t) => t - T[0]), F = e.fits;
  const f1 = fitSinusoids(E, y, S, [e.periods[0]], { order: 1, refine: false });
  let f2 = null; try { f2 = fitSinusoids(E, y, S, e.periods, { order: 1, refine: false }); } catch (err) { /* reported below */ }
  const mine = [{ chi2: lin.chi2, k: 2 }, { chi2: f1.chi2, k: f1.kLinear }, f2 && { chi2: f2.chi2, k: f2.kLinear }], G = e.fitsCentred;
  // Two references. "centred": statsmodels on the same design with the first time subtracted and the epochs centred,
  // which keeps float64 precision: chi2 to 1e-7 relative (set by the 4.7e-10 d resolution of a Julian date, ~1e-6 sigma
  // per point), BIC (statsmodels definition) to 1e-5. "EXOTIC": its own fits of raw Julian dates by pseudo-inverse, which
  // stop short of the minimum by up to 1e-4 of chi2 (so mine is never above it): chi2 to 2e-4 relative, BIC to 0.01.
  const dchi = mine.map((m, i) => (m ? Math.abs(m.chi2 - G[i].chi2) / G[i].chi2 : NaN)), dbic = mine.map((m, i) => (m ? Math.abs(bicScaled(m.chi2, n, m.k, S) - G[i].bic) : NaN));
  const xchi = mine.map((m, i) => (m ? (m.chi2 - F[i].chi2) / F[i].chi2 : NaN)), xbic = mine.map((m, i) => (m ? Math.abs(bicScaled(m.chi2, n, m.k, S) - F[i].bic) : NaN));
  check(`${tag}: chi2 and BIC of the linear and 1-sinusoid fits`, dchi[0] < 1e-7 && dchi[1] < 1e-7 && dbic[0] < 1e-5 && dbic[1] < 1e-5 && Math.abs(xchi[0]) < 2e-4 && Math.abs(xchi[1]) < 2e-4 && xchi[1] < 1e-7 && xbic[0] < 0.01 && xbic[1] < 0.01,
    `chi2 ${lin.chi2.toFixed(3)}, ${f1.chi2.toFixed(3)} (centred reference: ${ex(dchi[0])}, ${ex(dchi[1])} relative; EXOTIC: ${ex(xchi[0])}, ${ex(xchi[1])}); BIC ${F[0].bic.toFixed(2)}, ${F[1].bic.toFixed(2)} (centred: ${ex(dbic[0])}, ${ex(dbic[1])}; EXOTIC: ${ex(xbic[0])}, ${ex(xbic[1])})`);
  const da = Math.abs(f1.terms[0].amp / e.amp1 - 1), ds = Math.abs(f1.terms[0].sinErr / F[1].bse_unscaled[2] - 1);
  check(`${tag}: amplitude of the first sinusoid and the error of its sine coefficient`, da < 1e-5 && ds < 1e-5, `${(f1.terms[0].amp * min).toFixed(3)} min at ${e.periods[0].toFixed(2)} epochs (relative difference ${ex(da)}; error ${ex(ds)})`);
  if (e.name.includes('decay')) {
    // EXOTIC's two periods here are 3x and 2x the time span (the edges of its two grids): the sinusoids are nearly
    // degenerate with each other and with the line. Its own fit has amplitudes of 0.15 d cancelling to the 1e-3 d level.
    // Only chi2 is meaningful, and only loosely.
    check(`${tag}: 2-sinusoid fit (degenerate periods ${e.periods.map((v) => v.toFixed(0)).join(', ')} epochs over a ${Math.max(...E) - Math.min(...E)}-epoch span)`, !f2 || dchi[2] < 1e-6,
      f2 ? `chi2 ${f2.chi2.toFixed(2)} vs ${F[2].chi2.toFixed(2)}; EXOTIC amplitudes ${e.amp2.map((v) => v.toFixed(3)).join(', ')} d` : 'refused as degenerate');
  } else {
    const da2 = Math.max(Math.abs(f2.terms[0].amp / e.amp2[0] - 1), Math.abs(f2.terms[1].amp / e.amp2[1] - 1));
    check(`${tag}: 2-sinusoid fit, chi2, BIC and amplitudes`, dchi[2] < 1e-7 && dbic[2] < 1e-5 && Math.abs(xchi[2]) < 2e-4 && xbic[2] < 0.01 && da2 < 1e-4, `chi2 ${f2.chi2.toFixed(3)} (centred ${ex(dchi[2])}, EXOTIC ${ex(xchi[2])}); BIC ${F[2].bic.toFixed(2)} (${ex(dbic[2])}, ${ex(xbic[2])}); amplitudes ${(f2.terms[0].amp * min).toFixed(3)}, ${(f2.terms[1].amp * min).toFixed(3)} min (${ex(da2)})`);
  }
  // the whole sequence with EXOTIC's grid (periods 3 epochs to 3 spans, 5 samples per peak) and its parameter count
  const span = Math.max(...E) - Math.min(...E);
  const r = timingPeriodogram(E, T, S, { minPeriod: e.minPeriod, maxPeriod: 3 * span, oversample: 5, refine: false, countPeriods: false });
  const pk = r.periodograms[0].peaks[0], df = 1 / (5 * span);
  // my peak is refined between grid points of the exact periodogram, EXOTIC takes the grid maximum of the approximate
  // one: within one grid step in frequency, and at least as high less the approximation error. The false-alarm
  // probability of EXOTIC's peak power for the frequency range actually searched, astropy baluev: 1% (astropy rounds
  // the maximum frequency onto its default grid, a change of up to 1/(10 span) in fmax, to which the FAP is proportional)
  const dfap = Math.abs(Math.log(falseAlarmProbability(e.peakPower, { t: E, dy: S, fmax: e.fmaxSearched }) / e.peakFapBaluev));
  check(`${tag}: sequence finds EXOTIC's first period`, Math.abs(1 / pk.period - 1 / e.periods[0]) <= df * 1.001 && pk.power >= e.peakPower - e.fastMinusExact && dfap < 0.01,
    `${pk.period.toFixed(3)} vs ${e.periods[0].toFixed(3)} epochs; power ${pk.power.toFixed(4)} vs ${e.peakPower.toFixed(4)}; FAP ${ex(pk.fap)} (astropy ${ex(e.peakFapBaluev)} at EXOTIC's power)`);
  if (!e.name.includes('decay')) {
    // BIC difference in the statsmodels convention, 1 sinusoid minus linear, with the period then refined in the joint
    // fit (the periodogram of residuals peaks at a slightly different period than the joint fit prefers): never worse
    // than EXOTIC's at its grid period, and not far from it. EXOTIC's own number is reproduced to 0.01 above.
    const rr = timingPeriodogram(E, T, S, { minPeriod: e.minPeriod, maxPeriod: 3 * span, oversample: 5, countPeriods: false });
    const d1 = rr.models[1].bicScaled - rr.models[0].bicScaled, e1 = F[1].bic - F[0].bic;
    const g1 = G[1].bic - G[0].bic;
    check(`${tag}: sequence reproduces EXOTIC's BIC gain for one sinusoid`, d1 <= g1 + 1e-6 && d1 > g1 - 10 && Math.abs(g1 - e1) < 0.01, `${d1.toFixed(2)} at ${rr.models[1].terms[0].period.toFixed(3)} epochs vs ${e1.toFixed(2)} at ${e.periods[0].toFixed(3)} (unrefined, at the periodogram peak ${pk.period.toFixed(3)}: ${(r.models[1].bicScaled - r.models[0].bicScaled).toFixed(2)})`);
  }
}

// --- the bundled example file holds the 40 times of fit_ephemeris.py, and the default sequence finds the signal in it
{
  const all = ref.exotic.find((e) => e.name.includes('all 40'));
  const rows = parseTimings(readFileSync(new URL('../public/examples/ephemeris/transit_times.csv', import.meta.url), 'utf8').split('\n').map((l) => l.split(',').slice(0, 2).join(',')).join('\n')).rows;
  const sorted = all.times.map((t, i) => [t, all.errs[i]]).sort((a, b) => a[0] - b[0]);
  check('public/examples/ephemeris/transit_times.csv is the fit_ephemeris.py data', rows.length === 40 && rows.every((r, i) => r.t === sorted[i][0] && r.e === sorted[i][1]));
  const T = rows.map((r) => r.t), S = rows.map((r) => r.e), E = assignEpochs(T, 2.7962868, T[0]).epochs;
  const r = timingPeriodogram(E, T, S), t = r.models[1].terms[0];
  check('default sequence on the bundled example: one significant sinusoid near 20.5 epochs', r.significant && r.best >= 1 && Math.abs(t.period - 20.5) < 0.05 && r.grid.lattice === 1 && r.grid.nyquistPeriod === 2,
    `P ${t.period.toFixed(3)} ± ${t.periodErr.toFixed(3)} epochs (${t.periodDays.toFixed(2)} d), amplitude ${(t.amp * min).toFixed(2)} ± ${(t.ampErr * min).toFixed(2)} min, FAP ${ex(r.periodograms[0].peaks[0].fap)}, dBIC ${r.deltaBic.map((v) => v.toFixed(1)).join(', ')}; best ${r.models[r.best].key} (scaled BIC: ${r.models[r.bestScaled].key})`);
  console.log('     verdict: ' + r.verdict); for (const s of r.notes) console.log('     note: ' + s);
  const c = r.curve(1, 50);
  check('curve() has the shape renderOC takes', c.E.length === 50 && c.y.length === 50 && c.lo.every((v, i) => v <= c.y[i] && c.hi[i] >= c.y[i]) && Math.max(...c.y) < 1.3 * t.amp && r.curve(0, 10).y.every((v) => Math.abs(v) < 1e-9));
}

// --- noise-free injection at Julian-date magnitudes: everything recovered to rounding
{
  const t0 = 2459000.123456, per = 3.52474859, P1 = 61.3, A1 = 2.0 / min, ph1 = 0.7, P2 = 17.9, A2 = 0.8 / min, ph2 = -2.1;
  const rng = makeRng(11), E = [...new Set(Array.from({ length: 70 }, () => rng.int(700)))].sort((a, b) => a - b);
  const T = E.map((e) => t0 + per * e + A1 * Math.sin((2 * Math.PI * e) / P1 + ph1) + A2 * Math.sin((2 * Math.PI * e) / P2 + ph2)), S = E.map(() => 5e-4);
  const r = timingPeriodogram(E, T, S), m = r.models[2], a = m.terms[0], b = m.terms[1];
  const dph = (x, y) => Math.abs(((x - y + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  // tolerances: times are float64 Julian dates (resolution 4.7e-10 d = 3e-7 of the smaller amplitude)
  check('noise-free two-period signal recovered at Julian-date magnitudes', m.refined && Math.abs(a.period - P1) < 1e-4 && Math.abs(b.period - P2) < 1e-4 && Math.abs(a.amp / A1 - 1) < 1e-5 && Math.abs(b.amp / A2 - 1) < 1e-5 && dph(a.phase, ph1) < 1e-4 && dph(b.phase, ph2) < 1e-4 && Math.abs(m.per - per) < 1e-10 && Math.abs(m.t0 - t0) < 5e-9 && m.chi2 < 1e-6,
    `${E.length} epochs; dP ${ex(a.period - P1)}, ${ex(b.period - P2)} epochs; amplitude ${ex(a.amp / A1 - 1)}, ${ex(b.amp / A2 - 1)}; phase ${ex(dph(a.phase, ph1))}, ${ex(dph(b.phase, ph2))} rad; orbital period ${ex(m.per - per)} d; chi2 ${ex(m.chi2)}`);
  check('and the verdict prefers two sinusoids', r.best === 2 && r.significant && r.significant2 && r.recommended === 2 && r.periodograms[1].peaks[0].fap < 0.01);
  // quadratic baseline: a period change plus a sinusoid
  const dPdE = -3e-9, Tq = E.map((e) => t0 + per * e + 0.5 * dPdE * e * e + A1 * Math.sin((2 * Math.PI * e) / P1 + ph1));
  const q = timingPeriodogram(E, Tq, S, { order: 2 }), mq = q.models[1];
  check('sinusoid on a quadratic ephemeris', Math.abs(mq.terms[0].period - P1) < 1e-4 && Math.abs(mq.dPdE / dPdE - 1) < 1e-4 && Math.abs(mq.terms[0].amp / A1 - 1) < 1e-5, `dP/dE ${mq.dPdE.toExponential(4)} vs ${dPdE.toExponential(4)}`);
}

// --- injected timing variations in sparse, noisy data: recovery, and coverage of the reported errors
{
  // 30 transits picked from 500 orbits of a 3.5-day planet, errors 30-90 s, a 47.3-epoch (166 d) sinusoid
  const per = 3.52474859, t0 = 2458500.5, Ptrue = 47.3, N = 30, R = 300;
  console.log('     injected sinusoid, 30 of 500 epochs, errors 30-90 s, period 47.3 epochs; 300 realisations each:');
  for (const [ampMin, wantDet] of [[1, null], [2, 0.8], [3, 0.97], [5, 0.99]]) {
    const rng = makeRng(100 + ampMin); let det = 0, right = 0, sa = 0, sp = 0, sph = 0, nr = 0, bicWin = 0, bias = 0, two = 0, bic2 = 0, rec1 = 0;
    for (let k = 0; k < R; k++) {
      const E = [...new Set(Array.from({ length: 2 * N }, () => rng.int(500)))].slice(0, N).sort((a, b) => a - b), ph = 2 * Math.PI * rng.next() - Math.PI;
      const S = E.map(() => (30 + 60 * rng.next()) / 86400), T = E.map((e, i) => t0 + per * e + (ampMin / min) * Math.sin((2 * Math.PI * e) / Ptrue + ph) + S[i] * rng.normal());
      const r = timingPeriodogram(E, T, S), m = r.models[1]; if (!m) continue;
      const t = m.terms[0], good = Math.abs(1 / t.period - 1 / Ptrue) < 1 / r.grid.span;   // on the true peak, not an alias or a noise peak
      if (r.significant) det++; if (r.best >= 1) bicWin++; if (r.significant2) two++; if (r.best === 2) bic2++; if (r.recommended === 1) rec1++;
      if (good) { right++; if (m.refined) { nr++; sa += ((t.amp - ampMin / min) / t.ampErr) ** 2; bias += (t.amp - ampMin / min) / t.ampErr; sp += ((t.period - Ptrue) / t.periodErr) ** 2; const d = ((t.phase - ph + 3 * Math.PI) % (2 * Math.PI)) - Math.PI; sph += (d / t.phaseErr) ** 2; } }
    }
    const ra = Math.sqrt(sa / nr), rp = Math.sqrt(sp / nr), rph = Math.sqrt(sph / nr);
    const info = `FAP < 1% in ${((100 * det) / R).toFixed(0)}%, BIC prefers a sinusoid in ${((100 * bicWin) / R).toFixed(0)}%, right peak in ${((100 * right) / R).toFixed(0)}%; a second sinusoid (none was injected): significant in ${((100 * two) / R).toFixed(1)}%, preferred by BIC in ${((100 * bic2) / R).toFixed(0)}%; recommended model is one sinusoid in ${((100 * rec1) / R).toFixed(0)}%; pull rms on the right peak: amplitude ${ra.toFixed(2)} (mean ${(bias / nr).toFixed(2)}), period ${rp.toFixed(2)}, phase ${rph.toFixed(2)}`;
    // Detection: a 1-minute signal equals the error bars and is mostly not detectable (no requirement); from 2 minutes
    // (S/N per point ~2) it must usually be, from 3 minutes nearly always. Pulls: linearised errors are good to ~15%
    // once the amplitude is several sigma; binomial/chi noise on 300 realisations is ~5%.
    if (wantDet === null) check(`amplitude ${ampMin} min: (reported, not required)`, true, info);
    // a second sinusoid was not injected: its peak may pass the 1% test in at most 1% + 3 sigma of counting noise (2.7% of 300)
    else check(`amplitude ${ampMin} min: detected and measured`, det / R >= wantDet && right / R >= wantDet && two / R < 0.027 && rec1 / R >= wantDet - 0.03 && (ampMin < 3 || (Math.abs(ra - 1) < 0.15 && Math.abs(rp - 1) < 0.2 && Math.abs(rph - 1) < 0.2)), info);
  }
}

// --- false alarms on pure noise
{
  // (a) the statistic itself: Gaussian noise about a constant, uneven sampling, unequal errors, no ephemeris removed.
  const rng = makeRng(5), N = 40, R = 2000, t = Array.from({ length: N }, () => 300 * rng.next()).sort((a, b) => a - b), dy = t.map(() => 0.5 + rng.next());
  const fr = frequencyGrid(t, { samplesPerPeak: 8, nyquistFactor: 2 }), ctx = { t, dy, fmax: fr[fr.length - 1] };
  const count = { 0.1: 0, 0.01: 0 }, zs = [];
  for (let k = 0; k < R; k++) { const z = maxOf(lombScargle(t, dy.map((s) => s * rng.normal()), dy, fr)); zs.push(z); const f = falseAlarmProbability(z, ctx); if (f < 0.1) count[0.1]++; if (f < 0.01) count[0.01]++; }
  // Baluev's formula is an upper limit on the probability, so the observed rate must not exceed the stated level
  // beyond counting noise (3 sigma binomial: 0.1 -> +0.020, 0.01 -> +0.007 for 2000 trials), and for it to be useful
  // it should not be more than a factor ~2 conservative at the 10% level.
  const r10 = count[0.1] / R, r1 = count[0.01] / R;
  check('Baluev false-alarm probability on white noise (2000 realisations)', r10 < 0.12 && r10 > 0.05 && r1 < 0.017, `rate of FAP < 10%: ${(100 * r10).toFixed(1)}%; FAP < 1%: ${(100 * r1).toFixed(2)}%`);
  // bootstrap levels from ONE noise realisation against the true distribution of the maximum over the 2000
  zs.sort((a, b) => a - b); const y = dy.map((s) => s * rng.normal()), b = bootstrapFalseAlarm(t, y, dy, fr, { n: 1000, seed: 3 });
  const true10 = zs[Math.floor(0.9 * R)], true1 = zs[Math.floor(0.99 * R)];
  // a bootstrap of 40 points reproduces the 10% level to a few per cent and the 1% level to ~10% (1000 resamples: 10 in the tail)
  check('bootstrap false-alarm levels on white noise', Math.abs(b.level(0.1) / true10 - 1) < 0.08 && Math.abs(b.level(0.01) / true1 - 1) < 0.12 && Math.abs(b.fap(true10) - 0.1) < 0.05,
    `10% level ${b.level(0.1).toFixed(3)} (Monte Carlo ${true10.toFixed(3)}, Baluev ${falseAlarmLevel(0.1, ctx).toFixed(3)}); 1% level ${b.level(0.01).toFixed(3)} (${true1.toFixed(3)}, Baluev ${falseAlarmLevel(0.01, ctx).toFixed(3)})`);

  // (b) the whole sequence on timing data with no signal: 30 of 500 epochs, errors 30-90 s, default grid to the Nyquist limit
  const R2 = 1000, c2 = { 0.1: 0, 0.01: 0 }; let bic1 = 0, bic1e = 0, sig = 0, both = 0;
  for (let k = 0; k < R2; k++) {
    const E = [...new Set(Array.from({ length: 60 }, () => rng.int(500)))].slice(0, 30).sort((a, b) => a - b), S = E.map(() => (30 + 60 * rng.next()) / 86400);
    const T = E.map((e, i) => 2458500.5 + 3.52474859 * e + S[i] * rng.normal());
    const r = timingPeriodogram(E, T, S), f = r.periodograms[0].peaks[0].fap;
    if (f < 0.1) c2[0.1]++; if (f < 0.01) c2[0.01]++; if (r.best >= 1) bic1++; if (r.significant) sig++; if (r.recommended >= 1) both++;
    const e = timingPeriodogram(E, T, S, { countPeriods: false, refine: false }); if (e.best >= 1) bic1e++;
  }
  const q10 = c2[0.1] / R2, q1 = c2[0.01] / R2;
  // same requirement: not above the stated level beyond 3 sigma of counting noise (0.1 -> 0.128, 0.01 -> 0.019 for 1000).
  // Removing the fitted ephemeris takes two degrees of freedom out of the residuals, so the rate may sit below the level.
  check('sequence on signal-free timing data: false-alarm rate (1000 realisations)', q10 < 0.128 && q10 > 0.03 && q1 < 0.019, `FAP < 10% in ${(100 * q10).toFixed(1)}%; FAP < 1% in ${(100 * q1).toFixed(2)}%`);
  // the BIC alone is a much weaker guard, because it does not know the period was searched for
  check('BIC on signal-free data: the recommended model needs both tests', both <= sig && both / R2 < 0.019, `BIC prefers a sinusoid in ${((100 * bic1) / R2).toFixed(1)}% of noise-only sets counting the period as a parameter, ${((100 * bic1e) / R2).toFixed(1)}% with EXOTIC's count; the recommended model (both tests) has a sinusoid in ${((100 * both) / R2).toFixed(2)}%`);
}

// --- where the analytic probability fails and the bootstrap does not: very unequal error bars that are too small
{
  // The 40 error bars of the bundled example span 13-85 s, so 12 transits' worth of weight carries the fit. Signal-free
  // times are drawn with (a) exactly those errors, (b) an extra 45 s of scatter the error bars do not know about.
  const all = ref.exotic.find((e) => e.name.includes('all 40')), E = all.epochs, S = all.errs, rng = makeRng(21), R = 80;
  const g = timingFrequencyGrid(E, { oversample: 5, minPeriod: 3 }), ctx = { t: E, dy: S, fmax: g.freqs[g.freqs.length - 1] }, out = [];
  for (const jit of [0, 45 / 86400]) {
    let a = 0, b = 0;
    for (let k = 0; k < R; k++) {
      const T = E.map((e, i) => 2459000 + 2.7962868 * e + Math.hypot(S[i], jit) * rng.normal()), lin = fitEphemeris(E, T, S, 1), res = E.map((_, i) => lin.residual(i));
      const z = maxOf(lombScargle(E, res, S, g.freqs));
      if (falseAlarmProbability(z, ctx) < 0.1) a++; if (bootstrapFalseAlarm(E, res, S, g.freqs, { n: 100, seed: k + 1 }).fap(z) < 0.1) b++;
    }
    out.push([a / R, b / R]);
  }
  // 80 trials at a true rate of 10% scatter by 3.4%: "at or below the level" means below 0.2; "fails" means above 0.3
  check('correct but very unequal errors: both tests hold their level', out[0][0] < 0.2 && out[0][1] < 0.2, `FAP < 10% in ${(100 * out[0][0]).toFixed(0)}% (Baluev), ${(100 * out[0][1]).toFixed(0)}% (bootstrap) of 80 signal-free sets`);
  check('45 s of unmodelled scatter: Baluev raises false alarms, the bootstrap does not', out[1][0] > 0.3 && out[1][1] < 0.2, `FAP < 10% in ${(100 * out[1][0]).toFixed(0)}% (Baluev), ${(100 * out[1][1]).toFixed(0)}% (bootstrap)`);
}

// --- grid and degenerate inputs
{
  const g = timingFrequencyGrid([0, 4, 10, 22, 40, 64]);
  check('epoch lattice and Nyquist period', g.lattice === 2 && g.nyquistPeriod === 4 && g.freqs[g.freqs.length - 1] < 0.25 && g.freqs[0] === 1 / 128 && Math.abs(g.df - 1 / 640) < 1e-15, `lattice ${g.lattice}, periods ${g.minPeriod} to ${g.maxPeriod} epochs, ${g.freqs.length} frequencies`);
  // aliasing on the lattice: a period of 1/(1 - 1/p) epochs gives the same samples as p
  const E = Array.from({ length: 40 }, (_, i) => 3 * i + (i % 5)), y1 = E.map((e) => Math.sin((2 * Math.PI * e) / 7.7)), pa = 1 / (1 - 1 / 7.7), y2 = E.map((e) => -Math.sin((2 * Math.PI * e) / pa));
  check('alias across the Nyquist limit gives identical samples', Math.max(...y1.map((v, i) => Math.abs(v - y2[i]))) < 1e-9, `7.7 and ${pa.toFixed(4)} epochs`);
  // exactly at the Nyquist frequency the sine column vanishes; the power must stay finite and in [0, 1]
  const pn = lombScargle(E, y1, null, [0.5, 1.0]);
  check('degenerate frequencies do not produce NaN', pn.every((v) => v >= 0 && v <= 1));
  let threw = 0;
  for (const f of [() => fitSinusoids(E, y1, null, [10, 10], {}), () => timingPeriodogram([0, 1, 2], [0, 1, 2], [1, 1, 1]), () => lombScargle([0, 1, 2], [1, 2, 3], [1, 0, 1], [0.1]), () => timingFrequencyGrid([5, 5, 5])]) { try { f(); } catch (e) { threw++; } }
  check('bad input is refused with an error', threw === 4, `${threw} of 4`);
}

process.exit(ok ? 0 : 1);
