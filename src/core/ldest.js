// Limb darkening coefficients from stellar parameters.
//
// EXOTIC gets these from PHOENIX model atmospheres through LDTK, which needs
// a download of several GB that a web page cannot make. Two routes are offered:
//
// 1. LD grids: a table of coefficients on (Teff, logg, [Fe/H]), interpolated
//    trilinearly. The app bundles one (src/data/ld_table.js, built from PHOENIX
//    specific intensities by tools/build_ld_table.py and checked against
//    ExoTETHyS in test/limbdark.test.mjs); a user can load another (Claret's
//    tables, LDTK or ExoTETHyS exports). Outside the table the nearest edge is
//    used and the result is flagged `clamped`.
// 2. greyProfile(): the emergent intensity of a grey atmosphere in radiative
//    equilibrium, I_lambda(mu) = int B_lambda(T(tau)) exp(-tau/mu) dtau/mu, with
//    T^4 = 3/4 Teff^4 (tau + q(tau)), averaged over the bandpass. It captures the
//    two dominant trends (stronger darkening for cooler stars and bluer bands)
//    from Teff and wavelength alone. It has no line blanketing and no opacity
//    physics, so it cannot respond to log g or [Fe/H]. With the table bundled it
//    is only needed for a band the table does not hold (a custom wavelength
//    range) or when no table is loaded.
//
// fitLaw() is the port of the coefficient fit in EXOTIC's gael_ld.py: a
// least-squares fit of the chosen law to I(mu), without the constraint that
// forces the limb intensity to zero.

import { quadraticToKipping } from './limbdark.js';

// Band edges in nm. The first block is EXOTIC's filter table (api/filters.py).
// The keys are also the filter names of the bundled table (tools/build_ld_table.py
// uses the same list), so a band picked here selects its table column by name.
// For the grey fallback only the edges matter; the table uses a measured response
// curve where one was available (see `bands[name].passband` on the expanded table).
export const FILTERS = {
  'Johnson U': [333.8, 398.8], 'Johnson B': [391.6, 480.6], 'Johnson V': [502.8, 586.8], 'Johnson R': [590, 810], 'Johnson I': [780, 1020],
  'Cousins R': [561.7, 719.7], 'Cousins I': [721, 875],
  'Sloan u': [321.8, 386.8], 'Sloan g': [402.5, 551.5], 'Sloan r': [553.1, 693.1], 'Sloan i': [697.5, 827.5], 'Sloan z': [841.2, 978.2],
  'Near-Infrared J': [1040, 1360], 'Near-Infrared H': [1420, 1780], 'Near-Infrared K': [2015, 2385],
  'PanSTARRS z-short': [826, 920], 'PanSTARRS Y': [946.4, 1054.4], 'PanSTARRS w': [404.2, 845.8],
  'MObs CV (clear)': [350, 850], 'Astrodon ExoPlanet-BB': [500, 1000],
  'Stromgren u': [336.3, 367.7], 'Stromgren v': [401.5, 418.5], 'Stromgren b': [459.55, 478.05], 'Stromgren y': [536.7, 559.3],
  'Stromgren Hbw': [481.5, 496.5], 'Stromgren Hbn': [484.5, 487.5],   // EXOTIC lists Hbn as (487.5, 484.5); ordered here
  'Optec Wing A': [706.5, 717.5], 'Optec Wing B': [748.5, 759.5], 'Optec Wing C': [1003, 1045],
  // approximate half-power ranges for space missions
  'TESS (approx.)': [600, 1000], 'Kepler (approx.)': [430, 890], 'CHEOPS (approx.)': [400, 1000],
  // JWST white-light ranges of each mode (boxcars; MIRI LRS is beyond the model spectra used for the table)
  'JWST NIRISS SOSS': [850, 2800], 'JWST NIRSpec PRISM': [600, 5300], 'JWST NIRSpec G395H': [2870, 5140],
  'JWST NIRCam F322W2': [2430, 4010], 'JWST NIRCam F444W': [3880, 4990],
};

const HC_K = 1.438776877e7; // h c / k in nm K

/** Band-averaged I(mu)/I(1) for a grey atmosphere. Returns { mu, I }. */
export function greyProfile(teff, wlMin, wlMax, { nmu = 60, eddington = false } = {}) {
  const NL = wlMax > wlMin ? 9 : 1, NT = 600, XMAX = 30;
  const mu = new Float64Array(nmu), I = new Float64Array(nmu);
  // Hopf function: 2/3 in the Eddington approximation, else the standard fit to the exact solution
  const q = (tau) => (eddington ? 2 / 3 : 0.7104 - 0.1331 * Math.exp(-3.4488 * tau));
  const intens = (m, wl) => {
    // int_0^inf B(T(mu x)) e^-x dx, Simpson's rule
    let s = 0;
    for (let i = 0; i <= NT; i++) {
      const x = (XMAX * i) / NT, tau = m * x;
      const T = teff * Math.pow(0.75 * (tau + q(tau)), 0.25);
      const B = wl > 0 ? 1 / Math.expm1(HC_K / (wl * T)) : Math.pow(T, 4);
      s += (i === 0 || i === NT ? 1 : i % 2 ? 4 : 2) * B * Math.exp(-x);
    }
    return s;
  };
  const wls = []; for (let j = 0; j < NL; j++) wls.push(NL === 1 ? wlMin : wlMin + ((wlMax - wlMin) * (j + 0.5)) / NL);
  // photon-counting detector: weight each wavelength by lambda * B_lambda ~ lambda^-4 / (e^x - 1)
  const wgt = wls.map((wl) => (wl > 0 ? Math.pow(wl, -4) : 1));
  let norm = 0; for (let j = 0; j < NL; j++) norm += wgt[j] * intens(1, wls[j]);
  for (let k = 0; k < nmu; k++) {
    mu[k] = 0.02 + (0.98 * k) / (nmu - 1);
    let s = 0; for (let j = 0; j < NL; j++) s += wgt[j] * intens(mu[k], wls[j]);
    I[k] = s / norm;
  }
  return { mu, I };
}

function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

/** Least-squares coefficients of `law` for a profile { mu, I }. Returns { coeffs, rms }. */
export function fitLaw(law, prof) {
  const bases = {
    uniform: [], linear: [(m) => 1 - m], quadratic: [(m) => 1 - m, (m) => (1 - m) ** 2], kipping: [(m) => 1 - m, (m) => (1 - m) ** 2],
    sqrt: [(m) => 1 - m, (m) => 1 - Math.sqrt(m)],
    nonlinear: [(m) => 1 - Math.sqrt(m), (m) => 1 - m, (m) => 1 - Math.pow(m, 1.5), (m) => 1 - m * m],
  }[law];
  const nb = bases.length, n = prof.mu.length;
  let c = [];
  if (nb) {
    const A = Array.from({ length: nb }, () => new Array(nb).fill(0)), b = new Array(nb).fill(0);
    for (let i = 0; i < n; i++) {
      const g = bases.map((f) => f(prof.mu[i])), y = 1 - prof.I[i];
      for (let r = 0; r < nb; r++) { b[r] += g[r] * y; for (let q = 0; q < nb; q++) A[r][q] += g[r] * g[q]; }
    }
    // the four Claret basis functions are nearly collinear on a smooth profile: a small ridge keeps the solution tame
    if (law === 'nonlinear') for (let r = 0; r < nb; r++) A[r][r] *= 1 + 1e-6;
    c = solve(A, b);
  }
  let ss = 0;
  for (let i = 0; i < n; i++) { let y = 1; bases.forEach((f, r) => (y -= c[r] * f(prof.mu[i]))); ss += (y - prof.I[i]) ** 2; }
  let coeffs = c;
  if (law === 'kipping') { const q = quadraticToKipping(c[0], c[1]); coeffs = [Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1]))]; }
  return { coeffs, rms: Math.sqrt(ss / n) };
}

// ---- user-supplied coefficient grids ---------------------------------------------

/**
 * Parse a table with a header row. Needs columns named teff, logg and feh (or
 * mh / [fe/h] / z); an optional filter/band column; every other numeric column
 * is treated as a coefficient, in file order.
 */
export function parseLDGrid(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const split = (l) => (/[,;\t]/.test(l) ? l.split(/[,;\t]/).map((c) => c.trim()) : l.split(/\s+/));
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/[\[\]\s*]/g, ''));
  const col = (re) => head.findIndex((h) => re.test(h));
  const iT = col(/^t?eff$|^teff/), iG = col(/^logg$|^log\(g\)$|^g$/), iZ = col(/^feh$|^fe\/h$|^mh$|^m\/h$|^z$|^met/), iF = col(/^filter$|^band$|^passband$/);
  if (iT < 0 || iG < 0 || iZ < 0) throw new Error('The grid needs header columns named teff, logg and feh.');
  const cIdx = head.map((_, i) => i).filter((i) => ![iT, iG, iZ, iF].includes(i));
  const rows = [];
  for (const l of lines.slice(1)) {
    const p = split(l), c = cIdx.map((i) => Number(p[i]));
    const r = { teff: Number(p[iT]), logg: Number(p[iG]), feh: Number(p[iZ]), filter: iF >= 0 ? p[iF] : '', c };
    if ([r.teff, r.logg, r.feh, ...c].every(Number.isFinite)) rows.push(r);
  }
  if (rows.length < 2) throw new Error('No usable rows found in the grid.');
  const names = cIdx.map((i) => head[i]);
  const law = { 1: 'linear', 2: 'quadratic', 4: 'nonlinear' }[names.length];
  if (!law) throw new Error(`Found ${names.length} coefficient columns; expected 1 (linear), 2 (quadratic) or 4 (Claret).`);
  return { rows, names, law, filters: [...new Set(rows.map((r) => r.filter))] };
}

// Per-grid index (rows of one filter, its axes, a node lookup), built once: a bundled table has
// about ten thousand rows and the same grid is interpolated many times. Grids are never mutated.
const gridIndex = new WeakMap();
function indexFor(grid, filter) {
  let byFilter = gridIndex.get(grid);
  if (!byFilter) gridIndex.set(grid, (byFilter = new Map()));
  let ix = byFilter.get(filter);
  if (ix) return ix;
  let name = filter;
  if (grid.filters.length > 1 && !grid.filters.includes(name)) {
    name = grid.filters.find((f) => f.toLowerCase() === String(filter).toLowerCase());
    if (name === undefined) throw new Error(`The limb darkening table has no filter named "${filter}".`);
  }
  const rows = grid.rows.filter((r) => r.filter === name || grid.filters.length === 1);
  const axis = (k) => [...new Set(rows.map((r) => r[k]))].sort((a, b) => a - b);
  const nodes = new Map();
  for (const r of rows) { const key = r.teff + '|' + r.logg + '|' + r.feh; if (!nodes.has(key)) nodes.set(key, r); }
  ix = { rows, nodes, teff: axis('teff'), logg: axis('logg'), feh: axis('feh') };
  byFilter.set(filter, ix);
  return ix;
}

/**
 * Trilinear interpolation on a rectilinear grid. Outside the grid each coordinate is clamped to the
 * nearest edge and `clamped` is true. Where a cell lacks a corner, one coordinate is clamped to a
 * bracketing node that completes it (also `clamped`); only if that fails is the nearest node returned.
 * The filter name is matched exactly, then case-insensitively; a grid with one filter ignores it.
 */
export function interpLDGrid(grid, teff, logg, feh, filter = '') {
  const ix = indexFor(grid, filter), rows = ix.rows;
  const bracket = (ax, x) => {
    if (x <= ax[0]) return [ax[0], ax[0], 0];
    if (x >= ax[ax.length - 1]) return [ax[ax.length - 1], ax[ax.length - 1], 0];
    let i = 0; while (ax[i + 1] < x) i++;
    return [ax[i], ax[i + 1], (x - ax[i]) / (ax[i + 1] - ax[i])];
  };
  const T = bracket(ix.teff, teff), G = bracket(ix.logg, logg), Z = bracket(ix.feh, feh);
  const find = (t, g, z) => ix.nodes.get(t + '|' + g + '|' + z);
  const nc = grid.names.length;
  const cell = (T, G, Z) => {
    const out = new Array(nc).fill(0);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const r = find(T[a], G[b], Z[c]); if (!r) return null;
      const wgt = (a ? T[2] : 1 - T[2]) * (b ? G[2] : 1 - G[2]) * (c ? Z[2] : 1 - Z[2]);
      for (let i = 0; i < nc; i++) out[i] += wgt * r.c[i];
    }
    return out;
  };
  const outside = (ax, x) => !(x >= ax[0] && x <= ax[ax.length - 1]);
  const clamped = outside(ix.teff, teff) || outside(ix.logg, logg) || outside(ix.feh, feh);
  const out = cell(T, G, Z);
  if (out) return { coeffs: out, method: 'trilinear', clamped };
  // The cell has a missing corner: the grid is not a full box there (the bundled table holds log g 5.5
  // for cool stars only). Pull one coordinate to the nearer end of its bracket, then the farther one,
  // and interpolate in the other two; that is a clamp, and is reported as one.
  const pulls = [];
  [G, T, Z].forEach((B, k) => { if (B[0] !== B[1]) for (const end of B[2] < 0.5 ? [0, 1] : [1, 0]) pulls.push({ k, B: [B[end], B[end], 0], d: end ? 1 - B[2] : B[2] }); });
  for (const p of pulls.sort((x, y) => x.d - y.d)) {
    const o = cell(p.k === 1 ? p.B : T, p.k === 0 ? p.B : G, p.k === 2 ? p.B : Z);
    if (o) return { coeffs: o, method: 'trilinear', clamped: true };
  }
  let best = null, bd = Infinity;
  for (const r of rows) { const d = ((r.teff - teff) / 250) ** 2 + ((r.logg - logg) / 0.5) ** 2 + ((r.feh - feh) / 0.5) ** 2; if (d < bd) { bd = d; best = r; } }
  return { coeffs: best.c.slice(), method: 'nearest node', clamped, node: best };
}

// ---- tables in the app's own JSON format (tools/build_ld_table.py) -----------------

// A law fitted by linear least squares is a linear function of the profile, and a Claret profile is
// linear in its four coefficients. So the coefficients of a lower law fitted to a Claret profile are
// M a, with column k of M the fit to the k-th Claret basis function alone.
const claretBasis = [(m) => Math.sqrt(m), (m) => m, (m) => m * Math.sqrt(m), (m) => m * m];
function lawFromClaret(law, mu) {
  const cols = claretBasis.map((f) => fitLaw(law, { mu, I: mu.map((m) => f(m)) }).coeffs);   // 1 - I = 1 - mu^(n/2)
  return (a) => cols[0].map((_, i) => a[0] * cols[0][i] + a[1] * cols[1][i] + a[2] * cols[2][i] + a[3] * cols[3][i]);
}

// The same fit, kept physical. The model (buildProblem) treats a profile that goes negative or brightens
// toward the limb as outside the prior, so coefficients handed out as a star's defaults must not do
// either. For cool stars the plain least-squares linear, quadratic and square-root fits often do (a
// linear u above 1, for instance). Each law's physical region is a convex set bounded by straight lines:
//   linear     0 <= u <= 1
//   quadratic  u1 >= 0, u1 + 2 u2 >= 0 (dI/dmu >= 0 at mu = 1 and 0), u1 + u2 <= 1 (I(0) >= 0)
//   sqrt       d >= 0, c + d/2 >= 0, c + d <= 1                      (I = 1 - c (1 - mu) - d (1 - sqrt(mu)))
// so the constrained optimum is the plain one when that is inside, else the best point on the boundary.
// Being convex, the region also contains anything interpolated between physical nodes.
const PHYS = {
  quadratic: { basis: [(m) => 1 - m, (m) => (1 - m) ** 2], cons: [[-1, 0, 0], [-1, -2, 0], [1, 1, 1]] },
  sqrt: { basis: [(m) => 1 - m, (m) => 1 - Math.sqrt(m)], cons: [[0, -1, 0], [-1, -0.5, 0], [1, 1, 1]] },
};
function physicalFromClaret(law, mu) {
  const plain = lawFromClaret(law, mu);
  if (law === 'linear') return (a) => [Math.min(1, Math.max(0, plain(a)[0]))];
  const { basis, cons } = PHYS[law], H = [[0, 0], [0, 0]], G = [[0, 0, 0, 0], [0, 0, 0, 0]];
  for (const m of mu) {
    const b = [basis[0](m), basis[1](m)];
    for (let r = 0; r < 2; r++) { for (let c = 0; c < 2; c++) H[r][c] += b[r] * b[c]; for (let k = 0; k < 4; k++) G[r][k] += b[r] * (1 - claretBasis[k](m)); }
  }
  const inside = (x, tol) => cons.every((c) => c[0] * x[0] + c[1] * x[1] <= c[2] + tol);
  return (a) => {
    const x0 = plain(a);
    if (inside(x0, 0)) return x0;
    const g = [0, 1].map((r) => G[r][0] * a[0] + G[r][1] * a[1] + G[r][2] * a[2] + G[r][3] * a[3]);
    const cost = (x) => 0.5 * (H[0][0] * x[0] * x[0] + 2 * H[0][1] * x[0] * x[1] + H[1][1] * x[1] * x[1]) - g[0] * x[0] - g[1] * x[1];
    const cand = [];
    cons.forEach((c, i) => {
      // best point on the line c0 x0 + c1 x1 = c2: x = p + s d
      const n2 = c[0] * c[0] + c[1] * c[1], p = [(c[0] * c[2]) / n2, (c[1] * c[2]) / n2], d = [-c[1], c[0]];
      const Hd = [H[0][0] * d[0] + H[0][1] * d[1], H[0][1] * d[0] + H[1][1] * d[1]];
      const sBest = (g[0] * d[0] + g[1] * d[1] - (p[0] * Hd[0] + p[1] * Hd[1])) / (d[0] * Hd[0] + d[1] * Hd[1]);
      cand.push([p[0] + sBest * d[0], p[1] + sBest * d[1]]);
      for (let j = i + 1; j < cons.length; j++) {   // and the corner it makes with each other line
        const e = cons[j], det = c[0] * e[1] - c[1] * e[0];
        if (Math.abs(det) > 1e-12) cand.push([(c[2] * e[1] - c[1] * e[2]) / det, (c[0] * e[2] - c[2] * e[0]) / det]);
      }
    });
    let best = null, fb = Infinity;
    for (const x of cand) if (inside(x, 1e-12)) { const f = cost(x); if (f < fb) { fb = f; best = x; } }
    return best;
  };
}
const MU60 = Float64Array.from({ length: 60 }, (_, i) => 0.02 + (0.98 * i) / 59);
let sqrtFromClaret = null;
const tableGrids = new WeakMap();

/**
 * A JSON table carries linear, quadratic and nonlinear coefficients per node.
 * Returns a grid in the shape interpLDGrid() expects for the requested law.
 * Laws the table does not hold (kipping, sqrt) are obtained from its nonlinear
 * profile, so every law describes the same star. The grid for a (table, law)
 * pair is built once and reused; treat it as read-only.
 */
export function gridFromTable(table, law) {
  let byLaw = tableGrids.get(table);
  if (!byLaw) tableGrids.set(table, (byLaw = new Map()));
  if (byLaw.has(law)) return byLaw.get(law);
  const direct = law === 'linear' || law === 'quadratic' || law === 'nonlinear';
  // the square-root law is fitted on the table's own points (and kept physical) when it names them, else on 60 points even in mu
  const sqrtOf = law === 'sqrt' ? (table.muFit ? physicalFromClaret('sqrt', table.muFit) : (sqrtFromClaret = sqrtFromClaret || lawFromClaret('sqrt', MU60))) : null;
  const rows = table.rows.map((r) => {
    let c;
    if (direct) c = r[law];
    else if (law === 'kipping') { const q = quadraticToKipping(r.quadratic[0], r.quadratic[1]); c = [Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1]))]; }
    else if (law === 'sqrt') c = sqrtOf(r.nonlinear);
    else { const a = r.nonlinear, I = MU60.map((m) => 1 - a[0] * (1 - Math.sqrt(m)) - a[1] * (1 - m) - a[2] * (1 - m * Math.sqrt(m)) - a[3] * (1 - m * m)); c = fitLaw(law, { mu: MU60, I }).coeffs; }
    return { teff: r.teff, logg: r.logg, feh: r.feh, filter: r.filter || '', c };
  });
  const grid = { rows, law, names: rows[0].c.map((_, i) => 'c' + i), filters: [...new Set(rows.map((r) => r.filter))], name: table.source || 'table' };
  byLaw.set(law, grid);
  return grid;
}

function int16FromBase64(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) { const u = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); out[i] = u >= 0x8000 ? u - 0x10000 : u; }
  return out;
}

/**
 * Expand the compact table written by tools/build_ld_table.py (format 'esl-ld-compact-1': per filter
 * the four Claret coefficients on a rectilinear Teff x log g x [Fe/H] grid, as integers in units of the
 * filter's `scale`, either a plain array `a` or base64 little-endian int16 `a16`) into the row format
 * gridFromTable() reads. The linear and quadratic coefficients are least-squares fits to the stored
 * four-coefficient profile on `nmu` points between mu = 1 and mu_min (the range the builder fitted),
 * evenly spaced in radius when `sampling` is 'r' (the bundled table; this is ExoTETHyS's choice and
 * suits transits better than even spacing in mu), else evenly spaced in mu. The fits are constrained
 * to profiles that stay non-negative and do not brighten toward the limb (see physicalFromClaret);
 * for most nodes that changes nothing. The same points (`muFit`) and the same constraint are used by
 * gridFromTable() for the square-root law, so every law of a table is fitted alike.
 * Besides `rows` the result has `axes` { teff, logg, feh } and `bands` { name: { band, passband, dataset } }.
 */
export function expandLDTable(t) {
  if (!t || t.format !== 'esl-ld-compact-1' || !t.filters) throw new Error('Not a compact limb darkening table (format esl-ld-compact-1).');
  const nmu = t.nmu || 200, mu0 = t.mu_min ?? 0.1;
  const rMax = Math.sqrt(1 - mu0 * mu0);
  const mu = Float64Array.from({ length: nmu }, (_, i) => (t.sampling === 'r' ? Math.sqrt(1 - ((rMax * i) / (nmu - 1)) ** 2) : mu0 + ((1 - mu0) * i) / (nmu - 1)));
  const lin = physicalFromClaret('linear', mu), quad = physicalFromClaret('quadratic', mu);
  const nT = t.teff.length, nG = t.logg.length, nZ = t.feh.length, rows = [], bands = {};
  for (const [name, f] of Object.entries(t.filters)) {
    const v = f.a || int16FromBase64(f.a16), scale = f.scale || t.scale || 1e-4;
    if (v.length !== nT * nG * nZ * 4) throw new Error(`Limb darkening table: filter "${name}" has ${v.length} numbers, expected ${nT * nG * nZ * 4}.`);
    bands[name] = { band: f.band, passband: f.passband, dataset: f.dataset };
    for (let i = 0; i < nT; i++) for (let j = 0; j < nG; j++) for (let k = 0; k < nZ; k++) {
      const o = ((i * nG + j) * nZ + k) * 4;
      if (v[o] === null || v[o] === -32768) continue;      // a node the table does not hold (e.g. log g 5.5 for hot stars)
      const a = [v[o] * scale, v[o + 1] * scale, v[o + 2] * scale, v[o + 3] * scale];
      rows.push({ teff: t.teff[i], logg: t.logg[j], feh: t.feh[k], filter: name, linear: lin(a), quadratic: quad(a), nonlinear: a });
    }
  }
  return { source: t.source, built: t.built, mu_min: mu0, muFit: mu, axes: { teff: t.teff.slice(), logg: t.logg.slice(), feh: t.feh.slice() }, bands, filled: t.filled, rows };
}

/** Recognise either table format from file text. Returns { kind: 'json', table } or { kind: 'csv', grid }. */
export function readLDTable(text) {
  const t = text.trim();
  if (t.startsWith('{')) {
    let table = JSON.parse(t);
    if (table.format === 'esl-ld-compact-1') table = expandLDTable(table);
    if (!Array.isArray(table.rows) || !table.rows.length || !table.rows[0].nonlinear) throw new Error('JSON table needs rows with teff, logg, feh, filter, linear, quadratic, nonlinear.');
    return { kind: 'json', table };
  }
  return { kind: 'csv', grid: parseLDGrid(t) };
}

// ---- tying limb darkening to the star during a fit ---------------------------------

/**
 * Build a fast (Teff, [Fe/H]) -> coefficients function for use inside the
 * likelihood, by tabulating the estimator on a small grid and interpolating.
 * tie = { law, source: 'grey' | 'grid', band: [nm, nm], grid, filter, logg, teffRange: [lo, hi], fehRange: [lo, hi] }
 */
export function makeLDTie(tie) {
  const nT = 17, [t0, t1] = tie.teffRange, useZ = tie.source === 'grid';
  const nZ = useZ ? 7 : 1, [z0, z1] = tie.fehRange || [0, 0];
  const at = (T, Z) => (tie.source === 'grid' ? interpLDGrid(tie.grid, T, tie.logg, Z, tie.filter).coeffs : fitLaw(tie.law, greyProfile(T, tie.band[0], tie.band[1], { nmu: 40 })).coeffs);
  const nc = at(0.5 * (t0 + t1), 0.5 * (z0 + z1)).length, tab = new Float64Array(nT * nZ * nc);
  for (let i = 0; i < nT; i++) for (let j = 0; j < nZ; j++) tab.set(at(t0 + ((t1 - t0) * i) / (nT - 1), nZ > 1 ? z0 + ((z1 - z0) * j) / (nZ - 1) : z0), (i * nZ + j) * nc);
  return (teff, feh, out) => {
    let x = ((teff - t0) / (t1 - t0)) * (nT - 1); x = x < 0 ? 0 : x > nT - 1 ? nT - 1 : x;
    const i = Math.min(nT - 2, Math.floor(x)), fx = x - i;
    let j = 0, fy = 0;
    if (nZ > 1) { let y = ((feh - z0) / (z1 - z0)) * (nZ - 1); y = y < 0 ? 0 : y > nZ - 1 ? nZ - 1 : y; j = Math.min(nZ - 2, Math.floor(y)); fy = y - j; }
    for (let k = 0; k < nc; k++) {
      const a = tab[(i * nZ + j) * nc + k], b = tab[((i + 1) * nZ + j) * nc + k];
      if (nZ > 1) { const c = tab[(i * nZ + j + 1) * nc + k], d = tab[((i + 1) * nZ + j + 1) * nc + k]; out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy; }
      else out[k] = a * (1 - fx) + b * fx;
    }
    return out;
  };
}
