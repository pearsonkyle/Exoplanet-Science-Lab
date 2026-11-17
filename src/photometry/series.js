// The photometry page's long-light-curve mode: several sectors (quarters, campaigns) of TESS / Kepler / K2 light curves or
// target pixel files, shown stitched, and "Prepare for transit fitting" (src/photometry/prep.js): known transits masked from
// the catalogue's ephemerides (or typed), a per-sector biweight flatten, EXOTIC's clip, a window cut around every transit,
// and the hand-off to the analyzer. UI only; the science is in prep.js and src/core/lcprep.js.
import { renderPanel, fitCanvas, PHOT_THEME } from './plots.js';
import { loadIndex, lookupHost, systemFromRows } from '../core/catalog.js';
import { toiRecords } from './mast.js';
import { preparedCsv, windowCsvs } from './prep.js';
import { makeZip } from '../core/zip.js';
import { medianOf } from '../core/photometry.js';
import { siteJson } from '../site/net.js';

/**
 * @param ctx { P, h, $, call (worker), setStatus, siteRoot, download, el (the section), name () }
 * @returns { show(parts, info), state(), planets, prepare(opts), send(which), lookup() }
 */
export function createSeries(ctx) {
  const { P, h, $, el } = ctx, S = P.series = P.series || { parts: [], info: {}, planets: [], prep: null, opts: { window: 'auto', pad: 1.5, clipSigma: 4, trimMinutes: 30, binTo: 0, durations: 2.5 } };
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const segName = (p) => (p.mission === 'TESS' ? `S${p.sector}` : p.mission === 'K2' ? `C${p.campaign}` : p.quarter != null ? `Q${p.quarter}` : p.name);

  function show(parts, info = {}) {
    S.parts = parts; S.info = { ...S.info, ...info }; S.prep = null;
    render();
    if (!S.planets.length && (S.info.tic || S.info.name)) lookup().catch(() => {});
  }

  function render() {
    el.innerHTML = ''; el.hidden = false;
    const parts = S.parts, n = parts.reduce((a, p) => a + p.t.length, 0);
    const cRaw = h('canvas', { id: 'serRaw' });
    const cell = (p) => [segName(p) + (p.name && p.name !== segName(p) ? ` · ${p.name.length > 38 ? p.name.slice(0, 36) + '…' : p.name}` : ''), p.source === 'target pixel file' ? `pixels, ${p.aperture} (${p.npix} px)` : (p.author || 'file'), p.fluxColumn || (p.correction ? p.correction.method : 'aperture sum'),
      p.exptime ? (p.exptime >= 60 ? `${(p.exptime / 60).toFixed(p.exptime % 60 ? 1 : 0)} min` : `${p.exptime.toFixed(0)} s`) : '—', p.t.length, fmt(p.t[p.t.length - 1] - p.t[0]), p.correction ? `${fmt(p.correction.before, 0)} → ${fmt(p.correction.after)}` : '—'];
    const table = h('table', {}, h('thead', {}, h('tr', {}, ['part', 'from', 'flux', 'cadence', 'points', 'span [d]', 'CDPP [ppm]'].map((x) => h('th', {}, x)))), h('tbody', {}, parts.map((p) => h('tr', {}, cell(p).map((x) => h('td', {}, x))))));
    el.append(h('h2', {}, `${S.info.name || 'Light curves'}: ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}, ${n.toLocaleString()} cadences`),
      h('div', { class: 'card tried' }, h('div', { class: 'scroll xscroll' }, table)),
      h('div', { class: 'card', style: 'margin-top:10px;padding:6px' }, cRaw),
      prepCard(), h('div', { id: 'serRes' }));
    drawRaw(cRaw);
    if (S.prep) renderPrep();
  }

  function drawRaw(cv) {
    const all = [], col = [PHOT_THEME.data, PHOT_THEME.model, PHOT_THEME.star, PHOT_THEME.ok, PHOT_THEME.post, PHOT_THEME.warn];
    const xs = [], series = [];
    S.parts.forEach((p, k) => { const m = medianOf(p.f); for (let i = 0; i < p.t.length; i++) { xs.push(p.t[i]); all.push({ k, y: p.f[i] / m }); } });
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]), x = Float64Array.from(order, (i) => xs[i]);
    S.parts.forEach((p, k) => series.push({ y: Float64Array.from(order, (i) => (all[i].k === k ? all[i].y : NaN)), color: col[k % col.length], kind: 'dots' }));
    const g = fitCanvas(cv, 260), off = Math.floor(x[0] || 0);
    renderPanel(g.ctx, g.W, g.H, { x, series, xOffset: off, xLabel: `BJD_TDB − ${off}`, yLabel: 'flux / median of its part', title: 'Each part over its own median (stitched)' }, PHOT_THEME);
  }

  // ------------------------------------------------------------------------------------- planets and options
  function prepCard() {
    const O = S.opts, num = (k, v) => { const x = parseFloat(v); if (Number.isFinite(x)) O[k] = x; };
    const rows = S.planets.map((p, i) => h('tr', {}, h('td', {}, h('input', { type: 'checkbox', checked: p.use !== false, 'aria-label': `Mask ${p.name}`, onchange: (e) => { p.use = e.target.checked; } })), h('td', {}, p.name), h('td', {}, fmt(p.per, 6)), h('td', {}, fmt(p.tmid, 5)), h('td', {}, fmt(24 * p.t14, 2) + (p.t14Source ? ` (${p.t14Source})` : '')), h('td', {}, p.source || ''), h('td', {}, h('button', { class: 'btn sm', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => { S.planets.splice(i, 1); render(); } }, '✕'))));
    const inp = (id, ph, lab) => h('input', { type: 'text', id, placeholder: ph, 'aria-label': lab, inputmode: 'decimal', autocomplete: 'off', style: 'width:9em' });
    return h('div', { class: 'card', id: 'prepCard', style: 'margin-top:10px;padding:10px 12px' },
      h('h2', {}, 'Prepare for transit fitting'),
      h('p', { class: 'hint' }, 'The owner\'s TOI extraction (EXOTIC, toi-3planet): every known transit is masked out of the trend, each sector is flattened with a time-windowed biweight (wotan), outliers beyond 4σ of a 30-minute smooth are clipped (never in transit), 30 minutes after each gap are dropped, and a window of ±2.5 T14 is cut around every transit. With "auto" the window length is chosen per sector by injecting transits of the longest duration and keeping the best recovered depth per unit noise.'),
      h('div', { class: 'tried', style: 'margin-top:4px;padding:0' }, h('table', { id: 'planetTable' }, h('thead', {}, h('tr', {}, ['mask', 'planet', 'P [d]', 'T0 [BJD_TDB]', 'T14 [h]', 'from', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))),
      S.planets.length ? null : h('p', { class: 'hint', style: 'margin-top:6px' }, 'No planet yet: look them up, or type one (without a planet the flatten has nothing to protect).'),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', id: 'bLookup', onclick: () => lookup().catch((err) => ctx.setStatus('stPrep', String(err.message || err), 'err')) }, 'Look up planets and TOIs'),
        inp('npName', 'name', 'Planet name'), inp('npPer', 'P [d]', 'Period in days'), inp('npT0', 'T0 [BJD]', 'Mid-transit time, BJD_TDB'), inp('npT14', 'T14 [h]', 'Transit duration in hours'),
        h('button', { class: 'btn sm', id: 'bAddPlanet', onclick: () => { const v = (id) => parseFloat($(id).value); const per = v('npPer'), tmid = v('npT0'), t14 = v('npT14') / 24; if (!(per > 0) || !Number.isFinite(tmid)) { ctx.setStatus('stPrep', 'A planet needs a period and a mid-transit time (BJD_TDB).', 'err'); return; } S.planets.push({ name: $('npName').value.trim() || `planet ${S.planets.length + 1}`, per, tmid: tmid < 2.4e6 && tmid > 1000 && tmid < 5000 ? tmid + 2457000 : tmid, t14: t14 > 0 ? t14 : NaN, t14Source: t14 > 0 ? 'typed' : '', source: 'typed', use: true }); render(); } }, 'Add')),
      h('div', { class: 'grid2', style: 'margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' },
        h('label', { title: 'Length of the biweight window. auto: chosen per sector by injected transits (EXOTIC optimize_window).' }, 'Trend window', h('select', { id: 'pWin', onchange: (e) => { O.window = e.target.value === 'auto' ? 'auto' : +e.target.value; } }, ...['auto', 0.5, 0.75, 1, 1.5, 2, 3, 4, 6].map((w) => h('option', { value: w, selected: String(O.window) === String(w) }, w === 'auto' ? 'auto (injection test)' : `${w} d`)))),
        h('label', { title: 'Points within pad × T14 / 2 of a transit are left out of the trend.' }, 'Mask ± T14/2 ×', h('input', { type: 'number', id: 'pPad', step: 0.1, min: 1, value: O.pad, onchange: (e) => num('pad', e.target.value) })),
        h('label', {}, 'Clip at σ', h('input', { type: 'number', id: 'pClip', step: 0.5, min: 2, value: O.clipSigma, onchange: (e) => num('clipSigma', e.target.value) })),
        h('label', { title: 'Cadences dropped after each gap longer than an hour (thermal settling) and at the start.' }, 'Trim after gaps [min]', h('input', { type: 'number', id: 'pTrim', step: 10, min: 0, value: O.trimMinutes, onchange: (e) => num('trimMinutes', e.target.value) })),
        h('label', { title: 'Bin to a common cadence after the clip (EXOTIC fit_cadence_s): 20 s and 2 min carry the same photons.' }, 'Bin to', h('select', { id: 'pBin', onchange: (e) => { O.binTo = +e.target.value; } }, ...[[0, 'native cadence'], [120, '2 min'], [600, '10 min'], [1800, '30 min']].map(([v, l]) => h('option', { value: v, selected: O.binTo === v }, l)))),
        h('label', {}, 'Window half-width × T14', h('input', { type: 'number', id: 'pDur', step: 0.5, min: 1, value: O.durations, onchange: (e) => num('durations', e.target.value) }))),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', id: 'bPrepare', onclick: () => prepare().catch((err) => ctx.setStatus('stPrep', String(err.message || err), 'err')) }, 'Prepare'), h('span', { class: 'status', id: 'stPrep', style: 'margin:0' })));
  }

  /** Known planets of the host and TOIs of the TIC (not already known by period). */
  async function lookup() {
    ctx.setStatus('stPrep', 'Looking up the catalogue and the TOI list…');
    const root = ctx.siteRoot(), fj = (nm) => siteJson(new URL('catalog/' + nm, root), "The site's catalogue"), found = [];
    try {
      const idx = await loadIndex(fj), names = [S.info.name, S.info.tic ? 'TIC ' + S.info.tic : null, S.info.kic ? 'KIC ' + S.info.kic : null, S.info.epic ? 'EPIC ' + S.info.epic : null, S.info.object].filter(Boolean);
      let host = null; for (const nm of names) { try { host = await lookupHost(idx, nm, fj); } catch { host = null; } if (host) break; }
      if (host) { const sys = systemFromRows(host.rows); for (const p of sys.planets) { const v = (k) => (p.values[k] ? p.values[k].value : NaN); if (!(v('per') > 0) || !Number.isFinite(v('tmid'))) continue; found.push({ name: p.planet || p.name, per: v('per'), tmid: v('tmid'), t14: v('t14'), rprs: v('rprs'), ars: v('ars'), inc: v('inc'), ecc: v('ecc') || 0, omega: v('omega') || 0, t14Source: p.values.t14 ? 'catalogue' : '', source: 'archive', use: true }); } }
    } catch { /* no catalogue on this server */ }
    if (S.info.tic) {
      try { for (const r of await toiRecords(ctx.siteRoot())) { if (+r.info.tic !== +S.info.tic || !(r.v.per > 0) || /False/.test(r.v.status || '')) continue; if (found.some((q) => Math.abs(q.per / r.v.per - 1) < 0.01)) continue; found.push({ name: r.name, per: r.v.per, tmid: r.v.tmid, t14: r.v.t14, t14Source: 'TOI', source: `TOI (${r.v.status})`, use: true, depth: r.v.depth }); } } catch { /* no TOI table */ }
    }
    for (const q of found) if (!S.planets.some((p) => p.name === q.name)) S.planets.push(q);
    render();
    ctx.setStatus('stPrep', found.length ? `${found.length} planet${found.length > 1 ? 's' : ''} found: ${found.map((q) => q.name).join(', ')}.` : 'No planet with an ephemeris in the catalogue or the TOI list for this star: type one.', found.length ? 'ok' : 'err');
    return found;
  }

  async function prepare(over = {}) {
    if (!S.parts.length) throw new Error('Load light curves first.');
    Object.assign(S.opts, over);
    const planets = S.planets.filter((p) => p.use !== false).map(({ name, per, tmid, t14, rprs, ars, inc, ecc, omega }) => ({ name, per, tmid, t14, rprs, ars, inc, ecc, omega }));
    ctx.setStatus('stPrep', 'Preparing…'); $('bPrepare').disabled = true; const t0 = performance.now();
    try {
      S.prep = await ctx.call({ type: 'prep', parts: S.parts, planets, opts: S.opts }, (m) => { if (m.stage === 'part') ctx.setStatus('stPrep', `Sector ${m.done + 1} of ${m.total}: ${m.name}${S.opts.window === 'auto' ? ' (choosing the window by injection)' : ''}…`); });
      renderPrep();
      ctx.setStatus('stPrep', `${S.prep.n.toLocaleString()} points, ${S.prep.windows.length} transit windows, in ${((performance.now() - t0) / 1000).toFixed(1)} s.`, 'ok');
    } finally { $('bPrepare').disabled = false; }
    return S.prep;
  }

  function renderPrep() {
    const R = S.prep, box = $('serRes'); if (!R || !box) return; box.innerHTML = '';
    const c1 = h('canvas'), c2 = h('canvas');
    box.append(h('div', { class: 'card', style: 'margin-top:10px;padding:6px' }, c1, c2),
      h('div', { class: 'card tried' }, h('h2', {}, 'Per sector'), h('div', { class: 'scroll xscroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['part', 'points', 'trimmed', 'clipped', 'window [d]', 'recovered', 'scatter [ppm]', '30-min [ppm]', 'CDPP before → after [ppm]'].map((x) => h('th', {}, x)))),
        h('tbody', {}, R.perPart.map((p) => h('tr', {}, p.skipped ? [p.name, p.skipped, '', '', '', '', '', '', ''].map((x) => h('td', {}, x)) : [p.name.length > 40 ? p.name.slice(0, 38) + '…' : p.name, p.n, p.trimmed, p.clipped, String(p.window), p.scan && p.scan[p.window] ? `${(100 * p.scan[p.window].depth_recovered).toFixed(0)}%` : '—', fmt(p.scatterPpm, 0), fmt(p.scatter30Ppm * 1, 0), `${fmt(p.cdppRaw, 0)} → ${fmt(p.cdppFlat)}`].map((x) => h('td', {}, x)))))))),
      h('div', { class: 'card tried' }, h('h2', {}, `Transit windows (${R.windows.length})`), h('div', { class: 'scroll xscroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['planet', 'epoch', 'T predicted', 'points', 'before / in / after', 'covered', 'overlaps'].map((x) => h('th', {}, x)))),
        h('tbody', {}, R.windows.map((w) => h('tr', {}, [w.planet, w.epoch, w.tc.toFixed(5), w.n, `${w.before} / ${w.during} / ${w.after}`, `${Math.min(100, 100 * w.coverage).toFixed(0)}%`, w.overlaps.join(', ') || '—'].map((x) => h('td', {}, x)))))))),
      h('div', { class: 'out' },
        h('button', { class: 'btn primary', id: 'bSendWin', onclick: () => send('windows') }, 'Open the transit windows in Analyze'),
        h('button', { class: 'btn', id: 'bSendAll', onclick: () => send('all') }, 'Open the whole flattened light curve'),
        h('button', { class: 'btn', onclick: () => ctx.download(preparedCsv(R), 'text/csv', ctx.stem() + '_prepared.csv') }, 'Save CSV'),
        h('button', { class: 'btn', onclick: () => ctx.download(makeZip(windowCsvs(R).map((q) => ({ name: q.name, data: q.text }))), 'application/zip', ctx.stem() + '_transits.zip') }, 'Save each transit (zip of CSVs)'),
        h('button', { class: 'btn', onclick: () => ctx.download(JSON.stringify(record(), null, 1), 'application/json', ctx.stem() + '_preparation.json') }, 'Save the settings (JSON)')),
      h('p', { class: 'note2' }, 'The windows go to the analyzer as one light curve in BJD_TDB; give each transit its own baseline there with "Split by orbit" (Data tab). Errors are the pipeline\'s divided by the trend, or the per-sector 30-minute scatter when the file has none.'));
    const x = R.t, off = Math.floor(x[0]), th = PHOT_THEME;
    let g = fitCanvas(c1, 220); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: R.raw, color: th.data, kind: 'dots', mask: Uint8Array.from(R.masked, (v) => 1 - v) }, { y: Float64Array.from(R.trend, (v, i) => (i && R.segment[i] !== R.segment[i - 1] ? NaN : v)), color: th.warn, kind: 'line', label: 'biweight trend (transits masked)' }], xOffset: off, yLabel: 'flux', title: 'Before: the flux of each part and its trend' }, th);
    const inWin = new Uint8Array(R.n); for (const w of R.windows) for (const i of w.idx) inWin[i] = 1;
    g = fitCanvas(c2, 220); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: R.f, color: th.data, kind: 'dots', mask: inWin, alpha: 0.9 }, { y: Float64Array.from(R.f, (v, i) => (R.inTransit[i] ? v : NaN)), color: th.model, kind: 'dots', label: 'in transit' }], xOffset: off, xLabel: `BJD_TDB − ${off}`, yLabel: 'relative flux', title: 'After: flattened (faint: outside the transit windows)' }, th);
  }

  function record() {
    const R = S.prep;
    return { software: 'Exoplanet Science Lab photometry', method: 'per-sector transit-masked biweight flatten (wotan), EXOTIC clip and trim, windows of ±k T14 (EXOTIC toi1873_extract)', target: S.info, created: new Date().toISOString(), options: S.opts,
      planets: R ? R.planets : S.planets, parts: S.parts.map((p) => ({ name: p.name, mission: p.mission, sector: p.sector, quarter: p.quarter, campaign: p.campaign, source: p.source, author: p.author, fluxColumn: p.fluxColumn, aperture: p.aperture, exptime: p.exptime, points: p.t.length, correction: p.correction, thrusters: p.thrusters })),
      perSector: R ? R.perPart : null, windows: R ? R.windows.map((w) => ({ planet: w.planet, epoch: w.epoch, tc: w.tc, points: w.n, overlaps: w.overlaps })) : null, droppedDuplicates: R ? R.dropped : null };
  }

  /** The analyzer's hand-off record (the same shape the page's own "Open in Analyze" writes). */
  function handoff(which = 'windows') {
    const R = S.prep; if (!R) throw new Error('Prepare the light curve first.');
    const text = preparedCsv(R, { windowsOnly: which === 'windows' }), pl = R.planets[0];
    const ex = S.parts.map((p) => p.exptime).filter((v) => v > 0), exs = ex.length ? medianOf(ex) : null;
    return { kind: 'lightcurve', name: `${S.info.name || ctx.name()}${which === 'windows' ? ` · ${R.windows.length} transits` : ' · flattened'}`, text, source: 'photometry', version: 'prep-1', exptime: exs, exptimeDays: exs ? exs / 86400 : null, target: S.info.name || null, ra: S.parts[0] && S.parts[0].ra, dec: S.parts[0] && S.parts[0].dec, timeSystem: 'BJD_TDB',
      planet: pl ? { name: pl.name, per: pl.per, tmid: pl.tmid, t14: pl.t14, rprs: pl.rprs ?? null, ars: pl.ars ?? null, inc: pl.inc ?? null } : null,
      // per-row transit window (rows of `text`), for an analyzer that splits them into epochs; and the cadences, which differ between sectors
      epochs: which === 'windows' ? { names: R.windows.map((w) => `${w.planet} E${w.epoch}`), note: 'the CSV column "epoch" is the index into names' } : null, cadences: [...new Set(ex)], preparation: record() };
  }
  function send(which) {
    try { localStorage.setItem('esl.handoff', JSON.stringify(handoff(which))); } catch { ctx.setStatus('stPrep', 'Could not hand the light curve over (storage is full or blocked): save the CSV and open it in Analyze.', 'err'); return; }
    location.href = new URL('analyze/?handoff=1', ctx.siteRoot()).href;
  }

  function state() {
    const R = S.prep;
    return { parts: S.parts.map((p) => ({ name: p.name, mission: p.mission, segment: segName(p), source: p.source, cadence_s: p.exptime, points: p.t.length, aperture: p.aperture || null, flux: p.fluxColumn || null, correction: p.correction || null })),
      planets: S.planets.map((p) => ({ name: p.name, per: p.per, tmid: p.tmid, t14_h: Number.isFinite(p.t14) ? +(24 * p.t14).toFixed(3) : null, mask: p.use !== false, source: p.source })), options: S.opts,
      prepared: R ? { points: R.n, windows: R.windows.length, per_sector: R.perPart.map((p) => (p.skipped ? { name: p.name, skipped: p.skipped } : { name: p.name, window_d: p.window, scatter_ppm: Math.round(p.scatterPpm), cdpp_before_ppm: +p.cdppRaw.toFixed(1), cdpp_after_ppm: +p.cdppFlat.toFixed(1), clipped: p.clipped, trimmed: p.trimmed })), overlaps: R.windows.filter((w) => w.overlaps.length).map((w) => `${w.planet} E${w.epoch}: ${w.overlaps.join(', ')}`) } : null };
  }
  return { show, render, lookup, prepare, send, handoff, state, S };
}
