// End to end on simulated Ariel data: a hot Jupiter observed in transit, in eclipse and over a phase curve, then
// retrieved. Two planets, the same but for their aerosols: one clear, one hazy with a cloud deck.
//
//   node tools/examples/ariel_retrieval.mjs [clear|hazy|both] [quick] [calls=N]   writes tools/examples/ariel_retrieval[_clear|_hazy].json
//   (hours per planet at the default budget of 400,000 models a fit; the two can run side by side; `quick` is minutes and does not converge)
//
// What is simulated. The truth is the forward model of src/core/rtmodel.js (chemical equilibrium, a Guillot profile,
// a night side cooler by a set amount). The star is HD 209458 as a PHOENIX model. Ariel's channels at Tier 2 (three
// photometers; R = 10, 50, 15 in NIRSpec, AIRS-Ch0, AIRS-Ch1) and its noise as ArielRad computes it (Mugnai et al. 2020:
// photon noise with a 40% margin on its variance, 40 ppm sqrt(hr) of gain noise, a 20 ppm floor; an observation of
// 2.5 transit durations, eq. 22). Gaussian noise of that size is added to the binned truth: the light curves
// themselves are not simulated here (the Spectroscopy page does that step; this starts from depths with error bars).
// The night side is taken from the phase curve with the precision of one eclipse per orbit observed (an assumption).
//
// What is retrieved, with the sampler and priors of the light-curve fits: temperature (three numbers of the profile),
// [M/H], C/O, the radius at 10 mbar, and for the hazy planet the haze strength and the cloud-top pressure; with the
// eclipse and night spectra also the night-side contrast. Each planet is also fitted with the wrong aerosol
// description, and the two fits compared by their evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTable, prepareTables, loadMixKernel } from '../../src/core/opacity.js';
import { parseChem } from '../../src/core/chemistry.js';
import { parseStellar, stellarFlux } from '../../src/core/stellarspec.js';
import { DEFAULT_MODEL } from '../../src/core/rtmodel.js';
import { buildRetrieval, runRetrieval, compareRetrievals } from '../../src/core/retrieval.js';
import { depthNoise } from '../../src/core/spectroscopy.js';
import { TELESCOPES, instrumentChannels } from '../../src/core/missionbands.js';
import { makeRng } from '../../src/core/stats.js';

const which = process.argv[2] || 'both', quick = process.argv.includes('quick');
const arg = (k) => (process.argv.find((x) => x.startsWith(k + '=')) || '').slice(k.length + 1);
// seed=N draws another realisation of the noise; only=joint runs the joint fit alone; out=FILE writes there (the stored results are those of the default seeds)
const noiseSeed = +arg('seed') || 0, jointOnly = arg('only') === 'joint', outFile = arg('out');
const load = (f) => { const b = readFileSync(new URL('../../public/' + f, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const gases = ['H2O', 'CO2', 'CO', 'CH4'];
const full = { lines: gases.map((s) => parseTable(load(`opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`opacity/${s}.eslo`))), chem: parseChem(load('chem/equilibrium.eslc')), star: parseStellar(load('stellar/phoenix.esls')) };
// cut to Ariel's range and joined to R = 50, the finest Tier 2 asks for: a model then takes a few milliseconds
const tables = prepareTables(full, { wlMin: 0.5, wlMax: 7.8, merge: 4 }), kernel = await loadMixKernel(readFileSync(new URL('../../public/wasm/mix.wasm', import.meta.url)));

// HD 209458 and its planet (Stassun et al. 2017 / the usual values, rounded); T14 = 3.07 hr
const star = { teff: 6091, logg: 4.3, rstar: 1.19, distance: 48.3 }, t14 = 3.07;
const base = { ...DEFAULT_MODEL, nLayers: 30, planet: { mplanet: 0.69, rplanet: 1.38, pRef: 0.01 }, star: { rstar: star.rstar, teff: star.teff, logg: star.logg, ars: 8.8 }, vmr: {}, chemistry: { mh: 0.3, co: 0.55 },
  tp: { kind: 'guillot', teq: 1450, tint: 100, kappaIR: 10 ** -2.5, gamma: 10 ** -0.4 }, night: { dT: 500 } };
const WORLDS = { clear: { ...base }, hazy: { ...base, haze: { factor: 10 ** 3, slope: -4 }, cloudTop: 10 ** -1.5 } };
const TRUTH = { teq: 1450, logKappaIR: -2.5, logGamma: -0.4, mh: 0.3, co: 0.55, rplanet: 1.38, nightDT: 500, logHaze: 3, logCloudTop: -1.5 };

// Ariel's Tier 2 channels and the noise on a depth from one observation of each kind
const tel = TELESCOPES.Ariel, channels = instrumentChannels(tel), sp = stellarFlux(full.star, star);
const sigma = depthNoise(tel, { ...star, spectrum: sp }, channels, t14);
const nObs = { transit: 1, eclipse: 3, night: 3 };
function observe(model, seed) {
  const rng = makeRng(seed), sets = ['transit', 'eclipse', 'night'].map((kind) => ({ name: kind, kind, wl: channels.map((c) => c.wl), lo: channels.map((c) => c.lo), hi: channels.map((c) => c.hi), err: sigma.map((s) => s / Math.sqrt(nObs[kind])), y: null }));
  const truth = buildRetrieval({ model, tables, free: [], priors: {}, data: sets.map((s) => ({ ...s, y: s.wl.map(() => 0) })) }, { kernel }).predict([]).map((a) => Array.from(a));
  sets.forEach((s, j) => { s.truth = truth[j]; s.y = truth[j].map((v, i) => v + noiseScale * s.err[i] * rng.normal()); });
  return sets;
}
// noise=0: data without noise (the errors kept), to see where the posterior sits when the data are exactly the model
const noiseScale = arg('noise') === '' ? 1 : +arg('noise');
const U = (a, b) => ({ type: 'uniform', a, b });
const PRIORS = { teq: U(800, 2200), logKappaIR: U(-4, -1), logGamma: U(-1.5, 0.5), mh: U(-1, 2), co: U(0.2, 1.2), rplanet: U(1.2, 1.55), nightDT: U(0, 1200), logHaze: U(0, 5), logCloudTop: U(-5, 1.5) };
const budget = +arg('calls') || 400000;   // enough for every fit here to reach 1% of the evidence remaining
const sampler = { nlive: +arg('nlive') || (quick ? 60 : 100), seed: 11, maxCalls: quick ? 6000 : budget, ...(arg('method') ? { method: arg('method') } : {}), ...(+arg('slice') ? { sliceSteps: +arg('slice') } : {}) };   // method=slice slice=56: slice sampling only, with that many steps a point
const fit = (label, model, data, free) => {
  const t0 = Date.now(), r = runRetrieval({ model, tables, free, priors: PRIORS, data, sampler }, { kernel, onProgress: (p) => process.stderr.write(`  ${label}: ${p.ncalls} models, ln Z ${p.logZ.toFixed(1)}, ${(100 * (1 - Math.min(1, p.remFrac))).toFixed(0)}% of the evidence, ${p.elapsed.toFixed(0)} s\r`) });
  process.stderr.write('\n');
  const row = { label, free, logZ: r.logZ, logZerr: r.logZerr, converged: r.converged, ncalls: r.ncalls, seconds: (Date.now() - t0) / 1000, msPerModel: r.msPerModel, chi2: r.best.chi2, ndata: r.ndata, summary: r.summary, niter: r.niter, ess: r.ess, mode: r.mode, insertionP: r.insertionP, sampling: r.sampling || r.stat || null, warnings: r.warnings };
  console.log(`${label}: ${r.ncalls} models in ${row.seconds.toFixed(0)} s (${r.msPerModel.toFixed(0)} ms each), ln Z = ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)}, chi2 ${r.best.chi2.toFixed(1)} for ${r.ndata} points${r.converged ? '' : ' (NOT converged: ' + r.stopReason + ')'}`);
  for (const k of free) { const s = r.summary[k], t = TRUTH[k], e = 0.5 * (s.hi - s.lo); console.log(`    ${k.padEnd(12)} ${s.median.toPrecision(4).padStart(8)} +${(s.hi - s.median).toPrecision(2)} -${(s.median - s.lo).toPrecision(2)}   truth ${t}   ${(Math.abs(s.median - t) / e).toFixed(1)} sigma`); }
  return { row, r };
};
const out = { made: new Date().toISOString().slice(0, 10), quick, star, t14_hr: t14, channels: channels.map((c, i) => ({ name: c.name, wl: c.wl, lo: c.lo, hi: c.hi, sigma_ppm_one_observation: 1e6 * sigma[i] })), observations: nObs, truth: TRUTH, sampler, planets: {} };
console.log(`Ariel Tier 2: ${channels.length} channels; noise on a depth from one observation ${(1e6 * Math.min(...sigma)).toFixed(0)} to ${(1e6 * Math.max(...sigma)).toFixed(0)} ppm (median ${(1e6 * sigma.slice().sort((a, b) => a - b)[sigma.length >> 1]).toFixed(0)})`);
for (const name of which === 'both' ? ['clear', 'hazy'] : [which]) {
  const data = observe(WORLDS[name], noiseSeed || (name === 'clear' ? 5 : 6)), thermal = ['teq', 'logKappaIR', 'logGamma'], chem = ['mh', 'co', 'rplanet'], aero = ['logHaze', 'logCloudTop'];
  console.log(`\n=== ${name} planet ===`);
  const P = { data: data.map((d) => ({ kind: d.kind, wl: d.wl, y: d.y, err: d.err, truth: d.truth })) }, clearModel = { ...WORLDS.clear }, hazyModel = { ...WORLDS.clear, haze: { factor: 1, slope: -4 }, cloudTop: 10 };
  const tr = data.filter((d) => d.kind === 'transit');
  // 1. the transit alone, with the right description and with the other one
  const a = jointOnly ? null : fit('transit only, clear model', { ...clearModel, night: null }, tr, [...thermal, ...chem]);
  const b = jointOnly ? null : fit('transit only, haze and cloud', { ...hazyModel, night: null }, tr, [...thermal, ...chem, ...aero]);
  const cmp = jointOnly ? null : compareRetrievals(b.r, a.r); if (cmp) console.log(`  haze and cloud against clear: Δ ln Z = ${cmp.dLogZ.toFixed(2)} ± ${cmp.err.toFixed(2)}: ${cmp.verdict}`);
  // 2. transit, eclipse and the night side together, with the description the transit favoured
  const useAero = name === 'hazy', joint = fit('transit + eclipse + night side', useAero ? hazyModel : clearModel, data, [...thermal, ...chem, ...(useAero ? aero : []), 'nightDT']);
  P.fits = jointOnly ? [joint.row] : [a.row, b.row, joint.row]; P.comparison = cmp; P.bestSpectra = joint.r.best.spectra.map((x) => Array.from(x)); out.planets[name] = P;
}
const file = `./ariel_retrieval${which === 'both' ? '' : '_' + which}.json`;
if (outFile) { writeFileSync(outFile, JSON.stringify({ ...out, noiseSeed }, null, 1) + '\n'); console.log('\nwrote ' + outFile); }
else if (noiseSeed || jointOnly) throw new Error('seed= and only= need out=FILE: the stored results are not overwritten');
else { writeFileSync(new URL(file, import.meta.url), JSON.stringify(out, null, 1) + '\n'); console.log('\nwrote tools/examples/' + file.slice(2)); }
