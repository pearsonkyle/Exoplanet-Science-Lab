// Worked examples. Several use the sample data distributed with EXOTIC (github.com/rzellem/EXOTIC, examples/):
// that provenance is stated in the notes where it applies. Each example names, in `python`, the call of this
// project's own Python package (python/, import name esl) that runs the same analysis: every example with a stored
// session under public/examples/results is `esl.Session.load(<that file>).run()`; the two timing examples are
// `esl.fit_ephemeris`. Paths are relative to the site root (public/ in the repository).
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
// example = { id, kinds, title, sub, python (see above), and one of: preset (+ synth, free), load(), sessionFile (+ adjust) }

import { parseLightCurve, parseRV, combineEpochs } from '../core/data.js';

const LD_TESS_HD80606 = [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333];   // ExoTETHyS, the values distributed with EXOTIC's sample data
const U = (a, b) => ({ type: 'uniform', a, b });
const HD80606_STAR = { teff: 5565, teffErr: 92, logg: 4.4, loggErr: 0.1, feh: 0.35, fehErr: 0.06, rstar: 1.05, rstarErr: 0.01, mstar: 1.05, mstarErr: 0.047 };
const HD80606_B = { rprs: 0.1, ars: 94.45, inc: 89.269, per: 111.4367, tmid: 2458888.0757, ecc: 0.93132, omega: -58.699, mplanet: 4.2 };
// mid-transit and mid-eclipse times of the joint analysis (Pearson et al. 2022)
const HD80606_TIMES = [
  { t: 2454987.7842, e: 0.0049, kind: 'transit', src: 'Winn et al. 2010' }, { t: 2455210.6420, e: 0.004, kind: 'transit', src: 'Hébrard et al. 2010' },
  { t: 2455210.6502, e: 0.0064, kind: 'transit', src: 'Shporer et al. 2010' }, { t: 2459556.6942, e: 0.0035, kind: 'transit', src: 'Exoplanet Watch, Dec 2021' },
  { t: 2454424.736, e: 0.00025, kind: 'eclipse', src: 'Laughlin et al. 2009 (Spitzer)' },
];

// What is shown after an example loads (also when it opens from its stored session, whose own note may be older).
const NOTES = {
  'hd80606-rv': 'Velocities only: the period, eccentricity, argument of periastron and planet mass are free. Press Run on the Fit tab. The velocity compilation is the file distributed with EXOTIC’s sample data.',
  'hd80606-joint': 'Transit, velocities and five mid-times share one orbit (a/R★ from Kepler’s law). The bounds on P, e, ω and the mass are the velocity-only fit (the previous example) ± 5σ. The light curve and velocities are the files distributed with EXOTIC’s sample data.',
  'toy1873': 'Synthetic: the light curves and velocities simulated by EXOTIC’s examples/multi_planet, modelled on TOI-1873 (the real data are the “TOI-1873” example). The three masses, the stellar trend and the jitter are free; the ephemerides are held. Tick Rp/R★, P, i or T mid on the Fit tab to open it up.',
  'decay': 'Real data. The Timing tab holds 457 mid-transit times of WASP-12 b (Exoplanet Watch, ExoClock and the Exoplanet Transit Database, as compiled in EXOTIC’s sample data), with the quadratic ephemeris selected. χ²/dof is far above 1, so the quoted uncertainty of dP/dt is too small by about the square root of that.',
  'ephemeris': 'Simulated: 40 mid-transit times written as an exercise in EXOTIC’s sample data (they run to 2028; the observatory labels are made up). Points more than 3σ from a first fit are often clipped: remove rows with ✕ to do that.',
  'toi1873': 'Real data. TESS (13 sectors, detrended by EXOTIC, 10-minute bins around every transit) and 37 NEID velocities. b and c are confirmed; d is a candidate with three transits 900.19 d apart, so its period is 900.19 d / N with N = 1, 2, 3, 4 or 7 (the aliases the TESS coverage allows), and N is sampled: the posterior gives each alias its probability. Radius, inclination, period, mid-time and mass of each planet, the limb darkening and the NEID jitter are free; a/R★ follows from Kepler’s law, orbits are circular, crossing or Hill-unstable orbits are excluded. Compare with the published two-planet pyaneti fit in the Methods page’s Reproducibility table.',
  'toi1873-oc': 'Real data: 50 TESS mid-transit times of TOI-1873 (EXOTIC’s per-transit fits). The stored fit is a straight line per planet. On the Timing tab, pick a planet to see its O − C and the periodogram of the residuals: no peak passes the 1% false-alarm level, so there is no timing variation to explain. The Kepler-88 example shows a timing signal that does reveal a hidden planet.',
  'kepler88': 'Real data: 119 mid-transit times of Kepler-88 b (KOI-142) from the Kepler TTV catalogue of Holczer et al. (2016). Its O − C swings by ±10 hours over 630 days: a planet near the 2:1 resonance pulls on it, though that planet never transits. The N-body fit samples planet c’s mass, period and phase and both eccentricities, with b’s own T0 and P profiled; c’s orbit is put at i = 87°. The catalogue errors are too small for this model, so 8.7 minutes of timing noise are added in quadrature. Compare c with Nesvorný et al. (2013) and Weiss et al. (2020) on the Methods page.',
  'ttvpair': 'Simulated: two transiting warm Saturns just outside the 2:1 resonance, every transit over four years, no velocities. Their O − C curves swing in opposite directions with a period of about 990 days; the N-body fit turns that into both masses. Injected: 0.14 and 0.09 M Jup.',
  'hd80606-rm': 'Real data: the velocity compilation of EXOTIC’s sample data holds two partial transits, SOPHIE on 2009 February 14 and HIRES on 2009 June 5, each its own dataset with a jitter. v sin i★ and the projected obliquity λ are free with the orbit (velocities and five mid-times). Rp/R★ is held at 0.1001 (Winn et al. 2009): the TESS radius is diluted by HD 80607. The anomaly uses limb darkening of the 390–690 nm band. Hébrard et al. (2010) found λ = 42 ± 8° from a full transit that is not in this file.',
};

async function hd80606RV(get) {
  // HRS is two populations of error bars, treated as two instruments
  const { sets } = parseRV(await get('examples/hd80606/HD80606_RV.csv'));
  return sets.flatMap((s) => {
    if (s.name !== 'HRS') return [s];
    const pick = (keep, name) => { const idx = Array.from(s.e.keys()).filter((i) => keep(s.e[i])); return { name, t: Float64Array.from(idx, (i) => s.t[i]), v: Float64Array.from(idx, (i) => s.v[i]), e: Float64Array.from(idx, (i) => s.e[i]) }; };
    return [pick((e) => e < 5, 'HRS_1'), pick((e) => e >= 5, 'HRS_2')];
  });
}

// The joint HD 80606 b session (Pearson et al. 2022): TESS transit, velocities and five mid-times on one orbit.
async function hd80606Joint(get) {
  const lc = parseLightCurve(await get('examples/hd80606/2458888_08_lightcurve.csv'), 'TESS');
  return {
    name: 'HD 80606', star: { ...HD80606_STAR }, ldLaw: 'nonlinear', ld: LD_TESS_HD80606, band: 'TESS (approx.)',
    planets: [{ letter: 'b', values: { ...HD80606_B } }], kepler: true, lc: { ...lc, name: 'TESS' }, exptimeMin: 2, rv: await hd80606RV(get),
    timing: HD80606_TIMES.map((x) => ({ ...x, planet: 'b' })), use: { lc: true, rv: true, timing: true },
    free: ['per', 'tmid', 'inc', 'omega', 'ecc', 'mplanet', 'rprs'],
    // the velocity-only posterior (the previous example) widened to ± 5σ bounds what the velocities constrain
    priors: { per: U(111.43633, 111.43717), tmid: U(2458887.8757, 2458888.2757), inc: U(87, 90), omega: U(-59.04, -58.62), ecc: U(0.93096, 0.93216), mplanet: U(4.172, 4.202), rprs: U(0.01, 0.2) },
    view: 'lc', fold: false, tab: 'fit',
    note: NOTES['hd80606-joint'],
  };
}

export const EXAMPLES = [
  {
    id: 'single', kinds: ['transit'], title: 'Single transit (simulated)', sub: 'HAT-P-32 b · a simulated ground-based night with an airmass trend',
    python: 'esl.Session.load("examples/results/single.json").run()', preset: 'hatp32',
  },
  {
    id: 'hd80606-tess', kinds: ['transit'], title: 'TESS transit of HD 80606 b', sub: 'the 12-hour transit of a planet on an e = 0.93 orbit',
    python: 'esl.Session.load("examples/results/hd80606-tess.json").run()', preset: 'hd80606',
  },
  {
    id: 'multi', kinds: ['transit'], title: 'Several transits, one fit (simulated)', sub: 'HAT-P-32 b · five simulated nights, each with its own airmass trend; the period is free',
    python: 'esl.Session.load("examples/results/multi.json").run()', preset: 'hatp32', synth: { nEpochs: 5, epochStep: 9 }, free: ['rprs', 'inc', 'tmid', 'per'],
  },
  {
    id: 'hd80606-rv', note: NOTES['hd80606-rv'], kinds: ['rv'], title: 'Radial velocities of HD 80606 b', sub: '264 velocities from seven instruments over 20 years',
    python: 'esl.Session.load("examples/results/hd80606-rv.json").run()',
    async load(get) {
      return {
        name: 'HD 80606', star: { ...HD80606_STAR, rstar: 1.066 }, ldLaw: 'nonlinear', ld: LD_TESS_HD80606, band: 'TESS (approx.)',
        planets: [{ letter: 'b', values: { ...HD80606_B } }], kepler: true, lc: null, rv: await hd80606RV(get),
        timing: HD80606_TIMES.map((x) => ({ ...x, planet: 'b' })),   // listed on the Timing tab; not in this fit unless ticked
        use: { lc: false, rv: true, timing: false }, free: ['per', 'omega', 'ecc', 'mplanet'],
        priors: { per: U(111.3, 111.5), omega: U(-65, -55), ecc: U(0.92, 0.94), mplanet: U(3, 4.5) }, view: 'rv', fold: true, tab: 'fit',
        note: NOTES['hd80606-rv'],
      };
    },
  },
  {
    id: 'hd80606-joint', note: NOTES['hd80606-joint'], kinds: ['transit', 'rv', 'ephemeris'], title: 'HD 80606 b: transit + velocities + timing', sub: 'the joint analysis of Pearson et al. (2022)',
    python: 'esl.Session.load("examples/results/hd80606-joint.json").run()',
    load: (get) => hd80606Joint(get),
  },
  {
    id: 'hd80606-rm', note: NOTES['hd80606-rm'], kinds: ['rv'], title: 'HD 80606 b: the Rossiter–McLaughlin effect', sub: 'two partial transits in the velocities (SOPHIE 2009 February, HIRES 2009 June) give the projected obliquity λ',
    python: 'esl.Session.load("examples/results/hd80606-rm.json").run()', sessionFile: 'examples/hd80606/rm_session.json',
    adjust(doc) { doc.notes = NOTES['hd80606-rm']; doc.ui = { ...(doc.ui || {}), view: 'rv', fold: false }; return doc; },
  },
  {
    id: 'toi1873', note: NOTES['toi1873'], kinds: ['transit', 'rv'], title: 'TOI-1873: two planets and a candidate, TESS + NEID', sub: 'real data: 50 TESS transits in 13 sectors and 37 NEID velocities; masses from the velocities',
    python: 'esl.Session.load("examples/results/toi1873.json").run()', sessionFile: 'examples/toi1873/session.json',
    adjust(doc) { doc.notes = NOTES['toi1873']; doc.ui = { ...(doc.ui || {}), view: 'lc', fold: true }; return doc; },
  },
  {
    id: 'toy1873', note: NOTES['toy1873'], kinds: ['transit', 'rv'], title: 'Three planets, synthetic (toy-1873)', sub: 'simulated by EXOTIC, modelled on TOI-1873; the outer planet’s velocity signal is below the jitter',
    python: 'esl.Session.load("examples/results/toy1873.json").run()',
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
        note: NOTES['toy1873'],
      };
    },
  },
  {
    id: 'phasecurve', kinds: ['transit'], title: 'WASP-43 b: full-orbit phase curve', sub: 'Spitzer 4.5 µm, one orbit: transit, two eclipses and the day-night cycle',
    python: 'esl.Session.load("examples/results/phasecurve.json").run()', sessionFile: 'examples/phasecurve/wasp43b_phasecurve.json',
    adjust(doc) { doc.ui = { ...(doc.ui || {}), view: 'phase', fold: false }; return doc; },
  },
  {
    id: 'eclipsemap', kinds: ['transit'], title: 'WASP-43 b: eclipse map', sub: 'Spitzer 4.5 µm: a phase curve, four more eclipses and two transits; map of degree 1',
    python: 'esl.Session.load("examples/results/eclipsemap.json").run()', sessionFile: 'examples/phasecurve/wasp43b_eclipse_map.json',
    adjust(doc) { doc.ui = { ...(doc.ui || {}), view: 'map', fold: false }; return doc; },
  },
  {
    id: 'eclipsemap-sim', kinds: ['transit'], title: 'Eclipse map at JWST precision (simulated)', sub: 'simulated: three eclipses and a transit of a WASP-18 b-like planet; map of degree 2',
    python: 'esl.Session.load("examples/results/eclipsemap-sim.json").run()', sessionFile: 'examples/phasecurve/wasp18b_sim_eclipse_map.json',
    adjust(doc) { doc.ui = { ...(doc.ui || {}), view: 'map', fold: false }; return doc; },
  },
  {
    id: 'exomoon', kinds: ['transit'], title: 'A planet with a moon (simulated)', sub: 'simulated: a Jupiter at 45 d with a 2.2 Earth-radius moon, twelve transits',
    python: 'esl.Session.load("examples/results/exomoon.json").run()', sessionFile: 'examples/exomoon/session.json',
    // the stored session is a planet-only fit; these make it the planet + moon fit its notes describe
    adjust(doc) {
      const m = doc.fit.moon || { free: [] };
      doc.fit.free = [...doc.fit.free, ...m.free.filter((f) => f.key !== 'mmoon')];
      doc.fit.fixed = { ...(doc.fit.fixed || {}), mmoon: doc.planets[0].parameters.mmoon };
      doc.notes = 'Simulated: a Jupiter-size planet at 45 d with a moon of 2.2 Earth radii on a 3.7 d orbit (Rm/R★ 0.02), twelve transits at 250 ppm. The moon’s radius, period and phase are free; the plot’s Moon view shows its effects in isolation, and “Search for a moon” on the System tab (after removing it) finds it from scratch.';
      doc.ui = { ...(doc.ui || {}), view: 'moon', fold: false };
      return doc;
    },
  },
  {
    id: 'decay', note: NOTES['decay'], kinds: ['ephemeris'], title: 'Orbital decay of WASP-12 b', sub: '457 mid-transit times over 15 years: is the period changing?',
    python: 'esl.fit_ephemeris(times, errors, period=1.0914, order=2)',
    async load(get, ctx) {
      // the system comes from the catalog snapshot (so its values carry their sources); the times from EXOTIC's sample data
      const sess = await ctx.catalogSession('WASP-12 b', ['ephemeris']);
      const rows = (await get('examples/ephemeris/wasp12_decay_times.csv')).trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
      const letter = sess.planets[0].letter;
      return { ...sess, timing: rows.map((r) => ({ t: Number(r[0]), e: Number(r[1]), kind: 'transit', planet: letter, src: r[2] })), timingOrder: 2, tab: 'timing',
        note: NOTES['decay'] };
    },
  },
  {
    id: 'toi1873-oc', note: NOTES['toi1873-oc'], kinds: ['ephemeris'], title: 'TOI-1873: ephemerides, O − C and periodogram', sub: 'real data: 50 TESS mid-transit times of three planets; is anything periodic in the residuals?',
    python: 'esl.Session.load("examples/results/toi1873-oc.json").run()', sessionFile: 'examples/toi1873/oc_session.json',
    adjust(doc) { doc.notes = NOTES['toi1873-oc']; doc.ui = { ...(doc.ui || {}), tab: 'timing' }; return doc; },
  },
  {
    id: 'kepler88', note: NOTES['kepler88'], kinds: ['ephemeris'], title: 'Kepler-88: weighing a hidden planet by transit timing (real data)', sub: 'real data: 119 Kepler mid-transit times of b swing by ±10 hours; an N-body fit gives the mass of the non-transiting planet c',
    python: 'esl.Session.load("examples/results/kepler88.json").run()', sessionFile: 'examples/kepler88/session.json',
    adjust(doc) { doc.notes = NOTES['kepler88']; doc.ui = { ...(doc.ui || {}), tab: 'timing' }; return doc; },
  },
  {
    id: 'ttvpair', note: NOTES['ttvpair'], kinds: ['ephemeris'], title: 'Masses from timing alone (simulated)', sub: 'simulated: two transiting planets near the 2:1 resonance; the N-body fit of their times gives both masses without velocities',
    python: 'esl.Session.load("examples/results/ttvpair.json").run()', sessionFile: 'examples/ttvpair/session.json',
    adjust(doc) { doc.notes = NOTES['ttvpair']; doc.ui = { ...(doc.ui || {}), tab: 'timing' }; return doc; },
  },
  {
    id: 'nbody', kinds: ['ephemeris'], title: 'Timing variations from an unseen companion (simulated)', sub: 'simulated: 72 mid-transit times of a hot Jupiter pulled by a 0.1 M Jup planet near the 2:1 resonance',
    python: 'esl.Session.load("examples/results/nbody.json").run()', sessionFile: 'examples/nbody/session.json',
    adjust(doc) {
      doc.notes = 'Simulated: 72 mid-transit times of a 1.17 M Jup planet at 2.797 d over 1110 days. The O − C on the Timing tab shows a sinusoid of about 20 orbits (57 d). “Search for an unseen companion” under Dynamics simulates companions on a grid of mass and period and finds the 0.1 M Jup planet near the 2:1 resonance that causes it; “Add it as a planet and fit” then samples its mass with the N-body model.';
      doc.ui = { ...(doc.ui || {}), tab: 'timing' };
      return doc;
    },
  },
  {
    id: 'ephemeris', note: NOTES['ephemeris'], kinds: ['ephemeris'], title: 'Ephemeris from 40 mid-transit times (simulated)', sub: 'an exercise list from EXOTIC’s sample data; O − C diagram',
    python: 'esl.fit_ephemeris(times, errors, period=2.7962868)',
    async load(get) {
      const rows = (await get('examples/ephemeris/transit_times.csv')).trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
      const timing = rows.map((r) => ({ t: Number(r[0]), e: Number(r[1]), kind: 'transit', planet: 'b', src: r[2] }));
      return {
        name: 'Simulated planet', star: { teff: 5800, teffErr: 100, logg: 4.4, loggErr: 0.1, feh: 0, fehErr: 0.1, rstar: 1, rstarErr: 0.05, mstar: 1, mstarErr: 0.05 },
        ldLaw: 'quadratic', ld: [0.4, 0.26], band: 'TESS (approx.)', planets: [{ letter: 'b', values: { rprs: 0.1, ars: 8.5, inc: 87.5, per: 2.7962868, tmid: timing[0].t, ecc: 0, omega: 0 } }],
        kepler: false, lc: null, rv: [], timing, use: { lc: true, rv: false, timing: false }, free: ['rprs', 'inc', 'tmid'], priors: {}, view: 'lc', fold: false, tab: 'timing',
        note: NOTES['ephemeris'],
      };
    },
  },
];
