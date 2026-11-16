// Image viewer on a canvas: stretch, zoom about the cursor, pan, pinch, pixel readout. The image is drawn with
// its origin at the lower left (FITS convention); overlays are drawn by the page through `onDraw`.

const SCALES = {
  linear: (u) => u, sqrt: (u) => Math.sqrt(u), log: (u) => Math.log10(1 + 999 * u) / 3, asinh: (u) => Math.asinh(10 * u) / Math.asinh(10),
};

export class ImageViewer {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.off = document.createElement('canvas');
    this.w = 0; this.h = 0; this.data = null; this.scale = 1; this.ox = 0; this.oy = 0; this.fitted = false;
    this.stretch = { kind: 'asinh', lo: 10, hi: 99.8 }; this.vmin = 0; this.vmax = 1;
    this.onDraw = null; this.onClick = null; this.onHover = null;
    this._bind();
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!W || !H) return;
    if (this.cv.width !== Math.round(W * dpr) || this.cv.height !== Math.round(H * dpr)) { this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr); }
    this.dpr = dpr; this.W = W; this.H = H;
    if (!this.fitted && this.w) this.fit(); else this.draw();
  }
  /** Show an image. keepView leaves zoom and pan alone (stepping through frames of the same size). */
  setImage(data, w, h, keepView = true) {
    const same = keepView && w === this.w && h === this.h;
    this.data = data; this.w = w; this.h = h;
    this._levels(); this._paint();
    if (!same || !this.fitted) { this.fitted = false; this.resize(); if (!this.fitted) this.fit(); } else this.draw();
  }
  setStretch(s) { Object.assign(this.stretch, s); if (this.data) { this._levels(); this._paint(); this.draw(); } }
  _levels() {
    const d = this.data, n = d.length, step = Math.max(1, Math.floor(n / 60000)), buf = [];
    for (let i = 0; i < n; i += step) { const v = d[i]; if (v === v && Number.isFinite(v)) buf.push(v); }
    if (!buf.length) { this.vmin = 0; this.vmax = 1; return; }
    const a = Float64Array.from(buf).sort(), q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))];
    this.vmin = q(this.stretch.lo); this.vmax = q(this.stretch.hi);
    if (!(this.vmax > this.vmin)) this.vmax = this.vmin + 1;
  }
  _paint() {
    const { w, h, data } = this; this.off.width = w; this.off.height = h;
    const g = this.off.getContext('2d'), im = g.createImageData(w, h), px = new Uint32Array(im.data.buffer);
    const f = SCALES[this.stretch.kind] || SCALES.asinh, N = 1024, lut = new Uint32Array(N + 1);
    for (let i = 0; i <= N; i++) { const c = Math.round(255 * f(i / N)); lut[i] = 0xff000000 | (Math.min(255, c + 6) << 16) | (c << 8) | Math.max(0, c - 2); }   // ABGR, a faintly cool grey
    const k = N / (this.vmax - this.vmin), v0 = this.vmin;
    for (let i = 0; i < w * h; i++) { const v = data[i]; if (v !== v) { px[i] = 0xff30184a; continue; } let u = (v - v0) * k; u = u < 0 ? 0 : u > N ? N : u | 0; px[i] = lut[u]; }
    g.putImageData(im, 0, 0);
  }
  fit() {
    if (!this.w || !this.W) return;
    this.scale = Math.min(this.W / this.w, this.H / this.h) * 0.98;
    this.ox = (this.W - this.w * this.scale) / 2; this.oy = (this.H - this.h * this.scale) / 2; this.fitted = true; this.draw();
  }
  /** image (x, y) -> canvas CSS pixels; pixel centres at integers, y up. */
  toScreen(x, y) { return [this.ox + (x + 0.5) * this.scale, this.oy + (this.h - (y + 0.5)) * this.scale]; }
  toImage(sx, sy) { return [(sx - this.ox) / this.scale - 0.5, this.h - (sy - this.oy) / this.scale - 0.5]; }
  zoomAt(sx, sy, factor) {
    const [ix, iy] = this.toImage(sx, sy), min = Math.min(this.W / this.w, this.H / this.h) * 0.3;
    this.scale = Math.min(80, Math.max(min, this.scale * factor));
    this.ox = sx - (ix + 0.5) * this.scale; this.oy = sy - (this.h - (iy + 0.5)) * this.scale; this.draw();
  }
  draw() {
    const c = this.ctx; if (!this.W) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.fillStyle = '#05070c'; c.fillRect(0, 0, this.W, this.H);
    if (!this.data) return;
    c.imageSmoothingEnabled = this.scale < 1;
    c.save(); c.translate(this.ox, this.oy + this.h * this.scale); c.scale(this.scale, -this.scale); c.drawImage(this.off, 0, 0); c.restore();
    if (this.onDraw) this.onDraw(c, this);
  }
  _bind() {
    const cv = this.cv, pts = new Map(); let moved = 0, pinch = 0, start = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, pos(e)); moved = 0; start = pos(e); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (pts.has(e.pointerId)) {
        const q = pts.get(e.pointerId);
        if (pts.size === 1) { this.ox += p[0] - q[0]; this.oy += p[1] - q[1]; moved += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]); pts.set(e.pointerId, p); this.draw(); }
        else if (pts.size === 2) { pts.set(e.pointerId, p); const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch > 0) this.zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch); pinch = d; moved += 10; }
      } else if (this.onHover && this.data) { const [x, y] = this.toImage(p[0], p[1]), xi = Math.round(x), yi = Math.round(y); this.onHover(x, y, xi >= 0 && yi >= 0 && xi < this.w && yi < this.h ? this.data[yi * this.w + xi] : NaN); }
    });
    const up = (e) => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (moved < 5 && start && this.onClick && this.data && pts.size === 0) { const [x, y] = this.toImage(start[0], start[1]); if (x > -0.5 && y > -0.5 && x < this.w - 0.5 && y < this.h - 0.5) this.onClick(x, y, e); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); this.zoomAt(p[0], p[1], Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    cv.addEventListener('dblclick', () => this.fit());
  }
}
