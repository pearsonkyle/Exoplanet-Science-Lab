// Gap-filling relations (src/core/relations.js) against independent numbers.
// Reference: test/relations_reference.json from test/make_relations_reference.py (forecaster posterior medians for
// Chen & Kipping 2017, the dwarf table as published with numpy interpolation, astropy constants and units), the
// fitted coefficients printed in Otegi et al. 2020 (eqs. 1, 2 and the legend of their Fig. 4), and the numerically
// exact contact duration of src/core/kepler.js.
import { readFileSync } from 'node:fs';
import * as R from '../src/core/relations.js';
import { transitDuration as exactDuration, rvAmplitude } from '../src/core/catalog.js';
import { torres } from '../src/core/stellar.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const ref = JSON.parse(readFileSync(new URL('./relations_reference.json', import.meta.url)));
const P = ref.physics;

// --- every relation carries what a page needs to cite it
check('registry: every relation has a citation, a formula and a validity statement', Object.values(R.RELATIONS).every((r) => r.id && r.name && r.cite && r.formula && r.valid), Object.keys(R.RELATIONS).join(', '));
check('unit ratios', rel(R.RJUP_REARTH, P.rjup_rearth) < 1e-6 && rel(R.MJUP_MEARTH, P.mjup_mearth) < 2e-5, `Rjup/Rearth ${R.RJUP_REARTH.toFixed(4)} vs ${P.rjup_rearth.toFixed(4)}, Mjup/Mearth ${R.MJUP_MEARTH.toFixed(3)} vs ${P.mjup_mearth.toFixed(3)} (astropy)`);

// --- Chen & Kipping 2017
{
  const ck = ref.ck17; let worst = 0, at = 0;
  ck.mass_earth.forEach((m, i) => { const r = R.radiusFromMassCK17(m); const d = rel(r.value, ck.radius_earth[i]); if (d > worst) { worst = d; at = m; } });
  check('CK17 R(M): Table 2 values vs the medians of the forecaster posterior, 0.1 to 1e5 Mearth', worst < 0.02, `largest difference ${(100 * worst).toFixed(2)}% at ${at} Mearth (the table is rounded; the posterior medians are not the published point estimates)`);
  const e = R.radiusFromMassCK17(1), n = R.radiusFromMassCK17(10), j = R.radiusFromMassCK17(R.MJUP_MEARTH);
  check('CK17 landmarks', rel(e.value, 1.008) < 1e-3 && e.regime === 'Terran' && n.regime === 'Neptunian' && j.regime === 'Jovian' && R.radiusFromMassCK17(1e6) === null,
    `1 Mearth -> ${e.value.toFixed(3)} Rearth, 10 Mearth -> ${n.value.toFixed(3)}, 1 Mjup -> ${(j.value / R.RJUP_REARTH).toFixed(3)} Rjup`);
  // Otegi et al. 2020, Fig. 4 legend, quote the relation as R = 1.01 M^0.28 below 2 Mearth and 0.82 M^0.59 above
  check('CK17 as quoted by Otegi et al. 2020 (R = 1.01 M^0.28, 0.82 M^0.59)', rel(R.radiusFromMassCK17(1.5).value, 1.01 * 1.5 ** 0.28) < 0.01 && rel(R.radiusFromMassCK17(20).value, 0.82 * 20 ** 0.59) < 0.02,
    `${R.radiusFromMassCK17(1.5).value.toFixed(3)} vs ${(1.01 * 1.5 ** 0.28).toFixed(3)}; ${R.radiusFromMassCK17(20).value.toFixed(3)} vs ${(0.82 * 20 ** 0.59).toFixed(3)} Rearth`);
  let rt = 0;
  for (const m of [0.3, 1, 2.04, 5, 20, 80]) rt = Math.max(rt, rel(R.massFromRadiusCK17(R.radiusFromMassCK17(m).value).value, m));
  check('CK17 M(R) inverts R(M) on the Terran and Neptunian branches', rt < 1e-9, `round trip ${rt.toExponential(1)}`);
  check('CK17 M(R) refuses radii that are not single-valued', R.massFromRadiusCK17(12) === null && R.massFromRadiusCK17(R.CK17_RMAX_SINGLE * 0.999) !== null && Math.abs(R.CK17_RMAX_SINGLE - 11.3) < 0.15,
    `limit ${R.CK17_RMAX_SINGLE.toFixed(2)} Rearth = ${(R.CK17_RMAX_SINGLE / R.RJUP_REARTH).toFixed(3)} Rjup (the Jovian/Stellar transition radius)`);
  const s = R.massFromRadiusCK17(2.5);
  check('CK17 scatter is passed on', Math.abs(s.sigmaLog - 0.146 / 0.589) < 1e-9 && s.regime === 'Neptunian', `2.5 Rearth -> ${s.value.toFixed(2)} Mearth, ${s.sigmaLog.toFixed(2)} dex`);
}

// --- Otegi et al. 2020: the printed fits
check('Otegi20 printed fits', rel(R.massFromRadiusOtegi20(1.5), 0.90 * 1.5 ** 3.45) < 1e-12 && rel(R.massFromRadiusOtegi20(3), 1.74 * 3 ** 1.58) < 1e-12 && rel(R.radiusFromMassOtegi20(3), 1.03 * 3 ** 0.29) < 1e-12 && rel(R.radiusFromMassOtegi20(20), 0.70 * 20 ** 0.63) < 1e-12,
  `1.5 Rearth -> ${R.massFromRadiusOtegi20(1.5).toFixed(2)} Mearth (rocky), 3 Rearth -> ${R.massFromRadiusOtegi20(3).toFixed(2)} Mearth (volatile-rich)`);
check('Otegi20 stops at 120 Mearth', Number.isNaN(R.radiusFromMassOtegi20(150)) && Number.isNaN(R.massFromRadiusOtegi20(16)) && R.massFromRadiusOtegi20(14) < 120);
check('Otegi20 and CK17 agree where both hold', rel(R.massFromRadiusOtegi20(1.2), R.massFromRadiusCK17(1.2).value) < 0.25 && rel(R.massFromRadiusOtegi20(4), R.massFromRadiusCK17(4).value) < 0.25,
  `1.2 Rearth: ${R.massFromRadiusOtegi20(1.2).toFixed(2)} vs ${R.massFromRadiusCK17(1.2).value.toFixed(2)}; 4 Rearth: ${R.massFromRadiusOtegi20(4).toFixed(1)} vs ${R.massFromRadiusCK17(4).value.toFixed(1)} Mearth`);

// --- mean dwarf sequence
{
  const d = ref.dwarfs;
  const same = d.rows.length === R.DWARF_SEQUENCE.length && d.rows.every((r, i) => r.every((x, k) => x === R.DWARF_SEQUENCE[i][k]));
  check(`dwarf table matches the published file (${d.version})`, same, `${d.rows.length} rows, ${d.rows[0][0]} to ${d.rows[d.rows.length - 1][0]}`);
  let wr = 0, wm = 0, wl = 0;
  d.teff.forEach((t, i) => { const s = R.dwarfFromTeff(t); wr = Math.max(wr, rel(s.rstar, d.rstar[i])); wm = Math.max(wm, rel(s.mstar, d.mstar[i])); wl = Math.max(wl, Math.abs(s.logL - d.logL[i])); });
  check('interpolation vs numpy.interp in log Teff', wr < 1e-9 && wm < 1e-9 && wl < 1e-9, `R ${wr.toExponential(1)}, M ${wm.toExponential(1)}, log L ${wl.toExponential(1)}`);
  const sun = R.dwarfFromTeff(5772);
  check('a 5772 K dwarf is the Sun to a few per cent', Math.abs(sun.rstar - 1) < 0.03 && Math.abs(sun.mstar - 1) < 0.03 && sun.sptype === 'G2V', `R ${sun.rstar.toFixed(3)}, M ${sun.mstar.toFixed(3)}, ${sun.sptype}`);
  check('outside the table: no estimate', R.dwarfFromTeff(2000) === null && R.dwarfFromTeff(12000) === null && R.dwarfFromTeff(NaN) === null);
  // the table's own L against Stefan-Boltzmann from its R and Teff: says how self-consistent the sequence is
  let sb = 0;
  for (const [, t, logL, r] of R.DWARF_SEQUENCE) sb = Math.max(sb, Math.abs(Math.log10(R.luminosity(r, t)) - logL));
  check('table luminosities obey Stefan-Boltzmann with its radii', sb < 0.02, `largest difference ${sb.toFixed(3)} dex`);
  // against Torres et al. 2010 at the log g the dwarf sequence itself implies, where both are valid
  let wt = 0;
  for (const t of [4800, 5300, 5772, 6300, 7000]) { const s = R.dwarfFromTeff(t), x = torres(t, R.loggFromMassRadius(s.mstar, s.rstar), 0); wt = Math.max(wt, Math.abs(Math.log10(x.mstar / s.mstar))); }
  check('dwarf masses vs Torres et al. 2010 at the same log g (4800 to 7000 K)', wt < 0.08, `largest difference ${wt.toFixed(3)} dex (two different calibrations; Torres' own scatter is 0.027 dex)`);
}

// --- physics against astropy
check("Kepler's third law", rel(R.semiMajorAxis(1 + 1 / 332946.0487, 365.256363), P.a_earth_au) < 2e-6 && rel(R.semiMajorAxis(1.2, 3), P.a_hj_au) < 2e-6 && rel(R.scaledAxis(R.semiMajorAxis(1.2, 3), 1.3), P.ars_hj) < 2e-6,
  `Earth ${R.semiMajorAxis(1 + 1 / 332946.0487, 365.256363).toFixed(7)} vs ${P.a_earth_au.toFixed(7)} au; a/R* ${R.scaledAxis(R.semiMajorAxis(1.2, 3), 1.3).toFixed(5)} vs ${P.ars_hj.toFixed(5)}`);
check('RV semi-amplitude', rel(R.rvSemiAmplitude(1, 1, 4332.59, 0.0489), P.K_jupiter) < 5e-5 && rel(R.rvSemiAmplitude(1 / R.MJUP_MEARTH, 1, 365.256363, 0.0167), P.K_earth) < 5e-5 && rel(R.rvSemiAmplitude(0.7, 1.2, 3, 0.1, 85), P.K_hj_inclined) < 5e-5,
  `Jupiter ${R.rvSemiAmplitude(1, 1, 4332.59, 0.0489).toFixed(3)} vs ${P.K_jupiter.toFixed(3)} m/s; Earth ${R.rvSemiAmplitude(1 / R.MJUP_MEARTH, 1, 365.256363, 0.0167).toFixed(5)} vs ${P.K_earth.toFixed(5)} m/s (textbook 12.5 and 0.09)`);
check('... agrees with catalog.js and inverts', rel(R.rvSemiAmplitude(0.7, 1.2, 3, 0.1, 85), rvAmplitude(0.7, 3, 0.1, Math.sin(85 * Math.PI / 180), 1.2)) < 1e-12 && rel(R.massFromRvAmplitude(R.rvSemiAmplitude(0.7, 1.2, 3, 0.1, 85), 1.2, 3, 0.1, 85), 0.7) < 1e-9);
check('luminosity and insolation', rel(R.luminosity(1, 5772), P.lum_sun) < 2e-4 && rel(R.luminosity(0.7, 4500), P.lum_k) < 2e-4 && rel(R.insolation(6200, 1.3, R.semiMajorAxis(1.2, 3)), P.insol_hj) < 2e-4,
  `Sun ${R.luminosity(1, 5772).toFixed(5)} vs ${P.lum_sun.toFixed(5)} Lsun; hot Jupiter ${R.insolation(6200, 1.3, R.semiMajorAxis(1.2, 3)).toFixed(1)} vs ${P.insol_hj.toFixed(1)} Searth`);
{
  const arsE = R.scaledAxis(1, 1);
  check('equilibrium temperature', rel(R.equilibriumTemperature(5772, arsE), P.teq_earth_A0) < 1e-6 && rel(R.equilibriumTemperature(5772, arsE, 0.3), P.teq_earth_A03) < 1e-6 && Math.abs(R.equilibriumTemperature(5772, arsE, 0.3) - 255) < 1,
    `Earth ${R.equilibriumTemperature(5772, arsE).toFixed(1)} K at A = 0, ${R.equilibriumTemperature(5772, arsE, 0.3).toFixed(1)} K at A = 0.3 (textbook 255 K)`);
}
check('radius ratio, depth, gravity, density', rel(R.radiusRatio(1, 1), P.rprs_jup_sun) < 1e-6 && R.transitDepth(0.1) === 0.1 * 0.1 && rel(R.massFromLogg(4.3, 1.2), P.mass_logg) < 2e-5 && Math.abs(R.loggFromMassRadius(1, 1) - P.logg_sun) < 1e-5 &&
  rel(R.radiusFromLogg(4.3, R.massFromLogg(4.3, 1.2)), 1.2) < 1e-12 && rel(R.planetDensity(1, 1), P.density_jupiter) < 2e-4, `Jupiter ${R.planetDensity(1, 1).toFixed(4)} vs ${P.density_jupiter.toFixed(4)} g/cm^3`);
{
  const b = 0.45812654598716124, ars = 8.753571710059788, inc = R.inclinationFromImpact(ars, b);
  check('impact parameter and its inverse', Math.abs(inc - 87) < 1e-9 && rel(R.impactParameter(ars, 87), b) < 1e-12 && Number.isNaN(R.inclinationFromImpact(3, 4)), `i = ${inc.toFixed(6)} deg`);
  const t = R.transitDuration(3, ars, 0.1, b);
  check('transit duration, circular: Winn eq. 14 vs astropy and vs the exact contact times', rel(t, P.t14_circ) < 1e-12 && rel(t, exactDuration(3, ars, 87, 0.1)) < 1e-7, `${t.toFixed(8)} vs ${P.t14_circ.toFixed(8)} (formula), ${exactDuration(3, ars, 87, 0.1).toFixed(8)} d (kepler.js)`);
  const te = R.transitDuration(10, 20, 0.08, 0.3, 0.3, 60), incE = R.inclinationFromImpact(20, 0.3, 0.3, 60), ex = exactDuration(10, 20, incE, 0.08, 0.3, 60);
  check('transit duration, e = 0.3: formula vs astropy, and its approximation error vs the exact contact times', rel(te, P.t14_ecc) < 1e-12 && rel(te, ex) < 0.01, `${te.toFixed(6)} vs ${ex.toFixed(6)} d exact (${(100 * rel(te, ex)).toFixed(2)}% off)`);
  check('no transit when b > 1 + k', R.transitDuration(3, 8, 0.1, 1.2) === 0);
}
process.exit(ok ? 0 : 1);
