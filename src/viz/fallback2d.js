// Canvas-2D stand-in used when three.js or WebGL is unavailable (offline,
// blocked CDN, no GPU). Same interface as scene.js, much plainer picture.

import { orbitPosition, orbitPath } from '../core/kepler.js';
import { intensity } from '../core/limbdark.js';
import { teffToRGB } from './color.js';

export function createFallbackViz(container, labelsEl, insetFrame, reason) {
  const cv = document.createElement('canvas');
  container.appendChild(cv);
  const ctx = cv.getContext('2d');
  insetFrame.hidden = true;
  const note = document.createElement('div');
  note.className = 'viz-note';
  note.textContent = '3D view unavailable (' + reason + '). Showing the 2D schematic; the model and fitting are unaffected.';
  container.parentElement.appendChild(note);
  let sys = null, time = 0, path = null, dirty = true;
  const pos = [0, 0, 0];

  function draw() {
    requestAnimationFrame(draw);
    if (!sys || !dirty) return;
    dirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = container.clientWidth, h = container.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    orbitPosition(sys.el, time, pos);
    const [r, g, b] = teffToRGB(sys.teff).map((v) => Math.round(v * 255));

    // left: view from Earth, true scale
    const cx = w * 0.27, cy = h * 0.5, R = Math.min(w * 0.2, h * 0.3);
    const drawPlanet = () => { ctx.fillStyle = '#05070c'; ctx.beginPath(); ctx.arc(cx + pos[0] * R, cy - pos[1] * R, Math.max(1.2, sys.rprs * R), 0, 7); ctx.fill(); ctx.strokeStyle = '#5fd4ff66'; ctx.lineWidth = 1; ctx.stroke(); };
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w * 0.54, h); ctx.clip();
    if (pos[2] <= 0) drawPlanet();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    for (let i = 0; i <= 40; i++) { const x = i / 40, I = Math.max(0, intensity(Math.sqrt(1 - x * x), sys.claret)); grad.addColorStop(x, `rgb(${Math.round(r * I)},${Math.round(g * I)},${Math.round(b * I)})`); }
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    if (pos[2] > 0) drawPlanet();
    ctx.restore();
    ctx.fillStyle = '#9fdcff'; ctx.font = '10px ui-monospace, monospace'; ctx.fillText('AS SEEN FROM EARTH · TRUE SCALE', 14, h - 56);

    // right: orbit seen face-on
    const ox = w * 0.77, oy = h * 0.5, S = Math.min(w * 0.2, h * 0.36) / (sys.el.ars * (1 + sys.el.e));
    const face = (X, Y, Z) => { const yy = Z * sys.el.sinI - Y * sys.el.cosI; return [ox - X * S, oy + yy * S]; };
    ctx.strokeStyle = '#5fd4ff99'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = 0; i <= path.length / 3; i++) { const j = (i % (path.length / 3)) * 3; const [x, y] = face(path[j], path[j + 1], path[j + 2]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.beginPath(); ctx.arc(ox, oy, Math.max(2.5, S), 0, 7); ctx.fill();
    const [px, py] = face(pos[0], pos[1], pos[2]);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#7fd8ff77'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, h - 60); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#9fdcff'; ctx.fillText('↓ TO EARTH', ox - 30, h - 46); ctx.fillText('ORBIT, FACE-ON', ox - 42, 62);
  }
  new ResizeObserver(() => { dirty = true; }).observe(container);
  requestAnimationFrame(draw);
  return {
    kind: '2d',
    setSystem(s) { sys = s; path = orbitPath(s.el, 360); dirty = true; },
    setTime(t) { time = t; dirty = true; },
    setOptions() {}, setView() {}, getView: () => 'free', getOptions: () => ({}),
  };
}
