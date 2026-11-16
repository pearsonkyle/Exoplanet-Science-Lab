// Plots for N-body results (src/core/nbody.js): simulated O - C of each planet with data overlaid, the
// mass-period map of a perturber grid, and a top-down view of the orbits. Pure drawing routines like renderOC():
// each takes a 2D context, a size, a plain data object and a theme from LC_THEMES, so the screen, the exported
// figure and a movie frame share the code.

import { LC_THEMES, niceTicks, decimals, groupColor } from './lightcurve.js';

const frame = (ctx, th, x0, y0, x1, y1) => { if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); } };
const mix = (a, b, w) => { const pa = parseColor(a), pb = parseColor(b); return `rgb(${[0, 1, 2].map((i) => Math.round(pa[i] + (pb[i] - pa[i]) * w)).join(',')})`; };
function parseColor(c) {
  if (c[0] === '#') { const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
}

/**
 * O - C of each planet from a simulation, one panel per planet (they have different periods and amplitudes),
 * on a common time axis, with observed points overlaid where given.
 * d: {
 *   planets: [{
 *     label                     e.g. 'b'
 *     t: array-like             mid-transit times, days (any zero point; d.tRef is subtracted for the axis)
 *     oc: array-like            simulated O - C, days, against whatever ephemeris the caller chose
 *     data: { t, oc, errs } | null     observed O - C against the SAME ephemeris, days
 *     group: Int32Array | null, groups: [names]    optional source of each observed point (colours + legend)
 *   }],
 *   tRef     subtracted from every time (default: earliest time shown)
 *   label    text at the top left when opt.title is not given
 *   info: [strings]   drawn at the top right of the first panel
 * }
 * opt: { title, fontScale, points: true (draw a dot at every simulated transit when there are fewer than 400) }
 */
export function renderNbodyOC(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => (px * k).toFixed(1);
  const L = 58 + 12 * k, R = 14, T = opt.title ? 22 + 18 * k : 14 + 12 * k, B = 24 + 16 * k, gap = 10;
  const pls = (d.planets || []).filter((p) => p && p.t && p.t.length);
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  if (!pls.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('No transits', W / 2, H / 2); return; }
  let t0 = Infinity, t1 = -Infinity;
  for (const p of pls) { for (const v of p.t) { if (v < t0) t0 = v; if (v > t1) t1 = v; } if (p.data) for (const v of p.data.t) { if (v < t0) t0 = v; if (v > t1) t1 = v; } }
  const tRef = d.tRef ?? t0, pad = 0.03 * (t1 - t0 || 1); t0 -= pad; t1 += pad;
  const px0 = L, px1 = W - R, hP = (H - T - B - gap * (pls.length - 1)) / pls.length;
  const X = (t) => px0 + ((t - t0) / (t1 - t0)) * (px1 - px0);
  const xt = niceTicks(t0 - tRef, t1 - tRef, Math.max(3, Math.floor((px1 - px0) / (70 * k + 20))));
  pls.forEach((p, ip) => {
    const py0 = T + ip * (hP + gap), py1 = py0 + hP, n = p.t.length;
    let ymax = 0; for (let i = 0; i < n; i++) ymax = Math.max(ymax, Math.abs(p.oc[i]));
    if (p.data) for (let i = 0; i < p.data.t.length; i++) ymax = Math.max(ymax, Math.abs(p.data.oc[i]) + (p.data.errs ? p.data.errs[i] : 0));
    ymax = Math.max(ymax, 1e-7) * 1.18;
    const sec = ymax * 1440 < 3, u = sec ? 86400 : 1440, yr = ymax * u;
    const Y = (v) => py0 + (1 - (v * u + yr) / (2 * yr)) * (py1 - py0);
    ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) { const x = X(v + tRef); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke(); if (ip === pls.length - 1) { ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py1 + 5); } }
    const yt = niceTicks(-yr, yr, Math.max(2, Math.floor((py1 - py0) / 34)));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) { const y = Y(v / u); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
    ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = th.text; ctx.fillText(`O − C ${p.label || ''} (${sec ? 's' : 'min'})`, 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
    ctx.strokeStyle = th.text; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(px0, Y(0)); ctx.lineTo(px1, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = th.model; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = X(p.t[i]), y = Y(p.oc[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    if (opt.points !== false && n < 400) { ctx.fillStyle = th.model; for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(X(p.t[i]), Y(p.oc[i]), 1.6, 0, 6.3); ctx.fill(); } }
    if (p.data) {
      const D = p.data, grp = p.group && p.groups && p.groups.length > 1 ? p.group : null;
      ctx.strokeStyle = th.bin; ctx.fillStyle = th.bin; ctx.lineWidth = 1.2;
      for (let i = 0; i < D.t.length; i++) {
        const x = X(D.t[i]);
        if (grp) { ctx.strokeStyle = groupColor(th, grp[i]); ctx.fillStyle = groupColor(th, grp[i]); }
        if (D.errs) { ctx.beginPath(); ctx.moveTo(x, Y(D.oc[i] - D.errs[i])); ctx.lineTo(x, Y(D.oc[i] + D.errs[i])); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(x, Y(D.oc[i]), 3, 0, 6.3); ctx.fill();
      }
      if (grp) {
        ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; let lx = px0 + 8; const ly = py1 - 7;
        p.groups.forEach((nm, g) => { const w = 22 + ctx.measureText(nm).width; if (lx + w > px1 - 4) return; ctx.fillStyle = groupColor(th, g); ctx.beginPath(); ctx.arc(lx + 5, ly - 3.5, 3, 0, 6.3); ctx.fill(); ctx.fillStyle = th.text; ctx.fillText(nm, lx + 12, ly); lx += w; });
      }
    }
    ctx.restore();
    frame(ctx, th, px0, py0, px1, py1);
    if (ip === 0 && d.info && d.info.length) { ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; d.info.forEach((s, i) => ctx.fillText(s, px1 - 8, py0 + 6 + 11 * k + i * 14 * k)); }
  });
  ctx.font = `${F(11)}px ${th.font}`; ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(tRef ? `Time (days since ${+tRef.toFixed(4)})` : 'Time (days)', (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || d.label || '', px0, T - 6);
}

/**
 * Map of a perturber grid: how much better than a straight-line ephemeris each (period, mass) explains the
 * observed times. Colour is the improvement in chi-square as a fraction of the best cell's, so cells that do
 * no better than no perturber at all are the background colour.
 * d: the object returned by ttvGrid(), or any object with
 *   { mass (M_Jup, ascending), period (days, ascending), nm, np, chi2 (nm*np, row = mass), chi2Linear,
 *     stable (Uint8Array), mask (Uint8Array | null), best: { mass, period, chi2 } }
 *   plus, optionally,
 *   refined: { mass, period }     a polished solution (ttvGridRefine), drawn as a ring
 *   truth:   { mass, period }     for synthetic data, drawn as a cross
 *   basePeriod                    period of the transiting planet: adds the period ratio on the top axis and
 *                                 marks the first-order resonances
 * opt: { title, fontScale, massUnit: 'M Jup' (label only), mask: true (outline the EXOTIC-style amplitude/period mask) }
 */
export function renderGridMap(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => (px * k).toFixed(1);
  const L = 58 + 12 * k, R = 74 + 10 * k, T = (opt.title ? 22 + 18 * k : 14 + 12 * k) + (d.basePeriod ? 16 * k : 0), B = 24 + 16 * k;
  const px0 = L, px1 = W - R, py0 = T, py1 = H - B, nm = d.nm, np = d.np;
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  // cell edges: midway between grid values (log for mass when the spacing is geometric)
  const logM = nm > 2 && Math.abs(d.mass[2] / d.mass[1] - d.mass[1] / d.mass[0]) < 1e-6 * (d.mass[1] / d.mass[0]) && d.mass[0] > 0;
  const fm = (v) => (logM ? Math.log(v) : v);
  const edges = (a, f) => { const n = a.length, e = new Float64Array(n + 1); for (let i = 1; i < n; i++) e[i] = 0.5 * (f(a[i - 1]) + f(a[i])); e[0] = f(a[0]) - (e[1] - f(a[0])); e[n] = f(a[n - 1]) + (f(a[n - 1]) - e[n - 1]); return e; };
  const ex = edges(d.period, (v) => v), ey = edges(d.mass, fm);
  const X = (v) => px0 + ((v - ex[0]) / (ex[np] - ex[0])) * (px1 - px0), Y = (v) => py1 - ((v - ey[0]) / (ey[nm] - ey[0])) * (py1 - py0);
  const lin = d.chi2Linear, best = d.best.chi2, hi = th.model, lo = th.bg, bad = th.frame ? '#d9d9d9' : '#2a3040';
  for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) {
    const q = im * np + ip, x0 = X(ex[ip]), x1 = X(ex[ip + 1]), y0 = Y(ey[im + 1]), y1 = Y(ey[im]);
    if (!d.stable[q]) ctx.fillStyle = bad;
    else { const w = Math.max(0, Math.min(1, (lin - d.chi2[q]) / Math.max(lin - best, 1e-12))); ctx.fillStyle = mix(lo, hi, Math.pow(w, 0.7)); }
    ctx.fillRect(x0, y0, Math.ceil(x1 - x0) + 0.5, Math.ceil(y1 - y0) + 0.5);
  }
  // amplitude/period mask (EXOTIC's estimate_prior): outline
  if (d.mask && opt.mask !== false) {
    ctx.strokeStyle = th.bin; ctx.lineWidth = 1.2; ctx.setLineDash([3, 2]);
    const on = (im, ip) => im >= 0 && im < nm && ip >= 0 && ip < np && d.mask[im * np + ip];
    ctx.beginPath();
    for (let im = 0; im < nm; im++) for (let ip = 0; ip < np; ip++) if (on(im, ip)) {
      const x0 = X(ex[ip]), x1 = X(ex[ip + 1]), y0 = Y(ey[im + 1]), y1 = Y(ey[im]);
      if (!on(im, ip - 1)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); } if (!on(im, ip + 1)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
      if (!on(im + 1, ip)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); } if (!on(im - 1, ip)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  // resonances
  if (d.basePeriod > 0) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const [a, b] of [[3, 2], [5, 3], [2, 1], [5, 2], [3, 1]]) {
      const p = (d.basePeriod * a) / b; if (p <= ex[0] || p >= ex[np]) continue;
      ctx.strokeStyle = th.text; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(X(p), py0); ctx.lineTo(X(p), py1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = th.text; ctx.fillText(`${a}:${b}`, X(p), py0 - 3);
    }
  }
  // axes
  const xt = niceTicks(ex[0], ex[np], Math.max(3, Math.floor((px1 - px0) / (70 * k + 20))));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = th.text;
  for (const v of xt) { const x = X(v); ctx.strokeStyle = th.text; ctx.beginPath(); ctx.moveTo(x, py1); ctx.lineTo(x, py1 + 4); ctx.stroke(); ctx.fillText(v.toFixed(decimals(xt.step)), x, py1 + 6); }
  ctx.fillText('Perturber period (days)', (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  if (logM) {
    const d0 = Math.floor(Math.log10(d.mass[0])), d1 = Math.ceil(Math.log10(d.mass[nm - 1]));
    for (let e = d0; e <= d1; e++) for (const mth of [1, 2, 5]) { const v = mth * Math.pow(10, e), y = Y(Math.log(v)); if (y < py0 - 0.5 || y > py1 + 0.5) continue; ctx.strokeStyle = th.text; ctx.beginPath(); ctx.moveTo(px0 - 4, y); ctx.lineTo(px0, y); ctx.stroke(); ctx.fillText(String(+v.toPrecision(2)), px0 - 6, y); }
  } else { const yt = niceTicks(ey[0], ey[nm], Math.max(3, Math.floor((py1 - py0) / 34))); for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.text; ctx.beginPath(); ctx.moveTo(px0 - 4, y); ctx.lineTo(px0, y); ctx.stroke(); ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); } }
  ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(`Perturber mass (${opt.massUnit || 'M Jup'})`, 0, 0); ctx.restore();
  ctx.strokeStyle = th.frame || th.text; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, py1 - py0 - 1);
  // markers
  const mark = (p, kind, col) => {
    if (!p) return; const x = X(p.period), y = Y(fm(p.mass)); if (!(x >= px0 && x <= px1 && y >= py0 && y <= py1)) return;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
    if (kind === 'ring') ctx.arc(x, y, 7, 0, 6.3); else if (kind === 'box') ctx.rect(x - 6, y - 6, 12, 12); else { ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x - 7, y + 7); ctx.lineTo(x + 7, y - 7); }
    ctx.stroke();
  };
  const cBest = th.cursor || '#e88b00', cTruth = th.frame ? '#000000' : '#ff8fa3';
  mark(d.best, 'box', cBest); mark(d.refined, 'ring', cBest); mark(d.truth, 'cross', cTruth);
  // colour bar and legend
  const bx = px1 + 14, bw = 12;
  for (let i = 0; i < py1 - py0; i++) { const w = 1 - i / (py1 - py0 - 1); ctx.fillStyle = mix(lo, hi, Math.pow(w, 0.7)); ctx.fillRect(bx, py0 + i, bw, 1.5); }
  ctx.strokeStyle = th.frame || th.text; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, py0 + 0.5, bw, py1 - py0 - 1);
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `${F(10.5)}px ${th.font}`;
  ctx.fillText(`χ² ${best.toFixed(0)}`, bx + bw + 4, py0 + 6); ctx.fillText(`${lin.toFixed(0)}`, bx + bw + 4, py1 - 14); ctx.fillText('(line)', bx + bw + 4, py1 - 2);
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textBaseline = 'alphabetic';
  let lx = px0 + 8; const ly = py1 - 8;
  const leg = (txt, kind, col) => { const w = 26 + ctx.measureText(txt).width; if (lx + w > px1 - 4) return; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); const x = lx + 6, y = ly - 4; if (kind === 'ring') ctx.arc(x, y, 4.5, 0, 6.3); else if (kind === 'box') ctx.rect(x - 4, y - 4, 8, 8); else if (kind === 'dash') { ctx.setLineDash([3, 2]); ctx.rect(x - 5, y - 4, 10, 8); } else { ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x - 4, y + 4); ctx.lineTo(x + 4, y - 4); } ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = th.title; ctx.fillText(txt, lx + 15, ly); lx += w; };
  // legend on a strip so it reads over any cell colour
  const items = [['best cell', 'box', cBest]]; if (d.refined) items.push(['polished', 'ring', cBest]); if (d.truth) items.push(['truth', 'cross', cTruth]); if (d.mask && opt.mask !== false) items.push(['amplitude + period match', 'dash', th.bin]);
  let wTot = 8; for (const it of items) wTot += 26 + ctx.measureText(it[0]).width;
  ctx.fillStyle = th.bg; ctx.globalAlpha = 0.78; ctx.fillRect(px0 + 2, ly - 14, Math.min(wTot, px1 - px0 - 4), 20); ctx.globalAlpha = 1;
  for (const it of items) leg(...it);
  if (d.basePeriod > 0) { ctx.font = `${F(10)}px ${th.font}`; ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('resonances', px0 - 6, py0 - 3); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || d.label || '', px0, (opt.title ? 22 + 18 * k : 14 + 12 * k) - 6);
}

/**
 * Top-down view of the orbits: the plane containing the line of sight, seen from above the orbit, with the
 * observer at the bottom. Horizontal: X (sky plane); vertical: Z (toward the observer, downward on the page).
 * d: {
 *   bodies: [{ label, x: array-like 3*nt (X, Y, Z of each sample, as returned in simulate(...).samples.x), star: bool }]
 *            positions are drawn relative to the body flagged `star` (the first when none is flagged)
 *   unit: 'R★' | 'AU'     label of the length unit of x
 *   label, info: [strings]
 * }
 * opt: { title, fontScale, trail: 1 (fraction of the samples drawn, from the end; the last sample is the marker) }
 */
export function renderOrbitTop(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || 1, F = (px) => (px * k).toFixed(1);
  const L = 58 + 12 * k, R = 14, T = opt.title ? 22 + 18 * k : 14 + 12 * k, B = 24 + 16 * k;
  const bodies = d.bodies || [], is = Math.max(0, bodies.findIndex((b) => b.star)), S = bodies[is];
  ctx.font = `${F(11)}px ${th.font}`;
  if (!S || !S.x || !S.x.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('No orbit', W / 2, H / 2); return; }
  const nt = S.x.length / 3; let rmax = 0;
  for (const b of bodies) if (b !== S) for (let i = 0; i < nt; i++) rmax = Math.max(rmax, Math.abs(b.x[3 * i] - S.x[3 * i]), Math.abs(b.x[3 * i + 2] - S.x[3 * i + 2]));
  rmax = (rmax || 1) * 1.12;
  const px0 = L, px1 = W - R, py0 = T, py1 = H - B, cx = (px0 + px1) / 2, cy = (py0 + py1) / 2, sc = Math.min(px1 - px0, py1 - py0) / (2 * rmax);
  const X = (v) => cx + v * sc, Y = (z) => cy + z * sc;                       // +Z (toward the observer) is down
  const xr = (px1 - px0) / (2 * sc), yr = (py1 - py0) / (2 * sc);
  const xt = niceTicks(-xr, xr, Math.max(3, Math.floor((px1 - px0) / (70 * k + 20)))), yt = niceTicks(-yr, yr, Math.max(3, Math.floor((py1 - py0) / 40)));
  ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py1 + 5); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`X, plane of the sky (${d.unit || 'R★'})`, (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.save(); ctx.translate(4 + 8 * k, (py0 + py1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(`Z, toward the observer ↓ (${d.unit || 'R★'})`, 0, 0); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, py1 - py0); ctx.clip();
  // line of sight
  ctx.strokeStyle = th.text; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, py1); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.fillText('to observer', cx + 6, py1 - 5);
  const i0 = Math.max(0, Math.floor(nt * (1 - (opt.trail ?? 1))));
  let g = 0;
  bodies.forEach((b) => {
    if (b === S) return;
    const col = groupColor(th, g++);
    ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.75; ctx.beginPath();
    for (let i = i0; i < nt; i++) { const x = X(b.x[3 * i] - S.x[3 * i]), y = Y(b.x[3 * i + 2] - S.x[3 * i + 2]); if (i > i0) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
    const xe = X(b.x[3 * (nt - 1)] - S.x[3 * (nt - 1)]), ye = Y(b.x[3 * (nt - 1) + 2] - S.x[3 * (nt - 1) + 2]);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(xe, ye, 4, 0, 6.3); ctx.fill();
    ctx.fillStyle = th.title; ctx.font = `${F(11)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(b.label || '', xe + 7, ye);
  });
  // the star, to scale when the unit is the stellar radius
  const rs = d.unit === 'AU' ? 4 : Math.max(3, sc);
  ctx.fillStyle = th.cursor || '#e8a13a'; ctx.beginPath(); ctx.arc(cx, cy, rs, 0, 6.3); ctx.fill();
  ctx.restore();
  frame(ctx, th, px0, py0, px1, py1);
  if (d.info && d.info.length) { ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; d.info.forEach((s, i) => ctx.fillText(s, px1 - 8, py0 + 6 + 11 * k + i * 14 * k)); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`;
  ctx.fillText(opt.title || d.label || '', px0, T - 6);
}

/** Draw one of the three plots into a canvas at its displayed size (screen) or at a fixed size (export). kind: 'oc' | 'grid' | 'orbit'. */
export function drawNbody(cv, kind, d, opt = {}) {
  const W = opt.width || cv.clientWidth, H = opt.height || cv.clientHeight; if (!W || !H) return;
  const scale = opt.scale || Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale); cv._cssW = W; cv._cssH = H;
  const ctx = cv.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  (kind === 'grid' ? renderGridMap : kind === 'orbit' ? renderOrbitTop : renderNbodyOC)(ctx, W, H, d, LC_THEMES[opt.theme || 'dark'], opt);
}
