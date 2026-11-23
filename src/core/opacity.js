// Opacity tables: the binary format the app ships (ESLO), interpolation to a layer's pressure and temperature,
// and the extinction of every layer of an atmosphere from a set of tables.
//
// Three kinds of table share one layout:
//   'xsec'    sampled cross-sections: one value per wavelength point (opacity sampling), cm^2 per molecule
//   'ktable'  k-coefficients: ng values per wavelength bin, sorted, with quadrature weights (correlated-k)
//   'cia'     collision-induced absorption: one value per wavelength, per temperature only, cm^5 per molecule pair
//
// File: 'ESLO', uint32 version, uint32 header length, the header as JSON padded with spaces to a multiple of 8
// bytes, then the values. All integers little-endian. The header holds
//   { kind, species, source, doi, licence, binned (a 'cia' table made for k-tables: values are bin means),
//     wl: { min, max, n } (n points or bins, uniform in ln lambda, micron;
//     points at min exp(i ln(max/min) / (n - 1)), bins between edges min (max/min)^(i/n)),
//     t: [K], p: [bar] (absent for 'cia'), ng, weights: [..], nodes: [..],
//     encoding: { type: 'u16' | 'u8' | 'f16', lo, hi }, order: 'p,t,wl,g' }.
// Values are log10 of the cross-section. 'u16' and 'u8' map [lo, hi] linearly onto 1..65535 (1..255); code 0 means
// no opacity (below the table's floor). 'f16' stores log10 sigma as IEEE half floats, with -inf for no opacity.
//
// Interpolation is bilinear in (log P, 1/T) on log sigma, clamped at the edges of the grid; a corner without opacity
// makes the result zero only if its weight is not zero. 1/T because a line's strength goes as exp(-E / kT). Predicting
// a temperature node of the ExoMolOP tables from its two neighbours (the spacing the shipped tables have), over the
// twelve species: log sigma in 1/T is unbiased (mean 0 to +1%), log sigma in T runs 1-5% low, and sigma itself in T
// (what petitRADTRANS's spectra correspond to) 2-17% high with two to three times the scatter
// (docs/guide/validation.md, "Atmosphere"; test/opacity.test.mjs). Collision-induced absorption, which varies
// slowly, stays log sigma linear in T.
//
// Mixing k-tables: random overlap with resorting and rebinning (Lacis & Oinas 1991; Amundsen et al. 2017, A&A 598,
// A97), species by species. In each bin and layer, a species whose mean opacity is below `greyBelow` (1e-2) times the
// largest window opacity (lowest g-point) of the others is added as a grey term instead of being resorted; the cost
// of that shortcut is measured in tools/opacity/study.mjs.

const MAGIC = 0x4f4c5345;   // 'ESLO' little-endian

/** Decode a half float (for engines without Float16Array). */
function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
}

/** Encode a number as a half float, rounding to nearest (Float16Array is not in every engine: absent in Node 22). */
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function toHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  F32[0] = v; const x = U32[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127, m = x & 0x7fffff;
  if (e > 15) return s | 0x7c00;                       // overflow and infinity
  if (e >= -14) { let h = s | ((e + 15) << 10) | (m >>> 13); const r = m & 0x1fff; if (r > 0x1000 || (r === 0x1000 && (h & 1))) h++; return h; }
  if (e >= -25) { const mm = (m | 0x800000) >>> (-e - 14 + 13), r = (m | 0x800000) & ((1 << (-e - 1)) - 1), halfway = 1 << (-e - 2); let h = s | mm; if (r > halfway || (r === halfway && (h & 1))) h++; return h; }
  return s;
}

/** Parse an ESLO file (ArrayBuffer) into a table: header fields plus `logs` (Float32Array of log10 sigma, -inf where empty). */
export function parseTable(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not an opacity table (ESLO)');
  const version = dv.getUint32(4, true), hlen = dv.getUint32(8, true);
  if (version !== 1) throw new Error('opacity table version ' + version + ' is not supported');
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, hlen))), off = 12 + hlen, enc = h.encoding;
  const nT = h.t.length, nP = h.p ? h.p.length : 1, ng = h.ng || 1, count = nP * nT * h.wl.n * ng;
  const logs = new Float32Array(count);
  if (enc.type === 'u16' || enc.type === 'u8') {
    const raw = enc.type === 'u16' ? new Uint16Array(buffer.slice(off, off + 2 * count)) : new Uint8Array(buffer, off, count);
    const top = enc.type === 'u16' ? 65535 : 255, step = (enc.hi - enc.lo) / (top - 1);
    for (let i = 0; i < count; i++) logs[i] = raw[i] === 0 ? -Infinity : enc.lo + (raw[i] - 1) * step;
  } else if (enc.type === 'f16') {
    const raw = new Uint16Array(buffer.slice(off, off + 2 * count));
    for (let i = 0; i < count; i++) logs[i] = half(raw[i]);
  } else if (enc.type === 'f32') {   // written by the build tool for reference tables only
    logs.set(new Float32Array(buffer.slice(off, off + 4 * count)));
  } else throw new Error('unknown encoding ' + enc.type);
  return makeTable(h, logs);
}

/** A table from a header and log10 values (see the file header for the fields). */
export function makeTable(h, logs) {
  const n = h.wl.n, ng = h.ng || 1, binned = h.kind === 'ktable' || !!h.binned, wl = new Float64Array(n), edges = binned ? new Float64Array(n + 1) : null;
  const L = Math.log(h.wl.max / h.wl.min);
  if (binned) { for (let i = 0; i <= n; i++) edges[i] = h.wl.min * Math.exp((L * i) / n); for (let i = 0; i < n; i++) wl[i] = Math.sqrt(edges[i] * edges[i + 1]); }
  else for (let i = 0; i < n; i++) wl[i] = h.wl.min * Math.exp((L * i) / Math.max(1, n - 1));
  return { ...h, ng, nWl: n, wl, edges, lnp: h.p ? h.p.map(Math.log) : null, logs, bytes: logs.length * ({ u8: 1, f32: 4 }[h.encoding?.type] || 2) };
}

/** Write a table as an ESLO file. logs: log10 sigma in the order p, t, wl, g (-inf for none). Returns an ArrayBuffer. */
export function writeTable(header, logs, encoding = { type: 'u16' }) {
  let lo = Infinity, hi = -Infinity;
  for (const v of logs) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const enc = { type: encoding.type, lo: encoding.lo ?? lo, hi: encoding.hi ?? hi }, h = { ...header, encoding: enc, order: 'p,t,wl,g' };
  let json = JSON.stringify(h); while ((12 + new TextEncoder().encode(json).length) % 8) json += ' ';
  if (!['u8', 'u16', 'f16'].includes(enc.type)) throw new Error('writeTable writes u8, u16 or f16, not ' + enc.type);
  const hb = new TextEncoder().encode(json), per = enc.type === 'u8' ? 1 : 2, buf = new ArrayBuffer(12 + hb.length + per * logs.length), dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 1, true); dv.setUint32(8, hb.length, true); new Uint8Array(buf, 12, hb.length).set(hb);
  const off = 12 + hb.length;
  if (enc.type === 'f16') { const f = new Uint16Array(buf, off, logs.length); for (let i = 0; i < logs.length; i++) f[i] = toHalf(logs[i]); }
  else {
    const top = enc.type === 'u16' ? 65535 : 255, out = enc.type === 'u16' ? new Uint16Array(buf, off, logs.length) : new Uint8Array(buf, off, logs.length);
    for (let i = 0; i < logs.length; i++) out[i] = Number.isFinite(logs[i]) ? 1 + Math.round(((Math.min(enc.hi, Math.max(enc.lo, logs[i])) - enc.lo) / (enc.hi - enc.lo || 1)) * (top - 1)) : 0;
  }
  return buf;
}

const LN10 = Math.LN10;
/** Bracket x in the ascending array a: index i and weight f of a[i + 1], clamped to the ends. */
function bracket(a, x) {
  const n = a.length; if (n === 1 || x <= a[0]) return [0, 0]; if (x >= a[n - 1]) return [n - 2, 1];
  let i = 0; while (a[i + 1] < x) i++;
  return [i, (x - a[i]) / (a[i + 1] - a[i])];
}

/**
 * Cross-section of a table at temperature T [K] and pressure [bar], into out[o ...] (nWl * ng values, m^2 per
 * molecule; m^5 per pair for 'cia'). Bilinear in (ln P, 1/T) on log sigma (CIA: in T).
 * rule: 'invT' (default); 'T', log sigma linear in T; 'sigmaT', sigma itself linear in T, which reproduces
 * petitRADTRANS's spectra (test/rt_reference.test.mjs). The last two are for comparisons only: against the tables'
 * own nodes they run 1-5% low and 2-17% high (header).
 */
export function crossSection(table, T, pBar, out, o = 0, rule = 'invT') {
  if (!(T > 0) || !(pBar > 0)) throw new Error(`no cross-section at T = ${T} K, P = ${pBar} bar`);
  const { logs, nWl, ng } = table, m = nWl * ng, nT = table.t.length, tt = table.t, [it, f0] = bracket(tt, T), linear = rule === 'sigmaT';
  const ft = rule !== 'invT' || table.kind === 'cia' || f0 === 0 || f0 === 1 ? f0 : (1 / tt[it] - 1 / T) / (1 / tt[it] - 1 / tt[it + 1]);
  const [ip, fp] = table.lnp ? bracket(table.lnp, Math.log(pBar)) : [0, 0];
  const c = [[ip, it, (1 - fp) * (1 - ft)], [ip, it + 1, (1 - fp) * ft], [ip + 1, it, fp * (1 - ft)], [ip + 1, it + 1, fp * ft]].filter((x) => x[2] > 0);
  const unit = table.kind === 'cia' ? 1e-10 : 1e-4;   // cm^5 to m^5, cm^2 to m^2
  for (let k = 0; k < m; k++) {
    let s = 0;
    if (linear) { for (let q = 0; q < c.length; q++) s += c[q][2] * Math.exp(LN10 * logs[(c[q][0] * nT + c[q][1]) * m + k]); out[o + k] = unit * s; continue; }
    for (let q = 0; q < c.length; q++) s += c[q][2] * logs[(c[q][0] * nT + c[q][1]) * m + k];
    out[o + k] = s === -Infinity ? 0 : unit * Math.exp(LN10 * s);
  }
  return out;
}

/** Do the tables share a wavelength grid (and g-points)? Returns the grid or throws. */
export function commonGrid(tables) {
  const a = tables && tables[0]; if (!a) throw new Error('no opacity table to take the wavelength grid from: load a line table or the collision-induced absorption');
  for (const t of tables) {
    if (t.kind === 'cia') { if (t.nWl !== a.nWl || Math.abs(t.wl[0] / a.wl[0] - 1) > 1e-9) throw new Error(`the ${t.species} table is on another wavelength grid`); continue; }
    if (t.kind !== a.kind || t.nWl !== a.nWl || t.ng !== a.ng || Math.abs(t.wl[0] / a.wl[0] - 1) > 1e-9 || Math.abs(t.wl[t.nWl - 1] / a.wl[a.nWl - 1] - 1) > 1e-9) throw new Error(`the ${t.species} table is on another grid than ${a.species}`);
  }
  return { kind: a.kind, wl: a.wl, edges: a.edges, nWl: a.nWl, ng: a.ng, weights: a.weights ? Float64Array.from(a.weights) : null, nodes: a.nodes ? Float64Array.from(a.nodes) : null };
}

// Sorting ng^2 sums together with their weights, natively: the pair's index is written into the lowest 8 bits of
// each (positive) double, which changes it by less than 1e-13 and leaves the order of distinct values intact; the
// typed array's own numeric sort then carries the index along. ng <= 16.
const SORT = { f: new Float64Array(256), u: null }; SORT.u = new Uint32Array(SORT.f.buffer);
// ln x of a positive, normal double: its exponent, then the atanh series on the mantissa in [1/sqrt2, sqrt2).
// Error below 3e-8 of |ln mantissa|: far inside what a 12-point k-distribution carries, and about three times
// faster than Math.log where it is called 144 times per pair of gases, bin and layer (tools/wasm/mix.rs has the same).
const LNF = new Float64Array(1), LNU = new Uint32Array(LNF.buffer);
function fastLn(x) {
  LNF[0] = x; let e = ((LNU[1] >>> 20) & 0x7ff) - 1023; LNU[1] = (LNU[1] & 0xfffff) | 0x3ff00000;
  let m = LNF[0]; if (m > Math.SQRT2) { m *= 0.5; e++; }
  const s = (m - 1) / (m + 1), s2 = s * s;
  return e * Math.LN2 + 2 * s * (1 + s2 * (1 / 3 + s2 * (0.2 + s2 * (1 / 7 + s2 * (1 / 9)))));
}
export const _fastLn = fastLn;

/**
 * Random overlap of two k-distributions on the same g-points: a becomes the distribution of a + b.
 * w: weights, gn: g at the nodes; wt: scratch for the ng * ng pair weights.
 * The ng^2 sums, sorted, are a step function of g, and each node stands for its own interval of g (the cumulated
 * weights). What the node gets, `mode`:
 *   'log'   exp of the mean of ln k over the interval (the default). k spans decades inside an interval, and the
 *           transmittance of the interval follows its typical k, not its largest
 *   'mean'  the mean of k: keeps the bin's mean opacity exactly, but the top of each interval then counts for too much
 *   'node'  the value interpolated at the node's g: loses a little opacity at every combination
 * Measured against random overlap carried out without intermediate steps (tools/opacity/mixing_study.mjs; eight
 * molecules, R = 1000): 5 ppm rms of transit depth for 'log', 13 for 'mean', 37 for 'node'.
 * An interval that holds a zero (no opacity in the table) falls back to the mean.
 */
function overlap(a, b, ng, w, gn, wt, mode) {
  const f = SORT.f, u = SORT.u, m = ng * ng;
  let q0 = 0;
  for (let i = 0; i < ng; i++) for (let j = 0; j < ng; j++) { f[q0] = a[i] + b[j]; u[2 * q0] = (u[2 * q0] & 0xffffff00) | q0; wt[q0] = w[i] * w[j]; q0++; }
  const sorted = f.subarray(0, m).sort();
  if (mode !== 'node') {
    const log = mode !== 'mean' && sorted[0] >= 2.2250738585072014e-308;
    let k = 0, cum = 0, lo = 0, wk = wt[u[0] & 255], v = log ? fastLn(sorted[0]) : sorted[0];   // cum: g where sample k starts
    for (let q = 0; q < ng; q++) {
      const hi = q === ng - 1 ? 2 : lo + w[q]; let s = 0, got = 0;   // the last interval takes whatever round-off left
      while (k < m) {
        const end = cum + wk, from = cum > lo ? cum : lo;
        if (end <= hi) { s += (end - from) * v; got += end - from; cum = end; k++; if (k < m) { wk = wt[u[2 * k] & 255]; v = log ? fastLn(sorted[k]) : sorted[k]; } }
        else { s += (hi - from) * v; got += hi - from; break; }
      }
      a[q] = log ? Math.exp(s / got) : s / got; lo = hi;
    }
    return;
  }
  // cumulative g at the midpoint of each sorted sample, then linear interpolation of k onto the nodes
  let cum = 0, k = 0, gPrev = 0, sPrev = sorted[0], wk = wt[u[0] & 255];
  for (let q = 0; q < ng; q++) {
    const target = gn[q]; let gk = cum + 0.5 * wk;
    while (k < m - 1 && gk < target) { gPrev = gk; sPrev = sorted[k]; cum += wk; k++; wk = wt[u[2 * k] & 255]; gk = cum + 0.5 * wk; }
    const sk = sorted[k];
    if (gk <= target || gk === gPrev) a[q] = sk;
    else { const t = (target - gPrev) / (gk - gPrev); a[q] = sPrev + t * (sk - sPrev); }
  }
}

/**
 * A table cut to the bins between two wavelengths [micron] (whole bins: the window grows to the bins' edges).
 * A spectrum over 0.6-5.3 micron needs 436 of the 1023 bins of the shipped tables; the cost of a model falls with them.
 */
export function sliceTable(t, wlMin, wlMax) {
  const lo = t.edges || t.wl, nE = t.edges ? t.nWl : t.nWl - 1; let i0 = 0, i1 = t.nWl;
  while (i0 < t.nWl - 1 && (t.edges ? t.edges[i0 + 1] : t.wl[i0]) < wlMin * (1 + 1e-12) && (t.edges ? true : t.wl[i0] < wlMin)) i0++;
  while (i1 > i0 + 1 && (t.edges ? t.edges[i1 - 1] : t.wl[i1 - 1]) > wlMax * (1 - 1e-12) && (t.edges ? true : t.wl[i1 - 1] > wlMax)) i1--;
  if (i0 === 0 && i1 === t.nWl) return t;
  const ng = t.ng, m = t.nWl * ng, blocks = t.logs.length / m, n = i1 - i0, logs = new Float32Array(blocks * n * ng);
  for (let b = 0; b < blocks; b++) logs.set(t.logs.subarray(b * m + i0 * ng, b * m + i1 * ng), b * n * ng);
  const { wl, edges, lnp, nWl, bytes, logs: _l, ...h } = t;
  return makeTable({ ...h, wl: { min: t.edges ? t.edges[i0] : t.wl[i0], max: t.edges ? t.edges[i1] : t.wl[Math.min(i1 - 1, nE)], n } }, logs);
}

/**
 * A binned table ('ktable', or 'cia' with bin means) with every `f` neighbouring bins joined into one: resolving power
 * divided by f, and the cost of a model with it. The k-distribution of a joined bin is that of its parts taken together,
 * each part counting by its width in wavenumber: the f * ng samples are sorted and put back on the g-points by the mean
 * of log k over each node's interval (as `overlap` does; an interval holding a zero takes the mean of k). Leftover bins
 * at the long-wavelength end are dropped. test/opacity.test.mjs compares spectra from joined tables with the originals.
 */
export function coarsenTable(t, f) {
  if (!(f > 1)) return t;
  if (!t.edges) throw new Error('only binned tables can be coarsened');
  const ng = t.ng, m = t.nWl * ng, blocks = t.logs.length / m, n = Math.floor(t.nWl / f), logs = new Float32Array(blocks * n * ng), w = t.weights || [1];
  const ns = f * ng, val = new Float64Array(ns), wt = new Float64Array(ns), order = new Uint16Array(ns);
  for (let i = 0; i < n; i++) {
    let tot = 0; for (let a = 0; a < f; a++) tot += 1 / t.edges[i * f + a] - 1 / t.edges[i * f + a + 1];
    for (let a = 0; a < f; a++) { const share = (1 / t.edges[i * f + a] - 1 / t.edges[i * f + a + 1]) / tot; for (let q = 0; q < ng; q++) wt[a * ng + q] = share * w[q]; }
    for (let b = 0; b < blocks; b++) {
      const src = b * m + i * f * ng, dst = b * n * ng + i * ng;
      for (let k = 0; k < ns; k++) { val[k] = t.logs[src + k]; order[k] = k; }
      order.sort((x, y) => val[x] - val[y] || x - y);
      let k = 0, cum = 0, lo = 0;
      for (let q = 0; q < ng; q++) {
        const hi = q === ng - 1 ? 2 : lo + w[q]; let s = 0, lin = 0, got = 0, zero = false;
        while (k < ns) {
          const o = order[k], end = cum + wt[o], from = cum > lo ? cum : lo, part = (end <= hi ? end : hi) - from, v = val[o];
          if (part > 0) { if (v === -Infinity) zero = true; else { s += part * v; lin += part * Math.pow(10, v); } got += part; }
          if (end <= hi) { cum = end; k++; } else break;
        }
        logs[dst + q] = zero ? (lin > 0 ? Math.log10(lin / got) : -Infinity) : s / got; lo = hi;
      }
    }
  }
  const { wl, edges, lnp, nWl, bytes, logs: _l, ...h } = t;
  return makeTable({ ...h, wl: { min: t.edges[0], max: t.edges[n * f], n } }, logs);
}

/**
 * Tables made ready for many runs over one data set: { lines, cia, ... } cut to [wlMin, wlMax] and coarsened by `merge`.
 * Other entries (chem, tholin, ...) are passed through.
 */
export function prepareTables(tables, { wlMin = 0, wlMax = Infinity, merge = 1 } = {}) {
  const prep = (t) => coarsenTable(sliceTable(t, wlMin, wlMax), merge);
  return { ...tables, lines: (tables.lines || []).map(prep), cia: (tables.cia || []).map(prep) };
}

/**
 * The mixing loop of gasExtinction compiled to WebAssembly (tools/wasm/mix.rs, built to public/wasm/mix.wasm).
 * bytes: the file's contents (the page fetches it, a test reads it); this module touches no file or network itself.
 * Returns { mix(sig, vmr, nd, w, ext, n, nWl, ng, greyBelow) } for gasExtinction's `kernel` option. The JavaScript
 * loop stays the reference: test/opacity.test.mjs holds the two to the same extinction.
 */
export async function loadMixKernel(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes), X = instance.exports; let cap = 0, ptr = 0;
  return {
    mix(sig, vmr, nd, w, ext, n, nWl, ng, greyBelow) {
      const ns = sig.length, m = nWl * ng, need = 8 * (ns * n * m + ns * n + ng + m * n);
      if (need > cap) { if (ptr) X.esl_free(ptr, cap); ptr = X.esl_alloc(need); cap = need; if (!ptr) throw new Error('the mixing kernel is out of memory'); }
      const mem = new Float64Array(X.memory.buffer, ptr, need / 8), oF = ns * n * m, oW = oF + ns * n, oE = oW + ng;   // (a view is taken after any growth)
      for (let s = 0; s < ns; s++) { mem.set(sig[s], s * n * m); for (let j = 0; j < n; j++) mem[oF + s * n + j] = nd[j] * vmr[s][j]; }
      mem.set(w, oW);
      X.esl_mix(ptr, ptr + 8 * oF, ptr + 8 * oW, ptr + 8 * oE, ns, n, nWl, ng, greyBelow);
      ext.set(mem.subarray(oE, oE + m * n));
    },
  };
}

/**
 * Extinction of every layer [m^-1] from line tables and collision-induced absorption.
 *   tables: parsed tables of kind 'xsec' or 'ktable' on a common grid; species missing from the atmosphere are skipped
 *   cia: tables of kind 'cia' with species 'H2-H2', 'H2-He' (on the same wavelength grid)
 *   greyBelow: see the header (k-tables only); 0 resorts every species
 *   mixing: how a combined distribution is put back on the g-points, 'log' (default), 'mean' or 'node' (see `overlap`)
 *   interpolation: 'invT' (default), 'T' or 'sigmaT' (as petitRADTRANS; see `crossSection`); the others for comparisons only
 *   kernel: the WebAssembly mixing kernel (loadMixKernel): the same arithmetic, about 2.6 times faster; 'log' mixing only
 *   cache: an object kept between calls: per-species cross-sections are reused while the layers' P and T are unchanged
 * Returns { grid, extinction: Float64Array(nWl * ng * n) (row per wavelength and g, layers within), weights: { ng, w } | null }.
 */
export function gasExtinction(atm, tables, { cia = [], greyBelow = 1e-2, cache = null, only = null, mixing = 'log', interpolation = 'invT', kernel = null } = {}) {
  const lines = tables.filter((t) => t.kind !== 'cia' && atm.species[t.species] && (!only || only.includes(t.species)));
  const grid = commonGrid(lines.length ? [...lines, ...cia] : cia), n = atm.n, { nWl, ng } = grid, m = nWl * ng;
  const ext = new Float64Array(m * n), key = cache ? `${interpolation}|${n}|${Array.from(atm.pLay).join(',')}|${Array.from(atm.tLay).join(',')}` : '';
  const store = cache && cache.key === key ? cache.sig : {};
  if (cache && cache.key !== key) { cache.key = key; cache.sig = store; cache.mixed = null; }
  // the mixed result is kept too: while pressures, temperatures and every gas's amount stay the same (a cloud, the
  // star or the radius was changed) the mixing, three quarters of a run, is not repeated
  const amounts = new Float64Array((lines.length + 2 * cia.length) * n); lines.forEach((t, s) => { const x = atm.species[t.species]; for (let j = 0; j < n; j++) amounts[s * n + j] = atm.nd[j] * x[j]; });
  cia.forEach((t, s) => { const [a, b] = t.species.split('-'), o = (lines.length + s) * n; if (atm.species[a] && atm.species[b]) for (let j = 0; j < n; j++) amounts[o + j] = atm.nd[j] * atm.nd[j] * atm.species[a][j] * atm.species[b][j]; });
  const tag = `${lines.map((t) => t.species + t.nWl + ':' + t.ng).join(',')}|${cia.map((t) => t.species).join(',')}|${greyBelow}|${mixing}`, weightsOut = grid.kind === 'ktable' ? { ng, w: grid.weights } : null;
  if (cache && cache.mixed && cache.mixed.tag === tag && cache.mixed.amounts.length === amounts.length && cache.mixed.amounts.every((v, i) => v === amounts[i])) return { grid, extinction: cache.mixed.ext.slice(), weights: weightsOut };
  const sigOf = (t) => (store[`${t.species}:${t.kind}:${t.nWl}:${t.ng}`] ??= (() => { const s = new Float64Array(m * n), per = t.nWl * t.ng; for (let j = 0; j < n; j++) crossSection(t, atm.tLay[j], atm.pLay[j] / 1e5, s, j * per, interpolation); return s; })());
  const sig = lines.map(sigOf);

  if (grid.kind === 'xsec' || lines.length <= 1) {
    for (let s = 0; s < lines.length; s++) {
      const x = atm.species[lines[s].species], sg = sig[s];
      for (let j = 0; j < n; j++) { const f = atm.nd[j] * x[j]; if (f > 0) for (let k = 0; k < m; k++) ext[k * n + j] += f * sg[j * m + k]; }
    }
  } else if (kernel && mixing === 'log' && ng <= 16 && lines.length <= 64) {
    kernel.mix(sig, lines.map((t) => atm.species[t.species]), atm.nd, grid.weights, ext, n, nWl, ng, greyBelow);
  } else {
    if (ng > 16) throw new Error('k-tables with more than 16 g-points are not supported');
    const w = grid.weights, gn = grid.nodes, wt = new Float64Array(ng * ng), ns = lines.length;
    const mean = new Float64Array(ns), low = new Float64Array(ns), fac = new Float64Array(ns), acc = new Float64Array(ng), part = new Float64Array(ng);
    for (let j = 0; j < n; j++) {
      for (let s = 0; s < ns; s++) fac[s] = atm.nd[j] * atm.species[lines[s].species][j];
      for (let i = 0; i < nWl; i++) {
        const base = j * m + i * ng; let floor = 0;
        for (let s = 0; s < ns; s++) {
          let a = 0; const sg = sig[s];
          for (let q = 0; q < ng; q++) a += w[q] * sg[base + q];
          mean[s] = fac[s] * a; low[s] = fac[s] * sg[base]; if (low[s] > floor) floor = low[s];
        }
        // a species is grey here when even its mean lies below greyBelow x the largest "window" opacity (the
        // lowest g-point) of another species: then it matters nowhere in the bin
        acc.fill(0); let first = true, grey = 0;
        for (let s = 0; s < ns; s++) {
          if (!(mean[s] > 0)) continue;
          if (mean[s] < greyBelow * floor && low[s] < floor) { grey += mean[s]; continue; }
          const sg = sig[s], f = fac[s];
          if (first) { for (let q = 0; q < ng; q++) acc[q] = f * sg[base + q]; first = false; }
          else { for (let q = 0; q < ng; q++) part[q] = f * sg[base + q]; overlap(acc, part, ng, w, gn, wt, mixing); }
        }
        for (let q = 0; q < ng; q++) ext[(i * ng + q) * n + j] = acc[q] + grey;
      }
    }
  }
  // collision-induced absorption: sigma [m^5] x n_a x n_b, the same for every g-point
  for (const t of cia) {
    const [a, b] = t.species.split('-'); if (!atm.species[a] || !atm.species[b]) continue;
    const s = new Float64Array(nWl);
    for (let j = 0; j < n; j++) {
      crossSection(t, atm.tLay[j], 1, s);
      const f = atm.nd[j] * atm.nd[j] * atm.species[a][j] * atm.species[b][j];
      for (let i = 0; i < nWl; i++) { const v = f * s[i]; if (v > 0) for (let q = 0; q < ng; q++) ext[(i * ng + q) * n + j] += v; }
    }
  }
  if (cache) cache.mixed = { tag, amounts, ext: ext.slice() };
  return { grid, extinction: ext, weights: weightsOut };
}

/** Add a continuum computed per wavelength (nWl * n) to an extinction array with g-points (nWl * ng * n). */
export function addPerWavelength(ext, cont, nWl, ng, n) {
  for (let i = 0; i < nWl; i++) for (let q = 0; q < ng; q++) { const o = (i * ng + q) * n, c = i * n; for (let j = 0; j < n; j++) ext[o + j] += cont[c + j]; }
  return ext;
}

/**
 * Average a spectrum from the table's grid into bins of resolving power R (or onto given edges [micron]).
 * For 'xsec' tables this is the mean of the sampled points in each bin, which is what opacity sampling relies on.
 * Returns { wl, lo, hi, value, count }.
 */
export function binSpectrum(wl, value, { R = 100, edges = null, wlMin = wl[0], wlMax = wl[wl.length - 1] } = {}) {
  if (!edges) { edges = [wlMin]; while (edges[edges.length - 1] < wlMax) edges.push(edges[edges.length - 1] * Math.exp(1 / R)); }
  const nb = edges.length - 1, out = new Float64Array(nb), cnt = new Float64Array(nb);
  let b = 0;
  for (let i = 0; i < wl.length; i++) { if (wl[i] < edges[0]) continue; while (b < nb && wl[i] >= edges[b + 1]) b++; if (b >= nb) break; out[b] += value[i]; cnt[b]++; }
  const mid = new Float64Array(nb);
  for (let k = 0; k < nb; k++) { mid[k] = Math.sqrt(edges[k] * edges[k + 1]); out[k] = cnt[k] ? out[k] / cnt[k] : NaN; }
  return { wl: mid, lo: edges.slice(0, nb), hi: edges.slice(1), value: out, count: cnt };
}
