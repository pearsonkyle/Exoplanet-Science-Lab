// Corner plot of a weighted posterior sample with 1, 2 and 3 sigma regions.

import { weightedQuantiles, resampleIndices, makeRng } from '../core/stats.js';

const THEMES = {
  dark:  { bg: '#111726', cell: '#0b0f18', text: '#dfe6f3', dim: '#8491ad', line: '#e9e0ff', mark: '#ffc56b', z: ['rgba(196,160,255,0.98)', 'rgba(140,105,215,0.70)', 'rgba(105,85,170,0.38)'], tail: 'rgba(105,85,170,0.14)', frame: null, font: 'ui-monospace, Menlo, monospace', out: 'rgba(132,145,173,0.35)', contour: ['#ffffff', '#d9c8ff', '#a78be0'] },
  light: { bg: '#ffffff', cell: '#ffffff', text: '#000000', dim: '#333333', line: '#000000', mark: '#d62728', z: ['rgba(31,95,191,0.95)', 'rgba(31,95,191,0.55)', 'rgba(31,95,191,0.25)'], tail: 'rgba(31,95,191,0.08)', frame: '#000000', font: 'Helvetica, Arial, sans-serif', out: 'rgba(120,120,120,0.30)', contour: ['#000000', '#222222', '#555555'] },
};
// probability enclosed by 1, 2, 3 sigma: in one dimension, and for a 2-D Gaussian
const P1D = [[0.1587, 0.8413], [0.0228, 0.9772], [0.00135, 0.99865]];
const P2D = [0.3935, 0.8647, 0.9889];

const sig = (v, e) => { const dg = Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, e))))); return v.toFixed(dg); };

export function drawCorner(cv, post, labels, marks, opt = {}) {
  const th = THEMES[opt.theme || 'dark'], d = post.ndim, n = post.n;
  const scale = opt.scale || Math.min(window.devicePixelRatio || 1, 2);
  const W = opt.width || cv.clientWidth || 380, padL = 8, top = opt.title ? 52 : 36;
  const cell = Math.floor((W - padL - 8) / d), H = top + cell * d + 28;
  if (!opt.width) cv.style.height = H + 'px';
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale); cv._cssW = W; cv._cssH = H;
  const ctx = cv.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const fs = Math.max(9.5, Math.min(opt.width ? 13 : 12, cell / 8));
  // equal-weight draws for the scatter, so point density means probability
  const pts = resampleIndices(post.weights, Math.min(6000, Math.max(1500, Math.round(post.ess || 3000))), makeRng(11));
  const cols = [], rng = [], q = [];
  for (let k = 0; k < d; k++) {
    const c = new Float64Array(n); for (let i = 0; i < n; i++) c[i] = post.samples[i * d + k]; cols.push(c);
    const qq = weightedQuantiles(c, post.weights, [0.0005, 0.00135, 0.0228, 0.1587, 0.5, 0.8413, 0.9772, 0.99865, 0.9995]);
    const pad = (qq[8] - qq[0]) * 0.06 || Math.abs(qq[4]) * 1e-6 || 1e-9; rng.push([qq[0] - pad, qq[8] + pad]); q.push(qq);
  }
  const NB = 28, g = 2;
  if (opt.title) { ctx.fillStyle = th.text; ctx.font = `15px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(opt.title, padL + g, 6); }
  for (let r = 0; r < d; r++) for (let c = 0; c <= r; c++) {
    const x0 = padL + c * cell + g, y0 = top + r * cell + g, s = cell - 2 * g;
    ctx.fillStyle = th.cell; ctx.fillRect(x0, y0, s, s);
    const X = (v) => x0 + ((v - rng[c][0]) / (rng[c][1] - rng[c][0])) * s;
    if (r === c) {
      const h = new Float64Array(NB); let mx = 0;
      for (let i = 0; i < n; i++) { const b = Math.floor(((cols[c][i] - rng[c][0]) / (rng[c][1] - rng[c][0])) * NB); if (b >= 0 && b < NB) h[b] += post.weights[i]; }
      for (let b = 0; b < NB; b++) mx = Math.max(mx, h[b]);
      for (let b = 0; b < NB; b++) {
        const mid = rng[c][0] + ((b + 0.5) / NB) * (rng[c][1] - rng[c][0]);
        // shade each bar by the innermost credible interval that contains it
        const z = mid >= q[c][3] && mid <= q[c][5] ? 0 : mid >= q[c][2] && mid <= q[c][6] ? 1 : mid >= q[c][1] && mid <= q[c][7] ? 2 : 3;
        ctx.fillStyle = z < 3 ? th.z[z] : th.tail;
        const hh = (h[b] / mx) * (s - 8); ctx.fillRect(x0 + (b / NB) * s, y0 + s - hh, s / NB + 0.4, hh);
      }
      ctx.strokeStyle = th.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(q[c][4]), y0); ctx.lineTo(X(q[c][4]), y0 + s); ctx.stroke();
      if (marks && Number.isFinite(marks[c])) { ctx.strokeStyle = th.mark; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(X(marks[c]), y0); ctx.lineTo(X(marks[c]), y0 + s); ctx.stroke(); }
      const up = q[c][5] - q[c][4], dn = q[c][4] - q[c][3], e = Math.min(up, dn) || 1e-12;
      ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = `${fs}px ${th.font}`;
      ctx.fillText(labels[c], x0 + 1, y0 - fs - 3);
      ctx.fillStyle = th.dim; ctx.fillText(`${sig(q[c][4], e)} +${sig(up, e)} −${sig(dn, e)}`, x0 + 1, y0 - 2);
    } else {
      const h = new Float64Array(NB * NB);
      for (let i = 0; i < n; i++) {
        const bx = Math.floor(((cols[c][i] - rng[c][0]) / (rng[c][1] - rng[c][0])) * NB), by = Math.floor(((cols[r][i] - rng[r][0]) / (rng[r][1] - rng[r][0])) * NB);
        if (bx >= 0 && bx < NB && by >= 0 && by < NB) h[by * NB + bx] += post.weights[i];
      }
      const sm = new Float64Array(NB * NB);
      for (let y = 0; y < NB; y++) for (let x = 0; x < NB; x++) { let a = 0, w = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= NB || yy >= NB) continue; const k = dx || dy ? (dx && dy ? 0.5 : 1) : 2; a += k * h[yy * NB + xx]; w += k; } sm[y * NB + x] = a / w; }
      // highest-density thresholds enclosing the 1, 2, 3 sigma probabilities
      const srt = Float64Array.from(sm).sort().reverse(); let tot = 0; for (const v of srt) tot += v;
      const lev = [0, 0, 0]; let acc = 0, li = 0; for (const v of srt) { acc += v; while (li < 3 && acc >= P2D[li] * tot) lev[li++] = v; if (li === 3) break; }
      // every draw as a point, coloured by the credible region it falls in (as EXOTIC's posterior plots do)
      const Yp = (v) => y0 + s - ((v - rng[r][0]) / (rng[r][1] - rng[r][0])) * s;
      const zone = (i) => {
        const bx = Math.floor(((cols[c][i] - rng[c][0]) / (rng[c][1] - rng[c][0])) * NB), by = Math.floor(((cols[r][i] - rng[r][0]) / (rng[r][1] - rng[r][0])) * NB);
        if (bx < 0 || by < 0 || bx >= NB || by >= NB) return 3;
        const v = sm[by * NB + bx]; return v >= lev[0] ? 0 : v >= lev[1] ? 1 : v >= lev[2] ? 2 : 3;
      };
      const pr = Math.max(0.9, s / 150);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, s, s); ctx.clip();
      for (let z = 3; z >= 0; z--) {
        ctx.fillStyle = z === 3 ? th.out : th.z[z];
        for (const i of pts) if (zone(i) === z) ctx.fillRect(X(cols[c][i]) - pr, Yp(cols[r][i]) - pr, 2 * pr, 2 * pr);
      }
      // contour lines at the 1, 2, 3 sigma density thresholds (marching squares on bin centres)
      const gx = (i) => x0 + ((i + 0.5) / NB) * s, gy = (j) => y0 + s - ((j + 0.5) / NB) * s;
      for (let L = 2; L >= 0; L--) {
        const t = lev[L]; if (!(t > 0)) continue;
        ctx.strokeStyle = th.contour[L]; ctx.lineWidth = L === 0 ? 1.5 : 1.1; ctx.beginPath();
        for (let j = 0; j < NB - 1; j++) for (let i = 0; i < NB - 1; i++) {
          const a = sm[j * NB + i], b = sm[j * NB + i + 1], cc = sm[(j + 1) * NB + i + 1], dd = sm[(j + 1) * NB + i];
          const k = (a >= t ? 1 : 0) | (b >= t ? 2 : 0) | (cc >= t ? 4 : 0) | (dd >= t ? 8 : 0);
          if (k === 0 || k === 15) continue;
          const f = (p, q) => (t - p) / (q - p);
          const E = [[gx(i) + f(a, b) * (gx(i + 1) - gx(i)), gy(j)], [gx(i + 1), gy(j) + f(b, cc) * (gy(j + 1) - gy(j))], [gx(i) + f(dd, cc) * (gx(i + 1) - gx(i)), gy(j + 1)], [gx(i), gy(j) + f(a, dd) * (gy(j + 1) - gy(j))]];
          const seg = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] }[k];
          for (const [p, q] of seg) { ctx.moveTo(E[p][0], E[p][1]); ctx.lineTo(E[q][0], E[q][1]); }
        }
        ctx.stroke();
      }
      ctx.restore();
      if (marks && Number.isFinite(marks[c]) && Number.isFinite(marks[r])) { const mx = X(marks[c]), my = y0 + s - ((marks[r] - rng[r][0]) / (rng[r][1] - rng[r][0])) * s; ctx.strokeStyle = th.mark; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(mx - 6, my); ctx.lineTo(mx + 6, my); ctx.moveTo(mx, my - 6); ctx.lineTo(mx, my + 6); ctx.stroke(); }
    }
    if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 0.8; ctx.strokeRect(x0 + 0.5, y0 + 0.5, s - 1, s - 1); }
    if (r === d - 1) { ctx.fillStyle = th.dim; ctx.font = `${Math.min(fs, 10.5)}px ${th.font}`; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; if (cell > 125) { ctx.fillText(Number(rng[c][0].toPrecision(4)), x0, y0 + s + 3); ctx.textAlign = 'right'; ctx.fillText(Number(rng[c][1].toPrecision(4)), x0 + s, y0 + s + 3); } else { ctx.textAlign = 'center'; ctx.fillText(Number(q[c][4].toPrecision(cell > 80 ? 4 : 3)), x0 + s / 2, y0 + s + 3); } }
  }
  // legend in the empty upper triangle
  if (d > 1) {
    const lx = padL + cell * (d - 1) + g + Math.max(0, cell - 86), ly = top + 6; ctx.font = `${fs}px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ['1σ', '2σ', '3σ'].forEach((t, i) => { ctx.fillStyle = th.z[i]; ctx.fillRect(lx, ly + i * (fs + 5), 12, fs); if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 0.5; ctx.strokeRect(lx, ly + i * (fs + 5), 12, fs); } ctx.fillStyle = th.text; ctx.fillText(t, lx + 17, ly + i * (fs + 5) + fs / 2); });
    if (marks) { ctx.strokeStyle = th.mark; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(lx, ly + 3 * (fs + 5) + fs / 2); ctx.lineTo(lx + 12, ly + 3 * (fs + 5) + fs / 2); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText('truth', lx + 17, ly + 3 * (fs + 5) + fs / 2); }
  }
}
