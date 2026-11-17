// Image examination tools of the photometry page, in the spirit of DS9 and IRAF's imexam: a radial profile with
// FWHM, half-flux diameter and curve of growth for the star you click; a line cut; region statistics; the focus
// across the field; the FITS header. The science is in src/core/imexam.js; this file is the panel and the overlay.
import { radialProfile, lineProfile, regionStats, pixelTable, psfShape, psfMoments, focusMap, saturationLevel } from '../core/imexam.js';
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
  const I = { tool: 'pick', prof: null, cut: null, region: null, focus: null, focusFrame: -1, showFocus: true, grid: 3, filter: '', growth: false, minSnr: 30, bars: 'elongation' };
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
    // the 2-D distribution: moments with the focus map's weight (coma, asymmetry), and the unweighted stamp to draw
    const fw = r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm, R = r.growth.r[r.growth.r.length - 1];
    const mom = Number.isFinite(fw) ? psfMoments(c.data, c.width, c.height, r.x, r.y, { radius: R, background: r.background, weight: 0.7 * fw }) : null;
    I.prof = { ...r, rmax: R, shape: f.ok ? psfShape(f) : null, mom, table: pixelTable(c.data, c.width, c.height, r.x, r.y, 2), frame: P.frame };
    render(); viewer.draw();
    // a one-line answer next to the image, since on a phone the panel is below it
    if (ctx.note) ctx.note(`FWHM ${fx(r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm)} px${arc(r.moffat.ok ? r.moffat.fwhm : r.gaussian.fwhm)} · HFD ${fx(r.hfd)} px · peak ${r.saturated ? 'SATURATED' : big(r.peak)}${matchMedia('(max-width: 980px)').matches ? ' · details below' : ''}`);
  }

  // ---- focus
  function measureFocus() {
    const c = cur(); if (!c || P.mode !== 'stack') return;
    const t0 = performance.now();
    const g = Number(ctx.gain && ctx.gain()) || Number(H().GAIN ?? H().EGAIN) || 1;
    I.focus = focusMap(c.data, c.width, c.height, { nx: I.grid, ny: I.grid, saturation: sat().level, pixelScale: scale(), minSnr: I.minSnr, gain: g });
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
      // skipped stars bright enough to measure, so that no bright star is left without a mark: red cross saturated, grey
      // dashed circle crowded, grey dotted square fit failed or at the edge (faint stars are not marked)
      for (const r of F.rejected || []) {
        if (r.reason === 'faint') continue;
        const [sx, sy] = v.toScreen(r.x, r.y), q = Math.max(5, 2.2 * F.summary.fwhm * v.scale);
        if (r.reason === 'saturated') { c.strokeStyle = '#ff6b7a'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(sx - q, sy - q); c.lineTo(sx + q, sy + q); c.moveTo(sx - q, sy + q); c.lineTo(sx + q, sy - q); c.stroke(); }
        else if (r.reason === 'crowded') { c.strokeStyle = '#c9d4e3aa'; c.lineWidth = 1.2; c.setLineDash([3, 3]); c.beginPath(); c.arc(sx, sy, q, 0, 6.2832); c.stroke(); c.setLineDash([]); }
        else { c.strokeStyle = '#c9d4e3aa'; c.lineWidth = 1.2; c.setLineDash([1.5, 3]); c.strokeRect(sx - q, sy - q, 2 * q, 2 * q); c.setLineDash([]); }
      }
      for (const s of F.stars) {
        const [sx, sy] = v.toScreen(s.x, s.y), a = s.angle * Math.PI / 180, col = rampColor((s.fwhm - lo) / (hi - lo || 1));
        c.strokeStyle = col; c.lineWidth = 1.4;
        c.beginPath(); c.ellipse(sx, sy, Math.max(2, s.fwhmMajor / 2 * k * 0.5), Math.max(1.5, s.fwhmMinor / 2 * k * 0.5), -a, 0, 6.2832); c.stroke();
        if (I.bars === 'coma') {
          // coma: an arrow from the star toward its tail, 80 px for a coma of 1
          if (s.coma && s.coma.size > 0.04) { const L = Math.min(60, 80 * s.coma.size), b = s.coma.angle * Math.PI / 180, ex = sx + Math.cos(b) * L, ey = sy - Math.sin(b) * L; c.lineWidth = 2; c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke(); const hd = 5; c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - hd * Math.cos(b - 0.5), ey + hd * Math.sin(b - 0.5)); c.moveTo(ex, ey); c.lineTo(ex - hd * Math.cos(b + 0.5), ey + hd * Math.sin(b + 0.5)); c.stroke(); }
        } else if (s.ellipticity > 0.08) { const L = 6 + 60 * s.ellipticity, dx = Math.cos(a) * L / 2, dy = -Math.sin(a) * L / 2; c.lineWidth = 2; c.beginPath(); c.moveTo(sx - dx, sy - dy); c.lineTo(sx + dx, sy + dy); c.stroke(); }
      }
      // tip/tilt: an arrow at the centre toward the softer side, when the plane is significant
      const Pl = F.summary.plane;
      if (Pl && Pl.sigma > 3 && Pl.fraction > 0.03) {
        const img = cur(), [ox, oy] = v.toScreen((img.width - 1) / 2, (img.height - 1) / 2), b = Pl.angle * Math.PI / 180, L = Math.min(160, 40 + 400 * Pl.fraction), ex = ox + Math.cos(b) * L, ey = oy - Math.sin(b) * L;
        c.strokeStyle = '#ffffffcc'; c.lineWidth = 2.5; c.setLineDash([7, 4]); c.beginPath(); c.moveTo(ox, oy); c.lineTo(ex, ey); c.stroke(); c.setLineDash([]);
        c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - 10 * Math.cos(b - 0.45), ey + 10 * Math.sin(b - 0.45)); c.moveTo(ex, ey); c.lineTo(ex - 10 * Math.cos(b + 0.45), ey + 10 * Math.sin(b + 0.45)); c.stroke();
        c.font = '600 11px ui-monospace, monospace'; c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.fillText(`softer +${(100 * Pl.fraction).toFixed(0)}%`, ex + Math.cos(b) * 26, ey - Math.sin(b) * 14);
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
    const cs = h('canvas', { class: 'iplot', 'aria-label': 'The star in two dimensions: its pixels, contours at 50 and 5% of the peak, the moment ellipse at the FWHM and the coma arrow' });
    card.append(h('div', { class: 'iplots2' }, cv, cs));
    requestAnimationFrame(() => {
      if (!cv.isConnected) return;     // the panel was rebuilt before this frame
      const n = r.pixels.r.length, G = 120, xs = new Float64Array(n + G), dots = new Float64Array(n + G).fill(NaN), gl = new Float64Array(n + G).fill(NaN), ml = new Float64Array(n + G).fill(NaN);
      for (let i = 0; i < n; i++) { xs[i] = r.pixels.r[i]; dots[i] = r.pixels.v[i]; }
      for (let j = 0; j < G; j++) { const x = j / (G - 1) * r.rmax; xs[n + j] = x; gl[n + j] = r.gaussian.amp * Math.exp(-0.5 * x * x / (r.gaussian.sigma ** 2)); ml[n + j] = r.moffat.amp * Math.pow(1 + x * x / (r.moffat.gamma ** 2), -r.moffat.beta); }
      let g = fitCanvas(cv, 210); renderPanel(g.ctx, g.W, g.H, { x: xs, series: [{ y: dots, color: PHOT_THEME.data, kind: 'dots', size: 1.3, alpha: 0.6 }, { y: gl, color: PHOT_THEME.model, kind: 'line', label: 'Gaussian' }, { y: ml, color: PHOT_THEME.star, kind: 'line', label: 'Moffat' }], xLabel: 'radius [px]', yLabel: 'counts above sky', title: '' });   // the panel's heading names it; at half width a title would collide with the key
      if (cs.isConnected) { const q = fitCanvas(cs, 210); renderShape(q.ctx, q.W, q.H, r); }
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
        r.mom ? ['Elongation (moments)', `${(100 * r.mom.ellipticity).toFixed(1)}% at ${r.mom.angle.toFixed(0)}°`, 'From the second moments of the pixels (Gaussian weight σ 0.7 FWHM): the dashed ellipse'] : null,
        r.mom ? ['Coma', `${fx(r.mom.coma.size, 3)} toward ${r.mom.coma.angle.toFixed(0)}°`, 'Third moments: (Ixxx + Ixyy, Ixxy + Iyyy) / σ³, the side the light trails toward (the arrow). Round stars give about 0.04 at S/N 50–250; a tail 0.15 and up. One direction across the whole frame points to collimation or a tilted optic: see Focus with “Bars: coma”'] : null,
        r.mom ? ['Asymmetry (180°)', fx(r.mom.asymmetry, 3), 'Σ|I − I rotated 180°| / 2Σ|I| about the centroid: 0 for any point-symmetric star (an ellipse included); noise alone gives about 0.03'] : null,
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
  /** The star in two dimensions: its sky-subtracted pixels (asinh stretch), contours at 50 and 5% of the peak,
   *  the moment ellipse at the FWHM (dashed), the centroid and the coma arrow. y up, as on the image. */
  function renderShape(c, W, Hh, r) {
    c.fillStyle = PHOT_THEME.bg; c.fillRect(0, 0, W, Hh);
    c.font = PHOT_THEME.font; c.fillStyle = PHOT_THEME.strong; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText('2-D shape', 8, 6);
    c.fillStyle = '#ff9f43'; c.textAlign = 'right'; c.fillText('→ coma', W - 6, 6); c.textAlign = 'left';
    const m = r.mom; if (!m) { c.fillStyle = PHOT_THEME.text; c.fillText('moments not available', 8, 24); return; }
    const S = m.stamp, top = 22, side = Math.min(W - 16, Hh - top - 18), px = side / Math.max(S.nx, S.ny), ox = (W - S.nx * px) / 2, oy = top + (side - S.ny * px) / 2;
    let pk = 0; for (const v of S.v) if (v > pk) pk = v;
    const X = (x) => ox + (x - S.x0 + 0.5) * px, Y = (y) => oy + (S.ny - 1 - (y - S.y0) + 0.5) * px;   // pixel centres; y up
    const st = (v) => Math.max(0, Math.min(1, Math.asinh(Math.max(0, v) / pk * 30) / Math.asinh(30)));
    for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) { const g = Math.round(255 * st(S.v[j * S.nx + i])); c.fillStyle = `rgb(${g},${g},${g})`; c.fillRect(ox + i * px, oy + (S.ny - 1 - j) * px, Math.ceil(px), Math.ceil(px)); }
    // contours by marching squares on the pixel-centre grid
    const lv = [[0.5, '#6fe3a5'], [0.05, '#ff6b7a']];
    c.lineWidth = 1.3;
    for (const [f, col] of lv) {
      const L = f * pk; c.strokeStyle = col; c.beginPath();
      for (let j = 0; j < S.ny - 1; j++) for (let i = 0; i < S.nx - 1; i++) {
        const a = S.v[j * S.nx + i], b = S.v[j * S.nx + i + 1], d = S.v[(j + 1) * S.nx + i], e = S.v[(j + 1) * S.nx + i + 1];
        const pts = [], cross = (p, q, x0, y0, x1, y1) => { if ((p < L) !== (q < L)) { const t = (L - p) / (q - p); pts.push([x0 + t * (x1 - x0), y0 + t * (y1 - y0)]); } };
        const xi = S.x0 + i, yj = S.y0 + j;
        cross(a, b, xi, yj, xi + 1, yj); cross(b, e, xi + 1, yj, xi + 1, yj + 1); cross(d, e, xi, yj + 1, xi + 1, yj + 1); cross(a, d, xi, yj, xi, yj + 1);
        for (let k = 0; k + 1 < pts.length; k += 2) { c.moveTo(X(pts[k][0]), Y(pts[k][1])); c.lineTo(X(pts[k + 1][0]), Y(pts[k + 1][1])); }
      }
      c.stroke();
    }
    // moment ellipse at the FWHM (2.3548 a, 2.3548 b), the centroid, the coma arrow (one FWHM long for a coma of 0.5)
    const cxp = X(m.x), cyp = Y(m.y), ang = m.angle * Math.PI / 180, fwhmPx = 2.3548 * Math.sqrt((m.a * m.a + m.b * m.b) / 2);
    c.strokeStyle = '#ffffff'; c.lineWidth = 1.2; c.setLineDash([4, 3]); c.beginPath(); c.ellipse(cxp, cyp, 1.1774 * m.a * px, 1.1774 * m.b * px, -ang, 0, 6.2832); c.stroke(); c.setLineDash([]);
    c.beginPath(); c.moveTo(cxp - 5, cyp); c.lineTo(cxp + 5, cyp); c.moveTo(cxp, cyp - 5); c.lineTo(cxp, cyp + 5); c.stroke();
    if (m.coma.size > 0.02) { const b = m.coma.angle * Math.PI / 180, Lc = Math.min(0.45 * side, 2 * m.coma.size * fwhmPx * px), ex = cxp + Math.cos(b) * Lc, ey = cyp - Math.sin(b) * Lc; c.strokeStyle = '#ff9f43'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(cxp, cyp); c.lineTo(ex, ey); c.moveTo(ex, ey); c.lineTo(ex - 7 * Math.cos(b - 0.5), ey + 7 * Math.sin(b - 0.5)); c.moveTo(ex, ey); c.lineTo(ex - 7 * Math.cos(b + 0.5), ey + 7 * Math.sin(b + 0.5)); c.stroke(); }
    // key
    c.textBaseline = 'alphabetic'; c.font = PHOT_THEME.font; let kx = 8; const ky = Hh - 5;
    for (const [f, col] of lv) { c.fillStyle = col; c.fillRect(kx, ky - 7, 10, 3); c.fillStyle = PHOT_THEME.text; c.fillText(`${f * 100}%`, kx + 13, ky); kx += 13 + c.measureText(`${f * 100}%`).width + 7; }
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
      h('label', { class: 'dim', style: 'display:inline-flex;gap:4px;align-items:center', title: 'Only stars at least this bright are measured: a faint star\'s width is mostly noise' }, 'S/N ≥', h('select', { 'aria-label': 'Smallest signal to noise measured', onchange: (e) => { I.minSnr = +e.target.value; measureFocus(); } }, [10, 20, 30, 50, 100, 200].map((n) => h('option', { value: n, selected: n === I.minSnr }, String(n))))),
      h('label', { class: 'dim', style: 'display:inline-flex;gap:4px;align-items:center', title: 'What the line on each star shows' }, 'Bars', h('select', { 'aria-label': 'What the bars show', onchange: (e) => { I.bars = e.target.value; render(); viewer.draw(); } }, [['elongation', 'elongation'], ['coma', 'coma (asymmetry)']].map(([v, t]) => h('option', { value: v, selected: v === I.bars }, t)))),
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
    const RJ = S.rejected || {}, rj = [['saturated', 'saturated'], ['crowded', 'crowded'], ['faint', `S/N < ${S.minSnr}`], ['edge', 'at the edge'], ['fit', 'fit failed']].filter(([k]) => RJ[k]).map(([k, t]) => `${RJ[k]} ${t}`);
    const compass = (a) => ['right', 'upper right', 'up', 'upper left', 'left', 'lower left', 'down', 'lower right'][Math.round(a / 45) % 8], Pl = S.plane;
    card.append(kv([
      ['Stars measured', `${S.n} (S/N ≥ ${S.minSnr}, unsaturated, isolated)${F.ms ? `, ${F.ms.toFixed(0)} ms` : ''}`],
      rj.length ? ['Skipped', rj.join(', '), 'Every detected star that was not measured, by reason. Saturated and crowded ones are marked on the image'] : null,
      ['Median FWHM', `${fx(S.fwhm)} px${arc(S.fwhm)}`],
      ['Centre / corners', `${fx(S.fwhmCentre)} / ${S.fwhmCorners.map((v) => fx(v)).join(', ')} px`, 'Centre cell, then the lower-left, lower-right, upper-left and upper-right cells'],
      ['Corners softer by', Number.isFinite(S.curvature) ? `${(100 * S.curvature).toFixed(0)}%` : '–', 'Mean corner FWHM against the centre: field curvature or off-axis aberration'],
      ['Corner spread', Number.isFinite(S.tilt) ? `${(100 * S.tilt).toFixed(0)}%${S.worstCorner ? ', worst ' + S.worstCorner : ''}` : '–', 'Largest minus smallest corner FWHM, over the centre: sensor tilt or an off-centre optical axis'],
      ['Tilt (FWHM plane)', Pl ? `${(100 * Pl.fraction).toFixed(0)}% softer toward the ${compass(Pl.angle)} (${Number.isFinite(Pl.sigma) ? Pl.sigma.toFixed(1) + 'σ' : '–'}${Pl.sigma > 3 ? '' : ', not significant'})` : '–', 'A plane FWHM = f0 + gx x + gy y fitted to every star: how much the FWHM changes from one side of the frame to the other, and which side is softer. Significant (3σ and up) and over ~10%, the sensor is likely tilted against the focal plane (tip/tilt); the dashed arrow on the image'],
      ['Coma', Number.isFinite(S.coma) ? `median ${fx(S.coma, 3)}${Number.isFinite(S.comaCoherence) ? `, ${(100 * S.comaCoherence).toFixed(0)}% toward ${S.comaAngle.toFixed(0)}°` : ''}` : '–', 'Third moments of every star (Gaussian weight σ 0.7 FWHM): round stars give about 0.04, a visible tail 0.15 and up. Most stars pointing one way (a high percentage) means a decentred or tilted optic; choose “Bars: coma” to see them'],
      ['Asymmetry (180°)', fx(S.asymmetry, 3), 'Median 180-degree rotational asymmetry: noise alone gives about 0.03'],
      ['Median elongation', `${(100 * S.ellipticity).toFixed(1)}%`],
      ['Same direction', Number.isFinite(S.coherence) ? `${(100 * S.coherence).toFixed(0)}% at ${S.angle.toFixed(0)}°` : '–', '100% when every star is stretched the same way (tracking, guiding, wind), near 0 when directions vary (optics)'],
      S.best ? ['Sharpest point', `${fx(S.best.x, 0)}, ${fx(S.best.y, 0)} (white cross)`, 'Minimum of the quadratic FWHM surface fitted to all stars'] : null,
    ]), legend());
  }
  /** What every mark of the focus overlay means, each with its own symbol. */
  function legend() {
    const svg = (inner) => { const e = h('span'); e.innerHTML = `<svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">${inner}</svg>`; return e.firstChild; };
    const rows = [
      [svg('<ellipse cx="13" cy="9" rx="9" ry="5" fill="none" stroke="#6fe3a5" stroke-width="1.6" transform="rotate(-25 13 9)"/>'), 'A measured star, its FWHM ellipse enlarged; the colour is the FWHM, blue sharp to red soft (the scale beside the cell map)'],
      I.bars === 'coma' ? [svg('<path d="M5 9 H19 M19 9 l-5 -3.5 M19 9 l-5 3.5" fill="none" stroke="#5fd4ff" stroke-width="2"/>'), 'Coma: from the star toward the side its light trails, longer for a larger asymmetry (drawn above 0.04)'] : [svg('<path d="M4 13 L22 5" stroke="#5fd4ff" stroke-width="2"/>'), 'Direction of elongation, longer for more elongated stars (drawn above 8%)'],
      [svg('<path d="M6 3 L20 15 M6 15 L20 3" stroke="#ff6b7a" stroke-width="1.8"/>'), 'Saturated or within 10% of saturation: skipped (its shape is clipped)'],
      [svg('<circle cx="13" cy="9" r="7" fill="none" stroke="#c9d4e3" stroke-width="1.3" stroke-dasharray="3 3"/>'), 'A neighbour too close, or two stars blended into one: skipped'],
      [svg('<rect x="6" y="2" width="14" height="14" fill="none" stroke="#c9d4e3" stroke-width="1.3" stroke-dasharray="1.5 3"/>'), 'The fit failed or the star is too near the edge: skipped'],
      [svg('<path d="M3 9 H21 M21 9 l-6 -4 M21 9 l-6 4" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="5 3"/>'), 'Tilt: from the centre toward the softer side of the frame (shown when significant)'],
      [svg('<path d="M13 2 V16 M6 9 H20" stroke="#ffffff" stroke-width="1.6"/>'), 'Sharpest point of the fitted FWHM surface'],
      [svg('<rect x="3" y="2" width="20" height="14" fill="none" stroke="#ffffff55"/>'), 'Cells of the map above'],
    ];
    return h('div', {}, h('ul', { class: 'flegend', 'aria-label': 'What the marks on the image mean' }, rows.flatMap(([ic, t]) => [h('li', {}, ic), h('li', {}, t)])),
      h('p', { class: 'hint', style: 'margin-top:6px' }, `Stars fainter than S/N ${I.minSnr} are not measured or marked. Tap a star for its profile and 2-D shape.`));
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
