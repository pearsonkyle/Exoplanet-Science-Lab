// Planet + moon panels: the light curve with the moon's effects shown in isolation, the sky view of
// star, planet and moon, and the search map over the moon's period and phase.
// Pure drawing routines taking a theme (LC_THEMES), like renderLightCurve() and renderRV(), so the
// screen, the exported figure and the movie share them. The numbers come from src/core/exomoon.js.
//
// The isolated effects are told apart by dash pattern as well as colour (the house colour cycle is
// not safe for red-green colour blindness on its own), and each has its entry in the legend.

import { niceTicks, decimals, groupColor, fitText, fitItems, binGrid } from './lightcurve.js';

const frame = (ctx, th, x, y, w, h) => { if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); } };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// the isolated pieces: key in the curve object, legend text, colour slot, dash pattern
const EFFECTS = [
  { key: 'diff',    name: 'all of it: total − moonless', slot: -1, dash: [],        width: 3.2 },
  { key: 'moonDip', name: 'moon\'s own transit',         slot: 1,  dash: [7, 3],    width: 1.5 },
  { key: 'overlap', name: 'planet-moon eclipse',         slot: 4,  dash: [2, 3],    width: 1.7 },
  { key: 'wobble',  name: 'planet\'s wobble (TTV, TDV)', slot: 2,  dash: [9, 3, 2, 3], width: 1.5 },
];

/**
 * Light curve of a planet with a moon, and the moon's effects in isolation.
 * Three panels on one time axis: flux (data, full model, moonless planet), the isolated effects in ppm, residuals in ppm.
 *
 * d: { curve: { t[], total[], moonless[], moon[], overlap[], diff[], wobble[] },   a dense model grid: moonComponents(t, params) plus t
 *      t[], f[], e[], model[] (optional data, flux already divided by its baseline, and the full model at the data's times),
 *      tmid (time the x axis counts from), x0, x1 (optional window, same units as t), cursor (optional time),
 *      label, info: [strings] }
 * opt: { fontScale, title, ptAlpha, bins (false to hide), effects: [keys of the pieces to draw; default all of 'diff', 'moonDip', 'overlap', 'wobble'] }
 * returns { px0, px1, T, hMain, x0, x1 } for hit-testing.
 */
export function renderMoonLightCurve(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.setLineDash([]);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, gap = 10;
  // a wide, short panel: the legends go in a column on the right instead of over the curves
  const side = W > 760 && W > 3.4 * (H - T - B), R = side ? 16 + Math.round(Math.min(230, 150 + 70 * k)) : 16;
  const c = d.curve, hasData = !!(d.t && d.t.length), nd = hasData ? d.t.length : 0;
  if (!c || !c.t || !c.t.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.font = `${F(11)}px ${th.font}`; ctx.fillText(d.label || 'No moon model', W / 2, H / 2); return null; }
  const avail = H - T - B, hRes = hasData && d.model && avail > 200 ? Math.max(avail < 320 ? 34 : 44, avail * 0.17) : 0;
  const hEff = Math.max(Math.min(70, 0.42 * avail), (avail - hRes) * 0.4), hMain = avail - hRes - hEff - gap * (hRes ? 2 : 1);
  const px0 = L, px1 = W - R, yE0 = T + hMain + gap, yR0 = yE0 + hEff + gap;
  const x0 = d.x0 ?? c.t[0], x1 = d.x1 ?? c.t[c.t.length - 1], span = x1 - x0, tm = d.tmid ?? 0.5 * (x0 + x1), hours = span < 2.5, ux = hours ? 24 : 1;
  const X = (t) => px0 + ((t - x0) / span) * (px1 - px0);
  // ranges
  let y0 = Infinity, y1 = 1;
  for (let i = 0; i < c.t.length; i++) if (c.t[i] >= x0 && c.t[i] <= x1) y0 = Math.min(y0, c.total[i], c.moonless[i]);
  if (hasData) { const v = []; for (let i = 0; i < nd; i++) if (d.t[i] >= x0 && d.t[i] <= x1) v.push(d.f[i]); v.sort((a, b) => a - b); if (v.length > 3) { y0 = Math.min(y0, v[Math.floor(0.005 * (v.length - 1))]); y1 = Math.max(y1, v[Math.ceil(0.995 * (v.length - 1))]); } }
  if (!(y0 < y1)) y0 = y1 - 1e-4;
  const pad = 0.1 * (y1 - y0); y0 -= pad; y1 += 1.6 * pad;
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * hMain;
  const eff = { diff: c.diff, moonDip: c.moon.map ? Float64Array.from(c.moon, (v) => v - 1) : c.moon, overlap: c.overlap, wobble: c.wobble };
  const shown = EFFECTS.filter((e) => (opt.effects ? opt.effects.includes(e.key) : true) && eff[e.key]);
  let e0 = 0, e1 = 0;
  for (const e of shown) for (let i = 0; i < c.t.length; i++) if (c.t[i] >= x0 && c.t[i] <= x1) { const v = eff[e.key][i] * 1e6; if (v < e0) e0 = v; if (v > e1) e1 = v; }
  if (e1 - e0 < 1) { e0 -= 0.5; e1 += 0.5; }
  const ep = 0.08 * (e1 - e0); e0 -= ep; e1 += 2.6 * ep;
  const YE = (v) => yE0 + (1 - (v - e0) / (e1 - e0)) * hEff;
  let rmax = 1; const res = hRes ? new Float64Array(nd) : null;
  if (hRes) { const a = []; for (let i = 0; i < nd; i++) { res[i] = (d.f[i] - d.model[i]) * 1e6; if (d.t[i] >= x0 && d.t[i] <= x1) a.push(Math.abs(res[i])); } a.sort((p, q) => p - q); rmax = Math.max(1, 1.3 * (a.length ? a[Math.floor(0.99 * (a.length - 1))] : 1)); }
  const YR = (v) => yR0 + (1 - (v + rmax) / (2 * rmax)) * hRes;
  const bottom = hRes ? yR0 + hRes : yE0 + hEff;

  // grid and axes
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  const xt = niceTicks((x0 - tm) * ux, (x1 - tm) * ux, Math.max(3, Math.floor((px1 - px0) / (80 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v / ux + tm); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + hMain); ctx.moveTo(x, yE0); ctx.lineTo(x, yE0 + hEff); if (hRes) { ctx.moveTo(x, yR0); ctx.lineTo(x, yR0 + hRes); } ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, bottom + 5); }
  ctx.fillText(hours ? fitText(ctx, px1 - px0, 'Time from mid-transit (hours)', 'Hours from mid-transit', 'Hours') : fitText(ctx, px1 - px0, 'Time from mid-transit (days)', 'Days from mid-transit', 'Days'), (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const yt = niceTicks(y0, y1, Math.max(hMain < 45 ? 1 : hMain < 80 ? 2 : 3, Math.floor(hMain / 36)));
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  const et = niceTicks(e0, e1, Math.max(hEff < 45 ? 1 : 2, Math.floor(hEff / 30)));
  for (const v of et) { const y = YE(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(et.step)), px0 - 6, y); }
  if (hRes) { const rmag = Math.pow(10, Math.floor(Math.log10(rmax * 0.8))), rtick = [5, 2, 1].map((m) => m * rmag).find((v) => v <= rmax * 0.8) || rmag; for (const v of [-rtick, 0, rtick]) { if (v === 0 && hRes < 70) continue; const y = YR(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(0), px0 - 6, y); } }
  const ylab = (txt, y) => { ctx.save(); ctx.translate(4 + 8 * k, y); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = th.text; ctx.fillText(txt, 0, 0); ctx.restore(); };
  ylab(fitText(ctx, hMain, 'Relative flux', 'Flux', ''), T + hMain / 2); ylab(fitText(ctx, hEff, 'Moon effects (ppm)', 'ppm'), yE0 + hEff / 2); if (hRes) ylab(fitText(ctx, hRes, 'Residuals (ppm)', 'ppm'), yR0 + hRes / 2);

  const line = (yOf, arr, scale) => { ctx.beginPath(); let pen = false; for (let i = 0; i < c.t.length; i++) { const x = X(c.t[i]); if (x < px0 - 2 || x > px1 + 2) { pen = false; continue; } const y = yOf(arr[i] * scale); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; } ctx.stroke(); };
  const colOf = (e) => (e.slot < 0 ? th.model : groupColor(th, e.slot)), cMoonless = th.frame ? '#808080' : '#d0d6e2';

  // ---- flux panel
  ctx.save(); ctx.beginPath(); ctx.rect(px0, T, px1 - px0, hMain); ctx.clip();
  if (hasData) {
    const rpt = nd > 1500 ? 1 : nd > 500 ? 1.3 : 1.8;
    if (th.err && d.e && nd <= 2500) { ctx.strokeStyle = th.err; ctx.beginPath(); for (let i = 0; i < nd; i++) { const x = X(d.t[i]); ctx.moveTo(x, Y(d.f[i] - d.e[i])); ctx.lineTo(x, Y(d.f[i] + d.e[i])); } ctx.stroke(); }
    ctx.globalAlpha = Math.min(1, (opt.ptAlpha ?? 0.45) / 0.45); ctx.fillStyle = th.data;
    for (let i = 0; i < nd; i++) { const x = X(d.t[i]); if (x < px0 - 3 || x > px1 + 3) continue; ctx.beginPath(); ctx.arc(x, Y(d.f[i]), rpt, 0, 6.3); ctx.fill(); }
    ctx.globalAlpha = 1;
    const vis = []; for (let i = 0; i < nd; i++) if (d.t[i] >= x0 && d.t[i] <= x1) vis.push(i);
    const G = opt.bins === false ? null : binGrid(d.t, 48);   // fixed by the dataset: zooming does not move the bins
    if (G) {
      const M = new Map(); for (const i of vis) { const k = G.index(d.t[i]); let q = M.get(k); if (!q) M.set(k, (q = [0, 0, 0])); const w = d.e ? 1 / (d.e[i] * d.e[i]) : 1; q[0] += w; q[1] += w * d.f[i]; q[2] += w * d.t[i]; }
      ctx.fillStyle = th.bin; ctx.strokeStyle = th.bin; ctx.lineWidth = 1.2;
      for (const [, [sw0, sf0, st0]] of M) if (sw0 > 0) { const x = X(st0 / sw0), v = sf0 / sw0, s = d.e ? 1 / Math.sqrt(sw0) : 0; ctx.beginPath(); ctx.moveTo(x, Y(v - s)); ctx.lineTo(x, Y(v + s)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, Y(v), 2.8, 0, 6.3); ctx.fill(); }
    }
  }
  ctx.strokeStyle = cMoonless; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]); line(Y, c.moonless, 1);
  ctx.strokeStyle = th.model; ctx.lineWidth = 1.9; ctx.setLineDash([]); line(Y, c.total, 1);
  ctx.restore();

  // ---- isolated effects
  ctx.save(); ctx.beginPath(); ctx.rect(px0, yE0, px1 - px0, hEff); ctx.clip();
  ctx.strokeStyle = th.text; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(px0, YE(0)); ctx.lineTo(px1, YE(0)); ctx.stroke(); ctx.globalAlpha = 1;
  for (const e of shown) { ctx.strokeStyle = colOf(e); ctx.lineWidth = e.width; ctx.setLineDash(e.dash); line(YE, eff[e.key], 1e6); }
  ctx.setLineDash([]); ctx.restore();

  // ---- residuals
  if (hRes) {
    ctx.save(); ctx.beginPath(); ctx.rect(px0, yR0, px1 - px0, hRes); ctx.clip();
    const rpt = nd > 1500 ? 1 : nd > 500 ? 1.3 : 1.8; ctx.fillStyle = th.res;
    for (let i = 0; i < nd; i++) { const x = X(d.t[i]); if (x < px0 - 3 || x > px1 + 3) continue; ctx.beginPath(); ctx.arc(x, YR(res[i]), rpt, 0, 6.3); ctx.fill(); }
    ctx.strokeStyle = th.model; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px0, YR(0)); ctx.lineTo(px1, YR(0)); ctx.stroke(); ctx.restore();
  }
  frame(ctx, th, px0, T, px1 - px0, hMain); frame(ctx, th, px0, yE0, px1 - px0, hEff); if (hRes) frame(ctx, th, px0, yR0, px1 - px0, hRes);
  if (th.cursor && d.cursor != null && d.cursor >= x0 && d.cursor <= x1) { const x = X(d.cursor); ctx.strokeStyle = th.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, bottom); ctx.stroke(); }

  // title, annotation, legends
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  const ttl = opt.title || d.label || ''; ctx.fillText(ttl, px0, T - 6);
  const titleW = ctx.measureText(ttl).width;
  if (d.info && d.info.length) {
    ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right'; const txt = d.info.join('     ');
    if (side || hMain < 120) ctx.fillText(fitItems(ctx, d.info, W - R - px0 - titleW - 20 + (side ? R - 16 : 0), '     ', false), W - 16, T - 6);
    else if (ctx.measureText(txt).width < px1 - px0 - 20) ctx.fillText(txt, px1 - 8, T + 6 + 11 * k); else d.info.forEach((s, i) => ctx.fillText(s, px1 - 8, T + 6 + 11 * k + i * 14 * k));
  }
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left';
  const legend = (items, yTop) => {
    const x0l = side ? px1 + 14 : px0 + 10, x1l = side ? W - 6 : px1 - 6;
    let lx = x0l, ly = yTop + 13 * k;
    for (const it of items) {
      const w = 38 + ctx.measureText(it.name).width;
      if ((side && lx > x0l) || (lx + w > x1l && lx > x0l)) { lx = x0l; ly += 13 * k; }
      ctx.strokeStyle = it.color; ctx.lineWidth = it.width; ctx.setLineDash(it.dash); ctx.beginPath(); ctx.moveTo(lx, ly - 3.5); ctx.lineTo(lx + 22, ly - 3.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = th.text; ctx.fillText(it.name, lx + 27, ly); lx += w;
    }
  };
  if (!side && hMain < 110) return { px0, px1, T, hMain, x0, x1 };   // no room for legends over the curves
  legend([{ name: 'planet + moon', color: th.model, width: 2, dash: [] }, { name: 'planet alone, no moon', color: cMoonless, width: 1.4, dash: [5, 4] }], side ? T - 6 * k : T + hMain - 20 * k);
  legend(shown.map((e) => ({ name: e.name, color: colOf(e), width: e.width, dash: e.dash })), yE0 + 1);
  return { px0, px1, T, hMain, x0, x1 };
}

/**
 * Sky view at one moment: the limb-darkened star, the planet and the moon as discs, the moon's orbit about the
 * planet, and optionally the paths both have followed. X to the right, Y up, as seen by the observer.
 *
 * d: { planet: [X, Y, Z], moon: [X, Y, Z] (stellar radii; planetPosition() and moonPosition()), rp, rm (radii, stellar radii),
 *      path: Float32Array(3n) | null (moonOrbitPath(): the moon's ring about the planet at this moment),
 *      tracks: { planet: [[X, Y], ...], moon: [[X, Y], ...] } | null (where each has been and will go across the sky),
 *      ld: [a1..a4] Claret coefficients for the star's shading (optional), half (half-width of the view in stellar radii, default
 *      fits the star and the moon's orbit), cx (centre of the view in X, default 0), label, info: [strings] }
 * opt: { fontScale, title, starColor ('#ffd9a0') }
 */
export function renderMoonSky(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.setLineDash([]);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 20 + 14 * k, L = 12, R = 12;
  const w = W - L - R, h = H - T - B;
  let half = d.half;
  if (!half) { half = 1.25; if (d.path) for (let i = 0; i < d.path.length; i += 3) half = Math.max(half, Math.abs(d.path[i] - (d.cx || 0)) * 1.08); }
  const s = Math.min(w / (2 * half), h / 2.6), cx = L + w / 2, cy = T + h / 2, x00 = d.cx || 0;
  const PX = (x) => cx + (x - x00) * s, PY = (y) => cy - y * s;
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, w, h); ctx.clip();
  // star: radial gradient following the limb-darkening law
  const a = d.ld || [0, 0.6, 0, 0], col = rgb(opt.starColor || '#ffd9a0'), g = ctx.createRadialGradient(PX(0), PY(0), 0, PX(0), PY(0), s);
  for (let i = 0; i <= 24; i++) { const r = Math.sin(((i / 24) * Math.PI) / 2), mu = Math.sqrt(Math.max(0, 1 - r * r)), q = Math.sqrt(mu), I = Math.max(0.03, 1 - a[0] * (1 - q) - a[1] * (1 - mu) - a[2] * (1 - mu * q) - a[3] * (1 - mu * mu)); g.addColorStop(Math.min(1, r), `rgb(${col.map((v) => Math.round(v * Math.min(1, I))).join(',')})`); }
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(PX(0), PY(0), s, 0, 6.3); ctx.fill();
  if (th.frame) { ctx.strokeStyle = '#b08a4a'; ctx.lineWidth = 1; ctx.stroke(); }
  // paths across the sky
  const cP = groupColor(th, th.frame ? 1 : 0), cM = groupColor(th, th.frame ? 3 : 1);
  const poly = (pts, color, dash) => { if (!pts || pts.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash(dash); ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(PX(p[0]), PY(p[1])) : ctx.moveTo(PX(p[0]), PY(p[1])))); ctx.stroke(); ctx.setLineDash([]); };
  if (d.tracks) { poly(d.tracks.planet, cP, [5, 4]); poly(d.tracks.moon, cM, [2, 3]); }
  // the moon's ring about the planet: the half nearer the observer solid, the far half faint
  if (d.path) {
    const n = d.path.length / 3, zc = d.planet[2];
    for (const near of [false, true]) {
      ctx.strokeStyle = th.title; ctx.lineWidth = near ? 1.3 : 1; ctx.globalAlpha = near ? 0.9 : 0.35; ctx.beginPath();
      for (let i = 0; i < n; i++) { const j = (i + 1) % n, isNear = 0.5 * (d.path[3 * i + 2] + d.path[3 * j + 2]) >= zc; if (isNear !== near) continue; ctx.moveTo(PX(d.path[3 * i]), PY(d.path[3 * i + 1])); ctx.lineTo(PX(d.path[3 * j]), PY(d.path[3 * j + 1])); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // the bodies, far one first; a body behind the star is hidden where the star covers it
  const bodies = [{ p: d.planet, r: d.rp, c: cP, name: 'planet' }, { p: d.moon, r: d.rm, c: cM, name: 'moon' }].sort((u, v) => u.p[2] - v.p[2]);
  const dark = th.frame ? '#000000' : '#05070c';
  for (const b of bodies) {
    const x = PX(b.p[0]), y = PY(b.p[1]), r = Math.max(b.r * s, 1.5), behind = b.p[2] < 0;
    ctx.save();
    if (behind) { ctx.beginPath(); ctx.rect(L, T, w, h); ctx.arc(PX(0), PY(0), s, 0, 6.3, true); ctx.clip(); }
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
    ctx.strokeStyle = b.c; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(x, y, r + 0.7, 0, 6.3); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  if (th.frame) frame(ctx, th, L, T, w, h);
  // scale bar: one stellar radius
  ctx.strokeStyle = th.text; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L + 12, T + h - 12); ctx.lineTo(L + 12 + s, T + h - 12); ctx.stroke();
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('1 R★', L + 12, T + h - 17);
  // legend: both bodies, with what the moon is doing
  const dx = d.moon[0] - d.planet[0], dy = d.moon[1] - d.planet[1], sep = Math.hypot(dx, dy), front = d.moon[2] > d.planet[2];
  const state = sep < Math.abs(d.rp - d.rm) ? (front ? 'in front of the planet' : 'behind the planet') : sep < d.rp + d.rm ? (front ? 'crossing the planet\'s limb, in front' : 'crossing the planet\'s limb, behind') : front ? 'nearer than the planet' : 'farther than the planet';
  let lx = L + 12; const ly = T + 14 * k + 2;
  for (const [name, color] of [['planet', cP], [`moon (${state})`, cM]]) { ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 4, 0, 6.3); ctx.fill(); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(name, lx + 14, ly); lx += 26 + ctx.measureText(name).width; }
  ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`; ctx.fillText(opt.title || d.label || '', L, T - 6);
  if (d.info && d.info.length) { ctx.font = `${F(11)}px ${th.font}`; ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText(d.info.join('     '), W / 2, H - 8); }
  return null;
}

/**
 * The search map: signal-to-noise of a trial moon over its period and its phase at the planet's mid-transit,
 * with the best phase for each period above it.
 *
 * d: the object moonSearch() returns ({ periods, phases, snr, profile, best, nullMax, fap }), plus optionally
 *    truth: { permoon, phmoon } (an injected moon, marked), threshold (S/N line to draw; default the largest of nullMax if there are any),
 *    x0, x1 (period window), label, info: [strings]
 * opt: { fontScale, title }
 * The map shows dimming moons only (S/N > 0), one hue from the background (0) to the model colour (the maximum).
 */
export function renderMoonSearch(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.setLineDash([]);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, R = 64 + 10 * k, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, gap = 10;
  ctx.font = `${F(11)}px ${th.font}`;
  if (!d || !d.periods || !d.periods.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText((d && d.label) || 'No search yet', W / 2, H / 2); return null; }
  const nP = d.periods.length, nPh = d.phases.length, hTop = Math.max(60, (H - T - B) * 0.34), hMap = H - T - B - hTop - gap, px0 = L, px1 = W - R, yM0 = T + hTop + gap;
  const pLo = Math.min(d.periods[0], d.periods[nP - 1]), pHi = Math.max(d.periods[0], d.periods[nP - 1]), x0 = d.x0 ?? pLo, x1 = d.x1 ?? pHi;
  const X = (p) => px0 + ((p - x0) / (x1 - x0)) * (px1 - px0);
  // one column per pixel: the largest S/N of the periods that fall in it, for each phase and overall
  const nx = Math.max(2, Math.round(px1 - px0)), colMax = new Float32Array(nx * nPh).fill(-Infinity), prof = new Float32Array(nx).fill(-Infinity);
  let zMax = 0;
  for (let ip = 0; ip < nP; ip++) {
    const c = Math.floor(((d.periods[ip] - x0) / (x1 - x0)) * nx); if (c < 0 || c >= nx) continue;
    for (let ih = 0; ih < nPh; ih++) { const z = d.snr[ip * nPh + ih]; if (z > colMax[c * nPh + ih]) colMax[c * nPh + ih] = z; if (z > prof[c]) prof[c] = z; if (z > zMax) zMax = z; }
  }
  for (let c = 1; c < nx; c++) if (prof[c] === -Infinity) { prof[c] = prof[c - 1]; for (let ih = 0; ih < nPh; ih++) colMax[c * nPh + ih] = colMax[(c - 1) * nPh + ih]; }   // fewer periods than pixels
  const thr = d.threshold ?? (d.nullMax && d.nullMax.length ? Math.max(...d.nullMax) : null);
  zMax = Math.max(zMax, thr || 0, 1);
  const yTopMax = zMax * 1.5, YT = (z) => T + (1 - Math.max(0, z) / yTopMax) * hTop, YM = (ph) => yM0 + (1 - ph) * hMap;
  // heat map
  const c0 = rgb(th.bg), c1 = rgb(th.model), img = ctx.createImageData(nx, Math.max(1, Math.round(hMap))), hh = img.height;
  for (let y = 0; y < hh; y++) {
    const ih = Math.min(nPh - 1, Math.floor((1 - (y + 0.5) / hh) * nPh));
    for (let c = 0; c < nx; c++) { const z = colMax[c * nPh + ih], u = z > 0 ? Math.pow(Math.min(1, z / zMax), 1.0) : 0, o = 4 * (y * nx + c); img.data[o] = c0[0] + (c1[0] - c0[0]) * u; img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * u; img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * u; img.data[o + 3] = 255; }
  }
  // putImageData ignores the transform, so draw through a scratch canvas when one is available (export scale, device pixel ratio)
  if (typeof document !== 'undefined') { const sc = document.createElement('canvas'); sc.width = nx; sc.height = hh; sc.getContext('2d').putImageData(img, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(sc, px0, yM0, px1 - px0, hMap); }
  else ctx.putImageData(img, px0, yM0);
  // axes
  ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xt = niceTicks(x0, x1, Math.max(4, Math.floor((px1 - px0) / (48 * k + 12))));
  for (const v of xt) { const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + hTop); ctx.stroke(); ctx.strokeStyle = th.text; ctx.beginPath(); ctx.moveTo(x, yM0 + hMap); ctx.lineTo(x, yM0 + hMap + 4); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, yM0 + hMap + 6); }
  ctx.fillText('Moon period (days)', (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const zt = niceTicks(0, yTopMax, Math.max(2, Math.floor(hTop / 30)));
  for (const v of zt) { const y = YT(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(zt.step)), px0 - 6, y); }
  for (const v of [0, 0.25, 0.5, 0.75, 1]) { const y = YM(v); ctx.strokeStyle = th.text; ctx.beginPath(); ctx.moveTo(px0 - 4, y); ctx.lineTo(px0, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(2), px0 - 6, y); }
  const ylab = (txt, y) => { ctx.save(); ctx.translate(4 + 8 * k, y); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = th.text; ctx.fillText(txt, 0, 0); ctx.restore(); };
  ylab('Best S/N', T + hTop / 2); ylab('Moon phase at mid-transit', yM0 + hMap / 2);
  // profile
  ctx.save(); ctx.beginPath(); ctx.rect(px0, T, px1 - px0, hTop); ctx.clip();
  ctx.strokeStyle = th.model; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let c = 0; c < nx; c++) { const x = px0 + ((c + 0.5) / nx) * (px1 - px0), y = YT(prof[c] === -Infinity ? 0 : prof[c]); c ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  if (thr) { ctx.strokeStyle = th.text; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(px0, YT(thr)); ctx.lineTo(px1, YT(thr)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.restore();
  if (thr) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.fillStyle = th.text; ctx.fillText(d.nullMax && d.nullMax.length && d.threshold == null ? `largest of ${d.nullMax.length} noise-only searches` : 'threshold', px1 - 6, YT(thr) - 3); ctx.font = `${F(11)}px ${th.font}`; }
  // markers: the best trial moon and, if given, the injected one
  const mark = (p, ph, kind) => {
    if (!(p >= x0 && p <= x1)) return; const x = X(p), y = YM(ph);
    ctx.lineWidth = 3.4; ctx.strokeStyle = th.bg; const draw = () => { ctx.beginPath(); if (kind === 'best') ctx.arc(x, y, 8, 0, 6.3); else { ctx.moveTo(x - 9, y - 9); ctx.lineTo(x - 4, y - 4); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x - 9, y + 9); ctx.lineTo(x - 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x + 9, y - 9); } ctx.stroke(); };
    draw(); ctx.lineWidth = 1.6; ctx.strokeStyle = th.title; draw();
  };
  ctx.save(); ctx.beginPath(); ctx.rect(px0, yM0, px1 - px0, hMap); ctx.clip();
  if (d.truth) mark(d.truth.permoon, d.truth.phmoon, 'truth');
  if (d.best) mark(d.best.permoon, d.best.phmoon, 'best');
  ctx.restore();
  if (d.best && d.best.permoon >= x0 && d.best.permoon <= x1) { const x = X(d.best.permoon); ctx.fillStyle = th.title; ctx.beginPath(); ctx.arc(x, YT(d.best.snr), 3.2, 0, 6.3); ctx.fill(); }
  ctx.strokeStyle = th.frame || th.grid; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, T + 0.5, px1 - px0 - 1, hTop - 1); ctx.strokeRect(px0 + 0.5, yM0 + 0.5, px1 - px0 - 1, hMap - 1);
  // colour bar
  const bx = px1 + 14, bw = 10, grad = ctx.createLinearGradient(0, yM0 + hMap, 0, yM0); grad.addColorStop(0, th.bg); grad.addColorStop(1, th.model);
  ctx.fillStyle = grad; ctx.fillRect(bx, yM0, bw, hMap); ctx.strokeStyle = th.frame || th.text; ctx.strokeRect(bx + 0.5, yM0 + 0.5, bw - 1, hMap - 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = th.text;
  for (const v of niceTicks(0, zMax, Math.max(2, Math.floor(hMap / 40)))) ctx.fillText(v.toFixed(0), bx + bw + 5, yM0 + (1 - v / zMax) * hMap);
  ctx.textBaseline = 'alphabetic'; ctx.fillText('S/N', bx - 2, yM0 - 6);
  // title, annotation, marker legend
  ctx.textAlign = 'left'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`; ctx.fillText(opt.title || d.label || '', px0, T - 6);
  const info = d.info || (d.best ? [`best: P ${d.best.permoon.toFixed(4)} d`, `phase ${d.best.phmoon.toFixed(3)}`, `Rm/R★ ${d.best.rmoon.toFixed(4)}`, `S/N ${d.best.snr.toFixed(1)}`, ...(Number.isFinite(d.fap) ? [`FAP ${d.fap <= 1 / (d.nullMax.length + 1) + 1e-12 ? '< ' : ''}${d.fap.toFixed(3)}`] : [])] : []);
  const titleW = ctx.measureText(opt.title || d.label || '').width;
  if (info.length) {
    // the first line shares the title's row, what does not fit goes inside the panel
    ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right';
    const lines = []; let cur = '';
    for (const it of info) { const nxt = cur ? cur + '   ' + it : it, room = px1 - px0 - (lines.length ? 150 * k : titleW + 24); if (cur && ctx.measureText(nxt).width > room) { lines.push(cur); cur = it; } else cur = nxt; }
    if (cur) lines.push(cur);
    lines.forEach((ln, i) => ctx.fillText(ln, px1 - (i ? 8 : 0), i ? T + 4 + 12 * k + (i - 1) * 13 * k : T - 6));
  }
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.fillStyle = th.text;
  let lx = px0 + 10; const ly = T + 4 + 12 * k;
  ctx.strokeStyle = th.title; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 4.5, 0, 6.3); ctx.stroke(); ctx.fillText('best', lx + 14, ly); lx += 28 + ctx.measureText('best').width;
  if (d.truth) { ctx.beginPath(); ctx.moveTo(lx, ly - 8); ctx.lineTo(lx + 9, ly + 1); ctx.moveTo(lx, ly + 1); ctx.lineTo(lx + 9, ly - 8); ctx.stroke(); ctx.fillText('injected', lx + 14, ly); }
  return { px0, px1, yM0, hMap, x0, x1 };
}
