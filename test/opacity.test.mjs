// Opacity tables (src/core/opacity.js): the file format, interpolation, the mixing of k-distributions, and the tables
// the app ships (public/opacity) against values read straight from the ExoMolOP and HITRAN source files
// (test/make_rt_reference.py -> rt_reference.json, sections "tables" and "cia"). Tolerances are stated in each check.
import { readFileSync } from 'node:fs';
import * as O from '../src/core/opacity.js';
import { buildAtmosphere } from '../src/core/atmosphere.js';
import { opacityByAbsorber, geometricAlbedo, atmosphereOf, forwardModel, dayNightModel, nightProfile, DEFAULT_MODEL } from '../src/core/rtmodel.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./rt_reference.json', import.meta.url)));
const ex = (x) => x.toExponential(1);
const shipped = (name) => { const b = readFileSync(new URL(`../public/opacity/${name}.eslo`, import.meta.url)); return O.parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// ---- 1. the file format ---------------------------------------------------------------------------------------------
{
  const h = { kind: 'ktable', species: 'X', wl: { min: 1, max: 2, n: 5 }, t: [500, 1000, 2000], p: [1e-3, 1e-1, 10], ng: 4, nodes: [0.1, 0.4, 0.7, 0.95], weights: [0.25, 0.25, 0.25, 0.25] };
  const logs = Float64Array.from({ length: 3 * 3 * 5 * 4 }, (_, i) => (i % 17 === 3 ? -Infinity : -30 + 12 * rnd()));
  const err = {};
  for (const type of ['u16', 'u8', 'f16']) {
    const t = O.parseTable(O.writeTable(h, logs, { type })); let w = 0, holes = true;
    for (let i = 0; i < logs.length; i++) { if (logs[i] === -Infinity) { if (t.logs[i] !== -Infinity) holes = false; } else w = Math.max(w, Math.abs(t.logs[i] - logs[i])); }
    err[type] = w; if (!holes) err[type] = NaN;
  }
  check('tables survive writing and reading in every encoding', err.u16 < 12 / 65534 / 2 + 1e-6 && err.u8 < 12 / 254 / 2 + 1e-6 && err.f16 < 0.008,
    `max error in log10 σ over a 12 dex range: uint16 ${ex(err.u16)} (half a step is ${ex(12 / 65534 / 2)}), uint8 ${ex(err.u8)} (${ex(12 / 254 / 2)}), float16 ${ex(err.f16)} (half a unit in the last place near 30 is 0.008); entries without opacity stay empty. In σ itself: ${(100 * (10 ** err.u16 - 1)).toFixed(3)}%, ${(100 * (10 ** err.u8 - 1)).toFixed(1)}%, ${(100 * (10 ** err.f16 - 1)).toFixed(1)}%`);
  const t = O.parseTable(O.writeTable(h, logs, { type: 'u16' })), a = new Float64Array(20), b = new Float64Array(20), c = new Float64Array(20), m = new Float64Array(20);
  O.crossSection(t, 1000, 0.1, a); O.crossSection(t, 2000, 0.1, b); O.crossSection(t, 4000 / 3, 0.1, m); O.crossSection(t, 9000, 1e5, c);
  let wNode = 0, wMid = 0, wClamp = 0; const top = new Float64Array(20); O.crossSection(t, 2000, 10, top);
  for (let k = 0; k < 20; k++) { const want = 1e-4 * 10 ** t.logs[(1 * 3 + 1) * 20 + k]; if (want > 0) wNode = Math.max(wNode, Math.abs(a[k] / want - 1)); if (a[k] > 0 && b[k] > 0) wMid = Math.max(wMid, Math.abs(m[k] / Math.sqrt(a[k] * b[k]) - 1)); if (top[k] > 0) wClamp = Math.max(wClamp, Math.abs(c[k] / top[k] - 1)); }
  check('interpolation is bilinear in (log P, 1/T) on log σ, clamped at the edges', wNode < 1e-6 && wMid < 1e-6 && wClamp < 1e-12, `at a node ${ex(wNode)}; halfway in 1/T (1333 K between 1000 and 2000 K) the geometric mean of the neighbours to ${ex(wMid)}; outside the grid the edge value to ${ex(wClamp)}; cm² become m²`);
}

// ---- 2. mixing k-distributions ----------------------------------------------------------------------------------------
{
  // an atmosphere of one layer with two "species": H2O carries a k-distribution, CO2 a grey or a second distribution
  const nodes = [0.0178695, 0.0915001, 0.2135104, 0.3674544, 0.5325456, 0.6864896, 0.8084999, 0.8821304, 0.9019855, 0.9101667, 0.9237234, 0.9408283, 0.9591717, 0.9762766, 0.9898333, 0.9980145];
  const weights = [0.0455528, 0.1000715, 0.141168, 0.1632077, 0.1632077, 0.141168, 0.1000715, 0.0455528, 0.0050614, 0.0111191, 0.0156853, 0.0181342, 0.0181342, 0.0156853, 0.0111191, 0.0050614];
  const mk = (species, k) => O.makeTable({ kind: 'ktable', species, wl: { min: 1, max: 2, n: 1 }, t: [1000], p: [1], ng: 16, nodes, weights }, Float32Array.from(k, (v) => Math.log10(v)));
  const atm = buildAtmosphere({ mplanet: 1, rplanet: 1, tp: 1000, nLayers: 1, pTop: 0.5, pBottom: 2, fill: false, vmr: { H2O: 0.5, CO2: 0.5 } }), f = atm.nd[0] * 0.5 * 1e-4;
  const kA = nodes.map((g) => 1e-24 * Math.exp(12 * g * g)), grey = nodes.map(() => 3e-23);
  const r = O.gasExtinction(atm, [mk('H2O', kA), mk('CO2', grey)], { greyBelow: 0 }).extinction;
  const dG = Math.max(...nodes.map((_, q) => Math.abs(r[q] / (f * (kA[q] + 3e-23)) - 1)));
  check('adding a grey absorber shifts a k-distribution by its opacity', dG < 0.02, `max relative difference ${ex(dG)} over 16 g-points with every species resorted; tolerance 2% (single-precision table values; the resorted pairs are interpolated back onto the nodes)`);
  // two random spectra whose exact joint distribution is known
  const N = 60000, spec = (lines, amp) => { const s = new Float64Array(N).fill(1e-27 * amp); for (let l = 0; l < lines; l++) { const c = rnd() * N, S = amp * 1e-22 * Math.exp(2 * (rnd() + rnd() + rnd() - 1.5)), w = 3 + 20 * rnd(); for (let i = Math.max(0, (c - 60 * w) | 0); i < Math.min(N, c + 60 * w); i++) s[i] += S / (1 + ((i - c) / w) ** 2); } return s; };
  const kd = (s) => { const t = Float64Array.from(s).sort(); return nodes.map((g) => { const p = g * N - 0.5, i = Math.min(N - 2, Math.max(0, Math.floor(p))); return Math.exp(Math.log(t[i]) * (1 - (p - i)) + Math.log(t[i + 1]) * (p - i)); }); };
  let worst = 0, worstExact = 0, shortcut = 0;
  for (let trial = 0; trial < 6; trial++) {
    const A = spec(300, 1), B = spec(120, [1, 0.2, 0.05][trial % 3]), S = Float64Array.from(A, (v, i) => v + B[i]), mean = S.reduce((x, y) => x + y, 0) / N;
    const tabs = [mk('H2O', kd(A)), mk('CO2', kd(B))], mix = O.gasExtinction(atm, tabs, { greyBelow: 0 }).extinction, fast = O.gasExtinction(atm, tabs).extinction, exact = kd(S);
    for (const u of [0.03, 0.1, 0.3, 1, 3, 10]) {
      let t = 0; for (let i = 0; i < N; i++) t += Math.exp((-u * S[i]) / mean); t /= N;
      const tq = (k, sc) => weights.reduce((x, w, q) => x + w * Math.exp((-u * k[q] * sc) / mean), 0);
      worst = Math.max(worst, Math.abs(tq(mix, 1 / f) - t)); worstExact = Math.max(worstExact, Math.abs(tq(exact, 1) - t)); shortcut = Math.max(shortcut, Math.abs(tq(fast, 1 / f) - tq(mix, 1 / f)));
    }
  }
  check('random overlap of two uncorrelated spectra reproduces their joint transmittance', worst < 0.06 && worstExact < 0.01 && shortcut < 0.01,
    `max error in transmittance over columns from 0.03 to 10 mean free paths, 6 pairs of synthetic line spectra: ${worst.toFixed(4)} after mixing two 16-point distributions, against ${worstExact.toFixed(4)} for the exact joint distribution on the same 16 points; tolerance 0.06 and 0.01. Mixing is the larger error: each species is known at 16 points only. The grey shortcut changes it by ${ex(shortcut)}`);
}

// ---- 3. the shipped tables against the source files ---------------------------------------------------------------------
{
  const t = shipped('H2O'), g = ref.tables.grid, merge = Math.round(g[2] / t.nWl);
  check('shipped H2O table: grid and provenance', t.kind === 'ktable' && merge === 5 && Math.abs(t.wl[0] / Math.sqrt(g[0] * g[0] * Math.pow(g[1] / g[0], 5 / g[2])) - 1) < 1e-9 && /CC BY-SA 4.0/.test(t.licence) && /^10\./.test(t.doi),
    `${t.nWl} bins of ${merge} ExoMolOP bins each (R = ${(1 / Math.log(t.edges[1] / t.edges[0])).toFixed(0)}), ${t.edges[0].toFixed(3)}-${t.edges[t.nWl].toFixed(2)} µm, ${t.ng} g-points, ${t.t.length} temperatures ${t.t[0]}-${t.t[t.t.length - 1]} K, ${t.p.length} pressures ${t.p[0]}-${t.p[t.p.length - 1]} bar, ${t.encoding.type}, ${(t.bytes / 1e6).toFixed(2)} MB; "${t.source}", DOI ${t.doi}, ${t.licence}`);
  const out = new Float64Array(t.nWl * t.ng), on = [], off = [];
  for (const r of ref.tables.rows) {
    O.crossSection(t, r.t, r.p, out);
    let m = 0; for (let q = 0; q < t.ng; q++) m += t.weights[q] * out[r.bin * t.ng + q];
    (r.kept ? on : off).push(m / 1e-4 / r.mean - 1);
  }
  const st = (d) => [Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length), Math.max(...d.map(Math.abs))], [rmsOn, maxOn] = st(on), [rmsOff, maxOff] = st(off), stepPct = 100 * (10 ** ((t.encoding.hi - t.encoding.lo) / 254) - 1);
  check('shipped H2O table: bin-mean cross-sections against the source k-table', maxOn < 0.15 && rmsOff < 0.4 && Math.abs(t.edges[ref.tables.rows[0].bin] / ref.tables.rows[0].lo - 1) < 1e-9,
    `mean over g of the shipped table against the mean of the 5 source bins it joins, 4 bins from 0.6 to 27 µm: at 3 pressure-temperature nodes the table keeps, rms ${(100 * rmsOn).toFixed(1)}%, max ${(100 * maxOn).toFixed(1)}% (tolerance 15%: the 12 g-points hold the log mean of k over their intervals, which lies below the mean, and the uint8 steps are ${stepPct.toFixed(1)}%); at 3 pressures halfway between kept nodes, rms ${(100 * rmsOff).toFixed(1)}%, max ${(100 * maxOff).toFixed(1)}% (tolerance 40% rms). Between nodes log k is interpolated at fixed g, which does not keep the mean where pressure broadening reshapes the distribution; the cost in spectra is measured in the study (halving the pressure nodes: about 1 ppm rms)`);
  const index = JSON.parse(readFileSync(new URL('../public/opacity/index.json', import.meta.url)));
  const all = index.tables.filter((x) => x.kind === 'ktable').map((x) => shipped(x.species)), grid = O.commonGrid([...all, shipped('H2-H2'), shipped('H2-He')]);
  check('the shipped tables share one grid', grid.nWl === t.nWl && grid.ng === t.ng, `${all.map((x) => x.species).join(', ')} and both CIA tables: ${grid.nWl} bins, ${grid.ng} g-points, ${((all.reduce((a, x) => a + x.bytes, 0)) / 1e6).toFixed(1)} MB of line tables`);
}
{
  // temperature nodes the shipped tables drop, against the source's own values there
  const I = ref.tinterp, rows = [], all = { inv: [], lin: [] };
  for (const [sp, r] of Object.entries(I.species)) {
    const t = shipped(sp), a = new Float64Array(t.nWl * t.ng), lo = new Float64Array(t.nWl * t.ng), hi = new Float64Array(t.nWl * t.ng), e = { inv: [], lin: [] };
    r.t.forEach((T, n) => {
      const k = t.t.findIndex((x) => x > T); O.crossSection(t, T, I.p, a); O.crossSection(t, t.t[k - 1], I.p, lo); O.crossSection(t, t.t[k], I.p, hi);
      const f = (T - t.t[k - 1]) / (t.t[k] - t.t[k - 1]);
      I.bins.forEach((b, i) => {
        const want = r.mean[n][i]; if (!(want > 1e-26)) return;
        let m = 0, ml = 0; for (let q = 0; q < t.ng; q++) { const o = b * t.ng + q; m += t.weights[q] * a[o]; ml += t.weights[q] * (lo[o] > 0 && hi[o] > 0 ? Math.exp((1 - f) * Math.log(lo[o]) + f * Math.log(hi[o])) : 0); }
        e.inv.push(Math.log10(m / 1e-4 / want)); if (ml > 0) e.lin.push(Math.log10(ml / 1e-4 / want));
      });
    });
    const st = (d) => [d.reduce((x, y) => x + y, 0) / d.length, Math.sqrt(d.reduce((x, y) => x + y * y, 0) / d.length)];
    rows.push(`${sp} ${st(e.inv).map((v) => v.toFixed(3)).join(' / ')} (${st(e.lin).map((v) => v.toFixed(3)).join(' / ')})`); all.inv.push(...e.inv); all.lin.push(...e.lin);
  }
  const mean = (d) => d.reduce((x, y) => x + y, 0) / d.length, bi = mean(all.inv), bl = mean(all.lin);
  check('between temperature nodes the shipped tables are unbiased when interpolated in 1/T', Math.abs(bi) < 0.01 && Math.abs(bl) > 2 * Math.abs(bi),
    `log10 of the bin-mean cross-section over that of the source, reduced the same way, at ${I.species.H2O.t.join(', ')} K (nodes the shipped tables do not keep), ${I.p.toPrecision(3)} bar, ${I.bins.length} bins from 0.6 to 12 µm where σ > 1e-26 cm²: mean ${bi.toFixed(4)} dex (${(100 * (10 ** bi - 1)).toFixed(1)}%) over ${all.inv.length} values, against ${bl.toFixed(4)} dex (${(100 * (10 ** bl - 1)).toFixed(1)}%) when interpolated linearly in T; tolerance 0.01 dex. Mean / rms per species in 1/T (linear in T): ${rows.join('; ')}`);
}
{
  const tabs = { 'H2-H2': shipped('H2-H2'), 'H2-He': shipped('H2-He') }, d = [], out = {};
  for (const r of ref.cia) {
    const t = tabs[r.pair], s = (out[r.pair] ??= new Float64Array(t.nWl)); O.crossSection(t, r.t, 1, s);
    let i = 0; while (t.edges[i + 1] < r.wl) i++;
    d.push(s[i] / 1e-10 / r.k - 1);
  }
  const w = Math.max(...d.map(Math.abs));
  check('shipped CIA tables match the HITRAN files', w < 0.05, `max relative difference ${(100 * w).toFixed(1)}% over ${d.length} values (H2-H2 and H2-He at 500, 1000, 2000 K and 2.2, 5, 12 µm): the table holds bin means and every second temperature of the file, the reference is the file's value at the wavelength; tolerance 5%. H2-H2 at 1000 K, 2.2 µm: ${ref.cia.find((r) => r.pair === 'H2-H2' && r.t === 1000 && r.wl === 2.2).k.toExponential(3)} cm⁵ per pair in the file`);
  // a slab of H2 alone: optical depth of CIA = k n² L
  const atm = buildAtmosphere({ mplanet: 1, rplanet: 1, tp: 1000, nLayers: 1, pTop: 0.9, pBottom: 1.1, fill: false, vmr: { H2: 1 } });
  const e = O.gasExtinction(atm, [], { cia: [tabs['H2-H2']] }), t = tabs['H2-H2']; let i = 0; while (t.edges[i + 1] < 2.2) i++;
  const want = ref.cia.find((r) => r.pair === 'H2-H2' && r.t === 1000 && r.wl === 2.2).k * 1e-10 * atm.nd[0] ** 2;
  check('collision-induced extinction is k n²', Math.abs(e.extinction[i] / want - 1) < 0.05, `${e.extinction[i].toExponential(3)} m⁻¹ at 2.2 µm, 1000 K, ${(atm.pLay[0] / 1e5).toFixed(2)} bar of H2 against ${want.toExponential(3)} from the file's value and n = P/kT; tolerance 5%`);
}
{
  // the per-absorber split the opacity plot draws, against the extinction the spectrum is computed from
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4'].map(shipped), cia: [shipped('H2-H2'), shipped('H2-He')] }, j = 40;
  const r = opacityByAbsorber(DEFAULT_MODEL, tables, j), atm = atmosphereOf(DEFAULT_MODEL), ng = tables.lines[0].ng;
  let sum = 0; for (let i = 0; i < r.wl.length; i++) { let t = 0; for (const p of r.parts) t += p.y[i]; sum = Math.max(sum, Math.abs(t / r.total[i] - 1)); }
  // H2O alone through gasExtinction (no CIA, no shortcut): the weighted mean over g of its extinction in layer j
  const g = O.gasExtinction(atm, tables.lines, { cia: [], only: ['H2O'], greyBelow: 0 }), h2o = r.parts.find((p) => p.name === 'H2O').y;
  let dw = 0; for (let i = 0; i < r.wl.length; i++) { let m = 0; for (let q = 0; q < ng; q++) m += g.weights.w[q] * g.extinction[(i * ng + q) * atm.n + j]; if (m > 0) dw = Math.max(dw, Math.abs(h2o[i] / m - 1)); }
  // and the whole mixture: random overlap keeps the bin mean of a sum of uncorrelated absorbers
  const mix = O.gasExtinction(atm, tables.lines, { cia: tables.cia, greyBelow: 0 }), gasTotal = new Float64Array(r.wl.length);
  for (const p of r.parts) if (!['Rayleigh', 'haze', 'cloud', 'H-'].includes(p.name)) for (let i = 0; i < r.wl.length; i++) gasTotal[i] += p.y[i];
  const dm = []; for (let i = 0; i < r.wl.length; i++) { let m = 0; for (let q = 0; q < ng; q++) m += mix.weights.w[q] * mix.extinction[(i * ng + q) * atm.n + j]; dm.push(m / gasTotal[i] - 1); }
  const rms = Math.sqrt(dm.reduce((a, b) => a + b * b, 0) / dm.length), max = Math.max(...dm.map(Math.abs));
  check('opacity by absorber: the parts add up, and each is the mean over g of what the spectrum uses', sum < 1e-12 && dw < 1e-12 && rms < 0.02 && max < 0.15,
    `layer ${j} of 60 (${r.p.toExponential(2)} bar, ${r.t.toFixed(0)} K): ${r.parts.map((p) => p.name).join(', ')}; Σ parts / total - 1 = ${sum.toExponential(1)}; H2O against gasExtinction restricted to H2O ${dw.toExponential(1)}; mean over g of the mixed k-distribution against the sum of the gas parts: rms ${(100 * rms).toFixed(2)}%, max ${(100 * max).toFixed(1)}% over ${dm.length} bins (tolerance 2% rms, 15% max: the resort onto ${ng} g-points does not conserve the mean exactly)`);
  // the display albedo: its limits
  const fake = (ext, abs) => ({ atm: { n: 2, dr: [1, 1] }, grid: { ng: 1, nWl: 1 }, weights: null, extinction: Float64Array.from(ext), absorption: Float64Array.from(abs) });
  const a1 = geometricAlbedo(fake([1, 1], [0, 0]))[0], a0 = geometricAlbedo(fake([1, 1], [1, 1]))[0], ah = geometricAlbedo(fake([2, 2], [1, 1]))[0], s = Math.sqrt(0.5);
  check('albedo estimate: 2/3 for pure scattering, 0 for pure absorption', Math.abs(a1 - 2 / 3) < 1e-15 && a0 === 0 && Math.abs(ah - (2 / 3) * (1 - s) / (1 + s)) < 1e-15,
    `${a1.toFixed(4)}, ${a0}, and ${ah.toFixed(4)} at a single-scattering albedo of 0.5 (two-stream, (1 - s)/(1 + s) with s = √(1 - ω), times the Lambert 2/3). These are the formula's limits, not a comparison with a scattering code: the estimate is for display only`);
}
{
  // the cloud deck: smooth in its top pressure, never below the bare opaque disc; patchy cover is the mix of two runs
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4'].map(shipped), cia: [shipped('H2-H2'), shipped('H2-He')] }, rs = DEFAULT_MODEL.star.rstar * 6.957e8;
  const at = (r, w) => r.wl.findIndex((x) => x > w), d = [], under = [];
  for (let l = -3; l <= -2.4999; l += 0.025) {
    const m = { ...DEFAULT_MODEL, cloudTop: 10 ** l }, r = forwardModel(m, tables, { want: { emission: false } }), a = r.atm; let k = 0; while (a.pLev[k] < m.cloudTop * 1e5 * (1 - 1e-9)) k++;
    d.push(r.depth[at(r, 1.05)] * 1e6); under.push(Math.min(...Array.from(r.depth, (v) => v - (a.rLev[k] / rs) ** 2)) * 1e6);
  }
  const steps = d.slice(1).map((v, i) => d[i] - v), smin = Math.min(...steps), smax = Math.max(...steps);
  const full = forwardModel({ ...DEFAULT_MODEL, cloudTop: 1e-3 }, tables), none = forwardModel(DEFAULT_MODEL, tables), half = forwardModel({ ...DEFAULT_MODEL, cloudTop: 1e-3, cloudFraction: 0.3 }, tables);
  let wm = 0, wf = 0; for (let i = 0; i < full.depth.length; i++) { wm = Math.max(wm, Math.abs(half.depth[i] - (0.3 * full.depth[i] + 0.7 * none.depth[i]))); wf = Math.max(wf, Math.abs(half.flux[i] / (0.3 * full.flux[i] + 0.7 * none.flux[i]) - 1)); }
  check('cloud deck: the depth follows its top pressure smoothly and stays above the bare disc; patchy cover mixes', smin > 0 && smax / smin < 1.25 && Math.min(...under) > -0.01 && wm < 2e-6 && wf < 1e-3,
    `top from 1e-3 to 3.2e-3 bar in 20 steps of 0.025 dex, 60 layers, depth at 1.05 µm: each step lowers it by ${smin.toFixed(1)} to ${smax.toFixed(1)} ppm (before a level was moved onto the deck: 0 or 114 ppm); lowest depth over all wavelengths minus that of the opaque disc at the deck: ${Math.min(...under).toFixed(1)} ppm (was -96). With 30% cover the depth is 0.3 cloudy + 0.7 clear to ${(wm * 1e6).toFixed(2)} ppm and the flux to ${wf.toExponential(1)}; the residue is the level that the deck moves, which the clear run does not have`);
}
{
  // a cooler night side: three columns of the same model; ionization reaching the opacity and the spectrum; the sodium line
  const tables = { lines: ['H2O', 'CO2', 'CO', 'CH4', 'Na'].map(shipped), cia: [shipped('H2-H2'), shipped('H2-He')] };
  const base = { ...DEFAULT_MODEL, star: { ...DEFAULT_MODEL.star, ars: 11.4 }, vmr: { ...DEFAULT_MODEL.vmr, Na: 2e-6 }, pTop: 1e-8, nLayers: 80 }, at = (r, w) => r.wl.findIndex((x) => x > w) - 1;
  const one = forwardModel(base, tables), same = dayNightModel({ ...base, night: { dT: 1e-9 } }, tables), dn = dayNightModel({ ...base, night: { dT: 500 } }, tables);
  let w = 0; for (let i = 0; i < one.depth.length; i++) w = Math.max(w, Math.abs(same.depth[i] - one.depth[i]) * 1e6, Math.abs(same.fpfs[i] / one.fpfs[i] - 1));
  const j = 45, mean = Math.abs(dn.atm.tLay[j] - 0.5 * (dn.day.atm.tLay[j] + dn.nightSide.atm.tLay[j])), k = at(dn, 4.5);
  const cool = forwardModel({ ...base, tp: nightProfile(base.tp, 500) }, tables), dayFlux = Math.max(...Array.from(dn.flux, (v, i) => Math.abs(v / one.flux[i] - 1))), nightFlux = Math.max(...Array.from(dn.nightSide.flux, (v, i) => Math.abs(v / cool.flux[i] - 1)));
  check('day and night columns: emission from the day side, transmission from the mean limb', w < 1e-6 && mean < 1e-9 && dayFlux < 1e-12 && nightFlux < 1e-12 && dn.depth[k] < one.depth[k] && dn.nightSide.fpfs[k] < 0.2 * dn.fpfs[k],
    `with no contrast the three-column model is the one-column model (${w.toExponential(1)}); with a night side 500 K cooler the limb layer at ${(dn.atm.pLay[j] / 1e5).toExponential(1)} bar is at ${dn.atm.tLay[j].toFixed(1)} K, the mean of ${dn.day.atm.tLay[j].toFixed(1)} and ${dn.nightSide.atm.tLay[j].toFixed(1)}; the day flux is the unchanged model's and the night flux that of a planet with the night profile (${dayFlux.toExponential(1)}, ${nightFlux.toExponential(1)}); the cooler limb lowers the transit depth at 4.5 µm from ${(one.depth[k] * 1e6).toFixed(0)} to ${(dn.depth[k] * 1e6).toFixed(0)} ppm; eclipse depth there ${(dn.fpfs[k] * 1e6).toFixed(0)} ppm from the day side, ${(dn.nightSide.fpfs[k] * 1e6).toFixed(0)} ppm if the night side faced us. An interpolation between two profiles, not a circulation model`);
  const ionM = { ...base, ionization: { fxuv: 1.7 } }, ion = forwardModel(ionM, tables), hi = 12, lo = 50, na = (m, layer) => Math.max(...opacityByAbsorber(m, tables, layer).parts.find((p) => p.name === 'Na').y);
  const d = at(ion, 0.5893), half = ion.atm.ionization.Na.half;
  check('ionization reaches the plots: sodium\'s opacity falls where it is ionized, and the line core with it', na(ionM, hi) < 0.05 * na(base, hi) && Math.abs(na(ionM, lo) / na(base, lo) - 1) < 0.02 && ion.depth[d] < one.depth[d] && half > 1e-7 && half < 1e-3 && !ion.atm.ionization.H,
    `sodium half ionized at ${half.toExponential(1)} bar. Its peak extinction at ${(ion.atm.pLay[hi] / 1e5).toExponential(1)} bar falls to ${(100 * na(ionM, hi) / na(base, hi)).toFixed(1)}% of the neutral value and is unchanged (${(100 * na(ionM, lo) / na(base, lo)).toFixed(1)}%) at ${(ion.atm.pLay[lo] / 1e5).toExponential(1)} bar; the transit depth in the bin of the D lines drops from ${(one.depth[d] * 1e6).toFixed(0)} to ${(ion.depth[d] * 1e6).toFixed(0)} ppm at R = 200. Without chemistry there is no atomic hydrogen to ionize`);
  const noNa = forwardModel({ ...base, vmr: DEFAULT_MODEL.vmr }, tables), lift = (wl) => (one.depth[at(one, wl)] - noNa.depth[at(one, wl)]) * 1e6, peak = one.wl[Array.from(one.depth, (v, i) => (one.wl[i] > 0.45 && one.wl[i] < 0.75 ? v - noNa.depth[i] : 0)).reduce((b, v, i, a2) => (v > a2[b] ? i : b), 0)];
  const tNa = tables.lines[4], x = new Float64Array(tNa.nWl * tNa.ng); O.crossSection(tNa, 1000, 2.15e-2, x); const bm = (wl) => { const i = tNa.wl.findIndex((v) => v > wl) - 1; let m = 0; for (let q = 0; q < tNa.ng; q++) m += tNa.weights[q] * x[i * tNa.ng + q]; return m * 1e4; };
  check('sodium: the D lines stand at 0.589 µm, with wings on both sides', Math.abs(peak - 0.5893) < 0.004 && lift(0.5893) > 1.5 * lift(0.58) && lift(0.58) > lift(0.56) && lift(0.56) > lift(0.52) && lift(0.6) > lift(0.62) && lift(0.62) > lift(0.66) && lift(0.45) < 5 && bm(0.5893) > 1e4 * bm(0.58) && bm(0.5893) < 1.2e-14,
    `transit depth added by Na at 2e-6: ${[0.45, 0.52, 0.56, 0.58, 0.5893, 0.6, 0.62, 0.66, 0.8].map((v) => `${v}: ${lift(v).toFixed(0)}`).join(', ')} ppm (µm: ppm), largest in the bin at ${peak.toFixed(4)} µm. The shipped table's bin mean at 1000 K and 21 mbar is ${bm(0.5893).toExponential(1)} cm² in that bin against ${bm(0.58).toExponential(1)} at 0.58 µm. A plot that starts at 0.6 µm shows only the red wing, which looks like a haze slope`);
}
{
  const b = O.binSpectrum([1, 1.001, 1.002, 1.5, 1.6, 2.5], [1, 2, 3, 10, 20, 7], { edges: [1, 1.2, 2, 3] });
  check('binning averages the points inside each bin', b.value[0] === 2 && b.value[1] === 15 && b.value[2] === 7 && b.count[0] === 3, `${Array.from(b.value).join(', ')} from 3, 2 and 1 points`);
}
{
  // speed for retrievals: the WebAssembly kernel, tables cut to the data's range, bins joined, results kept
  const sp = ['H2O', 'CO2', 'CO', 'CH4', 'NH3', 'SO2'], tables = { lines: sp.map(shipped), cia: ['H2-H2', 'H2-He'].map(shipped) };
  const m = { ...DEFAULT_MODEL, vmr: { H2O: 1e-3, CO2: 1e-5, CO: 3e-4, CH4: 1e-6, NH3: 1e-6, SO2: 1e-6 } }, want = { emission: false };
  const kernel = await O.loadMixKernel(readFileSync(new URL('../public/wasm/mix.wasm', import.meta.url)));
  const atm = atmosphereOf(m, tables), js = O.gasExtinction(atm, tables.lines, { cia: tables.cia }), wa = O.gasExtinction(atm, tables.lines, { cia: tables.cia, kernel });
  let w = 0; for (let i = 0; i < js.extinction.length; i++) if (js.extinction[i] > 0) w = Math.max(w, Math.abs(wa.extinction[i] / js.extinction[i] - 1));
  let wl = 0; for (let i = 0; i < 2e5; i++) { const x = Math.exp((((i * 7919) % 200000) / 200000 - 0.5) * 1400); wl = Math.max(wl, Math.abs(O._fastLn(x) - Math.log(x))); }
  check('the WebAssembly mixing kernel gives the JavaScript loop\'s extinction', w < 1e-12 && wl < 2e-9,
    `six gases, ${js.grid.nWl} bins x ${js.grid.ng} g-points x ${atm.n} layers: largest relative difference ${ex(w)} (tolerance 1e-12). Both use the same series for ln k, within ${ex(wl)} of Math.log over 600 decades (tolerance 2e-9; a k-distribution carries far less)`);
  const full = forwardModel(m, tables, { want }), cut = O.prepareTables(tables, { wlMin: 0.6, wlMax: 5.3 }), rc = forwardModel(m, cut, { want }), o = full.wl.findIndex((v) => Math.abs(v / rc.wl[0] - 1) < 1e-9);
  let wc = 0; for (let i = 0; i < rc.wl.length; i++) wc = Math.max(wc, Math.abs(rc.depth[i] - full.depth[o + i]));
  const edges = [0.6]; while (edges[edges.length - 1] < 5.3) edges.push(edges[edges.length - 1] * Math.exp(1 / 100));
  const half = O.prepareTables(tables, { wlMin: 0.6, wlMax: 5.3, merge: 2 }), rh = forwardModel(m, half, { want }), b0 = O.binSpectrum(full.wl, full.depth, { edges }), b1 = O.binSpectrum(rh.wl, rh.depth, { edges });
  let s2 = 0, mx = 0, c = 0; for (let i = 0; i < b0.value.length; i++) if (b0.count[i] && b1.count[i]) { const d = (b1.value[i] - b0.value[i]) * 1e6; s2 += d * d; mx = Math.max(mx, Math.abs(d)); c++; }
  const rms = Math.sqrt(s2 / c), t1 = half.lines[0], t0 = cut.lines[0], x0 = new Float64Array(t0.nWl * t0.ng), x1 = new Float64Array(t1.nWl * t1.ng); O.crossSection(t0, t0.t[5], t0.p[6], x0); O.crossSection(t1, t1.t[5], t1.p[6], x1);
  check('tables cut to a wavelength window give the same spectrum there; bins joined in pairs stay within a few ppm', o >= 0 && rc.wl.length < 0.5 * full.wl.length && wc < 1e-15 && half.lines[0].nWl === Math.floor(cut.lines[0].nWl / 2) && rms < 6 && mx < 40 && x1.every((v, i) => i % t1.ng === 0 || v >= x1[i - 1]),
    `0.6 to 5.3 µm: ${rc.wl.length} of ${full.wl.length} bins, depths equal to ${ex(wc)}. Joined in pairs (R = 100, ${rh.wl.length} bins): ${rms.toFixed(1)} ppm rms and ${mx.toFixed(1)} ppm at most from the R = 200 tables, both binned to R = 100 (tolerance 6 and 40 ppm; a transit depth of ${(1e6 * b0.value[10]).toFixed(0)} ppm); each joined bin's k still rises with g`);
  const cache = {}, a1 = forwardModel(m, tables, { want, cache }), a2 = forwardModel({ ...m, haze: { factor: 50, slope: -4 } }, tables, { want, cache }), fresh = forwardModel({ ...m, haze: { factor: 50, slope: -4 } }, tables, { want });
  const iso = { ...m, tp: { kind: 'isothermal', t: 1200 } }, c2 = {}; forwardModel(iso, tables, { want, cache: c2 });
  const d1 = forwardModel({ ...iso, cloudTop: 3e-4 }, tables, { want, cache: c2 }), d0 = forwardModel({ ...iso, cloudTop: 3e-4 }, tables, { want }), d2 = forwardModel({ ...m, vmr: { ...m.vmr, H2O: 3e-3 } }, tables, { want, cache }), d3 = forwardModel({ ...m, vmr: { ...m.vmr, H2O: 3e-3 } }, tables, { want });
  const same = (x, y) => x.depth.every((v, i) => v === y.depth[i]); let threw = ''; try { O.crossSection(tables.lines[0], NaN, 1, new Float64Array(tables.lines[0].nWl * 12)); } catch (e) { threw = e.message; }
  check('kept results are never stale: a haze reuses the mixed gas, a moved level or a changed abundance does not', same(a2, fresh) && !same(a1, a2) && same(d1, d0) && same(d2, d3) && /no cross-section/.test(threw),
    `with a cache, adding a haze returns the fresh result exactly; so does a cloud deck that moves a level under an isothermal profile (the key holds every layer's pressure and temperature), and a tripled water abundance. A temperature that is not a number is refused ("${threw}")`);
}
{
  // line strength is conserved: integrated over frequency a line's cross-section is (pi e^2 / m_e c) f at every pressure.
  // ExoMolOP's Na and K tables break this below 10 bar (their D-line cores grow as 1 / P: 1.8e5 times too strong at 1e-5 bar);
  // tools/opacity/build_opacity.py recomputes those cores (repair_resonance). Here the shipped tables are held to the rule.
  const lines = { Na: [[16956.17, 0.32], [16973.366, 0.641]], K: [[12985.185, 0.333], [13042.896, 0.67]] }, rows = [];
  for (const [sp, pair] of Object.entries(lines)) {
    const t = shipped(sp), x = new Float64Array(t.nWl * t.ng), mid = 1e4 / (0.5 * (pair[0][0] + pair[1][0])), S = 8.8523e-13 * (pair[0][1] + pair[1][1]);   // cm^2 cm^-1
    let worst = 0, at = '', lowP = 0, highP = 0; const near = (a, v) => a.reduce((b, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(b / v)) ? x : b)), tRef = near(t.t, 1000), pRef = near(t.p, 10);
    for (const T of t.t) for (const P of t.p) {
      O.crossSection(t, T, P, x); let s = 0;
      for (let i = 0; i < t.nWl; i++) { if (Math.abs(t.wl[i] / mid - 1) > 0.02) continue; let m = 0; for (let q = 0; q < t.ng; q++) m += t.weights[q] * x[i * t.ng + q]; s += m * 1e4 * (1e4 / t.edges[i] - 1e4 / t.edges[i + 1]); }
      const r = s / S; if (r > worst) { worst = r; at = `${T} K, ${P} bar`; } if (T === tRef && P === t.p[0]) lowP = r; if (T === tRef && P === pRef) highP = r;
    }
    rows.push({ sp, worst, at, lowP, highP, src: t.source });
  }
  check('sodium and potassium: the D lines carry no more than their oscillator strength at any pressure and temperature', rows.every((r) => r.worst < 1.3 && r.highP > 0.5 && r.highP < 1.3 && r.lowP < 1.05 && /conserve line strength/.test(r.src)),
    rows.map((r) => `${r.sp}: the doublet's cross-section integrated over ±2% in wavelength, over (πe²/m_e c)·f, is at most ${r.worst.toFixed(2)} over the table's ${shipped(r.sp).t.length} × ${shipped(r.sp).p.length} nodes (at ${r.at}); ${r.highP.toFixed(2)} near 10 bar and 1000 K, ${r.lowP.toFixed(3)} at the lowest pressure (1e-5 bar)`).join('; ')
    + '. Tolerance: at most 1.3. Below 1 is expected at low pressure: a k-distribution on 12 points cannot hold a core that narrow, and its points are set by the mean of log k, which the comparison with the full-resolution table shows is what the transit depth needs (2 ppm rms; tools/opacity/README.md). As ExoMolOP ships these two tables the same number is 17 at 0.1 bar and 1.7e5 at 1e-5 bar');
}
process.exit(ok ? 0 : 1);
