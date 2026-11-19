// The companion explorer on the Timing tab (Dynamics): where an unseen planet can be, what its orbit looks like, and
// what it does to the transit times. Three linked views (src/ui/companionplot.js):
//   map     period ratio × mass: the grid search's Δχ² surface and the posterior's companions; hover to look, click
//           (or tap) to select
//   orbits  the system from above, animated: the transiting planet, the selected companion, and the posterior's
//           companions as a cloud of faint orbits with a dot each, so the spread of the estimate is visible in motion
//   O − C   the observed timing variations, the selected companion's integration (N-body, src/core/nbody.js) and the
//           curves of a few posterior draws, computed a few at a time so the page stays responsive
// Sources: the companion search's grid (cache.grid, cache.refined) and/or the posterior of an N-body fit with two or
// more planets (app.posterior). Nothing is sampled here; this only draws what was found.

import { renderCompanionMap, renderCompanionOrbits, renderCompanionOC, mapLayout, aAU } from './companionplot.js';
import { nbody, ttvGridPrepare } from '../core/nbody.js';

const MJ_MS = 9.547919e-4;   // Jupiter mass in solar masses (IAU nominal)
const quant = (a, q) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : NaN; };
const pm = (a, d = 3) => { const m = quant(a, 0.5), lo = quant(a, 0.1587), hi = quant(a, 0.8413); return `${m.toFixed(d)} +${(hi - m).toFixed(d)} −${(m - lo).toFixed(d)}`; };

/** Weighted straight line through (E, t) with errors e: { a, b }. */
function line(E, t, e) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < E.length; i++) { const w = 1 / (e[i] * e[i] || 1); sw += w; sx += w * E[i]; sy += w * t[i]; sxx += w * E[i] * E[i]; sxy += w * E[i] * t[i]; }
  const d = sw * sxx - sx * sx; return { a: (sxx * sy - sx * sxy) / d, b: (sw * sxy - sx * sy) / d };
}

/**
 * buildCompanionExplorer(el, { app, ctx, grid, refined, cellFor, onAdopt })
 *   ctx: searchContext of dynamics.js ({ me, obs, base, pls, st, tRef }); grid/refined: the search's result or null;
 *   onAdopt(selection): add the selected grid companion as a planet (shown only for grid selections)
 */
export function buildCompanionExplorer(el, { app, ctx, grid, refined, onAdopt }) {
  const { h, S } = app, me = ctx.me, obs = ctx.obs;
  const pls = ctx.pls, others = pls.filter((p) => p.sfx !== me.sfx), comp0 = others.length ? others.reduce((a, b) => (b.per > a.per ? b : a)) : null;
  const draws = S.nbody && comp0 && app.posterior ? app.posterior(80) : null;
  if (!grid && !draws) return;

  // ---- the observed O − C, against a straight line in transit number
  const tFirst = obs.t[0], Pb = me.per, Eobs = obs.t.map((t) => Math.round((t - tFirst) / Pb)), Lobs = line(Eobs, obs.t, obs.e);
  const MIN = 1440, ocObs = { E: Eobs, oc: obs.t.map((t, i) => (t - Lobs.a - Lobs.b * Eobs[i]) * MIN), err: obs.e.map((e) => e * MIN) };
  const tEnd = obs.t[obs.t.length - 1] + 2 * Pb;
  /** The O − C curve of one system: its transits of the planet on show, aligned to the data by a straight line as the fit does. */
  function curveOf(system, idx) {
    let sim; try { sim = nbody(system, { tStart: obs.t[0] - 2 * Pb, tEnd, event: 'conjunction' }); } catch { return null; }
    if (!sim || !sim.ok) return null;
    const tr = sim.transits[idx]; if (!tr || !tr.n) return null;
    const Tm = Array.from(tr.t.subarray ? tr.t.subarray(0, tr.n) : tr.t.slice(0, tr.n)), Em = Tm.map((t) => Math.round((t - tFirst) / Pb)), byE = new Map(Em.map((E, j) => [E, Tm[j]]));
    const r = [], Er = [], er = [];
    Eobs.forEach((E, i) => { if (byE.has(E)) { r.push(obs.t[i] - byE.get(E)); Er.push(E); er.push(obs.e[i]); } });
    if (r.length < Math.min(4, Eobs.length)) return null;
    const c = line(Er, r, er), keep = Em.map((E, j) => j).filter((j) => Em[j] >= Eobs[0] - 2 && Em[j] <= Eobs[Eobs.length - 1] + 2);
    return { E: keep.map((j) => Em[j]), oc: keep.map((j) => (Tm[j] + c.a + c.b * Em[j] - Lobs.a - Lobs.b * Em[j]) * MIN) };
  }
  const epoch = S.nbody && Number.isFinite(S.nbody.epoch) ? S.nbody.epoch : Math.min(...obs.t) - Pb;
  const sysOf = (draw) => ({ mstar: draw.mstar, rstar: draw.rstar, epoch, planets: draw.planets.map((p) => ({ per: p.per, tmid: p.tmid, ecc: p.ecc || 0, omega: p.omega || 0, inc: p.inc ?? 90, mplanet: p.mplanet || 0 })) });
  const iMe = pls.findIndex((p) => p.sfx === me.sfx);

  // ---- the companions: posterior draws and the grid's cells
  const samples = draws ? draws.map((d) => { const c = d.planets.find((p) => p.sfx === comp0.sfx), b = d.planets[iMe]; return { ratio: c.per / b.per, mass: c.mplanet, draw: d, c, b }; }) : [];
  let prep = null; const gridPrep = () => (prep ||= ttvGridPrepare(obs, ctx.base(), { phases: 8 }));
  const gridSystem = (mass, period, phase) => { const p = gridPrep(), b = ctx.base(); return { mstar: b.mstar, rstar: b.rstar, epoch: p.epoch, planets: [{ ...b.planet, tmid: p.tmid0 }, { ecc: 0, omega: 0, inc: b.planet.inc ?? 90, per: period, mplanet: mass, tmid: p.epoch + phase * period }] }; };
  const gridBest = grid ? (refined ? { ratio: refined.periodMean / me.per, mass: refined.mass, period: refined.period, phase: refined.phase } : { ratio: grid.best.period / me.per, mass: grid.best.mass, period: grid.best.period, phase: grid.best.phase }) : null;

  // ---- layout
  const th = () => app.theme;
  const cvMap = h('canvas', { class: 'cx-map', role: 'img', 'aria-label': 'Map of possible companions: period ratio against mass' });
  const cvOrb = h('canvas', { class: 'cx-orbit', role: 'img', 'aria-label': 'The system seen from above, animated' });
  const cvOC = h('canvas', { class: 'cx-oc', role: 'img', 'aria-label': 'Observed and simulated transit timing variations' });
  const read = h('div', { class: 'cx-read', 'aria-live': 'polite' });
  const play = h('button', { class: 'chip small', type: 'button', 'aria-pressed': 'false' }, 'Play');
  const speed = h('select', { class: 'cx-speed', 'aria-label': 'Animation speed' }, ...[['0.25', '¼ orbit/s'], ['1', '1 orbit/s'], ['4', '4 orbits/s']].map(([v, t]) => h('option', { value: v, selected: v === '1' }, t)));
  const cloudOn = h('input', { type: 'checkbox', checked: true });
  const adopt = h('button', { class: 'btn', type: 'button', hidden: true }, 'Add this companion and fit');
  const wrap = h('div', { class: 'cx' },
    h('h4', {}, 'Companion explorer'),
    h('p', { class: 'note' }, draws ? `The posterior of planet ${comp0.letter} (${samples.length} draws) ${grid ? 'over the grid search\'s Δχ² map' : ''}: hover the map to look, click a point to select it.` : 'The grid search\'s Δχ² map: hover to look, click a cell to see that companion\'s orbit and timing.'),
    h('div', { class: 'cx-grid' }, cvMap, cvOrb), cvOC,
    h('div', { class: 'cx-ctl' }, play, speed, draws ? h('label', { class: 'chk' }, cloudOn, ' posterior orbits') : null, adopt), read);
  el.append(wrap);

  // ---- state
  let sel = null, hover = null, spread = [], selCurve = null, t = obs.t[0], playing = false, last = 0;   // still until the user presses Play
  const mapData = () => ({ basePeriod: me.per, letter: me.letter, grid: grid ? { period: grid.period, mass: grid.mass, np: grid.np, nm: grid.nm, dchi2: grid.dchi2 } : null, samples: samples.map((s) => ({ ratio: s.ratio, mass: s.mass })), best: gridBest && !draws ? gridBest : null, sel, hover });
  const fit = (cv) => { const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return null; const k = Math.min(window.devicePixelRatio || 1, 2); if (cv.width !== Math.round(W * k)) { cv.width = Math.round(W * k); cv.height = Math.round(H * k); } const c = cv.getContext('2d'); c.setTransform(k, 0, 0, k, 0, 0); return { c, W, H }; };
  const drawMap = () => { const f = fit(cvMap); if (f) renderCompanionMap(f.c, f.W, f.H, mapData(), th()); };
  const drawOC = () => { const f = fit(cvOC); if (f) renderCompanionOC(f.c, f.W, f.H, { obs: ocObs, sel: selCurve, spread: cloudOn.checked ? spread : [], letter: me.letter, note: spread.length ? `${spread.length} posterior draws` : '' }, th()); };
  const bodyOf = (p, mstar, label, main, color) => ({ label, a: aAU(p.per, mstar + (p.mplanet || 0) * MJ_MS), e: p.ecc || 0, omega: p.omega || 0, per: p.per, tmid: p.tmid, mass: p.mplanet, main, color });
  function drawOrbit() {
    const f = fit(cvOrb); if (!f) return;
    const mstar = ctx.st.mstar || 1, inner = bodyOf(me, mstar, me.letter, true, th().model);
    const bodies = [inner]; if (sel && sel.planet) bodies.push(bodyOf(sel.planet, mstar, sel.label, false, th().cursor || '#ffc56b'));
    const cloud = cloudOn.checked ? samples.slice(0, 50).map((s) => bodyOf(s.c, s.draw.mstar || mstar, '', false)) : [];
    const days = t - obs.t[0];
    renderCompanionOrbits(f.c, f.W, f.H, { t, bodies, cloud, unit: 'AU', clock: `day ${days.toFixed(1)} · ${(days / me.per).toFixed(2)} orbits of ${me.letter}` }, th());
  }
  const describe = () => {
    const parts = [];
    if (samples.length) parts.push(`<b>Posterior of ${comp0.letter}</b>: mass ${pm(samples.map((s) => s.mass))} M Jup · period ${pm(samples.map((s) => s.c.per), 4)} d · ratio ${pm(samples.map((s) => s.ratio), 4)} ${(() => { const es = samples.map((s) => s.c.ecc || 0); return Math.max(...es) - Math.min(...es) > 1e-9 ? ` · e ${pm(es)}` : ` · e ${es[0].toFixed(3)} (fixed)`; })()}`);
    if (sel) parts.push(`<b>Selected</b> (${sel.source}): ${sel.mass.toFixed(3)} M Jup at ${sel.planet.per.toFixed(4)} d (ratio ${sel.ratio.toFixed(4)})${Number.isFinite(sel.dchi2) ? ` · Δχ² ${sel.dchi2.toFixed(1)} from the best cell` : ''}${selCurve ? '' : ' · its integration failed (unstable, or it stops transiting)'}`);
    if (grid) parts.push(`Grid: ${grid.nm} masses × ${grid.np} periods, best cell ${grid.best.mass.toFixed(3)} M Jup at ${grid.best.period.toFixed(3)} d. Bright cells fit the times best; grey cells are unstable or stop the planet transiting.`);
    read.innerHTML = parts.join('<br>');
  };

  // ---- selecting a companion
  function select(s) {
    sel = s; adopt.hidden = !(s && s.source === 'grid' && onAdopt);
    selCurve = s ? curveOf(s.system, s.idx) : null;
    describe(); drawMap(); drawOrbit(); drawOC();
  }
  function fromSample(s) { return { source: 'posterior draw', ratio: s.ratio, mass: s.mass, label: comp0.letter, planet: s.c, system: sysOf(s.draw), idx: iMe }; }
  function fromCell(im, ip) {
    const mass = grid.mass[im], period = grid.period[ip], q = im * grid.np + ip;
    const planet = { per: period, tmid: gridPrep().epoch + grid.phase[q] * period, ecc: 0, omega: 0, mplanet: mass };
    return { source: 'grid cell', ratio: period / me.per, mass, label: 'companion', planet, dchi2: grid.dchi2[q], phase: grid.phase[q], system: gridSystem(mass, period, grid.phase[q]), idx: 0 };
  }
  function pick(x, y) {
    const Lo = mapLayout(cvMap.clientWidth, cvMap.clientHeight, mapData());
    if (x < Lo.px0 || x > Lo.px1 || y < Lo.py0 || y > Lo.py1) return null;
    let best = null, bd = 12 * 12;
    samples.forEach((s) => { const dx = Lo.X(s.ratio) - x, dy = Lo.Y(s.mass) - y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = { kind: 'sample', s }; } });
    if (best || !grid) return best;
    const r = Lo.ratioAt(x), m = Lo.massAt(y);
    let ip = 0, im = 0; grid.period.forEach((p, i) => { if (Math.abs(p / me.per - r) < Math.abs(grid.period[ip] / me.per - r)) ip = i; }); grid.mass.forEach((v, i) => { if (Math.abs(Math.log(v / m)) < Math.abs(Math.log(grid.mass[im] / m))) im = i; });
    return { kind: 'cell', im, ip };
  }
  const xy = (ev) => { const r = cvMap.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  cvMap.addEventListener('pointermove', (ev) => { const p = pick(...xy(ev)); hover = p ? (p.kind === 'sample' ? { ratio: p.s.ratio, mass: p.s.mass } : { ratio: grid.period[p.ip] / me.per, mass: grid.mass[p.im] }) : null; cvMap.style.cursor = p ? 'pointer' : 'default'; drawMap(); });
  cvMap.addEventListener('pointerleave', () => { hover = null; drawMap(); });
  cvMap.addEventListener('click', (ev) => { const p = pick(...xy(ev)); if (p) select(p.kind === 'sample' ? fromSample(p.s) : fromCell(p.im, p.ip)); });
  adopt.addEventListener('click', () => sel && onAdopt && onAdopt(sel));
  play.addEventListener('click', () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; play.setAttribute('aria-pressed', String(playing)); if (playing) { last = 0; requestAnimationFrame(tick); } });
  cloudOn.addEventListener('change', () => { drawOrbit(); drawOC(); });

  // ---- animation: inner orbits per second, only after Play and while the explorer is on the page
  function tick(now) {
    if (!wrap.isConnected) return;
    if (!playing) return;
    if (last) t += ((now - last) / 1000) * Number(speed.value) * me.per;
    last = now; drawOrbit(); requestAnimationFrame(tick);
  }

  // ---- start: the best (median-ish) companion selected, the spread computed a few curves at a time. Each is an N-body
  // integration, so none runs until the explorer is first on screen (its tab open and scrolled into view): opening an
  // example, which rebuilds this panel several times, integrates nothing here.
  const queue = samples.slice(0, 24);
  const step = () => { if (!wrap.isConnected) return; const s = queue.shift(); if (!s) return; const c = curveOf(sysOf(s.draw), iMe); if (c) { spread.push(c); drawOC(); } setTimeout(step, 0); };
  let started = false;
  const start = () => {
    if (started || !wrap.isConnected) return; started = true;
    if (samples.length) { const byMass = [...samples].sort((a, b) => a.mass - b.mass); select(fromSample(byMass[byMass.length >> 1])); }
    else if (grid) { const g = grid.best; select(fromCell(g.im, g.ip)); }
    setTimeout(step, 50);
  };
  if (typeof IntersectionObserver === 'function') { const io = new IntersectionObserver((es) => { if (!wrap.isConnected) { io.disconnect(); return; } if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }); io.observe(wrap); }
  else start();
  if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(() => { if (!wrap.isConnected) { ro.disconnect(); return; } drawMap(); drawOrbit(); drawOC(); }); [cvMap, cvOrb, cvOC].forEach((c) => ro.observe(c)); }
  window.addEventListener('esl-theme', () => { if (wrap.isConnected) { drawMap(); drawOrbit(); drawOC(); } });
  requestAnimationFrame(() => { describe(); drawMap(); drawOrbit(); drawOC(); if (playing) requestAnimationFrame(tick); });
}
