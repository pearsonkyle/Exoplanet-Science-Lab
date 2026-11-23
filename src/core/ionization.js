// Ionization balance of sodium (and hydrogen) in a planet's atmosphere: photoionization by the star and ionization by
// electron impact against radiative and three-body recombination, layer by layer in steady state. It answers one
// radiative-transfer question: how much of the sodium that chemistry puts in the gas is still neutral, and so still
// absorbs in the D lines, at each pressure.
//
// After the owner's notes (github.com/pearsonkyle/Exoplanet-Ionization; Pearson et al. 2019, AJ 157, 21), from the
// published fits they use:
//   photoionization cross-sections   Verner, Ferland, Korista & Yakovlev (1996, ApJ 465, 487) for H and Na; Verner &
//                                    Yakovlev (1995, A&AS 109, 125) for K. The coefficients are those of Verner's own
//                                    phfit2.f (data-src/verner/, from www.pa.uky.edu/~verner/dima/photo/)
//   radiative recombination          Verner & Ferland (1996, ApJS 103, 467)
//   electron-impact ionization       Voronov (1997, At. Data Nucl. Data Tables 65, 1)
//   three-body recombination         alpha3 = k1 k0 n / (k0 n + k1), k1 = 1e-7 cm^3/s, k0 = 3.43e-14 T^-3.77 cm^6/s
//                                    (as in those notes, which give no reference for it)
// Differences from the notes: layers are solved from the top down, so the light reaching a layer has crossed the
// neutral sodium actually found above it; the path is slanted by 1 / mu0; electrons from other sources can be added.
//
// What it leaves out: other absorbers of the ionizing light (H2 and H shield below about 110 nm), ions other than
// Na+, transport, and time. The stellar spectrum decides the answer and a blackbody is a poor ultraviolet spectrum:
// a real star is fainter than its blackbody between 150 and 240 nm (line blanketing) and far brighter below (the
// chromosphere). Treat the result as the size of the effect, not a measurement.
// cgs inside, as the fits are published.

const ATOMS = {
  Na: { photo: { E0: 6.139, s0: 1.601, ya: 6.148e3, P: 3.839, yw: 0, y0: 0, y1: 0 }, threshold: 5.139, rr: { a: 5.641e-12, b: 0.1749, T0: 307.7, T1: 2.617e6 }, ci: { dE: 5.1, P: 1, A: 1.01e-7, X: 0.275, K: 0.23 } },
  // potassium: outer 4s shell of Verner & Yakovlev (1995, A&AS 109, 125), as tabulated in Verner's phfit2.f (PH1(.,19,19,7)).
  // No published fits for its recombination or electron-impact rates are carried. Recombination is taken as sodium's:
  // for both alkalis recombination to the ground state is under 0.1% of the total (milneRecombination gives 7e-16 and
  // 1e-16 cm^3/s at 1000 K against sodium's total of 1.3e-12), the rest going through excited states, which are
  // hydrogen-like in both. Electron impact is sodium's fit with potassium's ionization energy. Both are estimates,
  // good to perhaps a factor of two.
  K: { photo: { form: 'vy95', E0: 3.824, s0: 0.7363, ya: 2.410e7, P: 4.427, yw: 2.049e-4, l: 0 }, threshold: 4.341, g: [2, 1], rr: 'alkali', ci: { dE: 4.341, P: 1, A: 1.01e-7, X: 0.275, K: 0.23 } },
  H: { photo: { E0: 0.4298, s0: 5.475e4, ya: 32.88, P: 2.963, yw: 0, y0: 0, y1: 0 }, threshold: 13.598, rr: { a: 7.982e-11, b: 0.748, T0: 3.148, T1: 7.036e5 }, ci: { dE: 13.6, P: 0, A: 2.91e-8, X: 0.232, K: 0.39 } },
};

/** Photoionization cross-section [cm^2] at wavelength [nm] (Verner et al. 1996, eq. 1); zero beyond the threshold. */
export function photoCrossSection(species, nm) {
  const a = ATOMS[species], E = 1239.84193 / nm; if (E < a.threshold) return 0;
  const p = a.photo;
  if (p.form === 'vy95') { const y = E / p.E0; return p.s0 * ((y - 1) ** 2 + p.yw * p.yw) * Math.pow(y, 0.5 * p.P - p.l - 5.5) * Math.pow(1 + Math.sqrt(y / p.ya), -p.P) * 1e-18; }
  const x = E / p.E0 - p.y0, y = Math.sqrt(x * x + p.y1 * p.y1);
  return p.s0 * ((x - 1) ** 2 + p.yw * p.yw) * Math.pow(y, 0.5 * p.P - 5.5) * Math.pow(1 + Math.sqrt(y / p.ya), -p.P) * 1e-18;
}
/** Radiative recombination coefficient [cm^3/s] (Verner & Ferland 1996, eq. 4). */
export function radiativeRecombination(species, T) {
  if (ATOMS[species].rr === 'alkali') return radiativeRecombination('Na', T);   // see ATOMS.K
  const r = ATOMS[species].rr, t = Math.sqrt(T / r.T0);
  return r.a / (t * Math.pow(1 + t, 1 - r.b) * Math.pow(1 + Math.sqrt(T / r.T1), 1 + r.b));
}
/**
 * Radiative recombination to the ground state [cm^3/s] from the photoionization cross-section, by detailed balance
 * (the Milne relation): alpha_1 = (g_0 / (2 g_+)) (h^2 / (2 pi m_e k T))^(3/2) (8 pi / (c^2 h^3))
 * int_I^inf (h nu)^2 sigma e^(-(h nu - I) / kT) d(h nu). g_0, g_+: statistical weights of the atom and the ion (2, 1 for
 * H, Na, K). Recombination to excited states, which the total includes, is not in it.
 */
export function milneRecombination(species, T) {
  const a = ATOMS[species], [g0, gp] = a.g || [2, 1], I = a.threshold, kT = 8.617333262e-5 * T, eV = 1.602176634e-12, h = 6.62607015e-27, c = 2.99792458e10, me = 9.1093837015e-28;
  let s = 0; const n = 4000, top = 60 * kT;
  for (let i = 0; i < n; i++) { const u = (top * (i + 0.5)) / n, E = I + u; s += E * E * photoCrossSection(species, 1239.84193 / E * (1 - 1e-12)) * Math.exp(-u / kT) * (top / n); }
  return (g0 / (2 * gp)) * Math.pow((h * h) / (2 * Math.PI * me * kT * eV), 1.5) * ((8 * Math.PI) / (c * c * h * h * h)) * s * eV ** 3;
}
/** Electron-impact ionization rate coefficient [cm^3/s] (Voronov 1997, eq. 1). */
export function collisionalIonization(species, T) {
  const c = ATOMS[species].ci, U = c.dE / (8.617343e-5 * T);
  return (c.A * (1 + c.P * Math.sqrt(U)) * Math.pow(U, c.K) * Math.exp(-U)) / (c.X + U);
}
/** Three-body recombination coefficient [cm^3/s] at total number density n [cm^-3]. */
export function threeBodyRecombination(T, n) { const k1 = 1e-7, k0 = 3.43e-14 * Math.pow(T, -3.77); return (k1 * k0 * n) / (k0 * n + k1); }

/** Photon flux of a blackbody star at the planet [photons cm^-2 s^-1 nm^-1]: pi B_lambda / (h c / lambda) (R* / a)^2. */
export function blackbodyPhotons(nm, teff, rstarOverA) {
  const l = nm * 1e-9, h = 6.62607015e-34, c = 299792458, k = 1.380649e-23;
  const B = (2 * h * c * c) / l ** 5 / Math.expm1((h * c) / (l * k * teff));   // W m^-2 sr^-1 m^-1
  return (Math.PI * B * rstarOverA * rstarOverA) / ((h * c) / l) * 1e-9 * 1e-4;
}

/**
 * Neutral and ionized shares of a species in every layer.
 *   atm: { n, pLay [Pa], tLay [K], dr [m], nd [m^-3] } (top first); x: mixing ratio of the element per layer
 *   { species = 'Na', flux: (nm) => photons cm^-2 s^-1 nm^-1 at the planet, mu0 = 0.5 (cosine of the star's zenith
 *     angle: 0.5 is the day-side mean), electrons: Float64Array(n) | null (mixing ratio of electrons from other
 *     sources), nWl = 160, shield: Float64Array(n) | null (mixing ratio of another gas that absorbs the same light,
 *     counted with the same cross-section: H2 for hydrogen's) }
 * Each layer: 0 = n_0 (J + q n_e) - (alpha + alpha3) n_e n_+, with n_e = n_+ + other electrons, a quadratic in n_+.
 * Returns { neutral: Float64Array(n) (share of the species left neutral), ion, J: Float64Array(n) [s^-1 per atom],
 *           thermal: Float64Array(n) [s^-1 per atom], half: pressure [bar] where half is ionized, or null }.
 */
export function ionizationProfile(atm, x, { species = 'Na', flux, mu0 = 0.5, electrons = null, nWl = 160, shield = null } = {}) {
  const n = atm.n, lamMax = 1239.84193 / ATOMS[species].threshold, lam = [], sig = [], F = [];
  for (let i = 0; i < nWl; i++) { const l = 1 + ((lamMax - 1) * (i + 0.5)) / nWl; lam.push(l); sig.push(photoCrossSection(species, l)); F.push(flux(l)); }
  const dl = (lamMax - 1) / nWl, neutral = new Float64Array(n), ion = new Float64Array(n), J = new Float64Array(n), thermal = new Float64Array(n);
  let column = 0, half = null;   // neutral atoms per cm^2 above, along the slant
  for (let j = 0; j < n; j++) {
    const nt = atm.nd[j] * 1e-6, T = atm.tLay[j], m = x[j], e0 = electrons ? electrons[j] : 0;
    let rate = 0; for (let i = 0; i < nWl; i++) rate += F[i] * sig[i] * Math.exp(-sig[i] * column) * dl;
    const c = collisionalIonization(species, T) * nt, r = (radiativeRecombination(species, T) + threeBodyRecombination(T, nt)) * nt;
    // (m - xi)(J + c (xi + e0)) = r xi (xi + e0)  ->  (r + c) xi^2 + (J + (c + r) e0 - m c) xi - m (J + c e0) = 0
    const A = r + c, B = rate + (c + r) * e0 - m * c, D = -m * (rate + c * e0);
    const root = Math.sqrt(B * B - 4 * A * D), xi = m > 0 ? Math.min(m, B > 0 ? (-2 * D) / (B + root) : (-B + root) / (2 * A)) : 0;   // the form that does not cancel
    ion[j] = m > 0 ? xi / m : 0; neutral[j] = 1 - ion[j]; J[j] = rate; thermal[j] = c * (xi + e0);
    if (half == null && j > 0 && ion[j] < 0.5 && ion[j - 1] >= 0.5) half = atm.pLay[j] / 1e5;
    column += ((m - xi + (shield ? shield[j] : 0)) * nt * atm.dr[j] * 100) / mu0;
  }
  return { neutral, ion, J, thermal, half };
}

/** Photon flux [photons cm^-2 s^-1 nm^-1] of an XUV energy flux [W m^-2 at the planet] spread evenly from 10 to 91.2 nm. */
export function xuvPhotons(nm, fxuv) {
  if (!(nm >= 10 && nm <= 91.2)) return 0;
  const mean = 6.62607015e-34 * 299792458 / 50e-9;   // a photon of 50 nm
  return (fxuv / mean) * 1e-4 / 81.2;
}

/**
 * Photoionization of the atoms of an atmosphere, top down, sharing their electrons:
 *   hydrogen (when the composition carries atomic H: chemical equilibrium does), by the star's extreme ultraviolet
 *     `fxuv` [W m^-2 at the planet], shielded by the neutral hydrogen and the H2 above;
 *   sodium, by the star's near ultraviolet (a blackbody of `teff` at `ars` stellar radii), shielded by the neutral
 *     sodium above, recombining with the electrons of both and of the chemistry.
 *   potassium, like sodium, with its own cross-section and estimated rates (see ATOMS).
 * Molecules are not photodissociated, and the chemistry carries no other free atoms: this is the ionization of the
 * upper atmosphere's atoms, not a photochemical model.
 * The species' mixing ratios in `atm.species` are replaced by their neutral parts; 'e-' (if present) gains the ions.
 * Returns { Na: { neutral, ion, half }, K: { ... }, H: { ... } } for those treated.
 */
export function ionizeAtmosphere(atm, { teff, ars, fxuv = 0, mu0 = 0.5 } = {}) {
  if (!(ars > 0) && !(fxuv > 0)) throw new Error('ionization needs the star\'s distance (star.ars) or an XUV flux (ionization.fxuv)');
  const sp = atm.species, n = atm.n, out = {}, extra = new Float64Array(n), chem = sp['e-'] ? Float64Array.from(sp['e-']) : new Float64Array(n);
  if (sp.H && fxuv > 0) {
    const r = ionizationProfile(atm, sp.H, { species: 'H', flux: (nm) => xuvPhotons(nm, fxuv), mu0, electrons: chem, shield: sp.H2 || null, nWl: 60 });
    for (let j = 0; j < n; j++) { extra[j] += sp.H[j] * r.ion[j]; sp.H[j] *= r.neutral[j]; }
    out.H = { neutral: r.neutral, ion: r.ion, half: r.half };
  }
  if (sp.Na && ars > 0) {
    const e = Float64Array.from(chem, (v, j) => v + extra[j]);
    const r = ionizationProfile(atm, sp.Na, { species: 'Na', flux: (nm) => blackbodyPhotons(nm, teff, 1 / ars), mu0, electrons: e });
    for (let j = 0; j < n; j++) { extra[j] += sp.Na[j] * r.ion[j]; sp.Na[j] *= r.neutral[j]; }
    out.Na = { neutral: r.neutral, ion: r.ion, half: r.half };
  }
  if (sp.K && ars > 0) {
    const e = Float64Array.from(chem, (v, j) => v + extra[j]);
    const r = ionizationProfile(atm, sp.K, { species: 'K', flux: (nm) => blackbodyPhotons(nm, teff, 1 / ars), mu0, electrons: e });
    for (let j = 0; j < n; j++) { extra[j] += sp.K[j] * r.ion[j]; sp.K[j] *= r.neutral[j]; }
    out.K = { neutral: r.neutral, ion: r.ion, half: r.half };
  }
  if (sp['e-']) for (let j = 0; j < n; j++) sp['e-'][j] += extra[j];
  out.electrons = Float64Array.from(chem, (v, j) => v + extra[j]);
  return out;
}
