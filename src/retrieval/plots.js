// The Retrieval page's spectrum figure: a pure render function (ctx, W, H, data, theme), so screen and export draw the
// same thing. One panel per data set (a transit depth and an eclipse depth do not share a scale), each with its
// residuals in units of the errors underneath.
import { SPEC_THEME } from '../spectra/plots.js';

const KIND = { transit: 'Transit depth (ppm)', eclipse: 'Eclipse depth (ppm)', night: 'Night side, planet / star (ppm)' };
const nice = (span, n = 5) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
const hexA = (c, a) => { const m = /^#([0-9a-f]{6})$/i.exec(c || ''); if (!m) return c; const v = parseInt(m[1], 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; };

/**
 * d = { title, sets: [{ name, kind, wl, lo, hi, y, err (fractions), best: model on the bins | null,
 *       band: { lo, hi } | null (16 to 84% of the posterior's models), truth: [] | null }],
 *       curve: { wl, transit, eclipse, night } | null (the best model on the grid the fit ran on) }
 * Returns the height a panel was given (for tests).
 */
export function renderFit(ctx, W, H, d, th = SPEC_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.font = th.font;
  const sets = d.sets || [], mL = 66, mR = 14, mT = d.title ? 26 : 12, mB = 34, gap = 22, pw = W - mL - mR;
  if (d.title) { ctx.fillStyle = th.strong || th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(d.title, mL, 6); }
  if (!sets.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('No spectrum yet: load a file or simulate one.', W / 2, H / 2); return 0; }
  const each = (H - mT - mB - gap * (sets.length - 1)) / sets.length;
  let x0 = Infinity, x1 = 0; for (const s of sets) for (let i = 0; i < s.wl.length; i++) { x0 = Math.min(x0, s.lo ? s.lo[i] : s.wl[i]); x1 = Math.max(x1, s.hi ? s.hi[i] : s.wl[i]); }
  x0 *= 0.97; x1 *= 1.03; const X = (v) => mL + (Math.log(v / x0) / Math.log(x1 / x0)) * pw;
  const ticks = [0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20].filter((v) => v >= x0 && v <= x1);
  sets.forEach((s, j) => {
    const top = mT + j * (each + gap), hRes = Math.max(34, Math.round(0.22 * each)), ph = each - hRes - 6, n = s.wl.length;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { lo = Math.min(lo, s.y[i] - s.err[i], s.best ? s.best[i] : Infinity, s.band ? s.band.lo[i] : Infinity); hi = Math.max(hi, s.y[i] + s.err[i], s.best ? s.best[i] : -Infinity, s.band ? s.band.hi[i] : -Infinity); }
    const pad = 0.06 * (hi - lo || Math.abs(hi) || 1e-6); lo -= pad; hi += pad;
    const Y = (v) => top + (1 - (v - lo) / (hi - lo)) * ph, st = nice((hi - lo) * 1e6);
    ctx.strokeStyle = th.grid; ctx.fillStyle = th.text; ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil((lo * 1e6) / st) * st; v <= hi * 1e6; v += st) { const y = Math.round(Y(v * 1e-6)) + 0.5; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke(); ctx.fillText(String(Math.round(v)), mL - 6, y); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of ticks) { const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.moveTo(x, top + ph + 6); ctx.lineTo(x, top + ph + 6 + hRes); ctx.stroke(); if (j === sets.length - 1) ctx.fillText(String(v), x, top + each + 5); }
    ctx.strokeStyle = th.frame || th.grid; ctx.strokeRect(mL + 0.5, Math.round(top) + 0.5, pw, Math.round(ph)); ctx.strokeRect(mL + 0.5, Math.round(top + ph + 6) + 0.5, pw, hRes);
    ctx.save(); ctx.beginPath(); ctx.rect(mL, top, pw, ph); ctx.clip();
    // the posterior's band, bin by bin
    if (s.band) { ctx.fillStyle = hexA(th.post || th.model, 0.3); for (let i = 0; i < n; i++) { const a = X(s.lo ? s.lo[i] : s.wl[i] * 0.99), b = X(s.hi ? s.hi[i] : s.wl[i] * 1.01); ctx.fillRect(a, Y(s.band.hi[i]), Math.max(1.5, b - a), Math.max(1, Y(s.band.lo[i]) - Y(s.band.hi[i]))); } }
    // the best model on its own grid, faint, and on the data's bins
    const c = d.curve && d.curve[s.kind];
    if (c) { ctx.strokeStyle = hexA(th.model, 0.45); ctx.lineWidth = 1; ctx.beginPath(); let pen = false; for (let i = 0; i < d.curve.wl.length; i++) { const w = d.curve.wl[i]; if (w < x0 || w > x1) continue; const x = X(w), y = Y(c[i]); if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; } } ctx.stroke(); }
    if (s.best) { ctx.strokeStyle = th.model; ctx.lineWidth = 1.6; ctx.beginPath(); for (let i = 0; i < n; i++) { const a = X(s.lo ? s.lo[i] : s.wl[i]), b = X(s.hi ? s.hi[i] : s.wl[i]), y = Y(s.best[i]); if (i === 0) ctx.moveTo(a, y); else ctx.lineTo(a, y); ctx.lineTo(b, y); } ctx.stroke(); }
    if (s.truth) { ctx.strokeStyle = th.star || th.warn; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); for (let i = 0; i < n; i++) { const x = X(s.wl[i]), y = Y(s.truth[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]); }
    ctx.strokeStyle = th.data; ctx.fillStyle = th.data; ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) { const x = X(s.wl[i]); ctx.beginPath(); ctx.moveTo(x, Y(s.y[i] - s.err[i])); ctx.lineTo(x, Y(s.y[i] + s.err[i])); ctx.stroke(); ctx.beginPath(); ctx.arc(x, Y(s.y[i]), 2.2, 0, 2 * Math.PI); ctx.fill(); }
    ctx.restore();
    // residuals in units of the errors
    const ry = top + ph + 6, RY = (z) => ry + (0.5 - Math.max(-4, Math.min(4, z)) / 8) * hRes;
    ctx.strokeStyle = th.star || th.text; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(mL, Math.round(RY(0)) + 0.5); ctx.lineTo(mL + pw, Math.round(RY(0)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('+3σ', mL - 6, RY(3)); ctx.fillText('0', mL - 6, RY(0)); ctx.fillText('−3σ', mL - 6, RY(-3));
    ctx.save(); ctx.translate(11, ry + hRes / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Residual', 0, 0); ctx.restore();
    if (s.best) { ctx.fillStyle = th.data; for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(X(s.wl[i]), RY((s.y[i] - s.best[i]) / s.err[i]), 2, 0, 2 * Math.PI); ctx.fill(); } }
    ctx.save(); ctx.translate(13, top + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(KIND[s.kind] || s.kind, 0, 0); ctx.restore();
    ctx.fillStyle = th.strong || th.text; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText(`${s.name} · ${n} points`, mL + pw - 6, top + 5);
    if (j === 0) {   // legend
      let lx = mL + 8; const ly = top + 5; ctx.textAlign = 'left';
      const item = (label, draw) => { draw(lx, ly + 6); ctx.fillStyle = th.text; ctx.fillText(label, lx + 22, ly); lx += 30 + ctx.measureText(label).width; };
      item('data', (x, y) => { ctx.fillStyle = th.data; ctx.beginPath(); ctx.arc(x + 8, y, 2.4, 0, 2 * Math.PI); ctx.fill(); });
      if (s.best) item('best fit', (x, y) => { ctx.strokeStyle = th.model; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 16, y); ctx.stroke(); });
      if (s.band) item('16 to 84% of the posterior', (x, y) => { ctx.fillStyle = hexA(th.post || th.model, 0.3); ctx.fillRect(x, y - 5, 16, 10); });
      if (s.truth) item('what was put in', (x, y) => { ctx.strokeStyle = th.star || th.warn; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 16, y); ctx.stroke(); ctx.setLineDash([]); });
    }
  });
  ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('wavelength (µm)', mL + pw / 2, H - 4);
  return each;
}
