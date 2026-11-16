// Phase-curve figures: the light curve over an orbit with its eclipse and transit, the planet's
// brightness or temperature map (longitude-latitude and a globe), and temperature against orbital
// phase with the hemisphere that faces the observer. Pure drawing routines taking a theme from
// LC_THEMES, like renderLightCurve() and renderRV(): screen, exported figures and the movie share them.
// Only canvas 2D calls that respect the current transform are used (no putImageData), so a scaled
// export context draws the same picture.
//
// phasePlotData(), mapPlotData() and temperaturePlotData() build the data objects from model
// parameters with src/core/phasecurve.js; the render functions themselves do no science.

import { niceTicks, decimals, groupColor } from './lightcurve.js';
import { makePhaseCurve, phaseSummary, temperatureMap, brightnessTemperature } from '../core/phasecurve.js';
import { eventTimes } from '../core/kepler.js';

const DEG = Math.PI / 180;

// ---- colour ------------------------------------------------------------------------------------
// "inferno" (matplotlib, CC0), 11 stops; perceptually ordered and readable on white and on dark.
const INFERNO = [[0, 0, 4], [22, 11, 57], [66, 10, 104], [106, 23, 110], [147, 38, 103], [188, 55, 84], [221, 81, 58], [243, 120, 25], [252, 165, 10], [246, 215, 70], [252, 255, 164]];
/** CSS colour of a value in [0, 1] on the map's colour scale. */
export function heatColor(u) {
  if (!(u >= 0)) u = 0; if (u > 1) u = 1;
  const x = u * (INFERNO.length - 1), i = Math.min(INFERNO.length - 2, Math.floor(x)), f = x - i, a = INFERNO[i], b = INFERNO[i + 1];
  return `rgb(${Math.round(a[0] + f * (b[0] - a[0]))},${Math.round(a[1] + f * (b[1] - a[1]))},${Math.round(a[2] + f * (b[2] - a[2]))})`;
}
const LUT = Array.from({ length: 256 }, (_, i) => heatColor(i / 255));
const lut = (v, lo, hi) => (Number.isFinite(v) ? LUT[Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo || 1)) * 255)))] : null);
const NEG = (th) => (th.frame ? '#c8c8c8' : '#2a3142');      // cells where the map is negative (no temperature)

function mapValue(m, lat, lon) {
  let j = Math.floor(((((lon + 180) % 360) + 360) % 360) / 360 * m.nlon), i = Math.floor(((lat + 90) / 180) * m.nlat);
  if (i < 0) i = 0; if (i >= m.nlat) i = m.nlat - 1; if (j >= m.nlon) j = m.nlon - 1;
  return m.values[i * m.nlon + j];
}

/**
 * Orthographic globe of a map. cx, cy, R in canvas units.
 * m: { nlat, nlon, values (row = latitude from south, column = longitude from -180), vmin, vmax }
 * view: { lon0, lat0 } sub-observer longitude and latitude in degrees (lon0 = -phase from eclipse, lat0 = 90 - inclination)
 * o: { cell (px, default R/24 clamped to 1.5..4), graticule (bool), substellar (bool: mark longitude 0), night (bool: shade beyond the terminator) }
 */
export function drawGlobe(ctx, cx, cy, R, m, view, th, o = {}) {
  const lo = view.lon0 * DEG, la = view.lat0 * DEG;
  // observer, screen-up and screen-right in the planet's frame (east, north, substellar)
  const ob = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  let up = [-ob[1] * ob[0], 1 - ob[1] * ob[1], -ob[1] * ob[2]]; const un = Math.hypot(...up) || 1; up = up.map((x) => x / un);
  const rt = [up[1] * ob[2] - up[2] * ob[1], up[2] * ob[0] - up[0] * ob[2], up[0] * ob[1] - up[1] * ob[0]];
  const cell = o.cell || Math.max(1.5, Math.min(4, R / 24)), n = Math.ceil(R / cell);
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.clip();
  for (let iy = -n; iy < n; iy++) for (let ix = -n; ix < n; ix++) {
    const x = ((ix + 0.5) * cell) / R, y = -((iy + 0.5) * cell) / R, r2 = x * x + y * y;
    if (r2 > 1.08) continue;
    const z = Math.sqrt(Math.max(0, 1 - Math.min(r2, 1))), k = r2 > 1 ? 1 / Math.sqrt(r2) : 1;
    const be = k * (x * rt[0] + y * up[0]) + z * ob[0], bn = k * (x * rt[1] + y * up[1]) + z * ob[1], bs = k * (x * rt[2] + y * up[2]) + z * ob[2];
    const c = lut(mapValue(m, Math.asin(Math.max(-1, Math.min(1, bn))) / DEG, Math.atan2(be, bs) / DEG), m.vmin, m.vmax);
    ctx.fillStyle = c || NEG(th); ctx.fillRect(cx + ix * cell - 0.3, cy + iy * cell - 0.3, cell + 0.6, cell + 0.6);
  }
  const proj = (lat, lon) => { const cl = Math.cos(lat * DEG), b = [cl * Math.sin(lon * DEG), Math.sin(lat * DEG), cl * Math.cos(lon * DEG)]; return [b[0] * rt[0] + b[1] * rt[1] + b[2] * rt[2], b[0] * up[0] + b[1] * up[1] + b[2] * up[2], b[0] * ob[0] + b[1] * ob[1] + b[2] * ob[2]]; };
  const line = (pts) => { let pen = false; ctx.beginPath(); for (const [x, y, z] of pts) { if (z < 0) { pen = false; continue; } const px = cx + x * R, py = cy - y * R; if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true; } ctx.stroke(); };
  if (o.graticule !== false && R > 22) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.7;
    for (let L = -150; L <= 180; L += 30) line(Array.from({ length: 61 }, (_, i) => proj(-90 + 3 * i, L)));
    for (let B = -60; B <= 60; B += 30) line(Array.from({ length: 121 }, (_, i) => proj(B, -180 + 3 * i)));
  }
  if (o.night) { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); line(Array.from({ length: 61 }, (_, i) => proj(-90 + 3 * i, 90))); line(Array.from({ length: 61 }, (_, i) => proj(-90 + 3 * i, -90))); ctx.setLineDash([]); }
  if (o.substellar) { const s = proj(0, 0); if (s[2] > 0) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; const px = cx + s[0] * R, py = cy - s[1] * R, a = Math.max(3, R / 14); ctx.beginPath(); ctx.moveTo(px - a, py); ctx.lineTo(px + a, py); ctx.moveTo(px, py - a); ctx.lineTo(px, py + a); ctx.stroke(); } }
  if (o.hotspot) { const s = proj(o.hotspot.lat, o.hotspot.lon); if (s[2] > 0) { ctx.strokeStyle = th.frame ? '#000' : '#fff'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(cx + s[0] * R, cy - s[1] * R, Math.max(3, R / 18), 0, 6.3); ctx.stroke(); } }
  ctx.restore();
  ctx.strokeStyle = th.frame || th.text; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
}

function colorBar(ctx, x, y, w, h, m, th, F, label) {
  const n = 64; for (let i = 0; i < n; i++) { ctx.fillStyle = LUT[Math.round((i / (n - 1)) * 255)]; ctx.fillRect(x, y + h - ((i + 1) * h) / n, w, h / n + 0.6); }
  ctx.strokeStyle = th.frame || th.text; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const tk = niceTicks(m.vmin, m.vmax, Math.max(2, Math.floor(h / 34)));
  ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const v of tk) { const yy = y + h - ((v - m.vmin) / (m.vmax - m.vmin)) * h; ctx.beginPath(); ctx.moveTo(x + w, yy); ctx.lineTo(x + w + 3, yy); ctx.stroke(); ctx.fillText(v.toFixed(decimals(tk.step)), x + w + 6, yy); }
  if (label) { ctx.save(); ctx.translate(x - 6, y + h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(label, 0, 0); ctx.restore(); }
}

// ---- (a) phase curve ---------------------------------------------------------------------------------

/**
 * Full-orbit phase curve with zooms on the eclipse and the transit.
 * d: { x[], y[], e[] | null       data: orbital phase from mid-transit in [-0.25, 0.75), flux relative to the star (1 = star alone)
 *      group: Int32Array | null   observation index of each point (colours)
 *      bins: { x[], y[], e[] } | null   binned data (drawn on top)
 *      model: { x[], y[] }        the full model on a fine phase grid over [-0.25, 0.75]
 *      planet: { x[], y[] }       1 + unocculted planet flux (the phase-curve component, dashed)
 *      eclipse: [x0, x1], transit: [x0, x1]   phase ranges of the two zoom panels
 *      depth, night               eclipse depth and flux at mid-transit phase (relative flux), for the annotations
 *      label, info: [strings] }
 * opt: { fontScale, title, ptAlpha, modelAlpha, bins (bool), color (bool), groups: [names] }
 * All flux axes are in ppm above the star alone.
 */
export function renderPhaseCurve(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, R = 16, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k, gapY = 26 + 14 * k, gapX = 58 + 14 * k;
  ctx.font = `${F(11)}px ${th.font}`; ctx.lineWidth = 1;
  if (!d || !d.model || !d.model.x.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText((d && d.label) || 'No phase curve', W / 2, H / 2); return null; }
  const hTop = (H - T - B - gapY) * 0.56, hBot = H - T - B - gapY - hTop, yB0 = T + hTop + gapY, wB = (W - L - R - gapX) / 2;
  const ppm = (v) => (v - 1) * 1e6, pa = opt.ptAlpha ?? 0.5, ma = opt.modelAlpha ?? 1, has = d.x && d.x.length;
  const col = (g) => (opt.color === false || !d.group ? null : groupColor(th, g));

  // one panel: axes, data, model. yr = [lo, hi] in ppm
  const panel = (px0, py0, pw, ph, xr, yr, o) => {
    const X = (x) => px0 + ((x - xr[0]) / (xr[1] - xr[0])) * pw, Y = (v) => py0 + (1 - (v - yr[0]) / (yr[1] - yr[0])) * ph;
    const xt = niceTicks(xr[0], xr[1], Math.max(2, Math.floor(pw / (70 * k + 16)))), yt = niceTicks(yr[0], yr[1], Math.max(2, Math.floor(ph / 34)));
    ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineWidth = 1;
    for (const v of xt) { const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py0 + ph); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py0 + ph + 5); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px0 + pw, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
    ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, pw, ph); ctx.clip();
    if (yr[0] < 0 && yr[1] > 0) { ctx.strokeStyle = th.text; ctx.globalAlpha = 0.45; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(px0, Y(0)); ctx.lineTo(px0 + pw, Y(0)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    if (has) {
      const sz = o.big ? 2.2 : 1.7;
      if (o.errs && d.e) { ctx.globalAlpha = Math.min(1, pa * 0.6); ctx.lineWidth = 1; for (let i = 0; i < d.x.length; i++) { if (d.x[i] < xr[0] || d.x[i] > xr[1]) continue; ctx.strokeStyle = col(d.group ? d.group[i] : 0) || th.err || th.data; const x = X(d.x[i]); ctx.beginPath(); ctx.moveTo(x, Y(ppm(d.y[i] - d.e[i]))); ctx.lineTo(x, Y(ppm(d.y[i] + d.e[i]))); ctx.stroke(); } }
      ctx.globalAlpha = Math.min(1, pa * (d.group && opt.color !== false ? 1.3 : 1.6));
      for (let i = 0; i < d.x.length; i++) { if (d.x[i] < xr[0] || d.x[i] > xr[1]) continue; ctx.fillStyle = col(d.group ? d.group[i] : 0) || th.data; ctx.fillRect(X(d.x[i]) - sz / 2, Y(ppm(d.y[i])) - sz / 2, sz, sz); }
      ctx.globalAlpha = 1;
    }
    if (d.planet && o.component !== false) { ctx.strokeStyle = th.model; ctx.globalAlpha = 0.75 * ma; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]); ctx.beginPath(); d.planet.x.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(ppm(d.planet.y[i]))) : ctx.moveTo(X(x), Y(ppm(d.planet.y[i]))))); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    if (ma > 0) { ctx.strokeStyle = th.model; ctx.globalAlpha = ma; ctx.lineWidth = 1.8; ctx.beginPath(); let pen = false; for (let i = 0; i < d.model.x.length; i++) { const x = d.model.x[i]; if (x < xr[0] - 0.01 || x > xr[1] + 0.01) { pen = false; continue; } if (pen) ctx.lineTo(X(x), Y(ppm(d.model.y[i]))); else ctx.moveTo(X(x), Y(ppm(d.model.y[i]))); pen = true; } ctx.stroke(); ctx.globalAlpha = 1; }
    if (d.bins && opt.bins !== false) for (let i = 0; i < d.bins.x.length; i++) {
      const x = d.bins.x[i]; if (x < xr[0] || x > xr[1]) continue;
      ctx.strokeStyle = th.title; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.moveTo(X(x), Y(ppm(d.bins.y[i] - d.bins.e[i]))); ctx.lineTo(X(x), Y(ppm(d.bins.y[i] + d.bins.e[i]))); ctx.stroke();
      ctx.fillStyle = th.bin; ctx.beginPath(); ctx.arc(X(x), Y(ppm(d.bins.y[i])), o.big ? 3.2 : 2.6, 0, 6.3); ctx.fill(); if (th.frame) ctx.stroke();
    }
    ctx.restore();
    if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1); }
    ctx.fillStyle = th.title; ctx.font = `${F(11)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; if (o.tag) ctx.fillText(o.tag, px0 + 8, py0 + 6);
    return { X, Y };
  };
  // ranges: the top panel follows the planet's light and lets the transit run off the bottom
  let pmax = 0, pmin = Infinity; for (const v of d.planet ? d.planet.y : d.model.y) { pmax = Math.max(pmax, ppm(v)); pmin = Math.min(pmin, ppm(v)); }
  let noise = 0; if (d.bins && d.bins.e.length) noise = 1e6 * d.bins.e.reduce((a, b) => a + b, 0) / d.bins.e.length; else if (has && d.e) noise = 0.15e6 * d.e.reduce((a, b) => a + b, 0) / d.e.length;
  const span = Math.max(pmax, 1e-3), top = [-0.32 * span - 2 * noise, pmax + 0.3 * span + 2.5 * noise];
  const main = panel(L, T, W - L - R, hTop, [-0.25, 0.75], top, { tag: null });
  // markers for the zoom ranges and the off-scale transit
  ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('eclipse', main.X(0.5), T + hTop - 5); ctx.fillText('transit ↓', main.X(0), T + hTop - 5);
  const ecl = d.eclipse || [0.44, 0.56], tra = d.transit || [-0.06, 0.06];
  let mlo = Infinity; for (let i = 0; i < d.model.x.length; i++) if (d.model.x[i] >= tra[0] && d.model.x[i] <= tra[1]) mlo = Math.min(mlo, ppm(d.model.y[i]));
  if (!Number.isFinite(mlo)) mlo = -1;
  const eTop = (d.depth ? d.depth * 1e6 : pmax) * 1.28 + 3 * noise, eBot = -0.3 * (d.depth ? d.depth * 1e6 : pmax) - 3 * noise;
  panel(L, yB0, wB, hBot, ecl, [eBot, eTop], { tag: 'Eclipse', errs: !d.bins, big: true });
  panel(L + wB + gapX, yB0, wB, hBot, tra, [mlo * 1.12, Math.max(pmax * 1.6, -mlo * 0.1)], { tag: 'Transit', big: true, component: false });
  // labels
  ctx.fillStyle = th.text; ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Orbital phase (0 = mid-transit, 0.5 = mid-eclipse)', L + (W - L - R) / 2, H - 5);
  ctx.save(); ctx.translate(4 + 8 * k, T + hTop / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Flux above the star (ppm)', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(4 + 8 * k, yB0 + hBot / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('ppm', 0, 0); ctx.restore();
  ctx.textAlign = 'left'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`; ctx.fillText(opt.title || d.label || '', L, T - 6);
  if (d.info && d.info.length) { ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText(d.info.join('     '), W - R - 8, T + 6); }
  // legend
  ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; let lx = L + 10; const ly = T + 12 + 4 * k;
  const item = (draw, text) => { draw(lx); ctx.fillStyle = th.text; ctx.fillText(text, lx + 28, ly); lx += 40 + ctx.measureText(text).width; };
  item((x) => { ctx.strokeStyle = th.model; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + 22, ly); ctx.stroke(); }, 'model');
  if (d.planet) item((x) => { ctx.strokeStyle = th.model; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + 22, ly); ctx.stroke(); ctx.setLineDash([]); }, 'planet (phase curve)');
  if (d.bins && opt.bins !== false) item((x) => { ctx.fillStyle = th.bin; ctx.beginPath(); ctx.arc(x + 11, ly, 3, 0, 6.3); ctx.fill(); }, 'binned data');
  if (opt.groups && d.group && opt.color !== false) opt.groups.forEach((name, g) => item((x) => { ctx.fillStyle = groupColor(th, g); ctx.beginPath(); ctx.arc(x + 11, ly, 3, 0, 6.3); ctx.fill(); }, name));
  return null;
}

// ---- (b) the map --------------------------------------------------------------------------------------

/**
 * Brightness or temperature map: longitude-latitude on the left, the globe seen at one orbital phase on the right.
 * d: { nlat, nlon, values: Float64Array(nlat*nlon)   row = latitude from the south pole, column = longitude from -180 (east positive,
 *                                                    0 = substellar point); NaN where the map has no value (negative brightness)
 *      vmin, vmax, unit ('K' or ''), quantity ('Brightness temperature')
 *      hotspot: { lat, lon } | null, phase: degrees from mid-eclipse of the globe's view (0 = dayside, 180 = nightside)
 *      inc: orbital inclination in degrees, label, info: [strings] }
 * opt: { fontScale, title, graticule (bool) }
 */
export function renderPlanetMap(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 50 + 12 * k, R = 14, T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 26 + 44 * k;
  ctx.font = `${F(11)}px ${th.font}`;
  if (!d || !d.values) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText((d && d.label) || 'No map', W / 2, H / 2); return null; }
  const barW = 14, barPad = 46 + 20 * k, globeD = Math.min(H - T - B - 16 * k, (W - L - R) * 0.34), gap = 26;
  const mw = W - L - R - globeD - gap - barW - barPad, mh = Math.min(H - T - B, mw / 2), my = T + (H - T - B - mh) / 2 + 4;
  // longitude-latitude panel
  const cw = mw / d.nlon, ch = mh / d.nlat;
  for (let i = 0; i < d.nlat; i++) for (let j = 0; j < d.nlon; j++) { ctx.fillStyle = lut(d.values[i * d.nlon + j], d.vmin, d.vmax) || NEG(th); ctx.fillRect(L + j * cw - 0.3, my + mh - (i + 1) * ch - 0.3, cw + 0.6, ch + 0.6); }
  const X = (lon) => L + ((lon + 180) / 360) * mw, Y = (lat) => my + (1 - (lat + 90) / 180) * mh;
  ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  if (opt.graticule !== false) { for (let lo = -150; lo < 180; lo += 30) { ctx.beginPath(); ctx.moveTo(X(lo), my); ctx.lineTo(X(lo), my + mh); ctx.stroke(); } for (let la = -60; la <= 60; la += 30) { ctx.beginPath(); ctx.moveTo(L, Y(la)); ctx.lineTo(L + mw, Y(la)); ctx.stroke(); } }
  // terminators, and the edge of the hemisphere seen from the observer at this phase
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); for (const lo of [-90, 90]) { ctx.beginPath(); ctx.moveTo(X(lo), my); ctx.lineTo(X(lo), my + mh); ctx.stroke(); } ctx.setLineDash([]);
  const lon0 = -(d.phase || 0), lat0 = 90 - (d.inc ?? 90);
  ctx.save(); ctx.beginPath(); ctx.rect(L, my, mw, mh); ctx.clip(); ctx.strokeStyle = th.frame ? '#1f5fbf' : '#5fd4ff'; ctx.lineWidth = 1.4;
  { // limb: points 90 degrees from the sub-observer point
    const o = [Math.cos(lat0 * DEG) * Math.sin(lon0 * DEG), Math.sin(lat0 * DEG), Math.cos(lat0 * DEG) * Math.cos(lon0 * DEG)];
    let u = [-o[1] * o[0], 1 - o[1] * o[1], -o[1] * o[2]]; const un = Math.hypot(...u) || 1; u = u.map((x) => x / un); const r = [u[1] * o[2] - u[2] * o[1], u[2] * o[0] - u[0] * o[2], u[0] * o[1] - u[1] * o[0]];
    let prev = null; ctx.beginPath();
    for (let i = 0; i <= 360; i += 2) { const a = i * DEG, b = [Math.cos(a) * r[0] + Math.sin(a) * u[0], Math.cos(a) * r[1] + Math.sin(a) * u[1], Math.cos(a) * r[2] + Math.sin(a) * u[2]], lon = Math.atan2(b[0], b[2]) / DEG, lat = Math.asin(Math.max(-1, Math.min(1, b[1]))) / DEG; if (prev !== null && Math.abs(lon - prev) < 180) ctx.lineTo(X(lon), Y(lat)); else ctx.moveTo(X(lon), Y(lat)); prev = lon; }
    ctx.stroke();
  }
  ctx.restore();
  // substellar point and the hot spot
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(X(0) - 5, Y(0)); ctx.lineTo(X(0) + 5, Y(0)); ctx.moveTo(X(0), Y(0) - 5); ctx.lineTo(X(0), Y(0) + 5); ctx.stroke();
  if (d.hotspot) { ctx.strokeStyle = th.frame ? '#000' : '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(d.hotspot.lon), Y(d.hotspot.lat), 5, 0, 6.3); ctx.stroke(); }
  ctx.strokeStyle = th.frame || th.text; ctx.lineWidth = 1; ctx.strokeRect(L + 0.5, my + 0.5, mw - 1, mh - 1);
  ctx.fillStyle = th.text; ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let lo = -180; lo <= 180; lo += (mw < 380 ? 90 : 45)) ctx.fillText(`${lo}°`, X(lo), my + mh + 5);
  ctx.fillText('Longitude east of the substellar point', L + mw / 2, my + mh + 7 + 13 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; for (let la = -90; la <= 90; la += 30) ctx.fillText(`${la}°`, L - 6, Y(la));
  ctx.save(); ctx.translate(4 + 8 * k, my + mh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('Latitude', 0, 0); ctx.restore();
  // globe
  const gx = L + mw + gap + globeD / 2, gy = my + mh / 2;
  drawGlobe(ctx, gx, gy, globeD / 2, d, { lon0, lat0 }, th, { substellar: true, night: true, hotspot: d.hotspot, graticule: opt.graticule });
  ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const ph = (((0.5 + (d.phase || 0) / 360) % 1) + 1) % 1;
  ctx.fillText(`as seen at phase ${ph.toFixed(2)}`, gx, gy + globeD / 2 + 6);
  colorBar(ctx, W - R - barPad - barW + 12 * k, my, barW, mh, d, th, F, null);
  ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(d.unit ? `${d.quantity || ''} (${d.unit})`.trim() : d.quantity || '', W - R, my - 4);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`; ctx.fillText(opt.title || d.label || '', L, T - 6);
  if (d.info && d.info.length) { ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(d.info.join('     '), L, H - 5); }
  return null;
}

// ---- (c) temperature against phase -----------------------------------------------------------------------

/**
 * Disc-integrated brightness temperature the observer sees through the orbit, with globes of the facing hemisphere.
 * d: { x[] (orbital phase from mid-transit, -0.25..0.75 or 0..1), y[] (K),
 *      band: { x[], lo[], hi[] } | null    posterior band
 *      map: { nlat, nlon, values, vmin, vmax } as for renderPlanetMap (values in K, or relative brightness)
 *      inc, globes: number of globes (default from the width), marks: [{ x, label }] (e.g. transit, eclipse)
 *      cursor: phase | null (a vertical line and a larger globe at that phase, for the movie)
 *      tday, tnight, unit ('K'), label, info: [strings] }
 * opt: { fontScale, title }
 */
export function renderTemperaturePhase(ctx, W, H, d, th, opt = {}) {
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const k = opt.fontScale || (W < 520 ? 0.95 : 1.12), F = (px) => (px * k).toFixed(1);
  const L = 62 + 14 * k, R = 16 + (d && d.map ? 44 + 22 * k : 0), T = opt.title ? 20 + 18 * k : 12 + 12 * k, B = 22 + 16 * k;
  ctx.font = `${F(11)}px ${th.font}`;
  if (!d || !d.x || !d.x.length) { ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText((d && d.label) || 'No temperatures', W / 2, H / 2); return null; }
  const px0 = L, px1 = W - R, x0 = d.x[0], x1 = d.x[d.x.length - 1];
  const nG = d.map ? d.globes || Math.max(5, Math.min(13, Math.floor((px1 - px0) / 78))) : 0, gR = d.map ? Math.min(34, (px1 - px0) / nG / 2 - 5, (H - T - B) * 0.16) : 0, hG = d.map ? 2 * gR + 30 : 0;
  const py0 = T + hG, ph = H - B - py0;
  let y0 = Infinity, y1 = -Infinity; for (const v of d.y) if (Number.isFinite(v)) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
  if (d.band) for (let i = 0; i < d.band.x.length; i++) { y0 = Math.min(y0, d.band.lo[i]); y1 = Math.max(y1, d.band.hi[i]); }
  const pad = 0.1 * (y1 - y0 || 1); y0 -= pad; y1 += pad;
  const X = (x) => px0 + ((x - x0) / (x1 - x0)) * (px1 - px0), Y = (v) => py0 + (1 - (v - y0) / (y1 - y0)) * ph;
  const xt = niceTicks(x0, x1, Math.max(3, Math.floor((px1 - px0) / (80 * k + 20)))), yt = niceTicks(y0, y1, Math.max(3, Math.floor(ph / 36)));
  ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of xt) { const x = X(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py0 + ph); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(xt.step)), x, py0 + ph + 5); }
  ctx.fillText('Orbital phase (0 = mid-transit, 0.5 = mid-eclipse)', (px0 + px1) / 2, H - 5 - 11 * k);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) { const y = Y(v); ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText(v.toFixed(decimals(yt.step)), px0 - 6, y); }
  ctx.save(); ctx.translate(4 + 8 * k, py0 + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(`Hemisphere temperature (${d.unit || 'K'})`, 0, 0); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(px0, py0, px1 - px0, ph); ctx.clip();
  for (const m of d.marks || []) { ctx.strokeStyle = th.text; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(X(m.x), py0); ctx.lineTo(X(m.x), py0 + ph); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = th.text; ctx.font = `${F(10.5)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(m.label, X(m.x) + 5, py0 + ph - 5); }
  if (d.band) { ctx.fillStyle = th.band; ctx.beginPath(); d.band.x.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(d.band.hi[i])) : ctx.moveTo(X(x), Y(d.band.hi[i])))); for (let i = d.band.x.length - 1; i >= 0; i--) ctx.lineTo(X(d.band.x[i]), Y(d.band.lo[i])); ctx.closePath(); ctx.fill(); }
  // the curve, coloured by its own temperature on the map's scale when there is a map in kelvin
  const scaled = d.map && d.map.unit !== '' && d.colorCurve !== false;
  ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  for (let i = 1; i < d.x.length; i++) { if (!Number.isFinite(d.y[i]) || !Number.isFinite(d.y[i - 1])) continue; ctx.strokeStyle = scaled ? lut(0.5 * (d.y[i] + d.y[i - 1]), d.map.vmin, d.map.vmax) : th.model; ctx.beginPath(); ctx.moveTo(X(d.x[i - 1]), Y(d.y[i - 1])); ctx.lineTo(X(d.x[i]), Y(d.y[i])); ctx.stroke(); }
  if (scaled && th.frame) { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.6; ctx.beginPath(); let pen = false; d.x.forEach((x, i) => { if (!Number.isFinite(d.y[i])) { pen = false; return; } if (pen) ctx.lineTo(X(x), Y(d.y[i]) - 1.6); else ctx.moveTo(X(x), Y(d.y[i]) - 1.6); pen = true; }); ctx.stroke(); }
  if (d.cursor !== null && d.cursor !== undefined && th.cursor) { ctx.strokeStyle = th.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(d.cursor), py0); ctx.lineTo(X(d.cursor), py0 + ph); ctx.stroke(); }
  ctx.restore();
  if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, py0 + 0.5, px1 - px0 - 1, ph - 1); }
  // globes: the hemisphere facing the observer at evenly spaced phases, joined to the curve
  if (d.map) {
    const lat0 = 90 - (d.inc ?? 90), cy = T + gR + 6;
    for (let g = 0; g < nG; g++) {
      const xp = x0 + ((g + 0.5) / nG) * (x1 - x0), cx = X(xp), lon0 = -(xp - 0.5) * 360;
      let j = 0; while (j < d.x.length - 1 && d.x[j] < xp) j++;
      ctx.strokeStyle = th.text; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy + gR + 2); ctx.lineTo(cx, Number.isFinite(d.y[j]) ? Y(d.y[j]) - 5 : py0); ctx.stroke(); ctx.globalAlpha = 1;
      drawGlobe(ctx, cx, cy, gR, d.map, { lon0, lat0 }, th, { substellar: gR > 16, graticule: gR > 26, cell: Math.max(1.5, gR / 14) });
    }
    ctx.fillStyle = th.text; ctx.font = `${F(10)}px ${th.sans}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('hemisphere facing the observer', px0, cy + gR + 5);
    colorBar(ctx, px1 + 12, py0, 12, ph, d.map, th, F, null);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.title; ctx.font = `${F(opt.title ? 14 : 11.5)}px ${th.sans}`; ctx.fillText(opt.title || d.label || '', px0, T - 6);
  if (d.info && d.info.length) { ctx.fillStyle = th.text; ctx.font = `${F(11)}px ${th.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillText(d.info.join('    '), W - 16, T - 6); }
  return null;
}

// ---- data builders ------------------------------------------------------------------------------------------

/**
 * Data object for renderPhaseCurve from a light curve and model parameters.
 * data: { t, f, e, epoch? } | null (times in the same system as params.tmid); params, opts: as for makePhaseCurve.
 * o: { bins: number of phase bins over the orbit (default 60), nModel (default 1500), label }
 * The data are divided by the stellar level of their epoch (weighted least squares against the model).
 */
export function phasePlotData(data, params, opts = {}, o = {}) {
  const f = makePhaseCurve(params, opts), per = params.per, ev = eventTimes(params), nM = o.nModel || 1500;
  const fold = (t) => { const p = ((((t - params.tmid) / per + 0.25) % 1) + 1) % 1; return p - 0.25; };
  const model = { x: new Float64Array(nM + 1), y: new Float64Array(nM + 1) }, planet = { x: model.x, y: new Float64Array(nM + 1) };
  for (let i = 0; i <= nM; i++) { const x = -0.25 + i / nM, t = params.tmid + x * per; model.x[i] = x; model.y[i] = f(t); planet.y[i] = 1 + f.phaseFlux((x - 0.5) * 2 * Math.PI) ; }
  const d = { model, planet, depth: f.depth, night: f.phaseFlux(Math.PI), label: o.label || '', info: o.info || [],
    eclipse: [0.5 - 1.15 * ev.e14 / per, 0.5 + 1.15 * ev.e14 / per], transit: [-1.1 * ev.t14 / per, 1.1 * ev.t14 / per] };
  if (ev.e14 === 0) d.eclipse = [0.44, 0.56];
  if (data && data.t.length) {
    const N = data.t.length; let nE = 1; if (data.epoch) for (let i = 0; i < N; i++) if (data.epoch[i] >= nE) nE = data.epoch[i] + 1;
    const sm = new Float64Array(nE), smm = new Float64Array(nE), m = new Float64Array(N);
    for (let i = 0; i < N; i++) { const s = data.epoch ? data.epoch[i] : 0, w = 1 / (data.e[i] * data.e[i]); m[i] = f(data.t[i]); sm[s] += w * m[i] * data.f[i]; smm[s] += w * m[i] * m[i]; }
    d.x = new Float64Array(N); d.y = new Float64Array(N); d.e = new Float64Array(N); d.group = data.epoch ? Int32Array.from(data.epoch) : null;
    for (let i = 0; i < N; i++) { const a = sm[data.epoch ? data.epoch[i] : 0] / smm[data.epoch ? data.epoch[i] : 0]; d.x[i] = fold(data.t[i]); d.y[i] = data.f[i] / a; d.e[i] = data.e[i] / a; }
    // bins: even over the orbit, four times finer inside the two zoom ranges
    const nb = o.bins || 60, fine = (x) => (x >= d.eclipse[0] && x < d.eclipse[1]) || (x >= d.transit[0] && x < d.transit[1]);
    const wFine = Math.min(d.eclipse[1] - d.eclipse[0], d.transit[1] - d.transit[0]) / 24, E = [];
    for (let x = -0.25; x < 0.75; x += fine(x) ? wFine : Math.min(1 / nb, Math.max(wFine, Math.min(...[d.eclipse[0], d.transit[0]].map((z) => (z > x ? z - x : 1)))))) E.push(x);
    E.push(0.75);
    const bw = new Float64Array(E.length), bx = new Float64Array(E.length), by = new Float64Array(E.length);
    for (let i = 0; i < N; i++) { let lo = 0, hi = E.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (E[mid] <= d.x[i]) lo = mid; else hi = mid; } const w = 1 / (d.e[i] * d.e[i]); bw[lo] += w; bx[lo] += w * d.x[i]; by[lo] += w * d.y[i]; }
    const bins = { x: [], y: [], e: [] };
    for (let b = 0; b < E.length - 1; b++) if (bw[b] > 0) { bins.x.push(bx[b] / bw[b]); bins.y.push(by[b] / bw[b]); bins.e.push(1 / Math.sqrt(bw[b])); }
    d.bins = bins;
  }
  return d;
}

/**
 * Data object for renderPlanetMap. o: { tstar, band (see BANDS in phasecurve.js), phase (deg from mid-eclipse), nlat, nlon, label }
 * With a stellar temperature and band the map is in kelvin; otherwise brightness relative to the star's.
 */
export function mapPlotData(params, o = {}) {
  const tm = temperatureMap(params, { tstar: o.tstar, band: o.band, nlat: o.nlat || 60, nlon: o.nlon || 120 }), kelvin = !!tm.temp, values = kelvin ? tm.temp : tm.ratio;
  let vmin = Infinity, vmax = -Infinity; for (const v of values) if (Number.isFinite(v)) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  if (!kelvin) { for (let i = 0; i < values.length; i++) if (values[i] < 0) values[i] = NaN; vmin = Math.max(0, vmin); }
  const info = [`hot spot ${Math.abs(tm.hotspot.lon).toFixed(1)}° ${tm.hotspot.lon >= 0 ? 'E' : 'W'}, ${Math.abs(tm.hotspot.lat).toFixed(1)}° ${tm.hotspot.lat >= 0 ? 'N' : 'S'}`];
  if (kelvin) info.push(`${tm.hotspot.temp.toFixed(0)} K at the hot spot`);
  if (tm.negativeFraction > 0) info.push(`${(tm.negativeFraction * 100).toFixed(0)}% of the surface has negative brightness (grey)`);
  return { nlat: tm.nlat, nlon: tm.nlon, values, vmin: o.vmin ?? vmin, vmax: o.vmax ?? vmax, unit: kelvin ? 'K' : '', quantity: kelvin ? 'Brightness temperature' : 'Brightness / stellar', hotspot: { lat: tm.hotspot.lat, lon: tm.hotspot.lon },
    phase: o.phase || 0, inc: params.inc, label: o.label || '', info };
}

/** Data object for renderTemperaturePhase. o: { tstar, band, label, cursor, map: reuse a mapPlotData() result }. */
export function temperaturePlotData(params, o = {}) {
  const s = phaseSummary(params, { tstar: o.tstar, band: o.band, nphase: 241 }), map = o.map || mapPlotData(params, o), n = s.phase.length;
  const x = new Float64Array(n), y = new Float64Array(n);
  // phaseSummary runs from -180 to 180 deg about mid-eclipse: that is phase 0 to 1 from mid-transit, in the same order
  for (let i = 0; i < n; i++) { x[i] = i / (n - 1); y[i] = s.temp ? s.temp[i] : s.flux[i] / (params.rprs * params.rprs); }
  const info = s.temp ? [`day ${s.tday.toFixed(0)} K`, `night ${s.tnight.toFixed(0)} K`, `peak ${Math.abs(s.hotspotOffset).toFixed(1)}° ${s.hotspotOffset >= 0 ? 'before' : 'after'} eclipse`, `A_B ${s.bondAlbedo.toFixed(2)}`, `ε ${s.epsilon.toFixed(2)}`] : [];
  return { x, y, map, inc: params.inc, unit: s.temp ? 'K' : 'Fp/F★ surface brightness', tday: s.tday, tnight: s.tnight, marks: [{ x: 0.5, label: 'eclipse (dayside)' }, { x: 0.0, label: 'transit (nightside)' }, { x: 1.0, label: '' }], cursor: o.cursor ?? null, label: o.label || '', info, summary: s };
}
export { brightnessTemperature };
