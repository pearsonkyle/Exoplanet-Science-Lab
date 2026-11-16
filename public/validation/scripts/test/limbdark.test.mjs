// The bundled limb darkening table (src/data/ld_table.js, built by tools/build_ld_table.py from PHOENIX
// specific intensities) against an independent reference: ExoTETHyS coefficients read through pylightcurve
// (test/make_ld_reference.py -> limbdark_reference.json). Profiles are compared, not coefficients: the four
// Claret basis functions are nearly collinear, so very different coefficients can describe the same star.
//
// What the reference can and cannot show is in the header of make_ld_reference.py. In short: the 'phoenix'
// cases test the table's processing, the grid it keeps and the app's interpolation at solar metallicity
// against a different code working from the same model family; the 'atlas' cases are a different atmosphere
// code and give the metallicity response and an honest idea of the model-to-model spread.
import { readFileSync } from 'node:fs';
import { LD_TABLE, LD_TABLE_COMPACT } from '../src/data/ld_table.js';
import { FILTERS, fitLaw, gridFromTable, interpLDGrid, expandLDTable, readLDTable, makeLDTie } from '../src/core/ldest.js';
import { intensity, toClaret, checkProfile } from '../src/core/limbdark.js';
import { makeTransit } from '../src/core/transit.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./limbdark_reference.json', import.meta.url)));
// Tolerances: [rms, max] of the I(mu) difference over mu in [0.05, 1], the same over [0.1, 1] (units of the central
// intensity), relative difference in mid-transit depth, largest flux difference in ppm (Rp/R* = 0.1). Each is the
// worst value this test printed when the table was built (November 2026) times about 1.5, per law and spectral type.
const T = (rms, max, rms1, max1, depth, ppm) => ({ rms, max, rms1, max1, depth, ppm });
const TOL = {
  nonlinear: { F: T(1.0e-3, 6.0e-3, 6e-4, 1.5e-3, 5e-4, 6), G: T(5e-4, 3.5e-3, 3e-4, 6e-4, 4e-4, 5), K: T(1.4e-3, 2.5e-3, 1.4e-3, 2.1e-3, 1.4e-3, 20), M: T(5e-4, 2.6e-3, 4e-4, 1.1e-3, 2.5e-4, 3) },
  quadratic: { F: T(8e-4, 1.8e-3, 8e-4, 1.7e-3, 6e-4, 7.5), G: T(8e-4, 1.8e-3, 6e-4, 1.5e-3, 3e-4, 5), K: T(2.0e-3, 5.0e-3, 1.7e-3, 4.5e-3, 1.3e-3, 20), M: T(4.5e-3, 1.2e-2, 3.6e-3, 1.0e-2, 1.5e-3, 32) },
  sqrt: { F: T(6e-4, 1.8e-3, 6e-4, 1.4e-3, 4.5e-4, 5.5), G: T(4.5e-3, 1.7e-2, 3.3e-3, 1.2e-2, 8e-4, 28), K: T(3.8e-3, 1.4e-2, 2.7e-3, 9.5e-3, 1.4e-3, 22), M: T(1.4e-3, 5.5e-3, 1.1e-3, 3.5e-3, 3e-4, 7) },
  linear: { F: T(1.5e-3, 2.6e-3, 1.4e-3, 2.4e-3, 1.1e-3, 13), G: T(1.5e-3, 2.6e-3, 1.4e-3, 2.4e-3, 1.0e-3, 11), K: T(4.5e-3, 8.0e-3, 4.4e-3, 7.5e-3, 4.0e-3, 60), M: T(4.0e-3, 6.8e-3, 3.8e-3, 6.5e-3, 2.7e-3, 33) },
  hole: T(1.0e-2, 1.4e-2, 1.0e-2, 1.4e-2, 9e-3, 115), clampNear: T(3.6e-3, 4.7e-3, 3.6e-3, 4.7e-3, 4.2e-3, 60),
  atlasRms: 0.05, respRms: 0.021,
};

// ---- comparison tools ---------------------------------------------------------------------
const MU = Float64Array.from({ length: 96 }, (_, i) => 0.05 + (0.95 * i) / 95);      // mu in [0.05, 1]
/** rms and max of I_a - I_b over mu in [0.05, 1], and the same over [0.1, 1] (the range the table was fitted on). */
function profDiff(lawA, a, lawB, b) {
  const ca = toClaret(lawA, a), cb = toClaret(lawB, b); let s = 0, m = 0, s1 = 0, m1 = 0, n1 = 0;
  for (const mu of MU) { const d = intensity(mu, ca) - intensity(mu, cb); s += d * d; m = Math.max(m, Math.abs(d)); if (mu >= 0.1) { s1 += d * d; m1 = Math.max(m1, Math.abs(d)); n1++; } }
  return { rms: Math.sqrt(s / MU.length), max: m, rms1: Math.sqrt(s1 / n1), max1: m1 };
}
/** Transit of a Rp/R* = 0.1 planet, a/R* = 10: relative difference in mid-transit depth at b = 0 and b = 0.5, and the largest flux difference anywhere, in ppm. */
function transitDiff(lawA, a, lawB, b) {
  let depth = 0, flux = 0;
  for (const imp of [0, 0.5, 0.8]) {
    const p = { rprs: 0.1, ars: 10, per: 3, tmid: 0, ecc: 0, omega: 0, inc: Math.acos(imp / 10) * 180 / Math.PI };
    const fa = makeTransit({ ...p, ldLaw: lawA, ld: a }), fb = makeTransit({ ...p, ldLaw: lawB, ld: b });
    if (imp < 0.8) depth = Math.max(depth, Math.abs((1 - fa(0)) / (1 - fb(0)) - 1));
    for (let i = 0; i <= 400; i++) { const t = -0.07 + 0.14 * i / 400; flux = Math.max(flux, Math.abs(fa(t) - fb(t))); }
  }
  return { depth, ppm: flux * 1e6 };
}
const grids = Object.fromEntries(['nonlinear', 'quadratic', 'linear', 'sqrt'].map((law) => [law, gridFromTable(LD_TABLE, law)]));
const table = (law, c) => interpLDGrid(grids[law], c.teff, c.logg, c.feh, c.filter);
const cls = (teff) => (teff < 3900 ? 'M' : teff < 5300 ? 'K' : teff < 6000 ? 'G' : 'F');
const f4 = (x) => x.toFixed(4), e1 = (x) => x.toExponential(1);

// ---- the table itself -----------------------------------------------------------------------
{
  const ax = LD_TABLE.axes, names = Object.keys(LD_TABLE.bands), nNodes = LD_TABLE.rows.filter((r) => r.filter === names[0]).length;
  const box = (g) => ax.teff.filter((t) => LD_TABLE.rows.some((r) => r.filter === names[0] && r.teff === t && r.logg === g)).length;
  check('bundled table is present and complete', LD_TABLE.rows.length === names.length * nNodes && ax.logg.every((g) => box(g) === ax.teff.length || g === 5.5) && LD_TABLE.rows.every((r) => r.nonlinear.every(Number.isFinite) && r.quadratic.every(Number.isFinite) && r.linear.every(Number.isFinite)),
    `${names.length} filters x ${nNodes} nodes; Teff ${ax.teff[0]}-${ax.teff.at(-1)} K (${ax.teff.length}), log g ${ax.logg.join('/')} (5.5 for the ${box(5.5)} coolest Teff only), [Fe/H] ${ax.feh.join('/')}`);
  // the app selects a table column by the band's name in FILTERS
  const missing = Object.keys(FILTERS).filter((k) => !names.includes(k)), extra = names.filter((k) => !(k in FILTERS));
  check('every band in FILTERS has a table column of the same name, and the reverse', missing.length === 0 && extra.length === 0, missing.concat(extra).join(', '));
  check('filter names are matched case-insensitively; an unknown name throws', (() => {
    const a = interpLDGrid(grids.nonlinear, 5000, 4.5, 0, 'tess (APPROX.)').coeffs, b = interpLDGrid(grids.nonlinear, 5000, 4.5, 0, 'TESS (approx.)').coeffs;
    let threw = false; try { interpLDGrid(grids.nonlinear, 5000, 4.5, 0, 'no such band'); } catch { threw = true; }
    return threw && a.every((v, i) => v === b[i]);
  })());
  // a node is returned as stored; between nodes the result is the trilinear mean; outside is clamped and flagged
  const r0 = LD_TABLE.rows.find((r) => r.filter === 'Johnson V' && r.teff === 5800 && r.logg === 4.5 && r.feh === 0);
  const at = interpLDGrid(grids.nonlinear, 5800, 4.5, 0, 'Johnson V'), mid = interpLDGrid(grids.nonlinear, 5850, 4.5, 0, 'Johnson V');
  const r1 = LD_TABLE.rows.find((r) => r.filter === 'Johnson V' && r.teff === 5900 && r.logg === 4.5 && r.feh === 0);
  check('interpolation returns nodes exactly and is linear between them', at.method === 'trilinear' && !at.clamped && at.coeffs.every((v, i) => v === r0.nonlinear[i]) && mid.coeffs.every((v, i) => Math.abs(v - 0.5 * (r0.nonlinear[i] + r1.nonlinear[i])) < 1e-12));
  const hot = interpLDGrid(grids.nonlinear, 9600, 4.1, 0, 'Johnson V'), edge = interpLDGrid(grids.nonlinear, ax.teff.at(-1), 4.1, 0, 'Johnson V'), sub = interpLDGrid(grids.nonlinear, 5375, 3.7, 0.17, 'Johnson V');
  check('outside the table: clamped to the edge and flagged', hot.clamped && sub.clamped && hot.method === 'trilinear' && hot.coeffs.every((v, i) => Math.abs(v - edge.coeffs[i]) < 1e-12) && !interpLDGrid(grids.nonlinear, 2300, 4.0, -0.5, 'Johnson V').clamped && !interpLDGrid(grids.nonlinear, 2566, 5.24, 0.04, 'Johnson V').clamped);
  // log g 5.5 exists for cool stars only: a hotter star asking for log g > 5 gets log g 5.0, interpolated in Teff and [Fe/H], flagged
  const odd = interpLDGrid(grids.nonlinear, 5050, 5.2, 0.1, 'Johnson V'), at5 = interpLDGrid(grids.nonlinear, 5050, 5.0, 0.1, 'Johnson V');
  check('where the grid is not a full box the missing coordinate is clamped, not snapped to a node', odd.clamped && odd.method === 'trilinear' && odd.coeffs.every((v, i) => Math.abs(v - at5.coeffs[i]) < 1e-12));
  // derived laws: the quadratic and linear columns are the least-squares fit to the four-coefficient profile on the builder's mu range
  const mu0 = LD_TABLE.mu_min, mu = LD_TABLE.muFit; let worst = 0;      // the builder's points: even in r from the centre to mu_min
  let nFree = 0, nHeld = 0, heldWorst = 0;
  for (let i = 0; i < LD_TABLE.rows.length; i += 7) {
    const r = LD_TABLE.rows[i], I = mu.map((m) => intensity(m, r.nonlinear)), q = fitLaw('quadratic', { mu, I }), l = fitLaw('linear', { mu, I }).coeffs;
    if (checkProfile(toClaret('quadratic', q.coeffs)).ok && l[0] <= 1) { nFree++; worst = Math.max(worst, Math.abs(q.coeffs[0] - r.quadratic[0]), Math.abs(q.coeffs[1] - r.quadratic[1]), Math.abs(l[0] - r.linear[0])); }
    else if (!checkProfile(toClaret('quadratic', q.coeffs)).ok) { nHeld++; const c = fitLaw('quadratic', { mu, I: mu.map((m) => intensity(m, toClaret('quadratic', r.quadratic))) }); let ss = 0; mu.forEach((m, k) => (ss += (intensity(m, toClaret('quadratic', r.quadratic)) - I[k]) ** 2)); heldWorst = Math.max(heldWorst, Math.sqrt(ss / mu.length) - q.rms); }
  }
  check('quadratic and linear columns equal a direct fit to the four-coefficient profile wherever that fit is physical', worst < 1e-9 && nFree > 1000, `max difference ${e1(worst)} over ${nFree} nodes (${mu.length} points even in r, mu from 1 to ${mu0}); ${nHeld} more were held to the physical region, raising their fit rms by at most ${f4(heldWorst)}`);
  check('kipping and square-root grids come from the same table', gridFromTable(LD_TABLE, 'kipping').rows.length === LD_TABLE.rows.length && gridFromTable(LD_TABLE, 'sqrt').rows[0].c.length === 2 && gridFromTable(LD_TABLE, 'sqrt') === gridFromTable(LD_TABLE, 'sqrt'));
  // the same table through the file reader (compact JSON as a user would load it)
  const again = readLDTable(JSON.stringify(LD_TABLE_COMPACT));
  check('compact table round-trips through readLDTable', again.kind === 'json' && again.table.rows.length === LD_TABLE.rows.length && again.table.rows[1234].nonlinear.every((v, i) => v === LD_TABLE.rows[1234].nonlinear[i]) && expandLDTable(LD_TABLE_COMPACT).rows.length === LD_TABLE.rows.length);
  // physical sanity of every tabulated profile, and how well the lower laws can follow the four-coefficient one
  let bad = 0, nonMono = 0, qWorst = { rms: 0 }, lWorst = { rms: 0 };
  for (const r of LD_TABLE.rows) {
    const c = checkProfile(r.nonlinear); if (c.negative) bad++; if (c.nonMonotonic) nonMono++;
    const q = profDiff('quadratic', r.quadratic, 'nonlinear', r.nonlinear), l = profDiff('linear', r.linear, 'nonlinear', r.nonlinear);
    if (q.rms1 > qWorst.rms) qWorst = { rms: q.rms1, max: q.max1, r }; if (l.rms1 > lWorst.rms) lWorst = { rms: l.rms1, max: l.max1, r };
  }
  // buildProblem rejects a profile that fails checkProfile, so a table default that failed it could not be fitted with
  check('every tabulated four-coefficient profile passes checkProfile (no negative intensity, no limb brightening, mu 0..1)', bad === 0 && nonMono === 0, `${bad} negative, ${nonMono} non-monotonic of ${LD_TABLE.rows.length}`);
  const fails = (law) => gridFromTable(LD_TABLE, law).rows.filter((r) => !checkProfile(toClaret(law, r.c)).ok).length;
  const nf = ['linear', 'quadratic', 'kipping', 'sqrt'].map(fails);
  check('every derived law (linear, quadratic, Kipping, square-root) passes checkProfile at every node', nf.every((n) => n === 0), `failures: ${nf.join(', ')}`);
  // ... and so does anything interpolated between nodes (the physical regions are convex)
  { let bad = 0, n = 0; const names = Object.keys(LD_TABLE.bands);
    for (let k = 0; k < 4000; k++) { const u = (j) => ((k * [0.6180339887, 0.7548776662, 0.5698402910, 0.3819660113][j]) % 1), T = 2300 + 5700 * u(0), g = 4 + (T <= 4000 ? 1.5 : 1) * u(1), z = -0.5 + u(2), f = names[Math.floor(u(3) * names.length)];
      for (const law of ['nonlinear', 'quadratic', 'linear', 'sqrt']) { n++; if (!checkProfile(toClaret(law, interpLDGrid(gridFromTable(LD_TABLE, law), T, g, z, f).coeffs)).ok) bad++; } }
    check('interpolated profiles pass checkProfile too', bad === 0, `${bad} of ${n} at 4000 quasi-random (Teff, log g, [Fe/H], band) points`); }
  console.log(`info how much a simpler law loses against the four-coefficient profile, mu in [0.1, 1], worst node: quadratic rms ${f4(qWorst.rms)} max ${f4(qWorst.max)} (${qWorst.r.filter}, ${qWorst.r.teff} K); linear rms ${f4(lWorst.rms)} max ${f4(lWorst.max)} (${lWorst.r.filter}, ${lWorst.r.teff} K)`);
}

// ---- the published anchor: HD 80606, TESS band, ExoTETHyS coefficients used throughout EXOTIC's examples -----
{
  const A = ref.anchor, t = table('nonlinear', A), d = profDiff('nonlinear', t.coeffs, 'nonlinear', A.nonlinear), tr = transitDiff('nonlinear', t.coeffs, 'nonlinear', A.nonlinear);
  console.log(`info HD 80606 TESS: table [${t.coeffs.map(f4)}] vs published [${A.nonlinear.map(f4)}]`);
  check('HD 80606 / TESS anchor: profile', d.rms < 1e-4 && d.max < 1.5e-4, `I(mu) rms ${e1(d.rms)}, max ${e1(d.max)} over mu in [0.05, 1]; rms ${e1(d.rms1)}, max ${e1(d.max1)} over [0.1, 1]`);
  check('HD 80606 / TESS anchor: transit', tr.depth < 1e-4 && tr.ppm < 1, `mid-transit depth differs by ${e1(tr.depth)} (relative), largest flux difference ${tr.ppm.toFixed(2)} ppm for Rp/R* = 0.1`);
  const z = table('nonlinear', { ...A, feh: A.feh_star }), dz = profDiff('nonlinear', z.coeffs, 'nonlinear', A.nonlinear), trz = transitDiff('nonlinear', z.coeffs, 'nonlinear', A.nonlinear);
  console.log(`info the published coefficients are for [Fe/H] = 0 (pylightcurve's PHOENIX set is solar only). At the star's [Fe/H] = ${A.feh_star} the table gives [${z.coeffs.map(f4)}]: rms ${e1(dz.rms)}, max ${e1(dz.max)} from the anchor, depth ${e1(trz.depth)}, ${trz.ppm.toFixed(1)} ppm`);
}

// ---- PHOENIX reference at solar metallicity: stars from M to A, sixteen passbands ---------------------
// Three kinds of case are kept apart:
//   main     the star is inside the table, every model around it exists, and the reference profile is physical
//   hole     one of the eight models around the star is missing from the PHOENIX library. The table fills it along
//            Teff from the two neighbouring models at the same log g and [Fe/H]; pylightcurve widens its cell to
//            log g 4.5-5.5 instead. Holding out models that do exist, the first way is off by 0.001-0.003 rms and
//            the second by 0.004-0.007 (cool stars), so most of the difference in these cases is the reference's.
//   limited  the reference's own coefficients fail checkProfile (negative or limb-brightened below mu ~ 0.1). The
//            table's are constrained not to, so the two must differ; for the square-root law, which cannot follow
//            a steep cool-star profile without brightening at the limb, by a lot (the table falls back to d = 0).
{
  const ax = LD_TABLE.axes, inside = (c) => c.teff >= ax.teff[0] && c.teff <= ax.teff.at(-1) && c.logg >= ax.logg[0] && c.logg <= (c.teff <= 4000 ? 5.5 : 5.0);
  const filled = LD_TABLE.filled['vis-lowres'], around = (axis, x) => { const i = axis.findIndex((v) => v >= x); return i <= 0 ? [axis[Math.max(i, 0)]] : [axis[i - 1], axis[i]]; };
  const nearHole = (c) => filled.some(([t, g, z]) => around(ax.teff, c.teff).includes(t) && around(ax.logg, c.logg).includes(g) && around(ax.feh, c.feh).includes(z));
  const agg = {}, add = (key, d, tr, c) => { const a = (agg[key] ||= { n: 0, rms: 0, max: 0, rms1: 0, max1: 0, depth: 0, ppm: 0, at: '' }); a.n++; if (d.rms >= a.rms) { a.rms = d.rms; a.at = `${c.star.split(' (')[0]}, ${c.filter}`; } a.max = Math.max(a.max, d.max); a.rms1 = Math.max(a.rms1, d.rms1); a.max1 = Math.max(a.max1, d.max1); a.depth = Math.max(a.depth, tr.depth); a.ppm = Math.max(a.ppm, tr.ppm); };
  for (const c of ref.cases.filter((c) => c.model === 'phoenix')) {
    for (const law of ['nonlinear', 'quadratic', 'sqrt', 'linear']) {
      const t = table(law, c), d = profDiff(law, t.coeffs, law, c[law]), tr = transitDiff(law, t.coeffs, law, c[law]);
      if (inside(c) !== !t.clamped) check('clamped flag agrees with the table range', false, c.star);
      const kind = t.clamped ? 'clamped' : nearHole(c) ? 'hole' : !checkProfile(toClaret(law, c[law])).ok ? 'limited' : 'main';
      add(`${law} | ${kind}`, d, tr, c);
      if (kind === 'main') add(`${law} | main | type ${cls(c.teff)}`, d, tr, c);
      if (kind === 'main' && law === 'nonlinear') { add(`${law} | main | band ${c.filter}`, d, tr, c); add(`${law} | main | star ${c.star}`, d, tr, c); }
      if (kind === 'clamped' && law === 'nonlinear') add(`${law} | clamped | ${c.star}`, d, tr, c);
    }
  }
  const line = (k) => { const a = agg[k]; return `${k.padEnd(46)} n=${String(a.n).padStart(3)}  rms ${f4(a.rms)}  max ${f4(a.max)}  | mu>=0.1: rms ${f4(a.rms1)}  max ${f4(a.max1)}  | depth ${e1(a.depth)}  flux ${a.ppm.toFixed(1).padStart(5)} ppm  (worst: ${a.at})`; };
  console.log('info table vs ExoTETHyS/PHOENIX at [Fe/H] = 0, worst case in each group. I(mu) differences over mu in [0.05, 1] and over [0.1, 1]; relative depth and largest flux difference for a transit with Rp/R* = 0.1');
  for (const k of Object.keys(agg).sort()) console.log('info   ' + line(k));
  const within = (a, t) => a && a.rms < t.rms && a.max < t.max && a.rms1 < t.rms1 && a.max1 < t.max1 && a.depth < t.depth && a.ppm < t.ppm;
  const say = (a) => `rms ${f4(a.rms)}, max ${f4(a.max)} (mu >= 0.05); rms ${f4(a.rms1)}, max ${f4(a.max1)} (mu >= 0.1); depth ${e1(a.depth)}, flux ${a.ppm.toFixed(1)} ppm; n = ${a.n}`;
  for (const [law, label] of [['nonlinear', 'four-coefficient'], ['quadratic', 'quadratic'], ['sqrt', 'square-root'], ['linear', 'linear']]) {
    for (const T of ['F', 'G', 'K', 'M']) { const a = agg[`${law} | main | type ${T}`]; check(`${label} law, ${T} stars${T === 'F' ? ' (incl. the A5 star)' : ''}`, within(a, TOL[law][T]), say(a)); }
  }
  check('near a missing model the table and the reference stay within the cost of bridging it', within(agg['nonlinear | hole'], TOL.hole), say(agg['nonlinear | hole']));
  for (const law of ['nonlinear', 'quadratic', 'sqrt', 'linear']) if (agg[`${law} | limited`]) console.log(`info ${law}: ${agg[`${law} | limited`].n} cases where the reference profile is itself unphysical and the table's is not: ${say(agg[`${law} | limited`])}`);
  check('clamping: a subgiant just below the log g range costs little, a star 1600 K off the hot end costs a lot', within(agg['nonlinear | clamped | KELT-11 (G8 subgiant, log g outside the table)'], TOL.clampNear) && agg['nonlinear | clamped | KELT-9 (B9.5, Teff outside the table)'].rms > 0.02,
    `KELT-11 (log g 3.7): ${say(agg['nonlinear | clamped | KELT-11 (G8 subgiant, log g outside the table)'])} || KELT-9 (9600 K): rms ${f4(agg['nonlinear | clamped | KELT-9 (B9.5, Teff outside the table)'].rms)}, depth ${e1(agg['nonlinear | clamped | KELT-9 (B9.5, Teff outside the table)'].depth)}`);
}

// ---- ATLAS reference: a different atmosphere code, with metallicity -------------------------------
{
  const cases = ref.cases.filter((c) => c.model === 'atlas'), key = (c) => c.star + '|' + c.filter, zero = new Map(cases.filter((c) => c.feh === 0).map((c) => [key(c), c]));
  let abs = { rms: 0 }, nAbs = 0, sAbs = 0, resp = [], worstResp = { v: 0 };
  for (const c of cases) {
    const t = table('nonlinear', c); if (t.clamped) continue;
    const d = profDiff('nonlinear', t.coeffs, 'nonlinear', c.nonlinear); nAbs++; sAbs += d.rms1; if (d.rms1 > abs.rms) abs = { rms: d.rms1, max: d.max1, c };
    if (c.feh === 0 || Math.abs(c.feh) < 0.1) continue;
    // metallicity response: I([Fe/H]) - I(0) from the table and from ATLAS, mu in [0.1, 1]
    const z0 = zero.get(key(c)), t0 = table('nonlinear', { ...c, feh: 0 }), ct = toClaret('nonlinear', t.coeffs), ct0 = toClaret('nonlinear', t0.coeffs);
    let sT = 0, sA = 0, sD = 0, n = 0;
    for (const mu of MU) { if (mu < 0.1) continue; const a = intensity(mu, ct) - intensity(mu, ct0), b = intensity(mu, c.nonlinear) - intensity(mu, z0.nonlinear); sT += a * a; sA += b * b; sD += (a - b) ** 2; n++; }
    const r = { star: c.star, filter: c.filter, feh: c.feh, table: Math.sqrt(sT / n), atlas: Math.sqrt(sA / n), diff: Math.sqrt(sD / n) }; resp.push(r); if (r.diff > worstResp.v) worstResp = { v: r.diff, r };
  }
  console.log(`info table (PHOENIX) vs ExoTETHyS/ATLAS, absolute, mu in [0.1, 1], ${nAbs} cases with Teff >= 3500 K: mean rms ${f4(sAbs / nAbs)}, worst rms ${f4(abs.rms)} max ${f4(abs.max)} (${abs.c.star}, ${abs.c.filter}). This is the spread between two atmosphere codes, not an error of the table.`);
  const mean = (k) => resp.reduce((s, r) => s + r[k], 0) / resp.length;
  console.log(`info metallicity response I([Fe/H]) - I(0), rms over mu in [0.1, 1], ${resp.length} star/band cases with |[Fe/H]| >= 0.1: table ${f4(mean('table'))}, ATLAS ${f4(mean('atlas'))}, difference between the two responses ${f4(mean('diff'))} on average, worst ${f4(worstResp.v)} (${worstResp.r.star}, ${worstResp.r.filter})`);
  check('PHOENIX table and ATLAS agree to the level two atmosphere codes do', abs.rms < TOL.atlasRms, `worst rms ${f4(abs.rms)}`);
  check('the table responds to [Fe/H] and the response is of the size ATLAS gives', mean('table') > 0.3 * mean('atlas') && mean('table') < 3 * mean('atlas') && worstResp.v < TOL.respRms, `mean response ${f4(mean('table'))} vs ${f4(mean('atlas'))}`);
  // log g: a 0.5 dex step must change the profile, by less than a 0.5 dex step in [Fe/H] changes a solar-type star's B band
  const g = profDiff('nonlinear', table('nonlinear', { teff: 5772, logg: 4.0, feh: 0, filter: 'Johnson B' }).coeffs, 'nonlinear', table('nonlinear', { teff: 5772, logg: 4.5, feh: 0, filter: 'Johnson B' }).coeffs);
  const z = profDiff('nonlinear', table('nonlinear', { teff: 5772, logg: 4.5, feh: 0.5, filter: 'Johnson B' }).coeffs, 'nonlinear', table('nonlinear', { teff: 5772, logg: 4.5, feh: 0, filter: 'Johnson B' }).coeffs);
  check('the table responds to log g', g.rms1 > 1e-4, `Sun, B band: 0.5 dex in log g moves I(mu) by ${f4(g.rms1)} rms, 0.5 dex in [Fe/H] by ${f4(z.rms1)}`);
}

// ---- following the star in a fit: makeLDTie on the bundled table -------------------------------------
{
  const tie = makeLDTie({ law: 'nonlinear', source: 'grid', grid: grids.nonlinear, filter: 'TESS (approx.)', logg: 4.4, teffRange: [5265, 5865], fehRange: [0.05, 0.65] }), out = [0, 0, 0, 0];
  let worst = 0;
  for (const [T, Z] of [[5565, 0.35], [5412, 0.21], [5790, 0.58], [5300, 0.1]]) { tie(T, Z, out); worst = Math.max(worst, profDiff('nonlinear', out, 'nonlinear', interpLDGrid(grids.nonlinear, T, 4.4, Z, 'TESS (approx.)').coeffs).max); }
  check('makeLDTie on the bundled table follows the direct interpolation', worst < 1e-3, `max I(mu) difference ${e1(worst)} (its 17 x 7 lookup does not land on the table's 100 K nodes)`);
}
process.exit(ok ? 0 : 1);
