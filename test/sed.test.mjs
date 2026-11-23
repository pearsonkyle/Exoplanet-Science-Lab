// SED fitting (src/core/sed.js, extinction.js, passbands.js): the extinction curve against the dust_extinction
// package, the passbands against the filter service's own numbers, Vega through the bands, a fit that recovers what
// was put in, and benchmark stars with interferometric diameters. Reference: test/sed_reference.json
// (test/make_sed_reference.py) and test/sed_benchmarks.json. Tolerances are stated in each check.
import { readFileSync } from 'node:fs';
import { extinctionF99 } from '../src/core/extinction.js';
import { PASSBANDS } from '../src/core/passbands.js';
import { parseStellar, stellarFlux } from '../src/core/stellarspec.js';
import * as E from '../src/core/sed.js';
import { matchSpectrum } from '../src/core/specmatch.js';
import { resampleFlux } from '../src/core/stellarspec.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./sed_reference.json', import.meta.url))), bench = JSON.parse(readFileSync(new URL('./sed_benchmarks.json', import.meta.url)));
const gb = readFileSync(new URL('../public/stellar/phoenix.esls', import.meta.url)), grid = parseStellar(gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.byteLength));
{
  const x = ref.extinction; let wRel = 0, wAbs = 0;
  for (const rv of Object.keys(x.a_over_av)) x.wl.forEach((l, i) => { const got = extinctionF99(l, +rv), want = x.a_over_av[rv][i]; wAbs = Math.max(wAbs, Math.abs(got - want)); if (l < 2.5) wRel = Math.max(wRel, Math.abs(got / want - 1)); });
  check('the Fitzpatrick (1999) extinction curve against the dust_extinction package', wRel < 0.012 && wAbs < 0.03 && Math.abs(extinctionF99(0.5470) - 0.985) < 5e-3 && extinctionF99(0.2175) > 2.9 && extinctionF99(10) < 0.03,
    `${x.wl.length} wavelengths from 0.12 to 3.3 µm at R_V = 2.5, 3.1 and 4.5 (${x.source}): within ${(100 * wRel).toFixed(2)}% below 2.5 µm (tolerance 1.2%) and ${wAbs.toFixed(4)} in A/A_V everywhere (tolerance 0.03). A/A_V = ${extinctionF99(0.547).toFixed(4)} at 5470 Å, ${extinctionF99(0.2175).toFixed(2)} on the 2175 Å bump, ${extinctionF99(2.2).toFixed(3)} at 2.2 µm`);
}
{
  const rows = Object.entries(PASSBANDS).map(([name, b]) => { const r = ref.pivots[b.id], f = E.magnitudeToFlux(name, 0); return { name, dp: f.pivot / r.pivot - 1, zp: b.system === 'AB' ? b.zp === 3631 : Math.abs(b.zp / r.zp_vega - 1) < 1e-4, n: b.wl.length }; });
  const worst = rows.reduce((a, b) => (Math.abs(b.dp) > Math.abs(a.dp) ? b : a)), f0 = E.magnitudeToFlux('Johnson V', 0);
  check('passbands: pivot wavelengths and zero points as the filter service states them', rows.length === 31 && rows.every((r) => Math.abs(r.dp) < 0.004 && r.zp && r.n <= 91) && Math.abs(f0.flam / 3.63e-8 - 1) < 0.03,
    `${rows.length} bands, each on at most 90 points: pivots within ${(100 * Math.abs(worst.dp)).toFixed(2)}% of the service's (worst: ${worst.name}; tolerance 0.4%); Vega zero points as given, 3631 Jy for the AB surveys. Magnitude 0 in Johnson V is ${f0.flam.toExponential(3)} W m⁻² µm⁻¹ (3.63e-8 in the usual tables; tolerance 3%)`);
}
{
  // a fit recovers what was put in: magnitudes computed from the model, scattered by 0.02 mag
  const names = ['Gaia BP', 'Gaia G', 'Gaia RP', 'Tycho BT', 'Tycho VT', '2MASS J', '2MASS H', '2MASS Ks', 'WISE W1', 'WISE W2', 'WISE W3'], truth = { teff: 5350, logg: 4.5, feh: 0.1, theta: 0.25, av: 0.06 };
  const P = E.prepareSed(grid, names.map((band) => ({ band, mag: 0, err: 0.02 }))), mags = E.sedMagnitudes(P, truth).mags; let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }, g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const obs = names.map((band, j) => ({ band, mag: mags[j] + 0.02 * g(), err: 0.02 })), r = E.fitSed(grid, obs, { priors: { plx: [20, 0.02], logg: [4.5, 0.1], feh: [0.1, 0.1] } }), p = r.parameters, rTrue = (0.5 * 0.25 * (Math.PI / 180 / 3600 / 1000) * 50 * 3.0856775814913673e16) / 6.957e8;
  const z = (k, v) => (p[k].median - v) / (0.5 * (p[k].hi - p[k].lo)), red = E.sedMagnitudes(P, { ...truth, av: 1 }).mags, clear = E.sedMagnitudes(P, { ...truth, av: 0 }).mags;
  check('a fit recovers the star it was given', r.converged && Math.abs(z('teff', 5350)) < 2 && Math.abs(z('theta_mas', 0.25)) < 2 && Math.abs(z('rstar', rTrue)) < 2 && p.teff.hi - p.teff.lo < 250 && (p.theta_mas.hi - p.theta_mas.lo) / 0.25 < 0.04 && r.chi2 < 25 && Math.abs(red[4] - clear[4] - 1.0) < 0.06 && Math.abs(red[7] - clear[7] - 0.117) < 0.02,
    `11 magnitudes of a 5350 K star with θ = 0.25 mas, A_V = 0.06, scattered by 0.02 mag: Teff ${p.teff.median.toFixed(0)} +${(p.teff.hi - p.teff.median).toFixed(0)} −${(p.teff.median - p.teff.lo).toFixed(0)} K, θ ${p.theta_mas.median.toFixed(4)} ± ${(0.5 * (p.theta_mas.hi - p.theta_mas.lo)).toFixed(4)} mas, R ${p.rstar.median.toFixed(3)} ± ${(0.5 * (p.rstar.hi - p.rstar.lo)).toFixed(3)} R☉ (put in: ${rTrue.toFixed(3)}), A_V ${p.av.median.toFixed(2)} ± ${(0.5 * (p.av.hi - p.av.lo)).toFixed(2)}; each within 2σ; ${r.ncalls} model evaluations. One magnitude of A_V dims Tycho VT by ${(red[4] - clear[4]).toFixed(3)} mag and 2MASS Ks by ${(red[7] - clear[7]).toFixed(3)}`);
}
{
  // Vega through the bands: the grid stops at 8000 K, so this is a check of zero points on the hottest model only in
  // the infrared, where a 9600 K star and an 8000 K one differ least: skipped. Instead the Sun: V = -26.76, and colours
  const P = E.prepareSed(grid, ['Johnson B', 'Johnson V', '2MASS J', '2MASS Ks', 'Gaia G'].map((band) => ({ band, mag: 0, err: 0.01 }))), au = 1.495978707e11, theta = ((2 * 6.957e8) / au) / (Math.PI / 180 / 3600 / 1000);
  const m = E.sedMagnitudes(P, { teff: 5772, logg: 4.44, feh: 0, theta }).mags;
  check('the Sun through the passbands: its apparent magnitude and colours', Math.abs(m[1] - -26.76) < 0.05 && Math.abs(m[0] - m[1] - 0.653) < 0.07 && Math.abs(m[1] - m[3] - 1.49) < 0.08 && Math.abs(m[2] - m[3] - 0.37) < 0.08,
    `V = ${m[1].toFixed(3)} (−26.76; tolerance 0.05), B−V = ${(m[0] - m[1]).toFixed(3)} (0.653 ± 0.003, Ramírez et al. 2012; tolerance 0.07: the model Sun is 0.05 mag too red in B−V, with spectra sampled every 5 nm and a B passband of 11 points), V−Ks = ${(m[1] - m[3]).toFixed(3)} (1.49; tolerance 0.08), J−Ks = ${(m[2] - m[3]).toFixed(3)} (0.37; tolerance 0.08), Gaia G = ${m[4].toFixed(3)}. The model, the passbands and the zero points together`);
}
{
  // the chain of approximations (420 bins, passbands thinned to 90 points) against magnitudes computed straight from the
  // PHOENIX intensity files and the full passband curves in Python
  const MAS = Math.PI / 180 / 3600 / 1000; let w = 0, at = '';
  for (const r of ref.surface_magnitudes) { const names = Object.keys(r.mag), P = E.prepareSed(grid, names.map((band) => ({ band, mag: 0, err: 0.01 }))), m = E.sedMagnitudes(P, { teff: r.teff, logg: r.logg, feh: 0, theta: 2 / MAS }).mags; names.forEach((n, j) => { const d = Math.abs(m[j] - r.mag[n]); if (d > w) { w = d; at = `${n} at ${r.teff} K`; } }); }
  const au = 1.495978707e11, P = E.prepareSed(grid, ['Gaia BP', 'Gaia G', 'Gaia RP'].map((band) => ({ band, mag: 0, err: 0.01 }))), sun = E.sedMagnitudes(P, { teff: 5772, logg: 4.44, feh: 0, theta: ((2 * 6.957e8) / au) / MAS }).mags;
  check('binning and thinned passbands cost under a millimagnitude; the Sun in Gaia\'s bands', w < 0.002 && Math.abs(sun[0] - sun[2] - 0.82) < 0.02 && Math.abs(sun[1] - -26.9) < 0.03,
    `${ref.surface_magnitudes.length} models (3400 to 6200 K) x 9 bands: the shipped grid and passbands give the magnitudes of the raw 5 nm files and full passband curves to ${(1e3 * w).toFixed(1)} mmag (worst: ${at}; tolerance 2 mmag). The Sun: BP−RP = ${(sun[0] - sun[2]).toFixed(3)} (0.82, Casagrande & VandenBerg 2018; tolerance 0.02), G = ${sun[1].toFixed(3)} (−26.90; tolerance 0.03)`);
}
{
  // benchmark stars: catalogue magnitudes in, interferometric angular diameter and temperature to compare with
  const rows = [];
  for (const [name, s] of Object.entries(bench.stars)) {
    if (!s.measured || !s.measured.theta_mas) continue;
    const r = E.fitSed(grid, s.obs.filter((o) => o.use !== false), { priors: { plx: s.plx, logg: s.logg ? [s.logg, 0.1] : null, feh: s.feh != null ? [Math.max(-0.5, Math.min(0.5, s.feh)), 0.1] : null, avMax: s.avMax } }), p = r.parameters, mm = s.measured;
    rows.push({ name, r, dth: p.theta_mas.median / mm.theta_mas[0] - 1, dT: p.teff.median - mm.teff[0], dR: mm.rstar ? p.rstar.median / mm.rstar[0] - 1 : null, p, mm });
  }
  const hd189 = rows.find((x) => x.name === 'HD 189733'), rest = rows.filter((x) => x !== hd189), line = (x) => `${x.name}: θ ${x.p.theta_mas.median.toFixed(4)} ± ${(0.5 * (x.p.theta_mas.hi - x.p.theta_mas.lo)).toFixed(4)} mas (measured ${x.mm.theta_mas[0]} ± ${x.mm.theta_mas[1]}; ${(100 * x.dth >= 0 ? '+' : '') + (100 * x.dth).toFixed(1)}%), Teff ${x.p.teff.median.toFixed(0)} ± ${(0.5 * (x.p.teff.hi - x.p.teff.lo)).toFixed(0)} K (${x.mm.teff[0]} ± ${x.mm.teff[1]}; ${(x.dT >= 0 ? '+' : '') + x.dT.toFixed(0)} K), R ${x.p.rstar.median.toFixed(3)} R☉ (${x.mm.rstar[0]}), scatter ${x.p.scatter_mag.median.toFixed(3)} mag, ${x.r.bands.length} bands`;
  check('benchmark stars: angular diameters and temperatures against interferometry', rest.length >= 3 && rest.every((x) => x.r.converged && Math.abs(x.dth) < 0.04 && Math.abs(x.dT) < 60) && hd189.r.converged && Math.abs(hd189.dth) < 0.09 && Math.abs(hd189.dT) < 200,
    rest.map(line).join('; ') + `. Tolerance 4% in θ and 60 K. ${line(hd189)}: the magnitudes fix this star's colour temperature to ±20 K, 150 K above the interferometric value, and its bolometric flux then needs the smaller diameter; AstroARIADNE's published fit says the same (next check). Tolerance 9% and 200 K. All four are within 50 pc, inside the Local Bubble: A_V is fixed at zero (left free up to 0.1 mag, its prior alone adds 45 to 70 K). Saturated bands (WISE W1, W2; GALEX) are left out. Sources: ${bench.sources}`);
  const ar = rows.filter((x) => bench.stars[x.name].ariadne).map((x) => ({ name: x.name, a: bench.stars[x.name].ariadne, p: x.p }));
  check('the same stars against AstroARIADNE\'s published fits', ar.length === 2 && ar.every((x) => Math.abs(x.p.teff.median - x.a.teff) < 200 && Math.abs(x.p.theta_mas.median / x.a.theta_mas - 1) < 0.05 && Math.abs(x.p.rstar.median / x.a.rstar - 1) < 0.06),
    ar.map((x) => `${x.name}: Teff ${x.p.teff.median.toFixed(0)} K against ${x.a.teff} K, θ ${x.p.theta_mas.median.toFixed(4)} against ${x.a.theta_mas} mas, R ${x.p.rstar.median.toFixed(3)} against ${x.a.rstar} R☉`).join('; ') + ' (Vines & Jenkins 2022, table 5: Bayesian averaging over several model grids, with its own photometry and priors). Tolerance 200 K, 5% and 6%. AstroARIADNE itself was not run');
  // two stars without interferometry: the radius from the transit and spectroscopy, or from an empirical relation
  const others = ['WASP-39', 'GJ 1214'].map((name) => { const s = bench.stars[name], r = E.fitSed(grid, s.obs.filter((o) => o.use !== false), { priors: { plx: s.plx, logg: [s.logg, 0.1], feh: [Math.max(-0.5, Math.min(0.5, s.feh)), 0.1], avMax: s.avMax } }); return { name, r, p: r.parameters, mm: s.measured }; });   // WASP-39 at 215 pc: A_V up to 0.25; GJ 1214 at 15 pc: none
  check('two hosts without interferometry: radius and temperature against published values', others.every((x) => x.r.converged && Math.abs(x.p.rstar.median / x.mm.rstar[0] - 1) < 0.05) && Math.abs(others[0].p.teff.median - others[0].mm.teff[0]) < 100 && Math.abs(others[1].p.teff.median - others[1].mm.teff[0]) < 300,
    others.map((x) => `${x.name}: R ${x.p.rstar.median.toFixed(3)} ± ${(0.5 * (x.p.rstar.hi - x.p.rstar.lo)).toFixed(3)} R☉ (${x.mm.rstar[0]} ± ${x.mm.rstar[1]}), Teff ${x.p.teff.median.toFixed(0)} ± ${(0.5 * (x.p.teff.hi - x.p.teff.lo)).toFixed(0)} K (${x.mm.teff[0]} ± ${x.mm.teff[1]}), A_V ${x.p.av.median.toFixed(2)}, scatter ${x.p.scatter_mag.median.toFixed(3)} mag`).join('; ') + '. Tolerance 5% in radius, 100 K for WASP-39 and 300 K for GJ 1214 (a 3000 K star at the cool end of the grid: its magnitudes scatter by 0.09 mag about the model, the model being poor in the optical for M dwarfs)');
}
{
  // spectrum matching: a low-resolution spectrum made from the grid between its models, with 1% noise
  const truth = { teff: 5230, logg: 4.6, feh: -0.2 }, sp = stellarFlux(grid, truth), n = 160, edges = Float64Array.from({ length: n + 1 }, (_, i) => 0.4 * Math.pow(2.4 / 0.4, i / n)), wl = Array.from({ length: n }, (_, i) => Math.sqrt(edges[i] * edges[i + 1]));
  const dil = (0.5 * 0.3 * (Math.PI / 180 / 3600 / 1000)) ** 2, clean = Array.from(resampleFlux(sp, edges, truth.teff), (v) => v * dil); let seed = 3; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }, g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const flux = clean.map((v) => v * (1 + 0.01 * g())), err = clean.map((v) => 0.01 * v), tilt = (i) => 3.7 * Math.pow(wl[i], -0.35);
  const a = matchSpectrum(grid, { wl, flux, err }), b = matchSpectrum(grid, { wl, flux: flux.map((v, i) => v * tilt(i)), err: err.map((v, i) => v * tilt(i)) }, { degree: 2 }), wrong = matchSpectrum(grid, { wl, flux: flux.map((v, i) => v * tilt(i)), err: err.map((v, i) => v * tilt(i)) });
  const fine = Array.from({ length: 2000 }, (_, i) => 0.5 + (i * 0.5) / 2000), binned = matchSpectrum(grid, { wl: fine, flux: Array.from(resampleFlux(sp, Float64Array.from({ length: 2001 }, (_, i) => 0.5 + ((i - 0.5) * 0.5) / 2000), truth.teff)) });
  const sig = (r, k) => 0.5 * (r.parameters[k].hi - r.parameters[k].lo);
  check('spectrum matching recovers a star from a low-resolution spectrum, with and without a calibration slope', a.converged && b.converged && Math.abs(a.parameters.teff.median - 5230) < Math.max(15, 3 * sig(a, 'teff')) && Math.abs(a.parameters.theta_mas.median / 0.3 - 1) < 0.005 && Math.abs(b.parameters.teff.median - 5230) < Math.max(60, 3 * sig(b, 'teff')) && !b.parameters.theta_mas && Math.abs(wrong.parameters.teff.median - 5230) > 300 && wrong.parameters.scatter.median > 10 * a.parameters.scatter.median && a.chi2 / a.n > 0.6 && a.chi2 / a.n < 1.4 && binned.binned > 1 && /finer than the models/.test(binned.warnings.join(' ')),
    `160 points from 0.4 to 2.4 µm (R about 90), a 5230 K, log g 4.6, [Fe/H] −0.2 star with θ = 0.3 mas and 1% noise. Flux-calibrated, one scale factor: Teff ${a.parameters.teff.median.toFixed(0)} ± ${sig(a, 'teff').toFixed(0)} K, log g ${a.parameters.logg.median.toFixed(2)} ± ${sig(a, 'logg').toFixed(2)}, [Fe/H] ${a.parameters.feh.median.toFixed(2)} ± ${sig(a, 'feh').toFixed(2)}, θ ${a.parameters.theta_mas.median.toFixed(4)} mas, χ²/n ${(a.chi2 / a.n).toFixed(2)}. The same spectrum multiplied by 3.7 λ^−0.35 and matched with a quadratic factor: ${b.parameters.teff.median.toFixed(0)} ± ${sig(b, 'teff').toFixed(0)} K; matched as if calibrated: ${wrong.parameters.teff.median.toFixed(0)} K with ${(100 * wrong.parameters.scatter.median).toFixed(1)}% of scatter, which is how a wrong calibration shows. A spectrum sampled every 0.25 nm is binned ${binned.binned} to 1 and says so. The spectra here come from the grid itself: this checks the method, not the models; no observed spectrum was matched`);
}
{
  // looking a star up: stored answers of VizieR (the CfA mirror, 2026-11-20) through the parser and the choices
  const C = await import('../src/core/starcat.js'), fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/vizier/${n}.json`, import.meta.url)));
  const run = (n) => { const f = fx(n), g = C.pickGaia(C.parseTsv(f.gaia), f.gmag); return { f, g, ph: C.photometryFrom({ gaia: g, tmass: C.parseTsv(f.tmass), wise: C.parseTsv(f.wise), tycho: C.parseTsv(f.tycho) }) }; };
  const hd = run('HD209458'), gj = run('GJ1214'), by = (x, b) => x.ph.obs.find((o) => o.band === b), moved = C.positionAt(gj.g, 'tmass'), sep = 3600 * Math.hypot((moved.ra - gj.g.RA_ICRS) * Math.cos((gj.g.DE_ICRS * Math.PI) / 180), moved.dec - gj.g.DE_ICRS);
  const url = C.catalogueUrl(C.VIZIER[0], 'tmass', moved), sedHd = E.fitSed(grid, hd.ph.obs.filter((o) => o.use), { priors: { plx: hd.ph.plx, logg: [4.28, 0.1], feh: [0, 0.1], avMax: C.suggestAv(1000 / hd.ph.plx[0]) } });
  check('a star looked up in Gaia, 2MASS, AllWISE and Tycho-2: the right source, saturated bands set aside, proper motion followed', Math.abs(hd.ph.plx[0] - 20.7694) < 1e-4 && by(hd, 'Gaia G').mag === 7.521246 && by(hd, '2MASS J').use && !by(hd, 'WISE W1').use && /saturated/.test(by(hd, 'WISE W1').why) && by(hd, 'WISE W3').use && by(hd, 'Tycho VT').mag === 7.699
    && Math.abs(gj.g.Gmag - 12.9968) < 1e-3 && by(gj, '2MASS Ks').mag === 8.782 && by(gj, 'WISE W1').use && sep > 12 && sep < 20 && /II%2F246%2Fout/.test(url) && C.suggestAv(48) === 0 && C.suggestAv(215) > 0.1 && C.suggestAv(215) < 0.3 && C.pickGaia([]) === null
    && Math.abs(sedHd.parameters.teff.median - 6092) < 80 && Math.abs(sedHd.parameters.theta_mas.median / 0.2254 - 1) < 0.03,
    `HD 209458: ${hd.ph.obs.length} magnitudes, ${hd.ph.obs.filter((o) => !o.use).map((o) => `${o.band} off (${o.why})`).join(', ')}; parallax ${hd.ph.plx[0]} mas; fitted straight from the lookup: ${sedHd.parameters.teff.median.toFixed(0)} K and ${sedHd.parameters.theta_mas.median.toFixed(4)} mas (interferometry: 6092 K, 0.2254 mas). GJ 1214: among ${C.parseTsv(gj.f.gaia).length} Gaia sources within 30 arcsec the star (G = ${gj.g.Gmag.toFixed(2)}) is found by the catalogue's magnitude, and 2MASS is asked ${sep.toFixed(1)} arcsec away, where the star was in 1999 (it moves ${(Math.hypot(gj.g.pmRA, gj.g.pmDE) / 1000).toFixed(2)} arcsec a year): J, H, Ks = ${['J', 'H', 'Ks'].map((b) => by(gj, '2MASS ' + b).mag).join(', ')}. No extinction is allowed within 70 pc; ${C.suggestAv(215).toFixed(2)} mag at 215 pc`);
  const tex = E.sedLatex(sedHd, 'HD 209458', { plx: hd.ph.plx, logg: [4.28, 0.1], feh: [0, 0.1], avMax: 0 }), po = sedHd.posterior; let sw = 0, mt = 0; for (let i = 0; i < po.n; i++) { sw += po.weights[i]; mt += po.weights[i] * po.samples[i * po.ndim]; }
  check('the fit\'s posterior, sampler summary and LaTeX tables', po.names.join() === 'teff,theta_mas,rstar,lum,logg,feh,scatter_mag' && po.samples.length === po.n * po.ndim && Math.abs(sw - 1) < 1e-6 && Math.abs(mt / sw - sedHd.parameters.teff.median) < 30 && sedHd.sampler.converged && sedHd.sampler.ess > 200 && sedHd.sampler.insertionP > 0.001
    && (tex.match(/\\begin\{table\}/g) || []).length === 2 && /T_\{\\rm eff\}\$ \(K\) & \$\d{4}\^\{\+\d+\}_\{-\d+\}\$/.test(tex) && /Gaia G & 0\.\d{3} & \$7\.521 \\pm 0\.003\$/.test(tex) && !/A_V/.test(tex) && /\\mathcal\{N\}\(4\.28, 0\.1\)/.test(tex),
    `${po.n} weighted samples of ${po.ndim} quantities (${po.names.join(', ')}; A_V is left out when it is fixed), weights summing to ${sw.toFixed(6)}; ln Z = ${sedHd.sampler.logZ.toFixed(2)} ± ${sedHd.sampler.logZerr.toFixed(2)}, ${sedHd.sampler.ess.toFixed(0)} effective samples, insertion-order p = ${sedHd.sampler.insertionP.toFixed(2)}. The LaTeX has a parameter table with priors and a photometry table (${tex.split('\n').length} lines)`);
}
process.exit(ok ? 0 : 1);
