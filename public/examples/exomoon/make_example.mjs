// Makes the worked example in this folder: a simulated light curve of a planet with a moon, as CSV and as an
// ESL session (docs/FORMAT.md), and prints the numbers quoted in README.md.   node public/examples/exomoon/make_example.mjs
import { writeFileSync } from 'node:fs';
import { makePlanetMoonTransit, moonComponents, moonGeometry, moonSupersample, ttvTdvAmplitudes, moonSearch } from '../../../src/core/exomoon.js';
import { transitModel } from '../../../src/core/transit.js';
import { arsFromKepler } from '../../../src/core/rv.js';
import { derived } from '../../../src/core/kepler.js';
import { makeRng } from '../../../src/core/stats.js';

const here = (f) => new URL(f, import.meta.url);
const T_REF = 2459000, SEED = 20261115;
const star = { teff: 5772, logg: 4.44, feh: 0, rstar: 1.0, mstar: 1.0 };
const ld = { law: 'quadratic', coefficients: [0.40, 0.26] };
// the planet: a Jupiter on a 45 d circular orbit; a/R* from Kepler's law (M*, R*, P, Mp), impact parameter 0.3
const planet = { rprs: 0.1, per: 45, tmid: T_REF + 10, ecc: 0, omega: 0, mplanet: 1.0 };
const ars = arsFromKepler(planet.per, star.mstar, planet.mplanet, star.rstar);
planet.inc = +((Math.acos(0.3 / ars) * 180) / Math.PI).toFixed(4);
// the moon: about 2.2 Earth radii, 6.4 Earth masses, on a 3.7 d coplanar prograde orbit
const moon = { rmoon: 0.02, permoon: 3.7, phmoon: 0.13, mmoon: 0.02, imoon: 0 };
const N_TRANSITS = 12, HALF_WINDOW = 0.6, EXPOSURE_MIN = 5, NOISE = 250e-6;

const params = { ...planet, ars, tmid: planet.tmid - T_REF, ldLaw: ld.law, ld: ld.coefficients, mstar: star.mstar, ...moon };
const exptime = EXPOSURE_MIN / 1440, nPer = Math.round((2 * HALF_WINDOW) / exptime), N = N_TRANSITS * nPer;
const t = new Float64Array(N), epoch = new Int32Array(N);
for (let j = 0; j < N_TRANSITS; j++) for (let i = 0; i < nPer; i++) { t[j * nPer + i] = params.tmid + j * planet.per - HALF_WINDOW + (i + 0.5) * exptime; epoch[j * nPer + i] = j; }
const ss = Math.max(7, moonSupersample(exptime, params));
const truth = moonComponents(t, params, { exptime, supersample: ss });
const rng = makeRng(SEED), f = Float64Array.from(truth.total, (m) => m + NOISE * rng.normal()), e = new Float64Array(N).fill(NOISE);

// ---- files
writeFileSync(here('lightcurve.csv'), 'BJD_TDB,flux,flux_err\n' + Array.from(t, (x, i) => `${(x + T_REF).toFixed(6)},${f[i].toFixed(6)},${e[i].toFixed(6)}`).join('\n') + '\n');
const session = {
  format: 'esl-session', version: 1, software: { name: 'exoplanet-science-lab', version: '0.2.0', commit: null }, created: '2026-11-15T00:00:00Z',
  name: 'Exomoon example (simulated)', title: 'A Jupiter with a 2.2 Earth-radius moon: 12 transits',
  notes: 'Simulated with src/core/exomoon.js (public/examples/exomoon/make_example.mjs). The moon\'s parameters are extra keys of planet b ' +
    '(rmoon, permoon, phmoon, mmoon, imoon). Until buildProblem reads them this session runs as a planet-only fit; fit.moon lists what to free for the moon.',
  star, limb_darkening: { ...ld, mode: 'coeffs', band: 'Kepler (approx.)' },
  planets: [{ letter: 'b', parameters: { ...planet, ...moon } }],
  kepler: true, time_reference: T_REF,
  data: { light_curve: { name: 'simulated', time: Array.from(t, (x) => +(x + T_REF).toFixed(6)), flux: Array.from(f, (x) => +x.toFixed(6)), flux_err: Array.from(e), airmass: null, exposure_min: EXPOSURE_MIN, epoch: null, epochs: [] }, radial_velocity: [], timing: [] },
  fit: {
    use: { lc: true, rv: false, timing: false },
    free: [{ key: 'rprs', prior: { type: 'uniform', a: 0.09, b: 0.11 } }, { key: 'tmid', prior: { type: 'uniform', a: planet.tmid - 0.02, b: planet.tmid + 0.02 } }, { key: 'inc', prior: { type: 'uniform', a: 89.3, b: 90 } }],
    // not part of format version 1 (readers keep and ignore it): the moon's free parameters and priors, for when the likelihood has the moon
    moon: { planet: 'b', free: [{ key: 'rmoon', prior: { type: 'uniform', a: 0, b: 0.05 } }, { key: 'permoon', prior: { type: 'uniform', a: 3.68, b: 3.72 } }, { key: 'phmoon', prior: { type: 'uniform', a: 0, b: 0.3 } }, { key: 'mmoon', prior: { type: 'uniform', a: 0, b: 0.1 } }],
      switches: { wobble: true, moonTransit: true, mutual: true }, separation: 'kepler' },
    fixed: {}, timing_noise: 0, sampler: { nlive: 400, fracRemain: 0.01, seed: 42, maxCalls: 1000000 },
  },
  truth: { planet: { ...planet, ars }, moon, noise_ppm: NOISE * 1e6, seed: SEED },
  result: null,
};
writeFileSync(here('session.json'), JSON.stringify(session));

// ---- what README.md quotes
const g = moonGeometry(params), A = ttvTdvAmplitudes(params), d = derived(params);
const moonless = transitModel(t, params, null, { exptime, supersample: ss });
let c0 = 0, c1 = 0, deep = 0, nMoon = 0, nMut = 0;
for (let i = 0; i < N; i++) { c0 += ((f[i] - moonless[i]) / NOISE) ** 2; c1 += ((f[i] - truth.total[i]) / NOISE) ** 2; deep = Math.max(deep, 1 - truth.moon[i]); if (truth.moon[i] < 1 - 1e-9) nMoon++; if (truth.overlap[i] > 0) nMut++; }
const pl = { ...params, rmoon: undefined };
const s = moonSearch({ t, f, e }, pl, { nNull: 200, seed: 4 });
console.log(`a/R* ${ars.toFixed(3)}, inc ${planet.inc}, T14 ${(d.t14 * 24).toFixed(2)} h, planet depth ${(1e6 * (1 - Math.min(...moonless))).toFixed(0)} ppm`);
console.log(`moon: separation ${g.aMoon.toFixed(4)} R* = ${g.aMoonRp.toFixed(2)} Rp, ${g.hillFrac.toFixed(3)} Hill radii (stable below ${g.stableFrac}), longest stable period ${g.maxPeriod.toFixed(2)} d, Roche ${g.rocheRp.toFixed(2)} Rp, valid ${g.ok}`);
console.log(`moon depth ${(deep * 1e6).toFixed(0)} ppm, ${nMoon} of ${N} points in the moon's own transit, ${nMut} in a planet-moon eclipse; supersample ${ss}`);
console.log(`TTV peak ${(A.ttv * 1440).toFixed(2)} min (rms ${(A.ttvRms * 1440).toFixed(2)}), TDV peak ${(A.tdv * 1440).toFixed(2)} min (rms ${(A.tdvRms * 1440).toFixed(2)})`);
console.log(`chi2 of the noisy data: ${c1.toFixed(0)} against the truth, ${c0.toFixed(0)} against the moonless planet at its true parameters (delta ${(c0 - c1).toFixed(0)}), N ${N}`);
console.log(`search (true planet model): P ${s.best.permoon.toFixed(4)} d, phase ${s.best.phmoon.toFixed(3)}, Rm/R* ${s.best.rmoon.toFixed(4)}, S/N ${s.best.snr.toFixed(1)}; 200 noise-only searches: max ${Math.max(...s.nullMax).toFixed(2)}, FAP < ${s.fap.toFixed(4)}; ${s.ms.toFixed(0)} ms`);
console.log('peaks: ' + s.peaks.map((p) => `${p.permoon.toFixed(3)} d (${p.snr.toFixed(1)})`).join(', '));
console.log(`smallest moon at S/N 6 on this sampling and noise: Rm/R* ${(moon.rmoon * Math.sqrt(6 / s.best.snr)).toFixed(4)}`);
