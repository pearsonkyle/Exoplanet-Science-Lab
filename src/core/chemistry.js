// Equilibrium chemistry from a table: volume mixing ratios of the gases the atmosphere model uses, as a function of
// temperature, pressure, metallicity and C/O. The table (public/chem/equilibrium.eslc) is computed with FastChem
// (Stock et al. 2018, MNRAS 479, 865; Stock et al. 2022; Kitzmann et al. 2024) by tools/chem/build_chem.py; this
// file reads and interpolates it, and holds no chemistry of its own.
//
// What the table assumes (its header repeats it):
//   - gas phase only: nothing condenses or rains out, so TiO, VO, Na and K stay in the gas where they would have
//     condensed (below about 1500-2000 K for TiO and VO, about 1000 K for Na and K), and water makes no cloud
//   - metallicity [M/H]: every element heavier than helium scaled by 10^[M/H] from Asplund et al. (2021); C/O is then
//     set by changing oxygen at fixed carbon
//   - mixing ratios are fractions of the whole gas, so the species kept here sum to less than 1; the mean molecular
//     weight of the whole gas is tabulated with them
//
// Interpolation, on log10 of the mixing ratio, clamped at the grid's edges: linear in ln T and log P; in [M/H] and
// C/O a monotone cubic through four nodes (Fritsch & Butland 1984, SIAM J. Sci. Stat. Comput. 5, 300: Hermite
// cubics whose node slopes are the weighted harmonic mean of the two secants, zero where they change sign), so that
// a spectrum's derivative with respect to [M/H] and C/O has no step at the table's nodes and nothing overshoots
// where a gas falls by orders of magnitude (C/O near 1). `linear: true` gives the straight lines between nodes that
// the first version used; a fit's posterior then has a likelihood whose curvature jumps from cell to cell.
//
// Quenching: with `quench` [bar], the carbon, oxygen and nitrogen carriers keep, at lower pressures, the mixing
// ratios they have at that pressure: vertical mixing faster than the reactions (Prinn & Barshay 1977; the usual
// one-parameter stand-in for disequilibrium, e.g. Zahnle & Marley 2014).

const MAGIC = 0x434c5345;   // 'ESLC'
export const QUENCHED = ['CH4', 'CO', 'CO2', 'H2O', 'NH3', 'HCN', 'N2'];

/** Parse an ESLC file. Returns { species, t, p, mh, co, lnT, logP, codes: Uint16Array, lo, step, coSolar, source, ... }. */
export function parseChem(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a chemistry table (ESLC)');
  const len = dv.getUint32(8, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, len)));
  const n = h.species.length * h.mh.length * h.co.length * h.p.length * h.t.length;
  const codes = new Uint16Array(buffer.slice(12 + len, 12 + len + 2 * n));
  return { ...h, lnT: h.t.map(Math.log), logP: h.p.map(Math.log10), codes, lo: h.encoding.lo, step: (h.encoding.hi - h.encoding.lo) / 65534, coSolar: h.co_solar };
}

function bracket(a, x) {
  const n = a.length; if (x <= a[0]) return [0, 0]; if (x >= a[n - 1]) return [n - 2, 1];
  let i = 0; while (a[i + 1] < x) i++;
  return [i, (x - a[i]) / (a[i + 1] - a[i])];
}

/**
 * Mixing ratios at one temperature [K] and pressure [bar].
 *   { mh = 0 ([M/H], dex relative to the Sun), co = the Sun's C/O (0.59) }
 *   linear: true for straight lines between the [M/H] and C/O nodes instead of the monotone cubic
 * Returns { name: vmr, ..., mu: mean molecular weight of the whole gas [amu] }.
 */
// Slope at node 1 of three (x0 < x1 < x2) for the monotone cubic: 0 where the secants disagree in sign
function slope3(x0, x1, x2, y0, y1, y2) {
  const h0 = x1 - x0, h1 = x2 - x1, d0 = (y1 - y0) / h0, d1 = (y2 - y1) / h1;
  if (d0 * d1 <= 0) return 0;
  const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / d0 + w1 / d1);
}
// The four nodes around x (clamped to the grid) and where x lies between the middle two
function stencil(a, x) {
  const n = a.length, [i, f] = bracket(a, x);
  return { i, f, lo: i > 0, hi: i < n - 2 };
}
// Monotone cubic on the interval between nodes i and i+1 of grid a, from the values y[0..3] at nodes i-1 .. i+2
// (y[0] unused when st.lo is false, y[3] when st.hi is false: the end slope is then the secant, limited)
function cubic(a, st, y) {
  const { i, f } = st, h = a[i + 1] - a[i], d = (y[2] - y[1]) / h;
  if (f === 0) return y[1]; if (f === 1) return y[2];
  let m1 = st.lo ? slope3(a[i - 1], a[i], a[i + 1], y[0], y[1], y[2]) : d, m2 = st.hi ? slope3(a[i], a[i + 1], a[i + 2], y[1], y[2], y[3]) : d;
  if (d === 0) return y[1];
  // keep the cubic monotone on the interval (Fritsch & Carlson 1980: slopes at most three times the secant)
  if (m1 / d > 3) m1 = 3 * d; if (m2 / d > 3) m2 = 3 * d;
  const f2 = f * f, f3 = f2 * f;
  return (2 * f3 - 3 * f2 + 1) * y[1] + (f3 - 2 * f2 + f) * h * m1 + (-2 * f3 + 3 * f2) * y[2] + (f3 - f2) * h * m2;
}
const _row = new Float64Array(4), _col = new Float64Array(4);

export function equilibrium(table, T, pBar, { mh = 0, co = table.coSolar, linear = false } = {}) {
  const { species, codes, lo, step } = table, nT = table.t.length, nP = table.p.length, nC = table.co.length, nM = table.mh.length;
  const [it, ft] = bracket(table.lnT, Math.log(T)), [ip, fp] = bracket(table.logP, Math.log10(pBar)), sm = stencil(table.mh, mh), sc = stencil(table.co, co), im = sm.i, ic = sc.i, fm = sm.f, fc = sc.f;
  // log10 of the mixing ratio of species s at table node (m, c), interpolated in pressure and temperature
  const at = (s, m, c) => { let v = 0; for (let k = 0; k < 2; k++) for (let d = 0; d < 2; d++) { const w = (k ? fp : 1 - fp) * (d ? ft : 1 - ft); if (w === 0) continue; const code = codes[(((s * nM + m) * nC + c) * nP + ip + k) * nT + it + d]; v += w * (code ? lo + (code - 1) * step : lo); } return v; };
  const out = {};
  for (let s = 0; s < species.length; s++) {
    let v;
    if (linear) { v = 0; for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) { const w = (a ? fm : 1 - fm) * (b ? fc : 1 - fc); if (w !== 0) v += w * at(s, im + a, ic + b); } }
    else {
      for (let a = -1; a <= 2; a++) {
        if ((a === -1 && !sm.lo) || (a === 2 && !sm.hi)) continue;
        for (let b = -1; b <= 2; b++) if (!((b === -1 && !sc.lo) || (b === 2 && !sc.hi))) _row[b + 1] = at(s, im + a, ic + b);
        _col[a + 1] = cubic(table.co, sc, _row);
      }
      v = cubic(table.mh, sm, _col);
    }
    out[species[s]] = species[s] === 'mu' ? 100 * 10 ** v : v <= lo + 1e-9 ? 0 : 10 ** v;
  }
  return out;
}

/**
 * Mixing ratios of every layer of an atmosphere.
 *   tLay [K], pLayBar [bar] (top first), { mh, co, quench [bar] | null, exclude: [names] (set to zero: a gas switched off),
 *   scale: { name: factor } (applied after chemistry: escape, ionization) }
 * Returns { species: { name: Float64Array(n) }, mu: Float64Array(n) }.
 */
export function equilibriumProfile(table, tLay, pLayBar, { mh = 0, co = table.coSolar, quench = null, exclude = [], scale = null } = {}) {
  const n = tLay.length, species = {}, mu = new Float64Array(n);
  for (const s of table.species) if (s !== 'mu') species[s] = new Float64Array(n);
  let q = null;
  if (quench != null) { let j = 0; while (j < n - 1 && pLayBar[j] < quench) j++; q = equilibrium(table, tLay[j], pLayBar[j], { mh, co }); }
  for (let j = 0; j < n; j++) {
    const x = equilibrium(table, tLay[j], pLayBar[j], { mh, co }), frozen = q && pLayBar[j] < quench;
    for (const s of Object.keys(species)) species[s][j] = frozen && QUENCHED.includes(s) ? q[s] : x[s];
    mu[j] = x.mu;
  }
  for (const s of exclude) if (species[s]) species[s].fill(0);
  if (scale) for (const [s, f] of Object.entries(scale)) if (species[s]) for (let j = 0; j < n; j++) species[s][j] *= typeof f === 'number' ? f : f[j];
  return { species, mu };
}

/** Metallicity [M/H] and C/O after elements have been enriched by the factors { C, O, He, ... } relative to hydrogen. */
export function enriched({ mh = 0, co }, factors) {
  const c = factors.C ?? 1, o = factors.O ?? 1;
  return { mh: mh + Math.log10(Math.sqrt(c * o)), co: (co * c) / o };
}
