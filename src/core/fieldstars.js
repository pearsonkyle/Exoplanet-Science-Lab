// Comparison stars with a catalogue: once a frame has a WCS (src/core/platesolve.js), each detected star gets its Gaia
// DR3 counterpart, and the ranking of src/core/imexam.js rankComparisons (brightness, saturation, isolation among the
// detected stars, edge, width, elongation) is extended with what only the catalogue knows: the G magnitude and BP-RP
// colour against the target's, variability (Gaia DR3 phot_variable_flag, the AAVSO VSX index), and neighbours too faint
// to be detected that still put light in the aperture. Pure: no DOM, no network.
import { rankComparisons } from './imexam.js';
import { separation } from './platesolve.js';

/**
 * Give each detected star its nearest Gaia star within `radius` arcsec.
 * @param stars [{ x, y, ... }] pixels; wcs { pixToSky, skyToPix, scale }; gaia [{ ra, dec, g, bprp, variable, source }]
 * @returns the stars as new objects with { ra, dec, gaia (or null), gaiaSep [arcsec] }
 */
export function crossMatch(stars, wcs, gaia, { radius } = {}) {
  const r = radius ?? Math.max(2, 1.5 * wcs.scale), rPx = r / wcs.scale;
  const P = gaia.map((g) => wcs.skyToPix(g.ra, g.dec));
  return stars.map((s) => {
    const [ra, dec] = wcs.pixToSky(s.x, s.y);
    let best = -1, bd = Infinity;
    for (let k = 0; k < P.length; k++) {
      const dx = P[k][0] - s.x, dy = P[k][1] - s.y; if (Math.abs(dx) > rPx || Math.abs(dy) > rPx) continue;
      const d = Math.hypot(dx, dy); if (d <= rPx && d < bd) { bd = d; best = k; }
    }
    return { ...s, ra, dec, gaia: best >= 0 ? gaia[best] : null, gaiaSep: best >= 0 ? separation(ra, dec, gaia[best].ra, gaia[best].dec) : NaN };
  });
}

/**
 * Light from other Gaia stars inside a circle of `radius` arcsec around a catalogue star, as a fraction of its own
 * (sum of 10^(-0.4 (G_other - G))). Neighbours closer than `self` arcsec are taken to be the star itself.
 * @returns { fraction, list: [{ g, sep, frac }] } brightest contribution first
 */
export function contamination(star, gaia, radius, self = 0.3) {
  const list = [];
  if (!star || !Number.isFinite(star.g)) return { fraction: NaN, list };
  const dd = radius / 3600 + 1e-9;
  for (const o of gaia) {
    if (o === star || Math.abs(o.dec - star.dec) > dd || !Number.isFinite(o.g)) continue;
    const s = separation(star.ra, star.dec, o.ra, o.dec); if (s > radius || s < self) continue;
    list.push({ g: o.g, sep: s, frac: 10 ** (-0.4 * (o.g - star.g)), source: o.source });
  }
  list.sort((a, b) => b.frac - a.frac);
  return { fraction: list.reduce((a, q) => a + q.frac, 0), list };
}

/**
 * Rank comparison stars using the catalogue as well as the image.
 * @param sources  detected stars from crossMatch (optionally with psfShape fields), the target among them or not
 * @param target   { x, y, flux, gaia }
 * @param opts     { w, h, fwhm [px], saturation, scale [arcsec/px], gaia (full list, faint stars included), vsx [{ name, ra, dec, type }],
 *                   apertureFwhm = 2 (radius, in FWHM, within which neighbours count), maxColour = 0.5 (mag of BP-RP difference before it is noted),
 *                   maxContamination = 0.05 }
 * @returns rankComparisons' list with { gaia, dG, dColour, variable, vsx, contamination, neighbours } added, notes extended,
 *          `usable` false for variables, heavy contamination and stars with no Gaia counterpart; sorted best first
 */
export function rankWithCatalog(sources, target, opts = {}) {
  const { fwhm = 4, scale = 1, gaia = [], vsx = [], apertureFwhm = 2, maxColour = 0.5, maxContamination = 0.05 } = opts;
  const base = rankComparisons(sources, target, { w: opts.w, h: opts.h, fwhm, saturation: opts.saturation, crowd: opts.crowd, maxRatio: opts.maxRatio });
  const tg = target && target.gaia, rAp = apertureFwhm * fwhm * scale, vsxTol = Math.max(3, 1.5 * scale);
  const out = base.map((q) => {
    const g = q.gaia, notes = [...q.notes]; let pen = q.score, usable = q.usable;
    let dG = NaN, dColour = NaN, variable = false, vs = null, cont = { fraction: NaN, list: [] };
    if (!g) { notes.push('no Gaia star here'); pen += 2; usable = false; }
    else {
      if (tg && Number.isFinite(tg.g) && Number.isFinite(g.g)) { dG = g.g - tg.g; pen += 0.3 * Math.abs(dG); }
      if (tg && Number.isFinite(tg.bprp) && Number.isFinite(g.bprp)) { dColour = g.bprp - tg.bprp; pen += Math.min(4, Math.abs(dColour) / 0.4); if (Math.abs(dColour) > maxColour) notes.push(`${dColour > 0 ? 'redder' : 'bluer'} by ${Math.abs(dColour).toFixed(2)} in BP−RP`); }
      if (g.variable) { variable = true; notes.push('Gaia DR3: variable'); }
      cont = contamination(g, gaia, rAp, Math.min(1, 0.3 * scale));
      if (cont.fraction > 0.01) { const n = cont.list[0]; notes.push(`Gaia neighbour G ${n.g.toFixed(1)} at ${n.sep.toFixed(1)}″ (${(100 * cont.fraction).toFixed(cont.fraction < 0.1 ? 1 : 0)}% of its light)`); pen += Math.min(4, 8 * cont.fraction); if (cont.fraction > maxContamination) usable = false; }
    }
    const ra = g ? g.ra : q.ra, dec = g ? g.dec : q.dec;
    if (Number.isFinite(ra)) for (const v of vsx) { if (Math.abs(v.dec - dec) > 0.01) continue; if (separation(ra, dec, v.ra, v.dec) <= vsxTol) { vs = v; variable = true; notes.push(`VSX: ${v.name}${v.type ? ' (' + v.type + ')' : ''}`); break; } }
    if (variable) { pen += 10; usable = false; }
    return { ...q, gaia: g, dG, dColour, variable, vsx: vs, contamination: cont.fraction, neighbours: cont.list.slice(0, 3), notes, score: pen, usable };
  });
  return out.sort((a, b) => a.score - b.score);
}
