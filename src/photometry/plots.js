// Plots of the photometry page: pure render functions taking a theme, so screen and export can share them.

export const PHOT_THEME = { bg: '#0b0f18', frame: '#2b3550', grid: '#1e2638', text: '#8491ad', strong: '#dfe6f3', data: '#c9d3e6', model: '#5fd4ff', star: '#ffc56b', ok: '#6fe3a5', warn: '#ffb454', bad: '#ff6b7a', post: '#b48cff', font: '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace' };

export function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, step };
}
const fmt = (v, step) => { const d = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) + 0.01))); return v.toFixed(d); };

/**
 * One panel.
 * @param p { x, series: [{ y, color, kind: 'dots' | 'line' | 'err', size, err, mask (Uint8Array: 0 = draw faint), label }],
 *            xLabel, yLabel, title, xOffset (subtracted from x for the labels), yPad }
 */
export function renderPanel(ctx, W, H, p, th = PHOT_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const mL = 62, mR = 10, mT = p.title ? 20 : 8, mB = p.xLabel ? 30 : 18, pw = W - mL - mR, ph = H - mT - mB;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.x.length; i++) { const v = p.x[i]; if (v === v) { if (v < x0) x0 = v; if (v > x1) x1 = v; } }
  for (const s of p.series) for (let i = 0; i < s.y.length; i++) { const v = s.y[i]; if (!Number.isFinite(v) || (s.mask && !s.mask[i] && s.kind !== 'line')) continue; if (v < y0) y0 = v; if (v > y1) y1 = v; }
  if (!(x1 > x0)) { x0 -= 0.5; x1 += 0.5; } if (!(y1 > y0)) { y0 -= 0.5 * Math.abs(y0 || 1) * 0.01; y1 += 0.5 * Math.abs(y1 || 1) * 0.01; }
  const yp = (y1 - y0) * (p.yPad ?? 0.08), xp = (x1 - x0) * 0.015; y0 -= yp; y1 += yp; x0 -= xp; x1 += xp;
  if (p.yRange) [y0, y1] = p.yRange;
  const X = (v) => mL + (v - x0) / (x1 - x0) * pw, Y = (v) => mT + ph - (v - y0) / (y1 - y0) * ph;
  ctx.font = th.font; ctx.lineWidth = 1;
  const xo = p.xOffset || 0, tx = niceTicks(x0 - xo, x1 - xo, Math.max(3, Math.floor(pw / 90))), ty = niceTicks(y0, y1, Math.max(2, Math.floor(ph / 32)));
  ctx.strokeStyle = th.grid; ctx.fillStyle = th.text; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (const v of ty.ticks) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke(); ctx.fillText(fmt(v, ty.step), mL - 6, y); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of tx.ticks) { const x = Math.round(X(v + xo)) + 0.5; ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke(); ctx.fillText(fmt(v, tx.step), x, mT + ph + 4); }
  ctx.strokeStyle = th.frame; ctx.strokeRect(mL + 0.5, mT + 0.5, pw, ph);
  ctx.save(); ctx.beginPath(); ctx.rect(mL, mT, pw, ph); ctx.clip();
  for (const s of p.series) {
    if (s.kind === 'line') {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size || 1.5; ctx.beginPath(); let pen = false;
      for (let i = 0; i < s.y.length; i++) { const v = s.y[i]; if (!Number.isFinite(v) || !Number.isFinite(p.x[i])) { pen = false; continue; } if (pen) ctx.lineTo(X(p.x[i]), Y(v)); else { ctx.moveTo(X(p.x[i]), Y(v)); pen = true; } }
      ctx.stroke(); ctx.lineWidth = 1;
    } else {
      const r = s.size || (p.x.length > 1500 ? 1 : p.x.length > 400 ? 1.4 : 2.2);
      if (s.err) { ctx.strokeStyle = s.color; ctx.globalAlpha = 0.25; ctx.beginPath(); for (let i = 0; i < s.y.length; i++) { const v = s.y[i], e = typeof s.err === 'number' ? s.err : s.err[i]; if (!Number.isFinite(v) || !Number.isFinite(e)) continue; const x = X(p.x[i]); ctx.moveTo(x, Y(v - e)); ctx.lineTo(x, Y(v + e)); } ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillStyle = s.color;
      for (let i = 0; i < s.y.length; i++) { const v = s.y[i]; if (!Number.isFinite(v) || !Number.isFinite(p.x[i])) continue; ctx.globalAlpha = s.mask && !s.mask[i] ? 0.25 : (s.alpha ?? 0.9); ctx.fillRect(X(p.x[i]) - r, Y(v) - r, 2 * r, 2 * r); }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  if (p.xLabel) ctx.fillText(p.xLabel, mL + pw / 2, H - 2);
  if (p.yLabel) { ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(p.yLabel, 0, 0); ctx.restore(); }
  if (p.title) {
    // the series labels share the title's line: on a narrow plot the title is cut so that the two never overlap
    const labW = p.series.reduce((a, q) => a + (q.label ? ctx.measureText(q.label).width + 14 : 0), 0), room = pw - labW - 6;
    let t = p.title; if (ctx.measureText(t).width > room) { while (t.length > 4 && ctx.measureText(t + '…').width > room) t = t.slice(0, -1); t = t.trimEnd() + '…'; }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = th.strong; ctx.fillText(t, mL, 4);
  }
  // legend
  let lx = mL + pw - 6; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  for (const s of p.series.slice().reverse()) { if (!s.label) continue; ctx.fillStyle = s.color; ctx.fillText(s.label, lx, p.title ? 4 : mT + 4); lx -= ctx.measureText(s.label).width + 14; }
}

/** Size a canvas for the device pixel ratio and return a context scaled to CSS pixels. */
export function fitCanvas(cv, hCss) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(50, cv.clientWidth || cv.parentElement.clientWidth), h = hCss || cv.clientHeight || 160;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: w, H: h };
}

/**
 * Field of view with the apertures drawn, for the report (EXOTIC's FOV figure): the image stretched with asinh between
 * the `lo` and `hi` percentiles, fitted into the panel with y up, a circle of radius rA and a dashed annulus
 * rIn..rOut on every star, labels T, C1, C2, ...
 * @param d { data, width, height, stars: [{ x, y, label, comp }], rA, rIn, rOut, title, lo = 10, hi = 99.8, used: [indices of the stars the light curve uses] }
 */
export function renderFov(ctx, W, H, d, th = PHOT_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const { data, width: w, height: h } = d, mT = d.title ? 20 : 4, n = w * h, step = Math.max(1, Math.floor(n / 40000)), buf = [];
  for (let i = 0; i < n; i += step) { const v = data[i]; if (Number.isFinite(v)) buf.push(v); }
  const a = Float64Array.from(buf).sort(), q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))], v0 = q(d.lo ?? 10), v1 = Math.max(q(d.hi ?? 99.8), v0 + 1);
  const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(ctx.canvas.ownerDocument.createElement('canvas'), { width: w, height: h });
  const g = off.getContext('2d'), im = g.createImageData(w, h), px = new Uint32Array(im.data.buffer), k = 1 / Math.asinh(10);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = data[(h - 1 - y) * w + x]; let u = (v - v0) / (v1 - v0); u = !(u > 0) ? 0 : u > 1 ? 1 : u; const c = Math.round(255 * Math.asinh(10 * u) * k); px[y * w + x] = 0xff000000 | (Math.min(255, c + 6) << 16) | (c << 8) | Math.max(0, c - 2); }
  g.putImageData(im, 0, 0);
  const s = Math.min((W - 8) / w, (H - mT - 4) / h), ox = (W - w * s) / 2, oy = mT + (H - mT - 4 - h * s) / 2;
  ctx.imageSmoothingEnabled = s < 1; ctx.drawImage(off, ox, oy, w * s, h * s);
  ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(ox + 0.5, oy + 0.5, w * s, h * s);
  ctx.font = th.font; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
  (d.stars || []).forEach((st, i) => {
    const sx = ox + (st.x + 0.5) * s, sy = oy + (h - (st.y + 0.5)) * s, col = i ? th.model : th.star, used = !d.used || d.used.includes(i);
    ctx.globalAlpha = used ? 1 : 0.4; ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, d.rA * s), 0, 6.2832); ctx.stroke();
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(sx, sy, d.rIn * s, 0, 6.2832); ctx.stroke(); ctx.beginPath(); ctx.arc(sx, sy, d.rOut * s, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(st.label || (i ? 'C' + i : 'T'), sx + Math.max(3, d.rOut * s) * 0.72 + 2, sy - Math.max(3, d.rOut * s) * 0.72); ctx.globalAlpha = 1;
  });
  if (d.title) { ctx.fillStyle = th.strong; ctx.textBaseline = 'top'; ctx.fillText(d.title, 6, 4); }
}
