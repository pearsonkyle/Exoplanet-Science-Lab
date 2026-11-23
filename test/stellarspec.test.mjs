// Stellar spectra from the PHOENIX grid (src/core/stellarspec.js): the Sun's total and spectral irradiance, energy
// conservation over the grid, interpolation between models, and what a real stellar spectrum changes in an eclipse
// depth. Tolerances are stated in each check.
import { readFileSync } from 'node:fs';
import * as S from '../src/core/stellarspec.js';
import { planckSI } from '../src/core/phasecurve.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const b = readFileSync(new URL('../public/stellar/phoenix.esls', import.meta.url)), grid = S.parseStellar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const SIGMA = 5.670374419e-8;
{
  // the Sun: Teff 5772 K, log g 4.44, at 1 au
  const sun = S.stellarFlux(grid, { teff: 5772, logg: 4.44, feh: 0 }), au = (6.957e8 / 1.495978707e11) ** 2, tsi = S.bolometric(sun, 5772) * au;
  const at = (lo, hi) => S.resampleFlux(sun, [lo, hi], 5772)[0] * au / 1e3;   // W m^-2 nm^-1
  const vis = at(0.5, 0.6), nir = at(1.5, 1.7), uv = at(0.30, 0.32);
  check('the Sun from the grid: total irradiance and its spectrum at 1 au', Math.abs(tsi / 1361 - 1) < 0.02 && Math.abs(vis / 1.84 - 1) < 0.04 && Math.abs(nir / 0.245 - 1) < 0.06 && uv < 0.9 * (Math.PI * planckSI(0.31, 5772) * au / 1e3) && sun.used === 4 && sun.clamped.length === 0,
    `total ${tsi.toFixed(0)} W/m² (measured 1361; tolerance 2%); mean over 0.5 to 0.6 µm ${vis.toFixed(3)} W/m²/nm (ASTM E490: about 1.84; tolerance 4%), over 1.5 to 1.7 µm ${nir.toFixed(3)} (about 0.245; tolerance 6%); at 0.31 µm ${(uv / (Math.PI * planckSI(0.31, 5772) * au / 1e3)).toFixed(2)} of a 5772 K blackbody (the lines of metals take the rest). Interpolated from ${sun.used} models`);
}
{
  let lo = 9, hi = 0, n = 0, worst = 0, where = '';
  for (const feh of grid.feh) for (const logg of grid.logg) for (const teff of grid.teff) { let s; try { s = S.stellarFlux(grid, { teff, logg, feh }); } catch { continue; } if (s.used !== 1) continue; const r = S.bolometric(s, teff) / (SIGMA * teff ** 4); n++; lo = Math.min(lo, r); hi = Math.max(hi, r); }
  // leave one model out: the mean of its neighbours in temperature against the model itself, over 0.4 to 2.5 micron
  for (const teff of [3000, 4000, 5000, 5800, 6500, 7000]) { const a = S.stellarFlux(grid, { teff: teff - 100, logg: 4.5 }), c = S.stellarFlux(grid, { teff: teff + 100, logg: 4.5 }), m = S.stellarFlux(grid, { teff, logg: 4.5 }); let w = 0; for (let i = 0; i < grid.nWl; i++) if (grid.wl[i] > 0.4 && grid.wl[i] < 2.5) w = Math.max(w, Math.abs(Math.sqrt(a.flux[i] * c.flux[i]) / m.flux[i] - 1)); if (w > worst) { worst = w; where = teff + ' K'; } }
  const out = S.stellarFlux(grid, { teff: 9000, logg: 3, feh: 1 });
  check('energy over the grid, interpolation between models, and the grid\'s edges', n > 500 && lo > 0.95 && hi < 1.05 && worst < 0.08 && out.clamped.join() === 'teff,logg,feh',
    `${n} models: flux integrated to 1000 µm (Rayleigh-Jeans tail beyond 5.5 µm) over σT⁴ from ${lo.toFixed(3)} to ${hi.toFixed(3)} (tolerance 5%; the 5 nm sampling, 78 angles and the models' own departure from their nominal temperature). A model left out and interpolated from its neighbours 100 K either side is within ${(100 * worst).toFixed(1)}% in every bin from 0.4 to 2.5 µm (worst at ${where}; tolerance 8%; the grid's own step is 100 K, so in use the error is a quarter of that or less). Outside the grid the edge model is used and the result says so (${out.clamped.join(', ')})`);
}
{
  // synthetic photometry: a flat response returns the mean; a narrow band returns the spectrum there; the tail joins on
  const s = S.stellarFlux(grid, { teff: 5000 }), flat = { wl: [1.0, 1.1, 1.2, 1.3, 1.4], response: [1, 1, 1, 1, 1] }, got = S.bandFlux(s, flat, 5000), e = [0.95, 1.05, 1.15, 1.25, 1.35, 1.45], f = S.resampleFlux(s, e, 5000);
  let a = 0, c = 0; for (let i = 0; i < 5; i++) { a += f[i] * flat.wl[i] * 0.1; c += flat.wl[i] * 0.1; }
  const w4 = S.bandFlux(s, { wl: [20, 22, 24], response: [1, 1, 1] }, 5000), bb = Math.PI * planckSI(22, 5000), join = S.resampleFlux(s, [5.4, 5.5, 5.6], 5000);
  check('synthetic photometry counts photons, and a blackbody tail carries the spectrum beyond 5.5 µm', Math.abs(got / (a / c) - 1) < 1e-12 && Math.abs(join[1] / join[0] - 1) < 0.3 && w4 / bb > 0.8 && w4 / bb < 0.95 && Math.abs(S.dilution(1, 10) / 5.083e-18 - 1) < 1e-3,
    `a flat band from 0.95 to 1.45 µm returns the photon-weighted mean to ${Math.abs(got / (a / c) - 1).toExponential(1)}; across 5.5 µm, where the model ends inside the CO band, the flux steps by ${(100 * (join[1] / join[0] - 1)).toFixed(1)}%; at 22 µm (WISE W4) a 5000 K photosphere is put at ${(w4 / bb).toFixed(2)} of its blackbody (the Sun's brightness temperature there is about 15% under its effective temperature; the tail falls as (λ / 4 µm)^-0.08 for that reason, and the benchmark stars' WISE W3 and W4 magnitudes then fit to 0.02-0.09 mag for FGK stars, test/sed.test.mjs). (R☉ / 10 pc)² = ${S.dilution(1, 10).toExponential(3)}`);
}
{
  // what it changes for a planet: the eclipse depth scales as 1 / the star's flux; a K star is not a blackbody at 4.5 micron
  const rows = [[5485, 'WASP-39'], [4400, 'a K5 dwarf'], [3300, 'an M3 dwarf']].map(([teff, name]) => { const s = S.stellarFlux(grid, { teff }); return { name, teff, r: [1.4, 2.2, 4.5].map((wl) => S.resampleFlux(s, [wl * 0.97, wl * 1.03], teff)[0] / (Math.PI * planckSI(wl, teff))) }; });
  check('a model star against a blackbody of the same temperature, where planets are observed in eclipse', rows.every((x) => x.r[0] > 1.05 && x.r[1] > 1.05 && x.r[2] < 0.97 && x.r.every((v) => v > 0.6 && v < 1.6)),
    rows.map((x) => `${x.name} (${x.teff} K): ${x.r.map((v) => v.toFixed(2)).join(', ')}`).join('; ') + ' of the blackbody flux at 1.4, 2.2 and 4.5 µm: brighter than the blackbody in the H- opacity minimum, fainter beyond 4 µm. An eclipse depth computed over a blackbody star is off by the inverse of these factors; the atmosphere model takes a spectrum through star.flux');
}
{
  // in the atmosphere model: the eclipse depth over a model star against the same over a blackbody
  const { parseTable } = await import('../src/core/opacity.js'), { forwardModel, DEFAULT_MODEL } = await import('../src/core/rtmodel.js');
  const load = (n) => { const x = readFileSync(new URL(`../public/opacity/${n}.eslo`, import.meta.url)); return parseTable(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)); };
  const tables = { lines: ['H2O', 'CO2'].map(load), cia: ['H2-H2', 'H2-He'].map(load) }, m = { ...DEFAULT_MODEL, vmr: { H2O: 1e-3, CO2: 1e-5 }, star: { rstar: 0.9, teff: 5400 } };
  const bb = forwardModel(m, tables, { want: { transmission: false } }), ph = forwardModel(m, { ...tables, star: grid }, { want: { transmission: false } }), off = forwardModel({ ...m, star: { ...m.star, spectrum: 'blackbody' } }, { ...tables, star: grid }, { want: { transmission: false } });
  const i = (wl) => bb.wl.findIndex((v) => v > wl), ratio = (wl) => ph.fpfs[i(wl)] / bb.fpfs[i(wl)], sp = S.stellarFlux(grid, { teff: 5400 }), want = (Math.PI * planckSI(bb.wl[i(4.5)], 5400)) / S.resampleFlux(sp, [bb.grid.edges[i(4.5)], bb.grid.edges[i(4.5) + 1]], 5400)[0];
  check('the atmosphere model divides by the model star when it is given one', Math.abs(ratio(4.5) / want - 1) < 1e-12 && ratio(4.5) > 1.03 && ratio(1.6) < 0.95 && off.fpfs.every((v, k) => v === bb.fpfs[k]) && ph.flux.every((v, k) => v === bb.flux[k]) && ratio(30) > 1.1 && ratio(30) < 1.5,
    `a 5400 K star: eclipse depths are ${ratio(1.6).toFixed(2)} of the blackbody-star value at 1.6 µm, ${ratio(4.5).toFixed(2)} at 4.5 µm and ${ratio(30).toFixed(2)} at 30 µm (the tail); the planet's own flux is unchanged, and star.spectrum = 'blackbody' gives the old numbers exactly`);
}
{
  // one set of model stars for every routine: the limb darkening table and this flux grid come from the same PHOENIX files
  const { LD_TABLE_COMPACT: ld } = await import('../src/data/ld_table.js'), sedSrc = readFileSync(new URL('../src/core/sed.js', import.meta.url), 'utf8'), rt = readFileSync(new URL('../src/core/rtmodel.js', import.meta.url), 'utf8'), sm = readFileSync(new URL('../src/core/specmatch.js', import.meta.url), 'utf8');
  const common = grid.teff.filter((t) => ld.teff.includes(t)).length, { C } = await import('../src/core/derive.js');
  check('one set of model stars and one solar radius across limb darkening, eclipse depths, SED fits and spectrum matching', /PHOENIX-ACES/.test(ld.source) && /PHOENIX-ACES/.test(grid.source) && /Husser et al\. 2013/.test(ld.source) && /Husser et al\. 2013/.test(grid.source) && common >= 50 && /from '\.\/stellarspec\.js'/.test(sedSrc) && /from '\.\/stellarspec\.js'/.test(rt) && /from '\.\/stellarspec\.js'/.test(sm) && Math.abs(S.dilution(1, 1) / (C.Rsun / 3.0856775814913673e16) ** 2 - 1) < 1e-12 && !/6\.957e8/.test(sedSrc),
    `the limb darkening table ("${ld.source.slice(0, 58)}…") and the flux grid are built from the same PHOENIX-ACES specific-intensity files and share ${common} of the grid's ${grid.teff.length} temperatures; the atmosphere model's star (rtmodel.js), the SED fit (sed.js) and the spectrum match (specmatch.js) all read that one grid through stellarspec.js; the solar radius is derive.js's in each. Not yet shared: the 3D view's star colour and the ionizing ultraviolet are still blackbodies, and a star fitted on the Star page is not yet handed to the light-curve and radial-velocity fits`);
}
process.exit(ok ? 0 : 1);
