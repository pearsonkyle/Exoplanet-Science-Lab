// What the 3D atmosphere view draws, computed without three.js so it can be tested in Node (test/atmosphere.test.mjs):
// the display radius of each level, radial colour strips for the cutaway, and the colour of starlight that has
// crossed the limb at each impact parameter.

import { cmfX, cmfY, cmfZ, xyzToLinearSRGB } from '../core/colour.js';

/**
 * Display radii of the levels, as fractions of the outer radius. The real atmosphere is a thin skin (`trueFraction`
 * of the radius between the bottom and top levels), so the cutaway stretches it: the opaque interior fills `core`
 * of the radius and the levels are spread uniformly in log pressure above it.
 * Returns { disp: Float32Array(n + 1) top first, real: Float32Array(n + 1), trueFraction }.
 */
export function levelRadii(atm, core = 0.5) {
  const n = atm.n, disp = new Float32Array(n + 1), real = new Float32Array(n + 1), a = Math.log(atm.pLev[0]), b = Math.log(atm.pLev[n]);
  for (let k = 0; k <= n; k++) { disp[k] = core + ((1 - core) * (b - Math.log(atm.pLev[k]))) / (b - a); real[k] = atm.rLev[k] / atm.rLev[0]; }
  return { disp, real, trueFraction: 1 - atm.rLev[n] / atm.rLev[0] };
}

/**
 * A radial colour strip, centre to edge: RGBA bytes, `size` texels. Texels inside `core` get `coreColour`; above it
 * the colour of the layer that holds that display radius, from `colourOf(value)`; `marks` (level indices, may be
 * fractional) are drawn as thin white rings.
 *   values: one per layer, top first; radii: from levelRadii
 */
export function radialStrip(values, radii, colourOf, { size = 512, coreColour = [18, 20, 26], marks = [], markColour = [255, 64, 64] } = {}) {
  const n = values.length, out = new Uint8Array(size * 4), core = radii.disp[n];
  const markR = marks.filter((m) => m >= 0 && m <= n).map((m) => { const i = Math.min(n - 1, Math.floor(m)), f = m - i; return radii.disp[i] + f * (radii.disp[i + 1] - radii.disp[i]); });
  for (let x = 0; x < size; x++) {
    const r = (x + 0.5) / size; let c = coreColour;
    if (r >= core) { let j = n - 1; while (j > 0 && radii.disp[j] < r) j--; c = colourOf(values[j], j); }
    if (markR.some((m) => Math.abs(r - m) < 1.6 / size)) c = markColour;
    out[4 * x] = c[0]; out[4 * x + 1] = c[1]; out[4 * x + 2] = c[2]; out[4 * x + 3] = 255;
  }
  return out;
}

/**
 * The level (fractional index, top = 0) where the limb's transmittance at wavelength index i falls to `at`
 * (0.5 by default: half the starlight gets through). trans: Float32Array(nWl * (n + 1)). NaN if it never does.
 */
export function opaqueLevel(trans, i, n, at = 0.5) {
  const o = i * (n + 1);
  for (let k = 1; k <= n; k++) if (trans[o + k] <= at) { const a = trans[o + k - 1], b = trans[o + k]; return k - 1 + (a - at) / (a - b || 1); }
  return NaN;
}

/**
 * Which display wavelength [nm] a wavelength [micron] is drawn at.
 *   map = null: its own (true colour; only 0.38-0.75 micron is visible)
 *   map = { from: [a, b] }: the range a..b micron is laid over 400..700 nm, uniformly in log wavelength, so that the
 *   shortest wavelength of the data is drawn blue and the longest red (false colour, in the order of the spectrum)
 */
export function displayNm(wl, map = null) {
  if (!map) return wl * 1000;
  const [a, b] = map.from; return 400 + (300 * Math.log(wl / a)) / Math.log(b / a);
}

/** Does a wavelength grid [micron] reach across the visible (0.42 to 0.68 micron)? Then true colour can be shown. */
export const coversVisible = (wl) => wl.length > 1 && Math.min(wl[0], wl[wl.length - 1]) <= 0.42 && Math.max(wl[0], wl[wl.length - 1]) >= 0.68;

/**
 * Weights that turn a spectrum on the grid wl [micron] into a display colour.
 *   true colour (map null): the star's blackbody (teff) times the colour-matching functions: what the eye would get
 *   mapped: an equal-energy illuminant over the mapped range, so the colours say how a quantity varies across the
 *   data's wavelengths, not what an eye would see
 * Returns { idx, w: Float64Array(3 idx.length) (X, Y, Z weight of each used wavelength), ref: [r, g, b] linear sRGB of
 * the illuminant itself, mapped: bool }.
 */
export function displayWeights(wl, { map = null, teff = 5772 } = {}) {
  const idx = [], lo = map ? map.from[0] : 0.38, hi = map ? map.from[1] : 0.75;
  for (let i = 0; i < wl.length; i++) if (wl[i] >= lo && wl[i] <= hi) idx.push(i);
  const w = new Float64Array(3 * idx.length), sum = [0, 0, 0];
  idx.forEach((i, q) => {
    const nm = displayNm(wl[i], map), a = idx[Math.max(0, q - 1)], b = idx[Math.min(idx.length - 1, q + 1)];
    const width = Math.abs(displayNm(wl[b], map) - displayNm(wl[a], map)) / ((q > 0 ? 1 : 0) + (q < idx.length - 1 ? 1 : 0) || 1);   // the bin's width in display nm
    const s = width * (map ? 1 : 1e15 / ((wl[i] * 1000) ** 5 * Math.expm1(1.438776877e7 / (wl[i] * 1000 * teff))));
    w[3 * q] = s * cmfX(nm); w[3 * q + 1] = s * cmfY(nm); w[3 * q + 2] = s * cmfZ(nm);
    sum[0] += w[3 * q]; sum[1] += w[3 * q + 1]; sum[2] += w[3 * q + 2];
  });
  return { idx, w, ref: xyzToLinearSRGB(sum), mapped: !!map };
}

/**
 * A quantity that multiplies the illuminant (a transmittance, an albedo, a flux ratio to the star), as factors on
 * the illuminant's linear sRGB: (1, 1, 1) leaves it unchanged. f(i) is the quantity at wavelength index i.
 * Factors can leave 0..1 a little (the sRGB primaries are not the colour-matching functions); `clamp` holds them in.
 */
export function displayFactors(dw, f, clamp = true) {
  const xyz = [0, 0, 0];
  dw.idx.forEach((i, q) => { const v = f(i); xyz[0] += v * dw.w[3 * q]; xyz[1] += v * dw.w[3 * q + 1]; xyz[2] += v * dw.w[3 * q + 2]; });
  const rgb = xyzToLinearSRGB(xyz);
  return rgb.map((c, k) => { const v = dw.ref[k] > 0 ? c / dw.ref[k] : 0; return clamp ? Math.max(0, v) : v; });
}

/**
 * Colour of starlight after crossing the limb, per level: the star's spectrum times the transmittance, through the
 * colour-matching functions, divided by the same without the atmosphere. Linear sRGB factors (1, 1, 1 = unchanged,
 * 0 = blocked), which multiply the star's colour behind the planet.
 *   wl [micron], trans: Float32Array(nWl * (n + 1)); teff: the star's temperature, or display weights (displayWeights)
 * Returns Float32Array(3 (n + 1)), top first.
 */
export function limbColours(wl, trans, n, teff = 5772) {
  const dw = typeof teff === 'object' ? teff : displayWeights(wl, { teff }), out = new Float32Array(3 * (n + 1));
  if (!dw.idx.length) return out.fill(1);
  for (let k = 0; k <= n; k++) { const rgb = displayFactors(dw, (i) => trans[i * (n + 1) + k]); for (let c = 0; c < 3; c++) out[3 * k + c] = Math.min(1, rgb[c]); }
  return out;
}

/**
 * From the limb's transmittance to an extinction coefficient of every layer, per colour channel (onion peeling): the
 * values that, on straight chords through uniform shells, give back the transmittance of the ray tangent at each
 * level. The ray-marched view draws these, so its limb is the model's limb.
 *   colours: Float32Array(3 (n + 1)) from limbColours; real: level radii over the top radius, top first
 * Returns Float32Array(3 n), in units of 1 / (top radius). Where the limb is already black (transmittance under
 * 1e-4) the extinction keeps growing as it did over the last resolved layer.
 */
export function shellExtinction(colours, real) {
  const n = real.length - 1, out = new Float32Array(3 * n), half = (rj, b) => Math.sqrt(Math.max(0, rj * rj - b * b));
  for (let c = 0; c < 3; c++) {
    let growth = 1.5, dark = false;
    for (let k = 1; k <= n; k++) {   // the ray tangent at level k crosses layers 0 .. k - 1
      const b = real[k], T = colours[3 * k + c]; let tau = 0;
      for (let j = 0; j < k - 1; j++) tau += out[3 * j + c] * 2 * (half(real[j], b) - half(real[j + 1], b));
      const L = 2 * half(real[k - 1], b), prev = k > 1 ? out[3 * (k - 2) + c] : 0;
      if (dark || !(T > 1e-4)) { dark = true; out[3 * (k - 1) + c] = Math.max(prev * growth, 1e-3 / L); continue; }
      const beta = Math.max(0, (-Math.log(Math.min(1, T)) - tau) / L);
      if (prev > 0 && beta > prev) growth = Math.min(4, Math.max(1.05, beta / prev));
      out[3 * (k - 1) + c] = beta;
    }
  }
  return out;
}

/**
 * The textures of the ray-marched planet: extinction and scattering coefficients against display radius, from the
 * opaque radius to the top (= 1), `size` texels each (RGBA float; A unused).
 *   beta: Float32Array(3 n) from shellExtinction; scat: Float32Array(3 n) scattering coefficient per channel in the
 *   same units (at most beta); real: level radii over the top radius; inner: the opaque radius over the top radius;
 *   stretch: the shell above `inner` is drawn that many times thicker (coefficients are divided by it, which keeps
 *   every layer's vertical optical depth)
 * Returns { ext, sca: Float32Array(4 size), inner: display opaque radius over the display top radius }.
 */
export function shellTextures(beta, scat, real, inner, stretch = 1, size = 64) {
  const n = real.length - 1, top = inner + (1 - inner) * stretch, ext = new Float32Array(4 * size), sca = new Float32Array(4 * size);
  for (let x = 0; x < size; x++) {
    const r = inner + ((1 - inner) * (x + 0.5)) / size; let j = n - 1; while (j > 0 && real[j] < r) j--;   // layer j: real[j + 1] <= r <= real[j]
    for (let c = 0; c < 3; c++) { ext[4 * x + c] = (beta[3 * j + c] * top) / stretch; sca[4 * x + c] = (Math.min(scat[3 * j + c], beta[3 * j + c]) * top) / stretch; }
    ext[4 * x + 3] = sca[4 * x + 3] = 1;
  }
  return { ext, sca, inner: inner / top, top };
}

/**
 * The limb colours resampled uniformly in impact parameter from the bottom level to the top (for a 1-D texture):
 * Float32Array(4 * size) RGBA, alpha 1. real: levelRadii(...).real.
 */
export function limbTexture(colours, real, size = 256) {
  const n = real.length - 1, out = new Float32Array(4 * size), r0 = real[n], r1 = real[0];
  for (let x = 0; x < size; x++) {
    const r = r0 + ((r1 - r0) * x) / (size - 1); let k = n; while (k > 0 && real[k - 1] <= r) k--;   // real[k] <= r <= real[k - 1]
    const f = k > 0 ? (r - real[k]) / (real[k - 1] - real[k] || 1) : 0, a = k, b = Math.max(0, k - 1);
    for (let c = 0; c < 3; c++) out[4 * x + c] = colours[3 * a + c] + f * (colours[3 * b + c] - colours[3 * a + c]);
    out[4 * x + 3] = 1;
  }
  return out;
}
