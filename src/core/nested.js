// MiniNest: a compact nested sampler in the spirit of UltraNest's
// ReactiveNestedSampler (Buchner 2021).
//
// What is the same as UltraNest:
//   * MLFriends region (Buchner 2016, 2019): live points are whitened with
//     their covariance, and the constrained prior is bounded by the union of
//     balls around every live point. The ball radius is found by bootstrapping
//     (leave-out cross-validation), so the region is robust rather than tuned.
//   * Cluster-aware whitening (UltraNest's AffineLayer): live points are grouped
//     by friends-of-friends at the ball radius, and the covariance is taken about
//     each group's own mean. Separated modes (period aliases) then keep tight
//     balls instead of one metric stretched across the gap between them. A new
//     region is used only if it is smaller than the last one.
//   * A wrapping ellipsoid, also bootstrapped, intersected with the balls.
//   * Uniform rejection sampling from that region inside the unit cube, drawn
//     from the balls, the ellipsoid or a bounding box, whichever wastes least.
//   * A slice step sampler (hit-and-run; Neal 2003) along a mixture of
//     directions: differences of live points of the same group and random
//     directions in the whitened space (generate_mixture_random_direction).
//   * Termination on the fraction of evidence left in the live points.
//   * Insertion-order test as a self-diagnostic (Buchner 2023).
// What is different:
//   * The ellipsoid's enlargement is cross-validated with the ellipsoid re-fitted
//     to each bootstrap sample, which removes a bias in ln Z that grows with the
//     number of dimensions (+0.5 at 20 dimensions with 400 live points).
//   * The radius ignores groups that were left out whole and are far away, so a
//     mode down to its last point does not join all modes up again.
//   * The choice between region and slice sampling is made during the run from
//     the measured cost of each, with hysteresis, in both directions.
//   * The insertion-order test is also used during the run: if the points drawn
//     with the help of the region fail it, the run starts again with plain slice
//     sampling (funnels do this).
//   * A budget of likelihood calls (and of seconds) ends the run cleanly, and the
//     result carries plain-language warnings (see diagnose below).
// What is left out: the reactive tree (dynamic number of live points), a metric
// per mode, warm starts, MPI.
//
// The sampler is a stepper (call step(n) repeatedly) so it can run in a Web
// Worker or be time-sliced on the main thread. For one seed the run is the same
// every time: nothing depends on the clock except the optional time limit.

import { makeRng, logAddExp, ksUniformP } from './stats.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const RANK_BINS = 32;

export class MiniNest {
  /**
   * opts.ndim
   * opts.loglike(theta: Float64Array) -> number
   * opts.transform(u: Float64Array, theta: Float64Array) -> void
   * opts.nlive (400), opts.fracRemain (0.01), opts.seed (42), opts.nboot (20)
   * opts.maxCalls (1e6): budget of likelihood calls. The run stops cleanly when it is used up.
   * opts.maxSeconds (none): wall-clock budget, counted from construction.
   * opts.method: 'auto' (default: region sampling, slice sampling when that is cheaper), 'region' or 'slice'.
   * opts.sliceSteps: slice steps per new point (default max(10, 2 ndim)).
   * opts.names, opts.labels: parameter keys and display names, used in the warnings.
   */
  constructor(opts) {
    this.d = opts.ndim;
    this.loglike = opts.loglike;
    this.transform = opts.transform;
    this.N = Math.max(opts.nlive || 400, 2 * this.d + 10);
    this.fracRemain = opts.fracRemain ?? 0.01;
    this.maxCalls = opts.maxCalls ?? 1e6;
    this.maxSeconds = opts.maxSeconds ?? Infinity;
    this.nboot = opts.nboot ?? 20;
    this.method = opts.method === 'region' || opts.method === 'slice' ? opts.method : 'auto';
    this.sliceSteps = opts.sliceSteps ?? Math.max(10, 2 * this.d);
    this.names = opts.names || null; this.labels = opts.labels || null;
    this.rng = makeRng(opts.seed ?? 42);
    const { N, d } = this;
    this.U = new Float64Array(N * d);      // live points, unit cube
    this.T = new Float64Array(N * d);      // live points, whitened
    this.X = new Float64Array(N * d);      // live points, physical
    this.L = new Float64Array(N);
    this.label = new Int32Array(N); this.ncl = 1;      // friends-of-friends group of every live point
    this.dead = { x: [], u: [], logl: [], logw: [], nl: [] };
    this.ranks = [];
    this.it = 0; this.ncalls = 0; this.logZ = -Infinity; this.H = 0; this.logX = 0; this.nplateau = 0; this.varPlateau = 0;
    this.done = false; this.mode = this.method === 'slice' ? 'slice' : 'region';
    this.winCalls = 0; this.winAcc = 0;
    // slice sampler: bracket widths adapt separately for the two kinds of direction; cost = calls per new point
    this.sliceW = [1, 1]; this.sliceCost = 3 * this.sliceSteps; this.sliceCostKnown = false;
    this.brCost = [4.5, 3];               // likelihood calls per slice step with a stepped-out bracket, and with the ellipsoid chord
    this.probeLeft = 0; this.probeTries = 0; this.probeAcc = 0;
    this.rankHist = new Float64Array(RANK_BINS); this.rankN = 0; this.regionDistrusted = false;
    this.holes = null; this.liveFrac = 0; this.liveRelVar = 0;
    this.stat = { regionIter: 0, sliceIter: 0, regionCalls: 0, sliceCalls: 0, switches: 0, restarts: 0, callsBeforeRestart: 0, maxClusters: 1, events: [] };
    this.probeSkip = 0; this._sliceUsedRegion = false;
    this.t0 = now();
    this._u = new Float64Array(d); this._t = new Float64Array(d); this._x = new Float64Array(d);
    this._cur = new Float64Array(d); this._dir = new Float64Array(d); this._cand = new Float64Array(d);
    this._init();
  }

  _init() {
    const { N, d, rng } = this;
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < d; k++) this._u[k] = rng.next();
      this.transform(this._u, this._x);
      this.U.set(this._u, i * d); this.X.set(this._x, i * d);
      this.L[i] = this.loglike(this._x); this.ncalls++;
    }
    this._buildRegion();
  }

  // ---- MLFriends region -----------------------------------------------------

  _buildRegion() {
    const { N } = this;
    if (!this._D2 || this._D2.length !== N * N) this._D2 = new Float64Array(N * N);
    const old = this.A ? { A: this.A, mean: this.mean, r2: this.r2, R2: this.R2, enlarge: this.enlarge, logVol: this.logVol } : null;
    if (old) {
      // group the live points with the metric and radius of the previous region (UltraNest: update_clusters)
      this._distances(); this._cluster();
    }
    this._metric(); this._distances(); this._bootstrap();
    // the groups may look different in the new metric (always on the first build): let them settle
    for (let pass = 0; pass < 4 && this._cluster(); pass++) { this._metric(); this._distances(); this._bootstrap(); }
    // Volume of the region in the unit cube, up to a constant: the smaller of the ellipsoid and of all the balls.
    // The contour only ever shrinks, so a region that comes out larger than the last one is an accident of the
    // bootstrap (typically the last live point of a dying mode, whose nearest neighbour is another mode: the
    // radius jumps and the modes are joined up again). Keep the previous metric and radii then; they were
    // validated on a larger contour and are still safe (UltraNest: "force shrinkage of volume").
    const { d } = this;
    let lnDet = 0; for (let k = 0; k < d; k++) lnDet += Math.log(this.A[k * d + k]);
    const logVol = lnDet + 0.5 * d * Math.min(Math.log(this.R2), Math.log(this.r2) + (2 / d) * Math.log(N));
    if (old && logVol > old.logVol) {
      this.A = old.A; this.mean = old.mean; this.r2 = old.r2; this.r = Math.sqrt(old.r2); this.enlarge = old.enlarge;
      let maxAll = 0;
      for (let i = 0; i < N; i++) { this._whiten(this.U, i * d, this.T, i * d); let q = 0; for (let k = 0; k < d; k++) q += this.T[i * d + k] ** 2; if (q > maxAll) maxAll = q; }
      this.R2 = Math.max(old.R2, maxAll); this.R = Math.sqrt(this.R2);        // slice-sampled points may lie outside the old ellipsoid
      this._distances(); this._cluster();
    } else this.logVol = logVol;
    if (this.ncl > this.stat.maxClusters) this.stat.maxClusters = this.ncl;
    this.sinceRegion = 0;
    // axis-aligned box around the region in the unit cube: every ball and the ellipsoid reach r sqrt(C_kk), R sqrt(C_kk) along axis k
    const { U, A, mean } = this;
    if (!this.boxLo) { this.boxLo = new Float64Array(d); this.boxW = new Float64Array(d); }
    for (let k = 0; k < d; k++) {
      let c = 0; for (let j = 0; j <= k; j++) c += A[k * d + j] ** 2; c = Math.sqrt(c);
      let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { const v = U[i * d + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      lo = Math.max(0, lo - this.r * c, mean[k] - this.R * c); hi = Math.min(1, hi + this.r * c, mean[k] + this.R * c);
      this.boxLo[k] = lo; this.boxW[k] = hi - lo;
    }
    // Three exact ways to draw uniformly from the region (they differ only in arithmetic, not in likelihood calls):
    // from a ball around a live point, from the ellipsoid, from the box. Probe which succeeds most often.
    const okN = [0, 0, 0];
    for (let i = 0; i < 24; i++) { if (this._tryBall()) okN[0]++; if (this._trySphere()) okN[1]++; if (this._tryBox()) okN[2]++; }
    this.drawKind = okN[1] > okN[0] ? (okN[2] > okN[1] ? 2 : 1) : (okN[2] > okN[0] ? 2 : 0);
  }

  /** Whitening matrix from the covariance of the live points about the mean of their own group. */
  _metric() {
    const { N, d, U, T, label } = this;
    let ncl = this.ncl;
    if (N - ncl < 2 * d + 2) { label.fill(0); ncl = this.ncl = 1; }          // too fragmented to estimate a covariance
    const mean = new Float64Array(d), C = new Float64Array(d * d), cm = new Float64Array(ncl * d), cnt = new Float64Array(ncl);
    for (let i = 0; i < N; i++) { const c = label[i]; cnt[c]++; for (let k = 0; k < d; k++) { mean[k] += U[i * d + k]; cm[c * d + k] += U[i * d + k]; } }
    for (let k = 0; k < d; k++) mean[k] /= N;
    for (let c = 0; c < ncl; c++) for (let k = 0; k < d; k++) cm[c * d + k] /= Math.max(cnt[c], 1);
    for (let i = 0; i < N; i++) for (let a = 0; a < d; a++) {
      const co = label[i] * d, da = U[i * d + a] - cm[co + a];
      for (let b = 0; b <= a; b++) C[a * d + b] += da * (U[i * d + b] - cm[co + b]);
    }
    for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { C[a * d + b] /= N - ncl; C[b * d + a] = C[a * d + b]; }
    const A = cholesky(C, d);
    this.mean = mean; this.A = A;
    for (let i = 0; i < N; i++) this._whiten(U, i * d, T, i * d);
  }

  /** Pairwise squared distances of the live points in the whitened space. */
  _distances() {
    const { N, d, T, _D2: D2 } = this;
    for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = 0; k < d; k++) { const dd = T[i * d + k] - T[j * d + k]; s += dd * dd; }
      D2[i * N + j] = D2[j * N + i] = s;
    }
  }

  /**
   * Bootstrap the friends radius and the ellipsoid scale: in every round a random subset of the live points
   * (drawn with replacement) has to predict where the points it left out are.
   *   radius: the largest distance from a left-out point to its nearest selected point;
   *   ellipsoid: how far the left-out points stick out of the ellipsoid of the selected ones. The ellipsoid is
   *   re-fitted (mean and covariance) to the selected points alone, so the left-out points test its shape and
   *   not only its size. With the shape taken from all points, as UltraNest does, the test is too easy when
   *   the number of dimensions is no longer small against the number of live points: the wrapping ellipsoid
   *   then clips the contour and ln Z comes out too high (+0.5 for 20 dimensions and 400 live points).
   */
  _bootstrap() {
    const { N, d, T, U, rng, label, _D2: D2 } = this, ncl = this.ncl;
    let r2 = 0, f = 1, maxAll = 0;
    for (let i = 0; i < N; i++) { let s = 0; for (let k = 0; k < d; k++) s += T[i * d + k] ** 2; if (s > maxAll) maxAll = s; }
    const cnt = new Float64Array(N), selIdx = new Int32Array(N), n2 = new Float64Array(N), cross = new Float64Array(N * this.nboot);
    let nCross = 0;
    const mean = new Float64Array(d), C = new Float64Array(d * d), cm = new Float64Array(ncl * d), cw = new Float64Array(ncl), y = new Float64Array(d);
    for (let bt = 0; bt < this.nboot; bt++) {
      cnt.fill(0);
      for (let i = 0; i < N; i++) cnt[rng.int(N)]++;
      let ns = 0;
      for (let i = 0; i < N; i++) if (cnt[i]) selIdx[ns++] = i;
      for (let j = 0; j < N; j++) {
        if (cnt[j]) continue;
        // nearest selected point of the same group; if the whole group was left out, the nearest of any group
        let best = Infinity, other = Infinity;
        const jo = j * N, lj = label[j];
        for (let q = 0; q < ns; q++) { const i = selIdx[q], v = D2[jo + i]; if (label[i] === lj) { if (v < best) best = v; } else if (v < other) other = v; }
        if (best < Infinity) { if (best > r2) r2 = best; } else if (other < Infinity) cross[nCross++] = other;
      }
      // ellipsoid of the selected points: mean, covariance about the group means, as in _metric
      mean.fill(0); C.fill(0); cm.fill(0); cw.fill(0);
      for (let q = 0; q < ns; q++) { const i = selIdx[q], w = cnt[i], c = label[i]; cw[c] += w; for (let k = 0; k < d; k++) { mean[k] += w * U[i * d + k]; cm[c * d + k] += w * U[i * d + k]; } }
      let groups = 0;
      for (let c = 0; c < ncl; c++) if (cw[c] > 0) { groups++; for (let k = 0; k < d; k++) cm[c * d + k] /= cw[c]; }
      for (let k = 0; k < d; k++) mean[k] /= N;
      for (let q = 0; q < ns; q++) { const i = selIdx[q], w = cnt[i], co = label[i] * d;
        for (let a = 0; a < d; a++) { const da = w * (U[i * d + a] - cm[co + a]); for (let b = 0; b <= a; b++) C[a * d + b] += da * (U[i * d + b] - cm[co + b]); } }
      for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { C[a * d + b] /= Math.max(1, N - groups); C[b * d + a] = C[a * d + b]; }
      const As = cholesky(C, d);
      let maxSel = 0, maxOut = 0;
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let a = 0; a < d; a++) { let v = U[i * d + a] - mean[a]; for (let k = 0; k < a; k++) v -= As[a * d + k] * y[k]; y[a] = v / As[a * d + a]; s += y[a] * y[a]; }
        // (a left-out point whose whole group was left out is skipped, as for the radius: a stray point far from
        // the rest would otherwise blow the ellipsoid up by the square of its distance)
        n2[i] = s; if (cnt[i]) { if (s > maxSel) maxSel = s; } else if (s > maxOut && cw[label[i]] > 0) maxOut = s;
      }
      if (maxSel > 0 && maxOut / maxSel > f) f = maxOut / maxSel;
    }
    // A group that was left out entirely says nothing about the radius if it is far from the others: a mode
    // down to its last live points would otherwise set the radius to the distance between modes and join them
    // up again. Its distance counts only when it is near (within twice the radius found inside the groups).
    if (!(r2 > 0)) { for (let q = 0; q < nCross; q++) if (cross[q] > r2) r2 = cross[q]; }
    else { const lim = 4 * r2; let ext = r2; for (let q = 0; q < nCross; q++) if (cross[q] <= lim && cross[q] > ext) ext = cross[q]; r2 = ext; }
    this.r2 = r2; this.r = Math.sqrt(r2);
    this.R2 = maxAll * f; this.R = Math.sqrt(this.R2); this.enlarge = f;
  }

  /** Friends-of-friends groups at the current radius. Returns true if the number of groups changed. */
  _cluster() {
    const { N, _D2: D2, r2, label } = this, before = this.ncl;
    label.fill(-1);
    const stack = new Int32Array(N);
    let ncl = 0;
    for (let s = 0; s < N; s++) {
      if (label[s] >= 0) continue;
      let top = 0; stack[top++] = s; label[s] = ncl;
      while (top) {
        const i = stack[--top], io = i * N;
        for (let j = 0; j < N; j++) if (label[j] < 0 && D2[io + j] <= r2) { label[j] = ncl; stack[top++] = j; }
      }
      ncl++;
    }
    this.ncl = ncl;
    return ncl !== before;
  }

  // t = A^-1 (u - mean)   (forward substitution)
  _whiten(src, so, dst, dof) {
    const { d, A, mean } = this;
    for (let a = 0; a < d; a++) {
      let s = src[so + a] - mean[a];
      for (let k = 0; k < a; k++) s -= A[a * d + k] * dst[dof + k];
      dst[dof + a] = s / A[a * d + a];
    }
  }
  // u = mean + A t ; returns false if outside the unit cube
  _unwhiten(t, u) {
    const { d, A, mean } = this;
    for (let a = 0; a < d; a++) {
      let s = mean[a];
      for (let k = 0; k <= a; k++) s += A[a * d + k] * t[k];
      if (!(s > 0 && s < 1)) return false;
      u[a] = s;
    }
    return true;
  }
  _friends(t) {
    const { N, d, T, r2 } = this;
    let n = 0;
    for (let i = 0; i < N; i++) {
      const io = i * d; let s = 0;
      for (let k = 0; k < d; k++) { const dd = t[k] - T[io + k]; s += dd * dd; if (s > r2) break; }
      if (s <= r2) n++;
    }
    return n;
  }
  _ballDir(t, scale) {
    const { d, rng } = this;
    let s = 0;
    for (let k = 0; k < d; k++) { t[k] = rng.normal(); s += t[k] * t[k]; }
    const f = scale * Math.pow(rng.next(), 1 / d) / Math.sqrt(s);
    for (let k = 0; k < d; k++) t[k] *= f;
  }

  // Propose from a ball around a random live point; a point covered by nf balls
  // is nf times as likely to be proposed, so keep it with probability 1/nf.
  _tryBall() {
    const { N, d, T, rng, _t: t, _u: u } = this;
    const io = rng.int(N) * d;
    this._ballDir(t, this.r);
    let s = 0;
    for (let k = 0; k < d; k++) { t[k] += T[io + k]; s += t[k] * t[k]; }
    if (s > this.R2 || !this._unwhiten(t, u)) return false;
    const nf = this._friends(t);
    return nf <= 1 || rng.next() * nf <= 1;
  }
  // Propose from the wrapping ellipsoid; keep if any live point is within r.
  _trySphere() {
    this._ballDir(this._t, this.R);
    return this._unwhiten(this._t, this._u) && this._friends(this._t) > 0;
  }

  // Propose from the box; keep if inside the ellipsoid and within r of a live point.
  _tryBox() {
    const { d, rng, _t: t, _u: u, boxLo, boxW } = this;
    for (let k = 0; k < d; k++) u[k] = boxLo[k] + boxW[k] * rng.next();
    this._whiten(u, 0, t, 0);
    let s = 0; for (let k = 0; k < d; k++) s += t[k] * t[k];
    if (s > this.R2) return false;
    for (let k = 0; k < d; k++) if (!(u[k] > 0 && u[k] < 1)) return false;
    return this._friends(t) > 0;
  }

  /** One uniform draw from (union of balls) ∩ ellipsoid ∩ unit cube, into this._u. False if none is found in maxTries proposals. */
  _drawRegion(maxTries = 100000) {
    const kind = this.drawKind;
    for (let tries = 0; tries < maxTries; tries++) {
      if (kind === 1 ? this._trySphere() : kind === 2 ? this._tryBox() : this._tryBall()) return true;
    }
    return false;
  }

  // ---- slice sampling ----------------------------------------------------------

  /**
   * A new point by slice sampling inside the likelihood contour, starting from live point `start`.
   * Each step picks a line through the current point and samples uniformly from the part of it above
   * Lmin (Neal 2003: a bracket of random position is stepped out until both ends are outside, then
   * shrunk toward the current point on every rejected draw). Outside the unit cube counts as outside
   * the contour and costs no likelihood call. The line is, with equal probability,
   *   0: the difference of two other live points of the same group (follows correlations and curved
   *      ridges without knowing the metric, as in differential evolution), or
   *   1: a random direction in the whitened space (hit-and-run; makes the chain irreducible).
   * Both choices do not depend on the current position, so every step leaves the uniform distribution
   * on the contour invariant. The bracket width of each kind adapts slowly toward one step-out and one
   * shrink per step. Returns the likelihood of the new point (in this._u, this._x), -Infinity if no
   * move was accepted, or NaN if the call budget ran out.
   */
  _drawSlice(Lmin, start) {
    const { d, N, rng, T, label, _u: u, _x: x, _cur: cur, _dir: dir, _cand: cand } = this;
    for (let k = 0; k < d; k++) cur[k] = T[start * d + k];
    let curL = this.L[start], calls = 0, out = false, usedChord = false;
    const group = this.ncl > 1 ? label[start] : -1;
    const above = (a) => {
      for (let k = 0; k < d; k++) cand[k] = cur[k] + a * dir[k];
      if (!this._unwhiten(cand, u)) return -Infinity;
      if (this.ncalls >= this.maxCalls) { out = true; return -Infinity; }
      this.transform(u, x); this.ncalls++; calls++;
      return this.loglike(x);
    };
    for (let s = 0; s < this.sliceSteps && !out; s++) {
      let kind = rng.next() < 0.5 ? 0 : 1;
      if (kind === 0) {
        // two distinct live points, of the chain's own group when the live points form several
        let a = -1, b = -1;
        for (let tries = 0; tries < 64 && b < 0; tries++) {
          const j = rng.int(N);
          if (group >= 0 && label[j] !== group && tries < 48) continue;
          if (a < 0) a = j; else if (j !== a) b = j;
        }
        if (b < 0) kind = 1;
        else for (let k = 0; k < d; k++) dir[k] = T[a * d + k] - T[b * d + k];
      }
      if (kind === 1) {
        let n = 0;
        for (let k = 0; k < d; k++) { dir[k] = rng.normal(); n += dir[k] * dir[k]; }
        n = Math.sqrt(n);
        for (let k = 0; k < d; k++) dir[k] /= n;
      }
      // The bracket. Either Neal's stepping-out, which assumes nothing, or the chord of the line inside
      // (wrapping ellipsoid ∩ unit cube), which costs no likelihood calls but trusts the ellipsoid to contain
      // the contour, as region sampling does. Whichever has needed fewer calls per step is used nine times
      // in ten; only stepping-out once the region has failed its insertion-order test.
      const before = calls;
      let lo = 0, hi = 0, chord = !this.regionDistrusted && rng.next() < (this.brCost[1] <= this.brCost[0] ? 0.9 : 0.1);
      if (chord) {
        let cc = 0, cd = 0, dd = 0;
        for (let k = 0; k < d; k++) { cc += cur[k] * cur[k]; cd += cur[k] * dir[k]; dd += dir[k] * dir[k]; }
        const disc = cd * cd - dd * (cc - this.R2);
        if (!(disc > 0 && dd > 0)) chord = false;
        else {
          const sq = Math.sqrt(disc); lo = (-cd - sq) / dd; hi = (-cd + sq) / dd;
          const A = this.A, mean = this.mean;
          for (let a = 0; a < d; a++) {
            let u0 = mean[a], g = 0;
            for (let k = 0; k <= a; k++) { u0 += A[a * d + k] * cur[k]; g += A[a * d + k] * dir[k]; }
            if (g > 0) { lo = Math.max(lo, -u0 / g); hi = Math.min(hi, (1 - u0) / g); } else if (g < 0) { lo = Math.max(lo, (1 - u0) / g); hi = Math.min(hi, -u0 / g); }
          }
          if (!(lo < 0 && hi > 0)) chord = false;
        }
      }
      let nOut = 0, nIn = 0;
      if (chord) usedChord = true;
      else {
        // stepping out, at most 40 steps in total, split at random between the two sides (keeps detailed balance)
        const w = this.sliceW[kind];
        lo = -w * rng.next(); hi = lo + w;
        let jl = Math.floor(40 * rng.next()), jr = 39 - jl;
        while (jl-- > 0 && above(lo) > Lmin) { lo -= w; nOut++; }
        while (jr-- > 0 && !out && above(hi) > Lmin) { hi += w; nOut++; }
      }
      // shrinkage
      for (let j = 0; j < 200 && !out; j++) {
        const a = lo + (hi - lo) * rng.next(), l = above(a);
        if (l > Lmin) { for (let k = 0; k < d; k++) cur[k] += a * dir[k]; curL = l; break; }
        if (a < 0) lo = a; else hi = a;
        nIn++;
      }
      if (!chord) { if (nOut > nIn) this.sliceW[kind] *= 1.03; else if (nIn > nOut) this.sliceW[kind] /= 1.03; }
      if (!out) this.brCost[chord ? 1 : 0] += 0.02 * (calls - before - this.brCost[chord ? 1 : 0]);
    }
    this._sliceUsedRegion = usedChord;
    this.stat.sliceCalls += calls;
    if (out) return NaN;
    this.sliceCost = this.sliceCostKnown ? 0.95 * this.sliceCost + 0.05 * calls : calls; this.sliceCostKnown = true;
    if (!this._unwhiten(cur, u)) return -Infinity;
    this.transform(u, x);
    return curL;
  }

  // ---- main loop ------------------------------------------------------------

  /** Run up to nIter iterations. Returns true when finished. */
  step(nIter) {
    const { N, d, L, X, U } = this;
    for (let n = 0; n < nIter && !this.done; n++) {
      let worst = 0, best = 0;
      for (let i = 1; i < N; i++) { if (L[i] < L[worst]) worst = i; if (L[i] > L[best]) best = i; }
      const Lmin = L[worst];
      // budgets are checked before a point is retired, so a stopped run keeps all its live points
      if (this.ncalls >= this.maxCalls) { this._stop('max calls reached'); break; }
      if (now() - this.t0 > 1000 * this.maxSeconds) { this._stop('time limit reached'); break; }
      // Several live points can share the lowest likelihood (e.g. every model
      // whose transit misses the data). Plain nested sampling assumes this never
      // happens and over-estimates the evidence if it does. The k tied points
      // hold a fraction k/N of the current volume: retire them together
      // (Fowlie, Handley & Su 2021), then refill.
      const tied = [];
      for (let i = 0; i < N; i++) if (L[i] === Lmin) tied.push(i);
      const k = tied.length;
      if (k === N) { this._stop('likelihood is flat over the whole prior'); break; }
      this.it++;
      let logw;
      if (k === 1) {
        // volume shrinks by exp(-1/N) per iteration; the weight is the shell removed
        logw = this.logX + Math.log1p(-Math.exp(-1 / N));
        this.logX -= 1 / N;
      } else {
        // equivalent to removing the k points one at a time without refilling:
        // ln X drops by sum_{n=N-k+1..N} 1/n; they share the removed shell equally
        let drop = 0;
        for (let m = N - k + 1; m <= N; m++) drop += 1 / m;
        logw = this.logX + Math.log1p(-Math.exp(-drop)) - Math.log(k);
        this.logX -= drop;
        this.nplateau += k;
        this.varPlateau += k / (N * (N - k)); // binomial scatter of the plateau fraction
      }
      let nl = N;
      for (const i of tied) {
        this._accumulate(Lmin, logw);
        this.dead.x.push(X.slice(i * d, i * d + d)); this.dead.u.push(U.slice(i * d, i * d + d));
        this.dead.logl.push(Lmin); this.dead.logw.push(logw); this.dead.nl.push(nl--);
      }

      // evidence still to come if every live point sat at the current maximum
      const logZrem = L[best] + this.logX;
      this.remFrac = 1 / (1 + Math.exp(this.logZ - logZrem));
      if (this.remFrac < this.fracRemain) {
        // last look at the insertion ranks: a run that fails here and can afford it starts again with slice sampling
        if (this._distrust(1e-3, true) && this.stat.restarts && this.it === 0) continue;
        // the retired points are gone; the rest are the final live points
        this.holes = tied;
        this._stop('converged'); break;
      }

      for (let q = 0; q < k; q++) {
        const why = this._replace(tied[q], Lmin, k === 1);
        if (why) { this.holes = tied.slice(q); this._stop(why); break; }       // the unreplaced points are already counted as dead
      }
      if (this.done) break;
      this.sinceRegion += k;
      if (this.sinceRegion >= Math.max(20, Math.floor(N / 5))) { this._buildRegion(); this._afterRebuild(); }
    }
    return this.done;
  }

  /** Housekeeping after each new region: is the region still to be trusted, and is region sampling worth trying again? */
  _afterRebuild() {
    // looked at after every rebuild, so the bar is high (the same test with p < 0.001 is applied once more at the end)
    if (this._distrust(1e-5)) return;
    if (this.method === 'auto' && !this.regionDistrusted && this.mode === 'slice') {
      if (this.probeSkip > 0) this.probeSkip--;
      else { this.probeLeft = 3; this.probeTries *= 0.8; this.probeAcc *= 0.8; }
    }
  }

  /**
   * Insertion ranks of all points drawn so far under the assumption that the region contains the contour
   * (binned Kolmogorov-Smirnov; binning only makes it more lenient). If they are not uniform (p below pMin)
   * the region is cutting off part of the contour, as happens in funnels: what has been accumulated is biased.
   * Then start again without the region if the budget allows, otherwise carry on with plain slice sampling.
   * Returns true if the region was given up.
   */
  _distrust(pMin, exact = false) {
    if (this.regionDistrusted || this.rankN < 600) return false;
    let p = 0;
    if (exact && this.rankN === this.ranks.length) p = ksUniformP(this.ranks);          // every point relied on the region: the unbinned test
    else {
      let D = 0, c = 0;
      for (let b = 0; b < RANK_BINS; b++) { c += this.rankHist[b]; D = Math.max(D, Math.abs(c / this.rankN - (b + 1) / RANK_BINS)); }
      const lam = (Math.sqrt(this.rankN) + 0.12 + 0.11 / Math.sqrt(this.rankN)) * D;
      for (let j = 1; j <= 100; j++) p += 2 * (j % 2 ? 1 : -1) * Math.exp(-2 * j * j * lam * lam);
    }
    if (!(p < pMin)) return false;
    this.regionDistrusted = true; this.probeLeft = 0;
    const restart = this.method !== 'region' && this.ncalls < 0.3 * this.maxCalls;
    this.stat.events.push({ it: this.it, calls: this.ncalls, what: 'region failed its insertion-order test', p, restarted: restart });
    if (this.method !== 'region') {
      if (this.mode === 'region') { this.mode = 'slice'; this.stat.switches++; }
      if (restart) this._restart();
    }
    return true;
  }

  /** Throw away the run so far and begin again from fresh prior draws (the likelihood calls spent stay counted). */
  _restart() {
    this.stat.restarts++; this.stat.callsBeforeRestart = this.ncalls; this.stat.regionIter = 0; this.stat.sliceIter = 0;
    this.dead = { x: [], u: [], logl: [], logw: [], nl: [] };
    this.ranks = []; this.rankHist.fill(0); this.rankN = 0;
    this.it = 0; this.logZ = -Infinity; this.H = 0; this.logX = 0; this.nplateau = 0; this.varPlateau = 0; this.remFrac = undefined;
    this.label.fill(0); this.ncl = 1; this.A = null; this.logVol = Infinity;
    this._init();
  }

  /**
   * Replace live point i with a prior draw of likelihood > Lmin.
   * Returns null on success, else the reason the run has to stop.
   */
  _replace(i, Lmin, recordRank) {
    const { N, d, L, U, X, T } = this;
    let newL = -Infinity, got = false, byRegion = false;
    const probing = this.mode === 'slice' && this.probeLeft > 0 && !this.regionDistrusted && this.method === 'auto';
    if (this.mode === 'region' || probing) {
      // a probe spends at most the cost of one slice-sampled point on finding out what region sampling would cost now
      const cap = probing ? Math.max(8, Math.ceil(this.sliceCost)) : Infinity;
      if (probing) this.probeLeft--;
      for (let tries = 0; tries < cap; tries++) {
        if (this.ncalls >= this.maxCalls) return 'max calls reached';
        if (!this._drawRegion(probing ? 20000 : 100000)) {
          // the region is too awkward to draw from by rejection (no likelihood involved): slice sampling instead
          if (this.method === 'region') return 'could not find a better point';
          if (probing) { this.probeLeft = 0; this.probeSkip = 5; } else { this.mode = 'slice'; this.stat.switches++; this.probeSkip = 5; }
          break;
        }
        this.transform(this._u, this._x);
        newL = this.loglike(this._x); this.ncalls++; this.stat.regionCalls++;
        if (probing) this.probeTries++; else this.winCalls++;
        if (newL > Lmin) { got = byRegion = true; break; }
        if (!probing && this.method === 'auto') {
          // Region sampling costs winCalls / winAcc calls per point. Its draws are independent and it keeps separate
          // modes in proportion, which slice sampling does not, so it is given up only when it costs three times as much.
          const need = Math.max(300, 24 * this.sliceCost);
          if (this.winCalls >= need) {
            if (this.winAcc * 3 * this.sliceCost < this.winCalls) { this.mode = 'slice'; this.stat.switches++; this.probeLeft = 0; this.probeTries = 0; this.probeAcc = 0; this.winCalls = 0; this.winAcc = 0; break; }
            this.winCalls = 0; this.winAcc = 0;
          }
        }
        if ((tries & 255) === 255 && now() - this.t0 > 1000 * this.maxSeconds) return 'time limit reached';
      }
      if (probing && got) {
        this.probeAcc++;
        // ... and taken up again when it costs less than one and a half times as much (the gap between 1.5 and 3 is the hysteresis)
        if (this.probeAcc >= 4 && this.probeTries < 1.5 * this.sliceCost * this.probeAcc) { this.mode = 'region'; this.stat.switches++; this.winCalls = 0; this.winAcc = 0; this.probeLeft = 0; }
      }
    }
    if (!got) {
      // start from a live point strictly above the threshold
      let start = -1;
      for (let tries = 0; tries < 50 * N && start < 0; tries++) { const j = this.rng.int(N); if (L[j] > Lmin) start = j; }
      if (start < 0) return 'could not find a better point';
      this._sliceUsedRegion = false;
      for (let attempt = 0; attempt < 20 && !got; attempt++) {
        newL = this._drawSlice(Lmin, start);
        if (Number.isNaN(newL)) return 'max calls reached';
        got = newL > Lmin;
      }
      if (!got) return 'could not find a better point';
    }
    if (byRegion) this._sliceUsedRegion = false;
    if (byRegion) { this.winAcc += this.mode === 'region' && !probing ? 1 : 0; this.stat.regionIter++; } else this.stat.sliceIter++;
    if (recordRank) {
      // rank of the new point among the others; points with exactly its likelihood (a plateau) are ordered at random
      let rank = 0, same = 0;
      for (let j = 0; j < N; j++) if (j !== i) { if (L[j] < newL) rank++; else if (L[j] === newL) same++; }
      const q = (rank + (same + 1) * this.rng.next()) / N;
      this.ranks.push(q);
      if (byRegion || this._sliceUsedRegion) { this.rankHist[Math.min(RANK_BINS - 1, Math.floor(q * RANK_BINS))]++; this.rankN++; }
    }
    U.set(this._u, i * d); X.set(this._x, i * d); L[i] = newL;
    this._whiten(U, i * d, T, i * d);
    // a new point joins the group of its nearest live point until the next region is built
    if (this.ncl > 1) {
      let bestJ = -1, bestS = Infinity;
      for (let j = 0; j < N; j++) { if (j === i) continue; let s = 0; for (let k = 0; k < d; k++) { const dd = T[i * d + k] - T[j * d + k]; s += dd * dd; if (s > bestS) break; } if (s < bestS) { bestS = s; bestJ = j; } }
      if (bestJ >= 0) this.label[i] = this.label[bestJ];
    }
    return null;
  }

  _stop(reason) {
    if (this.done) return;
    this.done = true; this.stopReason = reason;
    this.seconds = (now() - this.t0) / 1000;
    this._finish();
  }

  _accumulate(logl, logw) {
    const lw = logl + logw, newZ = logAddExp(this.logZ, lw);
    const p = Math.exp(lw - newZ);
    // information H = int P ln(L/Z) dX, updated incrementally (Skilling 2006)
    this.H = p * logl + (this.logZ === -Infinity ? 0 : (1 - p) * (this.H + this.logZ)) - newZ;
    this.logZ = newZ;
  }

  /** Add the remaining live points: each stands for an equal share of the volume that is left. */
  _finish() {
    const { N, d, L, X, U } = this, hole = new Uint8Array(N);
    if (this.holes) for (const i of this.holes) hole[i] = 1;
    const order = []; for (let i = 0; i < N; i++) if (!hole[i]) order.push(i);
    order.sort((a, b) => L[a] - L[b]);
    const n = order.length; if (!n) return;
    const logw = this.logX - Math.log(n), logZdead = this.logZ;
    let nl = n, Lmax = -Infinity, s1 = 0, s2 = 0;
    for (const i of order) if (L[i] > Lmax) Lmax = L[i];
    for (const i of order) {
      this._accumulate(L[i], logw);
      this.dead.x.push(X.slice(i * d, i * d + d)); this.dead.u.push(U.slice(i * d, i * d + d));
      this.dead.logl.push(L[i]); this.dead.logw.push(logw); this.dead.nl.push(nl--);
      const e = Math.exp(L[i] - Lmax); s1 += e; s2 += e * e;
    }
    // The live points are a Monte Carlo estimate of the evidence still inside the contour. For a converged
    // run that share is under fracRemain and its scatter is irrelevant; for a run stopped early it is not.
    this.liveFrac = this.logZ > -Infinity ? 1 - Math.exp(logZdead - this.logZ) : 1;
    this.liveRelVar = Math.max(0, s2 / (s1 * s1) - 1 / n);
    // Bracket of ln Z if the likelihood rose no further than the best live point: nothing more inside the
    // contour, or the whole remaining volume at that likelihood. (If the peak has not been reached, the true
    // value lies above even this.)
    this.logZrange = [logZdead, logAddExp(logZdead, Lmax + this.logX)];
  }

  /** Number of groups of live points that hold at least 5% of them (stray points do not count as a mode). */
  _groups() {
    const size = new Int32Array(this.ncl); for (let i = 0; i < this.N; i++) size[this.label[i]]++;
    let n = 0; for (let c = 0; c < this.ncl; c++) if (size[c] >= 0.05 * this.N) n++;
    return Math.max(1, n);
  }

  /** Light-weight snapshot for progress displays. */
  progress() {
    const { N, d, L } = this;
    let best = 0; for (let i = 1; i < N; i++) if (L[i] > L[best]) best = i;
    return {
      it: this.it, ncalls: this.ncalls, logZ: this.logZ, remFrac: this.remFrac ?? 1,
      eff: (this.dead.x.length) / Math.max(1, this.ncalls - N), mode: this.mode, bestL: L[best],
      best: Array.from(this.X.subarray(best * d, best * d + d)),
      live: Float64Array.from(this.X),
      // budget: calls used against the limit (0..1), and the same for the wall clock when a limit is set
      maxCalls: this.maxCalls, callsFrac: Math.min(1, this.ncalls / this.maxCalls),
      maxSeconds: Number.isFinite(this.maxSeconds) ? this.maxSeconds : null, nclusters: this._groups(),
    };
  }

  /**
   * Uncertainty of ln Z from the one thing nested sampling does not know: the
   * actual volume shrinkage at each step. With n live points the shrinkage
   * factor is Beta(n, 1) distributed, so redraw every factor, recompute Z, and
   * take the spread (Skilling 2006; the same idea as dynesty's simulate_run).
   */
  _simulateLogZ(nsim = 200) {
    const { logl, nl } = this.dead, n = logl.length;
    let Lmax = -Infinity; for (let i = 0; i < n; i++) if (logl[i] > Lmax) Lmax = logl[i];
    const el = new Float64Array(n); for (let i = 0; i < n; i++) el[i] = Math.exp(logl[i] - Lmax);
    const rng = makeRng(90210), out = new Float64Array(nsim);
    for (let s = 0; s < nsim; s++) {
      let X = 1, Z = 0;
      for (let i = 0; i < n; i++) { const Xn = X * Math.pow(rng.next(), 1 / nl[i]); Z += el[i] * (X - Xn); X = Xn; }
      out[s] = Math.log(Z) + Lmax;
    }
    let m = 0; for (const v of out) m += v; m /= nsim;
    let v = 0; for (const x of out) v += (x - m) ** 2;
    return { mean: m, std: Math.sqrt(v / (nsim - 1)) };
  }

  /**
   * Final weighted posterior and evidence. Also valid for a run that was stopped early (budget, time,
   * user): the points retired so far plus the live points are a properly weighted sample of what has
   * been explored. Then `converged` is false and `logZ` is only what has been found so far: `logZrange`
   * brackets it under the assumption that the likelihood rises no higher than the best live point, and
   * `logZerr` includes half that bracket and the scatter of the live points' share. If the peak has not
   * been reached the true ln Z is higher than all of this; `remFrac` near 1 and a small `ess` say so, and
   * then the weighted posterior is little more than the best point: `liveRange` (the box of the live points)
   * is what the fit knew.
   */
  result() {
    const n = this.dead.x.length, d = this.d, sim = this._simulateLogZ();
    const samples = new Float64Array(n * d), usamples = new Float64Array(n * d), weights = new Float64Array(n), logl = Float64Array.from(this.dead.logl);
    let imax = 0, sw = 0, sw2 = 0;
    for (let i = 0; i < n; i++) {
      samples.set(this.dead.x[i], i * d); usamples.set(this.dead.u[i], i * d);
      weights[i] = Math.exp(this.dead.logl[i] + this.dead.logw[i] - this.logZ);
      sw += weights[i]; sw2 += weights[i] ** 2;
      if (logl[i] > logl[imax]) imax = i;
    }
    const converged = this.stopReason === 'converged', st = this.stat;
    // a run stopped early does not know the evidence still inside the contour: half the bracket is added to the error
    const open = converged || !this.logZrange ? 0 : 0.5 * (this.logZrange[1] - this.logZrange[0]);
    const reached = this.stopReason === 'max calls reached' ? 'calls' : this.stopReason === 'time limit reached' ? 'time' : null;
    const res = {
      ndim: d, n, samples, weights, logl,
      logZ: this.logZ, logZerr: Math.sqrt(sim.std ** 2 + this.varPlateau + this.liveFrac ** 2 * this.liveRelVar + (Number.isFinite(open) ? open * open : 0)), logZerrInfo: Math.sqrt(Math.max(this.H, 0) / this.N), logZsim: sim.mean, H: this.H,
      ess: (sw * sw) / sw2, niter: this.it, ncalls: this.ncalls, nlive: this.N,
      maxLogL: logl[imax], maxPoint: Array.from(samples.subarray(imax * d, imax * d + d)),
      insertionP: ksUniformP(this.ranks), mode: this.mode, stopReason: this.stopReason, nplateau: this.nplateau,
      // added: how the run ended and how it went
      converged, remFrac: this.remFrac ?? 1, liveFrac: this.liveFrac, logZrange: this.logZrange ? Array.from(this.logZrange) : null,
      budget: { maxCalls: this.maxCalls, calls: this.ncalls, maxSeconds: Number.isFinite(this.maxSeconds) ? this.maxSeconds : null, seconds: this.seconds ?? (now() - this.t0) / 1000, reached },
      efficiency: this.it / Math.max(1, this.ncalls), nclusters: this._groups(), maxClusters: st.maxClusters,
      sampling: { regionIter: st.regionIter, sliceIter: st.sliceIter, regionCalls: st.regionCalls, sliceCalls: st.sliceCalls, switches: st.switches, sliceSteps: this.sliceSteps, regionAbandoned: this.regionDistrusted, restarts: st.restarts, callsBeforeRestart: st.callsBeforeRestart, events: st.events },
    };
    // range of the final live points in every parameter: for a run stopped before the peak (ess of a few) the
    // weighted posterior is one point, and this box is the honest statement of where the fit still was
    const hole = new Uint8Array(this.N); if (this.holes) for (const i of this.holes) hole[i] = 1;
    res.liveRange = Array.from({ length: d }, (_, k) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < this.N; i++) if (!hole[i]) { const v = this.X[i * d + k]; if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; });
    const diag = diagnose(res, usamples, { names: this.names, labels: this.labels });
    res.warnings = diag.warnings; res.correlations = diag.correlations; res.edges = diag.edges; res.modes = diag.modes;
    return res;
  }
}

/** Cholesky factor A (lower triangle, row-major) of a symmetric matrix C = A A^T, with a ridge if C is degenerate. */
function cholesky(C, d) {
  const A = new Float64Array(d * d);
  let ridge = 0, ok = false;
  for (let attempt = 0; attempt < 12 && !ok; attempt++) {
    ok = true; A.fill(0);
    for (let a = 0; a < d && ok; a++) for (let b = 0; b <= a; b++) {
      let s = C[a * d + b] + (a === b ? ridge : 0);
      for (let k = 0; k < b; k++) s -= A[a * d + k] * A[b * d + k];
      if (a === b) { if (!(s > 0)) { ok = false; break; } A[a * d + a] = Math.sqrt(s); }
      else A[a * d + b] = s / A[b * d + b];
    }
    if (!ok) ridge = ridge === 0 ? 1e-24 : ridge * 100;
  }
  return A;
}

// ---- diagnostics ----------------------------------------------------------------

// What to do about a strong correlation between two parameters, by registry key (planet suffixes removed).
const PAIR_ADVICE = [
  [['ars', 'inc'], 'both set the transit duration through the impact parameter: fix a/R★, let it follow from Kepler\'s law or the stellar density, or fit the transit duration and the impact parameter b instead'],
  [['per', 'tmid'], 'the reference mid-transit time is far from the middle of the data: use an epoch near the middle'],
  [['ecc', 'omega'], 'fit √e cos ω and √e sin ω instead, or fix one'],
  [['ld0', 'ld1'], 'the data cannot separate the limb-darkening coefficients: let them follow the star, or fix one'],
  [['ld1', 'ld2'], 'the data cannot separate the limb-darkening coefficients: let them follow the star, or fix one'],
  [['ld2', 'ld3'], 'the data cannot separate the limb-darkening coefficients: let them follow the star, or fix one'],
  [['mplanet', 'mstar'], 'the velocities measure Mp / M★^(2/3): give M★ a prior from the star, or fix it'],
  [['mstar', 'rstar'], 'the transit measures the stellar density M★ / R★³: give one of them a prior from the star, or fix it'],
  [['inc', 'rstar'], 'both set the transit duration: give R★ a prior from the star, or fix it'],
  [['inc', 'mstar'], 'both set the transit duration: give M★ a prior from the star, or fix it'],
];
const baseKey = (k) => String(k).split('@')[0];
function weightedOrder(col, w) {
  const n = col.length, idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => col[a] - col[b]);
  return idx;
}

/**
 * Plain-language warnings about a finished run. `res` is a MiniNest result, `usamples` the same points in the
 * unit cube (n x ndim), opts.names / opts.labels the parameter keys and display names.
 * Returns { warnings: [string], correlations: [{ i, j, r, rank }], edges: [{ i, side }], modes: [{ i, peaks: [{ at, weight }] }] }.
 */
export function diagnose(res, usamples, opts = {}) {
  const d = res.ndim, n = res.n, w = res.weights, x = res.samples, warnings = [], correlations = [], edges = [], modes = [];
  const name = (k) => (opts.labels && opts.labels[k]) || (opts.names && opts.names[k]) || 'parameter ' + (k + 1);
  const key = (k) => (opts.names ? baseKey(opts.names[k]) : '');
  const pct = (v) => (v >= 0.1 ? (100 * v).toFixed(0) : v >= 0.01 ? (100 * v).toFixed(1) : (100 * v).toPrecision(1)) + '%';

  // 1. how the run ended
  const eff = res.efficiency, slice = res.sampling ? res.sampling.sliceIter / Math.max(1, res.niter) : 0;
  if (!res.converged) {
    const why = res.stopReason === 'max calls reached' ? `the budget of ${res.budget.maxCalls.toLocaleString('en-US')} likelihood calls was used up`
      : res.stopReason === 'time limit reached' ? `the time limit of ${res.budget.maxSeconds} s was reached` : res.stopReason === 'stopped by user' ? 'it was stopped' : res.stopReason;
    warnings.push(`Not converged: ${why} with ${pct(Math.min(1, res.remFrac))} of the evidence possibly still inside the live points. `
      + `The posterior is a weighted sample of what was explored (${Math.round(res.ess)} effective samples)${res.ess < 100 ? ': too few to trust the widths, the fit had not reached the peak' : ' and may still narrow or move'}; ln Z is what was found so far, in practice a lower limit, not to be used for comparing models.`);
  }
  // 2. efficiency
  if (res.niter > 200 && eff < 0.01) {
    warnings.push(`Sampling was inefficient: ${pct(eff)} of the likelihood calls gave a new point` + (slice > 0.05 ? ` (${pct(slice)} of the points came from slice sampling)` : '')
      + '. Strong correlations, several modes or very wide priors cause this; the warnings below and narrower priors on well-known parameters help.');
  }
  if (res.sampling && res.sampling.regionAbandoned) {
    warnings.push('The bounding region failed its insertion-order test during the run (it was cutting off part of the posterior, as happens with funnel shapes). '
      + (res.sampling.restarts ? `The run was started again with plain slice sampling; ${res.sampling.callsBeforeRestart.toLocaleString('en-US')} calls went into the first attempt.`
        : 'Plain slice sampling took over from there, but ln Z and the posterior tails may carry a bias from the first part of the run.'));
  }
  if (res.converged && slice > 0.5) warnings.push(`Most points (${pct(slice)}) were drawn by slice sampling, because region sampling was too slow here. Such runs scatter more in ln Z than the quoted error (up to about twice for thin, curved posteriors), and the balance between separate arms or modes of the posterior is less certain.`);
  if (res.insertionP < 1e-3) warnings.push(`The insertion-order test fails (p = ${res.insertionP.toPrecision(1)}): new points were not spread evenly inside the likelihood contour, so ln Z and the posterior tails are unreliable. More live points, or a parameterisation without a funnel or sharp bend, help.`);
  if (res.converged && res.ess < 150) warnings.push(`Only ${Math.round(res.ess)} effective posterior samples: the credible intervals are rough. Run with more live points.`);
  if (n < 20 || !(res.logZ > -Infinity)) return { warnings, correlations, edges, modes };

  // weighted mean, sd and quantiles of every parameter, in the unit cube and in physical units
  let sw = 0; for (let i = 0; i < n; i++) sw += w[i];
  const mean = new Float64Array(d), sd = new Float64Array(d), col = new Float64Array(n), ucol = new Float64Array(n);
  for (let k = 0; k < d; k++) { let m = 0; for (let i = 0; i < n; i++) m += w[i] * x[i * d + k]; mean[k] = m / sw; let v = 0; for (let i = 0; i < n; i++) v += w[i] * (x[i * d + k] - mean[k]) ** 2; sd[k] = Math.sqrt(v / sw); }

  // 3. prior edges and 5. separate peaks, parameter by parameter in the unit cube
  const B = Math.max(8, Math.min(64, Math.round(res.ess / 25))), hist = new Float64Array(B), flat = [];
  for (let k = 0; k < d; k++) {
    for (let i = 0; i < n; i++) { ucol[i] = usamples[i * d + k]; col[i] = x[i * d + k]; }
    const idx = weightedOrder(ucol, w), q = (p) => { let acc = 0; for (let j = 0; j < n; j++) { acc += w[idx[j]]; if (acc >= p * sw) return ucol[idx[j]]; } return ucol[idx[n - 1]]; };
    const u16 = q(0.16), u84 = q(0.84), u001 = q(0.001), u999 = q(0.999), width = Math.max(u84 - u16, 1e-12);
    // density at each prior edge against the mean density of the central 68%
    const h = Math.min(0.05, 0.1 * width), ref = 0.68 / width; let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) { if (ucol[i] < h) lo += w[i]; else if (ucol[i] > 1 - h) hi += w[i]; }
    const pileLo = lo / sw / h > 0.3 * ref, pileHi = hi / sw / h > 0.3 * ref;
    if (pileLo && pileHi) { edges.push({ i: k, side: 'both' }); flat.push(name(k)); }
    else if (pileLo || pileHi) {
      edges.push({ i: k, side: pileLo ? 'lower' : 'upper' });
      warnings.push(`The posterior of ${name(k)} runs into the ${pileLo ? 'lower' : 'upper'} edge of its prior. That is fine if the edge is physical (i = 90°, zero jitter or mass: read the result as a limit); otherwise widen the prior.`);
    }
    // islands of probability separated by empty stretches
    if (u999 - u001 > 0) {
      hist.fill(0); const sc = B / (u999 - u001);
      for (let i = 0; i < n; i++) { const b = Math.floor((ucol[i] - u001) * sc); if (b >= 0 && b < B) hist[b] += w[i] / sw; }
      const peaks = []; let cur = null, gap = 3;
      for (let b = 0; b < B; b++) {
        if (hist[b] > 1e-4) { if (!cur || gap >= 3) { cur = { b0: b, b1: b, weight: 0 }; peaks.push(cur); } cur.b1 = b; cur.weight += hist[b]; gap = 0; } else gap++;
      }
      const big = peaks.filter((p) => p.weight > 0.01);
      if (big.length > 1) {
        for (const p of big) { const a = u001 + p.b0 / sc, b2 = u001 + (p.b1 + 1) / sc; let m = 0, ws = 0; for (let i = 0; i < n; i++) if (ucol[i] >= a && ucol[i] < b2) { m += w[i] * col[i]; ws += w[i]; } p.at = m / ws; }
        big.sort((a, b) => b.weight - a.weight);
        modes.push({ i: k, peaks: big.map((p) => ({ at: p.at, weight: p.weight })) });
      }
    }
  }
  if (flat.length) warnings.splice(warnings.length - edges.filter((e) => e.side !== 'both').length, 0, flat.length === 1 ? `${flat[0]} is not constrained by the data: its posterior is its prior. Fix it, or keep in mind that its error bar is the prior's.`
    : `${flat.length} parameters are not constrained by the data (their posteriors are their priors): ${flat.join(', ')}. Fix them, or keep in mind that their error bars are the priors'; each one costs likelihood calls without adding information.`);
  if (modes.length) {
    const m = modes.reduce((a, b) => (b.peaks.length > a.peaks.length ? b : a)), digits = (v) => Number(v.toPrecision(6));
    warnings.push(`The posterior has ${m.peaks.length} separate peaks in ${name(m.i)}: ${m.peaks.slice(0, 5).map((p) => `${digits(p.at)} (${pct(p.weight)})`).join(', ')}${m.peaks.length > 5 ? ', …' : ''}. `
      + 'Means and error bars over all of them describe none of them: narrow the prior to one peak, or report them separately.'
      + (slice > 0.3 ? ' Their relative weights are uncertain, because most points came from slice sampling, which does not move between peaks.' : ''));
  } else if (res.nclusters > 1 && res.converged) {
    warnings.push(`The live points ended in ${res.nclusters} separate groups: the posterior may have more than one mode. Look at the corner plot.`);
  }

  // 4. correlations: Pearson, and Spearman (rank) on an equal-weight resample to catch curved degeneracies
  if (d > 1) {
    const M = Math.min(2000, Math.max(200, Math.round(res.ess))), pick = new Int32Array(M), rnk = [];
    { let acc = w[0], j = 0; const stepW = sw / M; let uu = 0.5 * stepW; for (let i = 0; i < M; i++) { while (acc < uu && j < n - 1) acc += w[++j]; pick[i] = j; uu += stepW; } }
    for (let k = 0; k < d; k++) {
      const v = new Float64Array(M); for (let i = 0; i < M; i++) v[i] = x[pick[i] * d + k];
      const o = weightedOrder(v), r = new Float64Array(M);
      for (let a = 0; a < M;) { let b = a; while (b + 1 < M && v[o[b + 1]] === v[o[a]]) b++; for (let c = a; c <= b; c++) r[o[c]] = (a + b) / 2; a = b + 1; }   // ties share a rank
      rnk.push(r);
    }
    const pairs = [];
    for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) {
      if (!(sd[a] > 0 && sd[b] > 0)) continue;
      let c = 0; for (let i = 0; i < n; i++) c += w[i] * (x[i * d + a] - mean[a]) * (x[i * d + b] - mean[b]);
      const r = c / sw / (sd[a] * sd[b]);
      let sa = 0, sb = 0, sab = 0; const m0 = (M - 1) / 2;
      for (let i = 0; i < M; i++) { const da = rnk[a][i] - m0, db = rnk[b][i] - m0; sa += da * da; sb += db * db; sab += da * db; }
      const rank = sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : 0;
      if (Math.max(Math.abs(r), Math.abs(rank)) >= 0.95) pairs.push({ i: a, j: b, r, rank });
    }
    pairs.sort((p, q2) => Math.max(Math.abs(q2.r), Math.abs(q2.rank)) - Math.max(Math.abs(p.r), Math.abs(p.rank)));
    for (const p of pairs.slice(0, 3)) {
      correlations.push(p);
      const ka = key(p.i), kb = key(p.j), adv = PAIR_ADVICE.find(([[a, b]]) => (a === ka && b === kb) || (a === kb && b === ka));
      const v = Math.abs(p.r) >= Math.abs(p.rank) ? p.r : p.rank;
      warnings.push(`${name(p.i)} and ${name(p.j)} are ${v.toFixed(Math.abs(v) > 0.995 ? 3 : 2)} correlated${Math.abs(p.r) < 0.9 ? ' along a curve' : ''}: ${adv ? adv[1] : 'the data constrain a combination of the two. Fix one, give one a tighter prior, or fit the combination'}.`);
    }
    if (pairs.length > 3) warnings.push(`${pairs.length - 3} more pair${pairs.length > 4 ? 's' : ''} of parameters are correlated above 0.95: ${pairs.slice(3, 9).map((p) => `${name(p.i)} and ${name(p.j)}`).join('; ')}${pairs.length > 9 ? '; …' : ''}.`);
  }
  return { warnings, correlations, edges, modes };
}
