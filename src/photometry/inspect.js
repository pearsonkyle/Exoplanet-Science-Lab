// Image examination tools of the photometry page, in the spirit of DS9 and IRAF's imexam: a radial profile with
// FWHM, half-flux diameter and curve of growth for the star you click; a line cut; region statistics; the focus
// across the field; the FITS header. The science is in src/core/imexam.js; this file is the panel and the overlay.
import { radialProfile, lineProfile, regionStats, pixelTable, psfShape, focusMap, saturationLevel } from '../core/imexam.js';
import { fitPsf } from '../core/photometry.js';
import { pixelScale } from '../core/fits.js';
import { renderPanel, fitCanvas, PHOT_THEME, PHOT_DARK } from './plots.js';   // PHOT_DARK: marks on the image

export const TOOLS = [
  { id: 'pick', label: 'Stars', title: 'Pick the target and comparison stars: click a star to add it, click it again to remove it' },
  { id: 'profile', label: 'Profile', title: 'Radial profile of the star you click: FWHM, half-flux diameter, curve of growth, peak and saturation (imexam r and a)' },
  { id: 'cut', label: 'Cut', title: 'Drag a line across the image to plot the pixel values along it' },
  { id: 'region', label: 'Region', title: 'Drag a box to get its mean, median, standard deviation, minimum and maximum' },
  { id: 'focus', label: 'Focus', title: 'Measure every star: FWHM and elongation across the field, with a verdict on focus, tilt and tracking' },
  { id: 'header', label: 'Header', title: 'The FITS header of this frame' },
];

const fx = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const big = (v) => (!Number.isFinite(v) ? '–' : Math.abs(v) >= 1e5 ? v.toExponential(3) : Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(4));
// FWHM colour scale: blue (sharp) through green and yellow to red (soft)
const RAMP = [[95, 160, 255], [95, 212, 255], [111, 227, 165], [255, 197, 107], [255, 107, 122]];
export function rampColor(t, a = 1) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1); const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, c = RAMP[i].map((v, k) => Math.round(v + f * (RAMP[i + 1][k] - v)));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/**
 * @param ctx { P, viewer, h, $, card (element), bar (element), addStar(x, y, asTarget), gain() }
 */
export function createInspector(ctx) {
  const { P, viewer, h, card, bar } = ctx;
  const I = { tool: 'pick', prof: null, cut: null, region: null, focus: null, focusFrame: -1, showFocus: true, grid: 3, filter: '', growth: false };
  const cur = () => P.cur;
  const H = () => (cur() && cur().header) || {};
  const sat = () => saturationLevel(H());
  const scale = () => { const s = pixelScale(H()); return s.scale > 0 ? s.scale : NaN; };
  const arc = (px) => (Number.isFinite(scale()) && Number.isFinite(px) ? ` (${(px * scale()).toFixed(2)}″)` : '');

  // ---- tool bar
  function buildBar() {
    bar.innerHTML = '';
    bar.append(h('span', { class: 'dim tlab' }, 'Tool'), h('div', { class: 'seg', role: 'toolbar', 'aria-label': 'Image tools' }, TOOLS.map((t) => {
      const off = P.mode === 'tpf' && (t.id === 'focus' || t.id === 'header');
      return h('button', { class: 'btn sm' + (I.tool === t.id ? ' on' : ''), title: t.title, 'aria-pressed': I.tool === t.id ? 'true' : 'false', disabled: off, onclick: () => setTool(t.id) }, t.label);
    })));
  }
  function setTool(id) {
    I.tool = id; buildBar(); render(); viewer.draw();
    viewer.cv.style.cursor = id === 'cut' || id === 'region' ? 'cell' : 'crosshair';
    if (id === 'focus' && (!I.focus || I.focusFrame !== P.frame)) setTimeout(measureFocus, 0);
  }
  viewer.dragTool = () => I.tool === 'cut' || I.tool === 'region';
  viewer.onDrag = (x0, y0, x1, y1, phase) => {
    const c = cur(); if (!c) return;
    if (I.tool === 'cut') I.cut = { x0, y0, x1, y1, lp: lineProfile(c.data, c.width, c.height, x0, y0, x1, y1, 0.5) };
    else I.region = { x0, y0, x1, y1, st: regionStats(c.data, c.width, c.height, { shape: 'box', x0, y0, x1, y1 }) };
    viewer.draw(); if (phase === 'end' || I.tool === 'region') render(); else renderCutPlot();
  };

  // ---- profile
  function examine(x, y) {
    const c = cur(); if (!c) return;
    const g = Number(ctx.gain && ctx.gain()) || Number(H().GAIN ?? H().EGAIN) || 1;
    const guess = I.prof ? I.prof.rmax : 12;
    let r = radialProfile(c.data, c.width, c.height, x, y, { rmax: guess, gain: g, saturation: sat().level });
    // size the radius to the star: about 3 FWHM, between 6 and 30 px
    const want = Math.max(6, Math.min(30, Math.round(3 * (r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm))));
    if (Number.isFinite(want) && Math.abs(want - guess) > 2) r = radialProfile(c.data, c.width, c.height, r.x, r.y, { rmax: want, gain: g, saturation: sat().level, recentre: false });
    const half = Math.max(5, Math.min(25, Math.round(2 * (r.gaussian.fwhm || 3))));
    const f = fitPsf(c.data, c.width, c.height, r.x, r.y, half, { model: 'gaussian', rotate: true, sigma: (r.gaussian.sigma || 2) });
    I.prof = { ...r, rmax: r.growth.r[r.growth.r.length - 1], shape: f.ok ? psfShape(f) : null, table: pixelTable(c.data, c.width, c.height, r.x, r.y, 2), frame: P.frame };
    render(); viewer.draw();
    // a one-line answer next to the image, since on a phone the panel is below it
    if (ctx.note) ctx.note(`FWHM ${fx(r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm)} px${arc(r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm)} · HFD ${fx(r.hfd)} px · peak ${r.saturated ? 'SATURATED' : big(r.peak)}${matchMedia('(max-width: 980px)').matches ? ' · details below' : ''}`);
  }

  // ---- focus
  function measureFocus() {
    const c = cur(); if (!c || P.mode !== 'stack') return;
    const t0 = performance.now();
    I.focus = focusMap(c.data, c.width, c.height, { nx: I.grid, ny: I.grid, saturation: sat().level, pixelScale: scale() });
    I.focus.ms = performance.now() - t0; I.focusFrame = P.frame;
    if (ctx.note) { const S = I.focus.summary; ctx.note(`${S.n} stars · median FWHM ${fx(S.fwhm)} px · ${S.verdict[0]}`); }
    render(); viewer.draw();
  }

  // ---- clicks from the viewer: true when the inspector used the click
  function click(x, y) {
    if (I.tool === 'profile') { examine(x, y); return true; }
    if (I.tool === 'focus' && I.focus) { const s = I.focus.stars.reduce((b, q) => (Math.hypot(q.x - x, q.y - y) < Math.hypot(b.x - x, b.y - y) ? q : b), I.focus.stars[0]); if (s && Math.hypot(s.x - x, s.y - y) < 15) { I.tool = 'profile'; buildBar(); examine(s.x, s.y); } return true; }
    if (I.tool === 'cut' || I.tool === 'region' || I.tool === 'header') return true;
    return false;
  }

  // ---- overlay
  function draw(c, v) {
    c.save();
    if (I.tool === 'profile' && I.prof && I.prof.frame === P.frame) {
      const [sx, sy] = v.toScreen(I.prof.x, I.prof.y);
      c.strokeStyle = PHOT_DARK.ok; c.lineWidth = 1.5; c.beginPath(); c.arc(sx, sy, I.prof.rmax * v.scale, 0, 6.2832); c.stroke();
      c.setLineDash([4, 4]); c.lineWidth = 1; for (const r of [I.prof.rmax + 2, I.prof.rmax + 8]) { c.beginPath(); c.arc(sx, sy, r * v.scale, 0, 6.2832); c.stroke(); } c.setLineDash([]);
      if (Number.isFinite(I.prof.hfd)) { c.strokeStyle = PHOT_DARK.star; c.beginPath(); c.arc(sx, sy, I.prof.hfd / 2 * v.scale, 0, 6.2832); c.stroke(); }
    }
    if (I.tool === 'cut' && I.cut) {
      const [ax, ay] = v.toScreen(I.cut.x0, I.cut.y0), [bx, by] = v.toScreen(I.cut.x1, I.cut.y1);
      c.strokeStyle = PHOT_DARK.ok; c.lineWidth = 1.5; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.fillStyle = PHOT_DARK.ok; c.beginPath(); c.arc(ax, ay, 3.5, 0, 6.2832); c.fill();
    }
    if (I.tool === 'region' && I.region) {
      const [ax, ay] = v.toScreen(Math.min(I.region.x0, I.region.x1), Math.max(I.region.y0, I.region.y1)), [bx, by] = v.toScreen(Math.max(I.region.x0, I.region.x1), Math.min(I.region.y0, I.region.y1));
      c.strokeStyle = PHOT_DARK.ok; c.lineWidth = 1.5; c.strokeRect(ax, ay, bx - ax, by - ay); c.fillStyle = '#6fe3a514'; c.fillRect(ax, ay, bx - ax, by - ay);
    }
    if (I.tool === 'focus' && I.focus && I.showFocus && I.focusFrame === P.frame) {
      const F = I.focus, [lo, hi] = focusRange(F);
      c.strokeStyle = '#ffffff22'; c.lineWidth = 1;
      for (const cl of F.cells) { const [ax, ay] = v.toScreen(cl.x0 - 0.5 + 0.5, cl.y1 - 0.5), [bx, by] = v.toScreen(cl.x1 - 0.5, cl.y0 - 0.5 + 0.5); c.strokeRect(ax, ay, bx - ax, by - ay); }
      const k = Math.max(2.5, 12 / Math.max(1, F.summary.fwhm)) * v.scale;      // whisker scale: drawn several times the FWHM
      for (const s of F.stars) {
        const [sx, sy] = v.toScreen(s.x, s.y), a = s.angle * Math.PI / 180, col = rampColor((s.fwhm - lo) / (hi - lo || 1));
        c.strokeStyle = col; c.lineWidth = 1.4;
        c.beginPath(); c.ellipse(sx, sy, Math.max(2, s.fwhmMajor / 2 * k * 0.5), Math.max(1.5, s.fwhmMinor / 2 * k * 0.5), -a, 0, 6.2832); c.stroke();
        if (s.ellipticity > 0.08) { const L = 6 + 60 * s.ellipticity, dx = Math.cos(a) * L / 2, dy = -Math.sin(a) * L / 2; c.lineWidth = 2; c.beginPath(); c.moveTo(sx - dx, sy - dy); c.lineTo(sx + dx, sy + dy); c.stroke(); }
      }
      if (F.summary.best) { const [bx, by] = v.toScreen(F.summary.best.x, F.summary.best.y); c.strokeStyle = PHOT_DARK.strong; c.lineWidth = 1.5; c.beginPath(); c.moveTo(bx - 8, by); c.lineTo(bx + 8, by); c.moveTo(bx, by - 8); c.lineTo(bx, by + 8); c.stroke(); }
    }
    c.restore();
  }
  // colour range: the 5th to 95th percentile, but never narrower than the median +-10%, so an even field stays one colour
  const focusRange = (F) => { const v = F.stars.map((s) => s.fwhm).sort((a, b) => a - b); if (!v.length) return [0, 1]; const q = (p) => v[Math.min(v.length - 1, Math.round(p * (v.length - 1)))], m = q(0.5); return [Math.min(q(0.05), 0.9 * m), Math.max(q(0.95), 1.1 * m)]; };

  // ---- the panel
  const kv = (rows) => h('table', { class: 'kv' }, h('tbody', {}, rows.filter(Boolean).map(([k, v, t]) => h('tr', { title: t || null }, h('th', {}, k), h('td', {}, v)))));
  function render() {
    card.innerHTML = '';
    card.hidden = I.tool === 'pick';
    if (I.tool === 'pick') return;
    const t = TOOLS.find((q) => q.id === I.tool);
    card.append(h('h2', {}, t.label === 'Stars' ? 'Stars' : t.label === 'Profile' ? 'Radial profile' : t.label === 'Cut' ? 'Line cut' : t.label === 'Region' ? 'Region statistics' : t.label === 'Focus' ? 'Focus across the field' : 'FITS header'));
    if (I.tool === 'profile') renderProfile();
    else if (I.tool === 'cut') { if (!I.cut) card.append(h('p', { class: 'hint' }, 'Drag across the image to draw a line. Two fingers (or shift-drag) still pan.')); else { card.append(h('canvas', { class: 'iplot', id: 'iCut' })); renderCutPlot(); const v = I.cut.lp.v.filter(Number.isFinite); card.append(kv([['Length', `${fx(I.cut.lp.length, 1)} px${arc(I.cut.lp.length)}`], ['From', `${fx(I.cut.x0, 1)}, ${fx(I.cut.y0, 1)}`], ['To', `${fx(I.cut.x1, 1)}, ${fx(I.cut.y1, 1)}`], ['Min / max', `${big(Math.min(...v))} / ${big(Math.max(...v))}`]])); } }
    else if (I.tool === 'region') renderRegion();
    else if (I.tool === 'focus') renderFocus();
    else if (I.tool === 'header') renderHeader();
  }
  function renderProfile() {
    const r = I.prof;
    if (!r) { card.append(h('p', { class: 'hint' }, 'Click or tap a star. Its centre is refined, the sky is taken from the dashed annulus, and Gaussian and Moffat profiles are fitted to every pixel.')); return; }
    const cv = h('canvas', { class: 'iplot', 'aria-label': 'Radial profile: pixel values against distance from the centre, with the Gaussian and Moffat fits' }), cg = h('canvas', { class: 'iplot', 'aria-label': 'Curve of growth' });
    card.append(cv);
    requestAnimationFrame(() => {
      if (!cv.isConnected) return;     // the panel was rebuilt before this frame
      const n = r.pixels.r.length, G = 120, xs = new Float64Array(n + G), dots = new Float64Array(n + G).fill(NaN), gl = new Float64Array(n + G).fill(NaN), ml = new Float64Array(n + G).fill(NaN);
      for (let i = 0; i < n; i++) { xs[i] = r.pixels.r[i]; dots[i] = r.pixels.v[i]; }
      for (let j = 0; j < G; j++) { const x = j / (G - 1) * r.rmax; xs[n + j] = x; gl[n + j] = r.gaussian.amp * Math.exp(-0.5 * x * x / (r.gaussian.sigma ** 2)); ml[n + j] = r.moffat.amp * Math.pow(1 + x * x / (r.moffat.gamma ** 2), -r.moffat.beta); }
      let g = fitCanvas(cv, 210); renderPanel(g.ctx, g.W, g.H, { x: xs, series: [{ y: dots, color: PHOT_THEME.data, kind: 'dots', size: 1.3, alpha: 0.6 }, { y: gl, color: PHOT_THEME.model, kind: 'line', label: 'Gaussian' }, { y: ml, color: PHOT_THEME.star, kind: 'line', label: 'Moffat' }], xLabel: 'radius [px]', yLabel: 'counts above sky', title: 'Radial profile' });
      if (I.growth && cg.isConnected) { g = fitCanvas(cg, 150); const tot = r.flux || 1; renderPanel(g.ctx, g.W, g.H, { x: r.growth.r, series: [{ y: Array.from(r.growth.flux, (v) => v / tot), color: PHOT_THEME.ok, kind: 'line' }], xLabel: 'aperture radius [px]', yLabel: 'fraction of flux', title: 'Curve of growth', yRange: [0, 1.08] }); }
    });
    const s = sat(), pk = s.level < Infinity ? r.peak / s.level : NaN, sh = r.shape;
    card.append(...[
      r.saturated ? h('p', { class: 'warnline' }, `Saturated: the peak ${big(r.peak)} is at the ${s.source === 'BITPIX' ? 'limit of the integer format' : s.source + ' level'} (${big(s.level)}). Do not use this star for photometry.`) : pk > 0.8 ? h('p', { class: 'warnline' }, `Peak at ${(100 * pk).toFixed(0)}% of saturation (${big(s.level)}): likely non-linear.`) : null,
      kv([
        ['Centre', `${fx(r.x, 2)}, ${fx(r.y, 2)}`],
        ['FWHM (Moffat)', `${fx(r.moffat.fwhm)} px${arc(r.moffat.fwhm)}, β ${r.moffat.beta > 10 ? '> 10 (Gaussian-like)' : fx(r.moffat.beta, 2)}`, 'Moffat a (1 + r²/γ²)^-β fitted to every pixel; FWHM = 2γ √(2^(1/β) − 1)'],
        ['FWHM (Gaussian)', `${fx(r.gaussian.fwhm)} px${arc(r.gaussian.fwhm)}`, 'Gaussian fitted to every pixel; 2.3548 σ'],
        ['Half-flux diameter', `${fx(r.hfd)} px${arc(r.hfd)}`, 'Diameter holding half the flux inside the outer circle: the focusing number, robust to the profile shape (yellow circle)'],
        sh ? ['Elongation', `${(100 * sh.ellipticity).toFixed(1)}% at ${sh.angle.toFixed(0)}° from +x`, 'Rotated Gaussian fit: 1 − minor/major axis, and the direction of the major axis'] : null,
        ['Peak', `${big(r.peak)}${Number.isFinite(pk) ? ` (${(100 * pk).toFixed(0)}% of saturation)` : ''}`],
        ['Sky', `${big(r.background)} ± ${big(r.backgroundSigma)} per px`, 'Sigma-clipped median and standard deviation of the dashed annulus'],
        ['Flux inside ' + fx(r.rmax, 0) + ' px', big(r.flux)],
        ['80% of the flux within', `${fx(r.r80)} px`],
        ['Signal to noise', fx(r.snr, 0), 'Flux / √(flux/gain + area × sky σ²) for the outer circle, with the gain from Settings or the header (1 when unknown)'],
      ]),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm primary', onclick: () => ctx.addStar(r.x, r.y, true) }, 'Use as target'),
        h('button', { class: 'btn sm', onclick: () => ctx.addStar(r.x, r.y, false) }, 'Add as comparison'),
        h('button', { class: 'btn sm' + (I.growth ? ' on' : ''), onclick: () => { I.growth = !I.growth; render(); } }, 'Curve of growth')),
      I.growth ? cg : null,
      h('details', { class: 'ptab' }, h('summary', {}, 'Pixel values around the centre'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'y \\ x'), r.table.xs.map((x) => h('th', {}, String(x))))), h('tbody', {}, r.table.rows.map((row, j) => h('tr', {}, h('th', {}, String(r.table.ys[j])), row.map((v, i) => h('td', { class: i === 2 && j === 2 ? 'mid' : null }, big(v))))))))].filter(Boolean));
  }
  function renderCutPlot() {
    const cv = document.getElementById('iCut'); if (!cv || !I.cut) return;
    const g = fitCanvas(cv, 190); renderPanel(g.ctx, g.W, g.H, { x: I.cut.lp.s, series: [{ y: I.cut.lp.v, color: PHOT_THEME.ok, kind: 'line' }], xLabel: 'distance along the line [px]', yLabel: 'counts', title: 'Pixel values along the line' });
  }
  function renderRegion() {
    if (!I.region) { card.append(h('p', { class: 'hint' }, 'Drag a box on the image. Pixels whose centres fall inside are used.')); return; }
    const R = I.region, s = R.st;
    card.append(kv([
      ['Box', `x ${fx(Math.min(R.x0, R.x1), 0)}–${fx(Math.max(R.x0, R.x1), 0)}, y ${fx(Math.min(R.y0, R.y1), 0)}–${fx(Math.max(R.y0, R.y1), 0)}`],
      ['Pixels', `${s.n}${s.nan ? ` (+${s.nan} blank)` : ''}`],
      ['Mean', big(s.mean)], ['Median', big(s.median)], ['Standard deviation', big(s.std)],
      ['Clipped mean / median / σ', `${big(s.clipped.mean)} / ${big(s.clipped.median)} / ${big(s.clipped.std)}`, '3σ-clipped, iterated: the sky level and noise of a star-free box'],
      ['Min / max', `${big(s.min)} / ${big(s.max)}`], ['Sum', big(s.sum)],
    ]));
  }
  function renderFocus() {
    if (P.mode !== 'stack') { card.append(h('p', { class: 'hint' }, 'The focus map needs an image with many stars.')); return; }
    const F = I.focus;
    card.append(h('div', { class: 'row' },
      h('button', { class: 'btn sm primary', onclick: measureFocus }, F && I.focusFrame === P.frame ? 'Measure again' : 'Measure this frame'),
      h('label', { class: 'dim', style: 'display:inline-flex;gap:4px;align-items:center' }, 'Grid', h('select', { onchange: (e) => { I.grid = +e.target.value; measureFocus(); } }, [2, 3, 4, 5].map((n) => h('option', { value: n, selected: n === I.grid }, `${n} × ${n}`)))),
      h('label', { class: 'dim', style: 'display:inline-flex;gap:4px;align-items:center' }, h('input', { type: 'checkbox', checked: I.showFocus, onchange: (e) => { I.showFocus = e.target.checked; viewer.draw(); } }), 'on image')));
    if (!F) { card.append(h('p', { class: 'hint' }, 'Measuring…')); return; }
    if (I.focusFrame !== P.frame) card.append(h('p', { class: 'warnline' }, `Measured on frame ${I.focusFrame + 1}; this is frame ${P.frame + 1}.`));
    const S = F.summary, [lo, hi] = focusRange(F);
    card.append(h('ul', { class: 'verdict' }, S.verdict.map((v) => h('li', {}, v))));
    // the grid of cells, as a small map
    const cv = h('canvas', { class: 'iplot', 'aria-label': 'Median FWHM in each cell of the field' }); card.append(cv);
    requestAnimationFrame(() => {
      if (!cv.isConnected) return;
      const nx = I.grid, ny = I.grid, img = cur(), g = fitCanvas(cv, Math.min(220, Math.round((cv.clientWidth || 280) * img.height / img.width) + 22)), c = g.ctx;
      c.fillStyle = PHOT_THEME.bg; c.fillRect(0, 0, g.W, g.H);
      const W = g.W - 54, Hh = g.H - 22, cw = W / nx, ch = Hh / ny;
      c.font = PHOT_THEME.font; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const cl of F.cells) {
        const x = cl.ix * cw, y = (ny - 1 - cl.iy) * ch;
        c.fillStyle = cl.n ? rampColor((cl.fwhm - lo) / (hi - lo || 1), 0.55) : '#1e2638'; c.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        c.fillStyle = PHOT_THEME.strong; c.fillText(cl.n ? fx(cl.fwhm) : '–', x + cw / 2, y + ch / 2 - (cl.n && ch > 34 ? 7 : 0));
        if (cl.n && ch > 34) { c.fillStyle = PHOT_THEME.text; c.fillText(`${cl.n}★ e ${fx(cl.ellipticity, 2)}`, x + cw / 2, y + ch / 2 + 8); }
        if (cl.n && cl.ellipticity > 0.08) { const a = cl.angle * Math.PI / 180, L = Math.min(cw, ch) * 0.35, dx = Math.cos(a) * L, dy = -Math.sin(a) * L, ox = x + cw / 2, oy = y + ch / 2; c.strokeStyle = '#ffffff55'; c.lineWidth = 1; c.beginPath(); c.moveTo(ox - dx, oy - dy); c.lineTo(ox + dx, oy + dy); c.stroke(); }
      }
      // colour bar
      for (let j = 0; j < Hh; j++) { c.fillStyle = rampColor(1 - j / Hh); c.fillRect(W + 12, j, 10, 1); }
      c.textAlign = 'left'; c.fillStyle = PHOT_THEME.text; c.fillText(fx(hi, 1), W + 25, 6); c.fillText(fx(lo, 1), W + 25, Hh - 6);
      c.textAlign = 'left'; c.fillText('median FWHM per cell [px], y up', 2, g.H - 9);
    });
    card.append(kv([
      ['Stars measured', `${S.n} (unsaturated, isolated)${F.ms ? `, ${F.ms.toFixed(0)} ms` : ''}`],
      ['Median FWHM', `${fx(S.fwhm)} px${arc(S.fwhm)}`],
      ['Centre / corners', `${fx(S.fwhmCentre)} / ${S.fwhmCorners.map((v) => fx(v)).join(', ')} px`, 'Centre cell, then the lower-left, lower-right, upper-left and upper-right cells'],
      ['Corners softer by', Number.isFinite(S.curvature) ? `${(100 * S.curvature).toFixed(0)}%` : '–', 'Mean corner FWHM against the centre: field curvature or off-axis aberration'],
      ['Corner spread', Number.isFinite(S.tilt) ? `${(100 * S.tilt).toFixed(0)}%${S.worstCorner ? ', worst ' + S.worstCorner : ''}` : '–', 'Largest minus smallest corner FWHM, over the centre: sensor tilt or an off-centre optical axis'],
      ['Median elongation', `${(100 * S.ellipticity).toFixed(1)}%`],
      ['Same direction', Number.isFinite(S.coherence) ? `${(100 * S.coherence).toFixed(0)}% at ${S.angle.toFixed(0)}°` : '–', '100% when every star is stretched the same way (tracking, guiding, wind), near 0 when directions vary (optics)'],
      S.best ? ['Sharpest point', `${fx(S.best.x, 0)}, ${fx(S.best.y, 0)} (white cross)`, 'Minimum of the quadratic FWHM surface fitted to all stars'] : null,
    ]), h('p', { class: 'hint', style: 'margin-top:6px' }, 'Ellipses are drawn scaled up, coloured by FWHM; bars show the direction of elongation. Tap a star to see its profile.'));
  }
  function renderHeader() {
    const hd = H(), cm = (cur() && cur().comments) || {}, keys = Object.keys(hd);
    const inp = h('input', { type: 'search', placeholder: 'Filter keywords', value: I.filter, 'aria-label': 'Filter header keywords', oninput: (e) => { I.filter = e.target.value; fill(); } });
    const tb = h('tbody'), fill = () => { tb.innerHTML = ''; const f = I.filter.trim().toUpperCase(); for (const k of keys) { const v = String(hd[k]); if (f && !k.includes(f) && !v.toUpperCase().includes(f)) continue; tb.append(h('tr', { title: cm[k] || null }, h('th', {}, k), h('td', {}, v))); } };
    fill();
    card.append(h('p', { class: 'hint' }, `${keys.length} keywords${P.lights[P.frame] ? ' · ' + P.lights[P.frame].file.name : ''}`), inp, h('div', { class: 'hdr' }, h('table', { class: 'kv' }, tb)));
  }
  function frameChanged() {
    if (I.tool === 'profile' && I.prof && I.prof.frame !== P.frame) examine(I.prof.x, I.prof.y);
    else if (I.tool === 'header') render();
    else if (I.tool === 'focus') render();
    else if ((I.tool === 'cut' && I.cut) || (I.tool === 'region' && I.region)) { const c = cur(); if (I.cut) I.cut.lp = lineProfile(c.data, c.width, c.height, I.cut.x0, I.cut.y0, I.cut.x1, I.cut.y1, 0.5); if (I.region) I.region.st = regionStats(c.data, c.width, c.height, { shape: 'box', x0: I.region.x0, y0: I.region.y0, x1: I.region.x1, y1: I.region.y1 }); render(); }
  }
  function reset() { Object.assign(I, { prof: null, cut: null, region: null, focus: null, focusFrame: -1 }); if (I.tool === 'focus' || I.tool === 'header') I.tool = P.mode === 'tpf' ? 'pick' : I.tool; buildBar(); render(); }
  buildBar(); render();
  return { I, setTool, click, draw, render, frameChanged, reset, examine, measureFocus };
}
