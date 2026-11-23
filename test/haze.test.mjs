// Hazes of real materials and the worlds that need them: Mie scattering (src/core/mie.js) against scipy, the tholin
// optical constants against the published table, the particle layer built on them, the nitrogen collision-induced
// absorption against the HITRAN files, and Titan and Jupiter (src/core/worlds.js) against what probes and
// occultations measured. Reference: test/haze_reference.json (test/make_haze_reference.py). Tolerances are stated.
import { readFileSync } from 'node:fs';
import { mie, refractiveIndex, particleOptics } from '../src/core/mie.js';
import { OPTICAL } from '../src/core/optical.js';
import { addParticleLayer, addContinuum } from '../src/core/continuum.js';
import { parseTable, crossSection } from '../src/core/opacity.js';
import { forwardModel, geometricAlbedo, atmosphereOf } from '../src/core/rtmodel.js';
import { spectrumToXYZ, xyzToLinearSRGB } from '../src/core/colour.js';
import { planckSI } from '../src/core/phasecurve.js';
import { WORLDS } from '../src/core/worlds.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./haze_reference.json', import.meta.url)));
const shipped = (name) => { const b = readFileSync(new URL(`../public/opacity/${name}.eslo`, import.meta.url)); return parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const ex = (x) => x.toExponential(1);

{
  let w = 0, wg = 0; for (const c of ref.mie.cases) { const q = mie(c.x, c.n, c.k); w = Math.max(w, Math.abs(q.qext / c.qext - 1), Math.abs(q.qsca / c.qsca - 1)); wg = Math.max(wg, Math.abs(q.g - c.g)); }
  const small = mie(0.01, 1.5, 0), ray = (8 / 3) * 0.01 ** 4 * ((1.5 ** 2 - 1) / (1.5 ** 2 + 2)) ** 2, big = mie(2000, 1.5, 0.1), lossless = mie(5, 1.33, 0), join = Math.abs(mie(0.0201, 1.7, 0.05).qext / mie(0.0199, 1.7, 0.05).qext / (0.0201 / 0.0199) - 1);
  check('Mie efficiencies against scipy\'s Bessel functions, and the limits', w < 1e-6 && wg < 1e-6 && Math.abs(small.qsca / ray - 1) < 1e-3 && Math.abs(big.qext - 2) < 0.02 && Math.abs(lossless.qabs) < 1e-12 && join < 0.01,
    `${ref.mie.cases.length} cases, x = 0.05 to 30, five refractive indices from 1.33 to 2 + 1i (${ref.mie.source}): Qext and Qsca within ${ex(w)}, g within ${ex(wg)} (tolerance 1e-6). x = 0.01: Rayleigh's (8/3) x⁴ |(m²−1)/(m²+2)|² to ${ex(Math.abs(small.qsca / ray - 1))}; x = 2000: Qext = ${big.qext.toFixed(3)} (2, the extinction paradox); no absorption without k (${ex(Math.abs(lossless.qabs))}); the small-particle formula meets the series at x = 0.02 to ${(100 * join).toFixed(2)}%`);
}
{
  // Khare et al. (1984), as tabulated in NASA's Optical Constants Database: [wavelength, n, k]; stated accuracy n 3%, k 30%
  const khare = [[0.4133, 1.69, 0.076], [0.5635, 1.70, 0.023], [0.6888, 1.68, 0.0088], [1.016, 1.65, 0.0010], [1.381, 1.64, 4.1e-4], [3.009, 1.61, 0.075], [3.463, 1.65, 0.035], [4.592, 1.61, 0.028]];
  const rows = khare.map(([wl, n, k]) => { const [gn, gk] = refractiveIndex(OPTICAL.tholin, wl); return { wl, dn: gn / n - 1, dk: gk / k - 1 }; });
  const wn = Math.max(...rows.map((r) => Math.abs(r.dn))), wk = Math.max(...rows.map((r) => Math.abs(r.dk)));
  const o = particleOptics(OPTICAL.tholin, [0.4, 0.55, 0.7, 1.0, 2.0], 0.05, 0.4);
  check('tholin: the optical constants are Khare et al.\'s, and small grains of it are orange', wn < 0.02 && wk < 0.2 && o.ext[0] > o.ext[1] && o.ext[1] > o.ext[2] && o.albedo[0] < o.albedo[1] && o.albedo[1] < o.albedo[2] && o.albedo[3] > 0.95,
    `n within ${(100 * wn).toFixed(1)}% and k within ${(100 * wk).toFixed(1)}% of the table at ${khare.length} wavelengths from 0.41 to 4.6 µm (tolerance 2% and 20%: the shipped values are interpolated from a compilation of the same measurements, whose stated accuracy is 3% in n and 30% in k). Grains of 0.05 µm: single-scattering albedo ${Array.from(o.albedo.slice(0, 4), (v) => v.toFixed(2)).join(', ')} at 0.4, 0.55, 0.7, 1.0 µm: blue light is absorbed, red is scattered`);
}
{
  const n = 40, pLev = Float64Array.from({ length: n + 1 }, (_, j) => 1e5 * 1e-6 * Math.pow(1e6, j / n)), atm = { n, pLev, dr: new Float64Array(n).fill(2e4) }, wl = [0.5, 1, 2];
  const col = (o, share) => { const out = new Float64Array(wl.length * n); addParticleLayer(atm, wl, out, o, share); return wl.map((_, i) => { let s = 0; for (let j = 0; j < n; j++) s += out[i * n + j] * atm.dr[j]; return s; }); };
  const layer = { material: 'tholin', top: 1e-5, base: 1e-1, tau: 2.5, ref: 1, radius: 0.2, power: 0.5 }, both = col(layer, 'both'), sc = col(layer, 'scattering'), ab = col(layer, 'absorption'), o = particleOptics(OPTICAL.tholin, wl, 0.2, 0.4);
  // tau(< P) ~ P^power: the share above 1e-3 bar is (sqrt(1e-3) - sqrt(1e-5)) / (sqrt(1e-1) - sqrt(1e-5))
  const upper = new Float64Array(wl.length * n); addParticleLayer(atm, wl, upper, layer); let above = 0; for (let j = 0; j < n; j++) if (pLev[j + 1] <= 1e-3 * 1e5 * (1 + 1e-9)) above += upper[1 * n + j] * atm.dr[j];
  const want = (Math.sqrt(1e-3) - Math.sqrt(1e-5)) / (Math.sqrt(1e-1) - Math.sqrt(1e-5)), flat = (1e-3 - 1e-5) / (1e-1 - 1e-5);
  check('a particle layer of a real material: its optical depth, its albedo and its spread with height', Math.abs(both[1] / 2.5 - 1) < 1e-12 && Math.abs(both[0] / (2.5 * o.ext[0] / o.ext[1]) - 1) < 1e-12 && Math.abs((sc[0] + ab[0]) / both[0] - 1) < 1e-12 && Math.abs(sc[0] / both[0] - o.albedo[0]) < 1e-12 && Math.abs(above / 2.5 / want - 1) < 1e-9 && want > 5 * flat,
    `optical depth ${both[1].toFixed(3)} at the reference wavelength (2.5 asked for), ${both[0].toFixed(2)} at 0.5 µm and ${both[2].toFixed(3)} at 2 µm from Mie theory; scattering and absorption add up to it, in the ratio of the albedo (${o.albedo[0].toFixed(3)} at 0.5 µm). With power 0.5, ${(100 * above / 2.5).toFixed(1)}% of it lies above 1 mbar (analytic ${(100 * want).toFixed(1)}%; a constant mixing ratio would put ${(100 * flat).toFixed(1)}% there)`);
}
{
  const T = {}; let w = 0; const rows = [];
  for (const c of ref.cia) { const t = (T[c.pair] ??= shipped(c.pair)), s = new Float64Array(t.nWl); crossSection(t, c.t, 1, s); const d = (s[c.bin] * 1e10) / c.k - 1; w = Math.max(w, Math.abs(d)); rows.push(`${c.pair} ${c.t} K ${Math.sqrt(c.lo * c.hi).toFixed(1)} µm ${c.k.toExponential(2)}`); }
  const nn = T['N2-N2'], s = new Float64Array(nn.nWl); crossSection(nn, 300, 1, s); const at = (wl) => s[nn.wl.findIndex((v) => v > wl)];
  check('collision-induced absorption of N2-N2, N2-CH4 and N2-H2: the shipped tables against the HITRAN files', w < 0.01 && at(4.29) > 100 * at(3.5) && at(2.15) > 0 && at(1.0) === 0 && nn.bands.length === 3,
    `${ref.cia.length} bin means read straight from the .cia files (cm⁵ per pair: ${rows.slice(0, 5).join('; ')}; …): the tables are within ${ex(w)} (tolerance 1%). N2-N2 keeps its three bands apart, each interpolated within its own temperatures: far infrared (70 to 400 K), the fundamental at 4.3 µm (228 to 363 K) and the overtone at 2.15 µm (200 to 330 K); nothing at 1 µm`);
}
{
  // Titan
  const W = WORLDS.Titan, tables = { lines: [shipped('CH4')], cia: ['N2-N2', 'N2-CH4', 'N2-H2'].map(shipped) };
  const r = forwardModel(W.model, tables, { want: { albedo: true } }), a = r.atm, rs = a.rLev[a.n], zAt = (P) => { const x = Math.log(P * 1e5); let j = 0; while (j < a.n - 1 && Math.log(a.pLev[j + 1]) < x) j++; const f = (x - Math.log(a.pLev[j])) / Math.log(a.pLev[j + 1] / a.pLev[j]); return (a.rLev[j] + f * (a.rLev[j + 1] - a.rLev[j]) - rs) / 1e3; };
  const zTrop = zAt(0.115), zStrat = zAt(3e-4), g = a.gm / (rs * rs), strat = a.species.CH4[a.pLay.findIndex((p) => p > 1e3)], cl = a.condensation.clouds[0];
  check('Titan: altitudes of the Huygens profile, surface gravity, and the methane cold trap', Math.abs(zTrop - 44) < 3 && Math.abs(zStrat - 250) < 25 && Math.abs(g - 1.354) < 0.005 && Math.abs(a.species.CH4[a.n - 1] - 0.0565) < 1e-12 && strat > 0.0148 && strat < 2 * 0.0148 && cl.name === 'CH4' && a.mu[a.n - 1] > 27 && a.mu[a.n - 1] < 28.02 && Math.abs(a.species.N2[a.n - 1] - (1 - 0.0565 - 0.001)) < 1e-12,
    `115 mbar at ${zTrop.toFixed(1)} km (Huygens: the tropopause at about 44 km; tolerance 3 km) and 0.3 mbar at ${zStrat.toFixed(0)} km (the stratopause at 250 km; tolerance 25 km, the profile between the published points being read off, not measured); g = ${g.toFixed(3)} m/s² at the surface (1.354 from GM and radius), falling to ${a.g[0].toFixed(2)} at the top. Methane: ${(100 * a.species.CH4[a.n - 1]).toFixed(2)}% at the surface, ${(100 * strat).toFixed(2)}% above the cold trap, where the probe measured 1.48 ± 0.09% (Niemann et al. 2010) and Cassini/CIRS about 1.0% (Lellouch et al. 2014): the pure-methane vapour pressure overestimates it by a factor ${(strat / 0.0148).toFixed(1)}, because nitrogen dissolves in the condensate and lowers it (tolerance: between 1 and 2 times the measured value). Condensing between ${cl.base.toFixed(2)} and ${cl.top.toFixed(2)} bar`);
  const i = (wl) => r.wl.findIndex((v) => v > wl), z = (wl) => (r.radius[i(wl)] - rs) / 1e3, pOf = (zkm) => { let j = a.n; while (j > 0 && (a.rLev[j] - rs) / 1e3 < zkm) j--; return a.pLev[j] / 1e5; };
  const o = particleOptics(OPTICAL.tholin, [0.88, 2.0], W.model.cloud.radius, W.model.cloud.sigma), beta = Math.log(o.ext[1] / o.ext[0]) / Math.log(2.0 / 0.88);
  const clear = forwardModel({ ...W.model, cloud: null }, tables, { want: { emission: false } }), zc = (clear.radius[i(0.88)] - rs) / 1e3;
  check('Titan in transit: the haze sets the altitude, as Cassini\'s solar occultations show', Math.abs(z(0.88) / 300 - 1) < 0.15 && beta < -1.5 && beta > -2.6 && z(0.88) > z(1.6) && z(1.6) > z(2.0) && z(5.0) < 120 && z(3.3) > z(2.8) + 50 && zc < 0.5 * z(0.88),
    `effective transit altitude ${z(0.88).toFixed(0)} km at 0.88 µm (Robinson et al. 2014: tangent heights of about 300 km at their shortest wavelength; tolerance 15%), ${z(1.6).toFixed(0)} km at 1.6 µm, ${z(2.0).toFixed(0)} km at 2.0 µm, ${z(5.0).toFixed(0)} km at 5 µm: pressures of ${ex(pOf(z(0.88)))} to ${ex(pOf(z(5.0)))} bar (theirs: about 0.1 mbar to 10 mbar). The haze's extinction falls as λ^${beta.toFixed(2)} between 0.88 and 2 µm (their fits: −1.9 ± 0.2 and −2.2 ± 0.2; Tomasko et al. −2.33; tolerance −1.5 to −2.6). Methane's 3.3 µm band stands ${(z(3.3) - z(2.8)).toFixed(0)} km above the window beside it. Without the haze a transit at 0.88 µm would reach only ${zc.toFixed(0)} km. The haze's three numbers were tuned to the first two of these; the rest follows`);
  const alb = geometricAlbedo(r), sun = Float64Array.from(r.wl, (wl, k) => alb[k] * planckSI(wl, 5772)), rgb = xyzToLinearSRGB(spectrumToXYZ({ nm: Array.from(r.wl, (v) => 1e3 * v), f: sun })), vis = (lo, hi) => { let s = 0, c = 0; for (let k = 0; k < r.wl.length; k++) if (r.wl[k] > lo && r.wl[k] < hi) { s += alb[k]; c++; } return s / c; };
  check('Titan\'s colour: orange, and about as bright as observed', rgb[0] > 1.15 * rgb[1] && rgb[1] > 1.3 * rgb[2] && vis(0.5, 0.6) > 0.11 && vis(0.5, 0.6) < 0.44 && vis(0.4, 0.45) < vis(0.6, 0.7),
    `reflected sunlight in linear sRGB ${rgb.map((v) => (v / rgb[0]).toFixed(2)).join(' : ')} (red : green : blue); the estimated geometric albedo is ${vis(0.4, 0.45).toFixed(2)} in the blue, ${vis(0.5, 0.6).toFixed(2)} at 0.5 to 0.6 µm and ${vis(0.6, 0.7).toFixed(2)} in the red, against a visual geometric albedo of 0.22 (NSSDC). Tolerance: within a factor 2; geometricAlbedo is a two-stream estimate, not a scattering calculation, and the haze is made of spheres`);
}
{
  // Jupiter
  const W = WORLDS.Jupiter, tables = { lines: ['CH4', 'NH3', 'H2O'].map(shipped), cia: ['H2-H2', 'H2-He'].map(shipped) };
  const r = forwardModel(W.model, tables, { want: { albedo: true } }), a = r.atm, c = Object.fromEntries(a.condensation.clouds.map((x) => [x.name, x])), top = a.pLay.findIndex((p) => p > 0.3e5), i = (wl) => r.wl.findIndex((v) => v > wl);
  const alb = geometricAlbedo(r), dry = forwardModel({ ...W.model, condensation: null, cloud: null }, tables, { want: { transmission: false } });
  check('Jupiter: ammonia and water rain out below the visible clouds; five-micron light escapes from the deep', c.NH3 && c.H2O && c.NH3.base > 0.5 && c.NH3.base < 1.1 && c.H2O.base > 4 && c.H2O.base < 9 && a.species.NH3[top] < 0.05 * a.species.NH3[a.n - 1] && a.species.H2O[top] < 1e-6 * a.species.H2O[a.n - 1] && a.species.CH4[0] === a.species.CH4[a.n - 1]
    && r.brightness[i(5.0)] > r.brightness[i(7.8)] + 40 && r.brightness[i(5.0)] > dry.brightness[i(5.0)] && alb[i(0.62)] > 1.3 * alb[i(0.89)] && r.brightness[i(45)] > 100 && r.brightness[i(45)] < 160,
    `three times solar: ammonia ice from ${c.NH3.base.toFixed(2)} bar and water from ${c.H2O.base.toFixed(1)} bar; at 0.3 bar ammonia is down to ${ex(a.species.NH3[top] / a.species.NH3[a.n - 1])} of its deep value, water to ${ex(a.species.H2O[top] / a.species.H2O[a.n - 1])}, methane unchanged. Brightness temperature ${r.brightness[i(5.0)].toFixed(0)} K at 5 µm (the window Jupiter's hot spots shine through; ${dry.brightness[i(5.0)].toFixed(0)} K if water and ammonia stayed in the gas), ${r.brightness[i(7.8)].toFixed(0)} K in methane's 7.8 µm band, ${r.brightness[i(45)].toFixed(0)} K at 45 µm (Jupiter's effective temperature is 124 K). The estimated albedo falls from ${alb[i(0.62)].toFixed(2)} at 0.62 µm to ${alb[i(0.89)].toFixed(2)} in the 0.89 µm methane band (the real planet: about 0.5 and 0.1; the estimate takes no account of how deep the cloud lies in the band)`);
}
process.exit(ok ? 0 : 1);
