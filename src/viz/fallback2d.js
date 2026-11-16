// Canvas-2D stand-in used when three.js or WebGL is unavailable (offline,
// blocked CDN, no GPU). Same interface as scene.js, much plainer picture.

import { orbitPosition, orbitPath, eventPosition } from '../core/kepler.js';
import { intensity } from '../core/limbdark.js';
import { teffToRGB } from './color.js';

const EVENT_LABELS = { transit: 'mid-transit', eclipse: 'mid-eclipse', periastron: 'periastron', apastron: 'apastron', ascending: 'ascending node' };

export function createFallbackViz(container, labelsEl, insetFrame, reason) {
  const cv = document.createElement('canvas');
  container.appendChild(cv);
  const ctx = cv.getContext('2d');
  insetFrame.hidden = true;
  const note = document.createElement('div');
  note.className = 'viz-note';
  note.textContent = '3D view unavailable (' + reason + '). Showing the 2D schematic; the model and fitting are unaffected.';
  container.parentElement.appendChild(note);
  let sys = null, time = 0, dirty = true, evKind = null;
  let bodies = [], act = null;   // { el, rprs, name, letter, color, active, path, pos }

  function draw() {
    requestAnimationFrame(draw);
    if (!sys || !dirty) return;
    dirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = container.clientWidth, h = container.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    for (const b of bodies) orbitPosition(b.el, time, b.pos);
    const [r, g, bl] = teffToRGB(sys.teff).map((v) => Math.round(v * 255));
    const many = bodies.length > 1, el = act.el;
    ctx.font = '10px ui-monospace, monospace';

    // left: view from Earth, true scale. Planets behind the star first, then the star, then the ones in front (nearest last).
    const cx = w * 0.27, cy = h * 0.5, R = Math.min(w * 0.2, h * 0.3);
    const drawPlanet = (b) => {
      const x = cx + b.pos[0] * R, y = cy - b.pos[1] * R, rp = Math.max(1.2, b.rprs * R);
      ctx.fillStyle = '#05070c'; ctx.beginPath(); ctx.arc(x, y, rp, 0, 7); ctx.fill();
      ctx.strokeStyle = b.active ? '#5fd4ff66' : (b.color || '#aebccc') ; ctx.globalAlpha = b.active ? 1 : 0.5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      if (many && b.pos[2] > 0) { ctx.fillStyle = b.active ? '#fff' : (b.color || '#aebccc'); ctx.fillText(b.letter, x + rp + 3, y - rp - 2); }
    };
    const byDepth = bodies.slice().sort((a, b) => a.pos[2] - b.pos[2]);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w * 0.54, h); ctx.clip();
    for (const b of byDepth) if (b.pos[2] <= 0) drawPlanet(b);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    for (let i = 0; i <= 40; i++) { const x = i / 40, I = Math.max(0, intensity(Math.sqrt(1 - x * x), sys.claret)); grad.addColorStop(x, `rgb(${Math.round(r * I)},${Math.round(g * I)},${Math.round(bl * I)})`); }
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    for (const b of byDepth) if (b.pos[2] > 0) drawPlanet(b);
    ctx.restore();
    ctx.fillStyle = '#9fdcff'; ctx.fillText('AS SEEN FROM EARTH · TRUE SCALE', 14, h - 56);

    // right: orbits seen face-on (down the normal of the active planet's orbit), scaled to the outermost one
    const rOut = Math.max(...bodies.map((b) => b.el.ars * (1 + b.el.e)));
    const ox = w * 0.77, oy = h * 0.5, S = Math.min(w * 0.2, h * 0.36) / rOut;
    const face = (X, Y, Z) => { const yy = Z * el.sinI - Y * el.cosI; return [ox - X * S, oy + yy * S]; };
    for (const b of bodies) {
      const path = b.path, n = path.length / 3;
      ctx.strokeStyle = b.active ? '#5fd4ff99' : (b.color || '#aebccc'); ctx.globalAlpha = b.active ? 1 : 0.4; ctx.lineWidth = b.active ? 1.2 : 0.8; ctx.beginPath();
      for (let i = 0; i <= n; i++) { const j = (i % n) * 3; const [x, y] = face(path[j], path[j + 1], path[j + 2]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = `rgb(${r},${g},${bl})`; ctx.beginPath(); ctx.arc(ox, oy, Math.max(2.5, S), 0, 7); ctx.fill();
    for (const b of bodies) {
      const [px, py] = face(b.pos[0], b.pos[1], b.pos[2]);
      ctx.fillStyle = b.active ? '#fff' : (b.color || '#aebccc'); ctx.beginPath(); ctx.arc(px, py, b.active ? 3.5 : 2.4, 0, 7); ctx.fill();
      if (many) ctx.fillText(b.letter, px + 6, py - 5);
    }
    ctx.strokeStyle = '#7fd8ff77'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, h - 60); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#9fdcff'; ctx.fillText('↓ TO EARTH', ox - 30, h - 46); ctx.fillText(many ? 'ORBITS, FACE-ON' : 'ORBIT, FACE-ON', ox - 42, 62);

    // orbit event marker: a ring and a label on the active orbit in the face-on panel, and on the Earth view when it falls inside it
    if (evKind) {
      const p = eventPosition(el, evKind), [mx, my] = face(p[0], p[1], p[2]);
      ctx.strokeStyle = '#ffc860'; ctx.fillStyle = '#ffc860'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(mx, my, 7, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(mx, my, 1.8, 0, 7); ctx.fill();
      const text = EVENT_LABELS[evKind].toUpperCase(), tw = ctx.measureText(text).width;
      ctx.fillText(text, mx + 12 + tw > w - 6 ? mx - 12 - tw : mx + 12, my + 3);
      const ex = cx + p[0] * R, ey = cy - p[1] * R;
      if (ex > 8 && ex < w * 0.54 - 8 && ey > 8 && ey < h - 8) { ctx.beginPath(); ctx.arc(ex, ey, 7, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(ex, ey, 1.8, 0, 7); ctx.fill(); }
    }
  }
  new ResizeObserver(() => { dirty = true; }).observe(container);
  requestAnimationFrame(draw);
  return {
    kind: '2d',
    // same contract as scene.js: `planets` (two or more) draws the whole system, otherwise the single planet on show
    setSystem(s) {
      sys = s;
      const list = Array.isArray(s.planets) && s.planets.length > 1 ? s.planets.filter((p) => p && p.el) : [];
      let ia = list.findIndex((p) => p.active); if (ia < 0) ia = list.findIndex((p) => p.el === s.el); if (ia < 0) ia = 0;
      const src = list.length > 1 ? list.map((p, i) => ({ el: p.el, rprs: p.rprs, name: p.name, color: p.color, active: i === ia })) : [{ el: s.el, rprs: s.rprs, name: s.name, active: true }];
      bodies = src.map((p) => { const name = p.name || 'planet', tail = name.trim().split(/\s+/).pop(); return { ...p, name, letter: tail.length <= 2 ? tail : name, path: orbitPath(p.el, 360), pos: [0, 0, 0] }; });
      act = bodies.find((b) => b.active);
      dirty = true;
    },
    setTime(t) { time = t; dirty = true; },
    setOptions() {}, setView() {}, getView: () => 'free', getOptions: () => ({}),
    highlight(kind) { evKind = kind && EVENT_LABELS[kind] ? kind : null; dirty = true; },
    eventPosition: (kind) => (act && EVENT_LABELS[kind] ? eventPosition(act.el, kind) : null),
    getHighlight: () => evKind,
    getInfo: () => ({ planets: bodies.length, active: act ? bodies.indexOf(act) : -1 }),
  };
}
