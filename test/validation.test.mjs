// The Validation page's claims, asserted. Reference values (other codes, 30-digit truth) are in public/validation/*.json,
// written by tools/validation/*.py; ESL's side is recomputed here with src/validation/compute.js, the same functions the
// page calls, against the tolerances in its TOL table. Also checks the statements the page makes about other codes
// against the stored numbers, so the prose cannot outlive a regenerated reference.   node test/validation.test.mjs  (about 1 min)
import { readFileSync, statSync, readdirSync } from 'node:fs';
import * as C from '../src/validation/compute.js';
import { TOPICS } from '../src/validation/topics.js';
import { REFS, CODES } from '../src/validation/refs.js';
import { findQuote } from '../src/validation/project.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const dir = new URL('../public/validation/', import.meta.url), J = (n) => JSON.parse(readFileSync(new URL(n + '.json', dir)));
const T = J('transit'), O = J('orbit'), V = J('rv'), F = J('fits'), E = J('esl'), TOL = C.TOL, e1 = (x) => x.toExponential(1);
console.log(`references: ${T.date}; batman ${T.versions.batman}, PyTransit ${T.versions.PyTransit}, ellc ${T.versions.ellc}, PyAstronomy ${T.versions.PyAstronomy}, ${T.versions.pyaneti}, ${T.versions.EXOTIC}, radvel ${V.versions.radvel}, dynesty ${F.versions.dynesty}, UltraNest ${F.versions.ultranest}, emcee ${F.versions.emcee}`);

// ---- 1. transit light curves -------------------------------------------------------------------
{
  const all = C.transitAll(T), worst = all.reduce((a, b) => (b.esl.max > a.esl.max ? b : a));
  check(`light curves match the quadrature reference in all ${all.length} cases`, worst.esl.max < TOL.transit && all.length >= 40, `worst ${e1(worst.esl.max)} (${worst.c.label}); tolerance ${e1(TOL.transit)}`);
  check('the reference is itself verified', T.truth.kernelVsMpmath < 1e-14 && Math.max(...T.cases.filter((c) => c.stats['exoplanet-core (kernel)']).map((c) => c.stats['exoplanet-core (kernel)'].max)) < 1e-14, `scipy vs mpmath ${e1(T.truth.kernelVsMpmath)}; exoplanet-core's closed form within 1e-14 of it in every quadratic case`);
  const byLaw = (law) => Math.max(...all.filter((a) => a.c.law === law).map((a) => a.esl.max));
  check('every law and regime', ['uniform', 'linear', 'quadratic', 'nonlinear'].every((l) => byLaw(l) < TOL.transit), ['uniform', 'linear', 'quadratic', 'nonlinear'].map((l) => `${l} ${e1(byLaw(l))}`).join(', ') + `; e >= 0.9: ${e1(Math.max(...all.filter((a) => a.c.ecc > 0.9).map((a) => a.esl.max)))}; grazing or missing (b >= 0.95): ${e1(Math.max(...all.filter((a) => /b = (0\.95|1)/.test(a.c.label)).map((a) => a.esl.max)))}`);
  const better = (n) => T.cases.filter((c) => c.stats[n] && c.depth > 0).every((c, i) => all.find((a) => a.c === c).esl.max <= c.stats[n].max + 1e-15);
  check('ESL is at least as close to the reference as batman, PyTransit, ellc, pylightcurve, pyaneti and EXOTIC in every transiting case', ['batman', 'PyTransit', 'ellc', 'pylightcurve', 'pyaneti', 'EXOTIC'].every(better));
  const sp = C.specialPoints(T), w = sp.reduce((a, b) => (Math.abs(b.esl) > Math.abs(a.esl) ? b : a));
  check('kernel branch points (z = p, contacts, centre)', Math.abs(w.esl) < TOL.special, `worst ${e1(Math.abs(w.esl))} at ${w.label}, Rp/R* = ${w.p}; tolerance ${e1(TOL.special)}`);
  for (const ex of T.exposure) {
    const r = C.exposureCase(ex), n101 = r.byN.find((q) => q.ns === 101).max, n7 = r.byN.find((q) => q.ns === 7).max, pt7 = C.maxAbs(ex.codes.PyTransit['7']);
    check(`exposure averaging: ${ex.label}`, n101 < TOL.exposure101 && r.autoRun.max < TOL.exposureAuto && Math.abs(n7 / pt7 - 1) < 0.05, `n = 101: ${e1(n101)}; automatic n = ${r.auto}: ${e1(r.autoRun.max)}; n = 7: ${e1(n7)} (PyTransit ${e1(pt7)}, batman ${e1(C.maxAbs(ex.codes.batman['7']))})`);
  }
  // statements the page makes about other codes
  const st = (label, n) => T.cases.find((c) => c.label === label).stats[n]?.max, zp = (p) => Math.abs(T.special.find((q) => q.p === p && q.label === 'z = p').batman);
  check('page claim: batman is wrong at z = p (quadratic law)', zp(0.3) > 1e-3 && zp(0.1) > 1e-4 && st('Rp/R* = 0.3, quadratic', 'batman') > 1e-5, `z = p: ${e1(zp(0.05))}, ${e1(zp(0.1))}, ${e1(zp(0.3))} for Rp/R* = 0.05, 0.1, 0.3`);
  check('page claim: batman meets 1 ppm for the four-coefficient law and no better by default', T.cases.filter((c) => c.law === 'nonlinear' && c.depth > 0).every((c) => c.stats.batman.max > 2e-7 && c.stats.batman.max < 2e-6));
  const hd = T.cases.find((c) => c.label.startsWith('e = 0.93, omega = -58.7') && c.law === 'quadratic');
  check('page claim: closest approach is 11.4 min from conjunction for HD 80606 b', Math.abs(Math.abs(hd.dtMinSep) * 1440 - 11.4) < 0.05, `${(hd.dtMinSep * 1440).toFixed(2)} min; ESL's own orbit gives ${((C.minSeparationTime(hd, hd.tmid) - hd.tmid) * 1440).toFixed(2)} min`);
  check('page claim: PyTransit 1e-5 at a/R* = 2.5 and e = 0.93; PyAstronomy non-linear up to 5e-5', st('a/R* = 2.5, quadratic', 'PyTransit') > 5e-6 && st('e = 0.93, omega = 120, quadratic', 'PyTransit') > 5e-6 && st('Rp/R* = 0.3, Claret', 'PyAstronomy') > 2e-5);
  const r0 = C.timeTransit(T.timing[0], 0.5), r1 = C.timeTransit(T.timing[1], 0.5);
  check('speed is of the order stated (Node)', r0 > 1500 && r1 > 600, `${Math.round(r0)} and ${Math.round(r1)} light curves of 1000 points per second (batman: ${T.timing[0].rate.batman} and ${T.timing[1].rate.batman})`);
}

// ---- 2. orbit and timing -----------------------------------------------------------------------
{
  const k = C.keplerErrors(O), wNu = Math.max(...k.map((m) => m.dNu)), wRes = Math.max(...k.map((m) => m.resid));
  check(`Kepler's equation, e = ${O.kepler.ecc[0]} to ${O.kepler.ecc.at(-1)}`, wNu < TOL.keplerNu && wRes < TOL.keplerE, `true anomaly within ${e1(wNu)} rad, residual ${e1(wRes)}`);
  const i93 = O.kepler.ecc.indexOf(0.93);
  check('page claim: batman and pyaneti solve Kepler to about 1e-6 at e = 0.93; radvel (C) fails at e = 0.999', O.kepler.codes.batman.max[i93] > 1e-7 && (!O.kepler.codes.pyaneti || O.kepler.codes.pyaneti.max[i93] > 1e-7) && O.kepler.codes['radvel (C)'].max.at(-1) === null);
  const ev = C.eventErrors(O), wP = Math.max(...ev.map((x) => Math.abs(x.dPeri))), wE = Math.max(...ev.map((x) => Math.abs(x.dEcl)));
  check(`periastron and eclipse times, ${ev.length} orbits`, wP < TOL.eventSeconds && wE < TOL.eventSeconds, `${e1(wP)} s and ${e1(wE)} s`);
  const D = C.durationRows(O); let wD = 0, wC = 0, wM = 0;
  for (const d of D) { for (const q of ['t14', 't23', 'e14', 'e23']) wD = Math.max(wD, Math.abs(d.exact[q] - d.c.truth[q]) * 86400); wC = Math.max(wC, Math.abs(d.closed.t14 - d.c.truth.t14) / d.c.truth.t14); wM = Math.max(wM, Math.abs(d.dtMinSep - d.c.truth.dtMinSep) * 86400); }
  check(`durations T14, T23, E14, E23 by bisection, ${D.length} orbits`, wD < TOL.durationSeconds, `largest error ${e1(wD)} s`);
  check('closed-form duration is exact for circular orbits and within 1% otherwise (known limitation)', wC < 0.01 && D.filter((d) => !d.c.ecc).every((d) => Math.abs(d.closed.t14 - d.c.truth.t14) < 1e-9), `largest relative error ${(100 * wC).toFixed(2)}%`);
  check('time of closest approach from ESL\'s orbit', wM < 1e-2, `largest error ${e1(wM)} s`);
  const hd = D.find((d) => d.c.label.startsWith('HD 80606'));
  check('HD 80606 b: eclipse duration agrees with the 30-digit orbit, not with the published value', Math.abs(hd.exact.e14 - hd.c.truth.e14) < 1e-8 && Math.abs(hd.exact.e14 - O.published.e14) > 0.01 && Math.abs(hd.exact.t14 - O.published.t14) < 1e-3, `E14 ${hd.exact.e14.toFixed(5)} d (reference ${hd.c.truth.e14.toFixed(5)}, published ${O.published.e14}); T14 ${hd.exact.t14.toFixed(4)} d (published ${O.published.t14})`);
}

// ---- 3. radial velocities ----------------------------------------------------------------------
{
  const R = V.cases.map((c) => ({ c, r: C.rvCase(c) })), w = Math.max(...R.map((x) => x.r.max));
  check(`velocity curves, ${R.length} orbits up to e = 0.93`, w < TOL.rv, `worst ${e1(w)} K; reference formula vs differentiated geometry ${e1(Math.max(...V.cases.map((c) => c.geometryVsFormula)))} K`);
  check('sign: the star recedes (+K) a quarter period before the transit of a circular orbit, as in radvel, pyaneti and EXOTIC', Math.abs(R[0].r.quarter - 1) < 1e-12 && ['radvel', 'pyaneti', 'EXOTIC'].every((n) => V.cases[0].quarterBefore[n] === undefined || Math.abs(V.cases[0].quarterBefore[n] - 1) < 1e-3));
  check('omega: same number as radvel\'s and pyaneti\'s, and a 180 deg shift would be an error of order K', V.cases.every((c) => C.maxAbs(c.codes.radvel) / c.K < 1e-11 && (!c.codes.pyaneti || C.maxAbs(c.codes.pyaneti) / c.K < 1e-5)) && V.cases.filter((c) => c.ecc).every((c) => c.wrong['radvel, omega + 180 deg'] > 1));
  check('EXOTIC agrees after its m_p/M* factor: 2e-4 K as shipped, 1e-8 K with a finer centred difference', V.cases.every((c) => !c.codes.EXOTIC || (C.maxAbs(c.codes.EXOTIC) / c.K < 3e-4 && C.maxAbs(c.codes['EXOTIC (finer step)']) / c.K < 1e-8)));
  const A = C.amplitudeRows(V), wa = Math.max(...A.map((a) => Math.abs(a.rel)));
  check('semi-amplitude from masses', wa < TOL.amplitude, `largest relative difference ${e1(wa)} (radvel: ${e1(Math.max(...V.amplitude.map((r) => Math.abs(r.codes['radvel.utils.semi_amplitude'] / r.truth - 1))))})`);
}

// ---- 4. parameter recovery ---------------------------------------------------------------------
{
  const dl = F.problems.flatMap((P) => C.lnLCheck(P)), wl = Math.max(...dl.map(Math.abs));
  check('ln L equals the independent Python likelihood (exoplanet-core / radvel models)', wl < TOL.lnL, `largest difference ${e1(wl)} over ${dl.length} points`);
  for (const P of F.problems) {
    const S = await C.runProblem(P), cmp = C.compareFit(P, S);
    check(`fit ${P.id}: posterior and ln Z against ${cmp.refName}, dynesty and UltraNest`, cmp.ok, cmp.rows.map((r) => `${r.key} ${r.dMean.toFixed(2)}σ ${(100 * r.dWidth).toFixed(1)}%`).join(', ') + ' | ln Z ' + cmp.lnZ.map((z) => `${z.name} ${z.diff.toFixed(2)} (${z.sigma.toFixed(1)}σ)`).join(', ') + ` | ${S.ncalls} calls`);
    const em = P.samplers.emcee; let we = 0; P.keys.forEach((_, i) => (we = Math.max(we, Math.abs(S.mean[i] - em.mean[i]) / em.std[i], Math.abs(S.std[i] / em.std[i] - 1))));
    check(`fit ${P.id}: against emcee`, we < TOL.fitMean, `largest of mean shift [σ] and relative width difference ${we.toFixed(3)}`);
    if (E.fits?.[P.id]) check(`fit ${P.id}: the stored run the page shows first is within tolerance too`, C.compareFit(P, E.fits[P.id]).ok);
    if (E.seeds?.[P.id]) { const sd = E.seeds[P.id], ref = P.analytic ? P.analytic.logZ : P.samplers.dynesty.logZ; check(`fit ${P.id}: ln Z over 8 seeds is unbiased and its error honest`, Math.abs(sd.mean - ref) < 0.3 && sd.sd < 2.5 * sd.logZerr[0] && sd.sd > 0.3 * sd.logZerr[0], `mean ${sd.mean.toFixed(3)} vs ${ref.toFixed(3)}; scatter ${sd.sd.toFixed(3)}, reported ${sd.logZerr[0].toFixed(3)}`); }
  }
  for (const kind of Object.keys(C.COVERAGE)) {
    const cv = E.coverage?.[kind]; if (!cv) { check(`coverage (${kind}) stored`, false, 'run node tools/validation/esl_reference.mjs'); continue; }
    const sum = C.coverageSummary(kind, cv.ranks);
    check(`coverage, stored ${cv.ranks.length} trials: ${C.COVERAGE[kind].label}`, cv.ranks.length >= 300 && sum.every((q) => q.c68 > TOL.coverage68[0] && q.c68 < TOL.coverage68[1] && q.c95 > 0.91 && q.c95 < 0.99), sum.map((q) => `${q.key} ${(100 * q.c68).toFixed(1)}% / ${(100 * q.c95).toFixed(1)}%`).join(', '));
    // a fresh sample of trials: the current sampler must be calibrated too (the stored ranks may predate a change to it)
    const n = 24, ranks = []; for (let i = 0; i < n; i++) ranks.push((await C.coverageRun(kind, i)).rank);
    const pooled = ranks.flat(), c68 = pooled.filter((x) => x > 0.15865 && x < 0.84135).length / pooled.length; let d = 0; ranks.forEach((r, i) => r.forEach((x, k) => (d = Math.max(d, Math.abs(x - cv.ranks[i][k])))));
    check(`coverage, ${n} trials rerun now`, c68 > 0.5 && c68 < 0.86, `${(100 * c68).toFixed(0)}% of ${pooled.length} parameter draws inside 68%; largest change of a rank from the stored run ${d.toFixed(3)}`);
  }
}

// ---- 5. section 5 of the page: the stored outcome of the project's other tests, and housekeeping ----------------
{
  // The page shows the printed output of the other test files as stored in project.json. Asserted here: the record is
  // complete, every number the page quotes (topics.js) is in it, nothing failed that the page does not say failed, the
  // bibliography is consistent, and the scripts the page links to are identical to the originals.
  const P = J('project'), done = TOPICS.filter((t) => t.status === 'done');
  const missing = done.flatMap((t) => t.tests.filter((f) => !P.tests[f])), exits = Object.entries(P.tests).filter(([, x]) => x.exit !== 0).map(([f]) => f);
  const nChecks = Object.values(P.tests).reduce((a, x) => a + x.checks.length, 0);
  check('stored output of the project\'s other tests is complete and every file exited 0', !missing.length && !exits.length && nChecks > 300, `${nChecks} printed checks in ${Object.keys(P.tests).length} files, stored ${P.date}` + (missing.length ? `; missing: ${missing.join(', ')} (run node tools/validation/project_reference.mjs)` : '') + (exits.length ? `; non-zero exit: ${exits.join(', ')}` : ''));
  const stale = [];
  for (const t of done) for (const r of t.rows) { const q = findQuote(P.tests, t, r); if (!q) stale.push(`${t.id}: no check named "${r.check}"`); else if (!q.ok) stale.push(`${t.id}: "${r.quote}" is not in "${q.c.name}   ${q.c.info}"`); else if (!q.c.ok !== !!r.failing) stale.push(`${t.id}: "${r.check}" is ${q.c.ok ? 'ok' : 'FAIL'} in the stored output but the page says otherwise`); }
  check('every number quoted in section 5 is in the stored output', !stale.length, stale.length ? stale.join(' | ').slice(0, 900) : `${done.reduce((a, t) => a + t.rows.length, 0)} quotes in ${done.length} topics`);
  const flagged = new Set(done.flatMap((t) => t.rows.filter((r) => r.failing).map((r) => r.check)));
  const fails = Object.entries(P.tests).flatMap(([f, x]) => x.checks.filter((c) => !c.ok).map((c) => `${f}: ${c.name}`)), unsaid = fails.filter((x) => ![...flagged].some((k) => x.includes(k)));
  check('no stored check fails without the page saying so', !unsaid.length, fails.length ? `${fails.length} not passed, reported on the page: ${fails.join('; ')}` + (unsaid.length ? ` | NOT reported: ${unsaid.join('; ')}` : '') : 'none failed');
  const badRefs = [...TOPICS.flatMap((t) => (t.refs || []).filter((k) => !REFS[k]).map((k) => `${t.id}: reference ${k}`)), ...TOPICS.flatMap((t) => (t.against || []).filter((k) => !CODES[k]).map((k) => `${t.id}: code ${k}`)),
    ...Object.entries(CODES).flatMap(([k, c]) => c.cite.filter((r) => !REFS[r]).map((r) => `${k}: reference ${r}`)), ...Object.entries(REFS).filter(([, r]) => !(r.doi || r.arxiv || r.url) || !r.authors || !r.where).map(([k]) => `${k}: incomplete`),
    ...TOPICS.filter((t) => !t.title || !t.purpose || (t.status === 'done' && (!t.headline || !t.tests?.length))).map((t) => `${t.id}: incomplete topic`)];
  check('bibliography and topic descriptions are consistent', !badRefs.length, badRefs.length ? badRefs.join('; ') : `${Object.keys(REFS).length} references, ${Object.keys(CODES).length} codes, ${TOPICS.length} topics (${TOPICS.length - done.length} planned)`);
  const root = new URL('../', import.meta.url), differ = (P.scripts || []).filter((f) => { try { return !readFileSync(new URL(f, root)).equals(readFileSync(new URL('scripts/' + f, dir))); } catch { return true; } });
  check('scripts mirrored for the page\'s links are identical to the originals', (P.scripts || []).length > 20 && !differ.length, differ.length ? `out of date: ${differ.join(', ')} (run node tools/validation/project_reference.mjs)` : `${P.scripts.length} files in public/validation/scripts/`);
  const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((a, f) => a + (f.isDirectory() ? size(new URL(f.name + '/', d)) : statSync(new URL(f.name, d)).size), 0), bytes = size(dir);
  check('public/validation stays under 3 MB', bytes < 3e6, `${(bytes / 1e6).toFixed(2)} MB`);
}
process.exit(ok ? 0 : 1);
