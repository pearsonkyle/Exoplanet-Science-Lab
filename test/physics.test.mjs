import { deriveSystem, planetClass } from '../src/core/derive.js';
import { hzEdges, hzProfile } from '../src/core/hz.js';
import { greyProfile, fitLaw, parseLDGrid, interpLDGrid } from '../src/core/ldest.js';
import { intensity, toClaret } from '../src/core/limbdark.js';
import { orbitElements, orbitPosition, eventTimes } from '../src/core/kepler.js';
import { makeTransit } from '../src/core/transit.js';
import { makeRng } from '../src/core/stats.js';
import { torres, estimateMassRadius } from '../src/core/stellar.js';
import { toYAML, parseConfig } from '../src/core/config.js';
import { makeLDTie, gridFromTable } from '../src/core/ldest.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

// Table 7 of Pearson et al. 2022, from their own parameter values
// the paper's planet radius and durations use the dilution-corrected radius ratio, sqrt(0.01019)
const hd = { rprs: Math.sqrt(0.01019), ars: 94.452, inc: 89.24, per: 111.436765, tmid: 2458888.07466, ecc: 0.93183, omega: -58.887 };
const star = { rstar: 1.05, mstar: 1.05, teff: 5565, mplanet: 4.1641 };
const D = deriveSystem(hd, star);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
check('planet radius', near(D.rpJup, 1.032, 0.006), `${D.rpJup.toFixed(3)} vs 1.032 Rjup`);
check('a from Kepler', near(D.aKeplerAU, 0.4603, 0.0006), `${D.aKeplerAU.toFixed(4)} vs 0.4603 au`);
check('a/R* from Kepler', near(D.arsKepler, 94.452, 0.25), `${D.arsKepler.toFixed(2)} vs 94.452`);
check('RV semi-amplitude', near(D.K, 469.22, 1.5), `${D.K.toFixed(2)} vs 469.22 m/s`);
check('transit duration', near(D.t14, 0.4990, 0.002), `${D.t14.toFixed(4)} vs 0.4990 d`);
console.log(`info eclipse duration ${D.e14.toFixed(5)} d here vs 0.07169 d in the paper (not reproduced; see README)`);
check('periastron epoch', near(D.tperi, 2458882.344, 0.01), `${D.tperi.toFixed(3)} vs 2458882.344`);
check('eclipse midpoint', near(D.emid, 2458882.214, 0.01), `${D.emid.toFixed(3)} vs 2458882.214`);

// geometry: the light curve dips exactly when the planet's disc overlaps the star's, in front of it
{
  const rng = makeRng(4); let bad = 0, n = 0, grazingSeen = 0, missSeen = 0;
  for (let c = 0; c < 400; c++) {
    const p = { rprs: 0.01 + 0.25 * rng.next(), ars: 2 + 60 * rng.next() ** 2, per: 1 + 50 * rng.next(), tmid: 10 * rng.next(), ecc: rng.next() < 0.3 ? 0 : 0.9 * rng.next(), omega: 360 * rng.next() - 180, ldLaw: 'quadratic', ld: [0.4, 0.2] };
    p.ars = Math.max(p.ars, (1.2 + p.rprs) / (1 - p.ecc));
    const bmax = 1.4; p.inc = Math.acos(Math.min(1, (bmax * rng.next()) / p.ars * (1 + p.ecc * Math.sin(p.omega * Math.PI / 180)) / (1 - p.ecc ** 2))) * 180 / Math.PI;
    const el = orbitElements(p), f = makeTransit(p), v = [0, 0, 0];
    let any = false;
    for (let i = 0; i < 400; i++) {
      const t = p.tmid + p.per * (rng.next() < 0.7 ? 0.03 * (rng.next() - 0.5) : rng.next() - 0.5);
      orbitPosition(el, t, v);
      const overlap = v[2] > 0 && Math.hypot(v[0], v[1]) < 1 + p.rprs - 1e-9, dip = f(t) < 1 - 1e-13;
      const edge = Math.abs(Math.hypot(v[0], v[1]) - (1 + p.rprs)) < 1e-6;
      if (!edge && overlap !== dip) bad++; n++; any = any || dip;
    }
    const b = Math.hypot(...orbitPosition(el, p.tmid, v).slice(0, 2));
    if (b > 1 - p.rprs && b < 1 + p.rprs) grazingSeen++; if (b > 1 + p.rprs) missSeen++;
    if (v[2] <= 0 || Math.abs(v[0]) > 1e-9 * p.ars) bad++;       // conjunction must be in front, on the sky meridian
  }
  check('flux dip <=> discs overlap in front (400 random orbits)', bad === 0, `${n} samples, ${grazingSeen} grazing, ${missSeen} non-transiting, mismatches ${bad}`);
}

// habitable zone
const hz = hzEdges(5780);
check('solar HZ (conservative 0.950-1.676 au)', near(hz.runaway / 215.032, 0.9505, 0.001) && near(hz.maxGreen / 215.032, 1.676, 0.001), `${(hz.runaway/215.032).toFixed(3)}-${(hz.maxGreen/215.032).toFixed(3)} au; optimistic ${(hz.recentVenus/215.032).toFixed(3)}-${(hz.earlyMars/215.032).toFixed(3)}`);
const hp = hzProfile({ teff: 5780, teffErr: 100, albedo: [0.2, 0.4] });
check('HZ profile is 0 at the ends, ~1 in the middle', hp.w[0] === 0 && hp.w[hp.w.length - 1] === 0 && Math.max(...hp.w) > 0.95);

// grey atmosphere: bolometric Eddington limit is I(mu)/I(1) = (2 + 3 mu)/5
{
  const g = greyProfile(5772, 0, 0, { eddington: true }); let e = 0;
  for (let i = 0; i < g.mu.length; i++) e = Math.max(e, Math.abs(g.I[i] - (2 + 3 * g.mu[i]) / 5));
  check('grey atmosphere reproduces the Eddington law', e < 2e-4, 'max err ' + e.toExponential(1));
  const lin = fitLaw('linear', g); check('linear fit of Eddington profile gives u = 0.6', near(lin.coeffs[0], 0.6, 2e-3), lin.coeffs[0].toFixed(4));
}
// how far is the grey estimate from a model-atmosphere result? HD 80606 in TESS (ExoTETHyS coefficients from the EXOTIC example)
{
  const a = [0.49387, -0.07295, 0.45785, -0.21582], g = greyProfile(5574, 600, 1000); let e = 0, s = 0;
  for (let i = 0; i < g.mu.length; i++) { const d = g.I[i] - intensity(g.mu[i], a); e = Math.max(e, Math.abs(d)); s += d * d; }
  const q = fitLaw('quadratic', g), sun = fitLaw('quadratic', greyProfile(5772, 502.8, 586.8));
  console.log(`info grey vs ExoTETHyS profile, HD 80606 / TESS: rms ${(Math.sqrt(s / g.mu.length)).toFixed(3)}, max ${e.toFixed(3)} (in units of central intensity)`);
  console.log(`info grey quadratic: HD 80606 TESS u = [${q.coeffs.map((x) => x.toFixed(3))}], Sun V u = [${sun.coeffs.map((x) => x.toFixed(3))}]`);
  const fl = { A: 0, B: 0 }; let fa = 0, fb = 0, ft = 0;   // flux-weighted comparison: disc-integrated darkening
  for (let i = 0; i < g.mu.length; i++) { fa += g.I[i] * g.mu[i]; fb += intensity(g.mu[i], a) * g.mu[i]; ft += g.mu[i]; }
  console.log(`info disc-averaged intensity / central: grey ${(fa / ft).toFixed(3)}, ExoTETHyS ${(fb / ft).toFixed(3)}`);
  for (const law of ['linear', 'quadratic', 'kipping', 'sqrt', 'nonlinear']) { const r = fitLaw(law, g); if (!(r.rms < 0.03) || r.coeffs.some((x) => !Number.isFinite(x))) check('fitLaw ' + law, false, JSON.stringify(r)); }
  check('fitLaw recovers known quadratic coefficients', (() => { const mu = Float64Array.from({ length: 50 }, (_, i) => 0.02 + 0.02 * i), I = mu.map((m) => intensity(m, toClaret('quadratic', [0.41, 0.23]))); const r = fitLaw('quadratic', { mu, I }); return near(r.coeffs[0], 0.41, 1e-9) && near(r.coeffs[1], 0.23, 1e-9); })());
}
// LD grid interpolation: a function linear in each axis must be reproduced exactly
{
  let txt = 'Teff, logg, [Fe/H], u1, u2\n';
  for (const T of [5000, 5500, 6000]) for (const g of [4.0, 4.5]) for (const z of [-0.5, 0, 0.5]) txt += `${T}, ${g}, ${z}, ${0.9 - T * 1e-4 + 0.02 * g + 0.03 * z}, ${0.1 + T * 2e-5 - 0.01 * g}\n`;
  const grid = parseLDGrid(txt), r = interpLDGrid(grid, 5574, 4.3, 0.34);
  check('LD grid trilinear interpolation', grid.law === 'quadratic' && r.method === 'trilinear' && near(r.coeffs[0], 0.9 - 0.5574 + 0.086 + 0.0102, 1e-12) && near(r.coeffs[1], 0.1 + 0.11148 - 0.043, 1e-12));
  check('LD grid clamps outside the table', interpLDGrid(grid, 7000, 4.3, 0).clamped === true);
}
// Torres et al. (2010): the calibration is known to return about 1.05 Msun, 1.02 Rsun for solar inputs
{ const t = torres(5772, 4.438, 0), e = estimateMassRadius({ teff: 5565, teffErr: 92, logg: 4.4, loggErr: 0.1, feh: 0.35, fehErr: 0.06 });
  check('Torres relation at solar values', near(t.mstar, 1.05, 0.015) && near(t.rstar, 1.02, 0.01), `M ${t.mstar.toFixed(3)} R ${t.rstar.toFixed(3)}`);
  check('Torres estimate for HD 80606 near literature (1.05, 1.05)', near(e.mstar, 1.05, 0.12) && near(e.rstar, 1.05, 0.15), `M ${e.mstar.toFixed(2)}±${e.mstarErr.toFixed(2)} R ${e.rstar.toFixed(2)}±${e.rstarErr.toFixed(2)}`); }
// config round trip through YAML and JSON
{ const cfg = { system: 'HD 80606 b', ld_law: 'nonlinear', ld_mode: 'coeffs', parameters: { rprs: { value: 0.072, fit: true, prior: 'uniform', min: 0.03, max: 0.12 }, per: { value: 111.4367, fit: false, prior: 'normal', mean: 111.4367, std: 0.0004 } }, sampler: { live_points: 400 } };
  const y = parseConfig(toYAML(cfg)), j = parseConfig(JSON.stringify(cfg));
  check('priors survive YAML and JSON', [y, j].every((c) => c.system === 'HD 80606 b' && c.params.rprs.fit === true && c.params.rprs.prior.b === 0.12 && c.params.per.prior.type === 'normal' && c.params.per.prior.b === 0.0004 && c.sampler.live_points === 400)); }
// stellar-tied limb darkening: the interpolated tie must match a direct evaluation
{ const tie = makeLDTie({ law: 'quadratic', source: 'grey', band: [600, 1000], teffRange: [5000, 6000] }), out = [0, 0];
  tie(5574, 0, out); const direct = fitLaw('quadratic', greyProfile(5574, 600, 1000, { nmu: 40 })).coeffs;
  check('LD tie interpolation (grey)', near(out[0], direct[0], 2e-4) && near(out[1], direct[1], 2e-4), `${out.map((x) => x.toFixed(4))} vs ${direct.map((x) => x.toFixed(4))}`);
  const rows = []; for (const T of [5000, 6000]) for (const g of [4, 5]) for (const z of [-0.5, 0.5]) rows.push({ teff: T, logg: g, feh: z, filter: 'V', linear: [0.9 - T * 5e-5], quadratic: [0.9 - T * 1e-4 + 0.1 * z, 0.2], nonlinear: [0.5, -0.1, 0.4, -0.2 + 0.05 * z] });
  const g = gridFromTable({ rows }, 'quadratic'), t2 = makeLDTie({ law: 'quadratic', source: 'grid', grid: g, filter: 'V', logg: 4.4, teffRange: [5000, 6000], fehRange: [-0.5, 0.5] });
  t2(5500, 0.2, out); check('LD tie interpolation (table, Teff and [Fe/H])', near(out[0], 0.9 - 0.55 + 0.02, 1e-9) && near(out[1], 0.2, 1e-12) && gridFromTable({ rows }, 'kipping').rows[0].c.length === 2 && gridFromTable({ rows }, 'sqrt').rows[0].c.length === 2); }
check('planet classes', planetClass(1, 300).key === 'earth' && planetClass(1.2, 2000).key === 'lava' && planetClass(2.5, 500).key === 'subneptune' && planetClass(4, 500).key === 'neptune' && planetClass(11, 1000).key === 'jupiter');
process.exit(ok ? 0 : 1);
