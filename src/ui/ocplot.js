// O-C (observed minus calculated) diagram for transit timing.
// renderOC() is a pure drawing routine, like renderLightCurve(): the same code draws the
// on-screen panel and the exported figure.

import { LC_THEMES, niceTicks, decimals, groupColor } from './lightcurve.js';

/**
 * d: { epochs[], oc[] (days, against the linear ephemeris), errs[] (days),
 *      curve: { E[], y[], lo[], hi[] } | null   (selected model minus the linear one, with its 1-sigma band, days),
 *      label, info: [strings] }
 */
export function renderOC(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => (px * k).toFixed(1);
  const L = 58 + 12 * k, R = 14, T = opt.title ? 22 + 18 * k : 14 + 12 * k, B = 24 + 16 * k;
  const n = d.epochs.length, px0 = L, px1 = W - R, py0 = T, py1 = H - B;
  let e0 = Math.min(...d.epochs), e1 = Math.max(...d.epochs);
  if (d.curve) { e0 = Math.min(e0, d.curve.E[0]); e1 = Math.max(e1, d.curve.E[d.curve.E.length - 1]); }
  const ep = Math.max(1, 0.04 * (e1 - e0)); e0 -= ep; e1 += ep;
  let ymax = 0;
  for (let i = 0; i < n; i++) ymax = Math.max(ymax, Math.abs(d.oc[i]) + d.errs[i]);
  if (d.curve) for (let i = 0; i < d.curve.E.length; i++) ymax = Math.max(ymax, Math.abs(d.curve.lo[i]), Math.abs(d.curve.hi[i]));
  ymax = Math.max(ymax, 1e-7) * 1.15;
  // seconds for tight timing, minutes otherwise
  const sec = ymax * 1440 < 3, u = sec ? 86400 : 1440, yr = ymax * u;
  const X = (E) => px0 + ((E - e0) / (e1 - e0)) * (px1 - px0), Y = (v) => py0 + (1 - (v * u + yr) / (2 * yr)) * (py1 - py0);
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  const xt = niceTicks(e0, e1, Math.max(3, Math.floor((px1 - px0) / (70 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { if (!Number.isInteger(Number(v.toFixed(6))) && e1 - e0 < 8) continue; const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py1 + 5); }
  ctx.fillText('Epoch (orbits)', (px0 + px1) / 2, H - 5 - 11 * k);
  const yt = niceTicks(-yr, yr, Math.max(3, Math.floor((py1 - py0) / 34)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v / u); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(`O − C (${sec ? 'seconds' : 'minutes'})`, 0, 0); ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  if (d.curve) {
    const c = d.curve;
    ctx.fillStyle = th.band; ctx.beginPath();
    c.E.forEach((E, i) => (i ? ctx.lineTo(X(E), Y(c.hi[i])) : ctx.moveTo(X(E), Y(c.hi[i]))));
    for (let i = c.E.length - 1; i >= 0; i--) ctx.lineTo(X(c.E[i]), Y(c.lo[i]));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = th.model; ctx.lineWidth = 1.8; ctx.beginPath();
    c.E.forEach((E, i) => (i ? ctx.lineTo(X(E), Y(c.y[i])) : ctx.moveTo(X(E), Y(c.y[i]))));
    ctx.stroke();
  }
  ctx.strokeStyle = th.text; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(px0, Y(0)); ctx.lineTo(px1, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  const grp = d.group && d.groups && d.groups.length > 1 ? d.group : null;
  ctx.strokeStyle = th.bin; ctx.fillStyle = th.bin; ctx.lineWidth = 1.2;
  for (let i = 0; i < n; i++) {
    const x = X(d.epochs[i]);
    if (grp) { ctx.strokeStyle = groupColor(th, grp[i]); ctx.fillStyle = groupColor(th, grp[i]); }
    ctx.beginPath(); ctx.moveTo(x, Y(d.oc[i] - d.errs[i])); ctx.lineTo(x, Y(d.oc[i] + d.errs[i])); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, Y(d.oc[i]), 3, 0, 6.3); ctx.fill();
  }
  ctx.restore();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1); }
  if (grp) {   // legend: one entry per source, along the bottom
    ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; let lx = px0 + 8; const ly = py1 - 7;
    d.groups.forEach((nm, g) => { const w = 22 + ctx.measureText(nm).width; if (lx + w > px1 - 4) return; ctx.fillStyle = groupColor(th, g); ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 3, 0, 6.3); ctx.fill(); ctx.fillStyle = th.text; ctx.fillText(nm, lx + 12, ly); lx += w; });
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || d.label || '', px0, T - 6);
  if (d.info && d.info.length && opt.title) {
    ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right';
    d.info.forEach((s, i) => ctx.fillText(s, px1 - 8, py0 + 6 + 11 * k + i * 14 * k));
  }
}

/** Draw into a canvas at its displayed size (screen) or at a fixed size (export). */
export function drawOC(cv, d, opt = {}) {
  const W = opt.width || cv.clientWidth, H = opt.height || cv.clientHeight; if (!W || !H) return;
  const scale = opt.scale || Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale); cv._cssW = W; cv._cssH = H;
  const ctx = cv.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderOC(ctx, W, H, d, LC_THEMES[opt.theme || 'screen'], opt);
}
