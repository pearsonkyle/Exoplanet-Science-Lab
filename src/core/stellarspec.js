// Stellar spectra from a model-atmosphere grid: the flux leaving the surface as a function of effective temperature,
// surface gravity and metallicity, and the pieces an SED fit is built from (resampling, synthetic photometry, the
// flux at Earth for a given angular diameter). The grid (public/stellar/phoenix.esls, tools/stellar/build_spectra.py)
// is made from the same PHOENIX-ACES specific intensities as the limb darkening table (Husser et al. 2013), integrated
// over the disc: 0.1 to 5.5 micron in 420 bins (R about 105), Teff 2300-8000 K, log g 4.0-5.5, [Fe/H] -0.5 to +0.5.
// No DOM; the host supplies the file's bytes.
import { planckSI } from './phasecurve.js';
import { C } from './derive.js';

const MAGIC = 0x534c5345;   // 'ESLS'

/** Parse an ESLS file: { teff, logg, feh, wl (bin centres), edges [micron], nWl, codes, lo, step, source, ... }. */
export function parseStellar(buffer) {
  const dv = new DataView(buffer); if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a stellar flux grid (ESLS)');
  const len = dv.getUint32(8, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, len))), n = h.wl.n;
  const codes = new Uint16Array(buffer.slice(12 + len, 12 + len + 2 * h.feh.length * h.logg.length * h.teff.length * n));
  const edges = Float64Array.from({ length: n + 1 }, (_, i) => h.wl.min * Math.pow(h.wl.max / h.wl.min, i / n)), wl = Float64Array.from({ length: n }, (_, i) => Math.sqrt(edges[i] * edges[i + 1]));
  return { ...h, nWl: n, wl, edges, codes, lo: h.encoding.lo, step: (h.encoding.hi - h.encoding.lo) / 65534 };
}

const bracket = (a, x) => { const n = a.length; if (n === 1 || x <= a[0]) return [0, 0]; if (x >= a[n - 1]) return [n - 2, 1]; let i = 0; while (a[i + 1] < x) i++; return [i, (x - a[i]) / (a[i + 1] - a[i])]; };

/**
 * Surface flux [W m^-2 micron^-1] on the grid's own bins for a star { teff, logg = 4.5, feh = 0 }: linear in the three
 * parameters on log flux. Parameters outside the grid are held at its edge (`clamped` says which); a node without a
 * model (the grid has 519 of 624) is left out and the weights of the others rescaled.
 * Returns { wl, edges, flux: Float64Array, clamped: [names], used: number of models that entered }.
 */
export function stellarFlux(grid, { teff, logg = 4.5, feh = 0 }) {
  if (!(teff > 0)) throw new Error('the star needs an effective temperature');
  const { nWl: n, codes, lo, step } = grid, nT = grid.teff.length, nG = grid.logg.length;
  const [it, ft] = bracket(grid.teff, teff), [ig, fg] = bracket(grid.logg, logg), [iz, fz] = bracket(grid.feh, feh), acc = new Float64Array(n);
  const clamped = [['teff', teff, grid.teff], ['logg', logg, grid.logg], ['feh', feh, grid.feh]].filter(([, v, a]) => v < a[0] - 1e-9 || v > a[a.length - 1] + 1e-9).map((x) => x[0]);
  let wsum = 0, used = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    const w = (a ? fz : 1 - fz) * (b ? fg : 1 - fg) * (c ? ft : 1 - ft); if (!(w > 0)) continue;
    const o = (((Math.min(iz + a, grid.feh.length - 1)) * nG + Math.min(ig + b, nG - 1)) * nT + Math.min(it + c, nT - 1)) * n; if (codes[o + (n >> 1)] === 0) continue;
    for (let i = 0; i < n; i++) acc[i] += w * (lo + (codes[o + i] - 1) * step); wsum += w; used++;
  }
  if (!used) throw new Error(`no model near Teff ${teff} K, log g ${logg}, [Fe/H] ${feh}`);
  // the grid's models are at their nominal temperature only to a per cent or so: nothing is rescaled here
  return { wl: grid.wl, edges: grid.edges, flux: Float64Array.from(acc, (v) => Math.pow(10, v / wsum)), clamped, used };
}

/**
 * How a photosphere departs from a blackbody of its effective temperature beyond the models' last wavelength, relative
 * to 4 micron: (lambda / 4)^-0.08. The opacity of H- grows with wavelength, so longer wavelengths come from higher,
 * cooler layers: the Sun's brightness temperature falls from about 5600 K at 4 micron to about 5000 K at 10 and 4800 K at
 * 20 (0.89 and 0.86 of the 4 micron ratio; this gives 0.93 and 0.88). An approximation, used for every star of the grid.
 */
export const tailShape = (wl) => Math.pow(wl / 4, -0.08);

/**
 * The spectrum of stellarFlux averaged onto other bins [micron] (edges ascending). Beyond the grid's last wavelength
 * a blackbody of the star's temperature is joined on, scaled to the model in its 3.6-4.2 micron window and lowered
 * slowly with wavelength (tailShape); no dust, no chromosphere. Shortward of the grid's first wavelength, nothing.
 */
export function resampleFlux(spec, edges, teff) {
  const { edges: e, flux } = spec, n = flux.length, last = e[n], cum = new Float64Array(n + 1); for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + flux[i] * (e[i + 1] - e[i]);
  // the tail's level: the model against the blackbody in the window from 3.6 to 4.2 micron (median), not in its last
  // bins, which lie in the CO fundamental band in cool stars
  const rat = []; for (let i = 0; i < n; i++) { const c = Math.sqrt(e[i] * e[i + 1]); if (c >= 3.6 && c <= 4.2) rat.push(flux[i] / planckSI(c, teff)); } rat.sort((x, y) => x - y);
  const scale = rat.length ? rat[rat.length >> 1] : flux[n - 1] / planckSI(Math.sqrt(e[n - 1] * e[n]), teff);
  const tail = (a, b) => { let s = 0; const m = 24; for (let k = 0; k < m; k++) { const x0 = a * Math.pow(b / a, k / m), x1 = a * Math.pow(b / a, (k + 1) / m), c = Math.sqrt(x0 * x1); s += scale * tailShape(c) * planckSI(c, teff) * (x1 - x0); } return s; };
  const upTo = (x) => { if (x <= e[0]) return 0; if (x >= last) return cum[n] + (x > last ? tail(last, x) : 0); let i = Math.min(n - 1, Math.floor((Math.log(x / e[0]) / Math.log(last / e[0])) * n)); while (i > 0 && e[i] > x) i--; while (i < n - 1 && e[i + 1] < x) i++; return cum[i] + flux[i] * (x - e[i]); };
  const out = new Float64Array(edges.length - 1); let prev = upTo(edges[0]);
  for (let i = 0; i < out.length; i++) { const next = upTo(edges[i + 1]); out[i] = (next - prev) / (edges[i + 1] - edges[i]); prev = next; }
  return out;
}

/**
 * Mean flux density of a spectrum through a passband { wl: [micron], response: [] }, photon counting (the weight is
 * response x wavelength), the convention of Gaia, 2MASS, WISE and SDSS magnitudes:
 *   <F> = int F R lambda dlambda / int R lambda dlambda.
 * spec: { edges, flux } as stellarFlux returns (teff is needed for the tail beyond 5.5 micron).
 */
export function bandFlux(spec, band, teff) {
  const w = band.wl, m = w.length, edges = new Float64Array(m + 1); edges[0] = w[0] - 0.5 * (w[1] - w[0]); edges[m] = w[m - 1] + 0.5 * (w[m - 1] - w[m - 2]); for (let i = 1; i < m; i++) edges[i] = 0.5 * (w[i - 1] + w[i]);
  const f = resampleFlux(spec, edges, teff); let a = 0, b = 0;
  for (let i = 0; i < m; i++) { const k = band.response[i] * w[i] * (edges[i + 1] - edges[i]); a += k * f[i]; b += k; }
  return a / b;
}

/** Bolometric flux of a spectrum [W m^-2]: the grid's range plus the Rayleigh-Jeans tail to 1000 micron. */
export function bolometric(spec, teff) { const e = spec.edges; return resampleFlux(spec, [e[0], 1000], teff)[0] * (1000 - e[0]); }

/** Flux at the observer from the surface flux: (R / d)^2, with the radius in solar radii and the distance in parsec. */
export const dilution = (rstarSun, distancePc) => ((rstarSun * C.Rsun) / (distancePc * 3.0856775814913673e16)) ** 2;
