// Condensation with rain-out: which gases leave the atmosphere as it gets cold, and where their clouds begin.
//
// Two kinds of condensate, each from published fits:
//   ices and liquids of the gas itself (H2O, NH3, CH4): the gas cannot exceed its saturation vapour pressure,
//     x <= humidity * p_sat(T) / P.
//   refractory solids made from several gases (silicates, iron, salts, perovskite): the published condensation
//     curve 1e4 / T = a - b log10 P[bar] - c [M/H] says at which temperature the solid first appears for a given
//     metallicity. Read the other way it says how much of the limiting element the gas can hold at (T, P): the
//     metallicity whose curve passes through that point, [M/H]sat = (a - b log P - 1e4/T) / c. The gas keeps the
//     fraction 10^([M/H]sat - [M/H]) of it, or all of it if that exceeds 1.
// Rain-out (the cold trap): condensed material falls, so above the level where a gas first condenses it cannot
// be more abundant than at the coldest point it has passed on the way up, even where the atmosphere is warmer
// again higher up. Without rain-out each layer has its own local saturation only.
//
// What this is not: the chemistry is not solved again without the condensed elements (the table of
// src/core/chemistry.js is gas-phase), so the oxygen that silicates take from water (about a fifth) stays in the gas,
// and no cloud particle sizes or optical depths follow from it: the cloud's place is given, its thickness is yours.
//
// Sources
//   H2O   Buck (1981, J. Appl. Meteorol. 20, 1527), in the 1996 form: liquid above 273.16 K, ice below
//   NH3   Ackerman & Marley (2001, ApJ 556, 872), appendix: ice
//   H2O   (Ackerman & Marley 2001 use Buck's 1981 coefficients for the liquid; the ice is the same)
//   CH4   liquid: Antoine fit of Prydz & Goodwin (1972) as in the NIST WebBook, 91-190 K; solid, below the triple
//         point (90.68 K): Fray & Schmitt (2009, Planet. Space Sci. 57, 2053), ln P[bar] as a polynomial in 1/T,
//         coefficients as quoted by Marboeuf et al. (2014, A&A 570, A36, table 3); the two differ by 0.8% where they meet
//   Na2S, KCl, ZnS, MnS, Cr   Morley et al. (2012, ApJ 756, 172), eqs. 13, 20, 16, 10, 7 (from Visscher et al. 2006)
//   Fe, Mg2SiO4, MgSiO3       Visscher, Lodders & Fegley (2010, ApJ 716, 1060), eqs. 2, 18, 20
//   CaTiO3, Al2O3             Wakeford et al. (2017, MNRAS 464, 4247), eqs. 7, 4 (from Lodders 2002)
// The NH3 expression is printed in the paper with the unit dyne cm^-2; it evaluates to bar (0.061 at the triple point).

/** Saturation vapour pressure [bar] of 'H2O', 'NH3' or 'CH4' at T [K] (over the liquid or the solid, whichever is stable). */
export function vapourPressure(species, T) {
  if (species === 'H2O') {
    const t = T - 273.15;
    return (T >= 273.16 ? 611.21 * Math.exp((18.678 - t / 234.5) * (t / (257.14 + t))) : 611.15 * Math.exp((23.036 - t / 333.7) * (t / (279.82 + t)))) / 1e5;
  }
  if (species === 'NH3') return Math.exp(10.53 - 2161 / T - 86596 / (T * T));
  if (species === 'CH4') {
    if (T >= 90.68) return Math.pow(10, 3.9895 - 443.028 / (T - 0.49));
    const u = 1 / T; return Math.exp(10.51 - 1110 * u - 4341 * u * u + 1.035e5 * u ** 3 - 7.91e5 * u ** 4);   // solid, 20.6-90.68 K
  }
  throw new Error('no vapour pressure for ' + species);
}

/**
 * The condensates. `gas`: the species whose own vapour pressure limits it. `curve`: [a, b, c] (and d for a
 * (log P)^2 term) of 1e4/T = a - b log P + d (log P)^2 - c [M/H]. `removes`: gases of the model that lose the limiting
 * element (none: the solid is a cloud only, as far as this model's gases go).
 */
export const CONDENSATES = {
  Al2O3: { label: 'corundum', curve: [5.014, 0.2179, 0.58, 2.264e-3], removes: [] },
  CaTiO3: { label: 'perovskite', curve: [5.125, 0.277, 0.554], removes: ['TiO', 'VO'] },   // vanadium goes into solid solution in it (Lodders 2002)
  Fe: { label: 'iron', curve: [5.44, 0.48, 0.48], removes: [] },
  Mg2SiO4: { label: 'forsterite', curve: [5.89, 0.37, 0.73], removes: [] },
  MgSiO3: { label: 'enstatite', curve: [6.26, 0.35, 0.7], removes: [] },
  Cr: { label: 'chromium', curve: [6.576, 0.486, 0.486], removes: [] },
  MnS: { label: 'manganese sulfide', curve: [7.447, 0.42, 0.84], removes: [] },
  Na2S: { label: 'sodium sulfide', curve: [10.045, 0.72, 1.08], removes: ['Na'] },
  ZnS: { label: 'zinc sulfide', curve: [12.527, 0.63, 1.26], removes: [] },
  KCl: { label: 'potassium chloride', curve: [12.479, 0.879, 0.879], removes: ['K'] },
  H2O: { label: 'water', gas: 'H2O' },
  NH3: { label: 'ammonia ice', gas: 'NH3' },
  CH4: { label: 'methane', gas: 'CH4' },
};

/** Temperature [K] below which a refractory condensate forms at pressure pBar and metallicity mh ([M/H], dex). */
export function condensationTemperature(name, pBar, mh = 0) {
  const c = CONDENSATES[name]; if (!c || !c.curve) throw new Error('no condensation curve for ' + name);
  const [a, b, cm, d = 0] = c.curve, L = Math.log10(pBar);
  return 1e4 / (a - b * L + d * L * L - cm * mh);
}

/** The fraction of a refractory condensate's limiting element that the gas can hold at (T, pBar): at most 1. */
export function gasFraction(name, T, pBar, mh = 0) {
  const [a, b, cm, d = 0] = CONDENSATES[name].curve, L = Math.log10(pBar);
  return Math.min(1, Math.pow(10, (a - b * L + d * L * L - 1e4 / T) / cm - mh));
}

/**
 * Condense and rain out.
 *   tLay [K], pLayBar [bar] (top first), species: { name: Float64Array(n) } (not modified)
 *   { mh = 0, rainout = true, humidity = 1 (share of saturation the ices and liquids are allowed), only: [names] | null }
 * Returns { species: the same object with the affected gases replaced by new arrays,
 *           clouds: [{ name, label, base [bar] (the deepest condensing level; null: none in the model), deep: true when
 *                      the bottom layer already condenses (the base lies below the model), top [bar], removes }],
 *           kept: { gas: Float64Array(n) }, what remains of each affected gas as a fraction }.
 */
export function rainOut(tLay, pLayBar, species, { mh = 0, rainout = true, humidity = 1, only = null } = {}) {
  const n = tLay.length, out = { ...species }, clouds = [], kept = {};
  for (const [name, c] of Object.entries(CONDENSATES)) {
    if (only && !only.includes(name)) continue;
    if (c.gas && !species[c.gas]) continue;
    const x = c.gas ? species[c.gas] : null, f = new Float64Array(n).fill(1);
    let floor = Infinity, base = null, top = null;
    for (let j = n - 1; j >= 0; j--) {   // from the bottom up
      // sat: the largest mixing ratio (ices) or fraction (refractories) the gas can hold here
      const sat = c.gas ? (humidity * vapourPressure(c.gas, tLay[j])) / pLayBar[j] : gasFraction(name, tLay[j], pLayBar[j], mh), have = c.gas ? x[j] : 1;
      if (sat < have) { if (base == null) base = j; top = j; if (rainout) floor = Math.min(floor, sat); }
      const lim = Math.min(sat, floor);
      f[j] = lim < have ? lim / have : 1;
    }
    if (base == null) continue;
    clouds.push({ name, label: c.label, base: pLayBar[base], deep: base === n - 1, top: pLayBar[top], removes: c.gas ? [c.gas] : c.removes });
    for (const g of c.gas ? [c.gas] : c.removes) {
      if (!species[g]) continue;
      const k = (kept[g] ??= new Float64Array(n).fill(1)), a = out[g] === species[g] ? Float64Array.from(species[g]) : out[g];
      for (let j = 0; j < n; j++) { a[j] *= f[j]; k[j] *= f[j]; }
      out[g] = a;
    }
  }
  clouds.sort((a, b) => b.base - a.base);
  return { species: out, clouds, kept };
}
