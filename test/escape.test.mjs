// Escape and ionization estimates (src/core/escape.js, src/core/ionization.js) against: the table of the owner's
// mass-fractionation notes (github.com/pearsonkyle/Exoplanet-Mass-Fractionation, Table 2), closed forms, textbook
// values for hydrogen, and an independent evaluation of the published fits (a separate script written from the
// papers' formulas while reading github.com/pearsonkyle/Exoplanet-Ionization). Every tolerance is stated in its check.
import * as E from '../src/core/escape.js';
import * as I from '../src/core/ionization.js';
import { buildAtmosphere } from '../src/core/atmosphere.js';
import { C } from '../src/core/derive.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ex = (x) => x.toExponential(2);

// ---- 1. energy-limited escape: the notes' table, with the notes' constants for the planets' sizes ------------------
{
  const RJ = 6.9911e7, MJ = 1.898e27, MS = 1.989e30, AU = 1.496e11;   // as used there (SI)
  const rows = [
    { name: 'GJ 1214 b', m: 0.0203507, r: 0.2389, a: 0.0143253, ms: 0.157, T: 559.4, L: 2.87e19, mdot: 1.463e6, K: 0.667, ruv2: 1.730 },
    { name: 'HD 97658 b', m: 0.024739, r: 0.208761, a: 0.0796373, ms: 0.748, T: 732.6, L: 3.10e21, mdot: 1.971e6, K: 0.916, ruv2: 1.667 },
  ];
  let w = 0; const out = [];
  for (const p of rows) {
    const M = p.m * MJ, R = p.r * RJ, { K } = E.rocheFactor({ a: p.a * AU, rplanet: R, mplanet: M, mstar: p.ms * MS }), { rxuv } = E.xuvRadius({ rplanet: R, mplanet: M, T: p.T });
    const mdot = E.energyLimited({ fxuv: p.L / (4 * Math.PI * (p.a * AU) ** 2), rplanet: R, rxuv, mplanet: M, eta: 0.2, K });
    w = Math.max(w, Math.abs(mdot / p.mdot - 1), Math.abs(K / p.K - 1), Math.abs((rxuv / R) ** 2 / p.ruv2 - 1));
    const he = E.crossoverMass({ mdot, rplanet: R, mplanet: M, T: p.T, species: 'He' }), o = E.crossoverMass({ mdot, rplanet: R, mplanet: M, T: p.T, species: 'O' });
    out.push(`${p.name}: ${ex(mdot * 1e3)} g/s (notes ${ex(p.mdot * 1e3)}), K ${K.toFixed(3)}, (R_xuv/R)² ${((rxuv / R) ** 2).toFixed(3)}; crossover mass ${he.mc.toFixed(1)} amu with the measured H-He diffusion, ${o.mc.toFixed(1)} with H-O`);
  }
  check('energy-limited mass loss reproduces the table of the mass-fractionation notes', w < 0.015,
    `${out.join('. ')}. Largest difference in the rate, K and (R_xuv/R)² ${(100 * w).toFixed(2)}% (tolerance 1.5%: the constants differ in the fourth digit). The notes' crossover masses (24.5 and 30.8 amu) are not reproduced and are not a reference: their diffusion coefficient was evaluated with masses in grams where the table wanted amu, and doubled`);
  const xi = 3, k = E.rocheFactor({ a: 3, rplanet: 1, mplanet: 3, mstar: 1 }).K;
  check('Roche factor', Math.abs(k - (1 - 1.5 / xi + 0.5 / 27)) < 1e-15 && Math.abs(E.rocheFactor({ a: 1e6, rplanet: 1, mplanet: 3, mstar: 1 }).K - 1) < 2e-6, `K = ${k.toFixed(6)} at ξ = 3 (1 - 3/2ξ + 1/2ξ³ = 0.518519); 1 far from the star`);
}
// ---- 2. crossover mass, fractionation, diffusion ----------------------------------------------------------------------
{
  const M = 0.05 * C.Mjup_Msun * C.Msun, R = 0.25 * C.Rjup, T = 800, mdot = 1e7, c = E.crossoverMass({ mdot, rplanet: R, mplanet: M, T, species: 'He', xH: 0.9 });
  const g = (C.G * M) / (R * R), F = mdot / (4 * Math.PI * R * R * 1.008 * 1.66053906660e-27), b = 1.04e18 * T ** 0.732 * 100, want = 1.008 + (1.380649e-23 * T * F) / (b * g * 0.9 * 1.66053906660e-27);
  const none = E.crossoverMass({ mdot: 0, rplanet: R, mplanet: M, T }).mc;
  check('crossover mass (Hunten, Pepin & Walker 1987)', Math.abs(c.mc / want - 1) < 1e-12 && Math.abs(none - 1.008) < 1e-12 && E.fractionation(4.0026, 3) === 0 && Math.abs(E.fractionation(1.008, 9) - 1) < 1e-15 && Math.abs(E.fractionation(4.0026, 9) - (9 - 4.0026) / (9 - 1.008)) < 1e-15,
    `m_c = m_H + kTF/(b g X_H) = ${c.mc.toFixed(3)} amu for 1e7 kg/s from a 0.05 M_Jup, 0.25 R_Jup planet at 800 K (by hand ${want.toFixed(3)}); m_H with no wind; a species above m_c keeps all of itself (factor 0), hydrogen has factor 1, helium under m_c = 9 has ${E.fractionation(4.0026, 9).toFixed(3)}`);
  const ratios = ['He', 'D'].map((s) => [s, E.diffusionScaled(E.ATOM[s], 1000) / E.diffusionB(s, 1000), E.diffusionScaled(E.ATOM[s], 5000) / E.diffusionB(s, 5000)]);
  check('diffusion coefficients: scaling the measured H-O value by reduced mass', ratios.every((r) => r[1] > 0.5 && r[1] < 1.5 && r[2] > 0.5 && r[2] < 1.5) && Math.abs(E.diffusionB('O', 1000) / (4.8e17 * 1000 ** 0.75 * 100) - 1) < 1e-15 && E.diffusionB('C', 1000) > E.diffusionB('O', 1000),
    `predicted over measured (Mason & Marrero power laws) for ${ratios.map((r) => `${r[0]}: ${r[1].toFixed(2)} at 1000 K, ${r[2].toFixed(2)} at 5000 K`).join('; ')}; tolerance 0.5 to 1.5. C, N, S and Na have no measured value here and get this scaling, so their crossover masses carry about that uncertainty. H-He at 1000 K: ${ex(E.diffusionB('He', 1000) / 100)} cm⁻¹ s⁻¹; H-C ${ex(E.diffusionB('C', 1000) / 100)}`);
  check('Rayleigh distillation and the Sun\'s XUV flux', Math.abs(E.enrichment(0.25, 0) - 4) < 1e-15 && E.enrichment(0.25, 1) === 1 && Math.abs(E.enrichment(0.25, 0.5) - 2) < 1e-15 && Math.abs(E.solarXuv(4.57) * 1e3 / 4.58 - 1) < 0.01 && E.solarXuv(0.01) === E.solarXuv(0.1),
    `losing three quarters of the hydrogen enriches a species that stays fourfold, one that leaves with it not at all, one with factor 0.5 twofold; 29.7 t^-1.23 gives ${(E.solarXuv(4.57) * 1e3).toFixed(2)} erg cm⁻² s⁻¹ at 1 AU for the Sun today (Ribas et al. 2005 measure 4.64), held constant before 0.1 Gyr`);
}
// ---- 3. the time integral ----------------------------------------------------------------------------------------------
{
  const base = { mplanet: 0.02, rplanet: 0.24, mstar: 0.5, a: 0.06, T: 700, ageGyr: 5, t0Gyr: 0.01, envelope: 0.02, eta: 0.2 };
  const flat = E.escapeHistory({ ...base, fxuvOf: () => 1e-3 }), yr = 3.15576e7 * 1e9, want = flat.now.mdot * (5 - 0.01) * yr, env = 0.02 * 0.02 * C.Mjup_Msun * C.Msun;
  const f = 1 - want / env, xHe = flat.now.x.He, rib = E.escapeHistory({ ...base, a: 0.15 }), fine = E.escapeHistory({ ...base, a: 0.15, steps: 2000 });
  check('escape through time: a constant flux gives rate x time, and the enrichment of the closed form', Math.abs(flat.lostMass / want - 1) < 1e-9 && Math.abs(flat.remaining / f - 1) < 1e-6 && Math.abs(flat.enrich.He / Math.pow(f, xHe - 1) - 1) < 1e-6 && Math.abs(rib.lostMass / fine.lostMass - 1) < 2e-3 && rib.track.every((s, i) => i === 0 || s.mdot <= rib.track[i - 1].mdot),
    `0.02 M_Jup, 0.24 R_Jup, 2% envelope, 0.06 AU, constant 1e-3 W m⁻² at 1 AU for 4.99 Gyr: ${ex(flat.lostMass)} kg lost against ${ex(want)}; hydrogen remaining ${flat.remaining.toFixed(4)} against ${f.toFixed(4)}; He/H enriched ${flat.enrich.He.toFixed(4)} times against f^(x-1) = ${Math.pow(f, xHe - 1).toFixed(4)}. With the Sun's history (Ribas) at 0.15 AU: ${(100 * rib.lostShare).toFixed(1)}% of the envelope lost, 200 log-time steps within ${ex(Math.abs(rib.lostMass / fine.lostMass - 1))} of 2000, the rate falling throughout; today ${ex(rib.now.mdot * 1e3)} g/s, crossover masses He ${rib.now.mc.He.toFixed(2)}, O ${rib.now.mc.O.toFixed(2)} amu`);
}
// ---- 4. ionization: the published fits ---------------------------------------------------------------------------------
{
  const rel = (a, b) => Math.abs(a / b - 1);
  const sig = [[241, 7.56e-20], [200, 1.42e-22], [100, 1.25e-19], [50, 9.05e-20], [10, 1.01e-20]].map(([l, v]) => rel(I.photoCrossSection('Na', l), v));
  const ci = [[1200, 1.526e-29], [1500, 3.157e-25], [1800, 2.408e-22]].map(([T, v]) => rel(I.collisionalIonization('Na', T), v)), rr = [[1200, 1.133e-12], [1500, 9.498e-13], [1800, 8.205e-13]].map(([T, v]) => rel(I.radiativeRecombination('Na', T), v));
  const a3 = rel(I.threeBodyRecombination(1500, 4.831e19), 9.46e-8), w = Math.max(...sig, ...ci, ...rr, a3);
  check('sodium: photoionization, electron-impact and recombination fits', w < 6e-3 && I.photoCrossSection('Na', 242) === 0,
    `against an independent evaluation of the same published fits (Verner et al. 1996; Voronov 1997; Verner & Ferland 1996): cross-section at 241, 200, 100, 50, 10 nm, rate coefficients at 1200, 1500, 1800 K, three-body recombination at 1500 K and 4.83e19 cm⁻³: largest difference ${ex(w)} (tolerance 6e-3: the reference values have three or four digits); zero beyond the 241.3 nm threshold. σ(241 nm) = ${ex(I.photoCrossSection('Na', 241))} cm², with the Cooper minimum near 200 nm (${ex(I.photoCrossSection('Na', 200))})`);
  const sH = I.photoCrossSection('H', 91.1), aH = I.radiativeRecombination('H', 1e4);
  check('hydrogen: the same fits give the textbook values', rel(sH, 6.30e-18) < 0.02 && rel(aH, 4.18e-13) < 0.03,
    `threshold cross-section ${ex(sH)} cm² (6.30e-18) and total radiative recombination at 10⁴ K ${ex(aH)} cm³ s⁻¹ (case A, 4.18e-13; Osterbrock & Ferland 2006); tolerance 2% and 3%. This checks the formulas and their units on an atom whose values are known; sodium's are checked above against a second evaluation only`);
}
// ---- 5. ionization: the balance in an atmosphere -----------------------------------------------------------------------
{
  const atm = buildAtmosphere({ mplanet: 0.57, rplanet: 0.97, tp: 1300, nLayers: 60, pTop: 1e-9, pBottom: 10 }), x = new Float64Array(60).fill(4e-7);
  const flux = (nm) => I.blackbodyPhotons(nm, 5340, 1 / 8), r = I.ionizationProfile(atm, x, { flux }), dark = I.ionizationProfile(atm, x, { flux: () => 0 }), thin = I.ionizationProfile(atm, x.map((v) => v * 1e-6), { flux });
  // the rate equation closes in every layer
  let res = 0; for (let j = 0; j < 60; j++) {
    const nt = atm.nd[j] * 1e-6, T = atm.tLay[j], xi = r.ion[j] * x[j], gain = (x[j] - xi) * (r.J[j] + I.collisionalIonization('Na', T) * nt * xi), loss = (I.radiativeRecombination('Na', T) + I.threeBodyRecombination(T, nt)) * nt * xi * xi;
    res = Math.max(res, Math.abs(gain - loss) / Math.max(gain, loss, 1e-300));
  }
  const mono = r.J.every((v, j) => j === 0 || v <= r.J[j - 1] * (1 + 1e-12)), e = I.ionizationProfile(atm, x, { flux, electrons: new Float64Array(60).fill(1e-6) });
  check('sodium in an atmosphere: the balance closes, light is used up on the way down, electrons push it back', res < 1e-9 && mono && r.ion[0] > 0.99 && r.ion[59] < 1e-3 && dark.ion[30] < 1e-6 && thin.J[59] > r.J[59] && e.ion[35] < r.ion[35] && r.half > 1e-7 && r.half < 1,
    `a 1300 K isothermal atmosphere, Na at 4e-7, a 5340 K blackbody star at a/R★ = 8, day-side mean slant: ionized share ${r.ion[0].toFixed(4)} at ${ex(atm.pLay[0] / 1e5)} bar, ${ex(r.ion[59])} at ${(atm.pLay[59] / 1e5).toFixed(1)} bar, one half at ${ex(r.half)} bar; rate equation residual ${ex(res)}; the photoionization rate falls from ${ex(r.J[0])} to ${ex(r.J[59])} s⁻¹ downward (with a millionth of the sodium, hence no shielding, ${ex(thin.J[59])}); with no starlight ${ex(dark.ion[30])} is ionized at ${ex(atm.pLay[30] / 1e5)} bar; a background of electrons at 1e-6 lowers the ionized share at ${ex(atm.pLay[35] / 1e5)} bar from ${r.ion[35].toFixed(3)} to ${e.ion[35].toFixed(3)}. The star is a blackbody here: its real ultraviolet differs by factors of several either way`);
}
// ---- 5b. potassium, and recombination by detailed balance ---------------------------------------------------------------
{
  const aH = I.milneRecombination('H', 1e4), sK = I.photoCrossSection('K', 285), gNa = I.milneRecombination('Na', 1000) / I.radiativeRecombination('Na', 1000), gK = I.milneRecombination('K', 1000) / I.radiativeRecombination('K', 1000);
  const atm = buildAtmosphere({ mplanet: 0.57, rplanet: 0.97, tp: 1300, nLayers: 60, pTop: 1e-9, pBottom: 10, vmr: { Na: 4e-7, K: 2e-8 } }), r = I.ionizeAtmosphere(atm, { teff: 5340, ars: 8 });
  check('potassium: cross-section, and recombination by detailed balance on hydrogen', Math.abs(aH / 1.58e-13 - 1) < 0.02 && sK > 1e-21 && sK < 1e-19 && I.photoCrossSection('K', 286.5) === 0 && gNa < 1e-2 && gK < 1e-2 && r.K.half > r.Na.half && r.K.ion[0] > 0.99,
    `the Milne relation applied to hydrogen's cross-section gives ${ex(aH)} cm³ s⁻¹ to the ground state at 10⁴ K (textbook 1.58e-13; tolerance 2%). Potassium (Verner & Yakovlev 1995, the 4s shell, coefficients from Verner's phfit2.f): ${ex(sK)} cm² at 285 nm, zero beyond the 285.6 nm threshold. Ground-state recombination is ${ex(gNa)} of sodium's total and ${ex(gK)} of the rate used for potassium (sodium's), so both go through excited states; potassium's rate is an estimate. In the test atmosphere potassium is half ionized at ${ex(r.K.half)} bar, deeper than sodium's ${ex(r.Na.half)} bar (its threshold is at longer wavelength, where the star is brighter)`);
}
// ---- 6. hydrogen and sodium together -------------------------------------------------------------------------------------
{
  const mk = () => buildAtmosphere({ mplanet: 0.57, rplanet: 0.97, tp: 1300, nLayers: 60, pTop: 1e-9, pBottom: 10, vmr: { Na: 4e-7, H: 1e-4, 'e-': 1e-12 } });
  const a = mk(), r = I.ionizeAtmosphere(a, { teff: 5340, ars: 8, fxuv: 2 }), b = mk(), noH = I.ionizeAtmosphere(b, { teff: 5340, ars: 8, fxuv: 0 });
  const charge = Math.max(...Array.from({ length: 60 }, (_, j) => Math.abs(a.species['e-'][j] - (1e-12 + 4e-7 * r.Na.ion[j] + 1e-4 * r.H.ion[j])) / a.species['e-'][j]));
  let j = 0; for (let q = 0; q < 60; q++) if (noH.Na.ion[q] - r.Na.ion[q] > noH.Na.ion[j] - r.Na.ion[j]) j = q;
  const photons = I.xuvPhotons(50, 2) * 81.2;
  check('hydrogen and sodium ionized together share their electrons', charge < 1e-12 && r.H.ion[0] > 0.9 && r.H.ion[59] < 1e-6 && r.Na.ion[j] < noH.Na.ion[j] && Math.abs(a.species.Na[j] / (4e-7 * r.Na.neutral[j]) - 1) < 1e-12 && Math.abs(photons / ((2 / ((6.62607015e-34 * 299792458) / 50e-9)) * 1e-4) - 1) < 1e-12 && !noH.H,
    `a 1300 K atmosphere with Na 4e-7 and atomic H 1e-4, 2 W m⁻² of extreme ultraviolet: hydrogen ${r.H.ion[0].toFixed(3)} ionized at the top, half at ${r.H.half ? ex(r.H.half) : 'none'} bar, shielded below (${ex(r.H.ion[59])} at 8 bar); sodium half at ${ex(r.Na.half)} bar. Electrons equal the ions of both plus those given, to ${ex(charge)}; hydrogen's electrons push sodium back toward neutral (ionized share at ${ex(a.pLay[j] / 1e5)} bar ${r.Na.ion[j].toFixed(4)} against ${noH.Na.ion[j].toFixed(4)} without them, the largest change of any layer: hydrogen is ionized only where sodium already is); the species' mixing ratios become their neutral parts. Potassium and molecules are not treated`);
}
process.exit(ok ? 0 : 1);
