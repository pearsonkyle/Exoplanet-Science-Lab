// The cost in spectra of dropping every second temperature node of a k-table, for each interpolation rule
// (`interpolation` in gasExtinction): one gas at a time at R = 1000, the table with half its temperature nodes
// (data-src/study/e1000g16-t2) against the full one (e1000g16), and both against petitRADTRANS (test/rt_reference.json).
// Build the half table first:
//   .venv-rt/bin/python -c "import sys; sys.path.insert(0, 'tools/opacity'); import build_opacity as B
//   for sp in ['H2O', 'CO', 'CO2', 'CH4', 'TiO']:
//       s = B.read_exomol_k(sp); B.build_species(sp, f'data-src/study/e1000g16-t2/{sp}.eslo', ng=16, t_idx=B.thin(len(s[2]), 2), p_idx=B.thin(len(s[1]), 1), encoding='u16', src=s, merge=1, method='mean')"
//   node tools/opacity/interp_study.mjs
import { readFileSync } from 'node:fs';
import { parseTable } from '../../src/core/opacity.js';
import { forwardModel } from '../../src/core/rtmodel.js';

const ref = JSON.parse(readFileSync(new URL('../../test/rt_reference.json', import.meta.url)));
const load = (dir, sp) => { const b = readFileSync(new URL(`../../data-src/study/${dir}/${sp}.eslo`, import.meta.url)); return parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const [p0, p1, np] = ref.pressures;
const stat = (a, b, f) => { let s = 0, m = 0, n = 0; for (let i = 0; i < a.length; i++) { if (!(a[i] > 0 && b[i] > 0)) continue; const d = f(a[i], b[i]); s += d * d; m += d; n++; } return `${Math.sqrt(s / n).toFixed(2)} (${(m / n).toFixed(2)})`; };
console.log('rms (mean); depth in ppm, flux in %. "half": every second temperature node');
for (const [name, sp] of [['warm, H2O only', 'H2O'], ['warm, CO only', 'CO'], ['warm, CO2 only', 'CO2'], ['warm, CH4 only', 'CH4'], ['ultra-hot, TiO only', 'TiO']]) {
  const c = ref.cases[name], model = { ...c.model, heH2: ref.heH2, pTop: p0, pBottom: p1, nLayers: np - 1 };
  for (const interpolation of ['T', 'invT', 'sigmaT']) {
    const full = forwardModel(model, { lines: [load('e1000g16', sp)], cia: [] }, { greyBelow: 0, interpolation }), half = forwardModel(model, { lines: [load('e1000g16-t2', sp)], cia: [] }, { greyBelow: 0, interpolation });
    let o = 0; while (full.wl[o] < c.wl[0] * (1 - 2e-4)) o++;
    const sub = (a) => a.subarray(o, o + c.wl.length), dd = (a, b) => (a - b) * 1e6, ff = (a, b) => 100 * (a / b - 1);
    console.log(name.padEnd(20), interpolation.padEnd(7), 'half - full: depth', stat(sub(half.depth), sub(full.depth), dd).padEnd(15), 'flux', stat(sub(half.flux), sub(full.flux), ff).padEnd(14), '| full - pRT: depth', stat(sub(full.depth), c.depth, dd).padEnd(14), '| half - pRT: depth', stat(sub(half.depth), c.depth, dd));
  }
}
