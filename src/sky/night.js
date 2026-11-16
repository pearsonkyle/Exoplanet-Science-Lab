// "Play the night": the span of time to run through for a target, and the scrubber that shows it (twilight, the
// target's altitude, the transit window). The astronomy is in src/core/astro.js.
import * as A from '../core/astro.js';

const HOUR = 3600000;
export const SKY_COLORS = { day: '#5c88c4', civil: '#3d5f9c', nautical: '#253a6b', astronomical: '#141f3f', night: '#080c1a' };

/**
 * The span to play. ref: a Unix time (the transit's mid-time, or the time the view shows); lat, lon in radians.
 * It runs from sunset to sunrise of the night that contains ref (or follows it, when the Sun is up at ref),
 * stretched to hold a transit with an hour of baseline on each side when one is given; where the Sun does not set
 * or rise (polar summer and winter) it is twelve hours around ref.
 * Returns { t0, t1, twilight: A.nightOf(...), polar }.
 */
export function nightWindow(ref, lat, lon, heightM, transit) {
  const tw = A.nightOf(ref, lat, lon, heightM);
  let t0 = tw.sun.evening, t1 = tw.sun.morning, polar = false;
  if (t0 == null || t1 == null) { t0 = ref - 6 * HOUR; t1 = ref + 6 * HOUR; polar = true; }
  if (transit) {
    // a transit in daylight, or one that the night does not hold: its own window decides
    if (transit.egress < t0 || transit.ingress > t1) { t0 = transit.ingress - HOUR; t1 = transit.egress + HOUR; }
    else { t0 = Math.min(t0, transit.ingress - HOUR); t1 = Math.max(t1, transit.egress + HOUR); }
  }
  return { t0, t1, twilight: tw, polar };
}

/** n + 1 samples across the window: [{ t, sun (deg), alt, az (rad, airless) }]. altAzAt(t) gives the target. */
export function sampleNight(w, lat, lon, heightM, altAzAt, n = 144) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = w.t0 + (w.t1 - w.t0) * i / n; out.push({ t, sun: A.sunAltitude(t, lat, lon, heightM) * A.DEG, ...altAzAt(t) }); }
  return out;
}

const pad = (v) => String(v).padStart(2, '0');
export const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const hhmmUtc = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

/**
 * Draw the scrubber. night: { t0, t1, samples, transit: { ingress, mid, egress, err (minutes) } | null };
 * now: the time shown; horizon(azRad) -> the horizon altitude in radians at an azimuth (0 for a flat one).
 */
export function drawNightBar(canvas, night, now, horizon = () => 0) {
  const r = canvas.getBoundingClientRect(), px = Math.min(window.devicePixelRatio || 1, 2), W = Math.max(50, Math.round(r.width)), H = Math.max(20, Math.round(r.height));
  if (canvas.width !== W * px || canvas.height !== H * px) { canvas.width = W * px; canvas.height = H * px; }
  const g = canvas.getContext('2d'); g.setTransform(px, 0, 0, px, 0, 0); g.clearRect(0, 0, W, H);
  const { t0, t1, samples: s, transit } = night, X = (t) => (t - t0) / (t1 - t0) * W, top = 3, base = H - 13, Y = (altDeg) => base - Math.max(0, Math.min(90, altDeg)) / 90 * (base - top);
  // twilight bands
  for (let i = 0; i + 1 < s.length; i++) { g.fillStyle = SKY_COLORS[A.twilight((s[i].sun + s[i + 1].sun) / 2)]; g.fillRect(Math.floor(X(s[i].t)), 0, Math.ceil(X(s[i + 1].t) - X(s[i].t)) + 1, base); }
  g.fillStyle = '#05070c'; g.fillRect(0, base, W, H - base);
  // the transit: one-sigma margins, then the window itself
  if (transit) {
    const e = (transit.err || 0) * 60000;
    if (e > 0) { g.fillStyle = 'rgba(95,212,255,0.16)'; g.fillRect(X(transit.ingress - e), 0, X(transit.egress + e) - X(transit.ingress - e), base); }
    g.fillStyle = 'rgba(95,212,255,0.30)'; g.fillRect(X(transit.ingress), 0, X(transit.egress) - X(transit.ingress), base);
    g.strokeStyle = '#5fd4ff'; g.lineWidth = 1; g.beginPath(); for (const t of [transit.ingress, transit.egress]) { g.moveTo(X(t) + 0.5, 0); g.lineTo(X(t) + 0.5, base); } g.stroke();
    g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(transit.mid) + 0.5, 0); g.lineTo(X(transit.mid) + 0.5, base); g.stroke(); g.setLineDash([]);
  }
  // altitude of the target: bright where it is above the horizon
  const up = (p) => p.alt > horizon(p.az);
  g.strokeStyle = 'rgba(255,180,84,0.3)'; g.lineWidth = 1; g.beginPath(); s.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.alt * A.DEG)) : g.moveTo(X(p.t), Y(p.alt * A.DEG)))); g.stroke();
  g.strokeStyle = '#ffb454'; g.lineWidth = 2; g.lineCap = 'round'; g.beginPath();
  for (let i = 0; i + 1 < s.length; i++) if (up(s[i]) && up(s[i + 1])) { g.moveTo(X(s[i].t), Y(s[i].alt * A.DEG)); g.lineTo(X(s[i + 1].t), Y(s[i + 1].alt * A.DEG)); }
  g.stroke();
  // hours, local time
  g.font = '9.5px ui-monospace, Menlo, monospace'; g.textBaseline = 'alphabetic'; g.fillStyle = '#8491ad'; g.strokeStyle = 'rgba(132,145,173,0.5)'; g.lineWidth = 1;
  const span = (t1 - t0) / HOUR, every = W / span < 26 ? (W / span < 13 ? 4 : 2) : 1, d = new Date(t0); d.setMinutes(0, 0, 0);
  for (let t = d.getTime() + HOUR; t < t1; t += HOUR) {
    const x = Math.round(X(t)) + 0.5, h = new Date(t).getHours(); g.beginPath(); g.moveTo(x, base); g.lineTo(x, base + 3); g.stroke();
    if (h % every === 0 && x > 10 && x < W - 10) { g.textAlign = 'center'; g.fillText(pad(h), x, H - 1); }
  }
  // the time shown
  if (now >= t0 && now <= t1) { const x = X(now); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, base + 2); g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5); g.fill(); }
}
