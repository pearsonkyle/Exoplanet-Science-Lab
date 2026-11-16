// Preparing long space light curves (TESS, Kepler, K2) for transit fitting: quality masks, per-sector stitching,
// transit-aware detrending, outlier clipping, per-transit cut-outs, the injection test that picks the detrending
// window, the alias scan of a planet seen in a few transits, and lightkurve's CDPP noise metric.
//
// Ported from the owner's TOI scripts (EXOTIC examples/toi-3planet/toi1873_extract.py: transit_mask, duration_t14,
// clip_outliers, optimize_window, bin_series, the post-gap trim, stage_alias_scan), from wotan's time-windowed
// biweight (Hippke et al. 2019, flatten(method='biweight')) and from lightkurve (quality bitmasks, flatten,
// estimate_cdpp). Checked against those codes in test/lcprep.test.mjs (reference: test/make_lcprep_reference.py).
// No DOM: runs in Node, in the worker and on the page.
import { savgol2 } from './photometry.js';
import { makeTransit } from './transit.js';

// ------------------------------------------------------------------------------------------------ quality flags

/**
 * lightkurve's quality bitmasks (lightkurve 2.6 utils.py: TessQualityFlags, KeplerQualityFlags, also used for K2).
 * 'default': cadences that are definitely bad; 'hard': also cosmic rays in the aperture or collateral pixels, stray
 * light (TESS), rolling band and possible thruster firings (Kepler / K2); 'hardest': any flag. EXOTIC's TESS scripts
 * download with 'hard'.
 */
export const QUALITY_BITMASKS = {
  tess: { none: 0, default: 17087, hard: 24319, hardest: 65535 },
  kepler: { none: 0, default: 1130799, hard: 1664431, hardest: 2096639 },
};
/** The bitmask of a preset ('none' | 'default' | 'hard' | 'hardest') for a mission ('TESS', 'Kepler', 'K2'); a number passes through. */
export function qualityBitmask(mission, preset = 'default') {
  if (typeof preset === 'number') return preset;
  const m = /tess/i.test(String(mission)) ? QUALITY_BITMASKS.tess : QUALITY_BITMASKS.kepler;
  if (!(preset in m)) throw new Error(`unknown quality preset "${preset}" (none, default, hard, hardest)`);
  return m[preset];
}
/** K2 thruster-firing bits: ThrusterFiring (1048576) and PossibleThrusterFiring (524288). */
export const K2_THRUSTER_BITS = 1048576 | 524288;

// ------------------------------------------------------------------------------------------------ small helpers

const fin = Number.isFinite;
function medianOfSorted(s, n = s.length) { return n ? (n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN; }
export function nanMedian(v) { const a = Float64Array.from(v).filter((x) => x === x).sort(); return medianOfSorted(a); }
/** numpy nanstd (ddof 0). */
export function nanStd(v) { let m = 0, n = 0; for (const x of v) if (x === x) { m += x; n++; } if (!n) return NaN; m /= n; let s = 0; for (const x of v) if (x === x) s += (x - m) * (x - m); return Math.sqrt(s / n); }
/** Index of the first element of the sorted `a` that is >= x (numpy searchsorted, side 'left'). */
function lowerBound(a, x, lo = 0, hi = a.length) { while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/** Linear interpolation of (xp, fp) (xp increasing) at x, constant beyond the ends (numpy interp). */
export function interp(x, xp, fp, out = new Float64Array(x.length)) {
  const n = xp.length;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!(v === v)) { out[i] = NaN; continue; }
    if (v <= xp[0]) { out[i] = fp[0]; continue; } if (v >= xp[n - 1]) { out[i] = fp[n - 1]; continue; }
    const k = lowerBound(xp, v); const u = (v - xp[k - 1]) / (xp[k] - xp[k - 1]); out[i] = fp[k - 1] + u * (fp[k] - fp[k - 1]);
  }
  return out;
}
/** As interp, extrapolating linearly from the two end points (scipy interp1d fill_value='extrapolate'). */
function interpExtrap(x, xp, fp, out) {
  const n = xp.length;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]; let k;
    if (n === 1) { out[i] = fp[0]; continue; }
    if (v <= xp[0]) k = 1; else if (v >= xp[n - 1]) k = n - 1; else { k = lowerBound(xp, v); if (xp[k] === v) { out[i] = fp[k]; continue; } }
    out[i] = fp[k - 1] + (v - xp[k - 1]) * (fp[k] - fp[k - 1]) / (xp[k] - xp[k - 1]);
  }
  return out;
}

/** A small seeded generator (mulberry32), so that injection tests repeat. */
export function rng(seed = 1) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------------------------------------ biweight (wotan)

/**
 * Tukey's biweight location of the values `s` (sorted, length n), starting at the median with the median absolute
 * deviation as scale, iterated until a step is smaller than 1e-6 MAD (wotan location_iter, cval = 5).
 */
export function biweightLocation(s, n = s.length, cval = 5, tmp = null) {
  if (!n) return NaN;
  const med = medianOfSorted(s, n);
  // MAD: the median of |s − med|. Left of the median the deviations med − s[r−1−i] ascend, right of it s[r+j] − med
  // ascend: merge the two runs up to the middle (O(n), no sort)
  const r = lowerBound(s, med, 0, n), K = (n - 1) >> 1; let i = 0, j = 0, v1 = 0, v2 = 0;
  for (let k = 0; k <= K + 1 && k < n; k++) {
    const a = r - 1 - i >= 0 ? med - s[r - 1 - i] : Infinity, b = r + j < n ? s[r + j] - med : Infinity;
    let v; if (a <= b) { v = a; i++; } else { v = b; j++; }
    if (k === K) v1 = v; if (k === K + 1) v2 = v;
  }
  void tmp;
  const mad = n & 1 ? v1 : 0.5 * (v1 + v2);
  if (mad === 0) return med;
  const cmad = 1 / (cval * mad), tol = 1e-6 * mad;
  let c = med;
  for (let it = 0; it < 1000; it++) {
    let sw = 0, sdw = 0;
    for (let j = 0; j < n; j++) { const dist = s[j] - c, u = dist * cmad; if (u >= 1 || u <= -1) continue; const w = (1 - u * u) * (1 - u * u); sdw += dist * w; sw += w; }
    const c1 = sw > 0 ? c + sdw / sw : c;
    if (Math.abs(c1 - c) <= tol) return c1;
    c = c1;
  }
  return c;
}

/**
 * Time-windowed sliding biweight trend (wotan flatten, method 'biweight'). For every point the location of the
 * unmasked points with time in [t - w/2, t + w/2) of its segment; segments are split where consecutive times differ by
 * more than `breakTolerance` (default w/2, as wotan). Points whose window holds no unmasked point get NaN, and so do
 * points within `edgeCutoff` of a segment's ends.
 * @param t times (any order; NaNs allowed), f fluxes
 * @param opts { window (days, required), mask: truthy = excluded from the trend estimate (wotan's convention, e.g.
 *               in-transit points), breakTolerance, edgeCutoff = 0, cval = 5, step: evaluate about every `step` days
 *               and interpolate between (wotan's `step`; much faster for long windows, used by the window scan) }
 * @returns Float64Array trend, aligned with t
 */
export function biweightTrend(t, f, opts = {}) {
  const w = opts.window; if (!(w > 0)) throw new Error('biweightTrend: window must be a positive number of days');
  const n = t.length, out = new Float64Array(n).fill(NaN), cval = opts.cval ?? 5, half = w / 2;
  let bt = opts.breakTolerance ?? half; if (bt === 0) bt = Infinity;
  const ec = Math.min(opts.edgeCutoff || 0, half), step = opts.step || 0;
  // valid points, in time order
  const idx = []; for (let i = 0; i < n; i++) if (fin(t[i]) && fin(f[i])) idx.push(i);
  idx.sort((a, b) => t[a] - t[b]);
  const m = idx.length, T = Float64Array.from(idx, (i) => t[i]), F = Float64Array.from(idx, (i) => f[i]), U = Uint8Array.from(idx, (i) => (opts.mask && opts.mask[i] ? 0 : 1));
  let s0 = 0;
  const buf = new Float64Array(m), tmp = new Float64Array(m);
  for (let k = 1; k <= m; k++) {
    if (k < m && !(T[k] - T[k - 1] > bt)) continue;
    // segment [s0, k)
    const lo0 = T[s0] + ec, hi0 = T[k - 1] - ec;
    let a = s0, b = s0, nb = 0, curA = s0, curB = s0;       // window [a, b) of the segment; buf holds its unmasked values sorted
    for (let i = s0; i < k; i++) {
      while (a < k && T[a] < T[i] - half) a++;
      while (b < k && T[b] < T[i] + half) b++;
      // slide: remove [curA, a), add [curB, b)
      for (let j = curA; j < a; j++) if (U[j] && j < curB) { const p = lowerBound(buf, F[j], 0, nb); buf.copyWithin(p, p + 1, nb); nb--; }
      for (let j = Math.max(curB, a); j < b; j++) if (U[j]) { const p = lowerBound(buf, F[j], 0, nb); buf.copyWithin(p + 1, p, nb); buf[p] = F[j]; nb++; }
      curA = a; curB = Math.max(curB, b);
      if (T[i] < lo0 || T[i] > hi0 || !nb) continue;
      if (step > 0 && i > s0 && i < k - 1 && Math.floor((T[i] - T[s0]) / step) === Math.floor((T[i - 1] - T[s0]) / step) && T[i] - T[i - 1] <= step && T[i + 1] - T[i] <= step) continue;
      out[idx[i]] = biweightLocation(buf, nb, cval, tmp);
    }
    // wotan's `step`: points between two evaluated ones are interpolated linearly in time
    if (step > 0) { let p = -1; for (let i = s0; i < k; i++) { const v = out[idx[i]]; if (v !== v) continue; if (p >= 0 && i > p + 1) { const a = out[idx[p]], sl = (v - a) / (T[i] - T[p]); for (let q = p + 1; q < i; q++) if (T[q] >= lo0 && T[q] <= hi0) out[idx[q]] = a + sl * (T[q] - T[p]); } p = i; } }
    s0 = k;
  }
  return out;
}

/** flux / trend with the biweight trend: { flat, trend } (wotan flatten(..., return_trend=True)). */
export function flatten(t, f, opts = {}) {
  const trend = biweightTrend(t, f, opts);
  return { flat: Float64Array.from(f, (v, i) => v / trend[i]), trend };
}

// ------------------------------------------------------------------------------------------------ transits

/**
 * Total transit duration T14 in days (EXOTIC toi1873_extract.py duration_t14): P/π asin(√((1+k)² − b²) / (a/R★ sin i)),
 * with the eccentric correction √(1−e²)/(1+e sin ω) on the speed and on b. NaN when the planet does not transit.
 */
export function durationT14(per, rprs, ars, inc = 90, ecc = 0, omega = 0) {
  const d = Math.PI / 180; let b = ars * Math.cos(inc * d), f = 1;
  if (ecc) { f = Math.sqrt(1 - ecc * ecc) / (1 + ecc * Math.sin(omega * d)); b *= (1 - ecc * ecc) / (1 + ecc * Math.sin(omega * d)); }
  const arg = (1 + rprs) * (1 + rprs) - b * b;
  if (arg <= 0) return NaN;
  return f * per / Math.PI * Math.asin(Math.sqrt(arg) / (ars * Math.sin(inc * d)));
}

/** Time from the nearest predicted transit, |((t − T0 + P/2) mod P) − P/2| with a floored modulo (numpy %). */
export function phaseDistance(t, per, tmid) { const x = t - tmid + 0.5 * per; return Math.abs(x - per * Math.floor(x / per) - 0.5 * per); }

/**
 * True where t lies within pad·T14/2 of a transit of any planet (EXOTIC transit_mask). planets: [{ per, tmid, t14 }].
 * @returns Uint8Array (1 = in transit)
 */
export function transitMask(t, planets, pad = 1.5) {
  const m = new Uint8Array(t.length);
  for (const p of planets) { if (!(p.per > 0 && p.t14 > 0)) continue; const h = pad * p.t14 / 2; for (let i = 0; i < t.length; i++) if (phaseDistance(t[i], p.per, p.tmid) < h) m[i] = 1; }
  return m;
}

// ------------------------------------------------------------------------------------------------ cleaning

/**
 * EXOTIC's sigma clip against a smooth trend that never clips in-transit points (toi1873_extract.py clip_outliers):
 * a Savitzky-Golay smooth (order 2, window 1 + 2·max(7, ⌊dtHr/24/cadence⌋) points) of the finite points in time
 * order, interpolated to every time; points more than `sigma` standard deviations (numpy, ddof 0) from it are dropped,
 * unless `tmask` marks them as in transit.
 * @returns Uint8Array keep (1 = keep)
 */
export function clipOutliers(t, f, tmask = null, sigma = 4, dtHr = 0.5) {
  const n = t.length, keep = Uint8Array.from(f, (v) => (fin(v) ? 1 : 0));
  let ng = 0; for (const k of keep) ng += k; if (ng < 25) return keep;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]);
  const ts = Float64Array.from(order, (i) => t[i]); const dts = new Float64Array(n - 1); for (let i = 1; i < n; i++) dts[i - 1] = ts[i] - ts[i - 1];
  const cad = nanMedian(dts), win = 1 + 2 * Math.trunc(Math.max(7, dtHr / 24 / cad));
  const g = order.filter((i) => fin(f[i]));
  if (win >= g.length) return keep;
  const sm = savgol2(Float64Array.from(g, (i) => f[i]), win), trend = interp(ts, Float64Array.from(g, (i) => t[i]), sm);
  const res = Float64Array.from(order, (i, k) => f[i] - trend[k]), std = nanStd(Float64Array.from(order.map((i, k) => (fin(f[i]) ? res[k] : NaN)).filter((v) => v === v)));
  order.forEach((i, k) => { const ok = Math.abs(res[k]) < sigma * std; if (!(ok || (tmask && tmask[i]))) keep[i] = 0; });
  return keep;
}

/**
 * Cadences to drop after gaps (thermal settling; EXOTIC's post_gap_trim): the first 2·ntrim good points of the
 * series and the ntrim points after every gap longer than `gapDays`, ntrim = max(1, ⌊minutes / (1440 · cadence)⌋).
 * @param good Uint8Array of usable points; returns Uint8Array trim (1 = drop)
 */
export function trimAfterGaps(t, good, minutes = 30, gapDays = 1 / 24) {
  const n = t.length, trim = new Uint8Array(n), si = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]);
  const dts = []; for (let k = 1; k < n; k++) dts.push(t[si[k]] - t[si[k - 1]]);
  const cad = nanMedian(dts), ntrim = Math.max(1, Math.trunc(minutes / (24 * 60 * cad))), order = si.filter((i) => good[i]);
  if (order.length > 2 * ntrim) {
    for (let k = 0; k < 2 * ntrim; k++) trim[order[k]] = 1;
    for (let k = 0; k < order.length - 1; k++) if (t[order[k + 1]] - t[order[k]] > gapDays) for (let j = k + 1; j < Math.min(order.length, k + 1 + ntrim); j++) trim[order[j]] = 1;
  }
  return trim;
}

/**
 * Average groups of `nb` cadences on a uniform time grid (EXOTIC bin_series): a downlink gap never merges cadences across
 * it, and a bin is in transit when any member was. chan: { name: array } binned the same way.
 * @returns { t, f, m, chan }
 */
export function binSeries(t, f, m, chan = {}, nb = 2) {
  const n = t.length, si = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]), ts = Float64Array.from(si, (i) => t[i]);
  const dts = []; for (let k = 1; k < n; k++) dts.push(ts[k] - ts[k - 1]);
  const dt = nanMedian(dts) * nb, t0 = ts[0], ne = Math.floor((ts[n - 1] + dt - t0) / dt - 1e-12) + 1;   // np.arange(t.min(), t.max() + dt, dt)
  const edges = Float64Array.from({ length: ne }, (_, k) => t0 + k * dt);
  const bin = Int32Array.from(ts, (v) => { let k = lowerBound(edges, v); if (k < ne && edges[k] === v) k++; return Math.min(ne - 1, Math.max(0, k - 1)); });   // np.digitize - 1, clipped
  const cnt = new Float64Array(ne); for (const b of bin) cnt[b]++;
  const avg = (v) => { const s = new Float64Array(ne); si.forEach((i, k) => { s[bin[k]] += v[i]; }); const o = []; for (let b = 0; b < ne; b++) if (cnt[b] > 0) o.push(s[b] / cnt[b]); return Float64Array.from(o); };
  const mm = new Float64Array(ne); si.forEach((i, k) => { if (m && m[i]) mm[bin[k]] = 1; });
  const mb = []; for (let b = 0; b < ne; b++) if (cnt[b] > 0) mb.push(mm[b] ? 1 : 0);
  return { t: avg(t), f: avg(f), m: Uint8Array.from(mb), chan: Object.fromEntries(Object.entries(chan).map(([k, v]) => [k, avg(v)])) };
}

// ------------------------------------------------------------------------------------------------ the detrending window

/**
 * Choose the biweight window by synthetic-transit recovery (EXOTIC optimize_window): box transits of depth `depth` and
 * duration t14max are injected (one at a time) at `epochs` away from the real transits; each candidate window detrends
 * with the real transits masked and the injected one NOT masked (the damage a trend does to an unknown transit); the
 * recovered fraction is (median out of the box − median in the box) / depth, and the score is
 * recovered / (noise / √(t14max / cadence)), noise being the standard deviation of the flattened out-of-transit flux.
 * @param opts { grid: windows in days, depth = 1500e-6, epochs: injection times (else drawn with a seeded generator as
 *               EXOTIC draws them), nInject = 12, seed = 0, breakTolerance (EXOTIC: gap tolerance, 1 h), step (biweightTrend's;
 *               the page uses 10 min, EXOTIC none) }
 * @returns { window, scan: { [window]: { depth_recovered, noise_ppm, score } }, epochs }
 */
export function optimizeWindow(t, f, tmask, t14max, opts = {}) {
  const grid = opts.grid || [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8], depth = opts.depth ?? 1500e-6, n = t.length;
  let tmin = Infinity, tmax = -Infinity, nout = 0; for (let i = 0; i < n; i++) { tmin = Math.min(tmin, t[i]); tmax = Math.max(tmax, t[i]); if (!tmask[i]) nout++; }
  const last = grid[grid.length - 1];
  if (tmax - tmin < 2 * t14max || nout < 100) return { window: last, scan: {}, epochs: [] };
  // EXOTIC's point counts (10 near an injection, 5 in its box) were written for 2-minute data; opts.minNear / minBox
  // scale them for coarser cadences (the page passes counts from the cadence)
  const minNear = opts.minNear ?? 10, minBox = opts.minBox ?? 5;
  let epochs = opts.epochs;
  if (!epochs) {
    const r = rng(opts.seed ?? 0); epochs = [];
    for (let k = 0; k < 200 && epochs.length < (opts.nInject ?? 12); k++) {
      const t0 = tmin + t14max + r() * (tmax - tmin - 2 * t14max); let near = 0, hit = false;
      for (let i = 0; i < n; i++) if (Math.abs(t[i] - t0) < t14max) { near++; if (tmask[i]) hit = true; }
      if (near > minNear && !hit && epochs.every((e) => Math.abs(t0 - e) > 2 * t14max)) epochs.push(t0);
    }
  }
  const sorted = Float64Array.from(t).sort(), dts = []; for (let k = 1; k < n; k++) dts.push(sorted[k] - sorted[k - 1]);
  const cad = nanMedian(dts), npts = Math.max(1, Math.trunc(t14max / cad)), scan = {};
  for (const wl of grid) {
    if (wl <= 2 * cad) continue;
    const fo = { window: wl, mask: tmask, breakTolerance: opts.breakTolerance, step: opts.step };
    const base = flatten(t, f, fo).flat, oot = []; for (let i = 0; i < n; i++) if (fin(base[i]) && !tmask[i]) oot.push(base[i]);
    const noise = nanStd(oot); if (!(noise > 0)) continue;
    const rec = [];
    for (const t0 of epochs) {
      const box = Uint8Array.from(t, (v) => (Math.abs(v - t0) < t14max / 2 ? 1 : 0)); let nbx = 0; for (const b of box) nbx += b; if (nbx < minBox) continue;
      const inj = Float64Array.from(f, (v, i) => (box[i] ? v * (1 - depth) : v)), fl = flatten(t, inj, fo).flat;
      const inb = [], out = []; for (let i = 0; i < n; i++) { if (!fin(fl[i])) continue; if (box[i]) inb.push(fl[i]); else if (!tmask[i] && Math.abs(t[i] - t0) < 3 * t14max) out.push(fl[i]); }
      if (inb.length < minBox || out.length < 2 * minBox) continue;
      rec.push((nanMedian(out) - nanMedian(inb)) / depth);
    }
    if (!rec.length) continue;
    const frac = nanMedian(rec);
    scan[wl] = { depth_recovered: frac, noise_ppm: noise * 1e6, score: frac / (noise / Math.sqrt(npts)) };
  }
  const keys = Object.keys(scan); if (!keys.length) return { window: last, scan, epochs };
  const best = keys.reduce((a, b) => (scan[b].score > scan[a].score ? b : a));
  return { window: +best, scan, epochs };
}

// ------------------------------------------------------------------------------------------------ stitching

/**
 * Join several light curves (sectors, quarters, campaigns) into one: each is divided by its own median (lightkurve
 * LightCurveCollection.stitch, EXOTIC's per-sector normalisation), the points are put in time order, and a point
 * less than 1 s after the previous one is dropped (the same photons twice: a sector in 20 s and 2 min). parts:
 * [{ name, t, f, e?, columns?: { name: array } }].
 * @returns { t, f, e, segment (index of the part per point), names, medians, dropped }
 */
export function stitch(parts) {
  const rows = [];
  parts.forEach((p, s) => { const med = nanMedian(Float64Array.from(p.f).filter((v, i) => fin(v) && fin(p.t[i]))); p._med = med; for (let i = 0; i < p.t.length; i++) if (fin(p.t[i]) && fin(p.f[i])) rows.push([p.t[i], p.f[i] / med, p.e ? p.e[i] / med : NaN, s, i]); });
  rows.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
  const keep = []; let dropped = 0; for (const r of rows) { if (keep.length && r[0] - keep[keep.length - 1][0] < 1 / 86400) { dropped++; continue; } keep.push(r); }
  const cols = {}; for (const p of parts) for (const k of Object.keys(p.columns || {})) cols[k] = new Float64Array(keep.length).fill(NaN);
  keep.forEach((r, k) => { const p = parts[r[3]]; for (const c of Object.keys(p.columns || {})) cols[c][k] = p.columns[c][r[4]]; });
  return { t: Float64Array.from(keep, (r) => r[0]), f: Float64Array.from(keep, (r) => r[1]), e: Float64Array.from(keep, (r) => r[2]), segment: Int32Array.from(keep, (r) => r[3]), names: parts.map((p) => p.name), medians: parts.map((p) => p._med), dropped, columns: cols };
}

// ------------------------------------------------------------------------------------------------ per-transit windows

/**
 * The window around every predicted transit of every planet that the data cover (EXOTIC stage_fit): points with
 * |t − Tc| < halfWidth (default 2.5 T14, EXOTIC's fit_window_durations); a window is kept when it holds at least
 * max(10, round(40 · 2 / cadence_minutes)) points (EXOTIC's 40 points at 2 min, scaled for coarser data) and points on
 * both sides of Tc, and at least one inside ±T14/2 (unless keepEmpty). Another planet transiting inside the window is reported (`overlaps`), and with
 * `divideOthers` its model transit is divided out of `fOut` (EXOTIC's fix for blended windows; needs rprs, ars, inc).
 * planets: [{ name, per, tmid, t14, rprs?, ars?, inc?, ecc?, omega?, ld? }].
 * @returns { windows: [{ planet, epoch, tc, idx: [indices], n, overlaps: [names], coverage }], fOut }
 */
export function transitWindows(t, f, planets, opts = {}) {
  const n = t.length, wins = [], fOut = Float64Array.from(f), k = opts.durations ?? 2.5, models = {};
  if (opts.divideOthers) for (const p of planets) if (p.rprs > 0 && p.ars > 1 && fin(p.inc)) models[p.name] = makeTransit({ rprs: p.rprs, per: p.per, tmid: p.tmid, ars: p.ars, inc: p.inc, ecc: p.ecc || 0, omega: p.omega || 0, ldLaw: 'quadratic', ld: p.ld || [0.4, 0.2] });
  let tmin = Infinity, tmax = -Infinity; for (const v of t) if (fin(v)) { tmin = Math.min(tmin, v); tmax = Math.max(tmax, v); }
  for (const p of planets) {
    if (!(p.per > 0 && p.t14 > 0)) continue;
    const half = opts.halfWidth ?? k * p.t14, e0 = Math.floor((tmin - half - p.tmid) / p.per), e1 = Math.ceil((tmax + half - p.tmid) / p.per);
    for (let E = e0; E <= e1; E++) {
      const tc = p.tmid + E * p.per, idx = []; for (let i = 0; i < n; i++) if (fin(t[i]) && fin(f[i]) && Math.abs(t[i] - tc) < half) idx.push(i);
      if (idx.length < 4) continue;
      const tt = idx.map((i) => t[i]).sort((a, b) => a - b), dts = []; for (let j = 1; j < tt.length; j++) dts.push(tt[j] - tt[j - 1]);
      const cadMin = nanMedian(dts) * 1440, minPts = Math.max(10, Math.round((opts.minPoints ?? 40) * 2 / Math.max(cadMin, 1e-6)));
      if (idx.length < minPts) continue;
      const before = idx.filter((i) => t[i] < tc - p.t14 / 2).length, after = idx.filter((i) => t[i] > tc + p.t14 / 2).length, during = idx.filter((i) => Math.abs(t[i] - tc) <= p.t14 / 2).length;
      if (!during && !opts.keepEmpty) continue;     // a window whose transit fell in a gap carries no transit
      const overlaps = planets.filter((q) => q !== p &&q.per > 0 && q.t14 > 0 && idx.some((i) => phaseDistance(t[i], q.per, q.tmid) < q.t14 / 2)).map((q) => q.name);
      for (const o of overlaps) if (models[o]) for (const i of idx) fOut[i] = fOut[i] / models[o](t[i]);
      wins.push({ planet: p.name, epoch: E, tc, idx, n: idx.length, before, during, after, overlaps, coverage: during * nanMedian(dts) / p.t14 });
    }
  }
  wins.sort((a, b) => a.tc - b.tc);
  return { windows: wins, fOut };
}

// ------------------------------------------------------------------------------------------------ aliases

/**
 * Which aliases P = (span of the observed transits) / N of a planet seen in a few transits survive the coverage
 * (EXOTIC stage_alias_scan): every transit an alias predicts inside the data is "covered" when the cadences within
 * ±T14/2 of it add up (each counting its own sector's cadence) to more than half of T14, and "missed" when it is
 * covered but more than 0.1 d from every observed transit. An alias with a missed transit is rejected.
 * @param t times of the data, cad per-point cadence (days), epochs observed mid-transit times
 * @param opts { rprs, arsFor: P => a/R★ (Kepler's law with the star), Nmax = 25, inc = 90 }
 * @returns { baseline, rows: [{ N, per, t14_hr, covered, missed, allowed }], minimumAllowed }
 */
export function aliasScan(t, cad, epochs, opts = {}) {
  const ep = Float64Array.from(epochs).sort(), baseline = (ep[ep.length - 1] - ep[0]) / (ep.length - 1), rows = [];
  const order = Array.from({ length: t.length }, (_, i) => i).sort((a, b) => t[a] - t[b]), ts = Float64Array.from(order, (i) => t[i]), cs = Float64Array.from(order, (i) => cad[i]);
  const tmin = ts[0], tmax = ts[ts.length - 1];
  for (let N = 1; N <= (opts.Nmax ?? 25); N++) {
    const P = baseline / N, dur = durationT14(P, opts.rprs, opts.arsFor(P), opts.inc ?? 90);
    const n0 = Math.floor((tmin - ep[0]) / P) - 1, n1 = Math.ceil((tmax - ep[0]) / P) + 1;
    let covered = 0, missed = 0;
    for (let k = n0; k <= n1; k++) {
      const x = ep[0] + k * P; if (!(x > tmin && x < tmax)) continue;
      let s = 0; for (let i = lowerBound(ts, x - dur / 2); i < ts.length && ts[i] < x + dur / 2; i++) if (ts[i] > x - dur / 2) s += cs[i];
      if (s / dur > 0.5) { covered++; if (Math.min(...Array.from(ep, (e) => Math.abs(e - x))) > 0.1) missed++; }
    }
    rows.push({ N, per: P, t14_hr: dur * 24, covered, missed, allowed: missed === 0 });
  }
  const ok = rows.filter((r) => r.allowed);
  return { baseline, rows, minimumAllowed: ok.length ? Math.min(...ok.map((r) => r.per)) : NaN };
}

/** Per-point cadence: the median spacing of each segment's own points (EXOTIC: per sector), so an FFI sector counts its 30 min. */
export function cadencePerPoint(t, segment) {
  const out = new Float64Array(t.length), groups = new Map();
  for (let i = 0; i < t.length; i++) { const s = segment ? segment[i] : 0; if (!groups.has(s)) groups.set(s, []); groups.get(s).push(i); }
  for (const idx of groups.values()) { const ts = idx.map((i) => t[i]).sort((a, b) => a - b), d = []; for (let k = 1; k < ts.length; k++) d.push(ts[k] - ts[k - 1]); const c = ts.length > 1 ? nanMedian(d) : 0; for (const i of idx) out[i] = c; }
  return out;
}

// ------------------------------------------------------------------------------------------------ CDPP (lightkurve)

/**
 * astropy sigma_clip(data, sigma, maxiters=5, cenfunc='median', stdfunc='std') as lightkurve's remove_outliers uses
 * it: returns Uint8Array keep.
 */
export function sigmaClipKeep(v, sigma = 5, maxiters = 5) {
  const n = v.length, keep = Uint8Array.from(v, (x) => (fin(x) ? 1 : 0));
  for (let it = 0; it < maxiters; it++) {
    const g = []; for (let i = 0; i < n; i++) if (keep[i]) g.push(v[i]);
    const med = nanMedian(g), sd = nanStd(g); let changed = 0;
    for (let i = 0; i < n; i++) if (keep[i] && Math.abs(v[i] - med) > sigma * sd) { keep[i] = 0; changed++; }
    if (!changed) break;
  }
  return keep;
}

/**
 * lightkurve LightCurve.flatten: a Savitzky-Golay trend (window `window` cadences, order 2) per stretch between gaps of
 * more than `breakTolerance` × the median spacing, iterated `niters` times with points beyond `sigma` standard deviations
 * set aside and the trend interpolated across them. Returns { flat, trend }.
 */
export function savgolFlatten(t, f, opts = {}) {
  const { window = 101, breakTolerance = 5, niters = 3, sigma = 3 } = opts, n = t.length;
  const med = nanMedian(f), sd = nanStd(f), mask = Uint8Array.from(f, (v) => (fin(v) && Math.abs(v - med) <= sd * sigma ? 1 : 0));
  if (opts.mask) for (let i = 0; i < n; i++) if (opts.mask[i]) mask[i] = 0;
  let trend = new Float64Array(n);
  for (let it = 0; it < niters; it++) {
    const id = []; for (let i = 0; i < n; i++) if (mask[i]) id.push(i);
    const m = id.length, dt = new Float64Array(Math.max(0, m - 1)); for (let k = 1; k < m; k++) dt[k - 1] = t[id[k]] - t[id[k - 1]];
    const mdt = nanMedian(dt), tr = new Float64Array(m); let lo = 0;
    for (let k = 1; k <= m; k++) {
      if (k < m && !(dt[k - 1] > breakTolerance * mdt)) continue;
      const seg = Float64Array.from(id.slice(lo, k), (i) => f[i]);
      if (window > k - lo || k - lo < breakTolerance) tr.fill(nanMedian(seg), lo, k); else tr.set(savgol2(seg, window), lo);
      lo = k;
    }
    const r = Float64Array.from(id, (i, k) => f[i] - tr[k]), s = nanStd(r), ok = Uint8Array.from(r, (v) => (Math.abs(v) < s * sigma + 1e-14 ? 1 : 0));
    const xp = [], fp = []; for (let k = 0; k < m; k++) if (ok[k]) { xp.push(t[id[k]]); fp.push(tr[k]); }
    trend = interpExtrap(t, xp, fp, new Float64Array(n));
    id.forEach((i, k) => { if (!ok[k]) mask[i] = 0; });
  }
  return { flat: Float64Array.from(f, (v, i) => v / trend[i]), trend };
}

/**
 * lightkurve estimate_cdpp: flatten (Savitzky-Golay, `savgolWindow` cadences), remove outliers beyond `sigma`
 * (astropy sigma_clip), normalise to ppm, take the running mean over `transitDuration` cadences and return its standard
 * deviation (ppm). Times and fluxes of good cadences only (NaNs are ignored).
 */
export function cdpp(t, f, opts = {}) {
  const { transitDuration = 13, savgolWindow = 101, sigma = 5 } = opts;
  const id = []; for (let i = 0; i < t.length; i++) if (fin(t[i]) && fin(f[i])) id.push(i);
  const tt = Float64Array.from(id, (i) => t[i]), ff = Float64Array.from(id, (i) => f[i]);
  const fl = savgolFlatten(tt, ff, { window: savgolWindow }).flat, keep = sigmaClipKeep(fl, sigma);
  const c = []; for (let i = 0; i < fl.length; i++) if (keep[i]) c.push(fl[i]);
  const med = nanMedian(c), ppm = c.map((v) => v / med * 1e6), w = Math.min(transitDuration, ppm.length);
  const rm = []; let s = 0; for (let i = 0; i < ppm.length; i++) { s += ppm[i]; if (i >= w) s -= ppm[i - w]; if (i >= w - 1) rm.push(s / w); }
  return nanStd(rm);
}
