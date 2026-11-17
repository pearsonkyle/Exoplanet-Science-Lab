// The "Dynamics" block of the Timing tab: planets that pull on each other (src/core/nbody.js).
//   - a switch that makes fits of mid-transit times and velocities use an N-body integration,
//   - the observed O - C of every planet against the integration at the current parameters, with the stability checks,
//   - a search for an unseen companion: a grid of simulations over its mass and period, run in a pool of workers.
// buildDynamics(el, app) appends to el. app: { S, h, pushUndo, flash, rebuild, label(), planets() -> [{ sfx, letter, per, tmid,
//   ecc, omega, inc, mplanet }], star() -> { mstar, rstar }, setNbody(null | { epoch }), addCompanion({...}), theme }
// Times here are days relative to S.data.tRef, like every parameter of the analyzer.

import { startJob } from '../site/jobs.js';
import { buildCompanionExplorer } from './companionExplorer.js';
import { nbody, dynamicalModel, stabilityReport, ttvGridPrepare, ttvGridCell, ttvGridAssemble, ttvGridRefine } from '../core/nbody.js';
import { renderNbodyOC, renderGridMap } from './nbodyplot.js';

const cache = { key: '', grid: null, refined: null, busy: false, msg: '' };

function fitCanvas(cv, draw) {
  // drawn whenever the canvas gets a size: the tab may be hidden when it is built
  const paint = () => { const W = cv.clientWidth, H = cv.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2); if (!W || !H) return; cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); draw(c, W, H); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(paint).observe(cv); else requestAnimationFrame(paint);
}
/** Weighted straight line t = a + b E. */
function lineFit(E, t, e) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < E.length; i++) { const w = 1 / (e[i] * e[i]); sw += w; sx += w * E[i]; sy += w * t[i]; sxx += w * E[i] * E[i]; sxy += w * E[i] * t[i]; }
  const det = sw * sxx - sx * sx; if (!(det > 0)) return { a: t[0], b: 0 };
  return { a: (sxx * sy - sx * sxy) / det, b: (sw * sxy - sx * sy) / det };
}
/** The earliest datum the integration has to reach, for the reference epoch: half an orbit before the first time. */
export function dynamicsEpoch(S, planets) {
  const tRef = S.data.tRef || 0; let t0 = Infinity;
  for (const r of S.timing.rows) t0 = Math.min(t0, r.t - tRef);
  for (const d of S.rv) for (let i = 0; i < d.t.length; i++) t0 = Math.min(t0, d.t[i]);
  if (!Number.isFinite(t0)) t0 = Math.min(...planets.map((p) => p.tmid));
  return t0 - 0.5 * Math.min(...planets.map((p) => p.per));
}

/**
 * Starting parameters for a dynamical fit from a polished grid solution. The grid uses the planet's mean period as its
 * osculating one and absorbs the mismatch in a straight line; a likelihood without that line needs the elements
 * themselves. Rescaling time (both periods by one factor, about the epoch) and shifting it leaves the shape of the O - C
 * as it is, so a few rounds of "match the mean period, then the mean residual" give them.
 * obs: { t, e }, base: as for ttvGrid, rf: ttvGridRefine result. Returns { host: { per, tmid }, comp: { per, tmid, mplanet }, epoch, chi2 }.
 */
export function companionStart(obs, base, rf) {
  const prep = ttvGridPrepare(obs, base, {});
  let epoch = prep.epoch, hp = base.planet.per, ht = prep.tmid0, cp = rf.period, ct = prep.epoch + rf.phase * rf.period, chi2 = Infinity;
  const run = () => dynamicalModel({ mstar: base.mstar, rstar: base.rstar, epoch, planets: [{ ...base.planet, per: hp, tmid: ht }, { ecc: 0, omega: 0, inc: base.planet.inc, ...(base.perturber || {}), per: cp, tmid: ct, mplanet: rf.mass }] }, { timing: [{ planet: 0, t: obs.t }], event: 'conjunction' });
  for (let it = 0; it < 6; it++) {
    const d = run(); if (!d.ok) break;
    const E = Array.from(d.timing[0].epoch), m = Array.from(d.timing[0].model), lo = lineFit(E, obs.t, obs.e), lm = lineFit(E, m, obs.e);
    // time dilation about the epoch so that the simulated mean period becomes the observed one
    const k = lo.b / lm.b; hp *= k; cp *= k; ht = epoch + (ht - epoch) * k; ct = epoch + (ct - epoch) * k;
    const d2 = run(); if (!d2.ok) break;
    let sw = 0, swr = 0; obs.t.forEach((t, i) => { const w = 1 / (obs.e[i] * obs.e[i]); sw += w; swr += w * (t - d2.timing[0].model[i]); });
    const dt = swr / sw; epoch += dt; ht += dt; ct += dt;                // a shift of everything in time is exact
    chi2 = 0; obs.t.forEach((t, i) => { chi2 += ((t - d2.timing[0].model[i] - dt) / obs.e[i]) ** 2; });
  }
  return { host: { per: hp, tmid: ht }, comp: { per: cp, tmid: ct, mplanet: rf.mass }, epoch, chi2 };
}

/** What the companion search works on: the planet on show, its listed mid-transit times, the star, and the cache key of that set-up. */
function searchContext(app) {
  const { S } = app, tRef = S.data.tRef || 0, pls = app.planets(), st = app.star();
  const rowsOf = (sfx) => S.timing.rows.filter((r) => (r.planet || '') === sfx && (r.kind || 'transit') === 'transit').sort((a, b) => a.t - b.t);
  const me = pls.find((p) => p.sfx === S.pl) || pls[0], rows = rowsOf(me.sfx);
  const key = `${S.dataId}|${pls.length}|${me.sfx}|${rows.length}|${rows.length ? rows[0].t + rows[rows.length - 1].t : 0}|${me.mplanet}`;
  const obs = { t: rows.map((r) => r.t - tRef), e: rows.map((r) => r.e) };
  const base = () => {
    const E = obs.t.map((x) => Math.round((x - me.tmid) / me.per)), ln = lineFit(E, obs.t, obs.e);
    return { mstar: st.mstar, rstar: st.rstar, planet: { per: ln.b || me.per, tmid: ln.a, ecc: me.ecc || 0, omega: me.omega || 0, inc: me.inc, mplanet: me.mplanet }, perturber: { inc: me.inc } };
  };
  return { tRef, pls, st, rowsOf, me, rows, key, obs, base };
}

/** The companion a search result describes, in the form addCompanion takes: elements at the reference epoch, times relative to S.data.tRef. */
function companionCell(c, rf) {
  const cs = companionStart(c.obs, c.base(), rf);
  return { mass: rf.mass, period: cs.comp.per, tmid: cs.comp.tmid, inc: c.me.inc, epoch: cs.epoch, host: cs.host, chi2: cs.chi2 };
}

/**
 * Search the mid-transit times of the planet on show for an unseen companion: simulate one of every mass and period
 * on a grid (at `phases` starting phases each), score each against the times, then polish the few best cells.
 * The result is kept for the Timing tab, which draws the map. Throws with the reason when the search cannot run.
 * opts: { phases = 8, masses: [M Jup], ratios: [companion period / planet period], refine = true, maxSim = 300, onProgress(fraction) }
 * Returns { grid, refined, cell, chi2Linear, ndata }: `cell` is the argument of addCompanion (null when no cell could be simulated).
 */
export async function companionSearch(app, opts = {}) {
  const c = searchContext(app), { me, st, rows, obs } = c;
  if (rows.length < 8) throw new Error(`a search for an unseen companion needs at least eight mid-transit times of planet ${me.letter}; ${rows.length} ${rows.length === 1 ? 'is' : 'are'} listed on the Timing tab`);
  if (!(me.mplanet > 0)) throw new Error(`the search needs the mass of planet ${me.letter} (System tab, “Mp”)`);
  if (!(st.mstar > 0)) throw new Error('the search needs the stellar mass (System tab)');
  if (cache.busy) throw new Error('a companion search is already running');
  cache.busy = true; cache.msg = 'Simulating…';
  try {
    const b = c.base(), P = b.planet.per, opt = { phases: opts.phases > 0 ? Math.round(opts.phases) : 8 };
    // outside companions from just beyond the Hill-stability limit to past 3:1, inside ones down to 1:3; masses from 5 Earth masses to 3 Jupiters
    let ratio = opts.ratios;
    if (!Array.isArray(ratio) || !ratio.length) { ratio = []; for (let r = 0.34; r < 0.8; r += 0.02) ratio.push(r); for (let r = 1.25; r <= 3.3; r += 0.02) ratio.push(r); }
    const period = ratio.map((r) => r * P), mass = Array.isArray(opts.masses) && opts.masses.length ? opts.masses.map(Number) : Array.from({ length: 14 }, (_, i) => 0.015 * Math.pow(3 / 0.015, i / 13));
    if (period.some((x) => !(x > 0)) || mass.some((x) => !(x > 0))) throw new Error('masses and period ratios of the grid must be positive numbers');
    const nm = mass.length, np = period.length, N = nm * np, chi2 = new Float64Array(N).fill(Infinity), amp = new Float64Array(N), phase = new Float64Array(N), stable = new Uint8Array(N), hill = new Float64Array(N);
    const cells = []; for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) cells.push({ q: im * np + ip, mass: mass[im], period: period[ip] });
    const t0 = performance.now(); let nSim = 0, done = 0;
    const put = (list) => { for (const x of list) { chi2[x.q] = x.chi2; amp[x.q] = x.amp; phase[x.q] = x.phase; stable[x.q] = x.stable; } done += list.length; if (opts.onProgress) opts.onProgress(done / N); };
    const nW = typeof Worker !== 'undefined' ? Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1)) : 0;
    let pooled = false;
    if (nW) {
      try {
        // small batches, handed out as workers free up, so the progress moves and slow cells do not pile up on one worker
        const queue = []; for (let i = 0; i < cells.length; i += 24) queue.push(cells.slice(i, i + 24));
        await Promise.all(Array.from({ length: nW }, () => new Promise((resolve, reject) => {
          const wk = new Worker(new URL('../worker/nbody.worker.js', import.meta.url), { type: 'module' });
          const next = () => { const part = queue.shift(); if (!part) { wk.terminate(); resolve(); return; } wk.postMessage({ id: 0, obs, base: b, opt, cells: part }); };
          wk.onerror = (err) => { wk.terminate(); reject(new Error(err.message || 'worker failed')); };
          wk.onmessage = (ev) => { put(ev.data.done); nSim += ev.data.nSim; next(); };
          next();
        })));
        pooled = true;
      } catch { chi2.fill(Infinity); done = 0; nSim = 0; }
    }
    if (!pooled) {   // no workers: the same grid on this thread, yielding to the page between rows
      const prep = ttvGridPrepare(obs, b, opt);
      for (let i = 0; i < cells.length; i += np) { put(cells.slice(i, i + np).map((x) => { const r = ttvGridCell(prep, x.mass, x.period); return { q: x.q, chi2: r.chi2, amp: r.amp, phase: r.phase, stable: r.stable && r.chi2 < Infinity ? 1 : 0 }; })); await new Promise((r) => setTimeout(r, 0)); }
      nSim = prep.nSim;
    }
    const prep = ttvGridPrepare(obs, b, opt), g = ttvGridAssemble(prep, b, mass, period, chi2, amp, phase, stable, hill, {});
    g.nSim = nSim; g.seconds = (performance.now() - t0) / 1000;
    // polish the few best cells that are not neighbours: the surface is too narrow for the grid minimum to be the answer
    let best = null;
    if (opts.refine !== false) {
      const order = Array.from({ length: N }, (_, q) => q).filter((q) => Number.isFinite(chi2[q])).sort((a, x) => chi2[a] - chi2[x]), starts = [];
      for (const q of order) { const im = (q / np) | 0, ip = q % np; if (starts.every((s) => Math.abs(s.ip - ip) > 2)) starts.push({ im, ip, mass: mass[im], period: period[ip], phase: phase[q] }); if (starts.length === 4) break; }
      for (const s of starts) { try { const rf = ttvGridRefine(obs, b, s, { maxSim: opts.maxSim > 0 ? opts.maxSim : 300 }); if (!best || rf.chi2 < best.chi2) best = rf; } catch { /* a start that fails is skipped */ } }
    }
    cache.key = c.key; cache.grid = g; cache.refined = best; cache.msg = '';
    let cell = null;
    if (best || Number.isFinite(g.best.chi2)) { try { cell = companionCell(c, best || { mass: g.best.mass, period: g.best.period, phase: g.best.phase }); } catch { cell = null; } }
    return { grid: g, refined: best, cell, chi2Linear: g.chi2Linear, ndata: g.ndata };
  } catch (err) { cache.msg = 'The search failed: ' + (err.message || err); throw err; } finally { cache.busy = false; }
}

export function buildDynamics(el, app) {
  const { S, h, pushUndo, flash } = app, ctx = searchContext(app), { tRef, pls, st, rowsOf } = ctx;
  const massOk = pls.every((p) => p.mplanet > 0) && st.mstar > 0;
  el.append(h('h3', {}, 'Dynamics'));

  // ---- the switch
  const on = !!S.nbody, cb = h('input', { type: 'checkbox', checked: on, disabled: !massOk || pls.length < 2 });
  cb.addEventListener('change', () => { pushUndo(); app.setNbody(cb.checked ? { epoch: dynamicsEpoch(S, pls) } : null); app.rebuild(); flash(cb.checked ? 'N-body model on' : 'N-body model off'); });
  el.append(h('label', { class: 'chk', title: 'Fits of mid-transit times and radial velocities integrate the planets’ mutual gravity instead of adding independent Keplerian orbits. Period, T mid, e, ω and i are then the orbit each planet has at the reference epoch' }, cb, ' The planets pull on each other (N-body) in fits of times and velocities'));
  if (pls.length < 2) el.append(h('p', { class: 'note' }, 'With one planet there is nothing to pull on it. Add a second planet on the System tab, or search the mid-transit times below for an unseen companion.'));
  else if (!massOk) el.append(h('p', { class: 'note callout warn' }, 'Every planet needs a mass (System tab, “Mp”) and the star its mass before the system can be integrated.'));
  else if (on) el.append(h('p', { class: 'note' }, `Reference epoch ${(S.nbody.epoch + tRef).toFixed(4)}: the planets’ parameters are their orbits at that instant.${S.nbody.linear ? ' A straight line in epoch is fitted to each planet’s simulated times inside the likelihood, so the T0 and period of a planet with listed times stay fixed and only the shape of its O − C is fitted.' : ''} Light curves and mid-eclipse times are still computed from Keplerian orbits.`));

  // ---- the system as it stands: stability and O - C against the integration
  if (pls.length > 1 && massOk) {
    const sys = { mstar: st.mstar, rstar: st.rstar, epoch: S.nbody ? S.nbody.epoch : dynamicsEpoch(S, pls), planets: pls.map((p) => ({ per: p.per, tmid: p.tmid, ecc: p.ecc || 0, omega: p.omega || 0, inc: p.inc, mplanet: p.mplanet })) };
    let rep = null; try { rep = stabilityReport(sys); } catch { /* reported below as no findings */ }
    const megBox = h('div');
    megBox.append(h('button', { class: 'btn', title: 'Integrate 1000 orbits of the outermost planet and compute MEGNO (Cincotta & Simó 2000): about 2 for a regular orbit, growing for a chaotic one. Runs in a worker; about a second.', onclick: (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Integrating…';
      const w = new Worker(new URL('../worker/nbody.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (m) => { w.terminate(); const r = m.data && m.data.report, ig = r && r.integration; b.remove();
        megBox.append(h('p', { class: 'note' + (r && r.stable === false ? ' callout warn' : ''), html: ig && Number.isFinite(ig.megno) ? `<b>MEGNO</b> ${ig.megno.toFixed(3)} after ${Math.round(ig.megnoOrbits || 0)} orbits${ig.megnoStopped ? ' (stopped when it passed 20)' : ''}${Number.isFinite(ig.lyapunovTime) ? `; Lyapunov time ≈ ${ig.lyapunovTime.toPrecision(2)} d (order of magnitude)` : ''}. ${ig.megno < 2.5 ? 'Regular over this span.' : 'Chaotic over this span.'}` : `The integration did not give MEGNO${m.data && m.data.error ? ': ' + m.data.error : ''}.` })); };
      w.onerror = (e) => { w.terminate(); b.disabled = false; b.textContent = 'Chaos check (MEGNO)'; megBox.append(h('p', { class: 'note callout warn' }, 'The worker failed: ' + (e.message || 'unknown error'))); };
      w.postMessage({ id: 1, task: 'stability', system: sys, opt: { integrate: 1000 } });
    } }, 'Chaos check (MEGNO)'));
    el.append(megBox);
    if (rep && rep.findings.length) el.append(h('p', { class: 'note' + (rep.stable === false ? ' callout warn' : ''), html: `<b>Stability:</b> ${rep.findings.slice(0, 2).join(' ')}` }));
    const sets = pls.map((p, i) => ({ p, i, rows: rowsOf(p.sfx) })).filter((x) => x.rows.length >= 3);
    if (sets.length) {
      let dyn = null;
      try { dyn = dynamicalModel(sys, { timing: sets.map((x) => ({ planet: x.i, t: x.rows.map((r) => r.t - tRef) })), event: 'conjunction' }); } catch (err) { dyn = { ok: false, status: String(err.message || err) }; }
      if (!dyn.ok) el.append(h('p', { class: 'note callout warn' }, `The integration of the current parameters failed (${dyn.status}): a planet is unbound, two planets come too close, or one stops transiting where a time is listed.`));
      else {
        const panels = [], info = [];
        sets.forEach((x, k) => {
          const t = x.rows.map((r) => r.t - tRef), e = x.rows.map((r) => r.e), E = Array.from(dyn.timing[k].epoch), ln = lineFit(E, t, e);
          const all = dyn.sim.transits[x.i];   // E counts the simulated transits, so transit j of the integration is epoch j
          let c2 = 0, c2l = 0; t.forEach((tt, i) => { c2 += ((tt - dyn.timing[k].model[i]) / e[i]) ** 2; c2l += ((tt - ln.a - ln.b * E[i]) / e[i]) ** 2; });
          info.push(`${x.p.letter}: χ² ${c2.toFixed(1)} with dynamics, ${c2l.toFixed(1)} for a straight line (${t.length} times)`);
          panels.push({ label: x.p.letter, t: Array.from(all.t), oc: Array.from(all.t, (tt, j) => tt - ln.a - ln.b * j), data: { t, oc: t.map((tt, i) => tt - ln.a - ln.b * E[i]), errs: e } });
        });
        const cv = h('canvas', { class: 'dyncanvas', style: `height:${150 * panels.length + 40}px` });
        el.append(cv, h('p', { class: 'note' }, info.join(' · ') + '. The line is the integration at the current parameters; both are measured against the straight line fitted to the observed times.'));
        fitCanvas(cv, (c, W, H) => renderNbodyOC(c, W, H, { planets: panels, tRef: 0, label: 'O − C: observed and integrated', info: [] }, app.theme, {}));
      }
    }
  }

  // ---- search for an unseen companion of the planet on show
  const { me, rows, key } = ctx;
  if (cache.key !== key) { cache.key = key; cache.grid = null; cache.refined = null; cache.msg = ''; }
  if (rows.length >= 8 && (pls.length === 1 || !S.nbody || cache.grid)) {
    const msg = h('span', { class: 'note', id: 'dynmsg' }, cache.msg);
    const run = h('button', { class: 'chip small', disabled: cache.busy || !(me.mplanet > 0) || !(st.mstar > 0), title: 'Simulate a companion of every mass and period on a grid, at eight starting phases each, and score each simulation against the listed mid-transit times (after Pearson 2019, Nbody-AI)', onclick: () => search() }, cache.grid ? 'Search again' : 'Search for an unseen companion');
    el.append(h('div', { class: 'btnrow' }, run, msg));
    if (!(me.mplanet > 0)) el.append(h('p', { class: 'note' }, 'The search needs this planet’s mass (System tab, “Mp”): the size of the timing variation it suffers depends on the companion’s mass, the one it causes on its own.'));
    if (cache.grid) {
      const g = cache.grid, rf = cache.refined, cv = h('canvas', { class: 'dyncanvas', style: 'height:300px' });
      el.append(cv);
      fitCanvas(cv, (c, W, H) => renderGridMap(c, W, H, { ...g, basePeriod: me.per, refined: rf ? { mass: rf.mass, period: rf.period } : null }, app.theme, { title: `${g.nSim} simulations · ${g.seconds.toFixed(1)} s` }));
      const better = g.chi2Linear - (rf ? rf.chi2 : g.best.chi2), nd = g.ndata;
      el.append(h('p', { class: 'note callout' + (better < 12 ? ' warn' : ''), html: rf
        ? `Best companion after polishing: <b>${rf.mass.toFixed(3)} M Jup</b> with a mean period of <b>${rf.periodMean.toFixed(4)} d</b> (period ratio ${(rf.periodMean / me.per).toFixed(3)}), χ² ${rf.chi2.toFixed(1)} for ${nd} times against ${g.chi2Linear.toFixed(1)} with no companion.`
          + (better < 12 ? ' That improvement is too small to claim a companion: three extra parameters are expected to gain about this much on noise alone.' : ' The chi-square surface has many narrow minima (aliases in period every few thousandths of a day, and a family on each side of every resonance): treat this as one solution that fits, and confirm it with a fit and with more data.')
        : `Best grid cell: ${g.best.mass.toFixed(3)} M Jup at ${g.best.period.toFixed(4)} d, χ² ${g.best.chi2.toFixed(1)} against ${g.chi2Linear.toFixed(1)} with no companion.` }));
      if (rf && better >= 12) el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Add the companion as a planet, switch the N-body model on and free its mass, period and phase, ready for a fit of the times', onclick: () => {
        app.addCompanion(companionCell(ctx, rf));
      } }, 'Add it as a planet and fit')));
    }
  } else if (pls.length === 1) el.append(h('p', { class: 'note' }, 'A search for an unseen companion needs at least eight mid-transit times of this planet.'));

  // ---- the companion explorer: the search's map and/or the posterior of an N-body fit, with the orbits and the timing
  if (rows.length >= 4 && (cache.grid || (S.nbody && pls.length > 1 && S.fit))) {
    try { buildCompanionExplorer(el, { app, ctx, grid: cache.grid, refined: cache.refined, onAdopt: (sel) => app.addCompanion(companionCell(ctx, { mass: sel.mass, period: sel.planet.per, phase: sel.phase })) }); }
    catch (err) { el.append(h('p', { class: 'note callout warn' }, 'The companion explorer could not be drawn: ' + (err.message || err))); }
  }

  async function search() {
    if (cache.busy) return;
    const job = startJob({ label: 'Search for an unseen companion', show: () => { const m = document.getElementById('dynmsg'); if (m) m.scrollIntoView({ block: 'center' }); } });
    const done = companionSearch(app, { onProgress: (f) => { job.update({ fraction: f }); const m = document.getElementById('dynmsg'); if (m) m.textContent = `Simulating… ${Math.round(100 * f)}%`; } });
    app.rebuild();   // shows "Simulating…" and disables the button while the grid runs
    try { await done; job.finish('Search finished'); } catch { job.fail('Search failed'); /* the reason is in cache.msg, shown beside the button */ }
    app.rebuild();
  }
}
