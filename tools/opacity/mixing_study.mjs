// How much of the difference from petitRADTRANS in a mixture is the mixing of species itself?
//
// Both codes combine k-distributions two at a time by random overlap and put the result back on 16 g-points after
// every pair (src/core/opacity.js `overlap`, with its three ways of doing so; petitRADTRANS's combine_ck_opacities). Here the same assumption is
// carried out without the intermediate 16-point steps: in every bin and layer, N joint samples are drawn (one g per
// species, independently, each node as often as its weight says), their opacities summed, sorted, and averaged into
// NG equal intervals of g. That is "random overlap, exactly" up to sampling; it is too slow for the app (N sums and
// a sort per bin and layer) and is only run here, on every STEP-th bin of a reference case.
//
//   node tools/opacity/mixing_study.mjs "warm, eight molecules" [step]
// Needs data-src/study/e1000g16 (the ExoMolOP tables at full resolution) and test/rt_reference.json.
import { readFileSync, readdirSync } from 'node:fs';
import { parseTable, crossSection, gasExtinction, addPerWavelength } from '../../src/core/opacity.js';
import { atmosphereOf } from '../../src/core/rtmodel.js';
import { addContinuum } from '../../src/core/continuum.js';
import { transmissionSpectrum, chordGeometry } from '../../src/core/transmission.js';
import { emissionSpectrum } from '../../src/core/emission.js';
import { C } from '../../src/core/derive.js';

const name = process.argv[2] || 'warm, eight molecules', STEP = +(process.argv[3] || 10), N = 4096, NG = 64;
const ref = JSON.parse(readFileSync(new URL('../../test/rt_reference.json', import.meta.url))), c = ref.cases[name];
if (!c) { console.error('no such case; have: ' + Object.keys(ref.cases).join(' | ')); process.exit(1); }
const dir = new URL('../../data-src/study/e1000g16/', import.meta.url);
const all = readdirSync(dir).filter((f) => f.endsWith('.eslo')).map((f) => { const b = readFileSync(new URL(f, dir)); return parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); });
const lines = Object.keys(c.model.vmr).map((sp) => all.find((t) => t.species === sp));
const [p0, p1, np] = ref.pressures, atm = atmosphereOf({ ...c.model, heH2: ref.heH2, pTop: p0, pBottom: p1, nLayers: np - 1 }), n = atm.n;
const t0 = lines[0], ng = t0.ng, w = t0.weights, nWl = t0.nWl;
let off = 0; while (t0.wl[off] < c.wl[0] * (1 - 2e-4)) off++;
const sel = []; for (let i = 0; i < c.wl.length; i += STEP) sel.push(i);
const wl = sel.map((i) => t0.wl[off + i]), nSel = sel.length;

// ---- sequential mixing, in the given order and reversed -------------------------------------------------------------
const pick = (ext, g) => { const out = new Float64Array(nSel * g * n); sel.forEach((i, a) => { for (let q = 0; q < g; q++) for (let j = 0; j < n; j++) out[(a * g + q) * n + j] = ext[((off + i) * g + q) * n + j]; }); return out; };
const mixed = (mixing, order = lines, greyBelow = 0) => { const t = performance.now(), e = pick(gasExtinction(atm, order, { greyBelow, mixing }).extinction, ng); return [e, performance.now() - t]; };
const seq = mixed('log'), rev = mixed('log', lines.slice().reverse()), fast = mixed('log', lines, 1e-2), mean = mixed('mean'), node = mixed('node');

// ---- random overlap without intermediate steps -------------------------------------------------------------------
let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const draws = lines.map(() => {   // per species: node index of each of the N samples, each node N w_q times, shuffled
  const idx = new Uint8Array(N); let k = 0, cum = 0;
  for (let q = 0; q < ng; q++) { cum += w[q]; const end = q === ng - 1 ? N : Math.round(cum * N); while (k < end) idx[k++] = q; }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx;
});
const exact = new Float64Array(nSel * NG * n), buf = new Float64Array(nWl * ng), sum = new Float64Array(N), per = N / NG;
const ks = lines.map(() => new Float64Array(nSel * ng));
for (let j = 0; j < n; j++) {
  lines.forEach((t, s) => { crossSection(t, atm.tLay[j], atm.pLay[j] / 1e5, buf); const f = atm.nd[j] * atm.species[t.species][j]; sel.forEach((i, a) => { for (let q = 0; q < ng; q++) ks[s][a * ng + q] = f * buf[(off + i) * ng + q]; }); });
  for (let a = 0; a < nSel; a++) {
    sum.fill(0);
    for (let s = 0; s < lines.length; s++) { const k = ks[s], d = draws[s], o = a * ng; for (let r = 0; r < N; r++) sum[r] += k[o + d[r]]; }
    sum.sort();
    for (let q = 0; q < NG; q++) { let m = 0; for (let r = q * per; r < (q + 1) * per; r++) m += sum[r]; exact[(a * NG + q) * n + j] = m / per; }
  }
}

// ---- spectra ----------------------------------------------------------------------------------------------------------
const scat = new Float64Array(nSel * n); addContinuum(atm, wl, scat, { rayleigh: true, hminus: false });
const geom = chordGeometry(atm), rstar = c.model.star.rstar * C.Rsun;
const run = (ext, g, wts) => {
  const flux = emissionSpectrum(atm, wl, ext.slice(), { weights: { ng: g, w: wts } }).flux;
  const depth = transmissionSpectrum(atm, addPerWavelength(ext.slice(), scat, nSel, g, n), rstar, { weights: { ng: g, w: wts }, geom }).depth;
  return { depth, flux };
};
const uniform = new Float64Array(NG).fill(1 / NG);
const R = { 'log mean (as shipped)': run(seq[0], ng, w), '... species in reverse order': run(rev[0], ng, w), '... with the grey shortcut': run(fast[0], ng, w),
  'mean': run(mean[0], ng, w), 'value at the node': run(node[0], ng, w), 'no intermediate steps': run(exact, NG, uniform), petitRADTRANS: { depth: sel.map((i) => c.depth[i]), flux: sel.map((i) => c.flux[i]) } };
const stat = (a, b, f) => { let s = 0, m = 0, mx = 0, at = 0; for (let i = 0; i < a.length; i++) { const d = f(a[i], b[i]); s += d * d; m += d; if (Math.abs(d) > mx) { mx = Math.abs(d); at = i; } } return `rms ${Math.sqrt(s / a.length).toFixed(2)}, mean ${(m / a.length).toFixed(2)}, max ${mx.toFixed(2)} at ${wl[at].toFixed(3)} µm`; };
console.log(`${name}: ${lines.map((t) => t.species).join(', ')}; ${nSel} of ${c.wl.length} bins, ${n} layers, ${N} joint samples into ${NG} g-intervals`);
const base = R['no intermediate steps'];
for (const [k, r] of Object.entries(R)) {
  if (r === base) continue;
  console.log(`${k.padEnd(30)} minus exact random overlap: depth [ppm] ${stat(r.depth, base.depth, (a, b) => (a - b) * 1e6)}; flux [%] ${stat(r.flux, base.flux, (a, b) => 100 * (a / b - 1))}`);
}
const ours = R['log mean (as shipped)'];
console.log(`${'log mean (as shipped)'.padEnd(30)} minus petitRADTRANS:        depth [ppm] ${stat(ours.depth, R.petitRADTRANS.depth, (a, b) => (a - b) * 1e6)}; flux [%] ${stat(ours.flux, R.petitRADTRANS.flux, (a, b) => 100 * (a / b - 1))}`);
console.log(`time for all ${c.wl.length} bins x ${n} layers: log ${(seq[1] / 1000).toFixed(1)} s, mean ${(mean[1] / 1000).toFixed(1)} s, node ${(node[1] / 1000).toFixed(1)} s, log with the grey shortcut ${(fast[1] / 1000).toFixed(1)} s`);
