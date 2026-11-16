// Detrending diagnostics (src/core/psd.js) against independent references made by test/make_psd_reference.py:
// scipy.signal.periodogram and welch, astropy's LombScargle, scipy.optimize.least_squares for the red-noise fit,
// MC3's mc3.stats.time_avg for the rms-versus-bin-size curve, scipy.stats.binned_statistic_2d for the pixel map
// and numpy.linalg.lstsq for the polynomial surface; analytic values for the noise formulae; and a synthetic
// K2-like series with a known intrapixel sensitivity that the map, the surfaces, the PSD and beta must recover.
import { readFileSync } from 'node:fs';
import { fft, periodogramPsd, welchPsd, lombScarglePsd, splitSegments, whiteNoiseLevel, photonNoiseLevel, photonNoise, scintillation, logBinPsd, fitRedNoise, digamma, trigamma, rmsVsBin, percentile, pixelMap, polySurface, polyTerms, surfaceOnGrid, gpSurface, syntheticRollSeries } from '../src/core/psd.js';
import { makeRng } from '../src/core/stats.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./psd_reference.json', import.meta.url)));
const ex = (v) => v.toExponential(1), T0 = performance.now();
console.log(`reference: numpy ${ref.versions.numpy}, scipy ${ref.versions.scipy}, astropy ${ref.versions.astropy}, mc3 ${ref.versions.mc3}`);

// the generator shared with make_psd_reference.py (32-bit LCG; sums of four uniforms)
function lcg(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
  return { u, g: () => ((u() + u()) + u()) + u() - 2.0 };
}
const series = (n, seed, trend = 0.001, amp = 0.3, per = 17.3) => { const r = lcg(seed); return Float64Array.from({ length: n }, (_, i) => r.g() + amp * Math.sin(2 * Math.PI * i / per) + trend * i); };
const ar1 = (n, seed, rho, off) => { const r = lcg(seed), v = new Float64Array(n); v[0] = r.g(); for (let i = 1; i < n; i++) v[i] = rho * v[i - 1] + r.g(); return v.map((a) => a + off); };
const relMax = (a, b) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i]) / Math.abs(b[i])); return w; };

// --- FFT: against the O(n^2) sum, for a power of two, a composite and a prime length
{
  let w = 0;
  for (const n of [1, 2, 8, 12, 31, 100, 127]) {
    const r = lcg(n), re = Float64Array.from({ length: n }, () => r.g()), im = Float64Array.from({ length: n }, () => r.g()), a = re.slice(), b = im.slice(); fft(a, b);
    let nrm = 0; for (let j = 0; j < n; j++) nrm += re[j] * re[j] + im[j] * im[j]; nrm = Math.sqrt(nrm);
    for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let j = 0; j < n; j++) { const ph = -2 * Math.PI * ((j * k) % n) / n, c = Math.cos(ph), s = Math.sin(ph); sr += re[j] * c - im[j] * s; si += re[j] * s + im[j] * c; } w = Math.max(w, Math.hypot(a[k] - sr, b[k] - si) / nrm); }
  }
  check('FFT (radix-2 and Bluestein) against the direct sum', w < 1e-14, `largest error ${ex(w)} of the input's norm, n = 1 .. 127; tolerance 1e-14`);
}

// --- periodogram against scipy.signal.periodogram
{
  const P = ref.periodogram; let wAbs = 0, wRel = 0, wSum = 0, wF = 0, wPars = 0, nOrd = 0; const big = [];
  for (const c of P.cases) {
    const y = series(c.n, c.seed), r = periodogramPsd(y, P.dt, { detrend: c.detrend, window: c.window });
    let sum = 0; for (const v of r.p) sum += v;
    wSum = Math.max(wSum, Math.abs(sum / c.sum - 1));
    c.idx.forEach((k, j) => {
      nOrd++; wF = Math.max(wF, Math.abs(r.f[k] - c.f[j]) / (c.f[j] || 1)); wAbs = Math.max(wAbs, Math.abs(r.p[k] - c.p[j]) / c.max);
      if (c.p[j] > 1e-6 * c.max) wRel = Math.max(wRel, Math.abs(r.p[k] / c.p[j] - 1));
    });
    if (c.detrend === 'constant' && c.window === 'boxcar') wPars = Math.max(wPars, Math.abs(sum * r.df / c.var - 1));
    if (c.n >= 1000) big.push(c.n);
  }
  check('periodogramPsd matches scipy.signal.periodogram', wAbs < 1e-13 && wRel < 1e-10 && wSum < 1e-13 && wF < 1e-14,
    `${P.cases.length} cases (n = 64, 75, 97 with every detrend x window; ${[...new Set(big)].join(', ')} with two), ${nOrd} ordinates: largest difference ${ex(wAbs)} of the highest peak (tolerance 1e-13), ${ex(wRel)} relative for ordinates above 1e-6 of the peak (1e-10), sum of all ordinates ${ex(wSum)} (1e-13), frequencies ${ex(wF)}`);
  check('Parseval: sum(P) df = variance (boxcar, mean removed)', wPars < 1e-13, `largest relative difference ${ex(wPars)}; tolerance 1e-13`);
}

// --- Welch against scipy.signal.welch
{
  const Wc = ref.welch; const line = []; let worst = 0;
  for (const c of Wc.cases) {
    const y = series(c.n, c.seed), r = welchPsd(y, Wc.dt, c.opts), top = Math.max(...c.p);
    let w = r.p.length === c.p.length ? 0 : 1; for (let k = 0; k < c.p.length && w < 1; k++) w = Math.max(w, Math.abs(r.p[k] - c.p[k]) / top, Math.abs(r.f[k] - c.f[k]) / (c.f[k] || 1));
    if (c.nWindows != null && r.nWindows !== c.nWindows) w = 1;
    worst = Math.max(worst, w); line.push(`${JSON.stringify(c.opts).replace(/"/g, '').slice(0, 48)}${c.n === 100 ? ' (n = 100)' : ''}: ${ex(w)} (${r.nWindows} windows)`);
  }
  check('welchPsd matches scipy.signal.welch (mean, median, n < nperseg, windows inside gap-free segments)', worst < 1e-13, line.join('; ') + '; differences relative to the highest value, tolerance 1e-13');
}

// --- Lomb-Scargle density
{
  const L = ref.lombscargle, r = lcg(L.seed), n = L.n, t = new Float64Array(n), y = new Float64Array(n), dy = new Float64Array(n);
  let acc = 0; for (let i = 0; i < n; i++) { acc += (0.5 + r.u()) * 0.01; t[i] = acc; }
  for (let i = 0; i < n; i++) y[i] = r.g() + 0.4 * Math.sin(2 * Math.PI * 7.0 * t[i]);
  for (let i = 0; i < n; i++) dy[i] = 0.5 + r.u();
  const a = lombScarglePsd(t, y, L.freqs), b = lombScarglePsd(t, y, L.freqs, { dy }); let sw = 0; for (const e of dy) sw += 1 / (e * e);
  const top = Math.max(...L.astropy_psd), topw = Math.max(...L.astropy_psd_weighted); let w1 = 0, w2 = 0, w3 = 0;
  for (let k = 0; k < L.freqs.length; k++) {
    w1 = Math.max(w1, Math.abs(a.p[k] - 2 * a.dt * L.astropy_psd[k]) / (2 * a.dt * top));
    w2 = Math.max(w2, Math.abs(b.p[k] - 2 * b.dt * (n / sw) * L.astropy_psd_weighted[k]) / (2 * b.dt * (n / sw) * topw));
    w3 = Math.max(w3, Math.abs(a.p[k] - L.direct_density[k]) / (2 * a.dt * top));
  }
  check('lombScarglePsd = 2 dt (n / sum w) x astropy LombScargle(normalization = "psd")', w1 < 1e-13 && w2 < 1e-13 && Math.abs(a.dt / L.dt_mean - 1) < 1e-14,
    `${n} unevenly spaced points, ${L.freqs.length} frequencies: without error bars ${ex(w1)}, with error bars ${ex(w2)} of the highest peak; tolerance 1e-13`);
  check('lombScarglePsd matches a direct sinusoid fit turned into a density (numpy lstsq)', w3 < 1e-13, `largest difference ${ex(w3)} of the highest peak; tolerance 1e-13`);
  // evenly sampled: identical to the periodogram at the Fourier frequencies strictly inside (0, Nyquist)
  let w4 = 0, cnt = 0;
  for (const m of [200, 201]) {
    const ye = series(m, 50 + m, 0, 0.3), te = Float64Array.from({ length: m }, (_, i) => 3 + i * 0.02), pp = periodogramPsd(ye, 0.02), ls = lombScarglePsd(te, ye), top2 = Math.max(...pp.p);
    for (let k = 0; k < ls.f.length; k++) { cnt++; w4 = Math.max(w4, Math.abs(ls.p[k] - pp.p[k + 1]) / top2, Math.abs(ls.f[k] / pp.f[k + 1] - 1)); }
  }
  check('lombScarglePsd equals periodogramPsd on evenly sampled data', w4 < 1e-12, `${cnt} Fourier frequencies of n = 200 and 201: largest difference ${ex(w4)} of the highest peak; tolerance 1e-12`);
  // white noise, uneven sampling: the mean level is 2 sigma^2 dt (statistical: each ordinate is exponential)
  const rng = makeRng(5), m = 400, sig = 0.002, tw = new Float64Array(m), yw = new Float64Array(m); let tt = 0;
  for (let i = 0; i < m; i++) { tt += 0.0007 * (0.4 + 1.2 * rng.next()); tw[i] = tt; yw[i] = sig * rng.normal(); }
  const lw = lombScarglePsd(tw, yw), lvl = whiteNoiseLevel(sig, lw.dt); let mean = 0; for (const v of lw.p) mean += v / lw.p.length;
  const tol = 3 / Math.sqrt(lw.p.length);
  check('white noise on uneven sampling sits at 2 sigma^2 dt', Math.abs(mean / lvl - 1) < tol, `mean of ${lw.p.length} ordinates / expected = ${(mean / lvl).toFixed(3)}; tolerance 3 / sqrt(${lw.p.length}) = ${tol.toFixed(2)} (3 standard errors of the mean of exponential variates)`);
}

// --- noise levels: analytic
{
  const e = [1e-3, 2e-3, 3e-3], lv = whiteNoiseLevel(e, 0.5), want = 2 * ((1e-6 + 4e-6 + 9e-6) / 3) * 0.5;
  check('whiteNoiseLevel = 2 mean(err^2) dt', Math.abs(lv / want - 1) < 1e-15 && whiteNoiseLevel(2e-3, 0.25) === 2 * 4e-6 * 0.25 && photonNoiseLevel(1e-3, 2) === 4e-6, `${lv.toExponential(6)} against ${want.toExponential(6)}`);
  // white noise of known sigma: periodogram mean level
  const rng = makeRng(3), n = 8192, sig = 5e-4, dt = 1 / 720, y = Float64Array.from({ length: n }, () => sig * rng.normal()), pp = periodogramPsd(y, dt); let mean = 0; for (let k = 1; k < pp.p.length - 1; k++) mean += pp.p[k] / (pp.p.length - 2);
  const tol = 3 / Math.sqrt(pp.p.length - 2);
  check('white noise in periodogramPsd sits at whiteNoiseLevel', Math.abs(mean / whiteNoiseLevel(sig, dt) - 1) < tol, `mean of ${pp.p.length - 2} ordinates / (2 sigma^2 dt) = ${(mean / whiteNoiseLevel(sig, dt)).toFixed(4)}; tolerance ${tol.toFixed(3)} (3 standard errors)`);
  // CCD equation by hand: S = 2 * 50000 = 1e5 e-; per pixel 2 * 100 + 5 + 10^2 = 305 e-; npix = 50, nsky = 200: 50 * 1.25 * 305 = 19062.5
  const p = photonNoise({ flux: 50000, sky: 100, npix: 50, nsky: 200, gain: 2, readNoise: 10, dark: 5 }), v = 1e5 + 19062.5;
  const src = photonNoise({ flux: 10000, gain: 1 });
  const sc = scintillation({ D: 100, airmass: 1.5, exptime: 30, altitude: 2400 }), scWant = 0.09 * Math.pow(100, -2 / 3) * Math.pow(1.5, 1.75) / Math.sqrt(60) * Math.exp(-0.3);
  const ps = photonNoise({ flux: 50000, sky: 100, npix: 50, nsky: 200, gain: 2, readNoise: 10, dark: 5, scint: { D: 100, airmass: 1.5, exptime: 30, altitude: 2400 } });
  const pd = photonNoise({ flux: 50000, npix: 10, gain: 2, digit: true }), arr = photonNoise({ flux: [50000, 10000], sky: [100, 100], npix: 50, nsky: 200, gain: 2, readNoise: 10, dark: 5 });
  const errs = [Math.abs(p.sigma / Math.sqrt(v) - 1), Math.abs(p.rel * 1e5 / Math.sqrt(v) - 1), Math.abs(p.sigmaAdu * 2 / Math.sqrt(v) - 1), Math.abs(p.snr * p.rel - 1), Math.abs(src.rel - 0.01), Math.abs(src.sigma - 100),
    Math.abs(sc / scWant - 1), Math.abs(ps.sigma / Math.sqrt(v + (scWant * 1e5) ** 2) - 1), Math.abs(pd.sigma / Math.sqrt(1e5 + 10 * 4 * 0.289 * 0.289) - 1), Math.abs(arr.sigma[0] / p.sigma - 1), Math.abs(arr.sigma[1] / Math.sqrt(2e4 + 19062.5) - 1)];
  check('photonNoise: CCD equation (Merline & Howell) with the sky-estimation term, scintillation, digitisation', Math.max(...errs) < 1e-14,
    `sigma = ${p.sigma.toFixed(3)} e- for S = 1e5 e- (hand value sqrt(119062.5) = ${Math.sqrt(v).toFixed(3)}), relative ${(1e6 * p.rel).toFixed(0)} ppm; source only 1/sqrt(1e4) = ${src.rel}; scintillation 1 m, X = 1.5, 30 s, 2400 m: ${(1e6 * sc).toFixed(0)} ppm; largest error ${ex(Math.max(...errs))}, tolerance 1e-14`);
  // without the sky term nsky -> infinity removes npix^2 / nsky exactly
  const q = photonNoise({ flux: 50000, sky: 100, npix: 50, gain: 2, readNoise: 10, dark: 5 });
  check('photonNoise: nsky = infinity drops the sky-estimation term', Math.abs(q.sigma - Math.sqrt(1e5 + 50 * 305)) < 1e-10, `${q.sigma.toFixed(4)} against ${Math.sqrt(1e5 + 15250).toFixed(4)}`);
}

// --- digamma, trigamma (used for the bias and weights of the log-space fit)
{
  const S = ref.special; let w1 = 0, w2 = 0;
  S.x.forEach((x, i) => { w1 = Math.max(w1, Math.abs(digamma(x) - S.digamma[i]) / Math.max(1, Math.abs(S.digamma[i]))); w2 = Math.max(w2, Math.abs(trigamma(x) / S.trigamma[i] - 1)); });
  check('digamma and trigamma against scipy.special', w1 < 1e-14 && w2 < 1e-13, `largest errors ${ex(w1)} and ${ex(w2)} for x = 0.3 .. 300; tolerances 1e-14 and 1e-13`);
}

// --- log binning and the red-noise fit, on a series synthesised in Python with spectrum W + A f^-gamma
{
  const R = ref.rednoise, y = Float64Array.from(R.y), pp = periodogramPsd(y, R.dt), tr = R.truth;
  const lb = logBinPsd(pp.f, pp.p, R.logbin.nbins);
  const same = lb.f.length === R.logbin.f.length && lb.n.every((v, i) => v === R.logbin.n[i]);
  check('logBinPsd matches the numpy implementation in the generator', same && relMax(lb.f, R.logbin.f) < 1e-13 && relMax(lb.p, R.logbin.p) < 1e-12, `${lb.f.length} bins, counts identical: ${same}; frequencies ${ex(same ? relMax(lb.f, R.logbin.f) : 1)}, power ${ex(same ? relMax(lb.p, R.logbin.p) : 1)}; tolerances 1e-13, 1e-12`);
  const t0 = performance.now(), fr = fitRedNoise(pp.f, pp.p), ms = performance.now() - t0, fb = fitRedNoise(lb.f, lb.p, { nAvg: lb.n });
  const d = (a, b) => Math.max(Math.abs(a.W / b.W - 1), Math.abs(a.A / b.A - 1), Math.abs(a.gamma / b.gamma - 1), Math.abs(a.knee / b.knee - 1));
  check('fitRedNoise matches scipy.optimize.least_squares on the same objective (raw periodogram)', d(fr, R.fit_raw) < 1e-7 && fr.cost <= R.fit_raw.cost * (1 + 1e-10),
    `W ${fr.W.toExponential(4)}, A ${fr.A.toExponential(4)}, gamma ${fr.gamma.toFixed(5)}, knee ${fr.knee.toFixed(4)} /day; largest relative difference ${ex(d(fr, R.fit_raw))}, tolerance 1e-7; cost ${fr.cost.toFixed(6)} against ${R.fit_raw.cost.toFixed(6)}; ${fr.n} ordinates, ${fr.iterations} iterations, ${ms.toFixed(1)} ms`);
  check('fitRedNoise matches scipy on the log-binned spectrum (weights from the bin counts)', d(fb, R.fit_binned) < 1e-7, `W ${fb.W.toExponential(4)}, gamma ${fb.gamma.toFixed(5)}, knee ${fb.knee.toFixed(4)}; largest relative difference ${ex(d(fb, R.fit_binned))}, tolerance 1e-7`);
  const z = [Math.log(fr.W / tr.W) / R.mc.std[0], (fr.gamma - tr.gamma) / R.mc.std[1], Math.log(fr.knee / tr.knee) / R.mc.std[2]];
  check('fitRedNoise recovers the injected spectrum', z.every((v) => Math.abs(v) < 3),
    `truth W ${tr.W.toExponential(3)} (= 2 sigma^2 dt for ${1e6 * tr.sigma} ppm), gamma ${tr.gamma}, knee ${tr.knee} /day; fit off by ${z.map((v) => v.toFixed(2)).join(', ')} standard deviations of the generator's ${R.mc.realisations} realisations (scatter ${(100 * R.mc.std[0]).toFixed(1)}% in W, ${R.mc.std[1].toFixed(3)} in gamma, ${(100 * R.mc.std[2]).toFixed(1)}% in the knee; mean bias ${(100 * R.mc.mean[0]).toFixed(2)}%, ${R.mc.mean[1].toFixed(4)}, ${(100 * R.mc.mean[2]).toFixed(2)}%); tolerance 3`);
  // white series: the power law must not be reported, and the flat level is 2 sigma^2 dt
  let falseRed = 0, wl = 0; const nW = 100;
  for (let seed = 1; seed <= nW; seed++) { const g = makeRng(seed), w = periodogramPsd(Float64Array.from({ length: 1000 }, () => g.normal()), 0.5), f = fitRedNoise(w.f, w.p); if (f.red) falseRed++; wl = Math.max(wl, Math.abs(f.whiteOnly - 1)); }
  check('fitRedNoise: red noise flagged on the red series and not on white ones', fr.red && fb.red && falseRed <= 4 && wl < 0.2,
    `red series: deltaCost ${fr.deltaCost.toFixed(0)} (threshold 9.21); ${nW} white series of 1000 points: ${falseRed} flagged red (nominal rate 1%; tolerance 4), flat level within ${(100 * wl).toFixed(1)}% of 2 sigma^2 dt in the worst case (tolerance 20% = 4.5 / sqrt(500))`);
  const plain = fitRedNoise(pp.f, pp.p, { correctBias: false });
  check('without the bias correction a raw-periodogram fit is low by exp(-0.5772)', Math.abs(plain.W / fr.W / Math.exp(digamma(1)) - 1) < 1e-6 && Math.abs(plain.gamma / fr.gamma - 1) < 1e-6, `W ratio ${(plain.W / fr.W).toFixed(6)} against ${Math.exp(digamma(1)).toFixed(6)}`);
}

// --- rms versus bin size against MC3
{
  const line = []; let worst = 0, worstErr = 0;
  for (const c of ref.timeavg) {
    const d = ar1(c.n, c.seed, c.rho, c.offset), o = {};
    if (c.opts.maxbins) o.maxBin = c.opts.maxbins; if (c.opts.binstep) o.binStep = c.opts.binstep; if (c.opts.binSizes) o.binSizes = c.opts.binSizes; if (c.opts.segments) o.segments = c.opts.segments;
    const r = rmsVsBin(d, o); let w = r.n.length === c.bins.length ? 0 : 1, we = 0;
    for (let j = 0; j < c.bins.length && w < 1; j++) {
      if (r.n[j] !== c.bins[j] || r.M[j] !== c.M[j]) { w = 1; break; }
      w = Math.max(w, Math.abs(r.rms[j] / c.rms[j] - 1), Math.abs(r.expected[j] / c.expected[j] - 1), Math.abs(r.betaAt(c.bins[j]) / (c.rms[j] / c.expected[j]) - 1));
      if (c.M[j] > 35) we = Math.max(we, Math.abs(r.rmsErr[j] / c.rmslo[j] - 1), Math.abs(r.rmsErr[j] / c.rmshi[j] - 1));
    }
    worst = Math.max(worst, w); worstErr = Math.max(worstErr, we);
    line.push(`n = ${c.n}${c.opts.segments ? ' with gaps' : ''}, ${c.bins.length} bin sizes: ${ex(w)}`);
  }
  check('rmsVsBin matches mc3.stats.time_avg (rms, expected, beta)', worst < 1e-12, line.join('; ') + '; tolerance 1e-12 (the gap case against the numpy re-implementation, which the generator asserts equal to MC3)');
  check('rmsVsBin error bar rms / sqrt(2M) matches MC3 where MC3 uses it (M > 35)', worstErr < 1e-12, `largest relative difference ${ex(worstErr)}; below M = 36 MC3 switches to an asymmetric inverse-gamma interval, not reproduced`);
  // segments from times, and the default sizes for a long series
  const t = Float64Array.from({ length: 1000 }, (_, i) => i * 0.02 + (i >= 310 ? 0.5 : 0) + (i >= 333 ? 1.3 : 0)), sg = splitSegments(t);
  const c = ref.timeavg[ref.timeavg.length - 1], viaT = rmsVsBin(ar1(c.n, c.seed, c.rho, c.offset), { t, binSizes: c.bins });
  check('splitSegments finds the gaps; rmsVsBin with times equals rmsVsBin with segments', JSON.stringify(sg.segments) === JSON.stringify(c.opts.segments) && Math.abs(sg.dt - 0.02) < 1e-12 && relMax(viaT.rms, c.rms) < 1e-12, `segments ${JSON.stringify(sg.segments)}`);
  const rng = makeRng(9), wn = Float64Array.from({ length: 20000 }, () => rng.normal()), t0 = performance.now(), rw = rmsVsBin(wn), ms = performance.now() - t0;
  const bm = rw.betaMax(1, 200);
  check('white noise: beta is 1 within its error; 20,000 points', Math.abs(rw.betaAt(10) - 1) < 3 / Math.sqrt(4000) && Math.abs(rw.betaAt(100) - 1) < 3 / Math.sqrt(400),
    `beta(10) = ${rw.betaAt(10).toFixed(3)} (tolerance 3 / sqrt(2M) = ${(3 / Math.sqrt(4000)).toFixed(3)}), beta(100) = ${rw.betaAt(100).toFixed(3)} (${(3 / Math.sqrt(400)).toFixed(2)}); the maximum over N <= 200 is ${bm.beta.toFixed(3)} at N = ${bm.n} (a maximum is biased high); ${rw.n.length} log-spaced sizes in ${ms.toFixed(0)} ms`);
}

// --- pixel map against scipy.stats.binned_statistic_2d; percentile against numpy
const PM = ref.pixelmap, pr = lcg(PM.seed), pn = PM.n, px = new Float64Array(pn), py = new Float64Array(pn), pres = new Float64Array(pn), pkeep = new Uint8Array(pn);
for (let i = 0; i < pn; i++) px[i] = 10.0 + 0.9 * pr.u() + 0.2 * pr.g();
for (let i = 0; i < pn; i++) py[i] = 20.0 + 0.5 * pr.u() + 0.1 * pr.g();
for (let i = 0; i < pn; i++) pres[i] = 0.004 * (px[i] - 10.4) - 0.01 * (px[i] - 10.4) ** 2 + 0.006 * (px[i] - 10.4) * (py[i] - 20.2) - 0.02 * (py[i] - 20.3) ** 2 + 0.008 * (py[i] - 20.2) ** 3 + 0.0005 * pr.g();
for (let i = 0; i < pn; i++) pkeep[i] = pr.u() < 0.8 ? 1 : 0;
{
  let wM = 0, wS = 0, wR = 0, cntOk = true, nanOk = true, bins = 0, empty = 0;
  for (const c of PM.cases) {
    const m = pixelMap(px, py, pres, { nx: c.nx, ny: c.ny, range: c.explicit_range ? c.range : undefined, keep: c.keep ? pkeep : null }), g = m.grid;
    wR = Math.max(wR, ...[g.x0, g.x1, g.y0, g.y1].map((v, i) => Math.abs(v - c.range[i])));
    for (let k = 0; k < c.mean.length; k++) {
      bins++; if (m.count[k] !== c.count[k]) cntOk = false;
      if (c.mean[k] == null) { empty++; if (!Number.isNaN(m.mean[k])) nanOk = false; } else wM = Math.max(wM, Math.abs(m.mean[k] - c.mean[k]));
      if (c.std[k] == null) { if (!Number.isNaN(m.std[k])) nanOk = false; } else { wS = Math.max(wS, Math.abs(m.std[k] / c.std[k] - 1), Math.abs(m.sem[k] * Math.sqrt(c.count[k]) / c.std[k] - 1)); }
    }
  }
  check('pixelMap matches scipy.stats.binned_statistic_2d (count, mean, standard deviation)', cntOk && nanOk && wM < 1e-16 && wS < 1e-12 && wR < 1e-13,
    `${PM.cases.length} grids (12 x 9 explicit range, 16 x 16 and 7 x 10 with keep on the 1-99% range), ${bins} bins of which ${empty} empty: counts identical ${cntOk}, empty bins NaN ${nanOk}; mean differs by at most ${ex(wM)} on values of order 1e-3 (tolerance 1e-16); standard deviation ${ex(wS)} relative (1e-12); range from percentiles against numpy.percentile ${ex(wR)} px (1e-13)`);
  check('percentile: numpy interpolation', percentile([1, 2, 3, 4], 50) === 2.5 && percentile([5, 1, 3], 0) === 1 && percentile([5, 1, 3], 100) === 5 && Math.abs(percentile([10, 20, 30, 40, 50], 37.5) - 25) < 1e-13, 'hand values');
}

// --- polynomial surface against numpy.linalg.lstsq
{
  const line = []; let worst = 0, worstE = 0, worstP = 0;
  for (const c of ref.poly) {
    const s = polySurface(px, py, pres, c.order, c.keep ? pkeep : null), sc = Math.max(...c.coef.map(Math.abs));
    const termsOk = JSON.stringify(s.terms) === JSON.stringify(polyTerms(c.order)) && s.coef.length === c.coef.length;
    let w = termsOk ? 0 : 1; c.coef.forEach((v, k) => { w = Math.max(w, Math.abs(s.coef[k] - v) / sc); });
    const we = relMax(s.coefErr, c.coefErr), wp = Math.max(...c.probe.map((p, i) => Math.abs(s.evaluate(p[0], p[1]) - c.probe_value[i])), Math.abs(s.rmsAfter / c.rmsAfter - 1), Math.abs(s.rmsBefore / c.rmsBefore - 1), Math.abs(s.xc - c.xc), Math.abs(s.yc - c.yc));
    worst = Math.max(worst, w); worstE = Math.max(worstE, we); worstP = Math.max(worstP, wp);
    line.push(`order ${c.order}${c.keep ? ' (keep)' : ''}: coefficients ${ex(w)}, errors ${ex(we)} (condition number ${c.cond.toFixed(0)})`);
  }
  check('polySurface matches numpy.linalg.lstsq', worst < 1e-12 && worstE < 1e-12 && worstP < 1e-13, line.join('; ') + `; coefficients relative to the largest one, tolerance 1e-12; formal errors 1e-12 (numpy side inverts the normal matrix); values at three probe points, rms before/after, centre: ${ex(worstP)} (1e-13)`);
  const grid = { x0: 10, x1: 11, y0: 20, y1: 20.5, nx: 4, ny: 2 }, sg = surfaceOnGrid((a, b) => a + 100 * b, grid), mask = surfaceOnGrid((a, b) => a, grid, [1, 0, 1, 1, 1, 1, 1, 0]);
  check('surfaceOnGrid samples bin centres, [iy * nx + ix], and blanks masked bins', Math.abs(sg[0] - (10.125 + 2012.5)) < 1e-12 && Math.abs(sg[7] - (10.875 + 2037.5)) < 1e-12 && Number.isNaN(mask[1]) && Number.isNaN(mask[7]) && mask[2] === 10.625, `${sg[0]}, ${sg[7]}`);
}

// --- synthetic K2-like series with a known intrapixel sensitivity
{
  const S = syntheticRollSeries(), n = S.resid.length, white = S.sigma, T = n * S.dt;
  const pm = pixelMap(S.x, S.y, S.resid, { nx: 24, ny: 16 });
  const ps = polySurface(S.x, S.y, S.resid, 2, null, { grid: pm.grid, mask: pm.count });
  // coefficients of x^2, xy, y^2 are -a, 0, -a; of x and y: -2a(xc - xs), -2a(yc - ys)
  const zs = [(ps.coef[3] + S.a) / ps.coefErr[3], ps.coef[4] / ps.coefErr[4], (ps.coef[5] + S.a) / ps.coefErr[5], (ps.coef[1] + 2 * S.a * (ps.xc - S.xs)) / ps.coefErr[1], (ps.coef[2] + 2 * S.a * (ps.yc - S.ys)) / ps.coefErr[2]];
  check('synthetic: polySurface order 2 recovers the intrapixel curvature a', zs.every((z) => Math.abs(z) < 3.5),
    `a = ${S.a} per px^2: from x^2 ${(-ps.coef[3]).toFixed(5)} +/- ${ps.coefErr[3].toFixed(5)}, from y^2 ${(-ps.coef[5]).toFixed(5)} +/- ${ps.coefErr[5].toFixed(5)}, xy ${ps.coef[4].toFixed(5)} +/- ${ps.coefErr[4].toFixed(5)}; offsets from truth in formal errors (x^2, xy, y^2, x, y): ${zs.map((z) => z.toFixed(2)).join(', ')}; tolerance 3.5`);
  const tolR = 3 / Math.sqrt(2 * n);
  check('synthetic: residual rms drops to the white level', Math.abs(ps.rmsAfter / white - 1) < tolR && ps.rmsBefore > 5 * white,
    `${(1e6 * ps.rmsBefore).toFixed(0)} ppm -> ${(1e6 * ps.rmsAfter).toFixed(1)} ppm with white noise ${(1e6 * white).toFixed(0)} ppm (ratio ${(ps.rmsAfter / white).toFixed(4)}; tolerance 3 / sqrt(2n) = ${tolR.toFixed(3)})`);
  // the binned map agrees with the true sensitivity at the bin centres, within the standard errors (plus the curvature inside a bin)
  let chi = 0, nb = 0, mx = 0; const truth = (a, b) => -S.a * ((a - S.xs) ** 2 + (b - S.ys) ** 2);
  for (let iy = 0; iy < 16; iy++) for (let ix = 0; ix < 24; ix++) { const k = iy * 24 + ix; if (pm.count[k] >= 5) { const z = (pm.mean[k] - truth(pm.xc[ix], pm.yc[iy])) / pm.sem[k]; chi += z * z; nb++; mx = Math.max(mx, Math.abs(pm.mean[k] - ps.surface[k])); } }
  check('synthetic: the pixel map follows the true sensitivity', Math.abs(chi / nb - 1) < 0.35 && pm.nUsed + pm.nOutside === n, `${nb} bins with 5 or more points: chi-square per bin ${(chi / nb).toFixed(2)} against the truth at the bin centres (tolerance 1 +/- 0.35); largest |map - fitted surface| ${(1e6 * mx).toFixed(0)} ppm; ${pm.nUsed} points inside the 1-99% range, ${pm.nOutside} outside`);
  // PSD: the roll peak
  const before = periodogramPsd(S.resid, S.dt), clean = Float64Array.from(S.resid, (v, i) => v - ps.fitted[i]), after = periodogramPsd(clean, S.dt);
  let kp = 1; for (let k = 2; k < before.p.length; k++) if (before.p[k] > before.p[kp]) kp = k;
  const lvl = whiteNoiseLevel(S.err, S.dt), fRoll = 1 / S.rollPeriod;
  let mAfter = 0; for (let k = 1; k < after.p.length - 1; k++) mAfter += after.p[k] / (after.p.length - 2);
  check('synthetic: the PSD peaks at the roll frequency', Math.abs(before.f[kp] - fRoll) <= before.df && before.p[kp] > 1000 * lvl,
    `peak at ${before.f[kp].toFixed(4)} /day (period ${(24 / before.f[kp]).toFixed(3)} h) against the roll at ${fRoll.toFixed(4)} /day (${(24 * S.rollPeriod).toFixed(2)} h): off by ${(Math.abs(before.f[kp] - fRoll) / before.df).toFixed(2)} resolution elements of ${before.df.toFixed(4)} /day (tolerance 1); peak ${(before.p[kp] / lvl).toExponential(1)} times the white level`);
  const tolP = 3 / Math.sqrt(after.p.length - 2);
  check('synthetic: after detrending the PSD is flat at the error-bar level', Math.abs(mAfter / lvl - 1) < tolP && after.p[kp] < 12 * lvl, `mean / (2 sigma^2 dt) = ${(mAfter / lvl).toFixed(3)} (tolerance ${tolP.toFixed(3)}: 3 standard errors); at the roll frequency ${(after.p[kp] / lvl).toFixed(2)} times the level (was ${(before.p[kp] / lvl).toExponential(1)})`);
  // Welch sees the same peak at its coarser resolution
  const wl = welchPsd(S.resid, S.dt, { nperseg: 512 }); let kw = 1; for (let k = 2; k < wl.p.length; k++) if (wl.p[k] > wl.p[kw]) kw = k;
  check('synthetic: welchPsd shows the roll peak', Math.abs(wl.f[kw] - fRoll) <= wl.df, `peak at ${wl.f[kw].toFixed(3)} /day, resolution ${wl.df.toFixed(3)} /day, ${wl.nWindows} windows`);
  // beta
  const rb = rmsVsBin(S.resid, { dt: S.dt }), ra = rmsVsBin(clean, { dt: S.dt }), Ns = [2, 3, 6, 12, 24, 48];
  const za = Ns.map((N) => (ra.betaAt(N) - 1) * Math.sqrt(2 * Math.floor(n / N)));
  check('synthetic: beta > 1 before detrending and 1 after', rb.betaAt(3) > 1.3 && rb.beta > 1.3 && za.every((z) => Math.abs(z) < 3),
    `before: beta(N = 3, 1.5 h) = ${rb.betaAt(3).toFixed(2)}, maximum ${rb.beta.toFixed(2)} at N = ${rb.nBeta}; after: ${Ns.map((N) => `beta(${N}) = ${ra.betaAt(N).toFixed(3)}`).join(', ')}, off from 1 by ${za.map((z) => z.toFixed(1)).join(', ')} of its error 1 / sqrt(2M) (tolerance 3); maximum over all sizes with 10 or more bins ${ra.beta.toFixed(2)} at N = ${ra.nBeta}`);
  // GP surface on the same grid
  const t0 = performance.now(), gs = gpSurface([S.x, S.y], S.resid, null, pm.grid, { maxHyper: 250, maxCond: 600 }), ms = performance.now() - t0;
  let q = 0, m = 0, mt = 0, ms2 = 0; for (let k = 0; k < gs.surface.length; k++) if (pm.count[k] > 0) { m++; }
  for (let iy = 0; iy < 16; iy++) for (let ix = 0; ix < 24; ix++) { const k = iy * 24 + ix; if (pm.count[k] > 0) q += (gs.surface[k] - truth(pm.xc[ix], pm.yc[iy])) ** 2 / m; }
  for (let i = 0; i < n; i++) { mt += (gs.trend[i] - S.sys[i]) ** 2 / n; ms2 += S.sys[i] / n; }
  check('synthetic: gpSurface (gp.js) gives the same map', Math.sqrt(q) < 0.5 * white && Math.sqrt(mt) < 0.3 * white && Math.abs(gs.rmsAfter / white - 1) < 0.05 && gs.surface.length === 24 * 16,
    `GP surface minus truth over the ${m} occupied bins: rms ${(1e6 * Math.sqrt(q)).toFixed(0)} ppm (tolerance half the white noise, ${(5e5 * white).toFixed(0)} ppm); trend at the points: ${(1e6 * Math.sqrt(mt)).toFixed(0)} ppm (tolerance 30%); residual rms ${(1e6 * gs.rmsAfter).toFixed(1)} ppm (within 5% of white); hyperparameters on ${gs.nHyper} points, conditioned on ${gs.nCond}; ${ms.toFixed(0)} ms`);
}

// --- timings
{
  const rng = makeRng(1), y = Float64Array.from({ length: 20000 }, () => rng.normal()), y2 = Float64Array.from({ length: 19997 }, () => rng.normal());
  periodogramPsd(y, 1); let t0 = performance.now(); for (let i = 0; i < 5; i++) periodogramPsd(y, 1); const a = (performance.now() - t0) / 5;
  t0 = performance.now(); for (let i = 0; i < 5; i++) periodogramPsd(y2, 1); const b = (performance.now() - t0) / 5;
  t0 = performance.now(); welchPsd(y, 1, { nperseg: 1024 }); const c = performance.now() - t0;
  const tt = Float64Array.from({ length: 1000 }, (_, i) => i + 0.3 * rng.next()); t0 = performance.now(); lombScarglePsd(tt, y.subarray(0, 1000)); const d = performance.now() - t0;
  check('periodogramPsd of 20,000 points in under 100 ms', a < 100 && b < 100, `n = 20000 (Bluestein, 65536-point transforms): ${a.toFixed(1)} ms; n = 19997 (prime): ${b.toFixed(1)} ms; welch nperseg 1024: ${c.toFixed(1)} ms; lombScarglePsd n = 1000 at 499 frequencies: ${d.toFixed(0)} ms`);
}
console.log(`total ${((performance.now() - T0) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
