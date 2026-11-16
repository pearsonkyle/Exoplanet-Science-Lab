// Charts for the Validation page: plain canvas, no library. The draw functions are pure (canvas context, size, spec,
// theme); `chart()` wraps one in a card with a title, a legend that toggles series, and a hover read-out.
// Kinds: 'lines', 'bars', 'intervals' (mean ± 1σ per row and sampler), 'ranges' (lo to hi per row on a log axis).

export function themeFrom(el) {
  const cs = getComputedStyle(el), v = (n, d) => cs.getPropertyValue(n).trim() || d;
  return {
    panel: v('--panel', '#0b0f18'), grid: v('--line', '#1e2638'), axis: v('--line2', '#2b3550'), text: v('--text', '#dfe6f3'), dim: v('--dim', '#8491ad'), faint: v('--faint', '#55607a'),
    esl: v('--esl', '#f2f6ff'), truth: v('--truth', '#8491ad'),
    s: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v('--s' + i, '#888')),
    font: '12px ' + v('--sans', 'system-ui, sans-serif'), mono: '11px ' + v('--mono', 'monospace'),
  };
}

const pow10 = (e) => (e === 0 ? '1' : '1e' + e);
function niceTicks(lo, hi, n) {
  const span = hi - lo || 1, step0 = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step0;
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1), out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, step };
}
const fmtTick = (v, step) => { const d = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9))); return Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-4) ? v.toExponential(1) : v.toFixed(d); };

/**
 * Line chart. spec = { series: [{ x, y, color, width, dash, label, hidden, points }], xLabel, yLabel,
 *   yLog (plots |y|, values under yFloor sit on the floor), yFloor, yMin, yMax, xTicks: [{ v, label }], xLog, bands: [{ y, label }] }
 * Returns the geometry needed for hover: { px(x), py(y), plot: {l, t, r, b} }.
 */
export function drawLines(ctx, W, H, spec, th) {
  const L = spec.yLog ? 46 : 52, R = 10, T = 8, B = spec.xLabel ? 36 : 22, l = L, r = W - R, t = T, b = H - B;
  ctx.clearRect(0, 0, W, H);
  const vis = spec.series.filter((s) => !s.hidden);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const floor = spec.yFloor ?? 1e-17, ty = (v) => (spec.yLog ? Math.log10(Math.max(Math.abs(v), floor)) : v), tx = (v) => (spec.xLog ? Math.log10(v) : v);
  for (const s of vis) for (let i = 0; i < s.x.length; i++) { const X = tx(s.x[i]), Y = ty(s.y[i]); if (!Number.isFinite(Y) || !Number.isFinite(X)) continue; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
  if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
  if (spec.yLog) { y0 = Math.floor(spec.yMin !== undefined ? Math.log10(spec.yMin) : y0); y1 = Math.ceil(spec.yMax !== undefined ? Math.log10(spec.yMax) : y1 + 0.2); if (y1 <= y0) y1 = y0 + 1; }
  else { if (spec.yMin !== undefined) y0 = spec.yMin; if (spec.yMax !== undefined) y1 = spec.yMax; const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.06; if (spec.yMin === undefined) y0 -= pad; if (spec.yMax === undefined) y1 += pad; }
  if (spec.xPad) { const p = (x1 - x0) * spec.xPad; x0 -= p; x1 += p; }
  if (x1 === x0) x1 = x0 + 1;
  const px = (v) => l + ((tx(v) - x0) / (x1 - x0)) * (r - l), py = (v) => b - ((ty(v) - y0) / (y1 - y0)) * (b - t);
  ctx.font = th.mono; ctx.lineWidth = 1; ctx.textBaseline = 'middle';
  // y grid and labels
  ctx.textAlign = 'right';
  if (spec.yLog) {
    const every = Math.max(1, Math.ceil((y1 - y0) / 7));
    for (let e = y0; e <= y1; e++) {
      const Y = b - ((e - y0) / (y1 - y0)) * (b - t);
      ctx.strokeStyle = th.grid; ctx.globalAlpha = (e - y0) % every === 0 ? 1 : 0.45; ctx.beginPath(); ctx.moveTo(l, Y + 0.5); ctx.lineTo(r, Y + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
      if ((e - y0) % every === 0) { ctx.fillStyle = th.dim; ctx.fillText((e === y0 && Math.pow(10, e) <= floor * 1.0001 ? '≤' : '') + pow10(e), l - 6, Y); }
    }
  } else {
    const { ticks, step } = niceTicks(y0, y1, Math.max(3, Math.round((b - t) / 34)));
    for (const v of ticks) { const Y = b - ((v - y0) / (y1 - y0)) * (b - t); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(l, Y + 0.5); ctx.lineTo(r, Y + 0.5); ctx.stroke(); ctx.fillStyle = th.dim; ctx.fillText(fmtTick(v, step), l - 6, Y); }
  }
  // x ticks
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = th.dim;
  if (spec.xTicks) { let last = -1e9; for (const k of spec.xTicks) { const X = px(k.v); if (X - last < 34) continue; last = X; ctx.fillText(k.label, X, b + 5); ctx.strokeStyle = th.grid; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(X + 0.5, t); ctx.lineTo(X + 0.5, b); ctx.stroke(); ctx.globalAlpha = 1; } }
  else if (spec.xLog) { for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) ctx.fillText(pow10(e), l + ((e - x0) / (x1 - x0)) * (r - l), b + 5); }
  else { const { ticks, step } = niceTicks(x0, x1, Math.max(2, Math.round((r - l) / 90))); for (const v of ticks) ctx.fillText(fmtTick(v, step), l + ((v - x0) / (x1 - x0)) * (r - l), b + 5); }
  ctx.strokeStyle = th.axis; ctx.beginPath(); ctx.moveTo(l, b + 0.5); ctx.lineTo(r, b + 0.5); ctx.stroke();
  ctx.font = th.font;
  if (spec.xLabel) { ctx.fillStyle = th.dim; ctx.fillText(spec.xLabel, (l + r) / 2, H - 14); }
  // reference levels (a tolerance, a noise level)
  for (const bd of spec.bands || []) {
    const Y = py(bd.y); if (Y < t || Y > b) continue;
    ctx.setLineDash([2, 4]); ctx.strokeStyle = th.dim; ctx.beginPath(); ctx.moveTo(l, Y + 0.5); ctx.lineTo(r, Y + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = th.dim; ctx.fillText(bd.label, r - 2, Y - 2);
  }
  // series
  ctx.save(); ctx.beginPath(); ctx.rect(l, t - 2, r - l, b - t + 4); ctx.clip();
  for (const s of [...vis].reverse()) {       // the first series (ESL) is drawn last, on top
    ctx.strokeStyle = ctx.fillStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.lineJoin = 'round';
    if (!s.pointsOnly) { ctx.beginPath(); let pen = false; for (let i = 0; i < s.x.length; i++) { const Y = ty(s.y[i]); if (!Number.isFinite(Y)) { pen = false; continue; } const X = px(s.x[i]), YY = b - ((Y - y0) / (y1 - y0)) * (b - t); if (pen) ctx.lineTo(X, YY); else ctx.moveTo(X, YY); pen = true; } ctx.stroke(); }
    ctx.setLineDash([]);
    if (s.points || s.pointsOnly) for (let i = 0; i < s.x.length; i++) { const Y = ty(s.y[i]); if (!Number.isFinite(Y)) continue; ctx.beginPath(); ctx.arc(px(s.x[i]), b - ((Y - y0) / (y1 - y0)) * (b - t), s.r || 4, 0, 6.2832); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = th.panel; ctx.stroke(); ctx.strokeStyle = s.color; }
  }
  ctx.restore();
  return { px, py, plot: { l, t, r, b }, x0, x1 };
}

/** Grouped vertical bars. spec = { groups: [label], series: [{ label, color, values }], yMax, ref: { y, label } } */
export function drawBars(ctx, W, H, spec, th) {
  const l = 38, r = W - 8, t = 8, b = H - 22; ctx.clearRect(0, 0, W, H);
  let y1 = spec.yMax || 0; if (!spec.yMax) for (const s of spec.series) for (const v of s.values) y1 = Math.max(y1, v); y1 *= spec.yMax ? 1 : 1.12;
  const py = (v) => b - (v / y1) * (b - t), { ticks, step } = niceTicks(0, y1, 4);
  ctx.font = th.mono; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of ticks) { ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(l, py(v) + 0.5); ctx.lineTo(r, py(v) + 0.5); ctx.stroke(); ctx.fillStyle = th.dim; ctx.fillText(fmtTick(v, step), l - 5, py(v)); }
  const G = spec.groups.length, gw = (r - l) / G, n = spec.series.length, bw = Math.max(2, Math.min(22, (gw - 6) / n - 2)), rects = [];
  spec.series.forEach((s, j) => s.values.forEach((v, g) => {
    const x = l + g * gw + (gw - n * (bw + 2)) / 2 + j * (bw + 2), y = py(v), rad = Math.min(4, bw / 2, Math.max(0, b - y));
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.moveTo(x, b); ctx.lineTo(x, y + rad); ctx.quadraticCurveTo(x, y, x + rad, y); ctx.lineTo(x + bw - rad, y); ctx.quadraticCurveTo(x + bw, y, x + bw, y + rad); ctx.lineTo(x + bw, b); ctx.fill();
    rects.push({ x, y, w: bw, g, j, v });
  }));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = th.dim; spec.groups.forEach((gl, g) => { if (G <= 12 || g % 2 === 0) ctx.fillText(gl, l + (g + 0.5) * gw, b + 5); });
  ctx.strokeStyle = th.axis; ctx.beginPath(); ctx.moveTo(l, b + 0.5); ctx.lineTo(r, b + 0.5); ctx.stroke();
  if (spec.ref) { const Y = py(spec.ref.y); ctx.setLineDash([2, 4]); ctx.strokeStyle = th.dim; ctx.beginPath(); ctx.moveTo(l, Y + 0.5); ctx.lineTo(r, Y + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.font = th.font; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = th.dim; ctx.fillText(spec.ref.label, r - 2, Y - 2); }
  return { rects };
}

/**
 * Interval plot: one row per parameter, one marker with a +-1 sigma whisker per sampler, in units of the reference width
 * about the reference mean. spec = { rows: [{ label, items: [{ label, color, mean, std }], truth }], }  (already normalised)
 */
export function drawIntervals(ctx, W, H, spec, th) {
  const l = Math.min(92, W * 0.24), r = W - 20, t = 6, b = H - 24; ctx.clearRect(0, 0, W, H);
  ctx.font = th.font; const lw = Math.max(...spec.rows.map((q) => ctx.measureText(q.label).width)) + 16;
  const lim = spec.lim || 2.6, unit = spec.unit ?? 'σ', step = lim < 2 ? 0.5 : 1, hits = [];
  const ll = Math.min(Math.max(l, lw), W * 0.42), px = (v) => ll + ((v + lim) / (2 * lim)) * (r - ll), rh = (b - t) / spec.rows.length;
  ctx.font = th.mono; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  for (let v = -Math.floor(lim / step) * step; v <= lim + 1e-9; v += step) { ctx.strokeStyle = th.grid; ctx.globalAlpha = v === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(px(v) + 0.5, t); ctx.lineTo(px(v) + 0.5, b); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillStyle = th.dim; ctx.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + unit, px(v), b + 6); }
  spec.rows.forEach((row, i) => {
    const y0 = t + i * rh; ctx.font = th.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = th.text; ctx.fillText(row.label, ll - 8, y0 + rh / 2);
    if (i) { ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(ll, y0 + 0.5); ctx.lineTo(r, y0 + 0.5); ctx.stroke(); }
    const n = row.items.length, dy = Math.min(13, (rh - 8) / n);
    row.items.forEach((it, j) => {
      const y = y0 + rh / 2 + (j - (n - 1) / 2) * dy, cl = (v) => Math.max(-lim, Math.min(lim, v)), a = cl(it.mean - it.std), c = cl(it.mean + it.std);
      ctx.strokeStyle = ctx.fillStyle = it.color; ctx.lineWidth = j === 0 ? 2.5 : 2; ctx.beginPath(); ctx.moveTo(px(a), y); ctx.lineTo(px(c), y); ctx.stroke();
      if (Math.abs(it.mean) > lim) { const X = px(cl(it.mean)), d = it.mean > 0 ? 1 : -1; ctx.beginPath(); ctx.moveTo(X, y); ctx.lineTo(X - 7 * d, y - 4); ctx.lineTo(X - 7 * d, y + 4); ctx.fill(); }   // off the scale: an arrow at the edge
      if (Math.abs(it.mean) <= lim) { ctx.beginPath(); ctx.arc(px(it.mean), y, j === 0 ? 4.5 : 3.5, 0, 6.2832); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = th.panel; ctx.stroke(); }
      hits.push({ x0: ll, x1: r, y: y, h: dy, row, it });
    });
    if (Number.isFinite(row.truth) && Math.abs(row.truth) <= lim) { ctx.strokeStyle = th.dim; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px(row.truth), y0 + 4); ctx.lineTo(px(row.truth), y0 + rh - 4); ctx.stroke(); ctx.setLineDash([]); }
  });
  return { hits };
}

/**
 * Horizontal ranges on a logarithmic axis: one row per code (or object), a bar from `lo` to `hi` with a dot at `hi`.
 * spec = { rows: [{ label, lo, hi, color, strong, note }], xMin, xMax, marks: [{ x, label }], unit, loName, hiName }
 * A row with hi === null shows its note instead (a failure, or no such model). Values under xMin sit on the left edge.
 */
export function drawRanges(ctx, W, H, spec, th) {
  ctx.clearRect(0, 0, W, H); ctx.font = th.font;
  const stacked = W < 520;      // on a phone the name goes above its bar, so the axis keeps the full width
  const lw = stacked ? 4 : Math.min(W * 0.44, Math.max(...spec.rows.map((q) => ctx.measureText(q.label).width)) + 14), l = lw, r = W - 58, t = spec.marks && spec.marks.length ? 20 : 6, b = H - 22;
  const x0 = Math.log10(spec.xMin), x1 = Math.log10(spec.xMax), px = (v) => l + ((Math.log10(Math.max(v, spec.xMin)) - x0) / (x1 - x0)) * (r - l), rh = (b - t) / spec.rows.length, hits = [];
  ctx.font = th.mono; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const every = Math.max(1, Math.ceil((x1 - x0) / Math.max(2, Math.floor((r - l) / 56))));
  for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) {
    const X = l + ((e - x0) / (x1 - x0)) * (r - l), lab = (e - Math.ceil(x0)) % every === 0;
    ctx.strokeStyle = th.grid; ctx.globalAlpha = lab ? 1 : 0.4; ctx.beginPath(); ctx.moveTo(X + 0.5, t); ctx.lineTo(X + 0.5, b); ctx.stroke(); ctx.globalAlpha = 1;
    if (lab) { ctx.fillStyle = th.dim; ctx.textAlign = e === Math.ceil(x0) && stacked ? 'left' : 'center'; ctx.fillText((e === Math.ceil(x0) && spec.floor ? '≤' : '') + pow10(e) + (spec.unit || ''), X, b + 6); }
  }
  [...(spec.marks || [])].sort((p, q) => p.x - q.x).forEach((m, i, all) => {
    const X = px(m.x); ctx.setLineDash([3, 3]); ctx.strokeStyle = th.dim; ctx.beginPath(); ctx.moveTo(X + 0.5, t - 4); ctx.lineTo(X + 0.5, b); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = th.font; const tw = ctx.measureText(m.label).width, left = (all.length > 1 ? i < all.length - 1 : X > (l + r) / 2) && X - tw - 4 > 0;   // the last mark's label goes to the right of its line
    ctx.fillStyle = th.dim; ctx.textBaseline = 'bottom'; ctx.textAlign = left ? 'right' : 'left'; ctx.fillText(m.label, X + (left ? -4 : 4), t - 5); ctx.font = th.mono; ctx.textBaseline = 'top';
  });
  spec.rows.forEach((row, i) => {
    const yc = t + (i + 0.5) * rh, y = stacked ? yc + 8 : yc; ctx.font = (row.strong ? 'bold ' : '') + th.font; ctx.textBaseline = 'middle';
    ctx.fillStyle = row.strong ? th.text : th.dim;
    if (stacked) { ctx.textAlign = 'left'; ctx.fillText(row.label, l + 2, yc - 9); } else { ctx.textAlign = 'right'; ctx.fillText(row.label, l - 10, y); }
    ctx.font = th.mono; ctx.textAlign = 'left';
    if (row.hi === null || row.hi === undefined) { ctx.fillStyle = th.faint; ctx.fillText(row.note || 'n/a', l + 6, y); hits.push({ y: yc, h: rh, row }); return; }
    const a = px(Math.min(row.lo ?? row.hi, row.hi)), c = px(row.hi), bh = row.strong ? 8 : 6;
    ctx.fillStyle = row.color; ctx.globalAlpha = 0.45; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(a, y - bh / 2, Math.max(1, c - a), bh, bh / 2); else ctx.rect(a, y - bh / 2, Math.max(1, c - a), bh); ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(c, y, row.strong ? 5.5 : 4.5, 0, 6.2832); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = th.panel; ctx.stroke();
    ctx.fillStyle = row.strong ? th.text : th.dim; ctx.fillText((row.hi < spec.xMin ? '<' : '') + fmtVal(row.hi) + (row.note ? ' ' + row.note : ''), c + 9, y);
    hits.push({ y: yc, h: rh, row });
  });
  return { hits };
}
/** Height of a ranges chart for n rows at chart width w (rows are taller when the names sit above the bars). */
export const rangesHeight = (n) => (w) => 44 + (w - 28 < 520 ? 40 : 25) * n;
const fmtVal = (v) => (v === 0 ? '0' : v >= 0.01 && v < 1e4 ? Number(v.toPrecision(2)).toString() : v.toExponential(1));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Mount a chart card. kind: 'lines' | 'bars' | 'intervals' | 'ranges'. opts: { title, sub, height, fmtX, fmtY, legend: false }
 * Returns { update(spec) }.
 */
export function chart(parent, kind, spec, opts = {}) {
  const box = document.createElement('div'); box.className = 'vchart';
  box.innerHTML = (opts.title ? `<div class="ctitle">${esc(opts.title)}</div>` : '') + (opts.sub ? `<div class="csub">${opts.sub}</div>` : '') + '<canvas></canvas><div class="vlegend"></div><div class="vtip"></div>';
  parent.append(box);
  const cv = box.querySelector('canvas'), lg = box.querySelector('.vlegend'), tip = box.querySelector('.vtip'), th = themeFrom(parent.closest('#val') || document.body);
  box.setAttribute('role', 'group'); if (opts.title) box.setAttribute('aria-label', opts.title);
  if (opts.label) { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', opts.label); }
  // stored specs name colours as 'var:esl', 'var:s1', ...: resolve them against the theme
  const col = (c) => (typeof c === 'string' && c.startsWith('var:') ? (/^s\d$/.test(c.slice(4)) ? th.s[Number(c[5]) - 1] : th[c.slice(4)]) || th.dim : c);
  const resolve = (sp) => { for (const k of ['series', 'rows']) for (const q of sp[k] || []) { if (q.color) q.color = col(q.color); for (const it of q.items || []) it.color = col(it.color); } return sp; };
  let geo = null, cur = resolve(spec), hover = null;
  const H = () => (typeof opts.height === 'function' ? opts.height(box.clientWidth) : opts.height || 240);
  function render() {
    const W = Math.max(200, box.clientWidth - 24), dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.style.height = H() + 'px'; cv.width = Math.round(W * dpr); cv.height = Math.round(H() * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geo = kind === 'lines' ? drawLines(ctx, W, H(), cur, th) : kind === 'bars' ? drawBars(ctx, W, H(), cur, th) : kind === 'ranges' ? drawRanges(ctx, W, H(), cur, th) : drawIntervals(ctx, W, H(), cur, th);
    if (kind === 'lines' && hover !== null) {
      const { l, t, r, b } = geo.plot; ctx.strokeStyle = th.dim; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hover.X + 0.5, t); ctx.lineTo(hover.X + 0.5, b); ctx.stroke();
      for (const p of hover.pts) { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.X, p.Y, 4, 0, 6.2832); ctx.fill(); ctx.strokeStyle = th.panel; ctx.lineWidth = 2; ctx.stroke(); }
    }
  }
  function legend() {
    if (opts.legend === false || kind === 'ranges') { lg.style.display = 'none'; return; }
    const items = kind === 'intervals' ? (cur.rows[0] ? cur.rows[0].items : []) : cur.series;
    lg.innerHTML = '';
    items.forEach((s) => {
      const bt = document.createElement('button'); bt.type = 'button'; bt.className = s.hidden ? 'off' : '';
      bt.innerHTML = `<i class="${kind === 'bars' ? 'box' : s.dash ? 'dash' : ''}" style="${kind === 'bars' ? 'background' : 'border-color'}:${s.color}"></i>${esc(s.label)}`;
      if (kind === 'lines') { bt.title = 'Show or hide this series'; bt.setAttribute('aria-pressed', String(!s.hidden)); bt.onclick = () => { s.hidden = !s.hidden; legend(); render(); }; } else bt.style.cursor = 'default';
      lg.append(bt);
    });
    if (kind === 'intervals' && cur.rows.some((r) => Number.isFinite(r.truth))) { const sp = document.createElement('span'); sp.innerHTML = `<i class="dash" style="border-color:${th.dim}"></i> ${esc(cur.truthLabel || 'injected value')}`; sp.style.cssText = 'display:inline-flex;align-items:center;gap:6px'; lg.append(sp); }
  }
  function showTip(html, x, y) { tip.innerHTML = html; tip.style.display = 'block'; const w = tip.offsetWidth, bw = box.clientWidth; tip.style.left = Math.max(4, Math.min(bw - w - 4, x + 14)) + 'px'; tip.style.top = Math.max(4, y - 10) + 'px'; }
  const fx = opts.fmtX || ((v) => Number(v.toPrecision(6)).toString()), fy = opts.fmtY || ((v) => (v === 0 ? '0' : Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5 ? v.toExponential(2) : Number(v.toPrecision(6)).toString()));
  function onMove(ev) {
    const rc = cv.getBoundingClientRect(), mx = ev.clientX - rc.left, my = ev.clientY - rc.top, ox = cv.offsetLeft, oy = cv.offsetTop;
    if (!geo) return;
    if (kind === 'lines') {
      const vis = cur.series.filter((s) => !s.hidden); if (!vis.length || mx < geo.plot.l - 4 || mx > geo.plot.r + 4) return onLeave();
      // nearest x among the visible series
      let best = null, bd = Infinity; for (const s of vis) for (let i = 0; i < s.x.length; i++) { const d = Math.abs(geo.px(s.x[i]) - mx); if (d < bd) { bd = d; best = s.x[i]; } }
      const pts = []; let html = `<b>${esc((cur.xLabelShort || cur.xLabel || 'x') + ' ' + (cur.xTicks ? (cur.xTicks.find((k) => k.v === best) || { label: fx(best) }).label : fx(best)))}</b>`;
      for (const s of vis) { let j = -1, dj = Infinity; for (let i = 0; i < s.x.length; i++) { const d = Math.abs(s.x[i] - best); if (d < dj) { dj = d; j = i; } } if (j < 0 || dj > 1e-9 * Math.max(1, Math.abs(best)) + (geo.x1 - geo.x0) * 1e-6 && !cur.xLog) continue; const yv = s.y[j]; if (!Number.isFinite(yv)) continue; pts.push({ X: geo.px(s.x[j]), Y: Math.min(geo.plot.b, Math.max(geo.plot.t, geo.py(yv))), color: s.color }); html += `<span><span><i style="background:${s.color}"></i>${esc(s.label)}</span><span>${fy(cur.yLog ? Math.abs(yv) : yv)}</span></span>`; }
      hover = { X: geo.px(best), pts }; render(); showTip(html, ox + mx, oy + my);
    } else if (kind === 'bars') {
      const h = geo.rects.find((q) => mx >= q.x - 2 && mx <= q.x + q.w + 2 && my >= Math.min(q.y, geo.rects[0].y) - 30);
      if (!h) return onLeave(); showTip(`<b>${esc(cur.groups[h.g])}</b><span><span><i style="background:${cur.series[h.j].color}"></i>${esc(cur.series[h.j].label)}</span><span>${fy(h.v)}</span></span>`, ox + mx, oy + my);
    } else if (kind === 'ranges') {
      const h = geo.hits.find((q) => Math.abs(my - q.y) <= q.h / 2);
      if (!h) return onLeave(); const q = h.row;
      showTip(`<b>${esc(q.label)}</b>` + (q.hi === null || q.hi === undefined ? `<span><span>${esc(q.note || 'n/a')}</span></span>` : (q.lo !== undefined && q.lo !== q.hi ? `<span><span>${esc(cur.loName || 'median')}</span><span>${fy(q.lo)}</span></span>` : '') + `<span><span>${esc(cur.hiName || 'worst')}</span><span>${fy(q.hi)}</span></span>`), ox + mx, oy + my);
    } else {
      const h = geo.hits.find((q) => Math.abs(my - q.y) <= q.h / 2 + 1);
      if (!h) return onLeave(); showTip(`<b>${esc(h.row.label)}</b><span><span><i style="background:${h.it.color}"></i>${esc(h.it.label)}</span><span>${esc(h.it.text || '')}</span></span>`, ox + mx, oy + my);
    }
  }
  function onLeave() { tip.style.display = 'none'; if (hover) { hover = null; render(); } }
  cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerdown', onMove); cv.addEventListener('pointerleave', onLeave);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => render()).observe(box); else window.addEventListener('resize', render);
  legend(); render();
  return { update(s) { cur = resolve(s); hover = null; legend(); render(); }, el: box };
}
