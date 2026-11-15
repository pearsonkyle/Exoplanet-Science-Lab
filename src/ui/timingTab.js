// Timing tab: a list of mid-transit times, a linear or quadratic ephemeris fitted to it,
// the O-C diagram, and predicted future transits. The science is in core/ephemeris.js.
//
// buildTimingTab(el, app) rebuilds the pane and returns a function that redraws the plot
// (call it when the tab becomes visible). `app` is what main.js lends this module:
//   { S, h, pushUndo, flash, slug, rebuild(), applyEphemeris(fit) }

import { fitEphemeris, assignEpochs, parseTimings, MS_PER_YEAR } from '../core/ephemeris.js';
import { makeRng } from '../core/stats.js';
import { drawOC } from './ocplot.js';
import { saveFile, canvasToPNG, canvasToPDF } from './export.js';

/** Digits after the point that show two significant figures of the uncertainty. */
const dgFor = (e) => Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, e)))));
const pm = (v, e) => { const d = dgFor(e); return `${v.toFixed(d)} ± ${e.toFixed(d)}`; };
const jdToUTC = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 16).replace('T', ' ');

/** Epochs and both fits for the current list. Returns null with fewer than two times. */
export function solveTiming(rows, per) {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => a.t - b.t), t = sorted.map((r) => r.t), e = sorted.map((r) => r.e);
  const given = sorted.every((r) => r.epoch != null);
  const { epochs, maxFrac } = given ? { epochs: sorted.map((r) => r.epoch), maxFrac: 0 } : assignEpochs(t, per, t[0]);
  const out = { rows: sorted, epochs, t, e, given, maxFrac, lin: null, quad: null, error: null };
  try { out.lin = fitEphemeris(epochs, t, e, 1); } catch (err) { out.error = err.message; return out; }
  if (rows.length >= 4) { try { out.quad = fitEphemeris(epochs, t, e, 2); } catch { /* not enough distinct epochs */ } }
  return out;
}

/** What the plot needs: residuals against the linear ephemeris, and the chosen model's curve and band. */
function plotData(sol, order, label) {
  const { lin, quad, epochs, t, e } = sol, sel = order === 2 && quad ? quad : lin;
  const e0 = Math.min(...epochs), e1 = Math.max(...epochs), ext = Math.max(1, 0.12 * (e1 - e0)), NG = 160;
  const curve = { E: [], y: [], lo: [], hi: [] };
  for (let i = 0; i <= NG; i++) {
    const E = e0 - ext + ((e1 - e0 + 2 * ext) * i) / NG, p = sel.predict(E), y = p.t - lin.model(E);
    curve.E.push(E); curve.y.push(y); curve.lo.push(y - p.sigma); curve.hi.push(y + p.sigma);
  }
  // colour by where each time came from (instrument, network, paper), when the list says
  const names = [...new Set(sol.rows.map((r) => r.src || 'unlabelled'))], grouped = names.length > 1 && names.length <= 9;
  return { epochs, oc: t.map((v, i) => v - lin.model(epochs[i])), errs: e, curve, label, group: grouped ? sol.rows.map((r) => names.indexOf(r.src || 'unlabelled')) : null, groups: grouped ? names : null };
}

export function buildTimingTab(el, app) {
  const { S, h, pushUndo, flash, slug } = app, T0 = S.timing;
  el.innerHTML = '';
  const tRef = S.data.tRef || 0, per = app.per();
  // the list shown and fitted here: mid-transit times of the planet on show. Other planets' times and
  // mid-eclipse times stay in S.timing (the joint fit uses them) and are listed below.
  const mine = (r) => (r.planet || '') === S.pl && (r.kind || 'transit') === 'transit';
  const T = { ...T0, rows: T0.rows.filter(mine) }, others = T0.rows.filter((r) => !mine(r));
  const setRows = (rows, text) => { pushUndo(); S.timing = { ...T0, rows: [...others, ...rows.map((r) => ({ kind: 'transit', planet: S.pl, ...r }))], text: text ?? T0.text }; app.rebuild(); };
  const msg = h('p', { class: 'note', id: 'timingmsg' });
  const fail = (t) => { msg.textContent = t; msg.style.color = 'var(--bad)'; };

  // ---- the list -------------------------------------------------------------
  el.append(h('h3', {}, S.planets.length > 1 ? `Mid-transit times · ${app.label()}` : 'Mid-transit times', T.rows.length ? h('button', { class: 'chip small', title: 'Remove every time from the list', onclick: () => setRows([]) }, 'clear') : null));
  const sol = solveTiming(T.rows, per), order = T.order === 2 && sol && sol.quad ? 2 : 1, sel = sol && (order === 2 ? sol.quad : sol.lin);
  if (!T.rows.length) el.append(h('div', { class: 'empty' }, 'No times yet. Add the mid-transit time from a fit, paste a list, or load the simulated example below.'));
  else {
    const tb = h('tbody');
    const list = sol ? sol.rows : T.rows;
    list.forEach((r, i) => {
      const oc = sol && sol.lin ? (r.t - sol.lin.model(sol.epochs[i])) * 1440 : null;
      const rm = h('button', { class: 'chip small', title: 'Remove this time', 'aria-label': 'Remove time ' + r.t, onclick: () => setRows(T.rows.filter((x) => x !== r)) }, '✕');
      tb.append(h('tr', { title: r.src || '' }, h('td', {}, sol ? String(sol.epochs[i]) : '—'), h('td', {}, r.t.toFixed(5)), h('td', {}, (r.e * 1440).toFixed(2)), h('td', {}, oc === null ? '—' : (oc >= 0 ? '+' : '−') + Math.abs(oc).toFixed(2)), h('td', {}, rm)));
    });
    el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing' }, h('thead', { html: '<tr><th>Epoch</th><th>T mid</th><th>± min</th><th>O − C min</th><th></th></tr>' }), tb)));
    if (sol && !sol.given) el.append(h('p', { class: 'note', html: `Epochs are counted from the first time using the System period, P = ${per} d.` + (sol.maxFrac > 0.2 ? ` <span style="color:var(--warn)">One time sits ${sol.maxFrac.toFixed(2)} of a period away from a whole number of orbits, so the orbit count may be wrong: improve the period or give the epochs explicitly.</span>` : '') }));
  }

  // add from the current fit
  const fitT = S.fit && S.fit.summary.find((s) => s.key === app.tmidKey());
  const addFit = () => {
    const t = fitT.med + tRef, e = 0.5 * (fitT.plus + fitT.minus);
    if (T.rows.some((r) => Math.abs(r.t - t) < 1e-7)) return fail('That mid-transit time is already in the list.');
    if (!(e > 0)) return fail('The fitted mid-transit time has no uncertainty.');
    setRows([...T.rows, { t, e, epoch: null, src: `run #${S.fit.id} · ${S.data.name}` }]); flash('Time added');
  };
  el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn primary', disabled: !fitT, title: fitT ? 'Append the posterior median and 1σ of T mid from the run shown on the Results tab' : 'Run a fit with T mid free first', onclick: addFit }, 'Add T mid from the current fit'),
    fitT ? h('span', { class: 'note' }, `${(fitT.med + tRef).toFixed(5)} ± ${(0.5 * (fitT.plus + fitT.minus)).toFixed(5)}`) : null));

  // paste or load a file
  const ta = h('textarea', { placeholder: 'time, uncertainty   (or: epoch, time, uncertainty)\n2455867.9734, 0.0007\n2455893.7735, 0.0004', 'aria-label': 'Paste mid-transit times' }); ta.value = T.text || '';
  const take = (text, append, name) => {
    try {
      const p = parseTimings(text), add = p.rows.map((r) => ({ ...r, src: name }));
      // explicit epochs only survive when every row in the list has one
      const rows = append ? [...T.rows, ...add.filter((r) => !T.rows.some((x) => Math.abs(x.t - r.t) < 1e-7))] : add;
      setRows(rows, text); flash(`${add.length} time${add.length > 1 ? 's' : ''} read` + (p.skipped ? `, ${p.skipped} line${p.skipped > 1 ? 's' : ''} skipped` : ''));
    } catch (err) { fail(err.message); }
  };
  const file = h('input', { type: 'file', accept: '.csv,.txt,.dat,.tsv', hidden: true, 'aria-label': 'Mid-transit times file' });
  file.addEventListener('change', async () => { if (file.files[0]) take(await file.files[0].text(), false, file.files[0].name); file.value = ''; });
  el.append(ta, h('div', { class: 'btnrow' },
    h('button', { class: 'btn', onclick: () => take(ta.value, false, 'pasted') }, 'Load pasted (replace)'),
    h('button', { class: 'btn', onclick: () => take(ta.value, true, 'pasted') }, 'Add pasted'),
    h('button', { class: 'btn', onclick: () => file.click() }, 'Open file…'), file,
    h('button', { class: 'btn', title: 'Make a list of noisy times from the current System period and T mid, to try the tab out', onclick: () => setRows(simulated(S, tRef, per, S.values[app.tmidKey()]), '') }, 'Simulated example')), msg);
  el.append(h('p', { class: 'note' }, 'Times in days in one time system (BJD_TDB is the usual choice) with 1σ uncertainties in days. The list never leaves your computer.'));

  // ---- the ephemeris ----------------------------------------------------------
  let redraw = () => {};
  if (sol && sol.error) el.append(h('p', { class: 'note', style: 'color:var(--bad)' }, sol.error));
  if (sol && sol.lin) {
    const pick = (o, label, dis, title) => h('button', { class: order === o ? 'on' : '', disabled: dis, title, onclick: () => { pushUndo(); S.timing = { ...T0, order: o }; app.rebuild(); } }, label);
    el.append(h('h3', {}, 'Ephemeris', h('div', { class: 'seg small' }, pick(1, 'Linear', false, 'T = T0 + P·E'), pick(2, 'Quadratic', !sol.quad, sol.quad ? 'T = T0 + P·E + ½(dP/dE)·E²: a steadily changing period' : 'Needs at least four times'))));
    const kv = [
      ['T0 at epoch 0', pm(sel.t0, sel.err.t0)], ['Period P (d)', pm(sel.per, sel.err.per)],
      ...(order === 2 ? [['dP/dt (ms/yr)', pm(sel.dPdt * MS_PER_YEAR, sel.dPdtErr * MS_PER_YEAR)], ['dP/dE (d/orbit)', `${sel.dPdE.toExponential(3)} ± ${sel.err.dPdE.toExponential(1)}`]] : []),
      ['χ² / dof', `${sel.chi2.toFixed(1)} / ${sel.dof}`], ['BIC', sel.bic.toFixed(1)],
    ];
    el.append(h('div', { class: 'kv', id: 'timingkv', html: kv.map(([k, v]) => `<div><span>${k}</span><b style="font-size:12px">${v}</b></div>`).join('') }));
    const notes = [];
    if (sol.quad) {
      const d = sol.lin.bic - sol.quad.bic, z = Math.abs(sol.quad.dPdE) / sol.quad.err.dPdE;
      notes.push(`ΔBIC (linear − quadratic) = <b>${d.toFixed(1)}</b>: ${d > 10 ? 'the changing period is strongly preferred' : d > 2 ? 'some preference for a changing period' : d > -2 ? 'the two models are not distinguished' : 'the constant period is preferred'}. The period change is ${z.toFixed(1)}σ from zero.`);
    }
    if (sel.dof > 0 && sel.chi2 / sel.dof > 2) notes.push(`χ²/dof is ${(sel.chi2 / sel.dof).toFixed(1)}: the times scatter more than their error bars allow (underestimated errors, stellar activity, or real timing variations), so the uncertainties above are too small by about ×${Math.sqrt(sel.chi2 / sel.dof).toFixed(1)}.`);
    if (sel.dof === 0) notes.push('As many parameters as times: the fit passes through every point and χ² says nothing about its quality.');
    notes.push('Weighted least squares; uncertainties come from the error bars as given, not rescaled by χ².');
    el.append(...notes.map((t) => h('p', { class: 'note', html: t })));

    const cv = h('canvas', { id: 'occanvas' }); el.append(cv);
    const label = `${app.label()} · O − C against the linear ephemeris`;
    const data = plotData(sol, order, label);
    redraw = () => drawOC(cv, data);
    requestAnimationFrame(redraw);
    const toast = h('span', { class: 'toast' }), base = slug(app.label());
    const save = async (name, make) => { try { const st = await saveFile(name, await make()); toast.textContent = st === 'saved' ? 'Saved ' + name : 'Save cancelled.'; } catch (err) { toast.textContent = 'Could not save: ' + err.message; } };
    const figure = (theme) => { const c = document.createElement('canvas'); drawOC(c, { ...data, info: [`P = ${pm(sel.per, sel.err.per)} d`, ...(order === 2 ? [`dP/dt = ${pm(sel.dPdt * MS_PER_YEAR, sel.dPdtErr * MS_PER_YEAR)} ms/yr`] : [])] }, { theme, width: 900, height: 480, scale: 3, fontScale: 1.35, title: `${app.label()} — transit timing` }); return c; };
    const csv = () => 'epoch,t_mid,sigma,o_minus_c_min,source\n' + sol.rows.map((r, i) => [sol.epochs[i], r.t, r.e, ((r.t - sol.lin.model(sol.epochs[i])) * 1440).toFixed(4), JSON.stringify(r.src || '')].join(',')).join('\n') + '\n';
    const json = () => JSON.stringify({ system: app.label(), model: order === 2 ? 'quadratic' : 'linear', n: sel.n, t0: sel.t0, t0_err: sel.err.t0, period: sel.per, period_err: sel.err.per, ...(order === 2 ? { dPdE: sel.dPdE, dPdE_err: sel.err.dPdE, dPdt_ms_per_yr: sel.dPdt * MS_PER_YEAR, dPdt_err_ms_per_yr: sel.dPdtErr * MS_PER_YEAR } : {}), chi2: sel.chi2, dof: sel.dof, bic: sel.bic, bic_linear: sol.lin.bic, bic_quadratic: sol.quad ? sol.quad.bic : null, epochs_from: sol.given ? 'file' : `counted with P = ${per} d` }, null, 2);
    el.append(h('div', { class: 'btnrow' }, h('span', { class: 'note' }, 'Save:'),
      h('button', { class: 'btn', onclick: () => save(base + '_oc.png', () => canvasToPNG(figure('light'))) }, 'PNG'),
      h('button', { class: 'btn', onclick: () => save(base + '_oc.pdf', () => canvasToPDF(figure('light'))) }, 'PDF'),
      h('button', { class: 'btn', onclick: () => save(base + '_oc_dark.png', () => canvasToPNG(figure('dark'))) }, 'PNG dark'),
      h('button', { class: 'btn', onclick: () => save(base + '_timing.csv', csv) }, 'Table CSV'),
      h('button', { class: 'btn', onclick: () => save(base + '_ephemeris.json', json) }, 'Ephemeris JSON'), toast));
    el.append(h('p', { class: 'note' }, 'Points are the times minus the linear ephemeris. The line and shaded band are the selected model and its 1σ prediction uncertainty, which grows away from the observed epochs.'));
    el.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn', title: 'Set the System period, and T mid to the predicted transit nearest the loaded light curve', onclick: () => app.applyEphemeris(sel) }, 'Use this ephemeris in the model')));

    // ---- upcoming transits (only when the list looks like Julian dates) --------
    if (sel.t0 > 2400000) {
      const now = Date.now() / 86400000 + 2440587.5, E0 = Math.ceil((now - sel.t0) / sel.per), rows = [];
      for (let i = 0; i < 5; i++) { const p = sel.predict(E0 + i); rows.push(`<tr><td>${E0 + i}</td><td>${p.t.toFixed(dgFor(p.sigma))}</td><td>${(p.sigma * 1440).toFixed(p.sigma * 1440 < 10 ? 2 : 1)}</td><td>${jdToUTC(p.t)}</td></tr>`); }
      el.append(h('h3', {}, 'Next transits'));
      el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing', html: `<thead><tr><th>Epoch</th><th>T mid</th><th>± min</th><th>Calendar (UTC)</th></tr></thead><tbody>${rows.join('')}</tbody>` })));
      el.append(h('p', { class: 'note' }, 'From the selected model with its uncertainty propagated to each epoch. The calendar column converts the listed time directly: if the list is in BJD_TDB, the moment seen from Earth differs by up to about 8 minutes (light travel time) plus 69 s (TDB − UTC).'));
    }
  }
  const ecl = others.filter((r) => (r.planet || '') === S.pl && r.kind === 'eclipse');
  if (ecl.length) {
    el.append(h('h3', {}, 'Mid-eclipse times'));
    const tb = h('tbody'); ecl.forEach((r) => tb.append(h('tr', { title: r.src || '' }, h('td', {}, r.t.toFixed(5)), h('td', {}, (r.e * 1440).toFixed(2)), h('td', {}, r.src || ''), h('td', {}, h('button', { class: 'chip small', 'aria-label': 'Remove eclipse time', onclick: () => { pushUndo(); S.timing = { ...T0, rows: T0.rows.filter((x) => x !== r) }; app.rebuild(); } }, '✕')))));
    el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'res timing' }, h('thead', { html: '<tr><th>E mid</th><th>± min</th><th>Source</th><th></th></tr>' }), tb)));
    el.append(h('p', { class: 'note' }, 'Not part of the ephemeris above. In a joint fit (Fit tab, “Mid-transit and mid-eclipse times”) an eclipse time pins down e cos ω.'));
  }
  if (others.length - ecl.length) el.append(h('p', { class: 'note' }, `${others.length - ecl.length} time${others.length - ecl.length > 1 ? 's' : ''} of other planets are kept: switch planet on the System tab to see them.`));
  return () => redraw();
}

/** A demonstration list: 14 earlier transits over up to ten years from the System ephemeris, 30 to 90 s errors. */
function simulated(S, tRef, per, tmid) {
  const rng = makeRng(11), t0 = tmid + tRef;
  const span = Math.max(13, Math.min(2500, Math.floor(3650 / per))), set = new Set([0, span]);
  while (set.size < Math.min(14, span + 1)) set.add(rng.int(span + 1));
  return [...set].sort((a, b) => a - b).map((E) => { const e = (30 + 60 * rng.next()) / 86400; return { t: t0 + per * (E - span - 1) + e * rng.normal(), e, epoch: null, src: 'simulated from the System ephemeris' }; });
}
