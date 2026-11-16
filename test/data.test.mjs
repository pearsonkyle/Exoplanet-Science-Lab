import { parseLightCurve, nearestEpoch, synthesize, errorScaleFactors } from '../src/core/data.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const near = (a, b, t) => Math.abs(a - b) <= t;
const rows = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('\n');

const a = parseLightCurve('Time (JD),Relative Flux,Relative Flux Error\n2458887.429,0.9992996,0.00177\n' + rows(20, (i) => `${2458887.43 + i * 0.001},${1 + 0.0001 * i},0.0017`));
check('EXOTIC example header + JD offset', a.tRef === 2458887 && a.t.length === 21 && near(a.t[0], 0.429, 1e-6) && a.airmass === null && a.timeSystem === 'jd' && a.fluxUnits === 'flux');
const b = parseLightCurve(rows(30, (i) => `${i * 0.01}\t${5000 + (i % 3)}\t`));
check('tabs, no header, no errors, raw counts', near(b.f[0], 5000 / 5001, 1e-3) && b.e[0] > 0 && b.timeSystem === 'rel' && b.fluxUnits === 'flux');
const c = parseLightCurve('BJD,flux,ferr,airmass\n' + rows(12, (i) => `${2459000 + i * 0.01},1.0,0.001,${1 + 0.01 * i}`));
check('airmass column', c.airmass && near(c.airmass[11], 1.11, 1e-9));
let threw = false; try { parseLightCurve('a,b\n1,2'); } catch { threw = true; } check('rejects tiny files', threw);

// AAVSO exoplanet report as EXOTIC writes it
const aavso = `#TYPE=EXOPLANET\n#OBSCODE=RTZ\n#SOFTWARE=EXOTIC v4\n#DELIM=,\n#DATE_TYPE=BJD_TDB\n#EXOPLANET_NAME=HAT-P-32 b\n#EXPOSURE_TIME=60.0\n#MEASUREMENT_TYPE=Rnflux\n#FILTER=CV\n#PRIORS=Period=2.1500082 +/- 1.3e-07,Rp/R*=0.1489 +/- 0.0006,a/R*=5.344 +/- 0.04,inc=88.98 +/- 0.76,ecc=0.159,u0=0.42 +/- 0.01,u1=0.1 +/- 0.01,u2=0.3 +/- 0.01,u3=-0.1 +/- 0.01\n#RESULTS=Tc=2458107.7143 +/- 0.0005,Rp/R*=0.151 +/- 0.002\n# EXOTIC is developed by Exoplanet Watch\n#DATE,DIFF,ERR,DETREND_1,DETREND_2\n` + rows(40, (i) => `${(2458107.6 + i * 0.005).toFixed(6)},${(0.98 + 0.0005 * i).toFixed(6)},0.002,${(1.1 + 0.01 * i).toFixed(4)},${(1.0 + 0.001 * i).toFixed(4)}`);
const d = parseLightCurve(aavso, 'report.txt');
check('AAVSO report: columns', d.t.length === 40 && d.tRef === 2458107 && d.airmass && near(d.airmass[0], 1.1, 1e-9) && near(d.e[0] / d.f[0], 0.002 / 0.98, 1e-6));
check('AAVSO report: metadata', d.meta.planet === 'HAT-P-32 b' && d.meta.exptimeMin === 1 && d.meta.priors.per === 2.1500082 && d.meta.priors.ars === 5.344 && d.meta.priors.ld3 === -0.1 && near(d.meta.tmid, 0.7143, 1e-6), JSON.stringify(d.meta.priors));

// EXOTIC FinalLightCurve: header as a comment, phase and model columns, last column is the airmass MODEL
const fin = '# FINAL TIMESERIES OF HAT-P-32 b\n# BJD_TDB,Orbital Phase,Flux,Uncertainty,Model,Airmass\n' + rows(15, (i) => `${2458107.6 + i * 0.01}, ${-0.02 + i * 0.003}, ${1 - 0.001 * i}, 0.0015, 0.999, ${1.2 + 0.01 * i}`);
const e2 = parseLightCurve(fin);
check('EXOTIC FinalLightCurve', e2.t.length === 15 && near(e2.f[14] / e2.f[0], 0.986, 1e-9) && near(e2.e[0], 0.0015, 2e-5) && e2.airmass === null, `f0 ${e2.f[0].toFixed(4)} e0 ${e2.e[0]}`);

// magnitudes (differential, around zero) and millimagnitudes, MJD and BTJD times
const mag = parseLightCurve('MJD MAG MERR\n' + rows(30, (i) => `${58107.1 + i * 0.004} ${(0.01 * Math.sin(i) + (i > 10 && i < 20 ? 0.02 : 0)).toFixed(5)} 0.003`));
check('magnitudes + MJD', mag.fluxUnits === 'magnitude' && mag.timeSystem === 'mjd' && mag.tRef === 2458107 && near(mag.t[0], 0.6, 1e-6) && mag.f[15] < mag.f[5] && near(mag.e[0], 0.003 * 0.921, 2e-4), `tRef ${mag.tRef} e0 ${mag.e[0].toFixed(5)}`);
const mm = parseLightCurve(rows(30, (i) => `${1500.2 + i * 0.002},${(3 * Math.cos(i)).toFixed(3)},2.0`), 'x', { flux: 'millimagnitude' });
check('millimagnitudes + BTJD guess', mm.timeSystem === 'btjd' && mm.tRef === 2458500 && near(mm.e[0], 0.002 * 0.921, 2e-4));
const ov = parseLightCurve(rows(30, (i) => `${1500.2 + i * 0.002},${1 + 0.001 * Math.cos(i)},0.001`), 'x', { time: 'rel' });
check('time override', ov.tRef === 1500 && ov.timeSystem === 'rel');
const semi = parseLightCurve('time;flux;err\n' + rows(12, (i) => `${i * 0.01};${1 + 0.001 * i};0.001`) + '\n0.05;1.005;0.001\nfoo;bar;baz');
check('semicolons, duplicates and junk rows', semi.t.length === 12 && semi.notes.some((x) => /duplicate/.test(x)) && semi.notes.some((x) => /unreadable/.test(x)));

check('nearest epoch', near(nearestEpoch(2455210.6428, 111.4367, [3677, 3678.3]), 2455210.6428 + 111.4367 * Math.round((3677.65 - 2455210.6428) / 111.4367), 1e-9));
const s = synthesize({ rprs: 0.1, ars: 8, inc: 88, per: 3, tmid: 0, ecc: 0, omega: 0, ld0: 0.4, ld1: 0.2, a2: 0 }, 'quadratic', { exptimeMin: 2, noisePpm: 500, baselineHr: 1.5, airmass: true, seed: 2, k: 0 });
const span = (s.t[s.t.length - 1] - s.t[0]) * 24;
check('synthetic: points follow from length / exposure', near(s.t.length, span * 30, 3) && s.airmass.length === s.t.length && s.f.reduce((m, v) => Math.min(m, v), 2) < 0.992, `${s.t.length} points over ${span.toFixed(2)} h`);

// error rescaling: one factor per epoch, relative sizes kept, reduced chi-squared exactly 1
{
  let u = 7; const rnd = () => { u = (u * 16807) % 2147483647; return u / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const n = 4000, e = new Float64Array(n), f = new Float64Array(n), pred = new Float64Array(n), ep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ep[i] = i < 2500 ? 0 : 1;
    e[i] = 1e-3 * (0.5 + 1.5 * rnd());                       // error bars that differ from point to point
    const truth = (ep[i] ? 1.3 : 2.0) * e[i];                  // the real noise: 2.0x, then 1.3x the quoted error
    pred[i] = 1; f[i] = 1 + truth * gauss();
  }
  const r = errorScaleFactors(f, e, pred, ep, 2, 3);
  const e2 = Float64Array.from(e, (x, i) => x * r.beta[ep[i]]);
  let chi = 0; for (let i = 0; i < n; i++) chi += ((f[i] - pred[i]) / e2[i]) ** 2;
  const k = 3 + 2;
  check('error rescaling: chi2 / (N - k) is 1 afterwards', near(chi / (n - k), 1, 1e-12), (chi / (n - k)).toFixed(12));
  // expected factors: sqrt(N / (N - k)) times the true inflation, with the sampling error of a chi-squared mean
  const exp0 = 2.0 * Math.sqrt(n / (n - k)), exp1 = 1.3 * Math.sqrt(n / (n - k)), tol0 = exp0 / Math.sqrt(2 * 2500) * 3, tol1 = exp1 / Math.sqrt(2 * 1500) * 3;
  check('error rescaling: factors recover the true inflation per epoch', near(r.beta[0], exp0, tol0) && near(r.beta[1], exp1, tol1), `beta ${r.beta.map((b) => b.toFixed(4)).join(', ')} against ${exp0.toFixed(4)}, ${exp1.toFixed(4)} (3 sigma ${tol0.toFixed(4)}, ${tol1.toFixed(4)})`);
  let ratio = true; for (let i = 1; i < 2500; i++) if (!near(e2[i] / e2[0], e[i] / e[0], 1e-12)) ratio = false;
  check('error rescaling: relative sizes kept (not all set to one value)', ratio && Math.max(...e2.slice(0, 2500)) / Math.min(...e2.slice(0, 2500)) > 3);
  check('error rescaling: a zero error bar is refused', errorScaleFactors([1, 1], [0.001, 0], [1, 1], null, 1, 0) === null);
}
process.exit(ok ? 0 : 1);
