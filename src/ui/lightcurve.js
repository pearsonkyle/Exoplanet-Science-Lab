// Light curve panel: data, model, posterior band, residuals, time cursor.
// renderLightCurve() is a pure drawing routine so the same code produces the
// on-screen plot and the exported figures (light or dark).

import { tokens, alpha, mix, groupPalette } from '../site/theme.js';

export const LC_THEMES = {
  dark: { bg: '#0b0f18', grid: '#1b2334', frame: null, text: '#8491ad', title: '#dfe6f3', data: 'rgba(201,211,230,0.42)', err: null, bin: '#ffffff', model: '#5fd4ff', band: 'rgba(180,140,255,0.30)', cursor: '#ffc56b', res: 'rgba(201,211,230,0.5)', font: 'ui-monospace, Menlo, monospace', sans: 'system-ui, sans-serif' },
  // white figure in the manner of EXOTIC's final light curve: grey points with error bars, blue bins, red model
  light: { bg: '#ffffff', grid: '#e9e9e9', frame: '#000000', text: '#111111', title: '#000000', data: 'rgba(60,60,60,0.45)', err: 'rgba(60,60,60,0.16)', bin: '#1f5fbf', model: '#d62728', band: 'rgba(214,39,40,0.20)', cursor: null, res: 'rgba(60,60,60,0.5)', font: 'Helvetica, Arial, sans-serif', sans: 'Helvetica, Arial, sans-serif' },
};

// The screen theme follows the site theme (src/site/theme.js): LC_THEMES.screen is LC_THEMES.dark in the Dark theme
// and a theme built from the site's colour tokens in the others. Exports keep asking for 'dark' or 'light' by name.
const screenCache = {};
function screenTheme() {
  const t = tokens();
  if (t.theme === 'dark') return LC_THEMES.dark;
  if (screenCache[t.theme]) return screenCache[t.theme];
  const base = t.light ? LC_THEMES.light : LC_THEMES.dark;
  const th = t.light
    ? { ...base, bg: t.panel, grid: mix(t.panel, t.line, 0.6), frame: t.line2, text: t.dim, title: t.text, font: LC_THEMES.dark.font, sans: LC_THEMES.dark.sans }
    : { ...base, bg: t.panel, grid: mix(t.panel, t.line, 0.85), text: t.dim, title: t.text, data: alpha(t.data, 0.42), bin: t.strong, model: t.model, band: alpha(t.post, 0.3), cursor: t.star, res: alpha(t.data, 0.5) };
  const g = groupPalette(t); if (g) th.groups = g;
  return (screenCache[t.theme] = th);
}
Object.defineProperty(LC_THEMES, 'screen', { get: screenTheme, enumerable: false });
if (typeof window !== 'undefined') window.addEventListener('esl-theme', () => { for (const k in screenCache) delete screenCache[k]; });

// One colour per observation (light-curve epoch or velocity instrument). Dark: tuned for the app's
// background. Light: the cycle EXOTIC's multi-light-curve figures use, so exported figures match its style.
export const GROUP_COLORS = {
  dark: ['#5fd4ff', '#ffc56b', '#6fe3a5', '#ff8fa3', '#b48cff', '#f4f1bb', '#7ee0d6', '#ff9f5a', '#9fb4ff', '#d0d6e2'],
  light: ['#000000', '#1f5fbf', '#2a9d3c', '#e88b00', '#7b3fb5', '#808080', '#d6249f', '#00a6b8', '#7fbf00'],
};
/** Colour of group g in a theme (themes are told apart by their background). */
export const groupColor = (th, g) => { const c = th.groups || GROUP_COLORS[th.frame ? 'light' : 'dark']; return c[g % c.length]; };

export function niceTicks(lo, hi, n) {
  const span = hi - lo; if (!(span > 0)) return [lo];
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  out.step = step; return out;
}
/** The longest of the candidate texts that fits in `room` px in the context's current font (the last one if none does). */
export function fitText(ctx, room, ...texts) { for (const t of texts) if (ctx.measureText(t).width <= room) return t; return texts[texts.length - 1]; }
/** As many of the items as fit in `room` px, joined by sep (the first one always). */
export function fitItems(ctx, items, room, sep = '     ', atLeastOne = true) {
  let out = '';
  for (const it of items) { const nx = out ? out + sep + it : it; if ((out || !atLeastOne) && ctx.measureText(nx).width > room) break; out = nx; }
  return out;
}
export const decimals = (step) => Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) - 1e-9) + (Math.abs(step / Math.pow(10, Math.floor(Math.log10(step))) - 2.5) < 1e-6 ? 1 : 0)));

/** Default x/y ranges for a dataset (what "reset view" returns to). */
export function autoView(d, x0, x1) {
  const n = d.t.length, pad = 0.03 * (d.t[n - 1] - d.t[0]);
  x0 = x0 ?? d.t[0] - pad; x1 = x1 ?? d.t[n - 1] + pad;
  const det = [];
  for (let i = 0; i < n; i++) if (d.t[i] >= x0 && d.t[i] <= x1) det.push(d.f[i] / d.base[i]);
  let dlo = 0.999, dhi = 1.001;
  if (det.length > 3) { det.sort((a, b) => a - b); dlo = det[Math.floor(0.005 * (det.length - 1))]; dhi = det[Math.ceil(0.995 * (det.length - 1))]; }
  let mlo = 1;
  for (let i = 0; i <= 200; i++) mlo = Math.min(mlo, d.fluxFn(x0 + ((x1 - x0) * i) / 200));
  const range = Math.max(dhi - dlo, 1e-5);
  // follow the model down, but never let a wildly wrong model squash the data flat
  const lo = Math.max(Math.min(dlo, mlo), dlo - 1.5 * range), hi = Math.max(dhi, 1 + 0.05 * range);
  const p = 0.1 * (hi - lo);
  return { x0, x1, y0: lo - p, y1: hi + 2.4 * p };   // head-room for the parameter annotation
}

/**
 * A bin grid fixed by the dataset, not by the view: the same width and edges at every zoom and pan, so the binned
 * points stay where they are and zooming in only shows fewer of them. Width: the larger of perBin times the median
 * cadence and the longest unbroken stretch (no gap over 20 cadences) over maxBins; edges at t0 + k w from the first
 * point. Bins are keyed by k (bin(), a Map of sums). null when there are fewer than 4 bins' worth of points.
 */
export function binGrid(t, maxBins = 40, perBin = 8) {
  const v = []; for (let i = 0; i < t.length; i++) if (Number.isFinite(t[i])) v.push(t[i]);
  if (v.length < 4 * perBin) return null;
  v.sort((p, q) => p - q);
  const dt = []; for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) dt.push(v[i] - v[i - 1]);
  if (!dt.length) return null;
  const sd = dt.slice().sort((p, q) => p - q), cad = sd[sd.length >> 1];
  let longest = 0, s0 = v[0];
  for (let i = 1; i < v.length; i++) { if (v[i] - v[i - 1] > 20 * cad) { longest = Math.max(longest, v[i - 1] - s0); s0 = v[i]; } }
  longest = Math.max(longest, v[v.length - 1] - s0);
  const w = Math.max(perBin * cad, longest / maxBins), t0 = v[0];
  return { t0, w, index: (x) => Math.floor((x - t0) / w) };
}

/**
 * d: { t, f, e, base, model, tmid, fluxFn(t), band: {t, lo, hi}|null, label, stats: {rms, chi2r}, cursor,
 *      group: Int32Array|null (observation index of each point) }
 * view: { x0, x1, y0, y1 }
 * opt: { fontScale, title, ptAlpha (0..1), modelAlpha (0..1), bins (bool), color (bool: colour by observation), groups: [names] }
 */
export function renderLightCurve(ctx, W, H, d, view, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  // type scale: larger for exported figures, slightly smaller on narrow screens
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, R = 16, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, gap = 10;
  // a short panel (a phone): a thinner residual strip, and no annotation or legend over the few pixels the curve has
  const short = H < 230, hRes = Math.max(short ? 34 : 48, (H - T - B) * 0.25), hMain = H - T - B - hRes - gap;
  const px0 = L, px1 = W - R, n = d.t.length;
  const span = view.x1 - view.x0, hours = span < 2.5, ux = hours ? 24 : 1;
  const X = (t) => px0 + ((t - view.x0) / span) * (px1 - px0);
  const Y = (v) => T + (1 - (v - view.y0) / (view.y1 - view.y0)) * hMain;
  const det = new Float64Array(n), res = new Float64Array(n), inView = [];
  for (let i = 0; i < n; i++) { det[i] = d.f[i] / d.base[i]; res[i] = (det[i] - d.model[i]) * 1e6; if (d.t[i] >= view.x0 && d.t[i] <= view.x1) inView.push(Math.abs(res[i])); }
  inView.sort((a, b) => a - b);
  const r99 = inView.length ? inView[Math.floor(0.99 * (inView.length - 1))] : 1000;
  // residual axis: symmetric, labelled at a round number of ppm either side of zero
  const rmax = Math.max(r99 * 1.3, 1), rmag = Math.pow(10, Math.floor(Math.log10(rmax * 0.8)));
  const rtick = [5, 2, 1].map((m) => m * rmag).find((v) => v <= rmax * 0.8) || rmag, rt = [-rtick, 0, rtick];
  const yR0 = T + hMain + gap, YR = (v) => yR0 + (1 - (v + rmax) / (2 * rmax)) * hRes;

  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  const xt = niceTicks((view.x0 - d.tmid) * ux, (view.x1 - d.tmid) * ux, Math.max(3, Math.floor((px1 - px0) / (80 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v / ux + d.tmid); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + hMain); ctx.moveTo(x, yR0); ctx.lineTo(x, yR0 + hRes); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, yR0 + hRes + 5); }
  ctx.fillText(hours ? fitText(ctx, px1 - px0, 'Time from mid-transit (hours)', 'Hours from mid-transit', 'Hours') : fitText(ctx, px1 - px0, 'Time from mid-transit (days)', 'Days from mid-transit', 'Days'), (px0 + px1) / 2, H - 5 - 11 * k);
  const yt = niceTicks(view.y0, view.y1, Math.max(hMain < 45 ? 1 : hMain < 80 ? 2 : 3, Math.floor(hMain / 36)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  for (const v of rt) { if (v === 0 && hRes < 70) continue; const y = YR(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(0), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, T + hMain / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(fitText(ctx, hMain, 'Relative flux', 'Flux', ''), 0, 0); ctx.restore();
  ctx.save(); ctx.translate(4 + 8 * k, yR0 + hRes / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(fitText(ctx, hRes, 'Residuals (ppm)', 'ppm'), 0, 0); ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(px0, T, px1 - px0, hMain); ctx.clip();
  if (d.band) {
    ctx.fillStyle = th.band; ctx.beginPath();
    d.band.t.forEach((t, i) => (i ? ctx.lineTo(X(t), Y(d.band.hi[i])) : ctx.moveTo(X(t), Y(d.band.hi[i]))));
    for (let i = d.band.t.length - 1; i >= 0; i--) ctx.lineTo(X(d.band.t[i]), Y(d.band.lo[i]));
    ctx.closePath(); ctx.fill();
  }
  const rpt = n > 1500 ? 1 : n > 500 ? 1.3 : 1.8;
  const grp = opt.color !== false && d.group && opt.groups && opt.groups.length > 1 ? d.group : null, ng = grp ? opt.groups.length : 0;
  const pa = (opt.ptAlpha ?? 0.45) / 0.45, ma = opt.modelAlpha ?? 1;   // the themes' point colours already carry alpha 0.45
  if (th.err && n <= 2500) { ctx.strokeStyle = th.err; ctx.beginPath(); for (let i = 0; i < n; i++) { const x = X(d.t[i]), s = d.e[i] / d.base[i]; ctx.moveTo(x, Y(det[i] - s)); ctx.lineTo(x, Y(det[i] + s)); } ctx.stroke(); }
  if (grp) {
    // each observation in its own colour
    ctx.globalAlpha = Math.min(1, 0.55 * pa);
    for (let g = 0; g < ng; g++) { ctx.fillStyle = groupColor(th, g); for (let i = 0; i < n; i++) { if (grp[i] !== g) continue; const x = X(d.t[i]); if (x < px0 - 3 || x > px1 + 3) continue; ctx.beginPath(); ctx.arc(x, Y(det[i]), rpt, 0, 6.3); ctx.fill(); } }
  } else {
    ctx.globalAlpha = Math.min(1, pa); ctx.fillStyle = th.data;
    for (let i = 0; i < n; i++) { const x = X(d.t[i]); if (x < px0 - 3 || x > px1 + 3) continue; ctx.beginPath(); ctx.arc(x, Y(det[i]), rpt, 0, 6.3); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  // bins across the visible window
  const vis = []; for (let i = 0; i < n; i++) if (d.t[i] >= view.x0 && d.t[i] <= view.x1) vis.push(i);
  // the grid is the whole dataset's (binGrid): zooming and panning do not move the bins
  const G = opt.bins === false ? null : binGrid(d.t), nb = G ? 4 : 0;   // nb: only "are there bins" from here on
  const acc = (keyOf, val) => { const M = new Map(); for (const i of vis) { const k = keyOf(i); let a = M.get(k); if (!a) M.set(k, (a = [0, 0, 0])); const w = val(i); a[0] += w; a[1] += w * det[i]; a[2] += w * d.t[i]; } return M; };
  // per-observation bins in the observation's colour (as in EXOTIC's combined light-curve figure), under the overall bins
  const GG = grp && G && ng <= 12 ? binGrid(d.t, 16, Math.max(6, 6 * ng)) : null;
  if (grp && GG) {
    const M = acc((i) => grp[i] * 1e9 + GG.index(d.t[i]), (i) => (d.base[i] / d.e[i]) ** 2);
    ctx.lineWidth = 1;
    for (const [k, [sw, sf, st]] of M) { if (!(sw > 0)) continue; const c = groupColor(th, Math.floor(k / 1e9)), x = X(st / sw), v = sf / sw, e = 1 / Math.sqrt(sw); ctx.strokeStyle = c; ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, Y(v - e)); ctx.lineTo(x, Y(v + e)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, Y(v), 2.2, 0, 6.3); ctx.fill(); }
  }
  if (G) {
    const M = acc((i) => G.index(d.t[i]), (i) => (d.base[i] / d.e[i]) ** 2);
    ctx.fillStyle = grp ? th.bg : th.bin; ctx.strokeStyle = grp ? th.title : th.bin; ctx.lineWidth = 1.2;
    for (const [, [sw, sf, st]] of M) { if (!(sw > 0)) continue; const x = X(st / sw), v = sf / sw, e = 1 / Math.sqrt(sw); ctx.beginPath(); ctx.moveTo(x, Y(v - e)); ctx.lineTo(x, Y(v + e)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, Y(v), grp ? 3.6 : 2.8, 0, 6.3); ctx.fill(); if (grp) ctx.stroke(); }
  }
  // model, evaluated across whatever is on screen so zooming never shows a coarse curve
  ctx.globalAlpha = ma; ctx.strokeStyle = th.model; ctx.lineWidth = 1.9; ctx.beginPath();
  const NM = Math.max(300, Math.min(1200, Math.round(px1 - px0)));
  for (let i = 0; i <= NM; i++) { const t = view.x0 + (span * i) / NM, y = Y(d.fluxFn(t)); i ? ctx.lineTo(X(t), y) : ctx.moveTo(X(t), y); }
  ctx.stroke(); ctx.globalAlpha = 1;
  ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(px0, yR0, px1 - px0, hRes); ctx.clip();
  ctx.globalAlpha = Math.min(1, (grp ? 0.55 : 1) * pa);
  for (let i = 0; i < n; i++) { const x = X(d.t[i]); if (x < px0 - 3 || x > px1 + 3) continue; ctx.fillStyle = grp ? groupColor(th, grp[i]) : th.res; ctx.beginPath(); ctx.arc(x, YR(res[i]), rpt, 0, 6.3); ctx.fill(); }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = th.model; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px0, YR(0)); ctx.lineTo(px1, YR(0)); ctx.stroke();
  ctx.restore();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, T + 0.5, px1 - px0 - 1, hMain - 1); ctx.strokeRect(px0 + 0.5, yR0 + 0.5, px1 - px0 - 1, hRes - 1); }

  if (th.cursor && d.cursor != null && d.cursor >= view.x0 && d.cursor <= view.x1) {
    const x = X(d.cursor); ctx.strokeStyle = th.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, yR0 + hRes); ctx.stroke();
    const y = Y(d.fluxFn(d.cursor)); if (y > T && y < T + hMain) { ctx.fillStyle = th.cursor; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.3); ctx.fill(); }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || (W >= 640 ? d.label : d.label.split(' · ')[0]), px0, T - 6);
  // fitted values, the way EXOTIC annotates its light curves
  if (d.info && d.info.length && hMain >= 110) {
    ctx.font = `${F(11)}px ${th.font}`; ctx.fillStyle = th.title;
    const txt = d.info.join('     '), wide = ctx.measureText(txt).width < px1 - px0 - 20;
    if (wide) { ctx.textAlign = 'right'; ctx.fillText(txt, px1 - 8, T + 6 + 11 * k); }
    else d.info.forEach((s2, i) => { ctx.textAlign = 'right'; ctx.fillText(s2, px1 - 8, T + 6 + 11 * k + i * 14 * k); });
  }
  // legend along the bottom of the main panel
  if (hMain < 90) return { px0, px1, T, hMain, yR0, hRes };
  let lx = px0 + 10; const ly = T + hMain - 9; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left';
  const item = (draw, txt) => { draw(lx); ctx.fillStyle = th.text; ctx.fillText(txt, lx + 19, ly); lx += 30 + ctx.measureText(txt).width; };
  item((x) => { ctx.strokeStyle = th.model; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, ly - 3.5); ctx.lineTo(x + 14, ly - 3.5); ctx.stroke(); }, 'model');
  if (d.band) item((x) => { ctx.fillStyle = th.band; ctx.fillRect(x + 2, ly - 9, 10, 10); }, W < 520 ? '68%' : 'posterior 68%');
  if (nb >= 4) item((x) => { ctx.fillStyle = grp ? th.bg : th.bin; ctx.strokeStyle = th.title; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 7, ly - 3.5, 2.8, 0, 6.3); ctx.fill(); if (grp) ctx.stroke(); }, grp ? 'all binned' : 'binned');
  // the observations and their colours, while they fit on the line
  if (grp) { ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; for (let g = 0; g < ng; g++) { const nm = opt.groups[g], w = 22 + ctx.measureText(nm).width; if (lx + w > px1 - (W >= 560 ? 190 : 8)) { if (g < ng) { ctx.fillStyle = th.text; ctx.fillText(`+${ng - g}`, lx, ly); } break; } ctx.fillStyle = groupColor(th, g); ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 3, 0, 6.3); ctx.fill(); ctx.fillStyle = th.text; ctx.fillText(nm, lx + 12, ly); lx += w; } }
  if (W >= 560 && d.stats) { ctx.textAlign = 'right'; ctx.font = `${F(10.5)}px ${th.font}`; ctx.fillStyle = th.text; ctx.fillText(`N ${n}    rms ${(d.stats.rms * 1e6).toFixed(0)} ppm`, px1 - 8, ly); }
  return { px0, px1, T, hMain, yR0, hRes };
}

export class LightCurvePlot {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.d = null; this.view = null; this.zoomed = false; this.onScrub = null; this.onViewChange = null; this.lay = null;
    this.opts = {};      // view options handed to the renderer: point and model opacity, bins, colour by observation
    this.alt = null;     // { data, render(ctx, W, H, data, theme, opts) }: another panel drawn in place of the light curve
    new ResizeObserver(() => this.draw()).observe(canvas);
    window.addEventListener('esl-theme', () => this.draw());
    let down = null, moved = false, pinch = null;
    const touches = new Map();   // pointers on the canvas: two of them pinch the time axis
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const tAt = (x) => this.view.x0 + ((x - this.lay.px0) / (this.lay.px1 - this.lay.px0)) * (this.view.x1 - this.view.x0);
    const two = () => { const [a, b] = [...touches.values()]; return { d: Math.max(8, Math.hypot(a[0] - b[0], a[1] - b[1])), cx: 0.5 * (a[0] + b[0]) }; };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.lay) return;
      touches.set(e.pointerId, pos(e)); canvas.setPointerCapture(e.pointerId);
      if (touches.size === 2) { pinch = { ...two(), v: { ...this.view } }; down = null; moved = true; return; }   // a pinch is not a click
      down = { p: pos(e), v: { ...this.view } }; moved = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, pos(e));
      if (pinch && touches.size === 2) {
        // the time under the fingers' midpoint stays under it while the span follows their distance
        const now = two(), { px0, px1 } = this.lay, v = pinch.v, w = px1 - px0, full = this.d.t[this.d.t.length - 1] - this.d.t[0];
        const span = Math.min(full * 6, Math.max(1e-5, ((v.x1 - v.x0) * pinch.d) / now.d)), tc = v.x0 + ((pinch.cx - px0) / w) * (v.x1 - v.x0), x0 = tc - ((now.cx - px0) / w) * span;
        this.view = this.yLocked ? { ...this.view, x0, x1: x0 + span } : autoView(this.d, x0, x0 + span); this._changed();
        return;
      }
      if (!down) return;
      const [x, y] = pos(e), dx = x - down.p[0], dy = y - down.p[1];
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true; canvas.style.cursor = 'grabbing';
      const { px0, px1, hMain, T } = this.lay, v = down.v;
      const sx = ((v.x1 - v.x0) * dx) / (px1 - px0), sy = down.p[1] < T + hMain ? ((v.y1 - v.y0) * dy) / hMain : 0;
      if (sy !== 0) this.yLocked = true;
      this.view = { x0: v.x0 - sx, x1: v.x1 - sx, y0: v.y0 + sy, y1: v.y1 + sy }; this._changed();
    });
    const lift = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
    const up = (e) => { lift(e); if (down && !moved && this.onScrub && this.lay) { const [x] = pos(e); const t = tAt(x); if (x >= this.lay.px0 && x <= this.lay.px1) this.onScrub(t); } down = null; canvas.style.cursor = ''; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', (e) => { lift(e); down = null; canvas.style.cursor = ''; });
    canvas.addEventListener('wheel', (e) => {
      if (!this.lay) return; e.preventDefault();
      const [x, y] = pos(e), f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0018))), v = this.view, { px0, px1, T, hMain } = this.lay;
      if (e.shiftKey || x < px0) { this.yLocked = true; const yc = v.y1 - ((y - T) / hMain) * (v.y1 - v.y0); this.view = { ...v, y0: yc - (yc - v.y0) * f, y1: yc + (v.y1 - yc) * f }; }
      else { const tc = tAt(Math.min(px1, Math.max(px0, x))); const full = this.d.t[this.d.t.length - 1] - this.d.t[0]; if ((v.x1 - v.x0) * f > full * 6 || (v.x1 - v.x0) * f < 1e-5) return; const nv = { x0: tc - (tc - v.x0) * f, x1: tc + (v.x1 - tc) * f }; this.view = this.yLocked ? { ...v, ...nv } : autoView(this.d, nv.x0, nv.x1); }
      this._changed();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { if (!this.alt) this.resetView(); });
  }
  _changed() { this.zoomed = true; this.draw(); if (this.onViewChange) this.onViewChange(this.view, true); }
  resetView() { if (!this.d) return; this.view = autoView(this.d, this.d.x0, this.d.x1); this.zoomed = false; this.yLocked = false; this.draw(); if (this.onViewChange) this.onViewChange(this.view, false); }
  /** New data or model. Keeps the x-zoom the user chose; flux limits follow the data unless the user set them. */
  set(d, resetView) {
    this.d = d;
    // d.x0 / d.x1, when given, are the window to open on (a transit inside a long folded span)
    if (resetView || !this.view || !this.zoomed) { this.view = autoView(d, d.x0, d.x1); this.zoomed = false; this.yLocked = false; }
    else if (!this.yLocked) this.view = autoView(d, this.view.x0, this.view.x1);   // keep the x-zoom, refit the flux axis
    this.draw();
  }
  setCursor(t) { if (this.d) { this.d.cursor = t; if (!this.alt) this.draw(); } }
  draw() {
    const cv = this.cv, dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H || !this.d) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lay = this.alt ? this.alt.render(this.ctx, W, H, this.alt.data, LC_THEMES.screen, this.opts) : renderLightCurve(this.ctx, W, H, this.d, this.view, LC_THEMES.screen, this.opts);
  }
  /** Off-screen render of the current view for export. */
  exportCanvas(theme, title, tRef, W = 900, H = 540, scale = 3) {
    const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale;
    const g = c.getContext('2d'); g.setTransform(scale, 0, 0, scale, 0, 0);
    if (this.alt) this.alt.render(g, W, H, this.alt.data, LC_THEMES[theme], { ...this.opts, toolsW: 0, title, fontScale: 1.35 });
    else renderLightCurve(g, W, H, { ...this.d, cursor: null }, this.view, LC_THEMES[theme], { ...this.opts, toolsW: 0, title, tRef, fontScale: 1.35 });
    c._cssW = W; c._cssH = H; return c;
  }
}

/**
 * The residuals on their own (data / baseline − model, in ppm) against time, with their error bars, bins and
 * a histogram on the right against a Gaussian of the same scatter. Same data object as renderLightCurve.
 * opt: { fontScale, title, x0, x1 (window, default the whole dataset), bins, color, groups }
 */
export function renderResiduals(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1), n = d.t.length;
  const L = 62 + 14 * k, R = 16, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, hW = W >= 480 ? Math.round(Math.min(150, 0.17 * W)) : 0, gap = hW ? 10 : 0;
  const px0 = L, px1 = W - R - hW - gap, py0 = T, py1 = H - B;
  const pad = 0.03 * (d.t[n - 1] - d.t[0] || 1), x0 = opt.x0 ?? d.t[0] - pad, x1 = opt.x1 ?? d.t[n - 1] + pad, span = x1 - x0, hours = span < 2.5, ux = hours ? 24 : 1;
  const res = new Float64Array(n), err = new Float64Array(n), vis = [];
  for (let i = 0; i < n; i++) { res[i] = (d.f[i] / d.base[i] - d.model[i]) * 1e6; err[i] = (d.e[i] / d.base[i]) * 1e6; if (d.t[i] >= x0 && d.t[i] <= x1) vis.push(i); }
  const abs = vis.map((i) => Math.abs(res[i])).sort((a, b) => a - b), r99 = abs.length ? abs[Math.floor(0.99 * (abs.length - 1))] : 1000, rmax = Math.max(1.35 * r99, 1);
  let ss = 0, c2 = 0; for (const i of vis) { ss += res[i] * res[i]; c2 += (res[i] / err[i]) ** 2; }
  const rms = Math.sqrt(ss / Math.max(1, vis.length));
  const X = (t) => px0 + ((t - x0) / span) * (px1 - px0), Y = (v) => py0 + (1 - (v + rmax) / (2 * rmax)) * (py1 - py0);
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  const xt = niceTicks((x0 - d.tmid) * ux, (x1 - d.tmid) * ux, Math.max(3, Math.floor((px1 - px0) / (80 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v / ux + d.tmid); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py1 + 5); }
  ctx.fillText(hours ? 'Time from mid-transit (hours)' : 'Time from mid-transit (days)', (px0 + px1) / 2, H - 5 - 11 * k);
  const yt = niceTicks(-rmax, rmax, Math.max(3, Math.floor((py1 - py0) / 40)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(0), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Residuals (ppm)', 0, 0); ctx.restore();

  const grp = opt.color !== false && d.group && opt.groups && opt.groups.length > 1 ? d.group : null, rpt = n > 1500 ? 1 : n > 500 ? 1.3 : 1.8;
  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  if (th.err && vis.length <= 2500) { ctx.strokeStyle = th.err; ctx.beginPath(); for (const i of vis) { const x = X(d.t[i]); ctx.moveTo(x, Y(res[i] - err[i])); ctx.lineTo(x, Y(res[i] + err[i])); } ctx.stroke(); }
  for (const i of vis) { ctx.fillStyle = grp ? groupColor(th, grp[i]) : th.res; ctx.beginPath(); ctx.arc(X(d.t[i]), Y(res[i]), rpt, 0, 6.3); ctx.fill(); }
  const G = opt.bins === false ? null : binGrid(d.t);   // fixed by the dataset, as in the light curve
  if (G) {
    const M = new Map(); for (const i of vis) { const k = G.index(d.t[i]); let q = M.get(k); if (!q) M.set(k, (q = [0, 0, 0])); const w = 1 / (err[i] * err[i]); q[0] += w; q[1] += w * res[i]; q[2] += w * d.t[i]; }
    ctx.fillStyle = th.bin; ctx.strokeStyle = th.bin; ctx.lineWidth = 1.2;
    for (const [, [sw, sf, st]] of M) { if (!(sw > 0)) continue; const x = X(st / sw), v = sf / sw, e = 1 / Math.sqrt(sw); ctx.beginPath(); ctx.moveTo(x, Y(v - e)); ctx.lineTo(x, Y(v + e)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, Y(v), 2.8, 0, 6.3); ctx.fill(); }
  }
  ctx.strokeStyle = th.model; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(px0, Y(0)); ctx.lineTo(px1, Y(0)); ctx.stroke();
  ctx.restore();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1); }
  // histogram of the residuals in view, sideways, with the Gaussian of the same rms
  if (hW && vis.length > 10) {
    const hx0 = px1 + gap, NB = 24, hist = new Float64Array(NB), bw = (2 * rmax) / NB;
    for (const i of vis) { const b = Math.floor((res[i] + rmax) / bw); if (b >= 0 && b < NB) hist[b]++; }
    const gPeak = (vis.length * bw) / (rms * Math.sqrt(2 * Math.PI)), hmax = Math.max(...hist, gPeak) * 1.08, HX = (c) => hx0 + (c / hmax) * hW;
    ctx.fillStyle = th.res;
    for (let b = 0; b < NB; b++) if (hist[b]) { const ya = Y(-rmax + (b + 1) * bw), yb = Y(-rmax + b * bw); ctx.fillRect(hx0, ya, HX(hist[b]) - hx0, Math.max(1, yb - ya - 1)); }
    ctx.strokeStyle = th.model; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let j = 0; j <= 120; j++) { const v = -rmax + (2 * rmax * j) / 120, g = gPeak * Math.exp(-0.5 * (v / rms) ** 2); j ? ctx.lineTo(HX(g), Y(v)) : ctx.moveTo(HX(g), Y(v)); }
    ctx.stroke();
    if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(hx0 + 0.5, py0 + 0.5, hW - 1, py1 - py0 - 1); }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || (d.label || '').split(' · ')[0] + ' · residuals', px0, T - 6);
  ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right';
  ctx.fillText(`N ${vis.length}     rms ${rms.toFixed(0)} ppm     χ²/N ${(c2 / Math.max(1, vis.length)).toFixed(2)}`, px1 - 8, py0 + 6 + 11 * k);
  return null;
}
