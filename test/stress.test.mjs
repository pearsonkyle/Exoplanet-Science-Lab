// Stress suite for the nested sampler: problems with known answers that probe the ways a fit goes wrong
// (strong correlations, curved ridges, the a/R* - inclination degeneracy, period aliases, narrow posteriors
// in wide priors, plateaus and walls, funnels, many parameters, HD 80606 b with wide priors).
//
//   node test/stress.test.mjs                 fast subset: 16 problems and the budget / warning checks (about 30 s)
//   STRESS=full node test/stress.test.mjs     everything: 47 problems (about 5 minutes; the HD 80606 and 17-parameter fits dominate)
//   STRESS_ONLY='a-gauss|d-' ...              only problems whose id matches the regular expression
//   STRESS_JSON=out.json ...                  also write the table as JSON
//   STRESS_SAMPLER=/path/to/nested.js ...     run another copy of the sampler (before / after comparisons)
//   STRESS_METHOD=slice|region ...            force one way of drawing points (default: the sampler decides)
//   STRESS_NLIVE=400  STRESS_MAXCALLS=1e6  STRESS_SEED=1
// References: analytic or one-dimensional quadrature in stress_problems.mjs; brute-force quadrature for the
// transit and eccentricity problems and UltraNest runs for HD 80606 b in stress_reference.json
// (make_stress_reference.mjs); UltraNest's call counts and ln Z on the same likelihoods in
// stress_ultranest.json (stress_ultranest.py, which calls the JavaScript likelihood through stress_like_server.mjs).
//
// For every problem: likelihood calls, wall time, efficiency, ln Z against the truth, posterior means,
// widths and correlations against the truth, mode weights, the insertion-order p-value, and whether the
// run said anything about its own trouble (stop reason, warnings). A failure the run did not flag is
// printed as SILENT: those are the ones that matter.
import { writeFileSync } from 'node:fs';
import { problems } from './stress_problems.mjs';
import { weightedMeanStd } from '../src/core/stats.js';

const env = process.env, FULL = env.STRESS === 'full', ONLY = env.STRESS_ONLY ? new RegExp(env.STRESS_ONLY) : null;
const { MiniNest } = await import(env.STRESS_SAMPLER ? new URL(env.STRESS_SAMPLER, 'file://' + process.cwd() + '/').href : '../src/core/nested.js');
const NLIVE = Number(env.STRESS_NLIVE || 400), MAXCALLS = Number(env.STRESS_MAXCALLS || 1e6), SEED = Number(env.STRESS_SEED || 1), METHOD = env.STRESS_METHOD || null;

export function runProblem(P, o = {}) {
  const ns = new MiniNest({ ndim: P.ndim, loglike: P.loglike, transform: P.transform, nlive: o.nlive ?? P.nlive ?? NLIVE, seed: o.seed ?? SEED, maxCalls: o.maxCalls ?? MAXCALLS, maxSeconds: o.maxSeconds, method: o.method ?? METHOD ?? undefined, names: P.names });
  if ((o.method ?? METHOD) === 'slice' && ns.mode !== 'slice') ns.mode = 'slice';     // the original sampler has no option for this
  const t0 = performance.now();
  while (!ns.step(200));
  const r = ns.result(); r.sec = (performance.now() - t0) / 1000;
  return r;
}

/** Compare a result with the problem's truth. Returns { rows: [[what, ok, text]], ok }. */
export function judge(P, r) {
  const T = P.truth || {}, d = r.ndim, out = [], col = (k) => Float64Array.from({ length: r.n }, (_, i) => r.samples[i * d + k]);
  const stats = Array.from({ length: d }, (_, k) => weightedMeanStd(col(k), r.weights));
  let worstM = 0, worstS = 0, worstC = 0, wm = '', ws = '', wc = '';
  if (T.lnZ !== undefined) {
    // 3.5 reported sigma, with a floor (the reported error is itself an estimate) and a 0.5 ceiling on what counts as right
    const dz = r.logZ - T.lnZ, tol = Math.min(Math.max(3.5 * Math.hypot(r.logZerr, T.lnZerr || 0), 0.25), 0.8);
    out.push(['lnZ', Math.abs(dz) < tol, `lnZ ${r.logZ.toFixed(3)} ± ${r.logZerr.toFixed(3)} vs ${T.lnZ.toFixed(3)} (${dz >= 0 ? '+' : ''}${dz.toFixed(3)}, ${(dz / r.logZerr).toFixed(1)}σ)`]);
  }
  if (T.mean && T.sd) {
    for (let k = 0; k < d; k++) {
      const dm = Math.abs(stats[k][0] - T.mean[k]) / T.sd[k], ds = Math.abs(stats[k][1] / T.sd[k] - 1);
      if (dm > worstM) { worstM = dm; wm = P.names[k]; } if (ds > worstS) { worstS = ds; ws = P.names[k]; }
    }
    out.push(['mean', worstM < 0.2, `means within ${worstM.toFixed(3)} sd (${wm})`]);
    out.push(['width', worstS < 0.15, `widths within ${(100 * worstS).toFixed(1)}% (${ws})`]);
  }
  for (const [i, j, rho] of T.corr || []) {
    const a = col(i), b = col(j); let s = 0, sw = 0;
    for (let q = 0; q < r.n; q++) { s += r.weights[q] * (a[q] - stats[i][0]) * (b[q] - stats[j][0]); sw += r.weights[q]; }
    const c = s / sw / (stats[i][1] * stats[j][1]), dc = Math.abs(c - rho) / Math.max(1 - Math.abs(rho), 0.05);
    if (dc > worstC) { worstC = dc; wc = `${P.names[i]},${P.names[j]}: ${c.toFixed(4)} vs ${rho.toFixed(4)}`; }
  }
  if (T.corr && T.corr.length) out.push(['corr', worstC < 0.3, `correlations: worst ${wc}`]);
  if (T.modes) {
    const th = new Float64Array(d); let bad = '', worst = 0;
    for (const m of T.modes) {
      let w = 0; for (let q = 0; q < r.n; q++) { for (let k = 0; k < d; k++) th[k] = r.samples[q * d + k]; if (m.test(th)) w += r.weights[q]; }
      // a mode holding fraction w of the mass keeps Binomial(nlive, w) live points when it separates
      const tol = 4 * Math.sqrt((m.w * (1 - m.w)) / r.nlive) + 0.01, dev = Math.abs(w - m.w) / tol;
      if (dev > worst) { worst = dev; bad = `${m.name}: ${w.toFixed(3)} vs ${m.w.toFixed(3)}`; }
    }
    out.push(['modes', worst < 1, `${T.modes.length} mode weight${T.modes.length > 1 ? 's' : ''}: worst ${bad}`]);
  }
  if (T.injected) {
    let w = 0, wn = ''; for (let k = 0; k < d; k++) { const p = Math.abs(stats[k][0] - T.injected[k]) / stats[k][1]; if (p > w) { w = p; wn = P.names[k]; } }
    out.push(['truth', w < 4, `injected values within ${w.toFixed(1)}σ (${wn})`]);
  }
  out.push(['insertion', r.insertionP > 1e-3, `insertion-order p = ${r.insertionP.toPrecision(2)}`]);
  return { rows: out, ok: out.every((x) => x[1]), stats };
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (main) {
  const list = problems.filter((p) => (ONLY ? ONLY.test(p.id) : FULL || p.tier === 'fast'));
  console.log(`stress suite: ${list.length} problem${list.length === 1 ? '' : 's'} (${FULL ? 'full' : ONLY ? 'selected' : 'fast subset; STRESS=full for all ' + problems.length}), nlive ${NLIVE}, budget ${MAXCALLS.toExponential(0)} calls, seed ${SEED}` + (env.STRESS_SAMPLER ? `, sampler ${env.STRESS_SAMPLER}` : '') + (METHOD ? `, method ${METHOD}` : ''));
  const table = []; let nFail = 0, nSilent = 0; const tAll = performance.now();
  for (const p of list) {
    const P = p.make(); let r, j;
    try { r = runProblem(P); j = judge(P, r); } catch (err) { console.log(`FAIL  ${p.id}: threw ${err.stack || err}`); nFail++; nSilent++; table.push({ id: p.id, threw: String(err) }); continue; }
    const converged = r.converged ?? r.stopReason === 'converged', warnings = r.warnings || [];
    const flagged = !converged || warnings.some((w) => /efficien|insertion|not converged|budget|unreliable|slice sampling/i.test(w));
    const status = j.ok && converged ? 'ok    ' : j.ok ? 'ok*   ' : flagged ? 'FAIL  ' : 'SILENT';
    if (!j.ok) { nFail++; if (!flagged) nSilent++; }
    const eff = r.niter / r.ncalls;
    console.log(`${status} ${p.id.padEnd(34)} ${String(r.ncalls).padStart(8)} calls ${r.sec.toFixed(1).padStart(6)} s  eff ${(100 * eff).toFixed(2).padStart(6)}%  ${r.mode.padEnd(6)} ${r.stopReason}`);
    for (const [what, ok, text] of j.rows) console.log(`         ${ok ? '  ' : '✗ '}${text}`);
    if (P.note) console.log(`           note: ${P.note}`);
    for (const w of warnings) console.log(`           warning: ${w}`);
    table.push({ id: p.id, title: p.title, ndim: r.ndim, ncalls: r.ncalls, sec: r.sec, eff, mode: r.mode, stopReason: r.stopReason, converged, logZ: r.logZ, logZerr: r.logZerr, lnZtrue: P.truth?.lnZ ?? null, H: r.H, ess: r.ess, insertionP: r.insertionP, pass: j.ok, flagged, warnings, checks: j.rows.map(([what, ok, text]) => ({ what, ok, text })),
      mean: j.stats.map((s) => s[0]), sd: j.stats.map((s) => s[1]), names: P.names });
  }
  // ---- budget, stop and warning behaviour (always run; a few seconds) ------------------------------------
  let nBad = 0; const check = (name, cond, info = '') => { console.log((cond ? 'ok     ' : 'FAIL   ') + name + (info ? '   ' + info : '')); if (!cond) nBad++; };
  if (!env.STRESS_SAMPLER && (!ONLY || ONLY.test('behaviour'))) {
    console.log('\nbudget, stop and warnings');
    const { runFit } = await import('../src/core/fitRunner.js');
    const { transitCase, jitterCase, aliasCase } = await import('./stress_problems.mjs');
    const G = problems.find((p) => p.id === 'a-gauss-d5-r0.99').make(), full = runProblem(G, { seed: 3 });
    const sumW = (r) => r.weights.reduce((a, b) => a + b, 0);
    // (1) call budget: stops at the budget, says so, and the result is a normalised weighted sample
    for (const frac of [0.1, 0.5, 0.9]) {
      const budget = Math.round(frac * full.ncalls), r = runProblem(G, { seed: 3, maxCalls: budget }), j = judge(G, r);
      const mean = j.rows.find((x) => x[0] === 'mean')[2], width = j.rows.find((x) => x[0] === 'width')[2];
      check(`budget ${budget} calls (${Math.round(100 * frac)}% of what the run needs)`, r.stopReason === 'max calls reached' && r.converged === false && r.ncalls <= budget && r.budget.reached === 'calls' && Math.abs(sumW(r) - 1) < 1e-9 && r.n === r.logl.length && Number.isFinite(r.logZ) && Number.isFinite(r.logZerr) && r.warnings.some((w) => w.startsWith('Not converged')),
        `${r.ncalls} calls, ${r.niter} iterations, ${(100 * r.remFrac).toFixed(1)}% of the evidence possibly still in the live points, ESS ${r.ess.toFixed(0)}, lnZ ${r.logZ.toFixed(2)} ± ${r.logZerr.toFixed(2)} (final ${full.logZ.toFixed(2)}); ${mean}; ${width}`);
    }
    // a run stopped late is already close: the same run stopped at 90% of its calls against the truth
    { const r = runProblem(G, { seed: 3, maxCalls: Math.round(0.9 * full.ncalls) }), j = judge(G, r); check('stopped at 90%: means within 0.2 sd and widths within 15% of the truth', j.rows.filter((x) => x[0] === 'mean' || x[0] === 'width').every((x) => x[1])); }
    // (2) the stopped run is the converged run cut short: same seed, same first points
    { const r = runProblem(G, { seed: 3, maxCalls: Math.round(0.5 * full.ncalls) }); let same = true; for (let i = 0; i < 2000; i++) if (r.logl[i] !== full.logl[i]) same = false; check('budget does not change the run before it stops', same); }
    // (3) seeds: identical runs for one seed, different for another
    { const a = runProblem(G, { seed: 3 }), b = runProblem(G, { seed: 4 }); check('same seed, same run; other seed, other run', a.logZ === full.logZ && a.ncalls === full.ncalls && a.n === full.n && b.logZ !== full.logZ, `lnZ ${a.logZ.toFixed(6)} twice (${a.ncalls} calls), ${b.logZ.toFixed(6)} with the next seed`); }
    // (4) wall clock
    { const slow = { ...G, loglike: (x) => { let s = 0; for (let i = 0; i < 3000; i++) s += Math.sin(i + x[0]); return G.loglike(x) + 0 * s; } }, r = runProblem(slow, { maxSeconds: 0.3 });
      check('time limit', r.stopReason === 'time limit reached' && !r.converged && r.budget.reached === 'time' && r.sec < 1.5 && Math.abs(sumW(r) - 1) < 1e-9, `asked 0.3 s, stopped after ${r.sec.toFixed(2)} s and ${r.ncalls} calls`); }
    // (5) through runFit: budget from spec.sampler, progress reports calls against the budget, stop request
    { const c = transitCase(0.5, 1000, true), prog = [];
      const r = await runFit({ ...c.spec, sampler: { nlive: 400, seed: 2, maxCalls: 8000 } }, (p) => prog.push(p), () => false);
      check('runFit: spec.sampler.maxCalls', r.stopReason === 'max calls reached' && !r.converged && r.ncalls <= 8000 && r.keys.length === 4 && prog.length > 0 && prog.every((p) => p.maxCalls === 8000 && p.callsFrac >= 0 && p.callsFrac <= 1) && prog[prog.length - 1].callsFrac > 0.5, `${prog.length} progress reports, last at ${(100 * prog[prog.length - 1].callsFrac).toFixed(0)}% of the budget`);
      let n = 0; const s = await runFit({ ...c.spec, sampler: { nlive: 400, seed: 2 } }, () => n++, () => n >= 2);
      check('runFit: stop request', s.stopReason === 'stopped by user' && !s.converged && Math.abs(sumW(s) - 1) < 1e-9 && s.warnings.some((w) => w.includes('it was stopped')), `${s.ncalls} calls, ESS ${s.ess.toFixed(0)}`);
      // (6) warnings in words, with the app's parameter names
      const f = await runFit({ ...c.spec, sampler: { nlive: 400, seed: 2 } }, () => {}, () => false), w = f.warnings.find((x) => x.includes('correlated'));
      check('warning: a/R* and i', f.converged && !!w && w.startsWith('i and a/R★ are 0.9') && w.includes('impact parameter') && f.correlations.length >= 1, w);
      const f2 = await runFit({ ...transitCase(0.5, 1000, false).spec, sampler: { nlive: 400, seed: 2 } }, () => {}, () => false);
      check('no warnings on a healthy fit', f2.converged && f2.warnings.length === 0, f2.warnings.join(' | ')); }
    { const P = jitterCase(false), r = runProblem(P), w = r.warnings.find((x) => x.includes('edge'));
      check('warning: posterior against a prior edge', !!w && w.includes('jit@rv1') && w.includes('lower edge') && r.edges.length === 1, w); }
    { const P = aliasCase(0.05), r = runProblem(P), w = r.warnings.find((x) => x.includes('separate peaks'));
      check('warning: several modes', !!w && w.includes('per') && r.modes.length === 1 && r.modes[0].peaks.length >= 3 && Math.abs(r.modes[0].peaks[0].at - 3) < 1e-3, w); }
    { const P = { ndim: 3, names: ['x', 'y', 'unused'], loglike: (x) => -0.5 * ((x[0] - 0.5) ** 2 + (x[1] - 0.5) ** 2) / 1e-4, transform: (u, x) => { x[0] = u[0]; x[1] = u[1]; x[2] = u[2]; } }, r = runProblem(P), w = r.warnings.find((x) => x.includes('not constrained'));
      check('warning: a parameter the data do not constrain', !!w && w.startsWith('unused') && r.warnings.length === 1, w); }
    { const P = problems.find((p) => p.id === 'g-funnel-4d').make(), r = runProblem(P), w = r.warnings.find((x) => x.includes('insertion-order'));
      check('warning: region failed its own test (funnel)', !!w && r.sampling.regionAbandoned, w); }
    { const r = runProblem(G, { maxCalls: 300 }); check('budget below the number of live points', !r.converged && r.n === 400 && Math.abs(sumW(r) - 1) < 1e-9 && r.warnings.length >= 1, `${r.ncalls} calls, ${r.stopReason}`); }
  }
  console.log(`\n${list.length - nFail} of ${list.length} passed` + (nFail ? `, ${nFail} failed (${nSilent} without the run flagging any trouble)` : '') + ` in ${((performance.now() - tAll) / 1000).toFixed(0)} s`);
  if (env.STRESS_JSON) writeFileSync(env.STRESS_JSON, JSON.stringify(table, null, 1));
  // unflagged failures fail the suite; a failure the run itself reported (budget reached, warnings) is the designed behaviour
  process.exit(nSilent || nBad ? 1 : 0);
}
