// Condensation with rain-out (src/core/condensation.js): vapour pressures and condensation temperatures against
// published values that the fits were not taken from, the cold trap on a profile whose answer is known, Jupiter's
// cloud bases against an equilibrium cloud model, and the coupling to the chemistry and the self-consistent profile.
// Every tolerance is stated in its check.
import { readFileSync } from 'node:fs';
import * as Cd from '../src/core/condensation.js';
import { consistentProfile } from '../src/core/climate.js';
import { parseTable } from '../src/core/opacity.js';
import { parseChem } from '../src/core/chemistry.js';
import { DEFAULT_MODEL, atmosphereOf, forwardModel, placedCloud } from '../src/core/rtmodel.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const load = (f) => { const b = readFileSync(new URL(f, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const pct = (a, b) => 100 * (a / b - 1);

{
  // published points: [species, T, pressure in bar, tolerance in %, source]
  const pts = [
    ['H2O', 273.16, 611.657e-5, 0.1, 'triple point, IAPWS'], ['H2O', 373.15, 1.01325, 0.1, 'boiling point'], ['H2O', 200, 0.1626e-5, 1, 'ice, Murphy & Koop 2005'],
    ['NH3', 195.4, 0.0606, 2, 'triple point, NIST'],
    ['CH4', 111.67, 1.01325, 0.5, 'boiling point, NIST'], ['CH4', 90.67, 0.1169, 3, 'triple point, NIST'], ['CH4', 77, 1.175e-2, 2, 'solid, Armstrong et al. 1955'], ['CH4', 70, 0.2577e-2, 2, 'solid, Armstrong et al. 1955'],
  ];
  const rows = pts.map(([s, T, p, tol, src]) => ({ s, T, d: pct(Cd.vapourPressure(s, T), p), tol, src }));
  const step = Math.abs(Cd.vapourPressure('CH4', 90.6801) / Cd.vapourPressure('CH4', 90.6799) - 1);
  check('vapour pressures of water, ammonia and methane against published points', rows.every((r) => Math.abs(r.d) < r.tol) && step < 0.01,
    rows.map((r) => `${r.s} at ${r.T} K (${r.src}): ${r.d >= 0 ? '+' : ''}${r.d.toFixed(2)}% (tolerance ${r.tol}%)`).join('; ') + `. Methane's liquid and solid fits differ by ${(100 * step).toFixed(1)}% where they meet`);
}
{
  // condensation temperatures at 1e-4 bar, solar composition: Lodders (2003, ApJ 591, 1220), table 7, a full equilibrium calculation
  const lod = { Al2O3: 1677, CaTiO3: 1593, Fe: 1357, Mg2SiO4: 1354, MgSiO3: 1316 };
  const rows = Object.entries(lod).map(([k, T]) => ({ k, got: Cd.condensationTemperature(k, 1e-4), T }));
  const t1 = Cd.condensationTemperature('MgSiO3', 1, 0), tm = Cd.condensationTemperature('MgSiO3', 1, -1);
  const f = [Cd.gasFraction('MgSiO3', t1 + 1, 1, 0), Cd.gasFraction('MgSiO3', t1, 1, 0), Cd.gasFraction('MgSiO3', tm, 1, 0), Cd.gasFraction('MgSiO3', tm, 1, -1)];
  check('condensation curves against Lodders (2003), and the gas fraction they imply', rows.every((r) => Math.abs(pct(r.got, r.T)) < 1.5) && f[0] === 1 && Math.abs(f[1] - 1) < 1e-9 && Math.abs(f[2] - 0.1) < 1e-9 && Math.abs(f[3] - 1) < 1e-9,
    rows.map((r) => `${r.k} ${r.got.toFixed(0)} K (Lodders ${r.T} K, ${pct(r.got, r.T) >= 0 ? '+' : ''}${pct(r.got, r.T).toFixed(1)}%)`).join(', ') + `; tolerance 1.5%. At 1 bar enstatite forms at ${t1.toFixed(0)} K; at the temperature where a gas ten times poorer in metals would start to condense it (${tm.toFixed(0)} K) the solar gas keeps a tenth: ${f[2].toFixed(3)}`);
}
{
  // a cold trap whose answer is known: 200 K at the bottom, 100 K at the minimum, 180 K at the top
  const n = 41, p = Float64Array.from({ length: n }, (_, j) => 1e-4 * Math.pow(1e4, j / (n - 1))), t = Float64Array.from(p, (P, j) => (j >= 20 ? 100 + 100 * ((j - 20) / 20) : 100 + 80 * ((20 - j) / 20)));
  const x0 = 1e-3, sp = { NH3: new Float64Array(n).fill(x0), CO: new Float64Array(n).fill(1e-4) }, r = Cd.rainOut(t, p, sp, { only: ['NH3'] }), loc = Cd.rainOut(t, p, sp, { only: ['NH3'], rainout: false }), half = Cd.rainOut(t, p, sp, { only: ['NH3'], humidity: 0.5 });
  const sat = (j) => Cd.vapourPressure('NH3', t[j]) / p[j], trap = Math.min(...Array.from({ length: n }, (_, j) => sat(j))), c = r.clouds[0];
  check('rain-out: above the coldest level a gas keeps what the cold trap let through', r.species.NH3[n - 1] === x0 && Math.abs(r.species.NH3[0] / trap - 1) < 1e-12 && r.species.NH3.every((v, j) => j === n - 1 || v <= r.species.NH3[j + 1] * (1 + 1e-12)) && loc.species.NH3[0] === x0 && Math.abs(loc.species.NH3[20] / sat(20) - 1) < 1e-12
    && Math.abs(half.species.NH3[0] / (0.5 * trap) - 1) < 1e-12 && r.species.CO === sp.CO && sp.NH3[0] === x0 && c.name === 'NH3' && !c.deep && c.base > p[20] && c.base < 1 && Math.abs(r.kept.NH3[0] - trap / x0) < 1e-15,
    `ammonia at 1e-3 under a temperature minimum of 100 K: with rain-out ${r.species.NH3[0].toExponential(2)} everywhere above the trap (the smallest saturation ratio below, ${trap.toExponential(2)}); without it the gas returns to ${loc.species.NH3[0].toExponential(1)} where the air is warm again; at half the saturation allowed, ${half.species.NH3[0].toExponential(2)}. Cloud base at ${c.base.toFixed(3)} bar. The input arrays and the other gases are untouched`);
}
{
  // Jupiter: T = 166.1 K at 1 bar (Galileo probe, Seiff et al. 1998), d ln T / d ln P = 0.306 (the probe's 427.7 K at 22 bar)
  const n = 200, p = Float64Array.from({ length: n }, (_, j) => 1e-2 * Math.pow(3000, (j + 0.5) / n)), t = Float64Array.from(p, (P) => Math.max(110, 166.1 * Math.pow(P, 0.306)));
  // solar N/H = 1.12e-4, O/H = 8.51e-4, He/H = 0.0975 (Anders & Grevesse 1989, as Atreya & Wong 2005 use): mole fractions in H2 + He
  const base = (k) => { const sp = { NH3: new Float64Array(n).fill((k * 2 * 1.12e-4) / 1.195), H2O: new Float64Array(n).fill((k * 2 * 8.51e-4) / 1.195) }, r = Cd.rainOut(t, p, sp, { only: ['NH3', 'H2O'] }); return Object.fromEntries(r.clouds.map((c) => [c.name, c.base])); };
  const b1 = base(1), b3 = base(3);
  check('Jupiter: the ammonia and water cloud bases of an equilibrium cloud model', Math.abs(b1.NH3 / 0.72 - 1) < 0.25 && Math.abs(b3.NH3 / 0.84 - 1) < 0.25 && Math.abs(b1.H2O / 5.7 - 1) < 0.25 && b3.H2O > b1.H2O && b3.H2O > 5 && b3.H2O < 8.5,
    `solar N/H and O/H: ammonia ice from ${b1.NH3.toFixed(2)} bar and water from ${b1.H2O.toFixed(1)} bar, where Atreya & Wong (2005, Space Sci. Rev. 116, 121) give 0.72 and 5.7 bar; three times solar: ${b3.NH3.toFixed(2)} bar (0.84) and ${b3.H2O.toFixed(1)} bar (their range for 1 to 3 times solar: 5 to 8 bar). Tolerance 25%: their profile follows a moist adiabat and ammonia is also taken up by NH4SH, neither of which is modelled here`);
}
{
  // in the model: chemistry, then rain-out, on a profile that follows from the gas
  const tables = { lines: ['H2O', 'CO', 'Na', 'K', 'TiO', 'VO'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), chem: parseChem(load('../public/chem/equilibrium.eslc')) };
  const mk = (teq, f) => ({ ...DEFAULT_MODEL, planet: { mplanet: 1.18, rplanet: 1.81, pRef: 0.01 }, star: { rstar: 1.46, teff: 6460, ars: 3.75 }, chemistry: { mh: 0 }, condensation: { rainout: true }, tp: { kind: 'consistent', teq, tint: 100, f } });
  const runs = [['2358 K, day side', mk(2358, 0.5)], ['1450 K', mk(1450, 0.25)], ['900 K', mk(900, 0.25)]].map(([name, m]) => {
    const r = consistentProfile(m, tables, { cache: {} }), atm = atmosphereOf({ ...m, tp: r.tp }, tables), at = (P) => { let j = 0; while (j < atm.n - 1 && atm.pLay[j] < P * 1e5) j++; return j; }, j = at(1e-3);
    const dry = atmosphereOf({ ...m, tp: r.tp, condensation: null }, tables);
    return { name, m, r, atm, j, tio: atm.species.TiO[j] / dry.species.TiO[j], na: atm.species.Na[j] / dry.species.Na[j], rise: Math.max(...r.tp.t.slice(at(1e-5), at(1e-2))) - r.tp.t[at(3e-2)], clouds: atm.condensation.clouds };
  });
  const [hot, mid, warm] = runs, na2s = warm.clouds.find((c) => c.name === 'Na2S');
  check('rain-out in the model: TiO stays in the gas of an ultra-hot day side and leaves a cooler planet, taking the inversion with it', runs.every((x) => x.r.converged && Math.abs(x.r.balance - 1) < 0.02) && hot.tio === 1 && hot.clouds.length === 0 && hot.rise > 150 && mid.tio < 0.01 && mid.rise < 50 && mid.na === 1 && warm.na < 0.5 && na2s && !na2s.deep,
    runs.map((x) => `Teq ${x.name}: ${x.r.iterations} passes, balance ${x.r.balance.toFixed(3)}, TiO at 1 mbar ${x.tio === 1 ? 'all in the gas' : 'x ' + x.tio.toExponential(1)}, Na ${x.na === 1 ? 'all in the gas' : 'x ' + x.na.toFixed(2)}, warmest layer above 10 mbar ${x.rise >= 0 ? '+' : ''}${x.rise.toFixed(0)} K against 30 mbar, clouds: ${x.clouds.map((c) => c.name + (c.deep ? ' (below the model)' : ' from ' + c.base.toPrecision(2) + ' bar')).join(', ') || 'none'}`).join('. ')
    + '. This is the cold trap of Spiegel et al. (2009) in its simplest form: no mixing lifts condensed titanium back up');
  // a particle layer that follows a condensate sits at its base
  const m = { ...warm.m, tp: warm.r.tp, cloud: { follow: 'Na2S', extent: 1.5, tau: 2, radius: 0.5, q0: 10, albedo: 0.9 } }, placed = placedCloud(m.cloud, warm.atm), none = placedCloud({ follow: 'KCl', tau: 1 }, hot.atm);
  const withCloud = forwardModel(m, tables, { want: { emission: false } }), without = forwardModel({ ...m, cloud: null }, tables, { want: { emission: false } }), i = withCloud.wl.findIndex((v) => v > 1.25);
  check('a particle layer can follow a condensate: its base is the cloud base the atmosphere gives', Math.abs(placed.base / na2s.base - 1) < 1e-12 && Math.abs(placed.top / (na2s.base * 10 ** -1.5) - 1) < 1e-12 && none === null && withCloud.depth[i] > without.depth[i],
    `Na2S on the 900 K planet: base ${placed.base.toPrecision(3)} bar, top ${placed.top.toExponential(1)} bar (1.5 decades higher); the transit depth at 1.25 µm rises by ${((withCloud.depth[i] - without.depth[i]) * 1e6).toFixed(0)} ppm with it. Where the condensate forms nowhere (KCl on the ultra-hot day side) there is no layer`);
}
process.exit(ok ? 0 : 1);
