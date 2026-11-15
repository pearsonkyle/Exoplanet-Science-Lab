// Worked examples, mirroring the examples/ folder of EXOTIC (github.com/rzellem/EXOTIC).
// Each returns a "session": a plain description of a system and its data that main.js turns
// into application state (applySession). Data files live in public/examples/.
//
// session = {
//   name, star: { teff, teffErr, logg, loggErr, feh, fehErr, rstar, rstarErr, mstar, mstarErr },
//   ldLaw, ld: [..], band,
//   planets: [{ letter, values: { rprs, ars, inc, per, tmid (absolute days), ecc, omega, mplanet } }],
//   kepler: bool, lc: dataset | null, exptimeMin, rv: [{ name, t (absolute), v, e }],
//   timing: [{ t, e, kind, planet (letter), src }], extra: { rvlin, ... },
//   use: { lc, rv, timing }, free: [keys with planet letters, e.g. "mplanet@c"], priors: { key: prior },
//   view: 'lc' | 'rv', fold: bool, tab: which side tab to open, note: one line shown after loading }

import { parseLightCurve, parseRV, combineEpochs } from '../core/data.js';

const LD_TESS_HD80606 = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];   // ExoTETHyS, as in EXOTIC's examples
const U = (a, b) => ({ type: 'uniform', a, b });
const HD80606_STAR = { teff: 5565, teffErr: 92, logg: 4.4, loggErr: 0.1, feh: 0.35, fehErr: 0.06, rstar: 1.05, rstarErr: 0.01, mstar: 1.05, mstarErr: 0.047 };
const HD80606_B = { rprs: 0.1, ars: 94.45, inc: 89.269, per: 111.4367, tmid: 2458888.0757, ecc: 0.93132, omega: -58.699, mplanet: 4.2 };
// mid-transit and mid-eclipse times used by examples/joint_rv_transit/joint_fit.py
const HD80606_TIMES = [
  { t: 2454987.7842, e: 0.0049, kind: 'transit', src: 'Winn et al. 2010' }, { t: 2455210.6420, e: 0.004, kind: 'transit', src: 'Hébrard et al. 2010' },
  { t: 2455210.6502, e: 0.0064, kind: 'transit', src: 'Shporer et al. 2010' }, { t: 2459556.6942, e: 0.0035, kind: 'transit', src: 'Exoplanet Watch, Dec 2021' },
  { t: 2454424.736, e: 0.00025, kind: 'eclipse', src: 'Laughlin et al. 2009 (Spitzer)' },
];

async function hd80606RV(get) {
  // as joint_fit.py: HRS is two populations of error bars, treated as two instruments
  const { sets } = parseRV(await get('examples/hd80606/HD80606_RV.csv'));
  return sets.flatMap((s) => {
    if (s.name !== 'HRS') return [s];
    const pick = (keep, name) => { const idx = Array.from(s.e.keys()).filter((i) => keep(s.e[i])); return { name, t: Float64Array.from(idx, (i) => s.t[i]), v: Float64Array.from(idx, (i) => s.v[i]), e: Float64Array.from(idx, (i) => s.e[i]) }; };
    return [pick((e) => e < 5, 'HRS_1'), pick((e) => e >= 5, 'HRS_2')];
  });
}

export const EXAMPLES = [
  {
    id: 'single', kinds: ['transit'], title: 'Single transit', sub: 'HAT-P-32 b · simulated ground-based night with an airmass trend',
    exotic: 'single_transit/transit_fit_example.py', preset: 'hatp32',
  },
  {
    id: 'hd80606-tess', kinds: ['transit'], title: 'TESS transit of HD 80606 b', sub: 'the 12-hour transit of a planet on an e = 0.93 orbit',
    exotic: 'joint_rv_transit (its light curve)', preset: 'hd80606',
  },
  {
    id: 'multi', kinds: ['transit'], title: 'Several transits, one fit', sub: 'five simulated nights, each with its own airmass trend; the period is free',
    exotic: 'multiple_transit/multi_fit_example.py', preset: 'hatp32', synth: { nEpochs: 5, epochStep: 9 }, free: ['rprs', 'inc', 'tmid', 'per'],
  },
  {
    id: 'hd80606-rv', kinds: ['rv'], title: 'Radial velocities of HD 80606 b', sub: '264 velocities from seven instruments over 20 years',
    exotic: 'radial_velocity/rv_example.py',
    async load(get) {
      return {
        name: 'HD 80606', star: { ...HD80606_STAR, rstar: 1.066 }, ldLaw: 'nonlinear', ld: LD_TESS_HD80606, band: 'TESS (approx.)',
        planets: [{ letter: 'b', values: { ...HD80606_B } }], kepler: true, lc: null, rv: await hd80606RV(get), timing: [],
        use: { lc: false, rv: true, timing: false }, free: ['per', 'omega', 'ecc', 'mplanet'],
        priors: { per: U(111.3, 111.5), omega: U(-65, -55), ecc: U(0.92, 0.94), mplanet: U(3, 4.5) }, view: 'rv', fold: true, tab: 'fit',
        note: 'Velocities only, with the four free parameters and bounds of EXOTIC’s rv_example.py. Press Run on the Fit tab.',
      };
    },
  },
  {
    id: 'hd80606-joint', kinds: ['transit', 'rv', 'ephemeris'], title: 'HD 80606 b: transit + velocities + timing', sub: 'the joint analysis of Pearson et al. (2022)',
    exotic: 'joint_rv_transit/joint_fit.py',
    async load(get) {
      const lc = parseLightCurve(await get('examples/hd80606/2458888_08_lightcurve.csv'), 'TESS');
      return {
        name: 'HD 80606', star: { ...HD80606_STAR }, ldLaw: 'nonlinear', ld: LD_TESS_HD80606, band: 'TESS (approx.)',
        planets: [{ letter: 'b', values: { ...HD80606_B } }], kepler: true, lc: { ...lc, name: 'TESS' }, exptimeMin: 2, rv: await hd80606RV(get),
        timing: HD80606_TIMES.map((x) => ({ ...x, planet: 'b' })), use: { lc: true, rv: true, timing: true },
        free: ['per', 'tmid', 'inc', 'omega', 'ecc', 'mplanet', 'rprs'],
        // as joint_fit.py: the velocity-only posterior (the previous example) widened to ± 5σ bounds what the velocities constrain
        priors: { per: U(111.43633, 111.43717), tmid: U(2458887.8757, 2458888.2757), inc: U(87, 90), omega: U(-59.04, -58.62), ecc: U(0.93096, 0.93216), mplanet: U(4.172, 4.202), rprs: U(0.01, 0.2) },
        view: 'lc', fold: false, tab: 'fit',
        note: 'Transit, velocities and five mid-times share one orbit (a/R★ from Kepler’s law). The bounds on P, e, ω and the mass are the velocity-only fit ± 5σ, as EXOTIC’s joint_fit.py sets them.',
      };
    },
  },
  {
    id: 'toy1873', kinds: ['transit', 'rv'], title: 'Three planets: TESS + NEID', sub: 'toy-1873, modelled on TOI-1873; the outer planet’s velocity signal is below the jitter',
    exotic: 'multi_planet/multi_fit.py',
    async load(get) {
      const sys = JSON.parse(await get('examples/toy1873/multi_system.json'));
      const lcs = await Promise.all(['b', 'c', 'd'].map(async (k) => ({ ...parseLightCurve(await get(`examples/toy1873/tess_${k}.csv`), `TESS · transits of ${k}`), name: `TESS · transits of ${k}` })));
      const { sets } = parseRV(await get('examples/toy1873/rv_neid.csv'), 'NEID');
      const planets = ['b', 'c', 'd'].map((k) => { const p = sys.planets[k]; return { letter: k, values: { rprs: p.rprs, inc: p.inc, per: p.per, tmid: p.tmid, ecc: 0, omega: 0, mplanet: p.mplanet, ars: 10 } }; });
      const b = sys.bounds;
      return {
        name: 'toy-1873', star: { teff: 5605, teffErr: 100, logg: 4.47, loggErr: 0.1, feh: 0, fehErr: 0.1, rstar: 0.974, rstarErr: 0.02, mstar: 1.02, mstarErr: 0.04 },
        ldLaw: 'nonlinear', ld: LD_TESS_HD80606, band: 'TESS (approx.)', planets, kepler: true, lc: combineEpochs(lcs), exptimeMin: 0, rv: sets, timing: [],
        extra: { rvlin: 0, 'jit@rv1': 2 }, use: { lc: true, rv: true, timing: false },
        free: ['mplanet', 'mplanet@c', 'mplanet@d', 'rvlin', 'jit@rv1'],
        priors: { mplanet: U(0, b.b.mplanet[1]), 'mplanet@c': U(0, b.c.mplanet[1]), 'mplanet@d': U(0, b.d.mplanet[1]), rvlin: U(-0.1, 0.1), 'jit@rv1': U(0, 15),
          ...Object.fromEntries(['b', 'c', 'd'].flatMap((k) => ['rprs', 'per', 'inc', 'tmid'].map((f) => [k === 'b' ? f : `${f}@${k}`, U(b[k][f][0], b[k][f][1])]))) },
        truth: { mplanet: sys.planets.b.mplanet, 'mplanet@c': sys.planets.c.mplanet, 'mplanet@d': sys.planets.d.mplanet, rvlin: sys.trend.rv_linear, 'jit@rv1': sys.noise.rv_jitter },
        view: 'rv', fold: true, tab: 'fit',
        note: 'EXOTIC’s default for this toy: the three masses, the stellar trend and the jitter are free; the ephemerides are held. Tick Rp/R★, P, i or T mid on the Fit tab to open it up.',
      };
    },
  },
  {
    id: 'ephemeris', kinds: ['ephemeris'], title: 'Ephemeris from 40 mid-transit times', sub: 'times from TESS, Exoplanet Watch, ExoClock and Unistellar; O − C diagram',
    exotic: 'ephemeris/fit_ephemeris.py',
    async load(get) {
      const rows = (await get('examples/ephemeris/transit_times.csv')).trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
      const timing = rows.map((r) => ({ t: Number(r[0]), e: Number(r[1]), kind: 'transit', planet: 'b', src: r[2] }));
      return {
        name: 'Example planet', star: { teff: 5800, teffErr: 100, logg: 4.4, loggErr: 0.1, feh: 0, fehErr: 0.1, rstar: 1, rstarErr: 0.05, mstar: 1, mstarErr: 0.05 },
        ldLaw: 'quadratic', ld: [0.4, 0.26], band: 'TESS (approx.)', planets: [{ letter: 'b', values: { rprs: 0.1, ars: 8.5, inc: 87.5, per: 2.7962868, tmid: timing[0].t, ecc: 0, omega: 0 } }],
        kepler: false, lc: null, rv: [], timing, use: { lc: true, rv: false, timing: false }, free: ['rprs', 'inc', 'tmid'], priors: {}, view: 'lc', fold: false, tab: 'timing',
        note: 'The Timing tab holds the 40 times of EXOTIC’s ephemeris example. Its script clips points more than 3σ from a first fit; remove rows with ✕ to do the same.',
      };
    },
  },
];
