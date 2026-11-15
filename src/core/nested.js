// MiniNest: a compact nested sampler in the spirit of UltraNest's
// ReactiveNestedSampler (Buchner 2021).
//
// What is the same as UltraNest:
//   * MLFriends region (Buchner 2016, 2019): live points are whitened with
//     their covariance, and the constrained prior is bounded by the union of
//     balls around every live point. The ball radius is found by bootstrapping
//     (leave-out cross-validation), so the region is robust rather than tuned.
//   * A wrapping ellipsoid, also bootstrapped, intersected with the balls.
//   * Uniform rejection sampling from that region inside the unit cube.
//   * Termination on the fraction of evidence left in the live points.
//   * Insertion-order test as a self-diagnostic (Buchner 2023).
// What is left out: the reactive tree (dynamic number of live points),
// clustering-aware transforms, warm starts, MPI. A slice step sampler takes
// over if region sampling becomes inefficient.
//
// The sampler is a stepper (call step(n) repeatedly) so it can run in a Web
// Worker or be time-sliced on the main thread.

import { makeRng, logAddExp, ksUniformP } from './stats.js';

export class MiniNest {
  /**
   * opts.ndim
   * opts.loglike(theta: Float64Array) -> number
   * opts.transform(u: Float64Array, theta: Float64Array) -> void
   */
  constructor(opts) {
    this.d = opts.ndim;
    this.loglike = opts.loglike;
    this.transform = opts.transform;
    this.N = Math.max(opts.nlive || 400, 2 * this.d + 10);
    this.fracRemain = opts.fracRemain ?? 0.01;
    this.maxCalls = opts.maxCalls ?? 1e6;
    this.nboot = opts.nboot ?? 20;
    this.rng = makeRng(opts.seed ?? 42);
    const { N, d } = this;
    this.U = new Float64Array(N * d);      // live points, unit cube
    this.T = new Float64Array(N * d);      // live points, whitened
    this.X = new Float64Array(N * d);      // live points, physical
    this.L = new Float64Array(N);
    this.dead = { x: [], logl: [], logw: [], nl: [] };
    this.ranks = [];
    this.it = 0; this.ncalls = 0; this.logZ = -Infinity; this.H = 0; this.logX = 0; this.nplateau = 0; this.varPlateau = 0;
    this.done = false; this.mode = 'region';
    this.winCalls = 0; this.winAcc = 0;
    this._u = new Float64Array(d); this._t = new Float64Array(d); this._x = new Float64Array(d);
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
    const { N, d, U, T, rng } = this;
    const mean = new Float64Array(d), C = new Float64Array(d * d);
    for (let i = 0; i < N; i++) for (let k = 0; k < d; k++) mean[k] += U[i * d + k];
    for (let k = 0; k < d; k++) mean[k] /= N;
    for (let i = 0; i < N; i++) for (let a = 0; a < d; a++) {
      const da = U[i * d + a] - mean[a];
      for (let b = 0; b <= a; b++) C[a * d + b] += da * (U[i * d + b] - mean[b]);
    }
    for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { C[a * d + b] /= N - 1; C[b * d + a] = C[a * d + b]; }
    // Cholesky C = A A^T, with a ridge if the live points are degenerate
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
    this.mean = mean; this.A = A;
    for (let i = 0; i < N; i++) this._whiten(U, i * d, T, i * d);

    // bootstrap the friends radius and the ellipsoid scale
    let r2 = 0, f = 1, maxAll = 0;
    const n2 = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let k = 0; k < d; k++) s += T[i * d + k] ** 2; n2[i] = s; if (s > maxAll) maxAll = s; }
    // pairwise squared distances once; every bootstrap round reuses them
    if (!this._D2 || this._D2.length !== N * N) this._D2 = new Float64Array(N * N);
    const D2 = this._D2;
    for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = 0; k < d; k++) { const dd = T[i * d + k] - T[j * d + k]; s += dd * dd; }
      D2[i * N + j] = D2[j * N + i] = s;
    }
    const sel = new Uint8Array(N), selIdx = new Int32Array(N);
    for (let bt = 0; bt < this.nboot; bt++) {
      sel.fill(0);
      for (let i = 0; i < N; i++) sel[rng.int(N)] = 1;
      let ns = 0, maxSel = 0;
      for (let i = 0; i < N; i++) if (sel[i]) { selIdx[ns++] = i; if (n2[i] > maxSel) maxSel = n2[i]; }
      for (let j = 0; j < N; j++) {
        if (sel[j]) continue;
        let best = Infinity;
        const jo = j * N;
        for (let q = 0; q < ns; q++) { const v = D2[jo + selIdx[q]]; if (v < best) best = v; }
        if (best > r2) r2 = best;
        if (maxSel > 0 && n2[j] / maxSel > f) f = n2[j] / maxSel;
      }
    }
    this.r2 = r2; this.r = Math.sqrt(r2);
    this.R2 = maxAll * f; this.R = Math.sqrt(this.R2);
    this.sinceRegion = 0;
    // Two exact ways to draw uniformly from the region; probe which is cheaper.
    let okBall = 0, okSphere = 0;
    for (let i = 0; i < 24; i++) { if (this._tryBall()) okBall++; if (this._trySphere()) okSphere++; }
    this.useSphere = okSphere > okBall;
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

  /** One uniform draw from (union of balls) ∩ ellipsoid ∩ unit cube, into this._u. */
  _drawRegion() {
    for (let tries = 0; tries < 200000; tries++) {
      if (this.useSphere ? this._trySphere() : this._tryBall()) return true;
    }
    return false;
  }

  /** Slice sampling fallback: hit-and-run in whitened space from a live point. */
  _drawSlice(Lmin, start) {
    const { d, rng, _u: u, _x: x } = this;
    const cur = new Float64Array(d), dir = new Float64Array(d), cand = new Float64Array(d);
    for (let k = 0; k < d; k++) cur[k] = this.T[start * d + k];
    let curL = this.L[start];
    const inside = (tt) => {
      if (!this._unwhiten(tt, u)) return -Infinity;
      this.transform(u, x); this.ncalls++; this.winCalls++;
      return this.loglike(x);
    };
    const nsteps = 3 * d;
    for (let s = 0; s < nsteps; s++) {
      let n = 0;
      for (let k = 0; k < d; k++) { dir[k] = rng.normal(); n += dir[k] * dir[k]; }
      n = Math.sqrt(n);
      const w = Math.max(this.r, 1e-12);
      for (let k = 0; k < d; k++) dir[k] *= w / n;
      let lo = -rng.next(), hi = lo + 1;
      // step out
      for (let j = 0; j < 12; j++) { for (let k = 0; k < d; k++) cand[k] = cur[k] + lo * dir[k]; if (inside(cand) > Lmin) lo -= 1; else break; }
      for (let j = 0; j < 12; j++) { for (let k = 0; k < d; k++) cand[k] = cur[k] + hi * dir[k]; if (inside(cand) > Lmin) hi += 1; else break; }
      // shrink
      for (let j = 0; j < 60; j++) {
        const a = lo + (hi - lo) * rng.next();
        for (let k = 0; k < d; k++) cand[k] = cur[k] + a * dir[k];
        const l = inside(cand);
        if (l > Lmin) { cur.set(cand); curL = l; break; }
        if (a < 0) lo = a; else hi = a;
      }
    }
    this._unwhiten(cur, u); this.transform(u, x);
    return curL;
  }

  // ---- main loop ------------------------------------------------------------

  /** Run up to nIter iterations. Returns true when finished. */
  step(nIter) {
    const { N, d, L, X } = this;
    for (let n = 0; n < nIter && !this.done; n++) {
      let worst = 0, best = 0;
      for (let i = 1; i < N; i++) { if (L[i] < L[worst]) worst = i; if (L[i] > L[best]) best = i; }
      const Lmin = L[worst];
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
        this.dead.x.push(X.slice(i * d, i * d + d));
        this.dead.logl.push(Lmin); this.dead.logw.push(logw); this.dead.nl.push(nl--);
      }

      // evidence still to come if every live point sat at the current maximum
      const logZrem = L[best] + this.logX;
      this.remFrac = 1 / (1 + Math.exp(this.logZ - logZrem));
      if (this.remFrac < this.fracRemain) { this._stop('converged'); break; }
      if (this.ncalls >= this.maxCalls) { this._stop('max calls reached'); break; }

      for (const i of tied) {
        if (!this._replace(i, Lmin, k === 1)) { this._stop('could not find a better point'); break; }
      }
      if (this.done) break;
      this.sinceRegion += k;
      if (this.sinceRegion >= Math.max(20, Math.floor(N / 5))) this._buildRegion();
    }
    return this.done;
  }

  // Replace live point i with a prior draw of likelihood > Lmin.
  _replace(i, Lmin, recordRank) {
    const { N, d, L, U, X, T } = this;
    let newL = -Infinity;
    if (this.mode === 'region') {
      while (true) {
        if (!this._drawRegion()) { this.mode = 'slice'; break; }
        this.transform(this._u, this._x);
        newL = this.loglike(this._x); this.ncalls++; this.winCalls++;
        if (newL > Lmin) break;
        if (this.winCalls >= 4000) {
          // region sampling has become too wasteful: hand over to slice sampling
          if (this.winAcc / this.winCalls < 0.004) { this.mode = 'slice'; break; }
          this.winCalls = 0; this.winAcc = 0;
        }
      }
    }
    if (this.mode === 'slice') {
      // start from a live point strictly above the threshold
      let start = -1;
      for (let tries = 0; tries < 50 * N && start < 0; tries++) { const j = this.rng.int(N); if (L[j] > Lmin) start = j; }
      if (start < 0) return false;
      newL = this._drawSlice(Lmin, start);
      if (!(newL > Lmin)) return false;
    }
    this.winAcc++;
    if (recordRank) {
      let rank = 0;
      for (let j = 0; j < N; j++) if (j !== i && L[j] < newL) rank++;
      this.ranks.push((rank + this.rng.next()) / N);
    }
    U.set(this._u, i * d); X.set(this._x, i * d); L[i] = newL;
    this._whiten(U, i * d, T, i * d);
    return true;
  }

  _stop(reason) {
    if (this.done) return;
    this.done = true; this.stopReason = reason;
    this._finish();
  }

  _accumulate(logl, logw) {
    const lw = logl + logw, newZ = logAddExp(this.logZ, lw);
    const p = Math.exp(lw - newZ);
    // information H = int P ln(L/Z) dX, updated incrementally (Skilling 2006)
    this.H = p * logl + (this.logZ === -Infinity ? 0 : (1 - p) * (this.H + this.logZ)) - newZ;
    this.logZ = newZ;
  }

  _finish() {
    const { N, d, L, X } = this;
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => L[a] - L[b]);
    const logw = this.logX - Math.log(N);
    let nl = N;
    for (const i of order) {
      this._accumulate(L[i], logw);
      this.dead.x.push(X.slice(i * d, i * d + d));
      this.dead.logl.push(L[i]); this.dead.logw.push(logw); this.dead.nl.push(nl--);
    }
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

  /** Final weighted posterior and evidence. */
  result() {
    const n = this.dead.x.length, d = this.d, sim = this._simulateLogZ();
    const samples = new Float64Array(n * d), weights = new Float64Array(n), logl = Float64Array.from(this.dead.logl);
    let imax = 0, sw = 0, sw2 = 0;
    for (let i = 0; i < n; i++) {
      samples.set(this.dead.x[i], i * d);
      weights[i] = Math.exp(this.dead.logl[i] + this.dead.logw[i] - this.logZ);
      sw += weights[i]; sw2 += weights[i] ** 2;
      if (logl[i] > logl[imax]) imax = i;
    }
    return {
      ndim: d, n, samples, weights, logl,
      logZ: this.logZ, logZerr: Math.sqrt(sim.std ** 2 + this.varPlateau), logZerrInfo: Math.sqrt(Math.max(this.H, 0) / this.N), logZsim: sim.mean, H: this.H,
      ess: (sw * sw) / sw2, niter: this.it, ncalls: this.ncalls, nlive: this.N,
      maxLogL: logl[imax], maxPoint: Array.from(samples.subarray(imax * d, imax * d + d)),
      insertionP: ksUniformP(this.ranks), mode: this.mode, stopReason: this.stopReason, nplateau: this.nplateau,
    };
  }
}
