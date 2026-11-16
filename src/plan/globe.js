// A small globe on a 2D canvas (orthographic projection, drawn here: no library, about 5 kB): land and sea, the day and night
// sides with the three twilight bands for a given time, the observatories as markers that can be picked, and the
// user's own site. Drag to turn, + / - (or pinch, or ctrl + wheel) to zoom, arrow keys when it has the focus.
//
// createGlobe(canvas, { onPick(site) }) -> { setLand(rings), setSites(sites), set({ jd, selected, user }), lookAt(lat, lon), zoomBy(f), resize() }
//   sites     [{ id, name, lat, lon, kind }]            rings   land-110m.json: [[lon10, lat10, ...], ...]
//   selected  id of the chosen site or null             user    { lat, lon } of a site typed by hand, or null
import { sunPosition, gast } from '../core/observability.js';

const DEG = Math.PI / 180;
export const GLOBE_COLOURS = { pro: '#6fdcff', net: '#ffd27a', remote: '#7ae6ad', user: '#ffffff', ocean: '#1a4470', land: '#6f9478', night: [4, 7, 16] };
// how dark the overlay is by the Sun's altitude: day, civil, nautical, astronomical twilight, night
const SHADE = [[0, 0], [-6, 0.26], [-12, 0.4], [-18, 0.52], [-90, 0.62]];

/** Sub-solar point { lat, lon (east) } at a Julian date (UTC). */
export function subSolar(jd) {
  const s = sunPosition(jd);
  return { lat: s.dec, lon: ((s.ra - gast(jd) + 540) % 360) - 180 };
}

export function createGlobe(canvas, { onPick } = {}) {
  const ctx = canvas.getContext('2d'), G = { lat0: 20, lon0: -100, zoom: 1, size: 280, sites: [], land: [], jd: null, selected: null, user: null, hover: null };
  let shade = null, raf = 0, anim = 0;
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);
  const R = () => (G.size / 2 - 5) * G.zoom;

  // unit vector of a place in the view frame: x right, y up, z toward the viewer
  function vec(lat, lon) {
    const p = lat * DEG, l = (lon - G.lon0) * DEG, p0 = G.lat0 * DEG, cp = Math.cos(p);
    return [cp * Math.sin(l), Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cp * Math.cos(l), Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cp * Math.cos(l)];
  }
  const px = (v) => [G.size / 2 + R() * v[0], G.size / 2 - R() * v[1]];

  // The surface is painted pixel by pixel: each pixel of the disc is turned back into a latitude and longitude,
  // looked up in a land mask (the coastline polygons filled once on an equirectangular grid of 0.25 deg) and
  // darkened by the Sun's altitude there. Filling the polygons in the projection instead goes wrong for a
  // continent that contains the far point of the view (the fill turns inside out).
  let mask = null; const MW = 1440, MH = 720;
  function buildMask() {
    const m = document.createElement('canvas'); m.width = MW; m.height = MH;
    const c = m.getContext('2d'); c.fillStyle = '#fff';
    for (const ring of G.land) { c.beginPath(); for (let i = 0; i < ring.length; i += 2) { const x = (ring[i] / 10 + 180) * 4, y = (90 - ring[i + 1] / 10) * 4; i ? c.lineTo(x, y) : c.moveTo(x, y); } c.closePath(); c.fill(); }
    const d = c.getImageData(0, 0, MW, MH).data; mask = new Uint8Array(MW * MH);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  }
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function drawSurface(c, r) {
    const n = Math.max(80, Math.min(460, Math.round(G.size * Math.min(2, dpr())))), half = G.size / 2;
    if (!shade || shade.width !== n) { shade = document.createElement('canvas'); shade.width = shade.height = n; }
    const sc = shade.getContext('2d'), img = sc.createImageData(n, n), d = img.data;
    const sp = G.jd != null ? subSolar(G.jd) : null, sv = sp ? vec(sp.lat, sp.lon) : null;
    const s0 = Math.sin(G.lat0 * DEG), c0 = Math.cos(G.lat0 * DEG), land = rgb(GLOBE_COLOURS.land), sea = rgb(GLOBE_COLOURS.ocean), ng = GLOBE_COLOURS.night;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n * G.size - half) / r, y = (half - (j + 0.5) / n * G.size) / r, q = x * x + y * y;
      if (q > 1) continue;
      const z = Math.sqrt(1 - q), sl = y * c0 + z * s0, lat = Math.asin(Math.max(-1, Math.min(1, sl))) / DEG, lon = G.lon0 + Math.atan2(x, z * c0 - y * s0) / DEG;
      const mx = Math.floor((((lon + 180) % 360) + 360) % 360 * 4) % MW, my = Math.min(MH - 1, Math.floor((90 - lat) * 4));
      const base = mask && mask[my * MW + mx] ? land : sea, lim = 0.72 + 0.28 * z;                       // a little darker toward the limb
      let a = 0;
      if (sv) { const alt = Math.asin(Math.max(-1, Math.min(1, x * sv[0] + y * sv[1] + z * sv[2]))) / DEG; for (const [lm, al] of SHADE) if (alt <= lm) a = al; }
      const k = (j * n + i) * 4;
      d[k] = base[0] * lim * (1 - a) + ng[0] * a; d[k + 1] = base[1] * lim * (1 - a) + ng[1] * a; d[k + 2] = base[2] * lim * (1 - a) + ng[2] * a; d[k + 3] = 255;
    }
    sc.putImageData(img, 0, 0);
    c.save(); c.beginPath(); c.arc(half, half, r - 0.5, 0, 2 * Math.PI); c.clip();
    c.imageSmoothingEnabled = true; c.drawImage(shade, 0, 0, G.size, G.size); c.restore();
  }

  function draw() {
    raf = 0;
    const s = G.size, c = ctx, r = R(), h = s / 2;
    c.setTransform(dpr(), 0, 0, dpr(), 0, 0); c.clearRect(0, 0, s, s);
    c.save(); c.beginPath(); c.rect(0, 0, s, s); c.clip();
    if (!mask && G.land.length) buildMask();
    drawSurface(c, r);
    // coastlines: the visible pieces only
    c.strokeStyle = 'rgba(200,228,208,0.55)'; c.lineWidth = 0.7;
    for (const ring of G.land) {
      c.beginPath(); let on = false;
      for (let i = 0; i < ring.length; i += 2) { const v = vec(ring[i + 1] / 10, ring[i] / 10); if (v[2] > 0 && ring[i + 1] > -899) { const [x, y] = px(v); on ? c.lineTo(x, y) : c.moveTo(x, y); on = true; } else on = false; }
      c.stroke();
    }
    // graticule every 30 degrees
    c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 0.7;
    const line = (f) => { c.beginPath(); let on = false; for (let t = 0; t <= 360; t += 3) { const v = f(t); if (v[2] > 0) { const [x, y] = px(v); on ? c.lineTo(x, y) : c.moveTo(x, y); on = true; } else on = false; } c.stroke(); };
    for (let lat = -60; lat <= 60; lat += 30) line((t) => vec(lat, t));
    for (let lon = -180; lon < 180; lon += 30) line((t) => vec(t / 2 - 90, lon));
    // the Sun overhead
    if (G.jd != null) {
      const sp = subSolar(G.jd), v = vec(sp.lat, sp.lon);
      if (v[2] > 0) { const [x, y] = px(v); c.fillStyle = '#ffe9a6'; c.strokeStyle = '#7a5a12'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, 5, 0, 2 * Math.PI); c.fill(); c.stroke(); }
    }
    // limb
    c.strokeStyle = '#7fa6d6'; c.lineWidth = 1.2; c.beginPath(); c.arc(h, h, r, 0, 2 * Math.PI); c.stroke();
    // observatories; the selected one last so that it is on top
    G.hit = [];
    const mark = (st, sel) => {
      const v = vec(st.lat, st.lon); if (v[2] <= 0.03) return;
      const [x, y] = px(v), col = GLOBE_COLOURS[st.kind] || GLOBE_COLOURS.pro, hov = G.hover === st;
      G.hit.push([x, y, st]);
      c.beginPath(); c.arc(x, y, sel ? 5.5 : hov ? 5 : 3.4, 0, 2 * Math.PI); c.fillStyle = col; c.fill(); c.strokeStyle = '#03060c'; c.lineWidth = 1.4; c.stroke();
      if (sel) { c.beginPath(); c.arc(x, y, 10, 0, 2 * Math.PI); c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.stroke(); }
      if (sel || hov) label(st.name, x, y);
    };
    const label = (text, x, y) => {
      c.font = '600 11.5px Inter, system-ui, sans-serif'; const w = c.measureText(text).width + 10, lx = Math.max(2, Math.min(s - w - 2, x - w / 2)), ly = y > 34 ? y - 31 : y + 14;
      c.fillStyle = 'rgba(5,8,14,0.9)'; c.strokeStyle = '#3a4664'; c.lineWidth = 1; c.beginPath(); c.rect(lx, ly, w, 18); c.fill(); c.stroke();
      c.fillStyle = '#e8eefa'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(text, lx + 5, ly + 9.5);
    };
    let selSite = null;
    for (const st of G.sites) { if (st.id === G.selected) selSite = st; else if (st !== G.hover) mark(st, false); }
    if (G.user) {
      const v = vec(G.user.lat, G.user.lon);
      if (v[2] > 0.03) { const [x, y] = px(v); c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillStyle = GLOBE_COLOURS.user; c.strokeStyle = '#03060c'; c.lineWidth = 1.5; c.fillRect(-4.5, -4.5, 9, 9); c.strokeRect(-4.5, -4.5, 9, 9); c.restore();
        c.beginPath(); c.arc(x, y, 10, 0, 2 * Math.PI); c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.stroke(); if (!G.hover) label('your site', x, y); }
    }
    if (selSite) mark(selSite, true);
    if (G.hover && G.hover !== selSite) mark(G.hover, false);
    c.restore();
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

  function resize() {
    const s = Math.max(160, Math.round(canvas.clientWidth || G.size));
    G.size = s; canvas.width = Math.round(s * dpr()); canvas.height = Math.round(s * dpr()); canvas.style.height = s + 'px';
    redraw();
  }
  function lookAt(lat, lon, animate = true) {
    cancelAnimationFrame(anim);
    const la = Math.max(-75, Math.min(75, lat));
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { G.lat0 = la; G.lon0 = lon; redraw(); return; }
    const a0 = G.lat0, o0 = G.lon0, dl = ((lon - o0 + 540) % 360) - 180, t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 450), e = 1 - (1 - k) ** 3; G.lat0 = a0 + (la - a0) * e; G.lon0 = o0 + dl * e; draw(); if (k < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }
  const zoomBy = (f) => { G.zoom = Math.max(1, Math.min(8, G.zoom * f)); redraw(); };
  const nearest = (x, y, tol) => { let best = null, bd = tol * tol; for (const [hx, hy, st] of G.hit || []) { const d = (hx - x) ** 2 + (hy - y) ** 2; if (d <= bd) { bd = d; best = st; } } return best; };
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

  // ---- pointer: drag turns, a click picks, two fingers zoom
  const ptr = new Map(); let moved = 0, pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no pointer to capture */ } ptr.set(e.pointerId, pos(e)); moved = 0; cancelAnimationFrame(anim); if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e), last = ptr.get(e.pointerId);
    if (!last) { const h = nearest(p[0], p[1], 9); if (h !== G.hover) { G.hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; redraw(); } return; }
    ptr.set(e.pointerId, p);
    if (ptr.size === 2) { const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch > 0) zoomBy(d / pinch); pinch = d; moved = 99; return; }
    const dx = p[0] - last[0], dy = p[1] - last[1]; moved += Math.abs(dx) + Math.abs(dy);
    const k = 1 / (R() * DEG);
    G.lon0 = ((G.lon0 - dx * k + 540) % 360) - 180; G.lat0 = Math.max(-85, Math.min(85, G.lat0 + dy * k)); redraw();
  });
  const up = (e) => {
    const had = ptr.delete(e.pointerId); pinch = 0;
    if (had && moved < 5 && e.type === 'pointerup') { const p = pos(e), h = nearest(p[0], p[1], e.pointerType === 'touch' ? 18 : 11); if (h && onPick) onPick(h); }
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (G.hover) { G.hover = null; redraw(); } });
  canvas.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const k = 10 / G.zoom;
    if (e.key === 'ArrowLeft') G.lon0 -= k; else if (e.key === 'ArrowRight') G.lon0 += k; else if (e.key === 'ArrowUp') G.lat0 = Math.min(85, G.lat0 + k); else if (e.key === 'ArrowDown') G.lat0 = Math.max(-85, G.lat0 - k);
    else if (e.key === '+' || e.key === '=') return zoomBy(1.3); else if (e.key === '-') return zoomBy(1 / 1.3); else return;
    e.preventDefault(); redraw();
  });
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'none';

  return {
    setLand(rings) { G.land = rings || []; mask = null; redraw(); },
    setSites(sites) { G.sites = sites || []; redraw(); },
    set(o) { Object.assign(G, o); redraw(); },
    lookAt, zoomBy, resize, state: G, _vec: vec,
  };
}
