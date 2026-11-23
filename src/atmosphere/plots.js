// Plots of the Atmosphere page: pure render functions (ctx, W, H, data, theme), so the screen and the exported
// PNG draw the same thing. Themes are those of the spectroscopy page.
import { niceTicks } from '../photometry/plots.js';
import { SPEC_THEME, SPEC_DARK, PRINT_THEME } from '../spectra/plots.js';
export { SPEC_THEME as ATM_THEME, SPEC_DARK as ATM_DARK, PRINT_THEME };

/** One colour per absorber, the same in every plot (chosen to stay apart on dark and light backgrounds). */
export const SPECIES_COLOURS = {
  H2O: '#4aa3ff', CO2: '#ff7a59', CO: '#f2c14e', CH4: '#5fd18b', NH3: '#c58cff', HCN: '#ff8fc7', SO2: '#d9d05a', H2S: '#9aa7b8',
  Na: '#ffb454', K: '#e06c9f', TiO: '#7fd6d0', VO: '#b0c46a', 'H-': '#a0a8ff', H2: '#8491ad', He: '#6b7890',
  CIA: '#8e9bb5', Rayleigh: '#7aa0c8', continuum: '#8e9bb5', haze: '#b79a7a', cloud: '#aaaaaa', particles: '#d9a066', total: null,
  H: '#e8e8e8', 'e-': '#ff5f5f', N2: '#3fc1c9', O2: '#74b9ff', FeH: '#c0843f', C2H2: '#9be564', PH3: '#f78fb3', O3: '#6c9bd2',
};
/** An ion (Na+, K+, H+) keeps its atom's colour and is drawn dashed. */
export const isIon = (name) => /\+$/.test(name);
export const colourOf = (name, th) => SPECIES_COLOURS[isIon(name) ? name.slice(0, -1) : name] || th.model;

const fmt = (v, step) => (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(0) : v.toFixed(Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) + 0.01)))));
const sup = (n) => String(n).replace(/[-0-9]/g, (c) => ({ '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }[c]));
/** Ticks of a logarithmic axis: decades (thinned to fit), labelled 10^n, or 1-2-5 within a span under two decades. */
function logTicks(lo, hi, n) {
  const a = Math.log10(lo), b = Math.log10(hi), out = [];
  if (b - a < 1.6) { for (let d = Math.floor(a); d <= Math.ceil(b); d++) for (const m of b - a < 0.7 ? [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 5, 7]) { const v = m * 10 ** d; if (v >= lo * 0.9999 && v <= hi * 1.0001) out.push([v, +v.toPrecision(3) + '']); } return out; }
  const step = Math.max(1, Math.ceil((b - a) / n));
  for (let d = Math.ceil(a - 1e-9); d <= b + 1e-9; d++) if (d % step === 0) out.push([10 ** d, Math.abs(d) <= 2 ? String(+(10 ** d).toPrecision(1)) : '10' + sup(d)]);
  return out;
}

/** Frame, grid, ticks and labels; returns the scales. a = { x0, x1, y0, y1, xLog, yLog, yFlip, xLabel, yLabel, title, mR } */
function axes(ctx, W, H, a, th) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const mL = a.mL ?? 58, mR = a.mR ?? 12, mT = a.mT ?? 22, mB = 32, pw = W - mL - mR, ph = H - mT - mB;
  const fx = a.xLog ? Math.log : (v) => v, fy = a.yLog ? Math.log : (v) => v;
  const X = (v) => mL + ((fx(v) - fx(a.x0)) / (fx(a.x1) - fx(a.x0))) * pw;
  const Y = (v) => { const u = (fy(v) - fy(a.y0)) / (fy(a.y1) - fy(a.y0)); return a.yFlip ? mT + u * ph : mT + ph - u * ph; };
  ctx.font = th.font; ctx.lineWidth = 1; ctx.strokeStyle = th.grid; ctx.fillStyle = th.text;
  const tx = a.xLog ? logTicks(a.x0, a.x1, Math.max(3, Math.floor(pw / 70))) : (() => { const t = niceTicks(a.x0, a.x1, Math.max(3, Math.floor(pw / 80))); return t.ticks.map((v) => [v, fmt(v, t.step)]); })();
  const ty = a.yLog ? logTicks(Math.min(a.y0, a.y1), Math.max(a.y0, a.y1), Math.max(3, Math.floor(ph / 30))) : (() => { const t = niceTicks(a.y0, a.y1, Math.max(2, Math.floor(ph / 34))); return t.ticks.map((v) => [v, fmt(v, t.step)]); })();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const [v, s] of tx) { const x = Math.round(X(v)) + 0.5; if (x < mL - 1 || x > mL + pw + 1) continue; ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke(); ctx.fillText(s, x, mT + ph + 4); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const [v, s] of ty) { const y = Math.round(Y(v)) + 0.5; if (y < mT - 1 || y > mT + ph + 1) continue; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke(); ctx.fillText(s, mL - 6, y); }
  ctx.strokeStyle = th.frame; ctx.strokeRect(mL + 0.5, mT + 0.5, pw, ph);
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; if (a.xLabel) ctx.fillText(a.xLabel, mL + pw / 2, H - 2);
  if (a.yLabel) { ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(a.yLabel, 0, 0); ctx.restore(); }
  return { X, Y, mL, mR, mT, mB, pw, ph };
}

/** Rows a legend of these names needs in `width` pixels (the names are set in the plot's 11 px font). */
function legendRows(ctx, names, width, th) {
  ctx.save(); ctx.font = th.font; let rows = 1, x = 0;
  for (const t of names) { const w = ctx.measureText(t).width + 10; if (x + w > width && x > 0) { rows++; x = 0; } x += w; }
  ctx.restore(); return rows;
}
/**
 * Title on the left of the top line, legend entries [[colour, text, dashed?], ...] on the right, wrapping onto as
 * many lines as they need (the caller leaves room: axes' mT). `hl`: the entry to pick out; the others are dimmed.
 * Returns the entries' boxes [{ name, x0, x1, y0, y1 }] for hit-testing.
 */
function topLine(ctx, s, title, legend, th, hl = null) {
  ctx.textBaseline = 'top'; ctx.textAlign = 'left'; const boxes = [], rows = [[]]; let x = 0;
  for (const e of legend) { const w = ctx.measureText(e[1]).width + 10; if (x + w > s.pw && x > 0) { rows.push([]); x = 0; } rows[rows.length - 1].push([e, w]); x += w; }
  let firstLeft = s.mL + s.pw;
  rows.forEach((row, r) => {
    const total = row.reduce((a, [, w]) => a + w, 0); let lx = s.mL + s.pw - total + 10; if (r === 0) firstLeft = lx;
    for (const [[c, t, dashed], w] of row) {
      const y = 5 + 13 * r, on = hl == null || hl === t;
      ctx.globalAlpha = on ? 1 : 0.35; ctx.fillStyle = c; ctx.font = (hl === t ? 'bold ' : '') + th.font; ctx.fillText(t, lx, y);
      if (dashed || hl === t) { ctx.strokeStyle = c; ctx.lineWidth = hl === t ? 1.5 : 1; if (dashed) ctx.setLineDash([3, 2]); ctx.beginPath(); ctx.moveTo(lx, y + 12.5); ctx.lineTo(lx + w - 10, y + 12.5); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; }
      boxes.push({ name: t, x0: lx - 3, x1: lx + w - 7, y0: y - 3, y1: y + 13 }); lx += w;
    }
  });
  ctx.globalAlpha = 1; ctx.font = th.font;
  if (title) { let t = title; const room = (rows.length > 1 ? s.pw - rows[0].reduce((a, [, w]) => a + w, 0) : firstLeft - s.mL) - 6; if (ctx.measureText(t).width > room) { while (t.length > 4 && ctx.measureText(t + '…').width > room) t = t.slice(0, -1); t += '…'; } ctx.fillStyle = th.strong; if (room > 30) ctx.fillText(t, s.mL, 5); }
  return boxes;
}
/**
 * What a plot of several named curves returns, so that the page can tell which curve is under the pointer:
 * pick(px, py) -> the name of the legend entry at that point, or of the curve passing within 9 pixels, or null.
 * curves: [{ name, x: [], y: [] }] in data units (as drawn); s: the scales of `axes`.
 */
function picker(s, curves, boxes) {
  return (px, py) => {
    for (const b of boxes) if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return b.name;
    if (px < s.mL - 2 || px > s.mL + s.pw + 2 || py < s.mT - 2 || py > s.mT + s.ph + 2) return null;
    let best = null, bd = 81;
    for (const c of curves) {
      let x0 = NaN, y0 = NaN;
      for (let i = 0; i < c.x.length; i++) {
        const x1 = s.X(c.x[i]), y1 = s.Y(c.y[i]);
        if (Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)) {   // distance to the segment
          const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy, t = L > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L)) : 0, ex = x0 + t * dx - px, ey = y0 + t * dy - py, dd = ex * ex + ey * ey;
          if (dd < bd) { bd = dd; best = c.name; }
        }
        x0 = x1; y0 = y1;
      }
    }
    return best;
  };
}
const clip = (ctx, s) => { ctx.save(); ctx.beginPath(); ctx.rect(s.mL, s.mT, s.pw, s.ph); ctx.clip(); };
function line(ctx, s, x, y, colour, width = 1.5, dash = null) {
  ctx.strokeStyle = colour; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash); ctx.beginPath();
  let pen = false;
  for (let i = 0; i < x.length; i++) { const px = s.X(x[i]), py = s.Y(y[i]); if (!Number.isFinite(py) || !Number.isFinite(px)) { pen = false; continue; } if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; } }
  ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
}

/**
 * The model spectrum against wavelength (log axis): the total and, behind it, the spectrum each absorber would give
 * alone. d = { wl, total, parts: [{ name, y }], unit: 'ppm' | '%' | ..., scale (multiplies y), yLabel, title,
 *              data?: [{ wl, lo, hi, y, err }] (observed points in the same unit, before scaling), range?: [lo, hi],
 *              highlight?: name of the curve to pick out ('all' for the total) }. Returns { pick(px, py), names }.
 */
export function renderModelSpectrum(ctx, W, H, d, th = SPEC_THEME) {
  const k = d.scale ?? 1, x0 = d.range ? d.range[0] : d.wl[0], x1 = d.range ? d.range[1] : d.wl[d.wl.length - 1], hl = d.highlight ?? null;
  let y0 = Infinity, y1 = -Infinity;
  const span = (y) => { for (let i = 0; i < d.wl.length; i++) if (d.wl[i] >= x0 && d.wl[i] <= x1 && Number.isFinite(y[i])) { y0 = Math.min(y0, y[i] * k); y1 = Math.max(y1, y[i] * k); } };
  span(d.total); for (const p of d.parts || []) span(p.y);
  for (const r of d.data || []) { y0 = Math.min(y0, (r.y - r.err) * k); y1 = Math.max(y1, (r.y + r.err) * k); }
  if (!(y1 > y0)) { y0 = 0; y1 = 1; }
  const pad = (y1 - y0) * 0.06; y0 -= pad; y1 += pad;
  const names = [...(d.parts || []).map((p) => p.name), 'all'], mT = 9 + 13 * legendRows(ctx, [d.title || '', ...names], W - 70, th);
  const s = axes(ctx, W, H, { mT, x0, x1, y0, y1, xLog: true, xLabel: 'wavelength (micron)', yLabel: d.yLabel }, th);
  clip(ctx, s);
  // only the plotted range is kept for drawing and for picking a curve under the pointer
  const keep = []; for (let i = 0; i < d.wl.length; i++) if (d.wl[i] >= x0 && d.wl[i] <= x1) keep.push(i);
  const cut = (y, f = 1) => keep.map((i) => y[i] * f), wl = cut(d.wl);
  const curves = [...(d.parts || []).map((p) => ({ name: p.name, x: wl, y: cut(p.y, k), colour: colourOf(p.name, th), w: 1 })), { name: 'all', x: wl, y: cut(d.total, k), colour: th.strong, w: 1.6 }];
  for (const c of curves) { if (c.name === hl) continue; ctx.globalAlpha = hl ? 0.2 : c.name === 'all' ? 1 : 0.85; line(ctx, s, c.x, c.y, c.colour, c.w); }
  ctx.globalAlpha = 1; const top = curves.find((c) => c.name === hl); if (top) line(ctx, s, top.x, top.y, top.colour, 2.4);
  if (d.data) { ctx.strokeStyle = th.star; ctx.fillStyle = th.star; for (const r of d.data) { const x = s.X(r.wl), y = s.Y(r.y * k); ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(x, s.Y((r.y - r.err) * k)); ctx.lineTo(x, s.Y((r.y + r.err) * k)); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillRect(x - 1.5, y - 1.5, 3, 3); } }
  ctx.restore();
  const boxes = topLine(ctx, s, d.title, [...curves.map((c) => [c.colour, c.name]), ...(d.data ? [[th.star, d.dataLabel || 'data']] : [])], th, names.includes(hl) ? hl : null);
  return { pick: picker(s, curves, boxes), names };
}

/**
 * Temperature against pressure, pressure increasing downward. d = { p [bar], t [K], title, marks?: [{ p, label }],
 * extra?: [{ t, colour, label }] more profiles on the same pressures, label?: name of the main one,
 * weight?: Float64Array per layer (shaded as a horizontal profile on the right: where the spectrum comes from) }
 */
export function renderProfile(ctx, W, H, d, th = SPEC_THEME) {
  const allT = [d.t, ...(d.extra || []).map((e) => e.t)].flat(); let t0 = Math.min(...allT), t1 = Math.max(...allT); const pad = Math.max(40, (t1 - t0) * 0.08); t0 = Math.max(0, t0 - pad); t1 += pad;
  const s = axes(ctx, W, H, { x0: t0, x1: t1, y0: d.p[0], y1: d.p[d.p.length - 1], yLog: true, yFlip: true, xLabel: 'temperature (K)', yLabel: 'pressure (bar)' }, th);
  clip(ctx, s);
  if (d.weight) {
    const m = Math.max(...d.weight) || 1; ctx.fillStyle = th.post; ctx.globalAlpha = 0.28; ctx.beginPath(); ctx.moveTo(s.mL + s.pw, s.Y(d.p[0]));
    for (let i = 0; i < d.p.length; i++) ctx.lineTo(s.mL + s.pw - (d.weight[i] / m) * s.pw * 0.45, s.Y(d.p[i]));
    ctx.lineTo(s.mL + s.pw, s.Y(d.p[d.p.length - 1])); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  }
  for (const e of d.extra || []) line(ctx, s, e.t, d.p, e.colour, 1.2);
  line(ctx, s, d.t, d.p, th.model, 1.8);
  for (const mk of d.marks || []) { const y = Math.round(s.Y(mk.p)) + 0.5; ctx.strokeStyle = th.star; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(s.mL, y); ctx.lineTo(s.mL + s.pw, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = th.star; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(mk.label, s.mL + 4, y - 2); }
  ctx.restore();
  topLine(ctx, s, d.title, [[th.model, d.label || 'T(P)'], ...(d.extra || []).map((e) => [e.colour, e.label]), ...(d.weight ? [[th.post, d.weightLabel || 'contribution']] : [])], th);
}

/** Mixing ratios against pressure. d = { p [bar], species: [{ name, x: per layer }], title, floor = 1e-10 } */
export function renderMixing(ctx, W, H, d, th = SPEC_THEME) {
  const floor = d.floor ?? 1e-10, hl = d.highlight ?? null;
  // only what is there: a gas that never rises above the floor of the axis is left out of the plot and of the legend
  const shown = d.species.filter((sp) => Array.from(sp.x).some((v) => v > floor)), names = shown.map((sp) => sp.name);
  const mT = 9 + 13 * legendRows(ctx, [d.title || '', ...names], W - 70, th);
  const s = axes(ctx, W, H, { mT, x0: floor, x1: 1.5, xLog: true, y0: d.p[0], y1: d.p[d.p.length - 1], yLog: true, yFlip: true, xLabel: 'volume mixing ratio', yLabel: 'pressure (bar)' }, th);
  const curves = shown.map((sp) => ({ name: sp.name, x: Array.from(sp.x, (v) => Math.max(v, floor * 1e-3)), y: d.p }));
  clip(ctx, s);
  for (const c of curves) { if (c.name === hl) continue; ctx.globalAlpha = hl ? 0.22 : 1; line(ctx, s, c.x, c.y, colourOf(c.name, th), 1.6, isIon(c.name) ? [5, 3] : null); }
  ctx.globalAlpha = 1; const top = curves.find((c) => c.name === hl); if (top) line(ctx, s, top.x, top.y, colourOf(top.name, th), 2.8, isIon(top.name) ? [6, 3] : null);
  ctx.restore();
  const boxes = topLine(ctx, s, d.title, shown.map((sp) => [colourOf(sp.name, th), sp.name, isIon(sp.name)]), th, names.includes(hl) ? hl : null);
  return { pick: picker(s, curves, boxes), names };
}

/**
 * Extinction of one layer against wavelength, by absorber: d = { wl, parts: [{ name, y [m^-1] }], total, title }.
 * Shown as an optical depth per scale height or any other unit through d.scale and d.yLabel.
 * d.highlight: the name of the curve to pick out ('all' for the total). Returns { pick(px, py), names }.
 */
export function renderOpacity(ctx, W, H, d, th = SPEC_THEME) {
  const k = d.scale ?? 1, hl = d.highlight ?? null; let y1 = 0;
  for (const v of d.total) if (v * k > y1) y1 = v * k;
  if (!(y1 > 0)) y1 = 1;
  // d.yRange: [lo, hi] holds the axis still while the layer or the model changes (values below lo sit on the floor)
  const y0 = d.yRange ? d.yRange[0] : y1 * (d.decades ? 10 ** -d.decades : 1e-8), yTop = d.yRange ? d.yRange[1] : y1 * 3;
  // an absorber that stays under the floor of the axis everywhere shown is left out of the plot and of the legend
  const parts = d.parts.filter((p) => Array.from(p.y).some((v) => v * k > y0)), names = [...parts.map((p) => p.name), 'all'];
  const mT = 9 + 13 * legendRows(ctx, [d.title || '', ...names], W - 70, th);
  // d.xRange, d.xLinear, d.xLabel, d.mR: to line the plot up with another one (the colour figure: nanometres, linear, 380 to 750)
  const s = axes(ctx, W, H, { mT, mR: d.mR, x0: d.xRange ? d.xRange[0] : d.wl[0], x1: d.xRange ? d.xRange[1] : d.wl[d.wl.length - 1], xLog: !d.xLinear, y0, y1: yTop, yLog: true, xLabel: d.xLabel || 'wavelength (micron)', yLabel: d.yLabel || 'extinction (1/m)' }, th);
  clip(ctx, s);
  const sc = (y) => Array.from(y, (v) => Math.min(Math.max(v * k, d.yRange ? y0 : y0 * 1e-3), d.yRange ? yTop : Infinity));
  if (d.yRange && d.mark > y0 && d.mark < yTop) { const y = Math.round(s.Y(d.mark)) + 0.5; ctx.strokeStyle = th.star; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(s.mL, y); ctx.lineTo(s.mL + s.pw, y); ctx.stroke(); ctx.setLineDash([]); }
  const curves = [...parts.map((p) => ({ name: p.name, x: d.wl, y: sc(p.y), colour: colourOf(p.name, th), w: 1.1 })), { name: 'all', x: d.wl, y: sc(d.total), colour: th.strong, w: 1.4 }];
  for (const c of curves) { if (c.name === hl) continue; ctx.globalAlpha = hl ? 0.22 : 1; line(ctx, s, c.x, c.y, c.colour, c.w); }
  ctx.globalAlpha = 1; const top = curves.find((c) => c.name === hl); if (top) line(ctx, s, top.x, top.y, top.colour, 2.4);
  ctx.restore();
  const boxes = topLine(ctx, s, d.title, curves.map((c) => [c.colour, c.name]), th, names.includes(hl) ? hl : null);
  return { pick: picker(s, curves, boxes), names };
}

/**
 * How a spectrum becomes a colour, on two axes. Left: the three colour-matching functions of the CIE 1931 observer
 * (what each "channel" of the eye weighs the light with), shaded. Right: the light itself, per unit wavelength: the
 * planet's reflected starlight, its own thermal glow and their sum on one scale (the largest value of the sum = 1), and
 * the star's spectrum scaled to its own peak (it is brighter by many orders of magnitude).
 * d = { nm: [], cmf: { x: [], y: [], z: [] }, star: [], reflected: [], thermal: [], total: [], title }
 */
export function renderColourResponse(ctx, W, H, d, th = SPEC_THEME) {
  const band = [['z', '#5b8cff', 'z̄ blue'], ['y', '#55c46a', 'ȳ green'], ['x', '#ff6b5b', 'x̄ red']];
  const light = [['star', '#ffd27f', 'star (own scale)', [2, 3], 1.4], ['reflected', '#7fd6ff', 'planet: reflected', null, 1.5], ['thermal', '#ff9d5c', 'planet: thermal', [6, 3], 1.5], ['total', th.strong, 'planet: total', null, 2.2]];
  const names = [...band.map((x) => x[2]), ...light.map((x) => x[2])], mT = 9 + 13 * legendRows(ctx, [d.title || '', ...names], W - 110, th);
  const s = axes(ctx, W, H, { mT, mR: 62, x0: d.nm[0], x1: d.nm[d.nm.length - 1], y0: 0, y1: 1.9, xLabel: 'wavelength (nm)', yLabel: 'response of the eye' }, th);
  // the right-hand axis: relative flux, 0 to 1.1
  const top = 1.1, YR = (v) => s.mT + s.ph * (1 - Math.max(0, v) / top), xr = s.mL + s.pw;
  ctx.fillStyle = th.text; ctx.strokeStyle = th.grid; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) { const y = Math.round(YR(v)) + 0.5; ctx.beginPath(); ctx.moveTo(xr, y); ctx.lineTo(xr + 4, y); ctx.stroke(); ctx.fillText(String(v), xr + 7, y); }
  ctx.save(); ctx.translate(W - 6, s.mT + s.ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('light (largest = 1)', 0, 0); ctx.restore();
  clip(ctx, s);
  for (const [k, c] of band) {   // filled, so that the overlap with the light reads at a glance
    ctx.fillStyle = c; ctx.globalAlpha = 0.15; ctx.beginPath(); ctx.moveTo(s.X(d.nm[0]), s.Y(0)); for (let i = 0; i < d.nm.length; i++) ctx.lineTo(s.X(d.nm[i]), s.Y(d.cmf[k][i])); ctx.lineTo(s.X(d.nm[d.nm.length - 1]), s.Y(0)); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.9; line(ctx, s, d.nm, d.cmf[k], c, 1.1);
  }
  ctx.globalAlpha = 1;
  const peak = (y) => { let m = 0; for (const v of y || []) if (v > m) m = v; return m; }, pTot = peak(d.total), pStar = peak(d.star), right = { ...s, Y: YR };
  for (const [k, c, , dash, w] of light) { const y = d[k]; if (!y) continue; const m = k === 'star' ? pStar : pTot; if (!(m > 0) || !(peak(y) > 0)) continue; line(ctx, right, d.nm, Array.from(y, (v) => v / m), c, w, dash); }
  ctx.restore();
  topLine(ctx, s, d.title, [...band.map(([, c, t]) => [c, t]), ...light.filter(([k]) => d[k] && peak(d[k]) > 0).map(([, c, t, dash]) => [c, t, !!dash])], th);
}

// a perceptually ordered ramp, dark blue to yellow (the one of the spectroscopy page's image)
const RAMP = [[13, 8, 60], [44, 62, 140], [32, 128, 141], [94, 201, 98], [253, 231, 37]];
export function ramp(u) { const x = Math.min(0.9999, Math.max(0, u)) * 4, i = Math.floor(x), f = x - i, a = RAMP[i], b = RAMP[i + 1]; return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]; }

/**
 * A map over wavelength (x, log) and pressure (y, log, increasing downward): the transmittance of the limb, or the
 * contribution function of the emission. d = { wl, p [bar, nP values], z: Float32Array(nWl * nP) row per wavelength,
 * title, label, lo = 0, hi = max, line?: per-wavelength pressure to draw (for example where the chord optical depth is 1) }
 */
export function renderMap(ctx, W, H, d, th = SPEC_THEME) {
  const nW = d.wl.length, nP = d.p.length;
  const s = axes(ctx, W, H, { x0: d.wl[0], x1: d.wl[nW - 1], xLog: true, y0: d.p[0], y1: d.p[nP - 1], yLog: true, yFlip: true, xLabel: 'wavelength (micron)', yLabel: 'pressure (bar)', mR: 58 }, th);
  const pw = Math.max(2, Math.round(s.pw)), ph = Math.max(2, Math.round(s.ph));
  let hi = d.hi; if (hi == null) { hi = 0; for (const v of d.z) if (v > hi) hi = v; } const lo = d.lo ?? 0;
  const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(ctx.canvas.ownerDocument.createElement('canvas'), { width: pw, height: ph });
  const g = off.getContext('2d'), im = g.createImageData(pw, ph), px = im.data;
  const lw = Math.log(d.wl[nW - 1] / d.wl[0]), lp = Math.log(d.p[nP - 1] / d.p[0]);
  // both axes are uniform in the logarithm, so a pixel maps to an index directly
  for (let y = 0; y < ph; y++) {
    const j = Math.min(nP - 1, Math.max(0, Math.round(((y + 0.5) / ph) * (nP - 1))));
    for (let x = 0; x < pw; x++) {
      const ia = Math.floor((x / pw) * (nW - 1)), ib = Math.max(ia + 1, Math.floor(((x + 1) / pw) * (nW - 1)));
      let v = 0, n = 0; for (let i = ia; i < ib && i < nW; i++) { v += d.z[i * nP + j]; n++; }
      const c = ramp((v / (n || 1) - lo) / (hi - lo || 1)), q = (y * pw + x) * 4; px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
    }
  }
  void lw; void lp;
  g.putImageData(im, 0, 0); ctx.drawImage(off, s.mL, s.mT);
  ctx.strokeStyle = th.frame; ctx.strokeRect(s.mL + 0.5, s.mT + 0.5, s.pw, s.ph);
  if (d.line) { clip(ctx, s); line(ctx, s, d.wl, d.line, '#ffffff', 1.1); ctx.restore(); }
  const bx = s.mL + s.pw + 10, bw = 8;
  for (let y = 0; y < ph; y++) { const c = ramp(1 - y / ph); ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; ctx.fillRect(bx, s.mT + y, bw, 1.5); }
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(fmt(hi, hi / 10), bx + bw + 3, s.mT);
  ctx.textBaseline = 'bottom'; ctx.fillText(fmt(lo, (hi - lo) / 10 || 1), bx + bw + 3, s.mT + ph);
  topLine(ctx, s, d.title, d.line ? [['#ffffff', d.lineLabel || '']].filter((x) => x[1]) : [], th);
  if (d.label) { ctx.save(); ctx.fillStyle = th.text; ctx.translate(W - 6, s.mT + ph / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(d.label, 0, 0); ctx.restore(); }
}
