// Transit ephemerides from mid-transit times.
//
//   linear      T(E) = T0 + P E
//   quadratic   T(E) = T0 + P E + (1/2) (dP/dE) E^2      (orbital decay, apsidal precession to first order)
//
// Weighted least squares with the covariance taken from the supplied error bars
// (not rescaled by chi^2). The fit is done in a centred, scaled epoch variable and
// with a time offset removed, so Julian dates of 2.4 million keep their precision;
// the result is then mapped back to epoch 0. No DOM, no dependencies.

/** Milliseconds per year for each day/day of period change. */
export const MS_PER_YEAR = 365.25 * 86400e3;

function invertSym(a, n) {
  // Gauss-Jordan with partial pivoting on a small (2x2 or 3x3) matrix; null when singular
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (!(Math.abs(m[p][c]) > 1e-300)) return null;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c]; if (f !== 0) for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j]; }
  }
  return m.map((row) => row.slice(n));
}

/**
 * Fit an ephemeris. epochs: integers; times, errs: days. order: 1 (linear) or 2 (quadratic).
 * Returns { order, n, k, t0, per, dPdE, err: {t0, per, dPdE}, cov (k x k, order t0, per, dPdE),
 *           chi2, dof, bic, dPdt (days/day), dPdtErr, predict(E) -> {t, sigma}, residual(i) }.
 * Throws when there are too few points or the epochs cannot constrain the model.
 */
export function fitEphemeris(epochs, times, errs, order = 1) {
  const n = epochs.length, k = order + 1;
  if (order !== 1 && order !== 2) throw new Error('order must be 1 or 2');
  if (times.length !== n || errs.length !== n) throw new Error('epochs, times and errors must have the same length');
  if (n < k) throw new Error(`need at least ${k} mid-transit times for a ${order === 1 ? 'linear' : 'quadratic'} ephemeris`);
  for (let i = 0; i < n; i++) if (!(errs[i] > 0) || !Number.isFinite(times[i]) || !Number.isFinite(epochs[i])) throw new Error('every time needs a finite value and a positive uncertainty');
  // centre and scale
  let sw = 0, swe = 0, emin = Infinity, emax = -Infinity;
  for (let i = 0; i < n; i++) { const w = 1 / (errs[i] * errs[i]); sw += w; swe += w * epochs[i]; emin = Math.min(emin, epochs[i]); emax = Math.max(emax, epochs[i]); }
  const m = swe / sw, s = Math.max(1, (emax - emin) / 2), tRef = times[0];
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const w = 1 / (errs[i] * errs[i]), x = (epochs[i] - m) / s, y = times[i] - tRef, pw = [1, x, x * x];
    for (let r = 0; r < k; r++) { b[r] += w * pw[r] * y; for (let c = 0; c < k; c++) A[r][c] += w * pw[r] * pw[c]; }
  }
  const C = invertSym(A, k);
  if (!C) throw new Error('the epochs do not constrain this ephemeris (are they all the same?)');
  const c = C.map((row) => row.reduce((acc, v, j) => acc + v * b[j], 0));
  // back to T0 at epoch 0, P, dP/dE:  x = (E - m)/s
  const J = order === 1
    ? [[1, -m / s], [0, 1 / s]]
    : [[1, -m / s, (m * m) / (s * s)], [0, 1 / s, (-2 * m) / (s * s)], [0, 0, 2 / (s * s)]];
  const par = J.map((row) => row.reduce((acc, v, j) => acc + v * c[j], 0));
  const cov = J.map((ri) => J.map((rj) => { let v = 0; for (let a = 0; a < k; a++) for (let d = 0; d < k; d++) v += ri[a] * C[a][d] * rj[d]; return v; }));
  const t0 = tRef + par[0], per = par[1], dPdE = order === 2 ? par[2] : 0;
  const model = (E) => { const x = (E - m) / s; return tRef + c[0] + c[1] * x + (order === 2 ? c[2] * x * x : 0); };
  const predict = (E) => {
    const x = (E - m) / s, g = order === 2 ? [1, x, x * x] : [1, x];
    let v = 0; for (let a = 0; a < k; a++) for (let d = 0; d < k; d++) v += g[a] * C[a][d] * g[d];
    return { t: model(E), sigma: Math.sqrt(Math.max(0, v)) };
  };
  let chi2 = 0;
  for (let i = 0; i < n; i++) chi2 += ((times[i] - model(epochs[i])) / errs[i]) ** 2;
  const sd = (i) => Math.sqrt(Math.max(0, cov[i][i]));
  const out = {
    order, n, k, t0, per, dPdE, err: { t0: sd(0), per: sd(1), dPdE: order === 2 ? sd(2) : 0 }, cov,
    chi2, dof: n - k, bic: chi2 + k * Math.log(n), predict, model,
    residual: (i) => times[i] - model(epochs[i]),
  };
  if (order === 2) {
    // dP/dt = (dP/dE) / P, with the (small) contribution of the period's own uncertainty
    out.dPdt = dPdE / per;
    out.dPdtErr = Math.sqrt(Math.max(0, cov[2][2] / (per * per) + (dPdE * dPdE * cov[1][1]) / per ** 4 - (2 * dPdE * cov[1][2]) / per ** 3));
  }
  return out;
}

/**
 * Whole-orbit counts for a list of times, given a period and a reference time.
 * Returns { epochs, maxFrac }: maxFrac is the largest distance from a whole orbit, in periods
 * (near 0.5 means the period is too uncertain to count orbits).
 */
export function assignEpochs(times, per, tRef) {
  let maxFrac = 0;
  const epochs = Array.from(times, (t) => { const x = (t - tRef) / per, e = Math.round(x); maxFrac = Math.max(maxFrac, Math.abs(x - e)); return e; });
  return { epochs, maxFrac };
}

/**
 * Read mid-transit times from text: one transit per line, columns separated by commas,
 * semicolons, tabs or spaces. Two columns are (time, uncertainty); with three, the
 * all-integer column is the epoch. Lines that are not numbers (headers, comments) are skipped.
 * Returns { rows: [{ t, e, epoch|null }], skipped }.
 */
export function parseTimings(text) {
  const raw = []; let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const tok = s.split(/[,;\s]+/).filter(Boolean).map(Number);
    if (tok.length < 2 || tok.length > 3 || tok.some((v) => !Number.isFinite(v))) { skipped++; continue; }
    raw.push(tok);
  }
  if (!raw.length) throw new Error('no rows of numbers found: expected "time, uncertainty" or "epoch, time, uncertainty" on each line');
  const nc = raw[0].length;
  if (raw.some((r) => r.length !== nc)) throw new Error('rows have different numbers of columns');
  const col = (j) => raw.map((r) => r[j]), med = (a) => [...a].map(Math.abs).sort((x, y) => x - y)[a.length >> 1];
  let iE = -1;
  if (nc === 3) {
    // the epoch column holds whole numbers; if several do, it is the one that is not the largest (times) or smallest (errors)
    const ints = [0, 1, 2].filter((j) => col(j).every(Number.isInteger));
    if (!ints.length) throw new Error('three columns but none holds whole-number epochs');
    iE = ints.length === 1 ? ints[0] : ints.sort((a, b) => med(col(a)) - med(col(b)))[ints.length === 3 ? 1 : 0];
  }
  const rest = [0, 1, 2].slice(0, nc).filter((j) => j !== iE);
  const [iT, iS] = med(col(rest[0])) >= med(col(rest[1])) ? rest : [rest[1], rest[0]];
  const rows = raw.map((r) => ({ t: r[iT], e: r[iS], epoch: iE >= 0 ? r[iE] : null }));
  const bad = rows.findIndex((r) => !(r.e > 0));
  if (bad >= 0) throw new Error(`row ${bad + 1}: the uncertainty must be positive`);
  rows.sort((a, b) => a.t - b.t);
  return { rows, skipped };
}
