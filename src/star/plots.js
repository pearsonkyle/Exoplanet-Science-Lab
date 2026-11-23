// The Star page's figure: a pure render function (ctx, W, H, data, theme), so screen and export draw the same thing.
import { SPEC_THEME } from '../spectra/plots.js';

const sup = (n) => String(n).replace(/[-0-9]/g, (c) => ({ '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }[c]));
export const SURVEY_COLOURS = { gaia: '#5fd18b', '2mass': '#ff7a59', wise: '#e06c9f', tycho: '#4aa3ff', galex: '#c58cff', sdss: '#f2c14e', ps1: '#d9d05a', johnson: '#7fd6d0', apass: '#9aa7b8', tess: '#ffb454' };

/**
 * The spectral energy distribution, lambda F_lambda against wavelength (both logarithmic), and the residuals in
 * magnitudes underneath.
 * d = { wl: [], flux: [] (model spectrum at the observer, W m^-2 micron^-1), title,
 *       points: [{ band, survey, wl (pivot), obs, lo, hi (observed lambda F_lambda and its error bar), model, residual (mag), err (mag), used }] }
 */
export function renderSed(ctx, W, H, d, th = SPEC_THEME) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H); ctx.font = th.font;
  const mL = 62, mR = 14, mT = 24, mB = 34, gap = 10, hRes = Math.max(60, Math.round(0.24 * (H - mT - mB))), ph = H - mT - mB - hRes - gap, pw = W - mL - mR;
  const xs = d.points.map((p) => p.wl), x0 = Math.min(0.2, ...xs.map((v) => v * 0.7)), x1 = Math.max(6, ...xs.map((v) => v * 1.4));
  const X = (v) => mL + (Math.log(v / x0) / Math.log(x1 / x0)) * pw;
  let yMax = 0; for (const p of d.points) { if (p.obs > yMax) yMax = p.obs; if (p.model > yMax) yMax = p.model; } if (d.wl) for (let i = 0; i < d.wl.length; i++) if (d.wl[i] >= x0 && d.wl[i] <= x1) yMax = Math.max(yMax, d.wl[i] * d.flux[i]);
  if (!(yMax > 0)) yMax = 1; const y1 = yMax * 2.2, y0 = y1 * 1e-4, Y = (v) => mT + (1 - Math.log(Math.max(v, y0 * 1e-3) / y0) / Math.log(y1 / y0)) * ph;
  ctx.strokeStyle = th.grid; ctx.fillStyle = th.text; ctx.lineWidth = 1; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  for (const v of [0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30]) { if (v < x0 || v > x1) continue; const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.moveTo(x, mT + ph + gap); ctx.lineTo(x, mT + ph + gap + hRes); ctx.stroke(); ctx.fillText(String(v), x, H - mB + 5); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let e = Math.ceil(Math.log10(y0)); e <= Math.log10(y1); e++) { const y = Math.round(Y(10 ** e)) + 0.5; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke(); ctx.fillText('10' + sup(e), mL - 6, y); }
  ctx.strokeRect(mL + 0.5, mT + 0.5, pw, ph); ctx.strokeRect(mL + 0.5, mT + ph + gap + 0.5, pw, hRes);
  // the model spectrum
  if (d.wl) { ctx.save(); ctx.beginPath(); ctx.rect(mL, mT, pw, ph); ctx.clip(); ctx.strokeStyle = th.model; ctx.lineWidth = 1.2; ctx.beginPath(); let pen = false; for (let i = 0; i < d.wl.length; i++) { if (d.wl[i] < x0 || d.wl[i] > x1) continue; const x = X(d.wl[i]), y = Y(d.wl[i] * d.flux[i]); if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; } } ctx.stroke(); ctx.restore(); }
  // residual panel
  const rMax = Math.max(0.1, ...d.points.filter((p) => p.used).map((p) => Math.abs(p.residual) + p.err)) * 1.15, RY = (v) => mT + ph + gap + (0.5 - v / (2 * rMax)) * hRes;
  ctx.strokeStyle = th.star || th.text; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(mL, Math.round(RY(0)) + 0.5); ctx.lineTo(mL + pw, Math.round(RY(0)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = th.text; ctx.textAlign = 'right'; for (const v of [-rMax / 1.15, 0, rMax / 1.15]) ctx.fillText((v > 0 ? '+' : '') + v.toFixed(2), mL - 6, RY(v));
  for (const p of d.points) {
    const c = SURVEY_COLOURS[p.survey] || th.strong, x = X(p.wl); ctx.globalAlpha = p.used ? 1 : 0.35;
    ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, Y(p.lo)); ctx.lineTo(x, Y(p.hi)); ctx.stroke();
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, Y(p.obs), 3.6, 0, 2 * Math.PI); ctx.fill();
    if (!p.used) continue;   // a band left out of the fit has no model point and no residual
    ctx.strokeStyle = th.strong; ctx.lineWidth = 1.2; ctx.strokeRect(x - 4.5, Y(p.model) - 4.5, 9, 9);
    ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(x, RY(p.residual - p.err)); ctx.lineTo(x, RY(p.residual + p.err)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, RY(p.residual), 3, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('wavelength (micron)', mL + pw / 2, H - 4);
  ctx.save(); ctx.translate(13, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('λ F_λ (W/m²)', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(13, mT + ph + gap + hRes / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('obs − model (mag)', 0, 0); ctx.restore();
  ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillStyle = th.strong; if (d.title) ctx.fillText(d.title, mL, 6);
  ctx.textAlign = 'right'; let lx = mL + pw; for (const s of [...new Set(d.points.map((p) => p.survey))].reverse()) { ctx.fillStyle = SURVEY_COLOURS[s] || th.strong; ctx.fillText(s, lx, 6); lx -= ctx.measureText(s).width + 10; }
  ctx.fillStyle = th.text; ctx.fillText('● measured   □ model   ', lx, 6);
}
