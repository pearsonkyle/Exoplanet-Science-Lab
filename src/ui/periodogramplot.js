// Periodogram of transit-timing residuals: power against period on a logarithmic axis, false-alarm levels,
// the strongest peaks labelled, and optionally the periodogram of what is left after the first sinusoid.
// renderPeriodogram() is a pure drawing routine, like renderOC(): the same code draws the on-screen panel
// and the exported figure, in either theme.

import { LC_THEMES, niceTicks, decimals, groupColor } from './lightcurve.js';

const fmtPeriod = (p) => (p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toFixed(3));
const fmtLevel = (p) => `${+(100 * p).toPrecision(2)}%`;

/**
 * d: the object returned by timingPeriodogram() in src/core/periodogram.js, or any object with the same fields:
 *   {
 *     periodograms: [pg, pg2 | null]      the second is drawn only when present and opt.second is not false
 *     period                              optional: orbital period, days per epoch (for peak labels in days and opt.unit 'days')
 *     label                               optional: text at the top left when opt.title is not given
 *   }
 *   pg = {
 *     period: array-like, epochs          (any order; timingPeriodogram gives it descending)
 *     power:  array-like, same length
 *     label                               legend text, e.g. 'O − C'
 *     fapLevels: [{ fap, power }]         analytic levels, drawn dashed (only those of periodograms[0] are drawn:
 *                                         both stages share the sampling, so their levels coincide)
 *     bootstrap: { levels: [{ fap, power }] }   optional, drawn dotted
 *     peaks: [{ period, power, periodDays?, fap? }]   strongest first; the first opt.nPeaks are marked and labelled
 *   }
 * opt: { title, fontScale, second = true, nPeaks = 1, unit = 'epochs' | 'days', levels = true,
 *        xMin, xMax (periods, in epochs) }
 */
export function renderPeriodogram(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => (px * k).toFixed(1);
  const L = 58 + 12 * k, R = 14, T = opt.title ? 22 + 18 * k : 14 + 12 * k, B = 24 + 16 * k;
  const px0 = L, px1 = W - R, py0 = T, py1 = H - B;
  const pgs = (d.periodograms || []).filter((p, i) => p && p.power && p.power.length && (i === 0 || opt.second !== false));
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  if (!pgs.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('No periodogram', W / 2, H / 2); return; }
  const days = opt.unit === 'days' && d.period > 0, u = days ? d.period : 1;
  // ranges
  let x0 = Infinity, x1 = -Infinity, ymax = 0;
  for (const pg of pgs) for (let i = 0; i < pg.period.length; i++) { const p = pg.period[i]; if (p < x0) x0 = p; if (p > x1) x1 = p; if (pg.power[i] > ymax) ymax = pg.power[i]; }
  x0 = opt.xMin ?? x0; x1 = opt.xMax ?? x1;
  const lv = opt.levels === false ? [] : (pgs[0].fapLevels || []).filter((l) => Number.isFinite(l.power));
  const bl = opt.levels === false || !pgs[0].bootstrap ? [] : pgs[0].bootstrap.levels.filter((l) => Number.isFinite(l.power));
  // keep the levels in view unless they are far above everything (a featureless periodogram should look featureless)
  for (const l of [...lv, ...bl]) if (l.power < 3 * ymax) ymax = Math.max(ymax, l.power);
  ymax = Math.max(ymax, 1e-12) * 1.16;
  const lx0 = Math.log10(x0), lx1 = Math.log10(x1);
  const X = (p) => px0 + ((Math.log10(p) - lx0) / (lx1 - lx0)) * (px1 - px0), Y = (v) => py1 - (v / ymax) * (py1 - py0);

  // x axis: decades with 1-2-5 labels when there is room, minor ticks at every integer multiple
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const dec0 = Math.floor(Math.log10(x0 * u)), dec1 = Math.ceil(Math.log10(x1 * u)), perDec = (px1 - px0) / (lx1 - lx0);
  const mult = perDec > 150 * k ? [1, 2, 5] : perDec > 70 * k ? [1, 3] : [1];
  let lastLabel = -Infinity;
  for (let e = dec0; e <= dec1; e++) for (let m = 1; m < 10; m++) {
    const v = m * Math.pow(10, e), p = v / u; if (p < x0 * (1 - 1e-9) || p > x1 * (1 + 1e-9)) continue;
    const x = X(p), major = mult.includes(m);
    ctx.strokeStyle = th.grid; ctx.beginPath();
    if (major) { ctx.moveTo(x, py0); ctx.lineTo(x, py1); } else { ctx.moveTo(x, py1 - 4); ctx.lineTo(x, py1); }
    ctx.stroke();
    if (major && x - lastLabel > 34 * k) { ctx.fillStyle = th.text; ctx.fillText(e < 0 ? v.toFixed(-e) : String(Math.round(v)), x, py1 + 5); lastLabel = x; }
  }
  ctx.fillStyle = th.text;
  ctx.fillText(days ? 'Period (days)' : d.period > 0 && px1 - px0 > 330 * k ? `Period (epochs; 1 epoch = ${d.period.toFixed(4)} d)` : 'Period (epochs)', (px0 + px1) / 2, H - 5 - 11 * k);
  // y axis
  const yt = niceTicks(0, ymax, Math.max(3, Math.floor((py1 - py0) / 34)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Lomb–Scargle power', 0, 0); ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  // curves: the residual periodogram underneath, the first on top
  const col = (i) => groupColor(th, i);
  for (let j = pgs.length - 1; j >= 0; j--) {
    const pg = pgs[j], n = pg.period.length;
    ctx.strokeStyle = col(j); ctx.lineWidth = j === 0 ? 1.4 : 1.1; ctx.globalAlpha = j === 0 ? 1 : 0.8; ctx.lineJoin = 'round'; ctx.beginPath();
    // more samples than pixels at the short-period end: draw the min-max envelope of each pixel column
    let cx = null, lo = 0, hi = 0, started = false;
    const flush = () => { if (cx === null) return; if (!started) { ctx.moveTo(cx, Y(lo)); started = true; } else ctx.lineTo(cx, Y(lo)); if (hi > lo) { ctx.lineTo(cx, Y(hi)); ctx.lineTo(cx, Y(lo)); } };
    for (let i = 0; i < n; i++) {
      const p = pg.period[i]; if (p < x0 || p > x1) continue;
      const x = Math.round(X(p) * 2) / 2, v = pg.power[i];
      if (x !== cx) { flush(); cx = x; lo = hi = v; } else { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    flush(); ctx.stroke(); ctx.globalAlpha = 1;
  }
  // false-alarm levels
  ctx.font = `${F(10)}px ${th.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 1;
  const placed = [];   // labels sit on their line at the right; one that would cover another moves left of it
  const drawLevel = (l, dash, tag) => {
    if (!(l.power < ymax)) return; const y = Y(l.power);
    ctx.strokeStyle = th.title; ctx.globalAlpha = 0.75; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    const s = `FAP ${fmtLevel(l.fap)}${tag}`, w = ctx.measureText(s).width, h = 13 * k; let xr = px1 - 6;
    for (const b of placed) if (Math.abs(b.y - y) < h && xr - w < b.x1 + 8 && xr > b.x0 - 8) xr = b.x0 - 12;
    if (xr - w < px0 + 4) return;
    placed.push({ y, x0: xr - w, x1: xr });
    ctx.fillStyle = th.bg; ctx.globalAlpha = 0.7; ctx.fillRect(xr - 3 - w, y - 3 - 10 * k, w + 6, 10 * k + 1); ctx.globalAlpha = 1;
    ctx.fillStyle = th.title; ctx.fillText(s, xr, y - 2);
  };
  for (const l of [...lv].sort((a, b) => b.fap - a.fap)) drawLevel(l, [6, 4], '');
  for (const l of [...bl].sort((a, b) => b.fap - a.fap)) drawLevel(l, [2, 3], ' (bootstrap)');
  // peaks
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textBaseline = 'bottom';
  const boxes = [];
  pgs.forEach((pg, j) => {
    (pg.peaks || []).slice(0, opt.nPeaks ?? 1).forEach((pk) => {
      if (!(pk.period >= x0 && pk.period <= x1)) return;
      const x = X(pk.period), y = Math.max(py0 + 16 * k, Y(pk.power));
      ctx.fillStyle = col(j); ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x - 4.5, y - 11); ctx.lineTo(x + 4.5, y - 11); ctx.closePath(); ctx.fill();
      const pd = pk.periodDays ?? (d.period > 0 ? pk.period * d.period : null);
      const s = days ? `${fmtPeriod(pk.period * u)} d` : `${fmtPeriod(pk.period)} epochs${pd ? ` (${fmtPeriod(pd)} d)` : ''}`;
      const w = ctx.measureText(s).width, right = x + 8 + w < px1 - 4, bx = right ? x + 8 : x - 8 - w, by = y - 2;
      const box = [bx - 2, by - 12 * k, bx + w + 2, by + 2];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
      boxes.push(box);
      ctx.fillStyle = th.bg; ctx.globalAlpha = 0.75; ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]); ctx.globalAlpha = 1;
      ctx.fillStyle = col(j); ctx.textAlign = 'left'; ctx.fillText(s, bx, by);
    });
  });
  ctx.restore();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1); }
  // header: title or label on the left, legend on the right
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  const head = opt.title || d.label || (pgs.length > 1 ? "Periodogram" : "Periodogram of the timing residuals"); ctx.fillText(head, px0, T - 6);
  const headW = ctx.measureText(head).width;
  ctx.font = `${F(10.5)}px ${th.sans}`;
  const names = pgs.map((pg, j) => pg.label || (j === 0 ? 'O − C' : 'after sinusoid 1')), ws = names.map((nm) => ctx.measureText(nm).width + 34);
  // the legend is all or nothing: half a legend is worse than none (with one curve the header already says what it is)
  if (pgs.length > 1 && px1 - ws.reduce((a, b) => a + b, 0) > px0 + headW + 6) {
    let lx = px1 - ws.reduce((a, b) => a + b, 0) + 10;
    names.forEach((nm, j) => { ctx.strokeStyle = col(j); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lx, T - 10); ctx.lineTo(lx + 14, T - 10); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(nm, lx + 18, T - 6); lx += ws[j]; });
  }
}

/** Draw into a canvas at its displayed size (screen) or at a fixed size (export). opt.theme: 'dark' (default) or 'light'. */
export function drawPeriodogram(cv, d, opt = {}) {
  const W = opt.width || cv.clientWidth, H = opt.height || cv.clientHeight; if (!W || !H) return;
  const scale = opt.scale || Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale); cv._cssW = W; cv._cssH = H;
  const ctx = cv.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderPeriodogram(ctx, W, H, d, LC_THEMES[opt.theme || 'screen'], opt);
}
