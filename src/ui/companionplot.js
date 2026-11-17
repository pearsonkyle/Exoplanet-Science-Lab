// Plots of the companion explorer (src/ui/companionExplorer.js): where an unseen planet could be and what it does.
// Pure render functions taking a theme (the LC_THEMES objects), so screen and export share them.
//
//   renderCompanionMap(ctx, W, H, d, th, opt)     period ratio × mass: the grid search's Δχ² as a heat map, the
//                                                 posterior's companions as points, low-order resonances, the selection
//   mapLayout(W, H, d, opt)                       the map's axes, for the panel's hit test (same numbers as the plot)
//   renderCompanionOrbits(ctx, W, H, d, th, opt)  the system from above at time t: Keplerian ellipses, planets on them,
//                                                 the posterior's orbits as a faint cloud, the line of sight
//   renderCompanionOC(ctx, W, H, d, th, opt)      observed O − C with the selected companion's integration and the
//                                                 posterior's spread of curves
//   orbitPoint(o, t)                              [X, Z] of a planet at time t (X on the sky, Z toward the observer)

const TAU = 2 * Math.PI, DEG = Math.PI / 180;
const niceStep = (span, n) => { const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
const ticks = (lo, hi, n) => { const s = niceStep(hi - lo || 1, n), out = []; for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9 * s; v += s) out.push(Math.abs(v) < 1e-12 ? 0 : v); return { out, s }; };
const dec = (s) => Math.max(0, Math.min(6, Math.ceil(-Math.log10(s) - 1e-9)));
// perceptual ramp for Δχ² (dark = poor, bright = good), the same on every theme
const RAMP = [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]];
function ramp(f) { f = Math.min(1, Math.max(0, f)); const x = f * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), w = x - i, a = RAMP[i], b = RAMP[i + 1]; return `rgb(${[0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * w)).join(',')})`; }
const RES = [[1, 3], [2, 5], [1, 2], [2, 3], [3, 2], [2, 1], [5, 2], [3, 1]];   // [q, p]: period ratio p/q, the p:q resonance

/** Semi-major axis in AU from the period (days) and the total mass (solar masses). */
export const aAU = (perDays, mtot) => Math.cbrt(mtot * (perDays / 365.25) ** 2);

/** [X, Z] in the units of o.a at time t: X along the sky, Z toward the observer (transit at Z > 0, X = 0). */
export function orbitPoint(o, t) {
  const e = Math.min(0.95, Math.max(0, o.e || 0)), w = (o.omega || 0) * DEG;
  // the transit (inferior conjunction) is at ω + ν = 90°: its mean anomaly is the zero point of the clock
  const nuT = Math.PI / 2 - w, ET = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nuT / 2)), MT = ET - e * Math.sin(ET);
  const M = MT + TAU * (t - (o.tmid || 0)) / o.per;
  let E = M; for (let k = 0; k < 30; k++) { const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-12) break; }
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)), r = o.a * (1 - e * Math.cos(E)), u = w + nu;
  return [-r * Math.cos(u), r * Math.sin(u)];
}

/** The map's frame: x = period ratio (linear), y = companion mass (log). */
export function mapLayout(W, H, d, opt = {}) {
  const k = opt.fontScale || 1, L = 56 + 10 * k, R = 16 + (d.grid ? 46 : 0), T = 28 + 8 * k, B = 30 + 12 * k;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const take = (r, m) => { if (r > 0 && m > 0) { x0 = Math.min(x0, r); x1 = Math.max(x1, r); y0 = Math.min(y0, m); y1 = Math.max(y1, m); } };
  if (d.grid) { const P = d.basePeriod; for (const p of d.grid.period) for (const m of [d.grid.mass[0], d.grid.mass[d.grid.mass.length - 1]]) take(p / P, m); }
  for (const s of d.samples || []) take(s.ratio, s.mass);
  if (d.best) take(d.best.ratio, d.best.mass);
  if (!(x1 > x0)) { x0 = (x0 > 0 ? x0 : 2) * 0.8; x1 = x0 * 1.6; }
  if (!(y1 > y0)) { y0 = (y0 > 0 ? y0 : 0.1) / 2; y1 = y0 * 4; }
  // samples only: a margin of 15% of the spread on both axes (the mass axis in log), at least 2% in mass, so a well
  // constrained mass fills the panel instead of sitting in a thin band
  if (!d.grid) { const px = 0.15 * (x1 - x0); x0 -= px; x1 += px; const f = Math.max(Math.log10(1.02), 0.15 * Math.log10(y1 / y0)); y0 /= 10 ** f; y1 *= 10 ** f; }
  const ly0 = Math.log10(y0), ly1 = Math.log10(y1), px0 = L, px1 = W - R, py0 = T, py1 = H - B;
  const X = (r) => px0 + ((r - x0) / (x1 - x0)) * (px1 - px0), Y = (m) => py1 - ((Math.log10(m) - ly0) / (ly1 - ly0)) * (py1 - py0);
  return { px0, px1, py0, py1, x0, x1, y0, y1, X, Y, ratioAt: (x) => x0 + ((x - px0) / (px1 - px0)) * (x1 - x0), massAt: (y) => Math.pow(10, ly0 + ((py1 - y) / (py1 - py0)) * (ly1 - ly0)) };
}

/**
 * d: { basePeriod, letter, grid?: { period[], mass[], np, nm, dchi2[] }, samples?: [{ ratio, mass }], best?: { ratio, mass },
 *      sel?: { ratio, mass, label }, hover?: { ratio, mass } }
 */
export function renderCompanionMap(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => `${(px * k).toFixed(1)}px ${th.font}`, Lo = mapLayout(W, H, d, opt), { px0, px1, py0, py1, X, Y } = Lo;
  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  // the colour scale reaches the median of the map's finite Δχ² (between 25 and 400), on a log stretch: the poorer half of
  // the map is dark and the valley of good companions shows its shape
  const top = d.grid ? Math.min(400, Math.max(25, (() => { const v = Array.from(d.grid.dchi2).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 60; })())) : 60;
  const shade = (dc) => 1 - Math.min(1, Math.log1p(dc) / Math.log1p(top));
  if (d.grid) {
    // the grid search: each cell from midway to midway between grid values, coloured by Δχ² against the best cell
    const g = d.grid, P = d.basePeriod, mid = (a, i, f) => (i <= 0 ? f(a[0]) - (f(a[1]) - f(a[0])) / 2 : i >= a.length ? f(a[a.length - 1]) + (f(a[a.length - 1]) - f(a[a.length - 2])) / 2 : (f(a[i - 1]) + f(a[i])) / 2);
    const lg = (v) => Math.log10(v), id = (v) => v / P;
    for (let im = 0; im < g.nm; im++) for (let ip = 0; ip < g.np; ip++) {
      const dc = g.dchi2[im * g.np + ip]; ctx.fillStyle = Number.isFinite(dc) ? ramp(shade(dc)) : th.grid;
      const xa = X(mid(g.period, ip, id)), xb = X(mid(g.period, ip + 1, id)), ya = Y(Math.pow(10, mid(g.mass, im, lg))), yb = Y(Math.pow(10, mid(g.mass, im + 1, lg)));
      ctx.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa) + 0.6, Math.abs(yb - ya) + 0.6);
    }
  }
  // low-order mean-motion resonances
  ctx.font = F(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let lastLabel = -Infinity;
  for (const [q, p] of [...RES].sort((a, b) => a[1] / a[0] - b[1] / b[0])) {   // period ratio p/q is the p:q resonance (P_c/P_b = 2 is 2:1), left to right
    const r = p / q, x = X(r); if (x < px0 + 2 || x > px1 - 2) continue;
    ctx.strokeStyle = d.grid ? 'rgba(255,255,255,0.35)' : th.grid; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke(); ctx.setLineDash([]);
    if (x - lastLabel > 26 * k && x > px0 + 14 * k && x < px1 - 14 * k) { ctx.fillStyle = d.grid ? '#ffffff' : th.text; ctx.fillText(`${p}:${q}`, x, py0 + 3); lastLabel = x; }
  }
  // the posterior's companions
  const ss = d.samples || [];
  if (ss.length) { ctx.fillStyle = th.model; ctx.globalAlpha = Math.max(0.15, Math.min(0.6, 30 / ss.length)); for (const s of ss) { ctx.beginPath(); ctx.arc(X(s.ratio), Y(s.mass), 2.2, 0, TAU); ctx.fill(); } ctx.globalAlpha = 1; }
  const mark = (p, col, r, cross) => { if (!p) return; const x = X(p.ratio), y = Y(p.mass); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); if (cross) { ctx.beginPath(); ctx.moveTo(x - r - 5, y); ctx.lineTo(x - r + 2, y); ctx.moveTo(x + r - 2, y); ctx.lineTo(x + r + 5, y); ctx.moveTo(x, y - r - 5); ctx.lineTo(x, y - r + 2); ctx.moveTo(x, y + r - 2); ctx.lineTo(x, y + r + 5); ctx.stroke(); } ctx.lineWidth = 1; };
  if (d.hover) mark(d.hover, th.text, 5, false);
  if (d.best) mark(d.best, '#ffffff', 6, false);
  if (d.sel) mark(d.sel, th.cursor || '#ffc56b', 8, true);
  ctx.restore();
  // axes
  ctx.strokeStyle = th.frame || th.grid; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1);
  ctx.fillStyle = th.text; ctx.font = F(11); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xt = ticks(Lo.x0, Lo.x1, Math.max(3, Math.floor((px1 - px0) / 70)));
  for (const v of xt.out) { const x = X(v); ctx.fillRect(x, py1, 1, 4); ctx.fillText(v.toFixed(dec(xt.s)), x, py1 + 6); }
  ctx.fillText(`period of the companion / period of ${d.letter || 'b'}`, (px0 + px1) / 2, py1 + 8 + 13 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  // 1, 2, 5 per decade on a wide axis; on a narrow one (less than a factor of 2.5) evenly spaced round values instead
  const yl = []; for (let e = Math.floor(Math.log10(Lo.y0)); e <= Math.ceil(Math.log10(Lo.y1)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= Lo.y0 && v <= Lo.y1) yl.push([v, v >= 1 ? String(v) : v.toPrecision(1)]); }
  if (yl.length < 2) { const yt = ticks(Lo.y0, Lo.y1, Math.max(3, Math.floor((py1 - py0) / 40))); yl.length = 0; for (const v of yt.out) if (v > 0) yl.push([v, v.toFixed(dec(yt.s))]); }
  for (const [v, txt] of yl) { const y = Y(v); ctx.fillRect(px0 - 4, y, 4, 1); ctx.fillText(txt, px0 - 6, y); }
  ctx.save(); ctx.translate(13, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('companion mass (M Jup)', 0, 0); ctx.restore();
  if (d.grid) {   // the colour scale
    const cx = px1 + 14, w = 10; for (let i = 0; i < 60; i++) { ctx.fillStyle = ramp(1 - i / 59); ctx.fillRect(cx, py0 + ((py1 - py0) * i) / 60, w, (py1 - py0) / 60 + 1); }
    ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.font = F(10); for (const v of [0, 2, 10, Math.round(top)]) { const f = Math.log1p(v) / Math.log1p(top); ctx.fillText(String(v), cx + w + 3, py0 + f * (py1 - py0)); }
    ctx.save(); ctx.translate(W - 6, (py0 + py1) / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Δχ²', 0, 0); ctx.restore();
  }
  ctx.fillStyle = th.title; ctx.font = `${(12 * k).toFixed(1)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(opt.title || 'Where the companion can be', px0, py0 - 10);
}

/**
 * d: { t, mstar, bodies: [{ label, a, e, omega, per, tmid, color, main }], cloud: [{ a, e, omega, per, tmid }], unit: 'AU' }
 * opt: { fontScale, title, trail (fraction of an orbit drawn behind each planet, default 0.15) }
 */
export function renderCompanionOrbits(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, pad = 18 * k, T = 26 * k, cx = W / 2, cy = (H + T) / 2;
  let rmax = 0; for (const o of [...(d.bodies || []), ...(d.cloud || [])]) rmax = Math.max(rmax, o.a * (1 + Math.min(0.95, o.e || 0)));
  const sc = (Math.min(W, H - T) / 2 - pad) / (rmax || 1), P = (o, t) => { const [x, z] = orbitPoint(o, t); return [cx + x * sc, cy + z * sc]; };
  const ellipse = (o) => { ctx.beginPath(); for (let i = 0; i <= 120; i++) { const [x, y] = P(o, o.tmid + (o.per * i) / 120); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.stroke(); };
  // the line of sight: the observer is below; transits happen on it
  ctx.strokeStyle = th.grid; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, H - 4); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = th.text; ctx.font = `${(10 * k).toFixed(1)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('to Earth ↓', cx + 6, H - 4);
  // the posterior's orbits and where each of those companions is now
  const cl = d.cloud || [];
  if (cl.length) {
    ctx.strokeStyle = th.model; ctx.globalAlpha = Math.max(0.05, Math.min(0.25, 6 / cl.length)); ctx.lineWidth = 1;
    for (const o of cl) ellipse(o);
    ctx.globalAlpha = 0.55; ctx.fillStyle = th.model; for (const o of cl) { const [x, y] = P(o, d.t); ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  for (const o of d.bodies || []) {
    const col = o.color || th.model;
    ctx.strokeStyle = col; ctx.globalAlpha = o.main ? 0.9 : 0.6; ctx.lineWidth = o.main ? 1.6 : 1.2; ellipse(o); ctx.globalAlpha = 1;
    // a short trail behind the planet
    const tr = (opt.trail ?? 0.15) * o.per; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 0; i < 24; i++) { const ta = d.t - tr * (1 - i / 24), tb = d.t - tr * (1 - (i + 1) / 24), [xa, ya] = P(o, ta), [xb, yb] = P(o, tb); ctx.globalAlpha = (i + 1) / 30; ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.lineCap = 'butt';
    const [x, y] = P(o, d.t), r = 3 + Math.min(5, Math.cbrt(Math.max(0.001, o.mass || 0.05)) * 4);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.fillStyle = th.title; ctx.font = `${(11 * k).toFixed(1)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(o.label || '', x + r + 4, y);
  }
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 9); g.addColorStop(0, '#fff6d8'); g.addColorStop(0.5, '#ffc56b'); g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 9, 0, TAU); ctx.fill();
  // a scale bar
  const step = niceStep(rmax, 3), len = step * sc; ctx.strokeStyle = th.text; ctx.fillStyle = th.text; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(pad, H - 10); ctx.lineTo(pad + len, H - 10); ctx.stroke(); ctx.lineWidth = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = `${(10 * k).toFixed(1)}px ${th.font}`; ctx.fillText(`${step.toFixed(dec(step))} ${d.unit || 'AU'}`, pad + len / 2, H - 13);
  ctx.fillStyle = th.title; ctx.font = `${(12 * k).toFixed(1)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(opt.title || 'The system from above', pad, T - 6);
  if (d.clock) { ctx.textAlign = 'right'; ctx.font = `${(11 * k).toFixed(1)}px ${th.font}`; ctx.fillStyle = th.text; ctx.fillText(d.clock, W - pad, T - 6); }
}

/**
 * d: { obs: { E[], oc[] (minutes), err[] }, sel?: { E[], oc[] }, spread?: [{ E[], oc[] }], letter, note }
 */
export function renderCompanionOC(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, L = 56 + 10 * k, R = 14, T = 28 + 8 * k, B = 30 + 12 * k, px0 = L, px1 = W - R, py0 = T, py1 = H - B;
  const o = d.obs || { E: [], oc: [], err: [] }; let e0 = Infinity, e1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < o.E.length; i++) { e0 = Math.min(e0, o.E[i]); e1 = Math.max(e1, o.E[i]); y0 = Math.min(y0, o.oc[i] - o.err[i]); y1 = Math.max(y1, o.oc[i] + o.err[i]); }
  for (const c of [d.sel, ...(d.spread || [])]) if (c) for (let i = 0; i < c.E.length; i++) { if (c.E[i] < e0 - 0.05 * (e1 - e0) || c.E[i] > e1 + 0.05 * (e1 - e0)) continue; y0 = Math.min(y0, c.oc[i]); y1 = Math.max(y1, c.oc[i]); }
  if (!(e1 > e0)) { e0 = 0; e1 = 1; } if (!(y1 > y0)) { y0 = -1; y1 = 1; }
  const yp = 0.08 * (y1 - y0); y0 -= yp; y1 += yp;
  const X = (E) => px0 + ((E - e0) / (e1 - e0)) * (px1 - px0), Y = (v) => py1 - ((v - y0) / (y1 - y0)) * (py1 - py0);
  ctx.font = `${(11 * k).toFixed(1)}px ${th.font}`; ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const yt = ticks(y0, y1, Math.max(3, Math.floor((py1 - py0) / 36)));
  for (const v of yt.out) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillText(v.toFixed(dec(yt.s)), px0 - 6, y); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xt = ticks(e0, e1, Math.max(3, Math.floor((px1 - px0) / 70)));
  for (const v of xt.out) { const x = X(v); ctx.fillRect(x, py1, 1, 4); ctx.fillText(String(Math.round(v)), x, py1 + 6); }
  ctx.fillText(`transit number of ${d.letter || 'b'}`, (px0 + px1) / 2, py1 + 8 + 13 * k);
  ctx.save(); ctx.translate(13, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('O − C (minutes)', 0, 0); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  const line = (c) => { ctx.beginPath(); c.E.forEach((E, i) => { const x = X(E), y = Y(c.oc[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); };
  ctx.strokeStyle = th.model; ctx.lineWidth = 1; ctx.globalAlpha = Math.max(0.08, Math.min(0.35, 4 / Math.max(1, (d.spread || []).length))); for (const c of d.spread || []) line(c); ctx.globalAlpha = 1;
  if (d.sel) { ctx.strokeStyle = th.cursor || '#ffc56b'; ctx.lineWidth = 2; line(d.sel); ctx.lineWidth = 1; }
  // the data last, over the curves: error bars, then points with a ring in the background colour so they stand out
  ctx.strokeStyle = th.err || th.res || th.text; for (let i = 0; i < o.E.length; i++) { const x = X(o.E[i]); ctx.beginPath(); ctx.moveTo(x, Y(o.oc[i] - o.err[i])); ctx.lineTo(x, Y(o.oc[i] + o.err[i])); ctx.stroke(); }
  for (let i = 0; i < o.E.length; i++) { const x = X(o.E[i]), y = Y(o.oc[i]); ctx.fillStyle = th.bg; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, TAU); ctx.fill(); ctx.fillStyle = th.bin || th.text; ctx.beginPath(); ctx.arc(x, y, 2.3, 0, TAU); ctx.fill(); }
  ctx.restore();
  ctx.strokeStyle = th.frame || th.grid; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1);
  ctx.fillStyle = th.title; ctx.font = `${(12 * k).toFixed(1)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(opt.title || 'Transit timing: observed and simulated', px0, py0 - 10);
  if (d.note) { const wide = W > 520; ctx.textAlign = wide ? 'right' : 'left'; ctx.font = `${(10.5 * k).toFixed(1)}px ${th.font}`; ctx.fillStyle = th.text; ctx.fillText(d.note, wide ? px1 : px0, wide ? py0 - 10 : py0 + 14); }
}
