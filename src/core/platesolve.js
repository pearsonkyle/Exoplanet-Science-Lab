// Plate solving without a server: the stars detected on a frame are matched to a star catalogue (Gaia DR3, fetched by
// the page from VizieR) by their triangles, and a gnomonic (TAN) world coordinate system, optionally with SIP
// distortion, is fitted to the matched pairs by least squares. Pure: no DOM, no network. The page passes star lists in
// and gets a WCS out; src/photometry/wcs.js does the fetching.
//
// Pixel coordinates are those of src/core/fits.js: zero-based, the centre of the first pixel at (0, 0). FITS CRPIX
// is one-based, as written in a header. Standard coordinates (xi, eta) are in degrees on the tangent plane, xi toward
// the east (increasing RA) and eta toward the north, as in Calabretta & Greisen (2002) for TAN.

import { detectSources, fitPsf } from './photometry.js';

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------
// Projection

/** Gnomonic projection of (ra, dec) about the tangent point (ra0, dec0), all in degrees: [xi, eta] in degrees (NaN on the far side). */
export function tanProject(ra, dec, ra0, dec0) {
  const a = (ra - ra0) * D2R, d = dec * D2R, d0 = dec0 * D2R, sd = Math.sin(d), cd = Math.cos(d), s0 = Math.sin(d0), c0 = Math.cos(d0);
  const cosc = s0 * sd + c0 * cd * Math.cos(a);
  if (!(cosc > 0)) return [NaN, NaN];
  return [cd * Math.sin(a) / cosc / D2R, (c0 * sd - s0 * cd * Math.cos(a)) / cosc / D2R];
}
/** Inverse of tanProject: [ra (0..360), dec] in degrees. */
export function tanDeproject(xi, eta, ra0, dec0) {
  const x = xi * D2R, y = eta * D2R, d0 = dec0 * D2R, s0 = Math.sin(d0), c0 = Math.cos(d0), den = c0 - y * s0;
  const ra = ra0 * D2R + Math.atan2(x, den), dec = Math.atan2(s0 + y * c0, Math.hypot(x, den));
  return [(((ra / D2R) % 360) + 360) % 360, dec / D2R];
}
/** Angular separation in arcsec (haversine). */
export function separation(ra1, dec1, ra2, dec2) {
  const d1 = dec1 * D2R, d2 = dec2 * D2R, s = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / D2R * 3600;
}

// ---------------------------------------------------------------------------------------------------------
// The WCS object

// exponents (p, q) of the polynomial terms with lo <= p + q <= hi, in SIP order
const terms = (lo, hi) => { const t = []; for (let n = lo; n <= hi; n++) for (let p = n; p >= 0; p--) t.push([p, n - p]); return t; };
const polyAt = (c, u, v) => { let s = 0; for (const k in c) { const [p, q] = k.split('_').map(Number); s += c[k] * u ** p * v ** q; } return s; };

/**
 * A TAN (optionally TAN-SIP) WCS.
 * @param crval [ra, dec] deg; crpix [x, y] one-based (FITS); cd [CD1_1, CD1_2, CD2_1, CD2_2] deg/px;
 *        sip { order, a: { 'p_q': coeff }, b: {...} } or null (forward SIP: u' = u + A(u, v), v' = v + B(u, v))
 * @returns { crval, crpix, cd, sip, scale [arcsec/px], rotation (deg, as readWcs), flipped, pixToSky(x, y), skyToPix(ra, dec), header(opts) }
 */
export function makeWcs({ crval, crpix, cd, sip = null, width, height }) {
  const [a, b, c, d] = cd, det = a * d - b * c;
  if (!(Math.abs(det) > 0)) throw new Error('singular CD matrix');
  const toUV = (x, y) => [x + 1 - crpix[0], y + 1 - crpix[1]];
  const fwd = sip ? (u, v) => [u + polyAt(sip.a, u, v), v + polyAt(sip.b, u, v)] : (u, v) => [u, v];
  const pixToSky = (x, y) => { const [u0, v0] = toUV(x, y), [u, v] = fwd(u0, v0); return tanDeproject(a * u + b * v, c * u + d * v, crval[0], crval[1]); };
  const skyToPix = (ra, dec) => {
    const [xi, eta] = tanProject(ra, dec, crval[0], crval[1]);
    if (!Number.isFinite(xi)) return [NaN, NaN];
    const U = (d * xi - b * eta) / det, V = (-c * xi + a * eta) / det;
    let u = U, v = V;
    if (sip) for (let it = 0; it < 20; it++) {
      // Newton on u + A(u, v) = U, v + B(u, v) = V
      const [fu, fv] = fwd(u, v), ru = fu - U, rv = fv - V, h = 1e-3;
      if (Math.abs(ru) + Math.abs(rv) < 1e-10) break;
      const [au, av] = fwd(u + h, v), [bu, bv] = fwd(u, v + h), j11 = (au - fu) / h, j21 = (av - fv) / h, j12 = (bu - fu) / h, j22 = (bv - fv) / h, dj = j11 * j22 - j12 * j21;
      u -= (j22 * ru - j12 * rv) / dj; v -= (-j21 * ru + j11 * rv) / dj;
    }
    return [u + crpix[0] - 1, v + crpix[1] - 1];
  };
  const W = {
    crval: [...crval], crpix: [...crpix], cd: [...cd], sip, width, height,
    scale: 0.5 * (Math.hypot(a, c) + Math.hypot(b, d)) * 3600, rotation: Math.atan2(b, d) / D2R, flipped: det > 0, pixToSky, skyToPix,
    /** FITS keywords; with SIP the inverse (AP, BP) is fitted on a grid over the image (width, height needed). */
    header(opts = {}) {
      const H = { WCSAXES: 2, CTYPE1: sip ? 'RA---TAN-SIP' : 'RA---TAN', CTYPE2: sip ? 'DEC--TAN-SIP' : 'DEC--TAN', CUNIT1: 'deg', CUNIT2: 'deg', RADESYS: 'ICRS', EQUINOX: 2000,
        CRVAL1: crval[0], CRVAL2: crval[1], CRPIX1: crpix[0], CRPIX2: crpix[1], CD1_1: a, CD1_2: b, CD2_1: c, CD2_2: d };
      if (sip) {
        H.A_ORDER = sip.order; for (const k in sip.a) H['A_' + k] = sip.a[k];
        H.B_ORDER = sip.order; for (const k in sip.b) H['B_' + k] = sip.b[k];
        const inv = inverseSip(W, opts.width ?? width, opts.height ?? height, sip.order + 1);
        if (inv) { H.AP_ORDER = inv.order; for (const k in inv.ap) H['AP_' + k] = inv.ap[k]; H.BP_ORDER = inv.order; for (const k in inv.bp) H['BP_' + k] = inv.bp[k]; }
      }
      return H;
    },
  };
  return W;
}

// the inverse SIP polynomials (AP, BP; terms 1 <= p + q <= order) by least squares on a grid of pixels
function inverseSip(W, width, height, order) {
  if (!(width > 0 && height > 0)) return null;
  const T = terms(1, order), rows = [], ru = [], rv = [], L = Math.max(width, height) / 2;
  for (let j = 0; j <= 24; j++) for (let i = 0; i <= 24; i++) {
    const u = i / 24 * width + 0.5 - W.crpix[0], v = j / 24 * height + 0.5 - W.crpix[1], U = u + polyAt(W.sip.a, u, v), V = v + polyAt(W.sip.b, u, v);
    rows.push(T.map(([p, q]) => (U / L) ** p * (V / L) ** q)); ru.push(u - U); rv.push(v - V);
  }
  const ca = lstsq(rows, ru), cb = lstsq(rows, rv); if (!ca || !cb) return null;
  const ap = {}, bp = {}; T.forEach(([p, q], k) => { ap[`${p}_${q}`] = ca[k] / L ** (p + q); bp[`${p}_${q}`] = cb[k] / L ** (p + q); });
  return { order, ap, bp };
}

/** A WCS from header keywords (FITS CRPIX), using makeWcs; SIP A/B are read when CTYPE ends in -SIP. Null when incomplete. */
export function wcsFromHeader(H) {
  const g = (k) => (H[k] == null ? NaN : Number(H[k]));
  const crval = [g('CRVAL1'), g('CRVAL2')], crpix = [g('CRPIX1'), g('CRPIX2')];
  let cd = ['CD1_1', 'CD1_2', 'CD2_1', 'CD2_2'].map(g);
  if (cd.every((v) => !Number.isFinite(v))) {
    const d1 = g('CDELT1'), d2 = g('CDELT2'); if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;
    const pc = ['PC1_1', 'PC1_2', 'PC2_1', 'PC2_2'].map(g), one = (v, dv) => (Number.isFinite(v) ? v : dv);
    if (pc.some(Number.isFinite)) cd = [d1 * one(pc[0], 1), d1 * one(pc[1], 0), d2 * one(pc[2], 0), d2 * one(pc[3], 1)];
    else { const r = (Number.isFinite(g('CROTA2')) ? g('CROTA2') : 0) * D2R; cd = [d1 * Math.cos(r), -d2 * Math.sin(r), d1 * Math.sin(r), d2 * Math.cos(r)]; }
  } else cd = cd.map((v) => (Number.isFinite(v) ? v : 0));
  if (![...crval, ...crpix].every(Number.isFinite)) return null;
  if (!/RA/i.test(String(H.CTYPE1 ?? 'RA')) || /^DEC/i.test(String(H.CTYPE1 ?? ''))) return null;    // (Dec, RA) order or other axes: use readWcs
  let sip = null;
  if (/-SIP/i.test(String(H.CTYPE1 ?? '')) && Number.isFinite(g('A_ORDER'))) {
    const order = g('A_ORDER'), a = {}, b = {};
    for (const [p, q] of terms(2, order)) { const ka = g(`A_${p}_${q}`), kb = g(`B_${p}_${q}`); if (Number.isFinite(ka)) a[`${p}_${q}`] = ka; if (Number.isFinite(kb)) b[`${p}_${q}`] = kb; }
    sip = { order, a, b };
  }
  try { return makeWcs({ crval, crpix, cd, sip, width: g('NAXIS1') || g('IMAGEW'), height: g('NAXIS2') || g('IMAGEH') }); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------
// Least squares

// solve the normal equations of rows (n x m) . c = y with Gaussian elimination and partial pivoting; null if singular
function lstsq(rows, y, w = null) {
  const m = rows[0].length, A = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (let i = 0; i < rows.length; i++) { const r = rows[i], wi = w ? w[i] : 1; for (let j = 0; j < m; j++) { const rj = r[j] * wi; for (let k = j; k < m; k++) A[j][k] += rj * r[k]; A[j][m] += rj * y[i]; } }
  for (let j = 0; j < m; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  for (let c = 0; c < m; c++) {
    let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-300)) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (f) for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
  }
  return Array.from({ length: m }, (_, j) => A[j][m] / A[j][j]);
}

// coefficients of P(u + x0, v + y0) from those of P(x, y) (keys 'p_q')
function shiftPoly(c, x0, y0) {
  const out = {}, C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
  for (const key in c) {
    const [i, j] = key.split('_').map(Number);
    for (let p = 0; p <= i; p++) for (let q = 0; q <= j; q++) { const k = `${p}_${q}`; out[k] = (out[k] || 0) + c[key] * C(i, p) * C(j, q) * x0 ** (i - p) * y0 ** (j - q); }
  }
  return out;
}

/**
 * Least-squares TAN (or TAN-SIP) WCS from matched pairs [{ x, y, ra, dec }] (pixels zero-based, degrees). The standard
 * coordinates xi and eta are fitted as polynomials of the pixel offsets (degree 1, or sipOrder), which is the TAN-SIP
 * model written another way: the linear terms are the CD matrix and the rest, multiplied by its inverse, are A and B.
 *   default:          CRPIX fixed (opts.crpix, one-based; default the centre of width x height, else of the stars), CRVAL fitted
 *                     by moving the tangent point until the constant terms vanish (as astrometry.net puts it at the centre)
 *   opts.crval given: CRVAL fixed and CRPIX fitted (astropy.wcs.utils.fit_wcs_from_points with proj_point)
 * @param opts { crpix, crval, sipOrder = 0, width, height, weights }
 * @returns makeWcs(...) plus { n, rms [arcsec], rmsPx, residuals: [{ dx, dy } arcsec east and north, d] }
 */
export function fitWcs(pairs, opts = {}) {
  const n = pairs.length, order = Math.max(1, opts.sipOrder || 0), T = terms(0, order);
  if (n < Math.max(3, T.length)) throw new Error(`a WCS of order ${order} needs at least ${Math.max(3, T.length)} matched stars (got ${n})`);
  const w = opts.weights || null;
  const W0 = opts.width, H0 = opts.height;
  let crpix = opts.crpix ? [...opts.crpix] : W0 > 0 && H0 > 0 ? [(W0 + 1) / 2, (H0 + 1) / 2] : [pairs.reduce((s, p) => s + p.x + 1, 0) / n, pairs.reduce((s, p) => s + p.y + 1, 0) / n];
  let crval, cx, ce;
  const L = Math.max(1, ...pairs.map((p) => Math.max(Math.abs(p.x + 1 - crpix[0]), Math.abs(p.y + 1 - crpix[1]))));     // scale of the offsets, for conditioning
  const fitAbout = (ra0, de0, cp) => {
    const rows = [], xi = [], eta = [];
    for (const p of pairs) { const u = (p.x + 1 - cp[0]) / L, v = (p.y + 1 - cp[1]) / L, [a, b] = tanProject(p.ra, p.dec, ra0, de0); rows.push(T.map(([P, Q]) => u ** P * v ** Q)); xi.push(a); eta.push(b); }
    const A = lstsq(rows, xi, w), B = lstsq(rows, eta, w); if (!A || !B) throw new Error('the matched stars do not constrain a WCS (all on a line?)');
    const ca = {}, cb = {}; T.forEach(([P, Q], k) => { ca[`${P}_${Q}`] = A[k] / L ** (P + Q); cb[`${P}_${Q}`] = B[k] / L ** (P + Q); });
    return [ca, cb];
  };
  if (opts.crval) {
    crval = [...opts.crval];
    [cx, ce] = fitAbout(crval[0], crval[1], crpix);
    // move CRPIX to where both polynomials vanish (Newton), then re-expand them about it
    let u = 0, v = 0;
    for (let it = 0; it < 50; it++) {
      const f = polyAt(cx, u, v), g = polyAt(ce, u, v), h = 1e-3 * L;
      const fu = (polyAt(cx, u + h, v) - f) / h, fv = (polyAt(cx, u, v + h) - f) / h, gu = (polyAt(ce, u + h, v) - g) / h, gv = (polyAt(ce, u, v + h) - g) / h, dj = fu * gv - fv * gu;
      const du = (gv * f - fv * g) / dj, dv = (-gu * f + fu * g) / dj; u -= du; v -= dv;
      if (Math.abs(du) + Math.abs(dv) < 1e-9) break;
    }
    cx = shiftPoly(cx, u, v); ce = shiftPoly(ce, u, v); crpix = [crpix[0] + u, crpix[1] + v];
  } else {
    let ra0 = opts.ra0, de0 = opts.dec0;
    if (!Number.isFinite(ra0) || !Number.isFinite(de0)) {
      // start at the star nearest the reference pixel
      const near = pairs.reduce((b, p) => (Math.hypot(p.x + 1 - crpix[0], p.y + 1 - crpix[1]) < Math.hypot(b.x + 1 - crpix[0], b.y + 1 - crpix[1]) ? p : b), pairs[0]); ra0 = near.ra; de0 = near.dec;
    }
    for (let it = 0; it < 30; it++) {
      [cx, ce] = fitAbout(ra0, de0, crpix);
      const c0 = cx['0_0'], e0 = ce['0_0'];
      [ra0, de0] = tanDeproject(c0, e0, ra0, de0);
      if (Math.hypot(c0, e0) < 1e-12) break;
    }
    crval = [ra0, de0];
    [cx, ce] = fitAbout(ra0, de0, crpix);
  }
  const cd = [cx['1_0'], cx['0_1'], ce['1_0'], ce['0_1']], det = cd[0] * cd[3] - cd[1] * cd[2];
  let sip = null;
  if (order >= 2) {
    const a = {}, b = {};
    for (const [P, Q] of terms(2, order)) { const k = `${P}_${Q}`, X = cx[k] || 0, E = ce[k] || 0; a[k] = (cd[3] * X - cd[1] * E) / det; b[k] = (-cd[2] * X + cd[0] * E) / det; }
    sip = { order, a, b };
  }
  const W = makeWcs({ crval, crpix, cd, sip, width: W0, height: H0 });
  const residuals = pairs.map((p) => { const [r, d] = W.pixToSky(p.x, p.y); const dx = ((((p.ra - r) % 360) + 540) % 360 - 180) * Math.cos(p.dec * D2R) * 3600, dy = (p.dec - d) * 3600; return { dx, dy, d: Math.hypot(dx, dy) }; });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r.d * r.d, 0) / n);
  return Object.assign(W, { n, rms, rmsPx: rms / W.scale, residuals });
}

// ---------------------------------------------------------------------------------------------------------
// Matching detected stars to a catalogue

// triangles of points P (indices into P, brightest first) with sides in [minSide, maxSide]:
// { v: [i (opposite the shortest side), j, k (opposite the longest)], r1 = short / long, r2 = middle / long, L (longest), o (orientation) }
function triangles(P, n, minSide, maxSide, cap = 400000) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dij = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y); if (dij < minSide || dij > maxSide) continue;
    for (let k = j + 1; k < n; k++) {
      const djk = Math.hypot(P[j].x - P[k].x, P[j].y - P[k].y), dik = Math.hypot(P[i].x - P[k].x, P[i].y - P[k].y);
      if (djk < minSide || dik < minSide || djk > maxSide || dik > maxSide) continue;
      const s = [[dij, k], [djk, i], [dik, j]].sort((p, q) => p[0] - q[0]);
      if (s[2][0] > 0.97 * (s[0][0] + s[1][0])) continue;                                                // nearly collinear
      if (s[1][0] / s[2][0] - s[0][0] / s[2][0] < 0.03 || 1 - s[1][0] / s[2][0] < 0.03) continue;        // nearly isosceles: vertex order ambiguous
      const A = P[s[0][1]], B = P[s[1][1]], C = P[s[2][1]], cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      out.push({ v: [s[0][1], s[1][1], s[2][1]], r1: s[0][0] / s[2][0], r2: s[1][0] / s[2][0], L: s[2][0], o: cr > 0 ? 1 : -1 });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// similarity X = s R (x, m y) + t from point pairs [[x, y, X, Y]] (m = -1 when mirrored)
function similarity(pairs, mirror) {
  const n = pairs.length, sg = mirror ? -1 : 1; let mx = 0, my = 0, mX = 0, mY = 0;
  for (const p of pairs) { mx += p[0]; my += sg * p[1]; mX += p[2]; mY += p[3]; } mx /= n; my /= n; mX /= n; mY /= n;
  let sxx = 0, sa = 0, sb = 0;
  for (const p of pairs) { const dx = p[0] - mx, dy = sg * p[1] - my, dX = p[2] - mX, dY = p[3] - mY; sxx += dx * dx + dy * dy; sa += dx * dX + dy * dY; sb += dx * dY - dy * dX; }
  const a = sa / sxx, b = sb / sxx;
  return { a, b, tx: mX - (a * mx - b * my), ty: mY - (b * mx + a * my), mirror, scale: Math.hypot(a, b), rotation: Math.atan2(b, a) };
}
const apply = (T, x, y) => { const yy = T.mirror ? -y : y; return [T.a * x - T.b * yy + T.tx, T.b * x + T.a * yy + T.ty]; };

// a uniform grid over points for nearest-neighbour queries
function grid(P, cell) {
  const G = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  P.forEach((p, k) => { const kk = key(Math.floor(p.x / cell), Math.floor(p.y / cell)); let a = G.get(kk); if (!a) G.set(kk, a = []); a.push(k); });
  return {
    nearest(x, y, r, skip) {
      let best = -1, bd = r; const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell), j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = G.get(key(i, j)); if (!a) continue; for (const k of a) { if (skip && skip.has(k)) continue; const d = Math.hypot(P[k].x - x, P[k].y - y); if (d < bd) { bd = d; best = k; } } }
      return best;
    },
  };
}

/**
 * Match detected stars to catalogue stars on the tangent plane, allowing any rotation, either parity (a mirrored
 * image) and a scale within [scaleMin, scaleMax]: triangles of the brightest stars of both lists (sides within the field)
 * are compared by their side ratios (Groth 1986; Valdes et al. 1995); every pair of similar triangles proposes a
 * similarity transform, the proposals are binned, and the best-supported ones are checked against all stars: the one
 * that brings the most detected stars within `tol` px of a catalogue star wins, refined on those stars.
 * @param det  [{ x, y }] pixels, brightest first
 * @param cat  [{ x, y }] standard coordinates in arcsec (x east, y north), brightest first
 * @param opts { scaleMin, scaleMax [arcsec/px], nDet = 22, nCat (default from the areas), tol = 2.5 px, ratioTol = 0.008,
 *               fieldPx (longest image side, px), cx, cy (image centre, px) }
 * @returns null, or { T (pixel offsets from (cx, cy) -> arcsec), pairs: [[iDet, iCat]], nMatch, rms [px], chance (expected random matches), tried }
 */
export function matchCatalog(det, cat, opts = {}) {
  const { scaleMin = 0.1, scaleMax = 60, tol = 2.5, ratioTol = 0.008 } = opts;
  const cx = opts.cx ?? 0, cy = opts.cy ?? 0, fieldPx = opts.fieldPx ?? 1000, minPx = opts.minPx ?? fieldPx;
  const D = det.map((s) => ({ x: s.x - cx, y: s.y - cy })), nD = Math.min(D.length, opts.nDet ?? 22);
  if (nD < 4 || cat.length < 4) return null;
  // catalogue stars to form triangles from: enough to hold the detected ones wherever the field is within the list
  const sMid = Math.sqrt(scaleMin * scaleMax), fieldArea = (opts.areaPx ?? fieldPx * minPx) * sMid * sMid;
  let ex = Infinity, ey = Infinity, fx = -Infinity, fy = -Infinity; for (const c of cat) { ex = Math.min(ex, c.x); fx = Math.max(fx, c.x); ey = Math.min(ey, c.y); fy = Math.max(fy, c.y); }
  const catArea = Math.max(fieldArea, (fx - ex) * (fy - ey) * 0.785);
  const nC = Math.min(cat.length, opts.nCat ?? Math.max(nD + 6, Math.min(260, Math.ceil(2.2 * nD * catArea / fieldArea))));
  const minSide = Math.max(8, 0.06 * minPx), maxSideDet = 0.8 * minPx;           // triangles that fit inside the field whatever its rotation
  const TD = triangles(D, nD, minSide, maxSideDet), TC = triangles(cat, nC, minSide * scaleMin, maxSideDet * scaleMax);
  if (!TD.length || !TC.length) return null;
  // hash the catalogue triangles by their side ratios
  const bin = ratioTol, H = new Map(), hk = (a, b) => a * 4096 + b;
  for (let t = 0; t < TC.length; t++) { const k = hk(Math.floor(TC[t].r1 / bin), Math.floor(TC[t].r2 / bin)); let a = H.get(k); if (!a) H.set(k, a = []); a.push(t); }
  // proposals, binned in (parity, log scale, rotation, translation)
  const votes = new Map(), lsBin = 0.02, rotBin = 2 * D2R, trBin = Math.max(6 * tol, 0.04 * fieldPx) * sMid;
  for (const td of TD) {
    const i1 = Math.floor(td.r1 / bin), i2 = Math.floor(td.r2 / bin);
    for (let a = i1 - 1; a <= i1 + 1; a++) for (let b = i2 - 1; b <= i2 + 1; b++) {
      const list = H.get(hk(a, b)); if (!list) continue;
      for (const t of list) {
        const tc = TC[t]; if (Math.abs(tc.r1 - td.r1) > ratioTol || Math.abs(tc.r2 - td.r2) > ratioTol) continue;
        const s = tc.L / td.L; if (s < scaleMin || s > scaleMax) continue;
        const mirror = tc.o !== td.o, T = similarity(td.v.map((i, k) => [D[i].x, D[i].y, cat[tc.v[k]].x, cat[tc.v[k]].y]), mirror);
        const key = `${mirror ? 1 : 0}|${Math.round(Math.log(T.scale) / lsBin)}|${Math.round(T.rotation / rotBin)}|${Math.round(T.tx / (trBin * T.scale / sMid))}|${Math.round(T.ty / (trBin * T.scale / sMid))}`;
        const e = votes.get(key); if (e) e.n++; else votes.set(key, { n: 1, T });
      }
    }
  }
  if (!votes.size) return null;
  const cand = [...votes.values()].sort((p, q) => q.n - p.n).slice(0, opts.maxTries ?? 60);
  // check each against every detected star
  const nV = Math.min(D.length, opts.nVerify ?? 80);
  let best = null;
  for (const c of cand) {
    let T = c.T, pairs = [];
    for (let it = 0; it < 5; it++) {
      const G = grid(cat, Math.max(1e-6, tol * T.scale * 2)), taken = new Set(); pairs = [];
      const r = (it === 0 ? 2 : 1) * tol * T.scale;
      for (let i = 0; i < nV; i++) { const [X, Y] = apply(T, D[i].x, D[i].y), j = G.nearest(X, Y, r, taken); if (j >= 0) { taken.add(j); pairs.push([i, j]); } }
      if (pairs.length < 3) break;
      const T2 = similarity(pairs.map(([i, j]) => [D[i].x, D[i].y, cat[j].x, cat[j].y]), T.mirror);
      if (!(T2.scale >= scaleMin * 0.9 && T2.scale <= scaleMax * 1.1)) break;
      T = T2;
    }
    if (pairs.length < 3) continue;
    let q = 0; for (const [i, j] of pairs) { const [X, Y] = apply(T, D[i].x, D[i].y); q += (X - cat[j].x) ** 2 + (Y - cat[j].y) ** 2; }
    const rms = Math.sqrt(q / pairs.length) / T.scale;
    if (!best || pairs.length > best.nMatch || (pairs.length === best.nMatch && rms < best.rms)) best = { T, pairs, nMatch: pairs.length, rms, votes: c.n };
  }
  if (!best) return null;
  // matches expected by chance: detected stars times the chance that a catalogue star lies within tol px of a random point
  const inField = cat.filter((p) => { const u = p.x - best.T.tx, v = p.y - best.T.ty; return Math.hypot(u, v) < 0.5 * Math.hypot(fieldPx, minPx) * best.T.scale; }).length;
  const dens = inField / (Math.PI * (0.5 * Math.hypot(fieldPx, minPx)) ** 2);
  best.chance = nV * dens * Math.PI * tol * tol; best.tried = cand.length; best.triangles = [TD.length, TC.length]; best.nDet = nD; best.nCat = nC;
  return best;
}

/** Approximate pixel-to-sky WCS from a similarity transform of matchCatalog (pixels offset from cx, cy -> arcsec about ra0, dec0). */
function wcsFromSimilarity(T, ra0, dec0, cx, cy, width, height) {
  // X = a u - b m v + tx, Y = b u + a m v + ty   (u = x - cx, v = y - cy; m = -1 when mirrored), arcsec
  const m = T.mirror ? -1 : 1, cd = [T.a / 3600, -T.b * m / 3600, T.b / 3600, T.a * m / 3600];
  const [ra, dec] = tanDeproject(T.tx / 3600, T.ty / 3600, ra0, dec0);
  return makeWcs({ crval: [ra, dec], crpix: [cx + 1, cy + 1], cd, width, height });
}

/**
 * Solve a frame: the WCS that maps detected stars onto catalogue stars.
 * @param stars    [{ x, y, flux? }] detected on the frame, brightest first
 * @param catalog  [{ ra, dec, g? }] brightest first, around the pointing
 * @param opts     { width, height, ra, dec (approximate pointing, deg), scale (arcsec/px, approximate), scaleTol = 0.15,
 *                   scaleMin, scaleMax (instead of scale), sipOrder: 0 | 2 | 3 | 'auto' (default 'auto': order 2 kept when
 *                   it lowers the AICc, needs 20 matches), tol = 2.5 px (first match), matchTol (final, default 3 x the rms, 1 to 3 px),
 *                   catalogDepth = 2 (catalogue stars used per detected star and field area; 'all' for every one) }
 * @returns { ok, message, wcs, nMatch, rms [arcsec], rmsPx, matches: [{ star, cat, x, y, ra, dec, dx, dy (arcsec), d }],
 *            chance, scale, rotation, flipped, offset (arcmin between the given pointing and the solved centre), sip }
 */
export function solveField(stars, catalog, opts = {}) {
  const { width, height, ra, dec } = opts;
  if (!(width > 0 && height > 0)) throw new Error('the image size is needed');
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new Error('an approximate pointing (RA, Dec) is needed');
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  let sMin = opts.scaleMin, sMax = opts.scaleMax;
  if (opts.scale > 0) { const t = opts.scaleTol ?? 0.15; sMin = opts.scale * (1 - t); sMax = opts.scale * (1 + t); }
  if (!(sMin > 0 && sMax > sMin)) { sMin = 0.1; sMax = 60; }
  const cat = catalog.map((c) => { const [x, y] = tanProject(c.ra, c.dec, ra, dec); return { x: x * 3600, y: y * 3600 }; });
  // only as deep as the frame: about twice as many catalogue stars per field as stars detected (fainter ones only add
  // chance coincidences); the catalogue is brightest first, so the indices of the matches still point into it
  let rCat = 0; for (const c of cat) if (Number.isFinite(c.x)) rCat = Math.max(rCat, Math.hypot(c.x, c.y));
  const sMid = Math.sqrt(sMin * sMax), areaRatio = Math.max(1, Math.PI * rCat * rCat / (width * height * sMid * sMid));
  const nUse = opts.catalogDepth === 'all' ? cat.length : Math.max(40, Math.ceil((opts.catalogDepth ?? 2) * stars.length * areaRatio));
  const keep = cat.map((c, i) => (Number.isFinite(c.x) && i < nUse ? i : -1)).filter((i) => i >= 0), catK = keep.map((i) => cat[i]);
  const M = matchCatalog(stars, catK, { scaleMin: sMin, scaleMax: sMax, tol: opts.tol ?? 2.5, cx, cy, fieldPx: Math.max(width, height), minPx: Math.min(width, height), nDet: opts.nDet, nCat: opts.nCat });
  const fail = (message, extra = {}) => ({ ...extra, ok: false, message });
  if (!M) return fail('no consistent match between the detected stars and the catalogue');
  const nNeed = opts.minMatch ?? Math.max(6, Math.ceil(2 * M.chance + 3));
  if (M.nMatch < nNeed) return fail(`only ${M.nMatch} stars matched (${nNeed} needed; ${M.chance.toFixed(1)} expected by chance)`, { nMatch: M.nMatch, chance: M.chance });
  // first WCS from the similarity, then rematch every detected star to the projected catalogue and fit
  let W = wcsFromSimilarity(M.T, ra, dec, cx, cy, width, height), pairs = [], tolPx = opts.tol ?? 2.5, sip = 0;
  const fitWith = (pp, order) => fitWcs(pp.map(([i, j]) => ({ x: stars[i].x, y: stars[i].y, ra: catalog[keep[j]].ra, dec: catalog[keep[j]].dec })), { crpix: [cx + 1, cy + 1], sipOrder: order, width, height });
  for (let it = 0; it < 6; it++) {
    const P = keep.map((k) => { const [x, y] = W.skyToPix(catalog[k].ra, catalog[k].dec); return { x, y }; });
    const G = grid(P.map((p) => (Number.isFinite(p.x) ? p : { x: 1e12, y: 1e12 })), Math.max(1, tolPx * 2)), taken = new Set(), next = [];
    for (let i = 0; i < stars.length; i++) { const j = G.nearest(stars[i].x, stars[i].y, tolPx, taken); if (j >= 0) { taken.add(j); next.push([i, j]); } }
    if (next.length < 4) break;
    pairs = next;
    // clip outliers beyond 3 rms (a blend, a double star, a wrong match), with the model chosen
    const clip = (pp, order) => { let F = fitWith(pp, order); const lim = Math.max(3 * F.rmsPx, 0.3), kept = pp.filter((_, k) => F.residuals[k].d / F.scale <= lim); if (kept.length >= 4 && kept.length < pp.length) { pp = kept; F = fitWith(pp, order); } return [F, pp]; };
    let F;
    if ((opts.sipOrder === 'auto' || opts.sipOrder == null) && pairs.length >= 20 && it >= 1) {
      // distortion: SIP order 2 when it lowers the corrected Akaike information criterion, judged on the stars SIP keeps
      // (clipping with the linear fit first would throw away the corners that show the distortion)
      const [S, ps] = clip(pairs, 2), L = fitWith(ps, 0), n2 = 2 * ps.length, aicc = (f, k) => n2 * Math.log(f.rms * f.rms) + 2 * k + 2 * k * (k + 1) / (n2 - k - 1);
      sip = aicc(S, 12) < aicc(L, 6) - 2 ? 2 : 0;
      if (sip) { F = S; pairs = ps; } else [F, pairs] = clip(pairs, 0);
    } else {
      sip = Number.isFinite(opts.sipOrder) && opts.sipOrder >= 2 && pairs.length >= 3 * (opts.sipOrder + 1) * (opts.sipOrder + 2) / 2 ? opts.sipOrder : 0;
      [F, pairs] = clip(pairs, sip);
    }
    W = F;
    tolPx = opts.matchTol ?? Math.min(3, Math.max(1, 3 * F.rmsPx));
  }
  if (!W.residuals) return fail('the match could not be refined', { nMatch: M.nMatch, chance: M.chance });
  const matches = pairs.map(([i, j], k) => ({ star: i, cat: keep[j], x: stars[i].x, y: stars[i].y, ra: catalog[keep[j]].ra, dec: catalog[keep[j]].dec, ...W.residuals[k] }));
  const [rc, dc] = W.pixToSky(cx, cy);
  const res = { ok: true, wcs: W, nMatch: W.n, rms: W.rms, rmsPx: W.rmsPx, matches, chance: M.chance, scale: W.scale, rotation: W.rotation, flipped: W.flipped, sip: W.sip ? W.sip.order : 0, offset: separation(ra, dec, rc, dc) / 60, centre: [rc, dc], firstMatch: { nMatch: M.nMatch, votes: M.votes, tried: M.tried, triangles: M.triangles } };
  // matches expected by chance at the final tolerance: the catalogue stars that land on the frame, spread evenly
  const onFrame = keep.filter((k) => { const [x, y] = W.skyToPix(catalog[k].ra, catalog[k].dec); return x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1; }).length;
  res.chance = stars.length * Math.min(1, onFrame / (width * height) * Math.PI * tolPx * tolPx); res.onFrame = onFrame;
  const need = opts.minMatch ?? Math.max(8, Math.ceil(3 * res.chance + 5));
  if (res.nMatch < need) return fail(`only ${res.nMatch} stars matched after refining (${need} needed; ${res.chance.toFixed(1)} expected by chance)`, res);
  if (res.rmsPx > 1) return fail(`the fit leaves ${res.rmsPx.toFixed(2)} px rms: not a reliable solution`, res);
  res.message = `${res.nMatch} stars matched, rms ${res.rms.toFixed(2)}″ (${res.rmsPx.toFixed(2)} px)${res.sip ? ', SIP order ' + res.sip : ''}; ${res.scale.toFixed(3)}″/px, ${res.flipped ? 'mirrored, ' : ''}north ${res.rotation.toFixed(1)}° from +y`;
  return res;
}

/**
 * Stars to solve with: detectSources, then each position refined by a Gaussian fit (detectSources' box centroid is
 * pulled by neighbours and the sky on undersampled frames; on the HAT-P-32 b frame the fit takes the solution's rms
 * from 2.5″ to 0.7″). A fit that fails or moves more than 2 px keeps the box centroid.
 * @returns { sources, background, sigma } as detectSources, brightest first
 */
export function starsForSolving(data, w, h, opts = {}) {
  const det = detectSources(data, w, h, { max: opts.max ?? 120, saturation: opts.saturation ?? Infinity });
  const half = opts.half ?? 5;
  det.sources = det.sources.map((s) => { const f = fitPsf(data, w, h, s.x, s.y, half, { model: 'gaussian' }); return f.ok && Math.hypot(f.x - s.x, f.y - s.y) < 2 ? { ...s, x: f.x, y: f.y, boxX: s.x, boxY: s.y } : s; });
  return det;
}

/** The WCS of another frame: pixToSky through a similarity T taking that frame's pixels to the solved frame's (fitSimilarity of src/core/photometry.js: X = a x - b y + tx ...). */
export function wcsThrough(W, T) {
  if (!T) return W;
  const inv = (() => { const s2 = T.a * T.a + T.b * T.b; return (X, Y) => { const dx = X - T.tx, dy = Y - T.ty, x = (T.a * dx + T.b * dy) / s2, yy = (-T.b * dx + T.a * dy) / s2; return [x, T.mirror ? -yy : yy]; }; })();
  const fwd = (x, y) => { const yy = T.mirror ? -y : y; return [T.a * x - T.b * yy + T.tx, T.b * x + T.a * yy + T.ty]; };
  return { ...W, pixToSky: (x, y) => { const [X, Y] = fwd(x, y); return W.pixToSky(X, Y); }, skyToPix: (ra, dec) => { const [X, Y] = W.skyToPix(ra, dec); return inv(X, Y); } };
}

// ---------------------------------------------------------------------------------------------------------
// Catalogue queries (URLs and parsers; the page fetches)

/** VizieR ASU-TSV query of Gaia DR3 (I/355/gaiadr3) around (ra, dec) within radius arcmin, brightest first. */
export function gaiaConeUrl(base, ra, dec, radiusArcmin, { gmax = 19, max = 2500 } = {}) {
  const p = [['-source', 'I/355/gaiadr3'], ['-c', `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`], ['-c.rm', radiusArcmin.toFixed(2)], ['-out', 'Source,RA_ICRS,DE_ICRS,Gmag,BP-RP,pmRA,pmDE,VarFlag'], ['-out.max', max], ['-sort', 'Gmag'], ['Gmag', `<${gmax}`]];
  return `${base.replace(/\/$/, '')}/viz-bin/asu-tsv?` + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}
/** VizieR query of the AAVSO International Variable Star Index (B/vsx/vsx). */
export function vsxConeUrl(base, ra, dec, radiusArcmin, { max = 500 } = {}) {
  const p = [['-source', 'B/vsx/vsx'], ['-c', `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`], ['-c.rm', radiusArcmin.toFixed(2)], ['-out', 'Name,RAJ2000,DEJ2000,Type,max,min,n_max'], ['-out.max', max]];
  return `${base.replace(/\/$/, '')}/viz-bin/asu-tsv?` + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}
/** CDS Sesame name resolver (the VizieR mirrors serve it with CORS): -oI/A gives the J2000 position in a %J line. */
export function sesameUrl(base, name) { return `${base.replace(/\/$/, '')}/viz-bin/nph-sesame/-oI/A?${encodeURIComponent(name.trim())}`; }

// rows of the first table of an ASU-TSV answer as objects; throws on a server error
function tsvRows(text, parseASU) {
  const r = parseASU(text); if (r.status === 'error') throw new Error(r.message);
  const tb = r.tables[0]; if (!tb) return [];
  return tb.rows.map((row) => Object.fromEntries(tb.columns.map((c, i) => [c, row[i]])));
}
const numOr = (v) => (v === '' || v == null ? NaN : Number(v));
/** Gaia stars from gaiaConeUrl's answer: [{ source, ra, dec, g, bprp, pmra, pmdec (mas/yr), variable }], brightest first. */
export function parseGaia(text, parseASU) {
  return tsvRows(text, parseASU).map((r) => ({ source: String(r.Source || '').trim(), ra: numOr(r.RA_ICRS), dec: numOr(r.DE_ICRS), g: numOr(r.Gmag), bprp: numOr(r['BP-RP']), pmra: numOr(r.pmRA), pmdec: numOr(r.pmDE), variable: /^VARIABLE/i.test(String(r.VarFlag || '').trim()) }))
    .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec)).sort((a, b) => (Number.isFinite(a.g) ? a.g : 99) - (Number.isFinite(b.g) ? b.g : 99));
}
/** VSX stars from vsxConeUrl's answer: [{ name, ra, dec, type, max, min, band }]. */
export function parseVsx(text, parseASU) {
  return tsvRows(text, parseASU).map((r) => ({ name: String(r.Name || '').trim(), ra: numOr(r.RAJ2000), dec: numOr(r.DEJ2000), type: String(r.Type || '').trim(), max: numOr(r.max), min: numOr(r.min), band: String(r.n_max || '').trim() })).filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec));
}
/** Sesame's answer: { ra, dec } in degrees, or null when the name is unknown. */
export function parseSesame(text) {
  const m = /^%J\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)/m.exec(String(text || ''));
  return m ? { ra: +m[1], dec: +m[2] } : null;
}
/** Gaia DR3 positions (epoch 2016.0) moved to a Julian year with their proper motions (stars without one are left). */
export function atEpoch(stars, year) {
  const dt = year - 2016.0;
  if (!Number.isFinite(dt) || Math.abs(dt) < 1e-3) return stars;
  return stars.map((s) => (Number.isFinite(s.pmra) && Number.isFinite(s.pmdec) ? { ...s, ra: s.ra + s.pmra * dt / 3.6e6 / Math.cos(s.dec * D2R), dec: s.dec + s.pmdec * dt / 3.6e6 } : s));
}
