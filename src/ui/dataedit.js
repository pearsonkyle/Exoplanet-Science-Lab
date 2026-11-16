// Edits of a loaded light curve: keep a subset of the points, trim to a time window, clip outliers, bin.
// Pure functions on the dataset shape of core/data.js ({ t, f, e, airmass | null, epoch?, segments?, ... });
// no DOM, runnable in Node (test/dataedit.test.mjs). Each returns a NEW dataset: the input is never changed,
// because the undo history holds datasets by reference.

/** Put arrays back together as a dataset like `d`: epochs that lost every point are dropped and the rest renumbered. */
function assemble(d, t, f, e, am, ep, cols) {
  const n = t.length;
  if (!n) throw new Error('that would remove every point of the light curve');
  const out = { ...d, t, f, e };
  // the systematics model belongs to the points it was built on: the caller builds it again (data.js applyDetrend)
  delete out.regressors; delete out.kernel; delete out.detrendInfo;
  if (d.columns) out.columns = cols;
  if (!d.epoch) { out.airmass = d.airmass ? am : null; return out; }
  const count = new Array(d.segments.length).fill(0);
  for (let i = 0; i < n; i++) count[ep[i]]++;
  const map = new Array(d.segments.length).fill(-1); let k = 0;
  count.forEach((c, s) => { if (c > 0) map[s] = k++; });
  const segments = d.segments.filter((_, s) => count[s] > 0).map((sg) => ({ ...sg, n: 0, t0: Infinity, t1: -Infinity }));
  const epoch = new Int32Array(n);
  for (let i = 0; i < n; i++) { const s = map[ep[i]]; epoch[i] = s; const sg = segments[s]; sg.n++; sg.t0 = Math.min(sg.t0, t[i]); sg.t1 = Math.max(sg.t1, t[i]); }
  const any = segments.some((sg) => sg.airmass);
  if (segments.length === 1) {   // one epoch left: an ordinary single light curve
    delete out.epoch; delete out.segments;
    out.airmass = any && d.airmass ? am : null;
    return out;
  }
  out.epoch = epoch; out.segments = segments; out.airmass = any && d.airmass ? am : null;
  return out;
}

/** The dataset with only the points for which keep(i) is true. */
export function keepPoints(d, keep) {
  const idx = []; for (let i = 0; i < d.t.length; i++) if (keep(i)) idx.push(i);
  const take = (a) => Float64Array.from(idx, (i) => a[i]);
  return assemble(d, take(d.t), take(d.f), take(d.e), d.airmass ? take(d.airmass) : null, d.epoch ? idx.map((i) => d.epoch[i]) : null, d.columns ? Object.fromEntries(Object.entries(d.columns).map(([nm, a]) => [nm, take(a)])) : null);
}

/** Points with t0 <= t <= t1 (the dataset's own time axis). */
export function trimData(d, t0, t1) {
  if (!(t1 > t0)) throw new Error('trim needs two times, the first earlier than the second');
  return keepPoints(d, (i) => d.t[i] >= t0 && d.t[i] <= t1);
}

/**
 * Remove points further than `sigma` robust standard deviations from the model. resid[i] is the residual of point i
 * (data minus model, any units); the scatter is 1.4826 x the median absolute deviation, measured in each epoch on its own.
 * Returns { data, removed, scatter: [per epoch, in the units of resid] }.
 */
export function clipData(d, resid, sigma) {
  if (!(sigma > 0)) throw new Error('the clipping threshold must be a positive number of sigma');
  const ne = d.epoch ? d.segments.length : 1, med = new Array(ne).fill(0), sc = new Array(ne).fill(0);
  const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? (s.length % 2 ? s[s.length >> 1] : 0.5 * (s[(s.length >> 1) - 1] + s[s.length >> 1])) : 0; };
  for (let k = 0; k < ne; k++) {
    const r = []; for (let i = 0; i < d.t.length; i++) if (!d.epoch || d.epoch[i] === k) r.push(resid[i]);
    med[k] = median(r); sc[k] = 1.4826 * median(r.map((x) => Math.abs(x - med[k])));
  }
  const ok = (i) => { const k = d.epoch ? d.epoch[i] : 0; return !(sc[k] > 0) || Math.abs(resid[i] - med[k]) <= sigma * sc[k]; };
  const data = keepPoints(d, ok);
  return { data, removed: d.t.length - data.t.length, scatter: sc };
}

/**
 * Bin in time: inverse-variance weighted means of flux, time and airmass in bins `width` wide (same units as t),
 * counted from the first point of each epoch, so bins never straddle two epochs. The error of a bin is
 * 1 / sqrt(sum of weights): the error of the weighted mean, from the error bars as given.
 */
export function binData(d, width) {
  if (!(width > 0)) throw new Error('the bin width must be positive');
  const n = d.t.length, T = [], F = [], E = [], A = [], P = [], cn = d.columns ? Object.keys(d.columns) : [], C = cn.map(() => []), sc = cn.map(() => 0);
  let sw = 0, st = 0, sf = 0, sa = 0, bin = -1, ep = -1, start = 0;
  const flush = () => { if (sw > 0) { T.push(st / sw); F.push(sf / sw); E.push(1 / Math.sqrt(sw)); A.push(sa / sw); P.push(ep); cn.forEach((_, c) => C[c].push(sc[c] / sw)); } sw = st = sf = sa = 0; sc.fill(0); };
  for (let i = 0; i < n; i++) {
    const k = d.epoch ? d.epoch[i] : 0;
    if (k !== ep) { flush(); ep = k; start = d.t[i]; bin = 0; }
    const b = Math.floor((d.t[i] - start) / width);
    if (b !== bin) { flush(); bin = b; }
    const w = 1 / (d.e[i] * d.e[i]);
    sw += w; st += w * d.t[i]; sf += w * d.f[i]; sa += w * (d.airmass ? d.airmass[i] : 0); cn.forEach((nm, c) => (sc[c] += w * d.columns[nm][i]));
  }
  flush();
  return assemble(d, Float64Array.from(T), Float64Array.from(F), Float64Array.from(E), d.airmass ? Float64Array.from(A) : null, d.epoch ? P : null, d.columns ? Object.fromEntries(cn.map((nm, c) => [nm, Float64Array.from(C[c])])) : null);
}
