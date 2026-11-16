// Radial-velocity panel: velocities of every instrument in its own colour, the model, residuals.
// renderRV() is a pure drawing routine (screen, export and movie share it), like renderLightCurve().

import { niceTicks, decimals, groupColor, fitText, fitItems } from './lightcurve.js';

/**
 * d: { sets: [{ name, x[], y[], e[], res[] }],     x in days (time view) or orbital phase (folded), y and res in m/s
 *      curve: { x[], y[] } | null, fold: bool, xlabel, label, info: [strings] }
 * opt: { ptAlpha, modelAlpha, bins, color, fontScale, title }
 */
/** Axis ranges a panel would choose for itself: { x0, x1, y0, y1, rmax } (velocity and residual scales in m/s). */
export function rvExtent(d) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, rmax = 0;
  for (const s of d.sets || []) for (let i = 0; i < s.x.length; i++) {
    x0 = Math.min(x0, s.x[i]); x1 = Math.max(x1, s.x[i]); y0 = Math.min(y0, s.y[i] - s.e[i]); y1 = Math.max(y1, s.y[i] + s.e[i]); rmax = Math.max(rmax, Math.abs(s.res[i]) + s.e[i]);
  }
  if (d.fold) { x0 = -0.5; x1 = 0.5; } else { const p = 0.03 * (x1 - x0 || 1); x0 -= p; x1 += p; }
  if (d.curve) for (let i = 0; i < d.curve.x.length; i++) if (d.curve.x[i] >= x0 && d.curve.x[i] <= x1) { y0 = Math.min(y0, d.curve.y[i]); y1 = Math.max(y1, d.curve.y[i]); }
  const py = 0.08 * (y1 - y0 || 1);
  return { x0, x1, y0: y0 - py, y1: y1 + 2.2 * py, rmax: Math.max(rmax * 1.1, 1e-3) };
}

export function renderRV(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, R = 16, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, gap = 10;
  const short = H < 260, hRes = Math.max(short ? 34 : 48, (H - T - B) * 0.25), hMain = H - T - B - hRes - gap, px0 = L, px1 = W - R, yR0 = T + hMain + gap;
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  const sets = d.sets || [];
  if (!sets.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText(d.label || 'No radial velocities loaded', W / 2, H / 2); return null; }
  let { x0, x1, y0, y1, rmax } = rvExtent(d);
  // several panels side by side share one velocity scale, so the planets' amplitudes can be compared by eye
  if (opt.yRange) [y0, y1] = opt.yRange;
  if (opt.rmax) rmax = opt.rmax;
  const X = (x) => px0 + ((x - x0) / (x1 - x0)) * (px1 - px0), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * hMain, YR = (v) => yR0 + (1 - (v + rmax) / (2 * rmax)) * hRes;

  const xt = niceTicks(x0, x1, Math.max(3, Math.floor((px1 - px0) / (80 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + hMain); ctx.moveTo(x, yR0); ctx.lineTo(x, yR0 + hRes); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, yR0 + hRes + 5); }
  ctx.fillText(fitText(ctx, px1 - px0, d.xlabel || '', d.fold ? 'Orbital phase' : 'Time (days)', ''), (px0 + px1) / 2, H - 5 - 11 * k);
  const yt = niceTicks(y0, y1, Math.max(hMain < 45 ? 1 : hMain < 80 ? 2 : 3, Math.floor(hMain / 36)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  const rmag = Math.pow(10, Math.floor(Math.log10(rmax * 0.8))), rtick = [5, 2, 1].map((m) => m * rmag).find((v) => v <= rmax * 0.8) || rmag;
  for (const v of [-rtick, 0, rtick]) { if (v === 0 && hRes < 70) continue; const y = YR(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(rtick)), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, T + hMain / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(fitText(ctx, hMain, 'Radial velocity (m/s)', 'RV (m/s)', 'm/s'), 0, 0); ctx.restore();
  ctx.save(); ctx.translate(4 + 8 * k, yR0 + hRes / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(fitText(ctx, hRes, 'Residuals (m/s)', 'm/s'), 0, 0); ctx.restore();

  const pa = opt.ptAlpha ?? 0.45, ma = opt.modelAlpha ?? 1, col = (g) => (opt.color === false ? th.bin : groupColor(th, g));
  const drawSet = (yOf, top, hgt, useRes) => {
    ctx.save(); ctx.beginPath(); ctx.rect(px0, top, px1 - px0, hgt); ctx.clip();
    sets.forEach((s, g) => {
      ctx.strokeStyle = col(g); ctx.fillStyle = col(g); ctx.lineWidth = 1;
      ctx.globalAlpha = Math.min(1, pa * 1.1); ctx.beginPath();
      for (let i = 0; i < s.x.length; i++) { const x = X(s.x[i]), v = useRes ? s.res[i] : s.y[i]; ctx.moveTo(x, yOf(v - s.e[i])); ctx.lineTo(x, yOf(v + s.e[i])); }
      ctx.stroke();
      ctx.globalAlpha = Math.min(1, pa * 2);
      for (let i = 0; i < s.x.length; i++) { ctx.beginPath(); ctx.arc(X(s.x[i]), yOf(useRes ? s.res[i] : s.y[i]), 2.6, 0, 6.3); ctx.fill(); }
    });
    ctx.globalAlpha = 1; ctx.restore();
  };
  // model under the points in the main panel
  if (d.curve && ma > 0) {
    ctx.save(); ctx.beginPath(); ctx.rect(px0, T, px1 - px0, hMain); ctx.clip();
    ctx.globalAlpha = ma; ctx.strokeStyle = th.model; ctx.lineWidth = 1.7; ctx.beginPath();
    d.curve.x.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(d.curve.y[i])) : ctx.moveTo(X(x), Y(d.curve.y[i]))));
    ctx.stroke(); ctx.restore();
  }
  drawSet(Y, T, hMain, false);
  // phase bins over all instruments (folded view): weighted means, drawn the way the light-curve bins are
  if (d.fold && opt.bins !== false) {
    const nb = 12, sw = new Float64Array(nb), sv = new Float64Array(nb), sx = new Float64Array(nb), sr = new Float64Array(nb);
    for (const s of sets) for (let i = 0; i < s.x.length; i++) { const b = Math.min(nb - 1, Math.max(0, Math.floor((s.x[i] + 0.5) * nb))), w = 1 / (s.e[i] * s.e[i]); sw[b] += w; sv[b] += w * s.y[i]; sx[b] += w * s.x[i]; sr[b] += w * s.res[i]; }
    ctx.save(); ctx.beginPath(); ctx.rect(px0, T, px1 - px0, hMain + gap + hRes); ctx.clip();
    for (let b = 0; b < nb; b++) if (sw[b] > 0) {
      const x = X(sx[b] / sw[b]), e = 1 / Math.sqrt(sw[b]);
      for (const [y, lo, hi] of [[Y(sv[b] / sw[b]), Y(sv[b] / sw[b] - e), Y(sv[b] / sw[b] + e)], [YR(sr[b] / sw[b]), YR(sr[b] / sw[b] - e), YR(sr[b] / sw[b] + e)]]) {
        ctx.strokeStyle = th.title; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, lo); ctx.lineTo(x, hi); ctx.stroke();
        ctx.fillStyle = th.bg; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, 6.3); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }
  drawSet(YR, yR0, hRes, true);
  ctx.strokeStyle = th.model; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px0, YR(0)); ctx.lineTo(px1, YR(0)); ctx.stroke();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, T + 0.5, px1 - px0 - 1, hMain - 1); ctx.strokeRect(px0 + 0.5, yR0 + 0.5, px1 - px0 - 1, hRes - 1); }

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  const ttl = opt.title || d.label || ''; ctx.fillText(ttl, px0, T - 6);
  const titleW = ctx.measureText(ttl).width;
  // a short panel: the numbers go up beside the title and the legend out of the way of the data (or is left out)
  if (d.info && d.info.length) {
    ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right';
    // beside the title, clear of the plot's tool buttons when they lie over the canvas (opt.toolsW, px from the right)
    if (hMain < 120) { ctx.textAlign = 'left'; ctx.fillText(fitItems(ctx, d.info, W - (opt.toolsW || 0) - px0 - titleW - 28, '     ', false), px0 + titleW + 24, T - 6); }
    else ctx.fillText(fitItems(ctx, d.info, px1 - px0 - 20), px1 - 8, T + 6 + 11 * k);
  }
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left';
  if (hMain < 100) return null;
  // legend: one entry per instrument, wrapping onto a second row when there are many
  let lx = px0 + 10, ly = T + hMain - 9;
  const rowsNeeded = sets.reduce((a, s) => a + 26 + ctx.measureText(s.name).width, 0) > px1 - px0 - 20 ? 2 : 1;
  if (rowsNeeded === 2) ly -= 14 * k;
  sets.forEach((s, g) => {
    const w = 26 + ctx.measureText(s.name).width;
    if (lx + w > px1 - 6) { lx = px0 + 10; ly += 14 * k; }
    ctx.fillStyle = col(g); ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 3, 0, 6.3); ctx.fill();
    ctx.fillStyle = th.text; ctx.fillText(s.name, lx + 13, ly); lx += w;
  });
  return null;   // no pan and zoom on this panel
}
