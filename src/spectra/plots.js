// Plots of the spectroscopy page: pure render functions (ctx, W, H, data, theme), so the screen and the exported
// PNG draw the same thing. renderPanel and the dark theme are those of the photometry page.
import { renderPanel, niceTicks, PHOT_THEME, PHOT_DARK } from '../photometry/plots.js';

export const SPEC_THEME = PHOT_THEME;   // the screen theme (follows the site theme)
export const SPEC_DARK = PHOT_DARK;     // a dark figure for export, whatever the site theme
/** For exported figures: dark text on white. */
export const PRINT_THEME = { bg: '#ffffff', frame: '#444b5c', grid: '#e3e6ee', text: '#3a4152', strong: '#10131a', data: '#30384c', model: '#0b6fb8', star: '#b36b00', ok: '#16794a', warn: '#a85a00', bad: '#c0293b', post: '#6a3fc4', font: '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace' };
const fmt = (v, step) => v.toFixed(Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) + 0.01))));

// a perceptually ordered dark-blue -> teal -> yellow ramp (five anchors, linear between them)
const RAMP = [[13, 8, 60], [44, 62, 140], [32, 128, 141], [94, 201, 98], [253, 231, 37]];
function ramp(u) { const x = Math.min(0.9999, Math.max(0, u)) * 4, i = Math.floor(x), f = x - i, a = RAMP[i], b = RAMP[i + 1]; return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]; }

/**
 * The time-wavelength image: every column (wavelength) divided by its median over time, so a transit is a dark
 * band. d = { time, wave, flux, bad, nT, nW, colOk?, title, bins?: [{ lo, hi }] }. Time runs to the right (hours from
 * the first integration), wavelength upward by column index (the axis is labelled in micron and is not linear when
 * the grid is not). The colour scale spans the 1st to 99th percentile of the normalised values.
 */
export function renderCubeImage(ctx, W, H, d, th = SPEC_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const mL = 54, mR = 54, mT = d.title ? 20 : 8, mB = 30, pw = Math.max(10, Math.round(W - mL - mR)), ph = Math.max(10, Math.round(H - mT - mB));
  const { nT, nW } = d, med = new Float64Array(nW), buf = new Float64Array(nT);
  for (let j = 0; j < nW; j++) { let n = 0; for (let i = 0; i < nT; i++) { const o = i * nW + j; if (!d.bad[o] && Number.isFinite(d.flux[o])) buf[n++] = d.flux[o]; } if (!n || (d.colOk && !d.colOk[j])) { med[j] = NaN; continue; } const s = buf.subarray(0, n).slice().sort(); med[j] = s[n >> 1]; }
  // percentiles from a subsample
  const smp = [], step = Math.max(1, Math.floor((nT * nW) / 30000));
  for (let o = 0; o < nT * nW; o += step) { const m = med[o % nW]; if (m > 0 && !d.bad[o]) smp.push(d.flux[o] / m); }
  smp.sort((a, b) => a - b); const v0 = smp[Math.floor(0.01 * (smp.length - 1))] ?? 0.99, v1 = Math.max(smp[Math.floor(0.99 * (smp.length - 1))] ?? 1.01, v0 + 1e-9);
  const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(ctx.canvas.ownerDocument.createElement('canvas'), { width: pw, height: ph });
  const g = off.getContext('2d'), im = g.createImageData(pw, ph), px = im.data;
  for (let y = 0; y < ph; y++) {
    const ja = Math.floor(((ph - 1 - y) / ph) * nW), jb = Math.max(ja + 1, Math.floor(((ph - y) / ph) * nW));
    for (let x = 0; x < pw; x++) {
      const ia = Math.floor((x / pw) * nT), ib = Math.max(ia + 1, Math.floor(((x + 1) / pw) * nT));
      let s = 0, n = 0;
      for (let i = ia; i < ib && i < nT; i++) for (let j = ja; j < jb && j < nW; j++) { const o = i * nW + j; if (med[j] > 0 && !d.bad[o]) { s += d.flux[o] / med[j]; n++; } }
      const q = (y * pw + x) * 4;
      if (!n) { px[q] = 30; px[q + 1] = 34; px[q + 2] = 46; px[q + 3] = 255; continue; }
      const c = ramp((s / n - v0) / (v1 - v0)); px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0); ctx.drawImage(off, mL, mT);
  ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(mL + 0.5, mT + 0.5, pw, ph);
  ctx.font = th.font; ctx.fillStyle = th.text;
  const hrs = (d.time[nT - 1] - d.time[0]) * 24, tx = niceTicks(0, hrs, Math.max(3, Math.floor(pw / 90)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of tx.ticks) ctx.fillText(fmt(v, tx.step), mL + (v / (hrs || 1)) * pw, mT + ph + 4);
  ctx.textBaseline = 'bottom'; ctx.fillText('hours from the first integration', mL + pw / 2, H - 2);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const nLab = Math.max(2, Math.min(8, Math.floor(ph / 36)));
  for (let k = 0; k <= nLab; k++) { const j = Math.min(nW - 1, Math.round((k / nLab) * (nW - 1))); ctx.fillText(d.wave[j].toFixed(2), mL - 6, mT + ph - ((j + 0.5) / nW) * ph); }
  ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Wavelength (µm)', 0, 0); ctx.restore();
  // bin edges as ticks on the right of the image
  if (d.bins && d.bins.length <= 400) { ctx.strokeStyle = th.star; ctx.globalAlpha = 0.8; ctx.beginPath(); for (const b of d.bins) { const y = Math.round(mT + ph - (b.j0 / nW) * ph) + 0.5; ctx.moveTo(mL + pw, y); ctx.lineTo(mL + pw + 5, y); } ctx.stroke(); ctx.globalAlpha = 1; }
  // colour bar
  const bx = mL + pw + 12, bw = 8;
  for (let y = 0; y < ph; y++) { const c = ramp(1 - y / ph); ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; ctx.fillRect(bx, mT + y, bw, 1.5); }
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(((v1 - 1) * 100).toFixed(2) + '%', bx - 2, mT + 2 - 14 < 0 ? mT : mT - 12);
  ctx.textBaseline = 'bottom'; ctx.fillText(((v0 - 1) * 100).toFixed(2) + '%', bx - 2, mT + ph + 13);
  if (d.title) { ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(d.title, mL, 4); }
}

/**
 * The spectrum: depth against wavelength with 1-sigma error bars and the bin widths.
 * d = { rows: [{ wl, lo, hi, depth, plus, minus }], kind, title, truth?: [{ wl, depth }], reference?: { label, rows: [{ wl, depth, err }] },
 *       white?: { depth, plus, minus }, scale?: { depthPerH } (adds a right-hand axis in scale heights), logX }
 */
export function renderSpectrum(ctx, W, H, d, th = SPEC_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const rows = d.rows || [], mL = 62, mR = d.scale ? 46 : 12, mT = 22, mB = 32, pw = W - mL - mR, ph = H - mT - mB;
  ctx.font = th.font;
  if (!rows.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('No spectrum yet: fit the channels.', W / 2, H / 2); return; }
  const PPM = 1e6; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rows) { x0 = Math.min(x0, r.lo ?? r.wl); x1 = Math.max(x1, r.hi ?? r.wl); y0 = Math.min(y0, (r.depth - r.minus) * PPM); y1 = Math.max(y1, (r.depth + r.plus) * PPM); }
  for (const t of d.truth || []) { y0 = Math.min(y0, t.depth * PPM); y1 = Math.max(y1, t.depth * PPM); }
  for (const t of (d.reference && d.reference.rows) || []) { if (t.wl < x0 || t.wl > x1) continue; y0 = Math.min(y0, t.depth * PPM); y1 = Math.max(y1, t.depth * PPM); }
  const yp = (y1 - y0) * 0.08 || 50, xp = (x1 - x0) * 0.02 || 0.05; y0 -= yp; y1 += yp; x0 -= xp; x1 += xp;
  const logX = d.logX && x0 > 0, fx = (v) => (logX ? Math.log(v) : v), X = (v) => mL + ((fx(v) - fx(x0)) / (fx(x1) - fx(x0))) * pw, Y = (v) => mT + ph - ((v - y0) / (y1 - y0)) * ph;
  const ty = niceTicks(y0, y1, Math.max(2, Math.floor(ph / 34))), tx = niceTicks(x0, x1, Math.max(3, Math.floor(pw / 80)));
  ctx.strokeStyle = th.grid; ctx.fillStyle = th.text; ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of ty.ticks) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke(); ctx.fillText(fmt(v, ty.step), mL - 6, y); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of tx.ticks) { if (v <= 0 && logX) continue; const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke(); ctx.fillText(fmt(v, tx.step), x, mT + ph + 4); }
  ctx.strokeStyle = th.frame; ctx.strokeRect(mL + 0.5, mT + 0.5, pw, ph);
  ctx.save(); ctx.beginPath(); ctx.rect(mL, mT, pw, ph); ctx.clip();
  if (d.white) { ctx.fillStyle = th.post; ctx.globalAlpha = 0.14; ctx.fillRect(mL, Y((d.white.depth + d.white.plus) * PPM), pw, Math.max(1, Y((d.white.depth - d.white.minus) * PPM) - Y((d.white.depth + d.white.plus) * PPM))); ctx.globalAlpha = 0.7; ctx.strokeStyle = th.post; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(mL, Y(d.white.depth * PPM)); ctx.lineTo(mL + pw, Y(d.white.depth * PPM)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
  if (d.reference) { ctx.strokeStyle = th.star; ctx.fillStyle = th.star; ctx.globalAlpha = 0.75; for (const t of d.reference.rows) { const x = X(t.wl), y = Y(t.depth * PPM); if (t.err) { ctx.beginPath(); ctx.moveTo(x, Y((t.depth - t.err) * PPM)); ctx.lineTo(x, Y((t.depth + t.err) * PPM)); ctx.stroke(); } ctx.fillRect(x - 1.5, y - 1.5, 3, 3); } ctx.globalAlpha = 1; }
  if (d.truth && d.truth.length) { ctx.strokeStyle = th.ok; ctx.lineWidth = 1.5; ctx.beginPath(); d.truth.forEach((t, i) => { const x = X(t.wl), y = Y(t.depth * PPM); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.lineWidth = 1; }
  ctx.strokeStyle = th.model; ctx.fillStyle = th.model;
  for (const r of rows) {
    const x = X(r.wl), y = Y(r.depth * PPM);
    ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x, Y((r.depth - r.minus) * PPM)); ctx.lineTo(x, Y((r.depth + r.plus) * PPM)); if (r.lo !== undefined) { ctx.moveTo(X(r.lo), y); ctx.lineTo(X(r.hi), y); } ctx.stroke();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, rows.length > 120 ? 1.6 : 2.6, 0, 6.2832); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('Wavelength (µm)', mL + pw / 2, H - 2);
  ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(d.kind === 'eclipse' ? 'Eclipse depth (ppm)' : 'Transit depth (ppm)', 0, 0); ctx.restore();
  if (d.scale && d.scale.depthPerH > 0) {
    // right-hand axis: scale heights above the lowest point
    const per = d.scale.depthPerH * PPM, ref = Math.min(...rows.map((r) => r.depth)) * PPM, ts = niceTicks((y0 - ref) / per, (y1 - ref) / per, Math.max(2, Math.floor(ph / 40)));
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = th.text;
    for (const v of ts.ticks) { const y = Y(ref + v * per); if (y < mT || y > mT + ph) continue; ctx.beginPath(); ctx.strokeStyle = th.frame; ctx.moveTo(mL + pw, y); ctx.lineTo(mL + pw + 4, y); ctx.stroke(); ctx.fillText(fmt(v, ts.step), mL + pw + 7, y); }
    ctx.save(); ctx.translate(W - 8, mT + ph / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('scale heights', 0, 0); ctx.restore();
  }
  // title and legend share the top line
  ctx.textBaseline = 'top'; ctx.textAlign = 'right'; let lx = mL + pw;
  const leg = [[th.model, rows.length + ' channels']]; if (d.white) leg.push([th.post, 'white light']); if (d.truth && d.truth.length) leg.push([th.ok, 'injected']); if (d.reference) leg.push([th.star, d.reference.label]);
  for (const [c, s] of leg.reverse()) { ctx.fillStyle = c; ctx.fillText(s, lx, 5); lx -= ctx.measureText(s).width + 12; }
  if (d.title) { let t = d.title; const room = lx - mL - 6; if (ctx.measureText(t).width > room) { while (t.length > 4 && ctx.measureText(t + '…').width > room) t = t.slice(0, -1); t += '…'; } ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.fillText(t, mL, 5); }
}

/** A light curve with its model above its residuals. d = { time, flux, err, model, resid, title, detrended? } */
export function renderLightCurve(ctx, W, H, d, th = SPEC_THEME) {
  const hTop = Math.round(H * (d.resid ? 0.64 : 1)), t0 = Math.floor(d.time[0]);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, hTop); ctx.clip();
  renderPanel(ctx, W, hTop, { x: d.time, xOffset: t0, title: d.title, yLabel: 'relative flux', series: [{ y: d.flux, color: th.data, kind: 'dots', err: d.err && d.time.length <= 600 ? d.err : null, label: 'data' }, ...(d.model ? [{ y: d.model, color: th.model, kind: 'line', label: 'model' }] : [])] }, th);
  ctx.restore();
  if (!d.resid) return;
  ctx.save(); ctx.translate(0, hTop); ctx.beginPath(); ctx.rect(0, 0, W, H - hTop); ctx.clip();
  renderPanel(ctx, W, H - hTop, { x: d.time, xOffset: t0, xLabel: `time − ${t0} (d)`, yLabel: 'residual (ppm)', series: [{ y: Float64Array.from(d.resid, (v) => v * 1e6), color: th.data, kind: 'dots' }, { y: new Float64Array(d.time.length), color: th.model, kind: 'line', size: 1 }] }, th);
  ctx.restore();
}

/**
 * Small multiples of the channel light curves. d = { cells: [{ wl, time, detrended, transit, depth }], cols }
 * Every cell shares the y range (the deepest model and 4 times the median scatter) so depths can be compared by eye.
 */
export function renderChannelGrid(ctx, W, H, d, th = SPEC_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const cells = d.cells || []; if (!cells.length) return;
  const cols = d.cols || Math.max(1, Math.floor(W / 150)), rowsN = Math.ceil(cells.length / cols), cw = W / cols, chh = H / rowsN;
  let lo = Infinity, hi = -Infinity; const sc = [];
  for (const c of cells) { for (const v of c.transit) { if (v < lo) lo = v; if (v > hi) hi = v; } let s = 0; for (let i = 0; i < c.detrended.length; i++) s += (c.detrended[i] - c.transit[i]) ** 2; sc.push(Math.sqrt(s / c.detrended.length)); }
  sc.sort((a, b) => a - b); const pad = 3 * (sc[sc.length >> 1] || 1e-4); lo -= pad; hi += pad;
  ctx.font = th.font;
  cells.forEach((c, k) => {
    const x0 = (k % cols) * cw + 3, y0 = Math.floor(k / cols) * chh + 3, w = cw - 6, h = chh - 6, n = c.time.length, ta = c.time[0], tb = c.time[n - 1];
    ctx.strokeStyle = th.grid; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    const X = (t) => x0 + ((t - ta) / (tb - ta || 1)) * w, Y = (v) => y0 + h - ((v - lo) / (hi - lo)) * h;
    ctx.fillStyle = th.data; ctx.globalAlpha = n > 300 ? 0.45 : 0.7; const st = Math.max(1, Math.floor(n / 600));
    for (let i = 0; i < n; i += st) ctx.fillRect(X(c.time[i]) - 0.8, Y(c.detrended[i]) - 0.8, 1.6, 1.6);
    ctx.globalAlpha = 1; ctx.strokeStyle = th.model; ctx.lineWidth = 1.3; ctx.beginPath(); for (let i = 0; i < n; i++) { if (i) ctx.lineTo(X(c.time[i]), Y(c.transit[i])); else ctx.moveTo(X(c.time[i]), Y(c.transit[i])); } ctx.stroke(); ctx.lineWidth = 1;
    ctx.restore();
    ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(c.wl.toFixed(c.wl < 10 ? 3 : 2) + ' µm', x0 + 4, y0 + h - 2);
    ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.fillText(Math.round(c.depth * 1e6) + ' ppm', x0 + w - 4, y0 + h - 2);
  });
}

/**
 * Noise per channel: residual rms and the rms expected from the error bars against wavelength (ppm), and beta.
 * d = { rows: [{ wl, rms, expected, beta }], title }
 */
export function renderNoise(ctx, W, H, d, th = SPEC_THEME) {
  const x = d.rows.map((r) => r.wl);
  renderPanel(ctx, W, H, { x, title: d.title || 'Scatter per channel', xLabel: 'wavelength (micron)', yLabel: 'ppm', yPad: 0.12,
    series: [{ y: d.rows.map((r) => r.expected * 1e6), color: th.star, kind: 'line', label: 'expected' }, { y: d.rows.map((r) => r.rms * 1e6), color: th.model, kind: 'dots', label: 'residual rms', size: d.rows.length > 120 ? 1.5 : 2.4 }] }, th);
}

/** The time-averaging test of one light curve: rms of binned residuals against bin size, with the white-noise line. d = { binned: { n, rms, expected }, dtMin, title } */
export function renderBinnedRms(ctx, W, H, d, th = SPEC_THEME) {
  const b = d.binned; if (!b) { ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); return; }
  const keep = b.n.map((_, i) => i).filter((i) => b.M[i] >= 4 && b.rms[i] > 0), lx = keep.map((i) => Math.log10(b.n[i] * (d.dtMin || 1)));
  renderPanel(ctx, W, H, { x: lx, title: d.title || 'Binned residuals', xLabel: d.dtMin ? 'log10 bin length (minutes)' : 'log10 bin size (points)', yLabel: 'log10 rms (ppm)',
    series: [{ y: keep.map((i) => Math.log10(b.expected[i] * 1e6)), color: th.star, kind: 'line', label: 'white noise' }, { y: keep.map((i) => Math.log10(b.rms[i] * 1e6)), color: th.model, kind: 'line', label: 'measured' }] }, th);
}
