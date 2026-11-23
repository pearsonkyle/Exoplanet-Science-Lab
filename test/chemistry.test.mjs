// Equilibrium chemistry (src/core/chemistry.js and the table public/chem/equilibrium.eslc) against FastChem run at
// points off the table's nodes, and FastChem itself against our own solution of the H-He-C-N-O gas
// (test/make_chem_reference.py -> chem_reference.json). Every tolerance is stated in its check.
import { readFileSync } from 'node:fs';
import { parseChem, equilibrium, equilibriumProfile, enriched, QUENCHED } from '../src/core/chemistry.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./chem_reference.json', import.meta.url)));
const b = readFileSync(new URL('../public/chem/equilibrium.eslc', import.meta.url)), table = parseChem(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const st = (e) => [Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length), Math.max(...e.map(Math.abs))];

{
  const names = table.species.filter((s) => s !== 'mu'), err = Object.fromEntries(names.map((s) => [s, []])), mu = [], inner = [];
  for (const q of ref.points) {
    const x = equilibrium(table, q.t, q.p, q);
    for (const s of names) if (q.x[s] > 1e-10) { const d = Math.log10(x[s] / q.x[s]); err[s].push(d); if (q.mh <= 2 && (q.co < 0.9 || q.co > 1.1)) inner.push(d); }
    mu.push(x.mu / q.mu - 1);
  }
  const all = Object.values(err).flat(), [rms, max] = st(all), [rmsIn, maxIn] = st(inner), worst = names.map((s) => [s, ...st(err[s])]).sort((a, c) => c[1] - a[1]);
  check('the chemistry table reproduces FastChem between its nodes', rms < 0.12 && rmsIn < 0.06 && Math.max(...mu.map(Math.abs)) < 0.05 && Math.abs(table.coSolar - ref.co_solar) < 1e-12,
    `log10 of the mixing ratio, table over FastChem, at ${ref.points.length} points (400-3400 K, 1e-7 to 30 bar, [M/H] -0.9 to 2.4, C/O 0.15 to 1.4), mixing ratios above 1e-10, ${names.length} species: rms ${rms.toFixed(3)} dex, max ${max.toFixed(2)} over ${all.length} values (tolerance 0.12 rms); away from C/O = 0.9-1.1 and up to 100 x solar: rms ${rmsIn.toFixed(3)}, max ${maxIn.toFixed(2)} over ${inner.length} (tolerance 0.06). Worst species (rms / max): ${worst.slice(0, 4).map((w) => `${w[0]} ${w[1].toFixed(3)} / ${w[2].toFixed(2)}`).join(', ')}. Mean molecular weight within 5% (found ${(100 * Math.max(...mu.map(Math.abs))).toFixed(1)}%). The Sun's C/O in the table is ${table.coSolar.toFixed(3)}`);
}
{
  // FastChem against our own solver, the same reduced problem; then what the other elements change
  const e = {}, full = [];
  for (const q of ref.points) if (q.own) for (const [s, v] of Object.entries(q.own)) {
    if (q.chon[s] > 1e-10) (e[s] ??= []).push(Math.log10(v / q.chon[s]));
    if (q.x[s] > 1e-10 && q.co <= 0.7 && ['H2O', 'CH4', 'CO', 'CO2', 'HCN'].includes(s)) full.push(Math.log10(v / q.x[s]));
  }
  const rows = Object.entries(e).map(([s, v]) => [s, ...st(v), v.length]), worst = Math.max(...rows.map((r) => r[2])), n = ref.points.filter((q) => q.own).length, res = Math.max(...ref.points.filter((q) => q.own).map((q) => q.own_residual));
  check('FastChem agrees with our own solution of the H-He-C-N-O gas', worst < 0.12 && rows.every((r) => r[1] < 0.03) && res < 1e-6,
    `15 species from H, C, N, O by the law of mass action, element conservation and the total pressure, Newton iteration (scipy), sharing only the equilibrium constants; ${n} points up to 3000 K and 10 x solar, every element but H, He, C, N, O taken out of FastChem: ${rows.map((r) => `${r[0]} ${r[1].toFixed(4)} / ${r[2].toFixed(3)}`).join(', ')} dex rms / max (tolerance 0.03 rms, 0.12 max; the largest are at C/O > 1 above 2200 K, where FastChem carries radicals ours does not). Largest residual of our equations ${res.toExponential(1)}. With FastChem's full set of elements instead, H2O, CH4, CO, CO2 and HCN differ from ours by ${st(full)[0].toFixed(3)} dex rms (max ${st(full)[1].toFixed(2)}) for C/O up to 0.7: oxygen held by silicon, magnesium and other metals, which is why the table is made with the full set`);
  const eV = (a1) => a1 * 8.617333262e-5, d = { H2: [eV(ref.a1.H2), 4.478], CO: [eV(ref.a1.C1O1), 11.09], N2: [eV(ref.a1.N2), 9.76], OH: [eV(ref.a1.H1O1), 4.39] };
  check('the equilibrium constants carry the molecules\' dissociation energies', Object.values(d).every(([got, want]) => Math.abs(got / want - 1) < 0.01),
    `the 1/T coefficient of ln K times k: ${Object.entries(d).map(([s, [got, want]]) => `${s} ${got.toFixed(3)} eV (D0 = ${want})`).join(', ')}; tolerance 1%. A sanity check of FastChem's data file (fits to JANAF), not a test of the constants over temperature: no second thermochemical table was compared`);
}
{
  const n = 30, p = Float64Array.from({ length: n }, (_, j) => 10 ** (-6 + (8 * (j + 0.5)) / n)), t = Float64Array.from(p, (v) => 900 + 250 * Math.log10(v + 1e-6) + 1500);
  const eq = equilibriumProfile(table, t, p, {}), qu = equilibriumProfile(table, t, p, { quench: 1 }), jq = p.findIndex((v) => v >= 1);
  const frozen = QUENCHED.every((s) => qu.species[s][0] === qu.species[s][jq] && qu.species[s][n - 1] === eq.species[s][n - 1]), free = qu.species.Na[0] === eq.species.Na[0];
  const off = equilibriumProfile(table, t, p, { exclude: ['H2O'], scale: { Na: 0.5, CO: Float64Array.from({ length: n }, (_, j) => (j === 0 ? 2 : 1)) } });
  const en = enriched({ mh: 0, co: 0.59 }, { C: 4, O: 9 }), sum = Object.values(eq.species).reduce((a, v) => a + v[10], 0);
  check('profiles: quenching freezes the carbon, oxygen and nitrogen carriers above the quench level', frozen && free && off.species.H2O.every((v) => v === 0) && Math.abs(off.species.Na[5] / eq.species.Na[5] - 0.5) < 1e-12 && Math.abs(off.species.CO[0] / eq.species.CO[0] - 2) < 1e-12 && Math.abs(en.mh - Math.log10(6)) < 1e-12 && Math.abs(en.co - 0.59 * 4 / 9) < 1e-12 && sum > 0.99 && sum <= 1.0001,
    `quench at 1 bar: ${QUENCHED.join(', ')} hold their 1 bar values up to the top and are untouched below; Na is not quenched; a gas can be switched off or scaled layer by layer; elements enriched 4 x (C) and 9 x (O) give [M/H] ${en.mh.toFixed(3)} and C/O ${en.co.toFixed(3)}; the kept species sum to ${sum.toFixed(4)} of the gas at 1 mbar`);
}
{
  // [M/H] and C/O are interpolated by a monotone cubic, not straight lines: nearer FastChem between the nodes, exact at
  // them, no step in the derivative across a node, and no overshoot where a gas falls steeply
  const names = table.species.filter((x) => x !== 'mu'), err = { lin: [], cub: [] };
  for (const q of ref.points) for (const [key, linear] of [['lin', true], ['cub', false]]) { const x = equilibrium(table, q.t, q.p, { mh: q.mh, co: q.co, linear }); for (const sp of names) if (q.x[sp] > 1e-10 && q.mh <= 2 && (q.co < 0.9 || q.co > 1.1)) err[key].push(Math.log10(x[sp] / q.x[sp])); }
  const [rl, ml] = st(err.lin), [rc, mc] = st(err.cub);
  let node = 0, over = 0;
  for (const mh of table.mh) for (const co of table.co) { const a2 = equilibrium(table, 1300, 0.01, { mh, co }), l = equilibrium(table, 1300, 0.01, { mh, co, linear: true }); for (const sp of names) if (l[sp] > 0) node = Math.max(node, Math.abs(Math.log10(a2[sp] / l[sp]))); }
  // between two nodes the cubic stays between the node values (no overshoot), here along C/O through the cliff at 1
  for (const T of [900, 1300, 2000]) for (let i = 0; i < table.co.length - 1; i++) { const A = equilibrium(table, T, 0.01, { mh: 0.3, co: table.co[i] }), B = equilibrium(table, T, 0.01, { mh: 0.3, co: table.co[i + 1] }); for (let k = 1; k < 10; k++) { const x = equilibrium(table, T, 0.01, { mh: 0.3, co: table.co[i] + (k / 10) * (table.co[i + 1] - table.co[i]) }); for (const sp of names) if (A[sp] > 0 && B[sp] > 0) over = Math.max(over, Math.log10(x[sp] / Math.max(A[sp], B[sp])), Math.log10(Math.min(A[sp], B[sp]) / x[sp])); } }
  const f = (co, linear) => Math.log10(equilibrium(table, 1300, 0.01, { mh: 0.3, co, linear }).H2O), g = (mh, linear) => Math.log10(equilibrium(table, 1300, 0.01, { mh, co: 0.55, linear }).H2O), h = 1e-4;
  const jump = (fn, x, linear) => Math.abs((fn(x + h, linear) - fn(x, linear)) / h - (fn(x, linear) - fn(x - h, linear)) / h), rows = [0.5, 0.6, 0.7, 0.8].map((c) => [c, jump(f, c, true), jump(f, c, false)]), jm = [jump(g, 0.5, true), jump(g, 0.5, false)];
  check('[M/H] and C/O are interpolated smoothly: nearer FastChem than straight lines, exact at the nodes, no step in the derivative', rc < rl && rc < 0.025 && node < 1e-12 && over < 0.02 && rows.every((r) => r[2] < 0.02 * Math.max(r[1], 0.05)) && jm[1] < 0.01,
    `log10 of the mixing ratio against FastChem off the nodes (${err.cub.length} values away from C/O = 0.9 to 1.1): rms ${rc.toFixed(4)} dex, max ${mc.toFixed(2)} with the monotone cubic; ${rl.toFixed(4)}, ${ml.toFixed(2)} with straight lines (tolerance 0.025 rms, and better than the lines). At the ${table.mh.length} × ${table.co.length} nodes the two agree to ${node.toExponential(0)} dex; between nodes the cubic leaves the range of the two node values by ${over.toExponential(0)} dex at most (tolerance 0.02: along one axis at a node of the other the cubic is monotone; off the node the two cubics in turn are not exactly so). Jump of d log10(H2O) / d(C/O) across a node at 1300 K, 10 mbar, [M/H] 0.3, straight lines then cubic: ${rows.map((r) => `${r[0]}: ${r[1].toFixed(2)}, ${r[2].toFixed(4)}`).join('; ')}; of d log10(H2O) / d[M/H] across 0.5: ${jm[0].toFixed(3)}, ${jm[1].toFixed(4)}. Not changed: temperature and pressure are still interpolated linearly`);
}
process.exit(ok ? 0 : 1);
