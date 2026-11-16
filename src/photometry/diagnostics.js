// Detrending diagnostics as pure render functions (ctx, W, H, data, theme): no DOM beyond the 2D context that
// is passed in, so the same code draws on screen, into an export canvas, or on the analyzer page for any light
// curve with centroids. The numbers come from src/core/psd.js.
//
//   renderPsd        power spectral density of the residuals on log-log axes against the white level of the
//                    error bars and the photon-noise limit, with the fitted W + A f^-gamma and marked periods
//   renderRmsBin     rms of the binned residuals against bin size, with the white-noise expectation and beta
//   renderPixelMap   binned residual against the (x, y) centroid, the surface that is removed, and their difference
//
// Theme: the keys of PHOT_THEME (plots.js); optional extra keys divNeg, divMid, divPos for the diverging scale.

import { PHOT_THEME, niceTicks } from './plots.js';

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const pow10Label = (e, plain = e >= -3 && e <= 4) => (plain ? String(Number(Math.pow(10, e).toPrecision(1))) : '10' + String(e).split('').map((c) => SUP[c]).join(''));
const fmtStep = (v, step) => v.toFixed(Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) + 0.01))));
const sig = (v, n = 3) => (v === 0 ? '0' : Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3 ? v.toExponential(n - 1) : String(Number(v.toPrecision(n))));
/** A duration in minutes as a short label: 30 s, 5 min, 2 h, 3 d. */
export function durationLabel(min) {
  const r = (v) => String(Number(v.toPrecision(3)));
  return min < 1 ? r(min * 60) + ' s' : min < 60 ? r(min) + ' min' : min < 2880 ? r(min / 60) + ' h' : r(min / 1440) + ' d';
}
const DURATIONS = [1 / 60, 1 / 30, 1 / 12, 1 / 6, 0.5, 1, 2, 5, 10, 30, 60, 120, 360, 720, 1440, 2880, 7200, 14400, 43200, 144000];   // minutes
/** Minutes per period for a frequency in the given unit. */
const minutesPerCycle = (fUnit) => (fUnit === 'Hz' ? 1 / 60 : fUnit === '1/h' ? 60 : fUnit === '1/min' ? 1 : 1440);

function isDark(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return true; const v = parseInt(m[1], 16); return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) < 128; }
const rgbOf = (hex) => { const v = parseInt(hex.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; };

/**
 * Colour of a diverging scale for t in [-1, 1]: two hues and a neutral grey midpoint (never a hue at zero).
 * Dark surfaces get a dark grey midpoint and bright poles, light surfaces a light grey midpoint and deep poles,
 * so in both the magnitude reads as distance from the surface's neutral.
 */
export function divergingColor(t, th = PHOT_THEME) {
  const dark = isDark(th.bg), neg = rgbOf(th.divNeg || (dark ? '#4da3ff' : '#1f5fbf')), mid = rgbOf(th.divMid || (dark ? '#3a4254' : '#e3e5ea')), pos = rgbOf(th.divPos || (dark ? '#ff7262' : '#c53a2f'));
  const u = Math.max(-1, Math.min(1, t)), a = Math.abs(u), e = u < 0 ? neg : pos;
  return `rgb(${Math.round(mid[0] + a * (e[0] - mid[0]))},${Math.round(mid[1] + a * (e[1] - mid[1]))},${Math.round(mid[2] + a * (e[2] - mid[2]))})`;
}

/** Log-log frame: grid at the decades, minor ticks at 2..9, labels on the left and bottom. Returns the mappers. */
function logFrame(ctx, th, box, xr, yr, o = {}) {
  const { l, t, w, h } = box, lx0 = Math.log10(xr[0]), lx1 = Math.log10(xr[1]), ly0 = Math.log10(yr[0]), ly1 = Math.log10(yr[1]);
  const X = (v) => l + (Math.log10(v) - lx0) / (lx1 - lx0) * w, Y = (v) => t + h - (Math.log10(v) - ly0) / (ly1 - ly0) * h;
  ctx.font = th.font; ctx.lineWidth = 1;
  const decades = (a, b, px) => { const out = [], every = Math.max(1, Math.ceil((b - a) / Math.max(1, px / 34))); for (let e = Math.ceil(a - 1e-9); e <= b + 1e-9; e++) out.push({ e, label: (e - Math.ceil(a - 1e-9)) % every === 0 }); return out; };
  const plainX = lx0 >= -3.001 && lx1 <= 4.001, plainY = ly0 >= -3.001 && ly1 <= 4.001;   // one notation per axis
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const d of decades(ly0, ly1, h)) { const y = Math.round(Y(Math.pow(10, d.e))) + 0.5; ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + w, y); ctx.stroke(); if (d.label) { ctx.fillStyle = th.text; ctx.fillText(pow10Label(d.e, plainY), l - 6, y); } }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const d of decades(lx0, lx1, w * 0.6)) { const x = Math.round(X(Math.pow(10, d.e))) + 0.5; ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + h); ctx.stroke(); if (d.label) { ctx.fillStyle = th.text; ctx.fillText(pow10Label(d.e, plainX), x, t + h + 5); } }
  // minor ticks
  ctx.strokeStyle = th.frame; ctx.beginPath();
  for (let e = Math.floor(lx0); e <= lx1; e++) for (let m = 2; m <= 9; m++) { const v = m * Math.pow(10, e); if (v > xr[0] && v < xr[1]) { const x = Math.round(X(v)) + 0.5; ctx.moveTo(x, t + h); ctx.lineTo(x, t + h - 3); } }
  if (ly1 - ly0 < 7) for (let e = Math.floor(ly0); e <= ly1; e++) for (let m = 2; m <= 9; m++) { const v = m * Math.pow(10, e); if (v > yr[0] && v < yr[1]) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(l, y); ctx.lineTo(l + 3, y); } }
  ctx.stroke(); ctx.strokeRect(l + 0.5, t + 0.5, w, h);
  ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  if (o.xLabel) ctx.fillText(o.xLabel, l + w / 2, t + h + 30);
  if (o.yLabel) { ctx.save(); ctx.translate(11, t + h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(o.yLabel, 0, 0); ctx.restore(); }
  return { X, Y };
}

/** Tick marks and labels along the top edge at round durations; toX maps a duration in minutes to a pixel. */
function durationAxis(ctx, th, box, toX, label) {
  const { l, t, w } = box; ctx.font = th.font; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.strokeStyle = th.frame; ctx.fillStyle = th.text;
  const pts = DURATIONS.map((m) => ({ m, x: toX(m) })).filter((p) => p.x >= l - 0.5 && p.x <= l + w + 0.5).sort((a, b) => a.x - b.x); let last = -Infinity;
  const lw = label ? ctx.measureText(label).width + 10 : 0;
  for (const p of pts) {
    const x = Math.round(p.x) + 0.5, s = durationLabel(p.m), half = ctx.measureText(s).width / 2;
    ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t - 4); ctx.stroke();
    if (x - half < last + 8 || x - half < l - 20 || x + half > l + w - lw - 6) continue;
    ctx.fillText(s, x, t - 5); last = x + half;
  }
  if (label) { ctx.textAlign = 'right'; ctx.fillText(label, l + w, t - 5); }
}

/** Legend rows with a line swatch; text in the text colour (identity is carried by the swatch). corner: 'bl' | 'tr' | 'tl'. */
function legend(ctx, th, box, rows, corner = 'bl') {
  rows = rows.filter(Boolean); if (!rows.length) return;
  ctx.font = th.font; const lh = 15, sw = 22, wid = Math.max(...rows.map((r) => ctx.measureText(r.label).width)) + sw + 14, hgt = rows.length * lh + 6;
  const x0 = corner === 'tr' ? box.l + box.w - wid - 6 : box.l + 6, y0 = corner === 'bl' ? box.t + box.h - hgt - 6 : box.t + 6;
  ctx.globalAlpha = 0.78; ctx.fillStyle = th.bg; ctx.fillRect(x0, y0, wid, hgt); ctx.globalAlpha = 1;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    const y = y0 + 3 + lh * (i + 0.5);
    ctx.strokeStyle = r.color; ctx.lineWidth = r.width || 1.5; ctx.globalAlpha = r.alpha ?? 1; ctx.setLineDash(r.dash || []);
    if (r.band) { ctx.fillStyle = r.color; ctx.globalAlpha = 0.25; ctx.fillRect(x0 + 5, y - 4, sw - 4, 8); ctx.globalAlpha = 1; }
    ctx.beginPath(); ctx.moveTo(x0 + 5, Math.round(y) + 0.5); ctx.lineTo(x0 + 1 + sw, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    ctx.fillStyle = th.text; ctx.fillText(r.label, x0 + sw + 8, y);
  });
}

/**
 * Power spectral density of the residuals.
 * @param d { f, p            the PSD (periodogramPsd / welchPsd / lombScarglePsd); points with f <= 0 or p <= 0 are skipped
 *            binned: { f, p } logBinPsd of it (drawn strong; the raw one is drawn faint)
 *            white           level expected from the error bars (whiteNoiseLevel), same units as p
 *            photon          level of the photon-noise limit (photonNoiseLevel)
 *            fit             { W, A, gamma, knee[, red] } from fitRedNoise: the curve W + A f^-gamma (the legend gives
 *                            gamma and the knee, or the flat level alone when red is false)
 *            marks           [{ f, label }] vertical markers, e.g. the K2 roll at 1 / 5.88 h or 1 / transit duration
 *            fUnit           '1/d' (default) | '1/h' | '1/min' | 'Hz': unit of f, used for the labels and the period axis
 *            pScale = 1      factor applied to every power for display (1e12 turns relative-flux^2 into ppm^2)
 *            yLabel, title   yLabel defaults to "PSD (flux^2 per <fUnit>)"
 *            yRange          [lo, hi] to fix the vertical range (e.g. the same for "before" and "after") }
 * The top edge carries the same axis expressed as a period (one scale, two sets of labels).
 */
export function renderPsd(ctx, W, H, d, th = PHOT_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const sc = d.pScale ?? 1, fUnit = d.fUnit || '1/d', box = { l: 64, t: 36, w: W - 64 - 12, h: H - 36 - 34 };
  const fs = [], ps = [];
  for (let i = 0; i < d.f.length; i++) if (d.f[i] > 0 && d.p[i] > 0 && Number.isFinite(d.p[i])) { fs.push(d.f[i]); ps.push(d.p[i] * sc); }
  if (fs.length < 2 || box.w < 40 || box.h < 40) { ctx.fillStyle = th.text; ctx.font = th.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('no spectrum', W / 2, H / 2); return; }
  let f0 = Infinity, f1 = -Infinity; for (const v of fs) { if (v < f0) f0 = v; if (v > f1) f1 = v; }
  // vertical range: the raw periodogram has deep, meaningless minima: keep its upper 98%, and everything else that is drawn
  const sorted = Float64Array.from(ps).sort(); let y0 = sorted[Math.floor(0.02 * (sorted.length - 1))], y1 = sorted[sorted.length - 1];
  const levels = [d.white, d.photon, d.fit && d.fit.W].filter((v) => v > 0).map((v) => v * sc);
  for (const v of levels) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
  if (d.binned) for (let i = 0; i < d.binned.p.length; i++) { const v = d.binned.p[i] * sc; if (v > 0) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); } }
  y0 /= 2.5; y1 *= 2.5;
  const nLegend = 1 + (d.binned ? 1 : 0) + (d.fit && d.fit.W > 0 ? 1 : 0) + (d.white > 0 ? 1 : 0) + (d.photon > 0 ? 1 : 0), room = Math.min(0.45, (nLegend * 15 + 18) / box.h);
  y0 = Math.pow(10, Math.log10(y1) - (Math.log10(y1) - Math.log10(y0)) / (1 - room));   // the legend sits below the spectrum, not on it
  if (d.yRange) [y0, y1] = d.yRange;
  const xr = [f0 / 1.08, f1 * 1.08], { X, Y } = logFrame(ctx, th, box, xr, [y0, y1], { xLabel: `frequency (${fUnit})`, yLabel: d.yLabel || `PSD (flux² per ${fUnit})` });
  const mpc = minutesPerCycle(fUnit);
  durationAxis(ctx, th, box, (min) => X(mpc / min), 'period');
  if (d.title) { ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(d.title, box.l, 4); }
  ctx.save(); ctx.beginPath(); ctx.rect(box.l, box.t, box.w, box.h); ctx.clip();
  // raw
  ctx.strokeStyle = th.data; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i < fs.length; i++) { const x = X(fs[i]), y = Y(Math.max(ps[i], y0 / 10)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  ctx.stroke(); ctx.globalAlpha = 1;
  // marks
  for (const m of d.marks || []) {
    if (!(m.f > xr[0] && m.f < xr[1])) continue; const x = Math.round(X(m.f)) + 0.5;
    ctx.strokeStyle = th.post; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, box.t); ctx.lineTo(x, box.t + box.h); ctx.stroke(); ctx.setLineDash([]);
  }
  // levels
  const hline = (v, color, dash) => { if (!(v > 0)) return; const y = Math.round(Y(v * sc)) + 0.5; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(box.l, y); ctx.lineTo(box.l + box.w, y); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; };
  hline(d.photon, th.star, [7, 4]); hline(d.white, th.ok, [3, 3]);
  // fit
  if (d.fit && d.fit.W > 0) {
    ctx.strokeStyle = th.model; ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 0; k <= 120; k++) { const f = xr[0] * Math.pow(xr[1] / xr[0], k / 120), x = X(f), y = Y((d.fit.W + d.fit.A * Math.pow(f, -d.fit.gamma)) * sc); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke(); ctx.lineWidth = 1;
  }
  // binned
  if (d.binned && d.binned.f.length) {
    ctx.strokeStyle = th.strong; ctx.fillStyle = th.strong; ctx.lineWidth = 1.5; ctx.beginPath(); let pen = false;
    for (let i = 0; i < d.binned.f.length; i++) { const v = d.binned.p[i] * sc; if (!(v > 0)) { pen = false; continue; } const x = X(d.binned.f[i]), y = Y(v); if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; } }
    ctx.stroke(); ctx.lineWidth = 1;
    if (d.binned.f.length <= 80) for (let i = 0; i < d.binned.f.length; i++) { const v = d.binned.p[i] * sc; if (v > 0) { ctx.beginPath(); ctx.arc(X(d.binned.f[i]), Y(v), 2.5, 0, 2 * Math.PI); ctx.fill(); } }
  }
  ctx.restore();
  const placed = [];
  for (const m of d.marks || []) {   // labels last, on a patch of background, so the spectrum does not strike through them
    if (!(m.f > xr[0] && m.f < xr[1])) continue; const x = Math.round(X(m.f)), tw = ctx.measureText(m.label).width, left = x + 5 + tw > box.l + box.w - 2, tx = left ? x - 5 - tw : x + 5;
    let row = 0; while (placed.some((q) => q.row === row && tx < q.b + 6 && tx + tw > q.a - 6)) row++;   // a label that would run into another drops a line
    placed.push({ row, a: tx, b: tx + tw }); const ty = box.t + 4 + 15 * row;
    ctx.globalAlpha = 0.78; ctx.fillStyle = th.bg; ctx.fillRect(tx - 2, ty, tw + 4, 14); ctx.globalAlpha = 1;
    ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(m.label, tx, ty + 7);
  }
  const kneeMin = d.fit && d.fit.knee > 0 ? mpc / d.fit.knee : NaN;
  legend(ctx, th, box, [
    { label: 'periodogram of the residuals', color: th.data, alpha: 0.5, width: 1 },
    d.binned && { label: 'log-binned', color: th.strong, width: 2 },
    d.fit && d.fit.W > 0 && { label: d.fit.red !== false && d.fit.knee > f0 && Number.isFinite(kneeMin) ? `fit W + A f^−γ:  γ = ${d.fit.gamma.toFixed(2)}, knee ${sig(d.fit.knee)} ${fUnit} (${durationLabel(kneeMin)})` : `fit W + A f^−γ:  flat at W = ${sig(d.fit.W * sc)} (no power-law rise)`, color: th.model, width: 2 },
    d.white > 0 && { label: `white level of the error bars  ${sig(d.white * sc)}`, color: th.ok, dash: [3, 3] },
    d.photon > 0 && { label: `photon-noise limit  ${sig(d.photon * sc)}`, color: th.star, dash: [7, 4] },
  ], 'bl');
}

/**
 * rms of the binned residuals against bin size (rmsVsBin of src/core/psd.js).
 * @param d { n, rms, expected, rmsErr     the arrays of rmsVsBin
 *            dt            cadence in days: adds the duration of a bin along the top edge (omit for none)
 *            beta          number, or { value, n } (e.g. rmsVsBin().beta and .nBeta, or betaAt(N) for a chosen N)
 *            scale = 1e6, unit = 'ppm'   display units of the rms
 *            title }
 */
export function renderRmsBin(ctx, W, H, d, th = PHOT_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const sc = d.scale ?? 1e6, unit = d.unit || 'ppm', top = d.dt > 0 || d.title, box = { l: 64, t: top ? 36 : 10, w: W - 64 - 12, h: H - (top ? 36 : 10) - 34 };
  const idx = []; for (let i = 0; i < d.n.length; i++) if (d.n[i] > 0 && d.rms[i] > 0 && d.expected[i] > 0 && Number.isFinite(d.expected[i])) idx.push(i);
  if (idx.length < 2 || box.w < 40 || box.h < 40) { ctx.fillStyle = th.text; ctx.font = th.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('too few points to bin', W / 2, H / 2); return; }
  let y0 = Infinity, y1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (const i of idx) { const e = d.rmsErr ? d.rmsErr[i] : 0; y0 = Math.min(y0, (d.rms[i] - e) * sc, d.expected[i] * sc); y1 = Math.max(y1, (d.rms[i] + e) * sc, d.expected[i] * sc); n0 = Math.min(n0, d.n[i]); n1 = Math.max(n1, d.n[i]); }
  y0 = Math.max(y0, y1 * 1e-6) / 1.5; y1 *= 1.5;
  const xr = [n0 / 1.12, n1 * 1.12], { X, Y } = logFrame(ctx, th, box, xr, [y0, y1], { xLabel: 'bin size (points)', yLabel: `rms of binned residuals (${unit})` });
  if (d.dt > 0) durationAxis(ctx, th, box, (min) => X(min / (d.dt * 1440)), 'bin duration');
  if (d.title) { ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(d.title, box.l, 4); }
  ctx.save(); ctx.beginPath(); ctx.rect(box.l, box.t, box.w, box.h); ctx.clip();
  if (d.rmsErr) {
    ctx.fillStyle = th.data; ctx.globalAlpha = 0.22; ctx.beginPath();
    idx.forEach((i, k) => { const x = X(d.n[i]), y = Y((d.rms[i] + d.rmsErr[i]) * sc); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; ctx.lineTo(X(d.n[i]), Y(Math.max((d.rms[i] - d.rmsErr[i]) * sc, y0 / 10))); }
    ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = th.model; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath();
  idx.forEach((i, k) => { const x = X(d.n[i]), y = Y(d.expected[i] * sc); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = th.strong; ctx.lineWidth = 2; ctx.beginPath();
  idx.forEach((i, k) => { const x = X(d.n[i]), y = Y(d.rms[i] * sc); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.lineWidth = 1;
  const b = d.beta == null ? null : typeof d.beta === 'number' ? { value: d.beta } : d.beta;
  if (b && b.n >= xr[0] && b.n <= xr[1]) { const x = Math.round(X(b.n)) + 0.5; ctx.strokeStyle = th.post; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, box.t); ctx.lineTo(x, box.t + box.h); ctx.stroke(); ctx.setLineDash([]); }
  ctx.restore();
  const bl = b && Number.isFinite(b.value) ? `β = ${b.value.toFixed(2)}` + (b.n ? `  at N = ${b.n}` + (d.dt > 0 ? ` (${durationLabel(b.n * d.dt * 1440)})` : '') : '') : null;
  legend(ctx, th, box, [
    { label: 'binned residuals' + (d.rmsErr ? ' (band: rms / √(2M))' : ''), color: th.strong, width: 2, band: !!d.rmsErr },
    { label: 'white noise: σ₁/√N · √(M/(M−1))', color: th.model, dash: [6, 4] },
    bl && { label: bl, color: b.n ? th.post : th.bg, dash: [2, 3] },
  ], 'bl');
}

/**
 * Pixel map: the residual as a function of where the star sits on the detector.
 * @param d { map        binned mean residual, Float64Array(ny * nx) indexed [iy * nx + ix], NaN = empty (pixelMap().mean)
 *            surface    the removed surface on the same grid (polySurface().surface, gpSurface().surface)
 *            residual   map - surface (computed here when omitted and both are given)
 *            x, y       raw centroids: faint points on the first panel (track: true joins them in time order)
 *            grid       { x0, x1, y0, y1, nx, ny }
 *            count      optional: bins of `surface` without data are drawn dimmed
 *            units      'ppm' | '%' (default: ppm when the range is below 0.2%)
 *            vmax       half-range of the colour scale in the data's own units (default: the 98th percentile of
 *                       |map| and |surface|)
 *            titles     panel titles; title: overall title;  xLabel, yLabel }
 * One diverging colour scale centred on zero is shared by all panels (colour bar on the right); empty bins are
 * left transparent; solid lines mark the pixel boundaries (pixel centres at integers, edges at k + 0.5), so
 * structure inside a pixel can be told from structure across pixels.
 */
export function renderPixelMap(ctx, W, H, d, th = PHOT_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.font = th.font;
  const g = d.grid, m = g.nx * g.ny;
  let resid = d.residual; if (!resid && d.map && d.surface) { resid = new Float64Array(m); for (let k = 0; k < m; k++) resid[k] = d.map[k] - d.surface[k]; }
  const panels = [d.map && { v: d.map, title: 'binned residuals', pts: true }, d.surface && { v: d.surface, title: 'removed surface', dim: d.count }, resid && { v: resid, title: 'binned residuals − surface' }].filter(Boolean);
  if (d.titles) panels.forEach((p, i) => { if (d.titles[i]) p.title = d.titles[i]; });
  if (!panels.length) return;
  let vmax = d.vmax;
  if (!(vmax > 0)) { const a = []; for (const p of panels.slice(0, 2)) for (let k = 0; k < m; k++) if (Number.isFinite(p.v[k])) a.push(Math.abs(p.v[k])); a.sort((u, v) => u - v); vmax = a.length ? a[Math.floor(0.98 * (a.length - 1))] : 1; if (!(vmax > 0)) vmax = 1; }
  const units = d.units || (vmax < 2e-3 ? 'ppm' : '%'), us = units === 'ppm' ? 1e6 : units === '%' ? 100 : 1;
  const cbW = 74, mL = 64, gap = 30, mT = d.title ? 40 : 24, mB = 34, np = panels.length, pw = (W - mL - cbW - gap * (np - 1)) / np, ph = H - mT - mB;
  if (pw < 30 || ph < 30) return;
  // equal scale in x and y when that does not waste more than half of the panel
  const xr = g.x1 - g.x0, yr = g.y1 - g.y0, sx = pw / xr, sy = ph / yr, eq = sx / sy > 0.5 && sx / sy < 2, s = Math.min(sx, sy);
  const dw = eq ? s * xr : pw, dh = eq ? s * yr : ph;
  if (d.title) { ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(d.title, mL, 4); }
  panels.forEach((p, ip) => {
    const l = Math.round(mL + ip * (pw + gap) + (pw - dw) / 2), t = Math.round(mT + (ph - dh) / 2), X = (v) => l + (v - g.x0) / xr * dw, Y = (v) => t + dh - (v - g.y0) / yr * dh;
    for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) {
      const v = p.v[iy * g.nx + ix]; if (!Number.isFinite(v)) continue;
      const xa = Math.round(l + ix * dw / g.nx), xb = Math.round(l + (ix + 1) * dw / g.nx), ya = Math.round(t + dh - (iy + 1) * dh / g.ny), yb = Math.round(t + dh - iy * dh / g.ny);
      ctx.globalAlpha = p.dim && !(p.dim[iy * g.nx + ix] > 0) ? 0.3 : 1; ctx.fillStyle = divergingColor(v / vmax, th); ctx.fillRect(xa, ya, xb - xa, yb - ya);
    }
    ctx.globalAlpha = 1;
    ctx.save(); ctx.beginPath(); ctx.rect(l, t, dw, dh); ctx.clip();
    if (p.pts && d.x && d.y) {
      const n = d.x.length; ctx.fillStyle = th.strong; ctx.strokeStyle = th.strong;
      if (d.track) { ctx.globalAlpha = 0.12; ctx.beginPath(); let pen = false; for (let i = 0; i < n; i++) { if (!Number.isFinite(d.x[i]) || !Number.isFinite(d.y[i])) { pen = false; continue; } if (pen) ctx.lineTo(X(d.x[i]), Y(d.y[i])); else { ctx.moveTo(X(d.x[i]), Y(d.y[i])); pen = true; } } ctx.stroke(); }
      ctx.globalAlpha = n > 3000 ? 0.18 : n > 600 ? 0.3 : 0.5; const r = n > 1500 ? 0.6 : 1;
      for (let i = 0; i < n; i++) if (Number.isFinite(d.x[i]) && Number.isFinite(d.y[i])) ctx.fillRect(X(d.x[i]) - r, Y(d.y[i]) - r, 2 * r, 2 * r);
      ctx.globalAlpha = 1;
    }
    // pixel boundaries
    ctx.strokeStyle = th.strong; ctx.globalAlpha = 0.75; ctx.lineWidth = 1; ctx.beginPath();
    for (let e = Math.ceil(g.x0 - 0.5) + 0.5; e < g.x1; e += 1) if (e > g.x0) { const x = Math.round(X(e)) + 0.5; ctx.moveTo(x, t); ctx.lineTo(x, t + dh); }
    for (let e = Math.ceil(g.y0 - 0.5) + 0.5; e < g.y1; e += 1) if (e > g.y0) { const y = Math.round(Y(e)) + 0.5; ctx.moveTo(l, y); ctx.lineTo(l + dw, y); }
    ctx.stroke(); ctx.globalAlpha = 1; ctx.restore();
    ctx.strokeStyle = th.frame; ctx.strokeRect(l + 0.5, t + 0.5, dw, dh);
    // axes
    const tx = niceTicks(g.x0, g.x1, Math.max(2, Math.floor(dw / 70))), ty = niceTicks(g.y0, g.y1, Math.max(2, Math.floor(dh / 40)));
    ctx.fillStyle = th.text; ctx.strokeStyle = th.frame; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of tx.ticks) { const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, t + dh); ctx.lineTo(x, t + dh + 4); ctx.stroke(); ctx.fillText(fmtStep(v, tx.step), x, t + dh + 6); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ty.ticks) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l - 4, y); ctx.stroke(); if (ip === 0 || eq === false || dw < pw - 40) ctx.fillText(fmtStep(v, ty.step), l - 6, y); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(d.xLabel || 'x centroid (px)', l + dw / 2, t + dh + 32);
    if (ip === 0) { ctx.save(); ctx.translate(11, t + dh / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(d.yLabel || 'y centroid (px)', 0, 0); ctx.restore(); }
    ctx.fillStyle = th.strong; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(p.title, l, t - 5);
  });
  // colour bar
  const bx = W - cbW + 14, bw = 12, bt = mT + 14, bh = Math.max(20, ph - 14), steps = Math.min(200, Math.round(bh));
  for (let k = 0; k < steps; k++) { const ya = Math.round(bt + k * bh / steps), yb = Math.round(bt + (k + 1) * bh / steps); ctx.fillStyle = divergingColor(1 - 2 * (k + 0.5) / steps, th); ctx.fillRect(bx, ya, bw, yb - ya); }
  ctx.strokeStyle = th.frame; ctx.strokeRect(bx + 0.5, bt + 0.5, bw, bh);
  const tk = niceTicks(-vmax * us, vmax * us, Math.max(2, Math.floor(bh / 34)));
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const v of tk.ticks) { const y = Math.round(bt + bh * (1 - (v / us + vmax) / (2 * vmax))) + 0.5; ctx.beginPath(); ctx.moveTo(bx + bw, y); ctx.lineTo(bx + bw + 4, y); ctx.stroke(); ctx.fillText((v > 0 ? '+' : '') + fmtStep(v, tk.step), bx + bw + 7, y); }
  ctx.textBaseline = 'bottom'; ctx.fillText(units, bx, bt - 4);
}
