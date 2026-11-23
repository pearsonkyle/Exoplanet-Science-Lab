// Thermal emission spectrum of a layered atmosphere (atmosphere.js), without scattering.
//
// Along a direction with cosine mu from the vertical, the intensity leaving the top is the formal solution
//     I(mu) = sum over layers of B(T_j) (e^{-tau_{j-1}/mu} - e^{-tau_j/mu}) + B(T_bottom) e^{-tau_n/mu},
// tau_j the vertical optical depth from the top down to the bottom of layer j, every layer isothermal, and the
// atmosphere below the bottom level a blackbody at the bottom layer's temperature. The emergent flux is
//     F = 2 pi int_0^1 I(mu) mu dmu,
// by Gauss-Legendre quadrature in mu (8 nodes by default; the isothermal-layer sum is the larger error, see
// test/atmosphere.test.mjs, section 3). Plane-parallel: the layers' vertical thickness is used, not the slant through a sphere.
//
// Units: wavelength in micron, extinction in m^-1, flux in W m^-2 per micron at the planet's surface.

import { planckSI } from './phasecurve.js';

/** Gauss-Legendre nodes and weights on [0, 1]. */
export function gaussLegendre01(n) {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5)), dp = 1;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp; z -= dz; if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = 0.5 * (z + 1); w[i] = 1 / ((1 - z * z) * dp * dp);   // 2 / ((1 - z^2) P'^2), halved for [0, 1]
  }
  return { x, w };
}

/**
 * Emergent flux of one wavelength. alpha: extinction per layer [m^-1] at offset o; B: Planck function of each layer.
 * contrib (length n + 1), if given, receives each layer's share of the flux (last entry: the bottom boundary).
 */
export function emergentFlux(atm, alpha, o, B, quad, contrib = null) {
  const n = atm.n, { x, w } = quad;
  let F = 0;
  if (contrib) contrib.fill(0);
  for (let m = 0; m < x.length; m++) {
    const mu = x[m], f = 2 * Math.PI * mu * w[m];
    let tau = 0, tPrev = 1, I = 0;
    for (let j = 0; j < n; j++) {
      tau += alpha[o + j] * atm.dr[j];
      const t = Math.exp(-tau / mu), c = B[j] * (tPrev - t);
      I += c; if (contrib) contrib[j] += f * c; tPrev = t;
    }
    I += B[n - 1] * tPrev; if (contrib) contrib[n] += f * B[n - 1] * tPrev;
    F += f * I;
  }
  return F;
}

/**
 * Emission spectrum. wl: wavelengths in micron (one per row of `extinction`, or per bin with a correlated-k table);
 * extinction: Float64Array(nWl * ng * n) [m^-1].
 *   weights: { ng, w } for a correlated-k table (fluxes of the g-points are averaged with w)
 *   contribution: also return Float32Array(nWl * (n + 1)), each row normalised to sum 1
 *   nmu: quadrature nodes (8)
 * Returns { flux [W m^-2 micron^-1], brightness [K], contribution? }.
 */
export function emissionSpectrum(atm, wl, extinction, { weights = null, contribution = false, nmu = 8 } = {}) {
  const n = atm.n, ng = weights ? weights.ng : 1, nWl = wl.length, quad = gaussLegendre01(nmu);
  const flux = new Float64Array(nWl), B = new Float64Array(n), row = contribution ? new Float64Array(n + 1) : null;
  const contrib = contribution ? new Float32Array(nWl * (n + 1)) : null;
  for (let i = 0; i < nWl; i++) {
    for (let j = 0; j < n; j++) B[j] = planckSI(wl[i], atm.tLay[j]);
    let F = 0;
    for (let q = 0; q < ng; q++) {
      const w = weights ? weights.w[q] : 1;
      F += w * emergentFlux(atm, extinction, (i * ng + q) * n, B, quad, row);
      if (contribution) for (let k = 0; k <= n; k++) contrib[i * (n + 1) + k] += w * row[k];
    }
    flux[i] = F;
    if (contribution && F > 0) for (let k = 0; k <= n; k++) contrib[i * (n + 1) + k] /= F;
  }
  return { flux, brightness: Float64Array.from(flux, (F, i) => brightnessOf(F / Math.PI, wl[i])), contribution: contrib };
}

/** Temperature of the blackbody with intensity I [W m^-2 sr^-1 micron^-1] at wavelength wl [micron]. */
export function brightnessOf(I, wl) {
  if (!(I > 0)) return 0;
  return 14387.768775 / (wl * Math.log1p(1.1910429723971884e8 / (wl ** 5 * I)));
}

/**
 * Planet-to-star flux ratio: (Rp / R*)^2 Fp / F*, the eclipse depth. star: { teff } for a blackbody star, or
 * { flux: Float64Array } with the star's surface flux on the same wavelengths [W m^-2 micron^-1].
 */
export function fluxRatio(wl, planetFlux, rprs, star) {
  const out = new Float64Array(wl.length);
  for (let i = 0; i < wl.length; i++) out[i] = (rprs * rprs * planetFlux[i]) / (star.flux ? star.flux[i] : Math.PI * planckSI(wl[i], star.teff));
  return out;
}
