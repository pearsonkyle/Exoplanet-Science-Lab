// Corner plot of a weighted posterior sample with 1, 2 and 3 sigma regions.

import { weightedQuantiles, resampleIndices, makeRng } from '../core/stats.js';
import { tokens, alpha, mix } from '../site/theme.js';

// The 1, 2 and 3 sigma regions on the viridis scale, as in EXOTIC's posterior plots: dark in the middle, green around
// it, yellow outside. Three hues, so the regions cannot be mistaken for one another (they were three tints of one
// colour). On the dark screen the innermost colour is a lighter violet, or it would vanish into the background.
const ZL = ['#440154', '#21908c', '#d8cf1d'], ZD = ['#7a52c7', '#22a884', '#fde725'];
const THEMES = {
  dark:  { bg: '#111726', cell: '#0b0f18', text: '#dfe6f3', dim: '#8491ad', line: '#e9e0ff', mark: '#ffc56b', z: ZD, tail: 'rgba(253,231,37,0.16)', frame: null, font: 'ui-monospace, Menlo, monospace', out: 'rgba(132,145,173,0.35)', contour: ['#ffffff', '#ffffff', '#c9d3e6'] },
  light: { bg: '#ffffff', cell: '#ffffff', text: '#000000', dim: '#333333', line: '#000000', mark: '#d62728', z: ZL, tail: 'rgba(200,190,60,0.22)', frame: '#000000', font: 'Helvetica, Arial, sans-serif', out: 'rgba(120,120,120,0.30)', contour: ['#000000', '#000000', '#444444'] },
};
// With no theme asked for (the screen), the corner follows the site theme (src/site/theme.js); exports name 'dark' or 'light'.
function screenTheme() {
  const t = tokens();
  if (t.theme === 'dark') return THEMES.dark;
  if (t.light) return { ...THEMES.light, bg: t.panel, cell: t.panel, font: THEMES.dark.font };
  return { ...THEMES.dark, bg: t.panel2, cell: t.panel, text: t.text, dim: t.dim, line: mix(t.post, t.strong, 0.75), mark: t.star,
    // Night keeps to red and amber (no green, no blue: dark adaptation): its regions are three strengths of its own colour
    ...(t.theme === 'night' ? { z: [alpha(t.post, 0.98), alpha(mix(t.post, t.star, 0.6), 0.8), alpha(t.star, 0.55)], tail: alpha(t.star, 0.14) } : {}),
    out: alpha(t.dim, 0.35), contour: [t.strong, t.strong, mix(t.dim, t.strong, 0.5)] };
}
// Points are coloured by their likelihood on the viridis scale, as in EXOTIC's posterior plots: dark = highest
// likelihood, yellow = lowest, on every theme (the dark screen starts the scale a little way in, at a violet that
// shows on a dark background). The colour bar in the legend says which. Contour lines are drawn in the ink colour,
// not in the points' colours, so a line is never lost among the points it encloses.
const VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37]];
const NCOL = 24, DLNL = 6;   // colour steps; the scale spans 6 in ln L below the best point (about 3 sigma for two parameters)
function viridis(t) { const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1), i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i, a = VIRIDIS[i], b = VIRIDIS[i + 1]; return `rgb(${Math.round(a[0] + f * (b[0] - a[0]))},${Math.round(a[1] + f * (b[1] - a[1]))},${Math.round(a[2] + f * (b[2] - a[2]))})`; }

// probability enclosed by 1, 2, 3 sigma: in one dimension, and for a 2-D Gaussian
const P1D = [[0.1587, 0.8413], [0.0228, 0.9772], [0.00135, 0.99865]];
const P2D = [0.3935, 0.8647, 0.9889];

const sig = (v, e) => { const dg = Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(Math.max(1e-12, e))))); return v.toFixed(dg); };

export function drawCorner(cv, post, labels, marks, opt = {}) {
  const th = opt.theme ? THEMES[opt.theme] : screenTheme(), d = post.ndim, n = post.n;
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
  const cols = [], rng = [], q = [], hard = [];
  for (let k = 0; k < d; k++) {
    const c = new Float64Array(n); for (let i = 0; i < n; i++) c[i] = post.samples[i * d + k]; cols.push(c);
    const qq = weightedQuantiles(c, post.weights, [0.0005, 0.00135, 0.0228, 0.1587, 0.5, 0.8413, 0.9772, 0.99865, 0.9995]);
    const pad = (qq[8] - qq[0]) * 0.06 || Math.abs(qq[4]) * 1e-6 || 1e-9;
    // A hard limit (a prior's edge, a quantity that cannot be negative): the samples pile up against it instead of
    // thinning out. The axis then ends at the limit, with no margin beyond it for the contours to wander into.
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) if (post.weights[i] > 0) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
    const eh = new Float64Array(20); let em = 0; for (let i = 0; i < n; i++) { const b = Math.min(19, Math.max(0, Math.floor(((c[i] - lo) / ((hi - lo) || 1)) * 20))); eh[b] += post.weights[i]; } for (const v of eh) em = Math.max(em, v);
    const hardLo = eh[0] > 0.4 * em, hardHi = eh[19] > 0.4 * em;
    rng.push([hardLo ? lo : qq[0] - pad, hardHi ? hi : qq[8] + pad]); hard.push([hardLo, hardHi]); q.push(qq);
  }
  const NB = 28, g = 2;
  // the bin of a value on axis k; the last bin holds its upper edge (a value sitting exactly on a hard upper limit)
  const bin = (v, k) => { const b = Math.floor(((v - rng[k][0]) / (rng[k][1] - rng[k][0])) * NB); return b === NB && v <= rng[k][1] ? NB - 1 : b; };
  // likelihood colour of every plotted draw: step 0 is the best point. Runs without stored likelihoods fall back to the credible-region colours.
  const ll = post.logl && post.logl.length === n ? post.logl : null, dark = !th.frame;
  let lmax = -Infinity; if (ll) for (const i of pts) if (ll[i] > lmax) lmax = ll[i];
  const step = ll ? Int8Array.from(pts, (i) => Math.min(NCOL - 1, Math.floor(((lmax - ll[i]) / DLNL) * NCOL))) : null;
  const stepColor = Array.from({ length: NCOL }, (_, k) => viridis(dark ? 0.16 + 0.84 * k / (NCOL - 1) : k / (NCOL - 1)));
  if (opt.title) { ctx.fillStyle = th.text; ctx.font = `15px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(opt.title, padL + g, 6); }
  for (let r = 0; r < d; r++) for (let c = 0; c <= r; c++) {
    const x0 = padL + c * cell + g, y0 = top + r * cell + g, s = cell - 2 * g;
    ctx.fillStyle = th.cell; ctx.fillRect(x0, y0, s, s);
    const X = (v) => x0 + ((v - rng[c][0]) / (rng[c][1] - rng[c][0])) * s;
    if (r === c) {
      const h = new Float64Array(NB); let mx = 0;
      for (let i = 0; i < n; i++) { const b = bin(cols[c][i], c); if (b >= 0 && b < NB) h[b] += post.weights[i]; }
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
      // the name and the value above the histogram, in the room from the cell to the right edge: a smaller font where they
      // would run off it (the last column), shifted left only if even 8 px does not fit
      const val = `${sig(q[c][4], e)} +${sig(up, e)} −${sig(dn, e)}`, room = W - 3 - (x0 + 1);
      const put = (t, y) => { let f = fs; ctx.font = `${f}px ${th.font}`; const w0 = ctx.measureText(t).width; if (w0 > room) { f = Math.max(8, fs * room / w0); ctx.font = `${f}px ${th.font}`; }
        ctx.fillText(t, Math.max(2, Math.min(x0 + 1, W - 3 - ctx.measureText(t).width)), y); ctx.font = `${fs}px ${th.font}`; };
      put(labels[c], y0 - fs - 3);
      ctx.fillStyle = th.dim; put(val, y0 - 2);
    } else {
      const h = new Float64Array(NB * NB);
      for (let i = 0; i < n; i++) {
        const bx = bin(cols[c][i], c), by = bin(cols[r][i], r);
        if (bx >= 0 && bx < NB && by >= 0 && by < NB) h[by * NB + bx] += post.weights[i];
      }
      const sm = new Float64Array(NB * NB);
      for (let y = 0; y < NB; y++) for (let x = 0; x < NB; x++) { let a = 0, w = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= NB || yy >= NB) { if ((xx < 0 && hard[c][0]) || (xx >= NB && hard[c][1]) || (yy < 0 && hard[r][0]) || (yy >= NB && hard[r][1])) { const k = dx && dy ? 0.5 : 1; a += k * h[Math.min(NB - 1, Math.max(0, yy)) * NB + Math.min(NB - 1, Math.max(0, xx))]; w += k; } continue; } const k = dx || dy ? (dx && dy ? 0.5 : 1) : 2; a += k * h[yy * NB + xx]; w += k; } sm[y * NB + x] = a / w; }
      // highest-density thresholds enclosing the 1, 2, 3 sigma probabilities
      const srt = Float64Array.from(sm).sort().reverse(); let tot = 0; for (const v of srt) tot += v;
      const lev = [0, 0, 0]; let acc = 0, li = 0; for (const v of srt) { acc += v; while (li < 3 && acc >= P2D[li] * tot) lev[li++] = v; if (li === 3) break; }
      // every draw as a point, coloured by the credible region it falls in (as EXOTIC's posterior plots do)
      const Yp = (v) => y0 + s - ((v - rng[r][0]) / (rng[r][1] - rng[r][0])) * s;
      const zone = (i) => {
        const bx = bin(cols[c][i], c), by = bin(cols[r][i], r);
        if (bx < 0 || by < 0 || bx >= NB || by >= NB) return 3;
        const v = sm[by * NB + bx]; return v >= lev[0] ? 0 : v >= lev[1] ? 1 : v >= lev[2] ? 2 : 3;
      };
      const pr = Math.max(0.9, s / 150);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, s, s); ctx.clip();
      if (step) {
        // lowest likelihood first, so the best points end up on top
        ctx.globalAlpha = 0.8;
        for (let k = NCOL - 1; k >= 0; k--) { ctx.fillStyle = stepColor[k]; for (let j = 0; j < pts.length; j++) if (step[j] === k) { const i = pts[j]; ctx.fillRect(X(cols[c][i]) - pr, Yp(cols[r][i]) - pr, 2 * pr, 2 * pr); } }
        ctx.globalAlpha = 1;
      } else for (let z = 3; z >= 0; z--) {
        ctx.fillStyle = z === 3 ? th.out : th.z[z];
        for (const i of pts) if (zone(i) === z) ctx.fillRect(X(cols[c][i]) - pr, Yp(cols[r][i]) - pr, 2 * pr, 2 * pr);
      }
      // Contour lines at the 1, 2, 3 sigma density thresholds (marching squares on bin centres). The grid has a ring
      // of zeros round it, placed on the cell's edge: a region cut by a hard limit closes along the limit instead of
      // ending in two loose lines. 1 sigma heavy, 2 sigma thin, 3 sigma dashed: told apart without colour.
      const M = NB + 2, dens = (i, j) => (i < 1 || j < 1 || i > NB || j > NB ? 0 : sm[(j - 1) * NB + i - 1]);
      const gx = (i) => (i <= 0 ? x0 + 0.75 : i >= M - 1 ? x0 + s - 0.75 : x0 + ((i - 0.5) / NB) * s), gy = (j) => (j <= 0 ? y0 + s - 0.75 : j >= M - 1 ? y0 + 0.75 : y0 + s - ((j - 0.5) / NB) * s);
      for (let L = 2; L >= 0; L--) {
        const t = lev[L]; if (!(t > 0)) continue;
        ctx.strokeStyle = th.contour[L]; ctx.lineWidth = L === 0 ? 1.7 : L === 1 ? 1.1 : 0.9; ctx.setLineDash(L === 2 ? [3, 2.5] : []); ctx.beginPath();
        for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {
          const a = dens(i, j), b = dens(i + 1, j), cc = dens(i + 1, j + 1), dd = dens(i, j + 1);
          const k = (a >= t ? 1 : 0) | (b >= t ? 2 : 0) | (cc >= t ? 4 : 0) | (dd >= t ? 8 : 0);
          if (k === 0 || k === 15) continue;
          const f = (p, q) => (t - p) / (q - p);
          const E = [[gx(i) + f(a, b) * (gx(i + 1) - gx(i)), gy(j)], [gx(i + 1), gy(j) + f(b, cc) * (gy(j + 1) - gy(j))], [gx(i) + f(dd, cc) * (gx(i + 1) - gx(i)), gy(j + 1)], [gx(i), gy(j) + f(a, dd) * (gy(j + 1) - gy(j))]];
          const seg = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] }[k];
          for (const [p, q] of seg) { ctx.moveTo(E[p][0], E[p][1]); ctx.lineTo(E[q][0], E[q][1]); }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
      if (marks && Number.isFinite(marks[c]) && Number.isFinite(marks[r])) { const mx = X(marks[c]), my = y0 + s - ((marks[r] - rng[r][0]) / (rng[r][1] - rng[r][0])) * s; ctx.strokeStyle = th.mark; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(mx - 6, my); ctx.lineTo(mx + 6, my); ctx.moveTo(mx, my - 6); ctx.lineTo(mx, my + 6); ctx.stroke(); }
    }
    if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 0.8; ctx.strokeRect(x0 + 0.5, y0 + 0.5, s - 1, s - 1); }
    if (r === d - 1) { ctx.fillStyle = th.dim; ctx.font = `${Math.min(fs, 10.5)}px ${th.font}`; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; if (cell > 125) { ctx.fillText(Number(rng[c][0].toPrecision(4)), x0, y0 + s + 3); ctx.textAlign = 'right'; ctx.fillText(Number(rng[c][1].toPrecision(4)), x0 + s, y0 + s + 3); } else { ctx.textAlign = 'center'; ctx.fillText(Number(q[c][4].toPrecision(cell > 80 ? 4 : 3)), x0 + s / 2, y0 + s + 3); } }
  }
  // legend in the empty upper triangle
  if (d > 1) {
    const lx = padL + cell * (d - 1) + g + Math.max(0, cell - 100), ly = top + 6; ctx.font = `${fs}px ${th.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lrow = 0;
    if (step) {
      const bw = 74, bx = Math.min(lx, padL + cell * d - bw - 6);
      for (let k = 0; k < NCOL; k++) { ctx.fillStyle = stepColor[k]; ctx.fillRect(bx + (k / NCOL) * bw, ly, bw / NCOL + 0.5, fs); }
      if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 0.5; ctx.strokeRect(bx, ly, bw, fs); }
      ctx.fillStyle = th.dim; ctx.font = `${Math.max(8.5, fs - 2)}px ${th.font}`; ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillText('best', bx, ly + fs + 2); ctx.textAlign = 'right'; ctx.fillText(`ln L −${DLNL}`, bx + bw, ly + fs + 2);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `${fs}px ${th.font}`; lrow = 2.3;
    }
    ['1σ', '2σ', '3σ'].forEach((t, i) => { ctx.fillStyle = th.z[i]; ctx.fillRect(lx, ly + (i + lrow) * (fs + 5), 12, fs); if (th.frame) { ctx.strokeStyle = th.frame; ctx.lineWidth = 0.5; ctx.strokeRect(lx, ly + (i + lrow) * (fs + 5), 12, fs); } const yy = ly + (i + lrow) * (fs + 5) + fs / 2; ctx.strokeStyle = th.contour[i]; ctx.lineWidth = i === 0 ? 1.7 : i === 1 ? 1.1 : 0.9; ctx.setLineDash(i === 2 ? [3, 2.5] : []); ctx.beginPath(); ctx.moveTo(lx + 16, yy); ctx.lineTo(lx + 34, yy); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = th.text; ctx.fillText(t, lx + 39, yy); });
    if (marks) { ctx.strokeStyle = th.mark; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(lx, ly + (3 + lrow) * (fs + 5) + fs / 2); ctx.lineTo(lx + 12, ly + (3 + lrow) * (fs + 5) + fs / 2); ctx.stroke(); ctx.fillStyle = th.text; ctx.fillText('truth', lx + 39, ly + (3 + lrow) * (fs + 5) + fs / 2); }
  }
}
