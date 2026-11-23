// The self-consistent temperature profile (src/core/climate.js): its closure against petitRADTRANS's own Guillot
// function and against the analytic profile; its means on gases whose answer is known; and, on real opacity tables,
// what it gives for HD 209458 b against the opacities Guillot (2010) calibrated on detailed models of that planet.
// Every tolerance is stated in its check.
import { readFileSync } from 'node:fs';
import * as K from '../src/core/climate.js';
import { guillot } from '../src/core/atmosphere.js';
import { parseTable } from '../src/core/opacity.js';
import { parseChem } from '../src/core/chemistry.js';
import { DEFAULT_MODEL, forwardModel } from '../src/core/rtmodel.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./atmosphere_reference.json', import.meta.url)));
const load = (f) => { const b = readFileSync(new URL(f, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

{
  // optical depths proportional to pressure: the closure is Guillot's eq. 29, here as two other codes write it
  const c = ref.guillot_prt.case, g = c.g / 100, kap = c.kappa / 10, p = ref.guillot_prt.p;
  const tau = p.map((P) => (kap * P * 1e5) / g), got = K.guillotFromDepths(tau, tau.map((v) => v * c.gamma), { teq: c.teq, tint: c.tint }), ours = guillot({ teq: c.teq, tint: c.tint, kappaIR: kap, gamma: c.gamma, g });
  const w = Math.max(...p.map((P, j) => Math.abs(got[j] - ref.guillot_prt.t[j]))), w2 = Math.max(...p.map((P, j) => Math.abs(got[j] - ours(P))));
  check('the closure with constant opacities is the Guillot (2010) profile', w < 0.01 && w2 < 1e-9,
    `9 pressures from 1e-6 to 100 bar, κ = ${c.kappa} cm²/g, γ = ${c.gamma}, Teq = ${c.teq} K, Tint = ${c.tint} K: within ${w.toExponential(1)} K of petitRADTRANS ${ref.hminus.version}'s temperature_profile_function_guillot_global and ${w2.toExponential(1)} K of our own guillot(); tolerance 0.01 K. ${got[4].toFixed(1)} K at 10 mbar, ${got[8].toFixed(1)} K at 100 bar`);
}
{
  // a grey gas: every mean is the opacity itself, and the effective depths are the true ones
  const n = 30, nWl = 40, ng = 2, wl = Float64Array.from({ length: nWl }, (_, i) => 0.3 * Math.pow(50 / 0.3, (i + 0.5) / nWl)), edges = Float64Array.from({ length: nWl + 1 }, (_, i) => 0.3 * Math.pow(50 / 0.3, i / nWl));
  const grid = { wl, edges, nWl, ng, weights: [0.5, 0.5] }, tLay = new Float64Array(n).fill(1200), dr = new Float64Array(n).fill(1e4), a0 = 3e-6, ext = new Float64Array(nWl * ng * n).fill(a0);
  const m = K.meanExtinctions(ext, grid, tLay, 5800), e = K.effectiveDepths(ext, grid, { n, dr, tLay }, 5800);
  const wm = Math.max(...[m.rosseland, m.planck, m.stellar].map((x) => Math.abs(x[7] / a0 - 1))), wd = Math.max(...Array.from({ length: n }, (_, j) => Math.max(Math.abs(e.tau[j] / (a0 * 1e4 * (j + 0.5)) - 1), Math.abs(e.tauV[j] / (a0 * 1e4 * (j + 0.5)) - 1))));
  // two opacities in equal shares: harmonic and arithmetic means, and a transmission that is the mean of two exponentials
  const two = new Float64Array(nWl * ng * n); for (let i = 0; i < nWl; i++) for (let j = 0; j < n; j++) { two[(i * ng) * n + j] = 1e-6; two[(i * ng + 1) * n + j] = 1e-4; }
  const m2 = K.meanExtinctions(two, grid, tLay, 5800), e2 = K.effectiveDepths(two, grid, { n, dr, tLay }, 5800), j = 12, d1 = 1e-6 * 1e4 * (j + 0.5), d2 = 1e-4 * 1e4 * (j + 0.5), want = -0.5 * Math.log(0.5 * (Math.exp(-d1 / 0.5) + Math.exp(-d2 / 0.5)));
  check('mean opacities and grey-equivalent depths on gases whose answer is known', wm < 1e-12 && wd < 1e-12 && Math.abs(m2.rosseland[3] / (2 / (1e6 + 1e4)) - 1) < 1e-12 && Math.abs(m2.planck[3] / 5.05e-5 - 1) < 1e-12 && Math.abs(e2.tauV[j] / want - 1) < 1e-12 && e2.tauV[j] < 0.5 * (d1 + d2),
    `a grey gas: Rosseland, Planck and stellar means equal the opacity to ${wm.toExponential(1)}, the depths to ${wd.toExponential(1)}. Two opacities 100 times apart in equal shares: Rosseland ${m2.rosseland[3].toExponential(3)} (harmonic, 1.980e-6), Planck ${m2.planck[3].toExponential(3)} (arithmetic, 5.050e-5), and a grey-equivalent visible depth of ${e2.tauV[j].toFixed(3)} where the arithmetic mean would say ${(0.5 * (d1 + d2)).toFixed(3)}: the opaque half stops counting once it is black`);
  const adj = K.convectiveAdjustment([1000, 1010, 1400, 1500, 1501], [1, 2, 4, 8, 16].map((v) => v * 1e5)), lim = 1010 * 2 ** (2 / 7);
  check('convective adjustment puts steep layers on the adiabat and leaves the rest', adj.top === 2 && Math.abs(adj.t[2] - lim) < 1e-9 && adj.t[1] === 1010 && adj.t[3] === 1500 && adj.t[4] === 1501 && K.convectiveAdjustment([1000, 1010], [1e5, 2e5]).top === -1,
    `1400 K below 1010 K over a factor 2 in pressure becomes ${adj.t[2].toFixed(1)} K (1010 x 2^(2/7)); the stable layers above are untouched`);
}
{
  // real tables. HD 209458 b, solar composition in chemical equilibrium
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), chem: parseChem(load('../public/chem/equilibrium.eslc')) };
  const hd = { ...DEFAULT_MODEL, planet: { mplanet: 0.69, rplanet: 1.38, pRef: 0.01 }, star: { rstar: 1.19, teff: 6065, ars: 8.8 }, chemistry: { mh: 0 }, tp: { kind: 'consistent', teq: 1450, tint: 100 } };
  const r = K.consistentProfile(hd, tables, { cache: {} }), p = r.tp.p, at = (P) => { let j = 0; while (j < p.length - 1 && p[j] < P) j++; return j; }, j1 = at(1), jm = at(1e-2);
  const run = forwardModel({ ...hd, tp: r.tp }, tables, { want: { transmission: false } }), g = run.atm.g[j1] * 100, kth = (r.tau[j1] * g) / (p[j1] * 1e6), bal = K.energyBalance({ ...hd, tp: r.tp }, tables, { budget: hd.tp, result: run });
  const fixed = K.energyBalance({ ...hd, tp: { kind: 'guillot', teq: 1450, tint: 100, kappaIR: 1e-3, gamma: 0.4 } }, tables);
  const dip = Math.min(...r.tp.t.map((v, j) => (j <= at(0.1) ? 0 : v - r.tp.t[j - 1]))), mono = dip > -0.5;
  check('HD 209458 b: the profile converges, balances its energy, and lands near Guillot\'s calibrated opacities', r.converged && Math.abs(bal.ratio - 1) < 0.03 && r.scale > 0.8 && r.scale < 1.25 && r.gamma[j1] > 0.4 / 3 && r.gamma[j1] < 0.4 * 3 && kth > 1e-2 / 6 && kth < 1e-2 * 6 && mono,
    `${r.iterations} passes, last change ${r.change.toFixed(1)} K; emitted over required ${bal.ratio.toFixed(3)} (the fixed profile with κ = 1e-2 cm²/g, γ = 0.4 typed in: ${fixed.ratio.toFixed(2)}); the closure's one number, the factor c on T⁴ that sets the profile's level, is ${r.scale.toFixed(2)} (1 would mean the grey solution with these depths already balanced; tolerance 0.8 to 1.25). At 1 bar: γ = τ_v/τ = ${r.gamma[j1].toFixed(2)} and an equivalent thermal opacity τ g / P = ${kth.toExponential(1)} cm²/g, where Guillot (2010) found γ = 0.4 and 1e-2 cm²/g to reproduce detailed models of this planet (tolerance: a factor 3 and a factor 6; this is a comparison of order, not of profiles). Temperatures ${[1e-6, 1e-4, 1e-2, 1, 50].map((P) => `${r.tp.t[at(P)].toFixed(0)} K at ${P} bar`).join(', ')}; ${(100 * r.absorbed[j1]).toFixed(0)}% of the starlight absorbed above 1 bar; below 0.1 bar it rises with depth (largest step back ${dip.toFixed(2)} K). No radiative-convective profile from another code was compared`);
  const rich = K.consistentProfile({ ...hd, chemistry: { mh: 1.5 } }, tables, { cache: {} }), cool = K.consistentProfile({ ...hd, star: { ...hd.star, teff: 3500 } }, tables, { cache: {} });
  check('the profile answers to the composition and to the star', rich.tau[j1] > 1.5 * r.tau[j1] && rich.tp.t[jm] > r.tp.t[jm] + 50 && Math.abs(cool.gamma[jm] / r.gamma[jm] - 1) > 0.2 && rich.converged && cool.converged,
    `30 x the metals: thermal depth at 1 bar ${r.tau[j1].toFixed(1)} → ${rich.tau[j1].toFixed(1)}, ${r.tp.t[jm].toFixed(0)} → ${rich.tp.t[jm].toFixed(0)} K at 10 mbar. The same irradiation from a 3500 K star, whose light falls in the near infrared where water absorbs it: γ at 10 mbar ${r.gamma[jm].toFixed(2)} → ${cool.gamma[jm].toFixed(2)}, ${r.tp.t[at(1e-4)].toFixed(0)} → ${cool.tp.t[at(1e-4)].toFixed(0)} K at 0.1 mbar`);
}
{
  // a temperature inversion: an ultra-hot Jupiter whose gas-phase TiO and VO absorb the starlight high up.
  // WASP-121 b's day side (f = 1/2: no heat carried to the night side), Teq = 2358 K (Delrez et al. 2016)
  const tables = { lines: ['H2O', 'CO', 'Na', 'K', 'TiO', 'VO'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), chem: parseChem(load('../public/chem/equilibrium.eslc')) };
  const w121 = { ...DEFAULT_MODEL, planet: { mplanet: 1.18, rplanet: 1.81, pRef: 0.01 }, star: { rstar: 1.46, teff: 6460, ars: 3.75 }, chemistry: { mh: 0 }, tp: { kind: 'consistent', teq: 2358, tint: 100, f: 0.5 } };
  const r = K.consistentProfile(w121, tables, { cache: {} }), off = K.consistentProfile({ ...w121, opacityOff: ['TiO', 'VO'] }, tables, { cache: {} }), p = r.tp.p, at = (P) => { let j = 0; while (j < p.length - 1 && p[j] < P) j++; return j; };
  const span = (x) => { let lo = Infinity, jl = 0; for (let j = at(1e-3); j <= at(1); j++) if (x.tp.t[j] < lo) { lo = x.tp.t[j]; jl = j; } let hi = 0, jh = 0; for (let j = at(1e-5); j <= jl; j++) if (x.tp.t[j] > hi) { hi = x.tp.t[j]; jh = j; } return { lo, hi, pLo: p[jl], pHi: p[jh], rise: hi - lo }; };
  const a = span(r), b = span(off);
  check('an inversion forms where TiO and VO absorb the starlight, settles, and goes away without them', r.converged && off.converged && Math.abs(r.balance - 1) < 0.02 && Math.abs(off.balance - 1) < 0.02 && a.rise > 150 && a.rise < 600 && b.rise < 0.5 * a.rise && r.gamma[at(1e-3)] > 1 && off.gamma[at(1e-3)] < r.gamma[at(1e-3)],
    `WASP-121 b's day side with gas-phase TiO and VO: ${r.iterations} passes, emitted over required ${r.balance.toFixed(3)}, level factor ${r.scale.toFixed(2)}; coolest ${a.lo.toFixed(0)} K at ${(1e3 * a.pLo).toFixed(0)} mbar, rising to ${a.hi.toFixed(0)} K at ${(1e3 * a.pHi).toFixed(1)} mbar (${a.rise.toFixed(0)} K; tolerance 150 to 600 K), γ = ${r.gamma[at(1e-3)].toFixed(2)} at 1 mbar. A retrieval of its eclipse spectrum gives about 2500 K rising to 2800 K between 30 and 5 mbar (Mikal-Evans et al. 2019, MNRAS 488, 2222): the same sense and size, from another kind of analysis, not a profile compared layer by layer. With the lines of TiO and VO left out: ${off.iterations} passes, balance ${off.balance.toFixed(3)}, a rise of ${b.rise.toFixed(0)} K above the coolest layer and γ = ${off.gamma[at(1e-3)].toFixed(2)}`);
}
{
  // clouds enter the profile, and the balance the solver reports is the forward model's own
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), chem: parseChem(load('../public/chem/equilibrium.eslc')) };
  const base = { ...DEFAULT_MODEL, planet: { mplanet: 0.281, rplanet: 1.279, pRef: 0.01 }, star: { rstar: 0.939, teff: 5485, ars: 11.4 }, chemistry: { mh: 1 }, tp: { kind: 'consistent', teq: 1166, tint: 100 } };
  const rows = [['clear', {}], ['a grey deck at 1 mbar', { cloudTop: 1e-3 }], ['the deck over half the planet', { cloudTop: 1e-3, cloudFraction: 0.5 }], ['a particle layer', { cloud: { top: 1e-4, base: 1e-2, tau: 3, radius: 0.1, q0: 10, albedo: 0.9 } }]].map(([name, extra]) => {
    const m = { ...base, ...extra }, r = K.consistentProfile(m, tables, { cache: {} }), b = K.energyBalance({ ...m, tp: r.tp }, tables, { budget: m.tp }); let j = 0; while (r.tp.p[j] < 3e-4) j++;
    return { name, r, fm: b.ratio, t: r.tp.t[j] };
  });
  check('a cloud deck, partial cover and a particle layer enter the profile, and the reported balance is the forward model\'s', rows.every((x) => x.r.converged && Math.abs(x.r.balance - x.fm) < 2e-3 && Math.abs(x.fm - 1) < 0.02) && rows[1].t > rows[0].t + 10,
    rows.map((x) => `${x.name}: ${x.r.iterations} passes, emitted over required ${x.r.balance.toFixed(3)} by the solver and ${x.fm.toFixed(3)} by forwardModel on the returned profile, ${x.t.toFixed(0)} K at 0.3 mbar`).join('; ') + '. Tolerance: the two balances within 0.002 of each other and 0.02 of 1; the deck, which closes the deep windows, makes the layers above it warmer');
}
{
  // the top of the atmosphere: where the gas is too thin for the closure, the profile is held; without the hold the
  // lines of sodium and potassium, counted as heating, make a hot top whose hydrogen is atomic
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4', 'Na', 'K'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`../public/opacity/${s}.eslo`))), chem: parseChem(load('../public/chem/equilibrium.eslc')) };
  const { atmosphereOf } = await import('../src/core/rtmodel.js');
  const base = { ...DEFAULT_MODEL, pTop: 1e-8, nLayers: 80, planet: { mplanet: 0.281, rplanet: 1.279, pRef: 0.01 }, star: { rstar: 0.939, teff: 5485, ars: 11.4 }, vmr: {}, chemistry: { mh: 0 } };
  const run = (tp) => { const m = { ...base, tp: { kind: 'consistent', teq: 1166, tint: 100, ...tp } }, r = K.consistentProfile(m, tables, { cache: {} }), atm = atmosphereOf({ ...m, tp: r.tp }, tables), f = forwardModel({ ...m, tp: r.tp }, tables, { want: { transmission: false } }), i = f.wl.findIndex((v) => v > 0.5893) - 1; return { r, atm, na: f.brightness[i] - f.brightness[i - 4] }; };
  const held = run({}), free = run({ pIso: null }), noAlk = run({ pIso: null, _: 0 }), at = (x, P) => { let j = 0; while (j < x.atm.n - 1 && x.atm.pLay[j] < P * 1e5) j++; return j; };
  const off = (() => { const m = { ...base, opacityOff: ['Na', 'K'], tp: { kind: 'consistent', teq: 1166, tint: 100, pIso: null } }, r = K.consistentProfile(m, tables, { cache: {} }); return r.tp.t[0]; })();
  // Until the sodium and potassium tables were repaired (their line cores were up to 1e5 times too strong at low pressure,
  // test/opacity.test.mjs) the unheld profile reached 1884 K at the top and its hydrogen was 89% atomic. With line strength
  // conserved there is no such heating; the hold stays as a statement of where the closure and the tables end.
  check('the top of the atmosphere: no runaway heating by sodium and potassium once their lines conserve strength; the profile is held above the tables\' top', held.r.converged && free.r.converged && held.atm.tLay[0] === held.atm.tLay[at(held, 1e-5)] && Math.abs(free.atm.tLay[0] - held.atm.tLay[0]) < 60 && free.atm.species.H[0] < 1e-3 && held.atm.species.H[0] < 1e-3 && Math.abs(held.atm.tLay[at(held, 1e-3)] - free.atm.tLay[at(free, 1e-3)]) < 5 && Math.abs(off - free.atm.tLay[0]) < 80 && held.na < 0 && free.na < 0,
    `WASP-39 b, top at 1e-8 bar. Held above 1e-5 bar (the default): ${held.atm.tLay[0].toFixed(0)} K at the top, atomic hydrogen ${held.atm.species.H[0].toExponential(1)}. Not held: ${free.atm.tLay[0].toFixed(0)} K, hydrogen ${free.atm.species.H[0].toExponential(1)}; with the lines of Na and K left out ${off.toFixed(0)} K: within 80 K of one another (with the tables as ExoMolOP ships them the unheld top was 1884 K and 89% atomic). The sodium line in the eclipse spectrum is in absorption either way (${held.na.toFixed(0)} K in brightness temperature against its surroundings). At 1 mbar the two profiles agree to ${Math.abs(held.atm.tLay[at(held, 1e-3)] - free.atm.tLay[at(free, 1e-3)]).toFixed(1)} K`);
}
process.exit(ok ? 0 : 1);
