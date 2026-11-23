// Transmission spectrum of a spherically symmetric atmosphere (atmosphere.js): starlight grazing the limb.
//
// Geometry. One ray per level: impact parameter b_k = rLev[k], k = 1..n (the bottom of layer k - 1). Such a ray
// crosses whole shells only. Inside shell j the temperature and composition are the layer's, so the extinction
// follows the pressure, alpha(r) = alpha_j P(r) / P_j, and P(r) is known in closed form (atmosphere.js). The optical
// depth of the ray is therefore sum_j alpha_j L_kj with the effective length
//     L_kj = 2 int over the ray's path in shell j of P(r(s)) / P_j ds,      r(s) = sqrt(b^2 + s^2),
// which depends on the geometry only and is integrated once by 4-point Gauss-Legendre quadrature in s (the
// integrand is smooth in s, also at the tangent point). Opacity that grows faster than the pressure inside a
// layer (collision-induced absorption, as P^2) is still taken at the layer centre: second order in the thickness.
// The top level has transmittance 1 (nothing above it), the planet below the bottom level is opaque. The absorbing
// area is
//     A = pi r_n^2 + sum over layers of pi (r_k^2 - r_{k+1}^2) x mean of (1 - T) at the layer's two levels,
// the trapezoid rule in b^2, and the transit depth is A / (pi R*^2). No refraction, no scattering into the beam.
//
// The remaining error falls with the number of layers and is reported by test/atmosphere.test.mjs against scipy
// quadrature and the closed form.
//
// Units: extinction in m^-1, radii in metres.

const GL4 = { x: [0.06943184420297371, 0.33000947820757187, 0.6699905217924281, 0.9305681557970263], w: [0.17392742256872692, 0.3260725774312731, 0.3260725774312731, 0.17392742256872692] };

/** Effective path lengths: ds[k * n + j] belongs to the ray at level k + 1 and shell j (0 for j > k); see the header. */
export function chordGeometry(atm) {
  const n = atm.n, r = atm.rLev, ds = new Float64Array(n * n), ring = new Float64Array(n);
  const u = atm.constantG ? (x) => x : (x) => 1 / x;
  for (let k = 0; k < n; k++) {
    const b2 = r[k + 1] * r[k + 1];
    for (let j = 0; j <= k; j++) {
      const s0 = Math.sqrt(Math.max(0, r[j + 1] * r[j + 1] - b2)), s1 = Math.sqrt(r[j] * r[j] - b2), uc = u(atm.rLay[j]), q = 1 / atm.dudlnp[j];
      let sum = 0;
      for (let m = 0; m < 4; m++) { const s = s0 + (s1 - s0) * GL4.x[m]; sum += GL4.w[m] * Math.exp((u(Math.sqrt(b2 + s * s)) - uc) * q); }
      ds[k * n + j] = 2 * (s1 - s0) * sum;
    }
    ring[k] = Math.PI * (r[k] * r[k] - b2);
  }
  return { n, ds, ring, core: Math.PI * r[n] * r[n] };
}

/**
 * Absorbing area [m^2] for one wavelength. alpha: extinction per layer [m^-1] (any array-like, offset `o`).
 * If `trans` is given (length n + 1), it receives the transmittance at every level, top first.
 * geom.opaqueFrom: index of the level at the top of an opaque deck; rays tangent below it are blocked.
 */
export function absorbingArea(geom, alpha, o = 0, trans = null) {
  const { n, ds, ring } = geom;
  let area = geom.core, prev = 0;   // prev = 1 - T at the level above
  if (trans) trans[0] = 1;
  for (let k = 0; k < n; k++) {
    let tau = 0; const row = k * n;
    // below an opaque deck every ray is blocked: the whole ring counts, whatever the layers say. The ray at the
    // deck's own level (k + 1 = opaqueFrom) is still the clear one, the limit from above.
    if (geom.opaqueFrom != null && k >= geom.opaqueFrom) { area += ring[k]; prev = 1; if (trans) trans[k + 1] = 0; continue; }
    for (let j = 0; j <= k; j++) tau += ds[row + j] * alpha[o + j];
    const a = -Math.expm1(-tau);
    area += 0.5 * ring[k] * (prev + a); prev = a;
    if (trans) trans[k + 1] = 1 - a;
  }
  return area;
}

/**
 * Transit depths. extinction: Float64Array(nWl * n), row per wavelength [m^-1]; rstar in metres.
 *   weights: with a correlated-k table, { ng, w }: rows are then nWl * ng, and the areas of the ng rows of a bin are
 *   averaged with the quadrature weights w (transmittance, not optical depth, is what averages over a bin).
 *   map: also return the transmittance of every level, Float32Array(nWl * (n + 1)), averaged over g the same way.
 * Returns { depth, radius [m], area, trans?, topTau }. topTau is the optical depth of the highest ray (the one grazing
 * the bottom of the top layer): where it is not small the model's top is not transparent and the depth there depends
 * on pTop.
 */
export function transmissionSpectrum(atm, extinction, rstar, { weights = null, map = false, geom = chordGeometry(atm) } = {}) {
  const n = atm.n, ng = weights ? weights.ng : 1, nWl = extinction.length / (n * ng);
  const depth = new Float64Array(nWl), radius = new Float64Array(nWl), area = new Float64Array(nWl);
  const trans = map ? new Float32Array(nWl * (n + 1)) : null, row = map ? new Float64Array(n + 1) : null;
  const star = Math.PI * rstar * rstar, topTau = new Float64Array(nWl);
  for (let i = 0; i < nWl; i++) {
    let a = 0, tt = 0;
    for (let q = 0; q < ng; q++) {
      const w = weights ? weights.w[q] : 1;
      a += w * absorbingArea(geom, extinction, (i * ng + q) * n, row);
      tt += w * Math.exp(-geom.ds[0] * extinction[(i * ng + q) * n]);
      if (map) for (let k = 0; k <= n; k++) trans[i * (n + 1) + k] += w * row[k];
    }
    area[i] = a; depth[i] = a / star; radius[i] = Math.sqrt(a / Math.PI); topTau[i] = -Math.log(Math.max(tt, 1e-300));
  }
  return { depth, radius, area, trans, topTau };
}

/**
 * The closed form for an isothermal atmosphere of constant gravity and constant mass opacity (Heng & Kitzmann 2017,
 * MNRAS 470, 2972, eq. 8; Bétrémieux & Swain 2017): R = R0 + H [gamma_E + E1(tau0) + ln tau0], with
 * tau0 = (P0 kappa / g) sqrt(2 pi R0 / H). Arguments: r0 [m], H [m], p0 [Pa], kappa [m^2/kg], g [m/s^2].
 * It is exact to first order in H / R0.
 */
export function isothermalRadius({ r0, H, p0, kappa, g }) {
  const tau0 = ((p0 * kappa) / g) * Math.sqrt((2 * Math.PI * r0) / H);
  return r0 + H * (0.5772156649015329 + expint1(tau0) + Math.log(tau0));
}

/** Exponential integral E1(x), x > 0: series below 1, continued fraction above (Abramowitz & Stegun 5.1.11, 5.1.22). */
export function expint1(x) {
  if (!(x > 0)) return Infinity;
  if (x <= 1) {
    let s = -0.5772156649015329 - Math.log(x), term = 1;
    for (let k = 1; k < 60; k++) { term *= -x / k; const d = -term / k; s += d; if (Math.abs(d) < 1e-17 * Math.abs(s)) break; }
    return s;
  }
  // modified Lentz
  let b = x + 1, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * i; b += 2; d = 1 / (an * d + b); c = b + an / c; const del = c * d; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h * Math.exp(-x);
}
