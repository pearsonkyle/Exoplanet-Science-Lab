// The planner's drawings, as pure render functions on a 2D canvas context (so a screen, an export or a test can
// share them): the altitude of the target through one night, and its track across the sky (the "compass").
//
// nightFrame(noon, site) holds what every transit of one night shares (time axis, the Sun, the Moon);
// nightData(ev, site, opts, frame) adds the target; renderAltitude / renderSkyTrack draw it with a theme, full
// size or compact (the small multiples of the grid view, which share their axes within a night).
import { altAz, sunAltAz, moonAltAz, twilight, noonBefore, airmass, moonIllumination } from '../core/observability.js';

// Text colours against what they are drawn on (WCAG 2.1 contrast ratio, the contrast() helper below): `text` 16.5:1
// and `dim` 9.4:1 on the panel, where the axis labels are; captions inside the plot sit on a dark plate (at least
// 8:1 for every caption colour). The earlier theme drew labels in #55607a, 3.0:1. Nothing textual is under 4.5:1.
export const THEME = {
  text: '#e8eefa', dim: '#aab6cf', line: '#3a4664', panel: '#0b0f18',
  target: '#6fdcff', targetCore: '#ffffff', moon: '#ffd27a', warn: '#ffb454', bad: '#ff7d8a', ok: '#7ae6ad', twi: '#b79cff',
  // sky brightness bands: day, civil, nautical, astronomical twilight, night
  sky: ['#44699f', '#2d4c7e', '#1c3156', '#111d36', '#060910'],
  grid: 'rgba(255,255,255,0.16)', gridFaint: 'rgba(255,255,255,0.09)',
  font: '12px Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontSmall: '11px Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '11.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace', monoSmall: '10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const skyBand = (sunAlt) => (sunAlt > -0.833 ? 0 : sunAlt > -6 ? 1 : sunAlt > -12 ? 2 : sunAlt > -18 ? 3 : 4);

/** WCAG 2.1 contrast ratio of two '#rrggbb' colours. */
export function contrast(a, b) {
  const L = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const x = L(a), y = L(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const frames = new Map();
/**
 * What all transits of one night share. noon: the local mean noon before the night; span: optional [t0, t1] the
 * axis must include. Returns { noon, t0, t1, tw, t: [], sun: [], moonAlt: [], moonAz: [] } (n + 1 samples).
 * Frames without a span are cached (a grid of 60 small charts asks for the same night 60 times).
 */
export function nightFrame(noon, site, span = null, n = 200) {
  const key = span ? null : [noon, site.lat, site.lon, n].join('|');
  if (key && frames.has(key)) return frames.get(key);
  const tw = twilight(noon, site);
  // from half an hour before sunset to half an hour after sunrise; the 14 h around local midnight where the Sun does not set or rise
  let t0 = tw.sun.evening != null ? tw.sun.evening - 0.5 / 24 : noon + 0.5 - 7 / 24, t1 = tw.sun.morning != null ? tw.sun.morning + 0.5 / 24 : noon + 0.5 + 7 / 24;
  if (span) { t0 = Math.min(t0, span[0]); t1 = Math.max(t1, span[1]); }
  const F = { noon, t0, t1, tw, t: [], sun: [], moonAlt: [], moonAz: [] };
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n, m = moonAltAz(t, site);
    F.t.push(t); F.sun.push(sunAltAz(t, site).alt); F.moonAlt.push(m.alt); F.moonAz.push(m.az);
  }
  if (key) { if (frames.size > 120) frames.clear(); frames.set(key, F); }
  return F;
}

/**
 * Everything the drawings need for one event. ev: an event of findObservableTransits; opts: { minAlt, sunLimit, baseline };
 * frame: a nightFrame to share (else one is made that includes the event's region of interest).
 */
export function nightData(ev, site, opts, frame = null) {
  const tg = ev.target, F = frame || nightFrame(noonBefore(ev.mid, site.lon), site, [ev.roiStart - 0.5 / 24, ev.roiEnd + 0.5 / 24], 240);
  const samples = F.t.map((t, i) => { const a = altAz(tg.ra, tg.dec, t, site); return { t, alt: a.alt, az: a.az, sun: F.sun[i], moonAlt: F.moonAlt[i], moonAz: F.moonAz[i] }; });
  const mm = moonAltAz(ev.mid, site);
  return { t0: F.t0, t1: F.t1, samples, tw: F.tw, ev, moon: { illum: moonIllumination(ev.mid).fraction, alt: mm.alt, az: mm.az }, minAlt: opts.minAlt, sunLimit: opts.sunLimit, baseline: opts.baseline };
}

const lostColour = (why, theme) => (why === 'twilight' ? theme.twi : theme.warn);

/**
 * Altitude against time. w, h in CSS pixels (the context is already scaled for the device).
 * fmt: { local(jd) -> 'HH:MM', utc(jd) -> 'HH:MM', tzLabel, span(days) -> text }.
 * o.compact: the small-multiple version (no air-mass axis, no UTC ticks, no captions).
 */
export function renderAltitude(ctx, w, h, D, fmt, theme = THEME, o = {}) {
  const c = !!o.compact, L = c ? 27 : 38, R = c ? 6 : 42, T = c ? 6 : 30, B = c ? 17 : 36, pw = w - L - R, ph = h - T - B;
  const x = (t) => L + (t - D.t0) / (D.t1 - D.t0) * pw, y = (alt) => T + (1 - Math.max(0, Math.min(90, alt)) / 90) * ph;
  const ev = D.ev, S = D.samples;
  ctx.clearRect(0, 0, w, h);
  // sky brightness
  for (let i = 0; i < S.length - 1; i++) { ctx.fillStyle = theme.sky[skyBand((S[i].sun + S[i + 1].sun) / 2)]; ctx.fillRect(x(S[i].t), T, x(S[i + 1].t) - x(S[i].t) + 0.6, ph); }
  // below the altitude limit
  ctx.fillStyle = 'rgba(3,5,9,0.55)'; ctx.fillRect(L, y(D.minAlt), pw, y(0) - y(D.minAlt));
  // grid and left axis
  ctx.font = c ? theme.monoSmall : theme.mono; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  for (const a of [0, 30, 60, 90]) {
    ctx.strokeStyle = theme.grid; ctx.beginPath(); ctx.moveTo(L, Math.round(y(a)) + 0.5); ctx.lineTo(L + pw, Math.round(y(a)) + 0.5); ctx.stroke();
    if (!c || a !== 0) { ctx.fillStyle = theme.dim; ctx.textAlign = 'right'; ctx.fillText(a + '°', L - 4, y(a) + (a === 90 && c ? 4 : 0)); }
  }
  // right axis: air mass
  if (!c) {
    ctx.textAlign = 'left';
    for (const X of [1, 1.2, 1.5, 2, 3]) { const a = Math.asin(1 / X) * 180 / Math.PI; ctx.fillStyle = theme.dim; ctx.fillText(X.toFixed(X < 2 && X !== 1 ? 1 : 0), L + pw + 5, y(a)); }
    ctx.save(); ctx.translate(w - 5, T + ph / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = theme.dim; ctx.fillText('air mass', 0, 0); ctx.restore();
  }
  // hour ticks: local below, UTC above
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  const stepH = [1, 2, 3, 4, 6].find((n) => n * pw / ((D.t1 - D.t0) * 24) >= (c ? 40 : 46)) || 6, first = Math.ceil(D.t0 * 24 - 12);                 // whole UTC hours (JD .5 = 0 h UT)
  for (let k = first; (k + 12) / 24 <= D.t1; k++) {
    const t = (k + 12) / 24, xx = Math.round(x(t)) + 0.5, major = ((k % stepH) + stepH) % stepH === 0;
    ctx.strokeStyle = major ? theme.grid : theme.gridFaint; ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, T + ph + (major ? 4 : 0)); ctx.stroke();
    if (major && xx > L + 14 && xx < L + pw - 14) { ctx.fillStyle = theme.dim; ctx.fillText(fmt.local(t), xx, T + ph + (c ? 13 : 16)); if (!c) ctx.fillText(fmt.utc(t), xx, T - 7); }
  }
  if (!c) { ctx.textAlign = 'left'; ctx.fillStyle = theme.dim; ctx.fillText('UTC', 2, T - 7); ctx.fillText(fmt.tzLabel, 2, h - 5); }
  // region of interest: the baseline wanted on each side, the transit, and the 1-sigma range of its timing
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  const xi = x(ev.ingress), xe = x(ev.egress), xb = x(ev.roiStart), xa = x(ev.roiEnd);
  ctx.fillStyle = 'rgba(111,220,255,0.13)'; ctx.fillRect(xb, T, xa - xb, ph);
  ctx.fillStyle = 'rgba(111,220,255,0.17)'; ctx.fillRect(xi, T, xe - xi, ph);
  if (ev.sigma > 0 && !c) {
    const s = ev.sigma * pw / (D.t1 - D.t0);
    ctx.fillStyle = 'rgba(255,180,84,0.22)'; ctx.fillRect(xi - s, T, 2 * s, ph); ctx.fillRect(xe - s, T, 2 * s, ph);
  }
  ctx.strokeStyle = theme.target; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.8;
  ctx.beginPath(); ctx.moveTo(Math.round(xb) + 0.5, T); ctx.lineTo(Math.round(xb) + 0.5, T + ph); ctx.moveTo(Math.round(xa) + 0.5, T); ctx.lineTo(Math.round(xa) + 0.5, T + ph); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = c ? 1.25 : 1.5;
  ctx.beginPath(); ctx.moveTo(xi, T); ctx.lineTo(xi, T + ph); ctx.moveTo(xe, T); ctx.lineTo(xe, T + ph); ctx.stroke();
  ctx.setLineDash([5, 3]); ctx.strokeStyle = theme.targetCore; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.moveTo(x(ev.mid), T); ctx.lineTo(x(ev.mid), T + ph); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  // altitude limit
  ctx.setLineDash([5, 4]); ctx.strokeStyle = theme.warn; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(L, y(D.minAlt)); ctx.lineTo(L + pw, y(D.minAlt)); ctx.stroke(); ctx.setLineDash([]);
  // Moon
  ctx.strokeStyle = theme.moon; ctx.setLineDash([6, 4]); ctx.lineWidth = c ? 1.5 : 2; ctx.beginPath();
  let pen = false, lastMoon = null;
  for (const s of S) { if (s.moonAlt > -2) { pen ? ctx.lineTo(x(s.t), y(s.moonAlt)) : ctx.moveTo(x(s.t), y(s.moonAlt)); pen = true; if (s.moonAlt > 3) lastMoon = s; } else pen = false; }
  ctx.stroke(); ctx.setLineDash([]);
  // target: thin everywhere, bold (with a dark edge so that it stands off the twilight bands) where it can be observed
  const path = (test, width, colour, alpha = 1) => {
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath(); let on = false;
    for (let i = 0; i < S.length; i++) { const s = S[i]; if (s.alt > -1 && test(s)) { on ? ctx.lineTo(x(s.t), y(s.alt)) : ctx.moveTo(x(s.t), y(s.alt)); on = true; } else on = false; }
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  const obs = (s) => s.sun <= D.sunLimit && s.alt >= D.minAlt;
  path(() => true, c ? 1.5 : 1.75, theme.target, 0.8);
  path(obs, c ? 5 : 6.5, '#03060c', 0.9);
  path(obs, c ? 3 : 4, theme.target);
  // along the bottom of the region of interest: what can be observed (green) and what is lost (twilight, altitude)
  const sy = T + ph - (c ? 4 : 6), sh = c ? 4 : 6;
  ctx.fillStyle = theme.ok; ctx.fillRect(xb, sy, xa - xb, sh);
  for (const l of ev.lost || []) { ctx.fillStyle = lostColour(l.why, theme); ctx.fillRect(x(l.start), sy, x(l.end) - x(l.start), sh); }
  ctx.restore();
  ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);
  if (c) return;
  // captions, each on a dark plate so that it reads on any band
  ctx.font = theme.font; ctx.textBaseline = 'alphabetic';
  const plate = (text, px, py, colour, align = 'center') => {
    const tw = ctx.measureText(text).width, x0 = align === 'center' ? px - tw / 2 : align === 'right' ? px - tw : px;
    ctx.fillStyle = 'rgba(6,9,16,0.78)'; ctx.fillRect(x0 - 3, py - 11, tw + 6, 15);
    ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.fillText(text, x0, py);
  };
  if (lastMoon) { const right = x(lastMoon.t) > L + pw - 80; plate(`Moon ${Math.round(100 * D.moon.illum)}%`, x(lastMoon.t) + (right ? -5 : 5), Math.max(T + 14, y(lastMoon.moonAlt) - 6), theme.moon, right ? 'right' : 'left'); }
  const lx = Math.max(L + 44, Math.min(L + pw - 44, x(ev.mid)));
  plate('transit', lx, T + 14, theme.target);
  if (ev.sigma > 0) plate('± ' + fmt.span(ev.sigma), lx, T + 30, theme.warn);
  plate(`limit ${D.minAlt}°`, L + 5, y(D.minAlt) - 5, theme.warn, 'left');
}

/**
 * The target's track on the sky dome, seen from below (zenith in the centre, north up, EAST LEFT as when looking
 * up), for the same night: thin for the whole night, medium over the region of interest, bold during the transit,
 * with an arrow for the direction of motion and the Moon at mid-transit. o.compact: the small-multiple version.
 */
export function renderSkyTrack(ctx, size, D, theme = THEME, o = {}) {
  const k = !!o.compact, pad = k ? 12 : 20, c = size / 2, R = size / 2 - pad, ev = D.ev;
  const pt = (alt, az) => { const r = R * (90 - Math.max(alt, 0)) / 90, a = az * Math.PI / 180; return [c - r * Math.sin(a), c - r * Math.cos(a)]; };
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = theme.sky[4]; ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.fill();
  // below the altitude limit: a darker, hatched-looking annulus is too busy at this size; a tinted one reads better
  ctx.fillStyle = 'rgba(255,180,84,0.10)'; ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.arc(c, c, R * (90 - D.minAlt) / 90, 0, 2 * Math.PI, true); ctx.fill();
  ctx.lineWidth = 1;
  for (const a of [0, 30, 60]) { ctx.strokeStyle = a === 0 ? theme.dim : theme.grid; ctx.lineWidth = a === 0 ? 1.5 : 1; ctx.beginPath(); ctx.arc(c, c, R * (90 - a) / 90, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.strokeStyle = theme.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
  ctx.setLineDash([5, 4]); ctx.strokeStyle = theme.warn; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c, c, R * (90 - D.minAlt) / 90, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `600 ${k ? 10.5 : 12.5}px Inter, system-ui, sans-serif`; ctx.fillStyle = theme.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cp = k ? 6 : 10;
  ctx.fillText('N', c, c - R - cp); ctx.fillText('S', c, c + R + cp); ctx.fillText('E', c - R - cp, c); ctx.fillText('W', c + R + cp, c);
  if (!k) { ctx.font = theme.monoSmall; ctx.fillStyle = theme.dim; ctx.textAlign = 'left'; for (const a of [30, 60]) ctx.fillText(a + '°', c + 3, c - R * (90 - a) / 90 - 7); ctx.fillStyle = theme.warn; }
  const seg = (test, width, colour, alpha = 1) => {
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); let on = false;
    for (const s of D.samples) { if (s.alt > 0 && test(s)) { const [px, py] = pt(s.alt, s.az); on ? ctx.lineTo(px, py) : ctx.moveTo(px, py); on = true; } else on = false; }
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  const inRoi = (s) => s.t >= ev.roiStart && s.t <= ev.roiEnd, inTr = (s) => s.t >= ev.ingress && s.t <= ev.egress;
  seg(() => true, k ? 1.5 : 2, theme.target, 0.75);
  seg(inRoi, k ? 4.5 : 6, '#03060c', 0.9); seg(inRoi, k ? 2.5 : 3.5, theme.target);
  seg(inTr, k ? 6 : 8, '#03060c', 0.9); seg(inTr, k ? 4 : 5.5, theme.targetCore);
  // direction of motion: an arrow head where the region of interest ends
  const at = (t) => { let b = D.samples[0]; for (const s of D.samples) if (Math.abs(s.t - t) < Math.abs(b.t - t)) b = s; return b; };
  const e1 = at(ev.roiEnd), e0 = at(ev.roiEnd - (D.t1 - D.t0) / 40);
  if (e1.alt > 0 && e0.alt > 0) {
    const [x1, y1] = pt(e1.alt, e1.az), [x0, y0] = pt(e0.alt, e0.az), a = Math.atan2(y1 - y0, x1 - x0), s = k ? 6 : 9;
    ctx.fillStyle = theme.target; ctx.beginPath(); ctx.moveTo(x1 + s * Math.cos(a), y1 + s * Math.sin(a)); ctx.lineTo(x1 + s * Math.cos(a + 2.5), y1 + s * Math.sin(a + 2.5)); ctx.lineTo(x1 + s * Math.cos(a - 2.5), y1 + s * Math.sin(a - 2.5)); ctx.closePath(); ctx.fill();
  }
  // ingress and egress markers
  ctx.font = k ? theme.monoSmall : theme.mono;
  for (const [alt, az, lab] of [[ev.altIngress, ev.azIngress, 'in'], [ev.altEgress, ev.azEgress, 'out']]) {
    if (!(alt > 0)) continue;
    const [px, py] = pt(alt, az);
    ctx.fillStyle = theme.panel; ctx.strokeStyle = theme.targetCore; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, k ? 3 : 4.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    if (k) continue;
    // labels on opposite sides so that a short track does not print one over the other
    const tx = px + (lab === 'in' ? -8 : 8), ty = py + (lab === 'in' ? -10 : 11), tw = ctx.measureText(lab).width;
    ctx.fillStyle = 'rgba(6,9,16,0.78)'; ctx.fillRect(lab === 'in' ? tx - tw - 2 : tx - 2, ty - 7, tw + 4, 14);
    ctx.fillStyle = theme.text; ctx.textAlign = lab === 'in' ? 'right' : 'left'; ctx.fillText(lab, tx, ty);
  }
  if (D.moon.alt > 0) {
    const [px, py] = pt(D.moon.alt, D.moon.az);
    ctx.fillStyle = theme.moon; ctx.strokeStyle = '#03060c'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, k ? 4 : 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    if (!k) { ctx.font = theme.fontSmall; ctx.fillStyle = theme.moon; ctx.textAlign = px > c ? 'right' : 'left'; ctx.fillText('Moon', px + (px > c ? -10 : 10), py + 1); }
  }
}

/** Size a canvas for the device pixel ratio and return its 2D context scaled to CSS pixels. */
export function prepareCanvas(canvas, w, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export const airmassText = (alt) => { const x = airmass(alt); return Number.isFinite(x) ? x.toFixed(2) : '—'; };
