// The atmosphere forward model's parts (src/core/atmosphere.js, transmission.js, emission.js, continuum.js, colour.js)
// against independent references (test/make_atmosphere_reference.py -> atmosphere_reference.json): adaptive
// quadrature in scipy for the hydrostatic radii, the transit radius and the emergent flux; the closed form of
// Heng & Kitzmann (2017); petitRADTRANS 3.4.0's own H- functions; colour-science's tabulated CIE 1931 functions.
// Every tolerance is stated in its check.
import { readFileSync } from 'node:fs';
import * as A from '../src/core/atmosphere.js';
import * as T from '../src/core/transmission.js';
import * as E from '../src/core/emission.js';
import * as K from '../src/core/continuum.js';
import * as Col from '../src/core/colour.js';
import { planckSI } from '../src/core/phasecurve.js';
import { C } from '../src/core/derive.js';
import * as V from '../src/viz/atmoview.js';
import { tabulatedDepth } from '../src/core/spectroscopy.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./atmosphere_reference.json', import.meta.url)));
const ex = (x) => x.toExponential(1);

// ---- 1. hydrostatic radii ----------------------------------------------------------------------------------------
{
  const c = ref.hydro.case, got = {};
  for (const n of [40, 80, 320]) {
    const atm = A.buildAtmosphere({ mplanet: c.mplanet, rplanet: c.rplanet, pRef: c.pRef, pTop: 1e-6, pBottom: 100, nLayers: n, fill: false, vmr: { H2: 1 }, tp: { kind: 'guillot', teq: c.teq, tint: c.tint, kappaIR: c.kappaIR, gamma: c.gamma } });
    let w = 0;
    ref.hydro.levels.forEach((p, k) => { const i = Math.round((k * n) / 8); w = Math.max(w, Math.abs(atm.rLev[i] - ref.hydro.radius[k]) / (ref.hydro.radius[0] - ref.hydro.radius[8])); });
    got[n] = w;
  }
  check('hydrostatic radii of a Guillot profile under g = GM/r² match quadrature', got[80] < 1e-3 && got[320] < 1e-4 && got[320] < got[40] / 30,
    `max difference over 9 levels from 1e-6 to 100 bar, as a fraction of the atmosphere's thickness (${((ref.hydro.radius[0] - ref.hydro.radius[8]) / 1e3).toFixed(0)} km): ${ex(got[40])} with 40 layers, ${ex(got[80])} with 80, ${ex(got[320])} with 320; tolerance 1e-3 at 80 and 1e-4 at 320. The only error is the layering of T (isothermal layers), second order in the layer thickness`);
  const f = A.guillot({ teq: c.teq, tint: c.tint, kappaIR: c.kappaIR, gamma: c.gamma, g: (C.GMsun * c.mplanet * C.Mjup_Msun) / (c.rplanet * C.Rjup) ** 2 });
  const wT = Math.max(...ref.hydro.levels.map((p, k) => Math.abs(f(p) - ref.hydro.t[k])));
  check('Guillot (2010) eq. 29 temperatures', wT < 1e-9, `max ${ex(wT)} K against the same formula written independently in Python; tolerance 1e-9 K`);
  const iso = A.guillot({ teq: 1000, tint: 0, kappaIR: 1e-3, gamma: 1, g: 10 });
  check('... limit gamma = 1, Tint = 0 is isothermal at (1 + 1/√3·... ) Teq', Math.abs(iso(1e-6) - iso(100)) < 1e-9 && Math.abs(iso(1) - 1000 * Math.pow(0.75 * (2 / 3 + 1 / Math.sqrt(3)), 0.25)) < 1e-9,
    `T = ${iso(1).toFixed(3)} K at every pressure = Teq (3/4 (2/3 + 1/√3))^¼ for Teq = 1000 K; tolerance 1e-9 K`);
  const ms = A.madhusudhanSeager({ t0: 800, a1: 0.5, a2: 0.4, p1: 1e-3, p2: 1e-2, p3: 1, p0: 1e-6 });
  const cont = Math.max(Math.abs(ms(1e-3 * (1 - 1e-12)) - ms(1e-3 * (1 + 1e-12))), Math.abs(ms(1 - 1e-12) - ms(1 + 1e-12)));
  check('Madhusudhan & Seager (2009) profile is continuous at P1 and P3', cont < 1e-6 && ms(1e-2) < ms(1e-3), `jump ${ex(cont)} K; with P2 > P1 the temperature falls from ${ms(1e-3).toFixed(0)} K at P1 to ${ms(1e-2).toFixed(0)} K at P2 (an inversion) and reaches ${ms(10).toFixed(0)} K below P3`);
}

// ---- 2. transit radius ---------------------------------------------------------------------------------------------
const transit = (c, n) => {
  const atm = A.buildAtmosphere({ mplanet: c.mplanet, rplanet: c.rplanet, pRef: c.p_ref, pTop: c.p_top, pBottom: c.p_bottom, nLayers: n, fill: false, vmr: { H2: 1 }, tp: c.temp, constantG: c.constant_g });
  const alpha = Float64Array.from(atm.nd, (nd, i) => c.kappa * nd * atm.mu[i] * A.M_U);
  return { r: T.transmissionSpectrum(atm, alpha, C.Rsun).radius[0], atm };
};
{
  const rows = [], perDecade = [5, 10, 20, 40];
  let pass = true, worst = {};
  for (const t of ref.transit) {
    const decades = Math.log10(t.case.p_bottom / t.case.p_top), err = perDecade.map((d) => (transit(t.case, Math.round(d * decades)).r - t.radius) / t.H);
    perDecade.forEach((d, i) => { worst[d] = Math.max(worst[d] || 0, Math.abs(err[i])); });
    rows.push(`${t.case.constant_g ? 'g const' : 'g ∝ 1/r²'} κ ${t.case.kappa} H/R ${(t.H / t.r0).toFixed(4)}: ${err.map((e) => e.toFixed(5)).join(' ')}`);
    if (!(Math.abs(err[0]) < 0.02 && Math.abs(err[1]) < 0.005 && Math.abs(err[3]) < 3e-4)) pass = false;
  }
  check('transit radius of an isothermal atmosphere with constant opacity matches quadrature', pass,
    `error in scale heights at 5, 10, 20, 40 layers per decade of pressure: worst ${perDecade.map((d) => worst[d].toFixed(5)).join(', ')} over 7 cases (mass opacity 1e-4 to 1 m²/kg, constant and inverse-square gravity, H/R up to 0.047); tolerance 0.02 H at 5 per decade, 0.005 H at 10, 3e-4 H at 40 (second order in the layer thickness). One scale height is ${(2 * ref.transit[0].H * ref.transit[0].r0 / C.Rsun ** 2 * 1e6).toFixed(0)} ppm of depth for this planet and a solar-radius star. ` + rows.join(' | '));
  // the closed form is first order in H/R: compare where H/R = 0.004 and gravity is constant
  let w = 0; const got = [];
  for (const t of ref.transit.filter((x) => x.case.constant_g)) {
    const an = T.isothermalRadius({ r0: t.r0, H: t.H, p0: t.case.p_ref * 1e5, kappa: t.case.kappa, g: t.g }), d = (an - t.radius) / t.H;
    got.push(d.toFixed(4)); w = Math.max(w, Math.abs(d));
  }
  check('closed form of Heng & Kitzmann (2017) eq. 8 agrees with the quadrature to first order in H/R', w < 0.05, `closed form minus quadrature, in scale heights: ${got.join(', ')} for κ = 1e-4, 1e-2, 1 m²/kg at H/R = ${(ref.transit[0].H / ref.transit[0].r0).toFixed(4)}; tolerance 0.05 H (the formula drops terms of order H/R times the height in scale heights)`);
  // Rayleigh slope: with sigma ∝ lambda^-4 the radius falls by 4 H per unit of ln(lambda)
  const atm = A.buildAtmosphere({ mplanet: 1, rplanet: 1.2, pRef: 10, pTop: 1e-10, pBottom: 1e3, nLayers: 260, tp: 1500, constantG: true });
  const wl = [0.4, 0.5, 0.6], ext = new Float64Array(wl.length * atm.n); K.addContinuum(atm, wl, ext);
  const R = T.transmissionSpectrum(atm, ext, C.Rsun).radius, H = (A.K_B * 1500) / (atm.mu[0] * A.M_U * atm.gRef);
  const slope = (R[2] - R[0]) / H / Math.log(wl[2] / wl[0]);
  const lnS = Math.log((K.rayleighH2(0.6) * atm.species.H2[0] + K.rayleighHe(0.6) * atm.species.He[0]) / (K.rayleighH2(0.4) * atm.species.H2[0] + K.rayleighHe(0.4) * atm.species.He[0])) / Math.log(1.5);
  check('Rayleigh slope dR/dlnλ = H dlnσ/dlnλ', Math.abs(slope - lnS) < 0.01, `${slope.toFixed(4)} H per e-fold of wavelength against ${lnS.toFixed(4)} (the H2 + He cross-section's own slope between 0.4 and 0.6 µm; -4 plus the λ⁻⁶ and λ⁻⁸ terms); tolerance 0.01`);
  check('exponential integral E1', Math.abs(T.expint1(0.5) - 0.5597735947761608) < 1e-15 && Math.abs(T.expint1(2) - 0.04890051070806112) < 1e-15 && Math.abs(T.expint1(30) - 3.0215520106888125e-15) < 1e-28,
    'E1(0.5), E1(2), E1(30) against Abramowitz & Stegun table 5.1 / scipy.special.exp1; tolerance 1e-15 absolute, 1e-13 relative at 30');
}

// ---- 3. emission ---------------------------------------------------------------------------------------------------
{
  const c = ref.emission.case, r0 = C.Rjup, mplanet = (c.g * r0 * r0) / (C.GMsun * C.Mjup_Msun);
  const run = (n, nmu = 8) => {
    const atm = A.buildAtmosphere({ mplanet, rplanet: 1, pRef: 1, pTop: c.pTop, pBottom: c.pBottom, nLayers: n, constantG: true, fill: false, vmr: { H2: 1 }, tp: { kind: 'guillot', teq: c.teq, tint: c.tint, kappaIR: c.kappaIR, gamma: c.gamma } });
    const ext = new Float64Array(c.wl.length * n); for (let i = 0; i < c.wl.length; i++) for (let j = 0; j < n; j++) ext[i * n + j] = c.kappa * atm.nd[j] * atm.mu[j] * A.M_U;
    return E.emissionSpectrum(atm, c.wl, ext, { nmu }).flux;
  };
  const err = (f) => Math.max(...c.wl.map((w, i) => Math.abs(f[i] / ref.emission.flux[i] - 1)));
  const e = [55, 110, 220, 440].map((n) => err(run(n))), e4 = err(run(440, 4)), e16 = err(run(440, 16));
  check('emergent flux of a grey atmosphere with a Guillot profile matches quadrature', e[1] < 5e-3 && e[3] < 5e-4,
    `max relative difference at 1, 3 and 10 µm: ${e.map(ex).join(', ')} with 5, 10, 20, 40 layers per decade (11 decades); tolerance 5e-3 at 10 per decade, 5e-4 at 40. With 4 and 16 angles instead of 8 (40 per decade): ${ex(e4)}, ${ex(e16)}. Reference: F = 2π[∫B(T(τ))E₂(τ)dτ + B E₃(τmax)]`);
  const atm = A.buildAtmosphere({ mplanet: 1, rplanet: 1, tp: 1500, nLayers: 40 }), wl = [1, 5, 10];
  const f = E.emissionSpectrum(atm, wl, new Float64Array(3 * 40).fill(1e-6), { contribution: true });
  const d = Math.max(...wl.map((w, i) => Math.abs(f.flux[i] / (Math.PI * planckSI(w, 1500)) - 1)));
  let s = 0; for (let k = 0; k <= 40; k++) s += f.contribution[k];
  check('an isothermal atmosphere emits the blackbody', d < 1e-14 && Math.abs(f.brightness[1] - 1500) < 1e-9 && Math.abs(s - 1) < 1e-6, `flux / πB - 1 = ${ex(d)}; brightness temperature ${f.brightness[1].toFixed(9)} K; contribution function sums to ${s.toFixed(7)}`);
  const sb = (() => { let t = 0; const g = E.gaussLegendre01(8); for (let i = 0; i < 4000; i++) { const w = 0.05 * Math.pow(4000, (i + 0.5) / 4000), dw = w * Math.log(4000) / 4000; t += Math.PI * planckSI(w, 1500) * dw; } return [t, g]; })();
  check('Planck function integrates to σT⁴', Math.abs(sb[0] / (5.670374419e-8 * 1500 ** 4) - 1) < 1e-4, `∫πB dλ over 0.05-200 µm / σT⁴ - 1 = ${ex(sb[0] / (5.670374419e-8 * 1500 ** 4) - 1)}; tolerance 1e-4 (the range holds all but 3e-5 of the flux at 1500 K)`);
  const wr = [0.8, 2, 4.5, 10], rprs = 0.1, fr = E.fluxRatio(wr, wr.map((w) => Math.PI * planckSI(w, 1500)), rprs, { teff: 5000 });
  const h = 6.62607015e-34, cl = 299792458, kb = 1.380649e-23, x = (w, t) => (h * cl) / (w * 1e-6 * kb * t);
  const dfr = Math.max(...wr.map((w, i) => Math.abs(fr[i] / (rprs * rprs * Math.expm1(x(w, 5000)) / Math.expm1(x(w, 1500))) - 1)));
  const fs = E.fluxRatio(wr, [1, 2, 3, 4], 0.5, { flux: [10, 10, 10, 10] }), bt = Math.max(...wr.map((w) => Math.abs(E.brightnessOf(planckSI(w, 1234.5), w) - 1234.5)));
  check('eclipse depth of two blackbodies and the brightness temperature', dfr < 1e-9 && Math.abs(fs[2] - 0.075) < 1e-15 && bt < 1e-8 && E.brightnessOf(0, 1) === 0,
    `(Rp/R★)² (e^x★ - 1)/(e^xp - 1) with x = hc/λkT from the SI constants: max relative difference ${ex(dfr)} at 0.8-10 µm (1500 K planet, 5000 K star, tolerance 1e-9); with a tabulated stellar flux the ratio is taken bin by bin; inverting the Planck function returns 1234.5 K to ${ex(bt)} K`);
  const gsum = sb[1].w.reduce((a, b) => a + b, 0), gm = sb[1].x.reduce((a, x, i) => a + x ** 15 * sb[1].w[i], 0);
  check('Gauss-Legendre nodes on [0, 1]', Math.abs(gsum - 1) < 1e-14 && Math.abs(gm - 1 / 16) < 1e-14, `8 nodes: Σw - 1 = ${ex(gsum - 1)}, ∫μ¹⁵ - 1/16 = ${ex(gm - 1 / 16)} (exact to degree 15)`);
}

// ---- 4. continuum ----------------------------------------------------------------------------------------------------
{
  const h = ref.hminus;
  const dbf = Math.max(...h.wl_bf.map((w, i) => (h.bf[i] === 0 ? K.hMinusBoundFree(w) : Math.abs(K.hMinusBoundFree(w) / h.bf[i] - 1))));
  let dff = 0; for (const t of Object.keys(h.ff)) h.wl_ff.forEach((w, i) => { const a = K.hMinusFreeFree(w, +t), b = h.ff[t][i]; dff = Math.max(dff, b === 0 ? a : Math.abs(a / b - 1)); });
  check(`H- bound-free and free-free match petitRADTRANS ${h.version}`, dbf < 1e-6 && dff < 1e-12, `max relative difference ${ex(dbf)} (bound-free at 0.4-1.6 µm, zero at 1.7 µm in both; petitRADTRANS averages over a bin 2e-7 wide) and ${ex(dff)} (free-free at 0.5-10 µm, 3000 and 6000 K; zero at 2400 K in both); bound-free at 0.85 µm ${ex(K.hMinusBoundFree(0.85))} cm² per ion`);
  check('H2 Rayleigh cross-section', Math.abs(K.rayleighH2(0.5) / 1.38844e-27 - 1) < 2e-5 && Math.abs(K.haze(0.7, { factor: 3, slope: -2 }) / (3 * K.rayleighH2(0.35) * 0.25) - 1) < 1e-14,
    `${K.rayleighH2(0.5).toExponential(4)} cm² at 0.5 µm from Dalgarno & Williams (1962), 8.14e-13/λ⁴ + 1.28e-6/λ⁶ + 1.61/λ⁸ with λ in Å, whose terms by hand are 1.3024e-27 + 8.192e-29 + 4.122e-30 = 1.38844e-27 (tolerance 2e-5); the same three coefficients are in petitRADTRANS's h2_rayleigh. Haze: factor × σ(0.35 µm) × (λ/0.35)^slope`);
  const he = K.rayleighHe(0.5), pol = (2.265983321 - 3.721350022 * 0.5 + 3.016150391 * 0.25) * 1.482e-25;
  check('He Rayleigh cross-section', Math.abs(he / ((128 * Math.PI ** 5 / 3) * pol * pol / (0.5e-4) ** 4) - 1) < 1e-14 && he < K.rayleighH2(0.5) / 10, `${he.toExponential(3)} cm² at 0.5 µm, ${(K.rayleighH2(0.5) / he).toFixed(1)} times smaller than H2 (polarisability fit of Chan & Dalgarno 1965 as in petitRADTRANS's he_rayleigh)`);
}

// ---- 4b. aerosols and the Rayleigh scattering of other gases ---------------------------------------------------------
{
  const R = ref.rayleigh; let lo = 9, hi = 0; const per = [];
  for (const [sp, sig] of Object.entries(R.sigma)) { const q = R.wl.map((w, i) => K.rayleighGas(sp, w) / sig[i]); if (sp !== 'CO') { lo = Math.min(lo, ...q); hi = Math.max(hi, ...q); } per.push(`${sp} ${q[2].toFixed(2)}`); }
  const co = K.rayleighGas('CO', 1) / R.sigma.CO[2];
  check('Rayleigh cross-sections of H2O, CO2, CH4, N2, O2 from their polarisabilities', lo > 0.7 && hi < 1.2 && co > 1.5 && co < 2.1,
    `ratio to petitRADTRANS ${ref.hminus.version}'s values at ${R.wl.join(', ')} µm: ${lo.toFixed(2)} to ${hi.toFixed(2)} (tolerance 0.70 to 1.20); at 1 µm: ${per.join(', ')}. Ours is 128π⁵α²/3λ⁴ with the static polarisability: no dispersion and no King factor. CO is left out of the tolerance: ours is ${co.toFixed(2)} times petitRADTRANS's, a difference that was not resolved (α = 1.95e-24 cm³ is the handbook value)`);
  const small = K.particleQ(10, 0.01, 10) / (5 * (2 * Math.PI * 0.001) ** 4 / 10), big = K.particleQ(0.5, 100, 10) / (5 * (2 * Math.PI * 200) ** -0.2);
  const M = ref.mie, rows = []; let rl = 9, rh = 0, sl = 9, sh = 0;
  for (const [name, q0] of [['silicate-like, m = 1.6 + 0.01i', 10], ['ice-like, m = 1.3 + 0.001i', 65]]) {
    const c = M.cases[name], ratio = M.x.map((x, i) => K.particleQ(2 * Math.PI, x, q0) / c.q[i]);   // wl = 2 pi: x = r
    M.x.forEach((x, i) => { if (x >= 1) { rl = Math.min(rl, ratio[i]); rh = Math.max(rh, ratio[i]); } else { sl = Math.min(sl, ratio[i]); sh = Math.max(sh, ratio[i]); } });
    rows.push(`${name} with Q0 = ${q0}: ${M.x.map((x, i) => `${x}: ${ratio[i].toFixed(2)}`).join(', ')}`);
  }
  check('particle extinction (Kitzmann & Heng 2018): limits, and against Mie theory', Math.abs(small - 1) < 1e-6 && Math.abs(big - 1) < 1e-6 && rl > 0.6 && rh < 1.6,
    `Q → 5x⁴/Q0 for x ≪ 1 (ratio ${small.toFixed(7)}) and 5x^-0.2 for x ≫ 1 (${big.toFixed(7)}). Ratio to a Mie calculation averaged over a log-normal size distribution (σ = ${M.sigma_ln} in ln r, x from the area-weighted radius), for x ≥ 1: ${rl.toFixed(2)} to ${rh.toFixed(2)} (tolerance 0.6 to 1.6); for x < 1: ${sl.toFixed(3)} to ${sh.toFixed(3)}, where the large particles of a wide distribution and absorption in the material dominate and the fit, a Rayleigh x⁴, falls far below. Fit over Mie at each x: ${rows.join('; ')}`);
  // a particle layer: its vertical optical depth is what was asked for, wherever its edges fall between levels
  const atm = A.buildAtmosphere({ mplanet: 1, rplanet: 1, tp: 1200, nLayers: 37 }), wl = [0.5, 1, 4], out = new Float64Array(3 * 37), sc = new Float64Array(3 * 37), ab = new Float64Array(3 * 37);
  const layer = { top: 3.3e-4, base: 2.7e-2, tau: 0.7, radius: 0.3, q0: 10, albedo: 0.8 };
  K.addParticleLayer(atm, wl, out, layer); K.addParticleLayer(atm, wl, sc, layer, 'scattering'); K.addParticleLayer(atm, wl, ab, layer, 'absorption');
  const tau = (a, i) => { let t = 0; for (let j = 0; j < 37; j++) t += a[i * 37 + j] * atm.dr[j]; return t; };
  let outside = 0; for (let j = 0; j < 37; j++) if (atm.pLev[j + 1] <= 3.3e-4 * 1e5 || atm.pLev[j] >= 2.7e-2 * 1e5) outside += out[37 + j];
  const zero = new Float64Array(3 * 37); K.addParticleLayer(atm, wl, zero, { ...layer, radius: 0 });
  check('a particle layer carries the optical depth it is given', Math.abs(tau(out, 1) - 0.7) < 1e-12 && Math.abs(tau(sc, 1) - 0.56) < 1e-12 && Math.abs(tau(ab, 1) - 0.14) < 1e-12 && outside === 0 && Math.abs(tau(out, 0) / 0.7 - K.particleQ(0.5, 0.3) / K.particleQ(1, 0.3)) < 1e-12 && zero.every(Number.isFinite),
    `τ = ${tau(out, 1).toFixed(12)} at the reference wavelength for 0.7 asked, between 3.3e-4 and 2.7e-2 bar on 37 layers (edges inside layers); scattering and absorbing shares ${tau(sc, 1).toFixed(3)} and ${tau(ab, 1).toFixed(3)} for an albedo of 0.8; nothing outside the layer; at 0.5 µm it scales as Q; a radius of zero gives finite numbers`);
  const c1 = A.composition({ H2: 0.5, H2O: 1e-3 }, 2), c2 = A.composition({ H2O: 1e-3 }, 2), bad = (v) => { try { A.composition(v, 2); return false; } catch { return true; } };
  check('composition: the fill gas takes what is left, and a sum above 1 is refused', Math.abs(c1.species.He[0] - 0.499) < 1e-15 && Math.abs(c2.species.H2[0] + c2.species.He[0] + 1e-3 - 1) < 1e-15 && Math.abs(c2.species.He[0] / c2.species.H2[0] - 0.17) < 1e-12 && bad({ H2: 0.9, H2O: 0.5 }) && bad({ H2O: NaN }),
    `H2 = 0.5 with H2O = 1e-3 gives He = ${c1.species.He[0]}; H2O alone gives He/H2 = ${(c2.species.He[0] / c2.species.H2[0]).toFixed(2)}; H2 = 0.9 with H2O = 0.5, and a NaN, throw`);
}

// ---- 5. colour -----------------------------------------------------------------------------------------------------
{
  const c = ref.colour;
  let w = 0, where = 0; c.temps.forEach((t, i) => { const xy = Col.blackbodyColour(t).xy, d = Math.hypot(xy[0] - c.blackbody[i][0], xy[1] - c.blackbody[i][1]); if (d > w) { w = d; where = t; } });
  const ee = Col.chromaticity(Col.spectrumToXYZ(() => 1)), dee = Math.hypot(ee[0] - c.equal_energy[0], ee[1] - c.equal_energy[1]);
  check(`blackbody chromaticities match the tabulated CIE 1931 observer (colour-science ${c.version})`, w < 3e-3 && dee < 1e-3,
    `max distance in (x, y) ${ex(w)} at ${where} K over ${c.temps.length} temperatures from ${c.temps[0]} to ${c.temps[c.temps.length - 1]} K; equal-energy spectrum ${ex(dee)}; tolerance 3e-3 for blackbodies and 1e-3 for the equal-energy spectrum (a just-noticeable difference is about 3e-3). The colour-matching functions are the analytic fits of Wyman, Sloan & Shirley (2013), not the table`);
  let wc = 0; c.cmf_nm.forEach((nm, i) => { wc = Math.max(wc, Math.abs(Col.cmfX(nm) - c.cmf[i][0]), Math.abs(Col.cmfY(nm) - c.cmf[i][1]), Math.abs(Col.cmfZ(nm) - c.cmf[i][2])); });
  check('... and the fitted functions themselves', wc < 0.03, `max difference ${wc.toFixed(4)} at 450-650 nm against the table (peak values are 1.06, 1.00, 1.78); tolerance 0.03`);
  const sun = Col.blackbodyColour(5772), cool = Col.blackbodyColour(3000), hot = Col.blackbodyColour(12000);
  check('sRGB conversion', sun.srgb.every((v) => v > 0.85) && cool.srgb[0] > 0.999 && cool.srgb[2] < 0.5 && hot.srgb[2] > 0.999 && hot.srgb[0] < 0.85 && Math.abs(Col.srgbEncode(0.5) - (1.055 * Math.pow(0.5, 1 / 2.4) - 0.055)) < 1e-15 && Math.abs(Col.srgbEncode(0.5) - 0.73536) < 1e-5 && Math.abs(Col.srgbEncode(0.002) - 0.02584) < 1e-12,
    `5772 K → (${sun.srgb.map((v) => v.toFixed(3)).join(', ')}), 3000 K → (${cool.srgb.map((v) => v.toFixed(3)).join(', ')}), 12000 K → (${hot.srgb.map((v) => v.toFixed(3)).join(', ')}), each scaled to its brightest channel; the transfer curve at 0.5 is 0.73536 (IEC 61966-2-1)`);
  const L = ref.limb; let wl = 0, at = '';
  for (const [teff, rows] of Object.entries(L.rgb)) {
    const got = Col.stellarLimbColours(+teff, L.n);
    L.k.forEach((k, m) => { for (let ch = 0; ch < 3; ch++) { const d = Math.abs(got.rgb[3 * k + ch] - rows[m][ch]); if (d > wl) { wl = d; at = `${teff} K, μ = ${got.mu[k].toFixed(2)}`; } } });
  }
  const sunL = Col.stellarLimbColours(5772, L.n), k2 = L.k[0];
  check('limb colours of a grey star match quadrature with the tabulated observer', wl < 0.015 && sunL.rgb[3 * k2] / sunL.rgb[3 * k2 + 2] > sunL.rgb[3 * 49] / sunL.rgb[3 * 49 + 2],
    `max difference ${wl.toFixed(4)} in a linear sRGB channel (centre's brightest = 1) at ${at}, over ${Object.keys(L.rgb).join(', ')} K and μ = ${L.mu.join(', ')}; tolerance 0.015 (the fitted colour-matching functions). At 5772 K and μ = 0.2 the disc is (${[0, 1, 2].map((c) => sunL.rgb[3 * k2 + c].toFixed(3)).join(', ')}) of the centre: dimmer and redder`);
  const g1 = Col.toGamut([0.5, -0.1, 0.2]), g2 = Col.toGamut([2, 1, 0.5], 0.8), g3 = Col.toGamut([0, 0, 0]);
  check('gamut mapping lifts negatives with white and scales to the peak', Math.abs(g1[0] - 1) < 1e-15 && g1[1] === 0 && Math.abs(g1[2] - 0.5) < 1e-15 && Math.abs(g2[0] - 0.8) < 1e-15 && Math.abs(g2[2] - 0.2) < 1e-15 && g3.join() === '0,0,0',
    `(0.5, -0.1, 0.2) → (${g1.map((v) => v.toFixed(2)).join(', ')}); (2, 1, 0.5) at peak 0.8 → (${g2.map((v) => v.toFixed(2)).join(', ')}); black stays black`);
}

// ---- 6. what the 3D view draws ---------------------------------------------------------------------------------------
{
  const atm = A.buildAtmosphere({ mplanet: 0.28, rplanet: 1.27, tp: 1100, nLayers: 40 }), R = V.levelRadii(atm, 0.5), n = atm.n;
  const mono = Array.from(R.disp).every((v, k) => k === 0 || v < R.disp[k - 1]) && Array.from(R.real).every((v, k) => k === 0 || v < R.real[k - 1]);
  check('display radii: the stretched cutaway keeps the order of the levels', mono && Math.abs(R.disp[0] - 1) < 1e-6 && Math.abs(R.disp[n] - 0.5) < 1e-6 && Math.abs(R.real[0] - 1) < 1e-6,
    `top at 1, bottom at 0.5 of the drawn radius, uniform in log P; the real atmosphere between 1e-6 and 100 bar is ${(100 * R.trueFraction).toFixed(1)}% of the radius for this planet`);
  const strip = V.radialStrip(Array.from(atm.tLay), R, (v, j) => [j, 100, 200], { size: 400, marks: [10] });
  const at = (r) => Array.from(strip.subarray(4 * Math.floor(r * 400), 4 * Math.floor(r * 400) + 3)), rMark = R.disp[10];
  check('radial strip: interior, layers and marks land at their radii', at(0.2).join() === '18,20,26' && at(0.999)[0] === 0 && at(0.505)[0] === n - 1 && at(rMark).join() === '255,64,64', `core colour inside 0.5, layer 0 at the edge, layer ${n - 1} just above the core, a red ring at level 10 (radius ${rMark.toFixed(3)})`);
  // a grey limb that is opaque below level 20 and clear above: colours are 0 and 1, and the opaque level is found
  const wl = Array.from({ length: 60 }, (_, i) => 0.36 + 0.007 * i), trans = new Float32Array(wl.length * (n + 1));
  for (let i = 0; i < wl.length; i++) for (let k = 0; k <= n; k++) trans[i * (n + 1) + k] = k <= 18 ? 1 : k >= 22 ? 0 : (22 - k) / 4;
  const col = V.limbColours(wl, trans, n, 5772), lv = V.opaqueLevel(trans, 5, n);
  check('limb colours: a grey limb leaves the star\'s colour unchanged', Math.abs(col[0] - 1) < 1e-6 && col[3 * n] === 0 && Math.abs(col[3 * 20] - 0.5) < 1e-6 && Math.abs(col[3 * 20] - col[3 * 20 + 2]) < 1e-6 && Math.abs(lv - 20) < 1e-6, `factors 1 above, 0 below, 0.5 in all three channels where half the light passes; that level is found at ${lv.toFixed(3)} (expected 20)`);
  // blue light blocked: the transmitted light turns red
  for (let i = 0; i < wl.length; i++) trans[i * (n + 1) + 20] = wl[i] < 0.5 ? 0 : 1;
  const red = V.limbColours(wl, trans, n, 5772);
  check('limb colours: blocking the blue reddens the transmitted light', red[3 * 20] > 0.9 && red[3 * 20 + 2] < 0.1, `linear sRGB factors (${[0, 1, 2].map((c) => red[3 * 20 + c].toFixed(3)).join(', ')}) with everything below 0.5 µm absorbed`);
  const tex = V.limbTexture(col, R.real, 64);
  check('limb texture: bottom opaque, top clear', tex[0] === 0 && Math.abs(tex[4 * 63] - 1) < 1e-6 && tex[4 * 63 + 3] === 1, '64 texels uniform in impact parameter from the bottom level to the top');
}

// ---- 6b. colours from any wavelength range, and the ray-marched planet's inputs -------------------------------------
{
  const wl = []; for (let w = 0.3; w < 12; w *= 1.005) wl.push(w);
  const tr = V.displayWeights(wl, { teff: 5772 }), mp = V.displayWeights(wl, { map: { from: [0.6, 12] } });
  const flatT = V.displayFactors(tr, () => 1), flatM = V.displayFactors(mp, () => 0.3), short = V.displayFactors(mp, (i) => (wl[i] < 1.5 ? 1 : 0)), long = V.displayFactors(mp, (i) => (wl[i] > 5 ? 1 : 0));
  const sun = Col.blackbodyColour(5772).linear, refN = tr.ref.map((v) => v / Math.max(...tr.ref)), dStar = Math.max(...refN.map((v, c) => Math.abs(v - sun[c])));
  check('display colours: true colour uses the star\'s light, a mapped range runs blue to red', flatT.every((v) => Math.abs(v - 1) < 1e-12) && flatM.every((v) => Math.abs(v - 0.3) < 1e-12) && short[2] > 0.9 && short[0] < 0.05 && long[0] > 0.4 && long[2] < 0.01 && dStar < 0.02 && Math.abs(V.displayNm(0.6, { from: [0.6, 12] }) - 400) < 1e-9 && Math.abs(V.displayNm(12, { from: [0.6, 12] }) - 700) < 1e-9 && V.coversVisible([0.3, 1]) && !V.coversVisible([0.6, 5]),
    `a flat factor comes back unchanged in both modes; with 0.6–12 µm laid over 400–700 nm, light below 1.5 µm alone gives (${short.map((v) => v.toFixed(2)).join(', ')}) and light above 5 µm alone (${long.map((v) => v.toFixed(2)).join(', ')}) in linear sRGB; the true-colour illuminant on a 0.5% grid is the 5772 K blackbody's colour to ${dStar.toFixed(4)}; 0.6–5 µm is not taken for visible coverage`);
  // onion peeling: an extinction profile -> limb transmittance on straight chords -> back
  const n = 40, real = Float64Array.from({ length: n + 1 }, (_, k) => 1 - (0.05 * k) / n), beta = Float64Array.from({ length: n }, (_, j) => 0.5 * Math.exp(j / 6));
  const col = new Float32Array(3 * (n + 1)).fill(1);
  for (let k = 1; k <= n; k++) { let tau = 0; const b = real[k]; for (let j = 0; j < k; j++) tau += beta[j] * 2 * (Math.sqrt(real[j] ** 2 - b * b) - Math.sqrt(Math.max(0, real[j + 1] ** 2 - b * b))); for (let c = 0; c < 3; c++) col[3 * k + c] = Math.exp(-tau * (c + 1)); }
  const got = V.shellExtinction(col, real); let w = 0, res = 0, mono = true;
  for (let j = 0; j < n; j++) { if (col[3 * (j + 1)] > 1e-4) { w = Math.max(w, Math.abs(got[3 * j] / beta[j] - 1), Math.abs(got[3 * j + 1] / (2 * beta[j]) - 1)); res = j + 1; } else if (!(got[3 * j] >= got[3 * (j - 1)])) mono = false; }
  const sh = V.shellTextures(got, got.map((v) => 2 * v), real, real[res], 4, 32);
  let tauT = 0, tauR = 0; for (let x = 0; x < 32; x++) tauT += sh.ext[4 * x] * (1 - sh.inner) / 32; for (let j = 0; j < res; j++) tauR += got[3 * j] * (real[j] - real[j + 1]);
  check('ray-marched planet: the layers\' extinction gives back the limb\'s transmittance', w < 1e-4 && mono && Math.abs(tauT / tauR - 1) < 0.05 && sh.sca.every((v, i) => v <= sh.ext[i] + 1e-12) && Math.abs(sh.inner - real[res] / sh.top) < 1e-12,
    `a known profile on ${n} layers, three channels: recovered to ${ex(w)} over the ${res} layers whose limb still passes more than 1e-4, and rising below; stretched 4 times on 32 texels the vertical optical depth above the opaque radius is ${tauT.toFixed(3)} against ${tauR.toFixed(3)}; scattering is held at or below extinction`);
}

// ---- 7. a tabulated spectrum as the simulator's input -----------------------------------------------------------------
{
  const wl = Array.from({ length: 200 }, (_, i) => 1 * Math.exp(i / 200)), f = tabulatedDepth({ wl, depth: wl.map((w) => 0.02 + 0.001 * Math.log(w)) });
  const mid = f(1.5), band = f(1.5, { lo: 1.4, hi: 1.6 }), narrow = f(1.5, { lo: 1.4999, hi: 1.5001 }), out = [f(0.5), f(9)];
  check('tabulated depth: channel means, interpolation and the ends', Math.abs(mid - (0.02 + 0.001 * Math.log(1.5))) < 1e-9 && Math.abs(band - mid) < 2e-6 && narrow === mid && out[0] === 0.02 && Math.abs(out[1] - (0.02 + 0.001 * 199 / 200)) < 1e-12,
    `a spectrum linear in log λ is returned exactly at a wavelength (${(mid * 1e6).toFixed(3)} ppm at 1.5 µm), its mean over 1.4-1.6 µm differs by ${((band - mid) * 1e6).toFixed(2)} ppm (curvature of the logarithm over the channel), a channel narrower than the table's spacing falls back to interpolation, and outside the table the end values are used`);
}

process.exit(ok ? 0 : 1);
