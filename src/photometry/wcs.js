// The "Field" card of the photometry page: sky coordinates for the frames (a WCS from the header, from a plate solve
// against Gaia DR3 done here, or from a file astrometry.net returned), the target found by name, comparison stars
// ranked with Gaia (magnitude, colour, variability, faint neighbours), and aperture radii set from each star's
// signal to noise. The science is in src/core/platesolve.js, src/core/fieldstars.js and src/core/imexam.js; this file
// fetches the catalogues (VizieR answers with CORS) and draws.
import { readWcs, framePointing, pixelScale } from '../core/fits.js';
import { centroidIter, detectSources, fitPsf, matchAsterism } from '../core/photometry.js';
import { radialProfile, optimalAperture, gainFromSky, saturationLevel, psfShape } from '../core/imexam.js';
import { solveField, starsForSolving, wcsFromHeader, wcsThrough, gaiaConeUrl, vsxConeUrl, sesameUrl, parseGaia, parseVsx, parseSesame, atEpoch, separation } from '../core/platesolve.js';
import { crossMatch, rankWithCatalog, contamination } from '../core/fieldstars.js';
import { parseASU, VIZIER_MIRRORS, describeFailure } from '../core/rvsources.js';
import { loadIndex, lookupHost } from '../core/catalog.js';
import { readHeaderOnly } from './pipeline.js';
import { siteJson, reportDown, reportUp } from '../site/net.js';
import { PHOT_DARK } from './plots.js';   // marks drawn on the (dark) image keep their bright colours in every theme

const NOVA = 'https://nova.astrometry.net/upload';
const fx = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pad = (v, n, d = 0) => { const s = v.toFixed(d); return s.padStart(n + (d ? d + 1 : 0), '0'); };
/** RA, Dec in degrees as "hh:mm:ss.s ±dd:mm:ss". */
export function sexagesimal(ra, dec) {
  let h = ((ra % 360) + 360) % 360 / 15, m = (h - Math.floor(h)) * 60, s = (m - Math.floor(m)) * 60; if (s >= 59.95) { s = 0; m = Math.floor(m) + 1; } if (m >= 60) { m = 0; h += 1; }
  const a = Math.abs(dec); let d = Math.floor(a), dm = (a - d) * 60, ds = (dm - Math.floor(dm)) * 60; if (ds >= 59.5) { ds = 0; dm = Math.floor(dm) + 1; } if (dm >= 60) { dm = 0; d += 1; }
  return `${pad(Math.floor(h) % 24, 2)}:${pad(Math.floor(m), 2)}:${pad(s, 2, 1)} ${dec < 0 ? '−' : '+'}${pad(d, 2)}:${pad(Math.floor(dm), 2)}:${pad(ds, 2)}`;
}
// "02 04 10.3 +46 41 16", "02:04:10.3, +46:41:16", "31.0428 46.6878": [ra, dec] degrees, or null
function parseCoords(s) {
  const t = String(s || '').trim().replace(/[,;]/g, ' ').replace(/[hdms°′″'"]/g, ' ').replace(/\s+/g, ' ').trim(); if (!t) return null;
  const p = t.split(' ');
  const num = (x) => /^[+\-−]?\d+(\.\d*)?$/.test(x);
  if (p.length === 2 && p.every(num)) { const ra = +p[0], dec = +p[1].replace('−', '-'); return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? [ra, dec] : null; }
  if (p.length === 6 && p.every(num)) { const ra = 15 * (+p[0] + +p[1] / 60 + +p[2] / 3600), sg = /^[-−]/.test(p[3]) ? -1 : 1, dec = sg * (Math.abs(+p[3].replace('−', '-')) + +p[4] / 60 + +p[5] / 3600); return ra < 360 && Math.abs(dec) <= 90 ? [ra, dec] : null; }
  return null;
}

/**
 * @param ctx { P, h, $, viewer, siteRoot, setStatus(id, text, cls), addStarAt(x, y, asTarget), showFrame(i), buildStarsCard(), gain() }
 */
export function createFieldTools(ctx) {
  const { P, h, $, viewer } = ctx;
  // F.wcs: the WCS of the first frame ({ pixToSky, skyToPix, scale, ... }); F.source: where it came from
  const F = { wcs: null, source: '', sol: null, gaia: null, vsx: null, stars: null, target: null, ranked: null, apertures: null, busy: false, msg: '', msgCls: '', showGaia: true, perFrame: new Map(), nTop: 4 };
  P.field = F;
  const el = () => $('cardWcs');
  const H0 = () => (P.lights[0] && P.lights[0].header) || (P.cur && P.cur.header) || {};
  const say = (text, cls = '') => { F.msg = text; F.msgCls = cls; const s = el() && el().querySelector('.fstat'); if (s) { s.textContent = text; s.className = 'status fstat ' + cls; } };

  // ---------------------------------------------------------------- the WCS of the frame shown
  /** WCS of frame i: the first frame's, carried through the frame-to-frame transform found by matching its stars. */
  function wcsFor(i = P.frame) {
    if (!F.wcs) return null;
    if (i === 0) return F.wcs;
    if (F.perFrame.has(i)) return F.perFrame.get(i);
    if (!P.cur || P.frame !== i || !F.stars) return null;
    const cur = detectSources(P.cur.data, P.cur.width, P.cur.height, { max: 60 }).sources;
    const T = matchAsterism(cur, F.stars, { mirror: true, tol: 3, scaleTol: 0.03 });
    const W = T ? wcsThrough(F.wcs, T) : null; F.perFrame.set(i, W); return W;
  }
  /** " · RA 02:04:10.3 Dec +46:41:16" for the readout, or ''. */
  function radec(x, y) { const W = wcsFor(); if (!W) return ''; const [ra, dec] = W.pixToSky(x, y); return Number.isFinite(ra) ? `   ${sexagesimal(ra, dec)}` : ''; }

  // ---------------------------------------------------------------- names and catalogues
  let catIndex = null;
  async function resolve(text) {
    const s = String(text || '').trim(); if (!s) return null;
    const c = parseCoords(s); if (c) return { name: s, ra: c[0], dec: c[1], from: 'typed coordinates' };
    try {
      const root = ctx.siteRoot(), fj = (nm) => siteJson(new URL('catalog/' + nm, root), "The site's catalogue");
      catIndex = catIndex || await loadIndex(fj);
      const host = await lookupHost(catIndex, s, fj);
      if (host && Number.isFinite(host.system.ra)) return { name: host.host, ra: host.system.ra, dec: host.system.dec, gaiaMag: host.system.sy_gaiamag, from: `the site's catalogue (NASA Exoplanet Archive, ${host.snapshot})` };
    } catch { /* not in the catalogue, or it could not be read: Sesame next */ }
    let reached = false, last = null;
    for (const base of VIZIER_MIRRORS) {
      try { const r = parseSesame(await fetchText(sesameUrl(base, s), 15000)); reached = true; if (r) return { name: s, ra: r.ra, dec: r.dec, from: 'CDS Sesame (SIMBAD)' }; else break; } catch (e) { last = e; /* next mirror */ }
    }
    if (reached) reportUp('SIMBAD (CDS Sesame)'); else reportDown('SIMBAD (CDS Sesame)', last);
    return { name: s, unknown: true, ...(reached ? {} : { unreachable: true }) };
  }
  async function fetchText(url, ms = 45000) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); } finally { clearTimeout(t); }
  }
  async function vizier(makeUrl, parse) {
    let last = null;
    for (const base of VIZIER_MIRRORS) { try { const out = parse(await fetchText(makeUrl(base)), parseASU); reportUp('VizieR (Gaia DR3, VSX)'); return out; } catch (e) { last = e; } }
    reportDown('VizieR (Gaia DR3, VSX)', last);
    throw new Error('VizieR could not be reached: ' + (navigator.onLine === false ? 'you are offline. Plate solving needs the Gaia catalogue; the rest of the page works.' : describeFailure(last)));
  }
  const year = () => { const jd = P.lights[0] && P.lights[0].jd; return Number.isFinite(jd) ? 2000 + (jd - 2451545) / 365.25 : 2016; };

  // ---------------------------------------------------------------- solving
  /**
   * Solve the first frame against Gaia DR3. opts { target (name or coordinates), scale (arcsec/px), ra, dec }.
   * @returns the solveField result, or throws with a plain-words reason
   */
  async function solve(opts = {}) {
    if (P.mode !== 'stack') throw new Error('plate solving is for an image stack');
    if (F.busy) throw new Error('already solving');
    F.busy = true; render();
    try {
      if (P.frame !== 0 || !P.cur) await ctx.showFrame(0);
      const img = P.cur, Hd = img.header || H0(), W = img.width, Hh = img.height;
      const tText = opts.target ?? ($('fTarget') ? $('fTarget').value : '');
      // where the frame points: what the user typed or named first, then the header
      say('Finding the target…');
      if (tText && (!F.target || F.target.name !== tText)) F.target = await resolve(tText);
      if (Number.isFinite(opts.ra) && Number.isFinite(opts.dec)) F.target = { name: opts.name || `${fx(opts.ra, 5)} ${fx(opts.dec, 5)}`, ra: opts.ra, dec: opts.dec, from: 'given coordinates' };
      const centres = [];
      if (F.target && !F.target.unknown) centres.push({ ra: F.target.ra, dec: F.target.dec, what: F.target.name, full: true });
      const pt = framePointing(Hd); if (Number.isFinite(pt.ra) && Number.isFinite(pt.dec) && !centres.some((c) => separation(c.ra, c.dec, pt.ra, pt.dec) < 30)) centres.push({ ra: pt.ra, dec: pt.dec, what: 'the header pointing', full: false });
      if (!centres.length) throw new Error(F.target && F.target.unknown ? `“${F.target.name}” was not found in the site's catalogue or by Sesame, and the header has no RA / DEC. Type the target's coordinates (e.g. 02 04 10.3 +46 41 16).` : 'No pointing: the header has no RA / DEC (or OBJCTRA / OBJCTDEC). Type the target name or its coordinates.');
      // the image scale: typed, the header (IM_SCALE, PIXSCALE, XPIXSZ and FOCALLEN, ...), else a series of guesses
      const typed = opts.scale ?? (parseFloat($('fScale') ? $('fScale').value : '') || NaN), hs = pixelScale(Hd).scale, scale = typed > 0 ? typed : hs > 0 ? hs : NaN;
      const guesses = scale > 0 ? [{ s: scale, tol: 0.15 }] : [0.4, 0.8, 1.6, 3.2, 6.4, 12.8].map((s) => ({ s, tol: 0.42 }));
      say('Measuring the stars of the first frame…');
      const det = starsForSolving(img.data, W, Hh, { saturation: saturationLevel(Hd).level });
      F.stars = det.sources;
      if (det.sources.length < 8) throw new Error(`Only ${det.sources.length} stars were found on the first frame: too few to solve (8 or more are needed).`);
      let res = null, tried = [];
      for (const g of guesses) for (const c of centres) {
        const diag = Math.hypot(W, Hh) * g.s * (1 + g.tol) / 60, radius = Math.min(180, (c.full ? 1.0 : 0.75) * diag + 2);
        say(`Asking Gaia DR3 (VizieR) for the stars within ${radius.toFixed(0)}′ of ${c.what}${guesses.length > 1 ? `, for about ${g.s}″ per pixel` : ''}…`);
        const gaia = atEpoch(await vizier((b) => gaiaConeUrl(b, c.ra, c.dec, radius, { gmax: 19.5, max: 3000 }), parseGaia), year());
        say(`Matching ${det.sources.length} stars to ${gaia.length} Gaia stars…`);
        await new Promise((r) => setTimeout(r, 0));
        const r = solveField(det.sources, gaia, { width: W, height: Hh, ra: c.ra, dec: c.dec, scale: g.s, scaleTol: g.tol });
        tried.push(`${c.what}${guesses.length > 1 ? ` at ${g.s}″/px` : ''}: ${r.message}`);
        if (r.ok) { res = r; F.gaia = gaia; F.cone = { ra: c.ra, dec: c.dec, radius }; break; }
      }
      if (!res) throw new Error(`No solution. ${tried.join('; ')}. Check the target name or type its coordinates, and the image scale${scale > 0 ? ` (${fx(scale, 3)}″/px from ${typed > 0 ? 'what you typed' : pixelScale(Hd).source})` : ''}; or solve the frame at astrometry.net and load the file it returns.`);
      F.wcs = res.wcs; F.sol = res; F.source = 'Gaia DR3 plate solve (this page)'; F.perFrame.clear(); F.ranked = null;
      say(`Solved: ${res.message}. ${res.offset > 1 ? `The frame centre is ${res.offset.toFixed(1)}′ from ${centres[0].what}.` : ''}`, 'ok');
      // variables near the field for the ranking (not needed for the solution: a failure here is only reported)
      vizier((b) => vsxConeUrl(b, F.cone.ra, F.cone.dec, F.cone.radius), parseVsx).then((v) => { F.vsx = v; render(); }).catch((e) => { F.vsx = null; F.vsxErr = String(e.message || e); render(); });
      placeTarget();
      fillCoords();
      return res;
    } catch (e) { say(String(e.message || e), 'err'); throw e; } finally { F.busy = false; render(); viewer.draw(); }
  }
  // the target's RA / Dec into the settings (for BJD) when they are empty or came from the header
  function fillCoords() { const t = F.target; if (!t || t.unknown || !$('sRa')) return; const hp = framePointing(H0()); const fromHeader = (id, v) => !$(id).value || Math.abs(parseFloat($(id).value) - v) < 1e-4; if (fromHeader('sRa', hp.ra) && fromHeader('sDec', hp.dec)) { $('sRa').value = String(+t.ra.toFixed(6)); $('sDec').value = String(+t.dec.toFixed(6)); } }

  /** Header WCS (or none) when frames are opened. */
  function reset() {
    Object.assign(F, { wcs: null, source: '', sol: null, gaia: null, vsx: null, stars: null, ranked: null, apertures: null, target: null, msg: '', msgCls: '' }); F.perFrame.clear();
    if (P.mode === 'stack' && P.lights.length) {
      const Hd = H0(), W = wcsFromHeader(Hd) || (() => { const r = readWcs(Hd); return r && !r.approximate ? r : null; })();
      if (W && Number.isFinite(W.scale) && W.scale > 0 && W.scale < 3600) { F.wcs = W; F.source = `the FITS header (${/-SIP/i.test(String(Hd.CTYPE1 || '')) ? 'TAN-SIP' : 'TAN'})`; F.msg = `The header has a WCS: ${fx(W.scale, 3)}″/px. Solve again to check it against Gaia.`; }
    }
    render();
  }

  // ---------------------------------------------------------------- astrometry.net's files
  async function loadAstrometryNet(file) {
    try {
      const hd = await readHeaderOnly(file), Hd = hd.header, W = wcsFromHeader(Hd);
      if (!W) throw new Error(`${file.name} has no TAN WCS (CRVAL, CRPIX, CD).`);
      const iw = Number(Hd.IMAGEW || (Hd.NAXIS > 0 ? Hd.NAXIS1 : NaN)), ih = Number(Hd.IMAGEH || (Hd.NAXIS > 0 ? Hd.NAXIS2 : NaN)), c = P.lights[0] && (P.cur || {});
      if (c && Number.isFinite(iw) && Number.isFinite(ih) && c.width && (iw !== c.width || ih !== c.height)) throw new Error(`${file.name} is for a ${iw} × ${ih} image; the first frame is ${c.width} × ${c.height}.`);
      if (P.frame !== 0) await ctx.showFrame(0);
      F.wcs = W; F.source = `astrometry.net (${file.name})`; F.sol = null; F.perFrame.clear(); F.ranked = null;
      F.stars = detectSources(P.cur.data, P.cur.width, P.cur.height, { max: 120 }).sources;
      say(`WCS from ${file.name}: ${fx(W.scale, 3)}″/px${W.sip ? ', SIP order ' + W.sip.order : ''}. Gaia stars are fetched when you rank comparisons.`, 'ok');
      placeTarget(); render(); viewer.draw();
    } catch (e) { say(String(e.message || e), 'err'); }
  }

  // ---------------------------------------------------------------- the target
  function placeTarget() {
    const t = F.target; if (!F.wcs || !t || t.unknown || !P.cur) { if (t) t.px = null; return; }
    const W0 = F.wcs, [x, y] = W0.skyToPix(t.ra, t.dec), c = P.cur, inside = x >= 0 && y >= 0 && x <= c.width - 1 && y <= c.height - 1;
    t.px = Number.isFinite(x) ? [x, y] : null; t.inside = inside; t.star = null;
    if (inside && P.frame === 0) { const q = centroidIter(c.data, c.width, c.height, x, y, 6); if (q[2] > 0 && Math.hypot(q[0] - x, q[1] - y) < 4) t.star = [q[0], q[1]]; }
    if (F.gaia) { const g = F.gaia.reduce((b, s) => { const d = separation(s.ra, s.dec, t.ra, t.dec); return d < b.d ? { d, s } : b; }, { d: Infinity, s: null }); t.gaia = g.d < Math.max(3, 1.5 * W0.scale) ? g.s : null; }
  }
  async function chooseTarget(text, ra, dec) {
    if (P.mode !== 'stack') throw new Error('load an image stack first');
    if (text != null && $('fTarget')) $('fTarget').value = text;
    if (Number.isFinite(ra) && Number.isFinite(dec)) F.target = { name: text || `${fx(ra, 5)} ${fx(dec, 5)}`, ra, dec, from: 'given coordinates' };
    else if (text) F.target = await resolve(text);
    if (!F.target || F.target.unknown) throw new Error(F.target ? `“${F.target.name}” was not found (site catalogue, Sesame): give coordinates` : 'no target given');
    if (!F.wcs) await solve({ target: F.target.name });
    placeTarget();
    if (!F.target.px || !F.target.inside) throw new Error(`${F.target.name} (${sexagesimal(F.target.ra, F.target.dec)}) falls outside the first frame${F.target.px ? ` (at pixel ${fx(F.target.px[0], 0)}, ${fx(F.target.px[1], 0)})` : ''}`);
    const [x, y] = F.target.star || F.target.px;
    await ctx.addStarAt(x, y, true);
    fillCoords(); render(); viewer.draw();
    return F.target;
  }

  // ---------------------------------------------------------------- comparison stars
  async function rank() {
    if (!F.wcs) throw new Error('solve the WCS first');
    if (P.frame !== 0) await ctx.showFrame(0);
    const c = P.cur, Hd = c.header || H0(), sat = saturationLevel(Hd).level;
    if (!F.gaia) {
      // a WCS from the header or astrometry.net: Gaia around the frame centre
      const [ra, dec] = F.wcs.pixToSky((c.width - 1) / 2, (c.height - 1) / 2), radius = 0.55 * Math.hypot(c.width, c.height) * F.wcs.scale / 60 + 1;
      say(`Asking Gaia DR3 for the stars within ${radius.toFixed(0)}′ of the frame centre…`);
      F.gaia = atEpoch(await vizier((b) => gaiaConeUrl(b, ra, dec, radius, { gmax: 19.5, max: 3000 }), parseGaia), year()); F.cone = { ra, dec, radius };
      try { F.vsx = await vizier((b) => vsxConeUrl(b, ra, dec, radius), parseVsx); } catch (e) { F.vsx = null; F.vsxErr = String(e.message || e); }
    }
    if (!F.vsx && !F.vsxErr && F.cone) { try { F.vsx = await vizier((b) => vsxConeUrl(b, F.cone.ra, F.cone.dec, F.cone.radius), parseVsx); } catch (e) { F.vsxErr = String(e.message || e); } }
    const tgt = P.stars[0] || (F.target && (F.target.star || F.target.px) ? { x: (F.target.star || F.target.px)[0], y: (F.target.star || F.target.px)[1] } : null);
    if (!tgt) throw new Error('choose the target first (by name, or click it)');
    const det = detectSources(c.data, c.width, c.height, { max: 120, saturation: sat }).sources;
    const f0 = fitPsf(c.data, c.width, c.height, tgt.x, tgt.y, 8, { model: 'gaussian', rotate: true }), fwhm = f0.ok ? psfShape(f0).fwhm : 4;
    const shaped = det.map((q, i) => { if (i >= 40 || q.saturated) return q; const g = fitPsf(c.data, c.width, c.height, q.x, q.y, Math.max(5, Math.round(2 * fwhm)), { model: 'gaussian', rotate: true, sigma: fwhm / 2.3548 }); return g.ok ? { ...q, ...psfShape(g) } : q; });
    const X = crossMatch(shaped, F.wcs, F.gaia, { radius: Math.max(2, 1.5 * F.wcs.scale) });
    let ti = -1, bd = 4; X.forEach((s, i) => { const d = Math.hypot(s.x - tgt.x, s.y - tgt.y); if (d < bd) { bd = d; ti = i; } });
    const T = ti >= 0 ? X[ti] : { ...tgt, flux: det[0] ? det[0].flux : 1, gaia: F.target && F.target.gaia };
    F.ranked = rankWithCatalog(X, T, { w: c.width, h: c.height, fwhm, saturation: sat, scale: F.wcs.scale, gaia: F.gaia, vsx: F.vsx || [] }).filter((q) => !P.stars.some((s) => Math.hypot(s.x - q.x, s.y - q.y) < 3));
    F.rankTarget = T; F.rankTarget.contamination = T.gaia ? contamination(T.gaia, F.gaia, 2 * fwhm * F.wcs.scale, Math.min(1, 0.3 * F.wcs.scale)) : null;
    const nv = F.ranked.filter((q) => q.variable).length;
    say(`${F.ranked.filter((q) => q.usable).length} usable comparison stars of ${F.ranked.length} ranked against the target${T.gaia ? ` (G ${fx(T.gaia.g)}, BP−RP ${fx(T.gaia.bprp)})` : ''}${nv ? `; ${nv} known or suspected variable${nv > 1 ? 's' : ''} set aside` : ''}${F.vsx ? '' : ' (VSX could not be read: variables from Gaia only)'}.`, 'ok');
    render(); viewer.draw();
    return F.ranked;
  }
  function addRanked(list) {
    for (const q of list) if (!P.stars.some((s) => Math.hypot(s.x - q.x, s.y - q.y) < 3)) P.stars.push({ x: q.x, y: q.y, peak: q.peak });
    F.ranked = F.ranked.filter((q) => !list.includes(q)); P.result = null; ctx.buildStarsCard(); render(); viewer.draw();
  }

  // ---------------------------------------------------------------- apertures
  /** SNR-optimal radius of every chosen star; the aperture search of the reduction is centred on the target's. */
  async function apertures(apply = true) {
    if (P.mode !== 'stack' || !P.stars.length) throw new Error('choose the target (and comparison stars) first');
    if (P.frame !== 0) await ctx.showFrame(0);
    const c = P.cur, typedG = Number(ctx.gain && ctx.gain()), hdrG = Number(c.header && (c.header.GAIN ?? c.header.EGAIN));
    let g = typedG > 0 ? typedG : hdrG > 0 ? hdrG : NaN, gainNote = typedG > 0 ? 'from Settings' : hdrG > 0 ? 'from the header' : '';
    // the PSF width the reduction uses: a Gaussian fitted to the target (src/photometry/pipeline.js runStack)
    const t = P.stars[0], f = fitPsf(c.data, c.width, c.height, t.x, t.y, 8, { rotate: true }), sigma = f.ok && Number.isFinite(f.sx) ? Math.min(12, Math.max(0.8, 0.5 * (f.sx + f.sy))) : 2;
    const rmax = Math.max(8, Math.min(40, Math.round(6 * sigma)));
    if (!(g > 0)) {
      // gain unknown: the sky's own noise bounds it (src/core/imexam.js gainFromSky)
      const p0 = radialProfile(c.data, c.width, c.height, t.x, t.y, { rmax, recentre: false }), sky = p0.background, sd = p0.backgroundSigma;
      g = gainFromSky(sky, sd).gain;
      gainNote = Number.isFinite(g) ? `unknown: at least ${g.toPrecision(3)} e⁻/ADU from the sky (${sky.toFixed(0)} ± ${sd.toPrecision(3)} ADU), used as is` : 'unknown and the sky is subtracted: photon noise of the stars left out (sky-limited)';
    }
    const rows = P.stars.map((s, i) => {
      const prof = radialProfile(c.data, c.width, c.height, s.x, s.y, { rmax, gain: g, growthStep: 0.1 });   // an unknown gain stays unknown
      const o = optimalAperture(prof, { gain: g });     // gain Infinity: no photon noise from the star
      return { name: i ? 'C' + i : 'T', radius: o ? o.radius : NaN, sigmas: o ? o.radius / sigma : NaN, fwhm: o ? o.radius / (2.3548 * sigma) : NaN, snr: o ? o.snr : NaN, fraction: o ? o.fraction : NaN };
    });
    const tr = rows[0];
    if (!Number.isFinite(tr.radius)) throw new Error('the target\'s curve of growth could not be measured');
    const cc = tr.sigmas, lo = Math.max(0.6, Math.round(10 * cc / 2) / 10), hi = Math.max(lo + 1, Math.round(10 * Math.max(2 * cc, cc + 2)) / 10);
    F.apertures = { rows, sigma, gain: g, gainNote, lo, hi, applied: false };
    if (apply && $('sA0') && $('sA1')) { $('sA0').value = lo; $('sA1').value = hi; F.apertures.applied = true; }
    render();
    return F.apertures;
  }

  // ---------------------------------------------------------------- overlay
  function draw(c, v) {
    const W = wcsFor(); if (!W || P.mode !== 'stack' || !P.cur) return;
    c.save(); c.font = '11px ui-monospace, Menlo, monospace'; c.lineWidth = 1;
    if (F.showGaia && F.gaia) {
      const gl = F.sol && F.sol.matches.length ? Math.max(...F.sol.matches.map((m) => F.gaia[m.cat] ? F.gaia[m.cat].g : 0)) + 0.5 : 16, matched = new Set(F.sol && P.frame === 0 ? F.sol.matches.map((m) => m.cat) : []);
      for (let k = 0; k < F.gaia.length; k++) {
        const s = F.gaia[k]; if (!(s.g <= gl)) break;
        const [x, y] = W.skyToPix(s.ra, s.dec); if (!(x > -2 && y > -2 && x < P.cur.width + 1 && y < P.cur.height + 1)) continue;
        const [sx, sy] = v.toScreen(x, y), r = Math.max(3, 7 - 0.35 * (s.g - 8));
        c.strokeStyle = s.variable ? PHOT_DARK.bad : matched.has(k) ? '#5fd4ffcc' : '#5fd4ff66';
        c.beginPath(); c.moveTo(sx, sy - r); c.lineTo(sx + r, sy); c.lineTo(sx, sy + r); c.lineTo(sx - r, sy); c.closePath(); c.stroke();
      }
    }
    if (F.ranked && P.frame === 0) F.ranked.slice(0, 8).forEach((q, i) => { const [sx, sy] = v.toScreen(q.x, q.y); c.fillStyle = q.usable ? PHOT_DARK.ok : PHOT_DARK.text; c.fillText(String(i + 1), sx + 7, sy + 12); });
    const t = F.target;
    if (t && !t.unknown) {
      const [x, y] = W.skyToPix(t.ra, t.dec);
      if (Number.isFinite(x)) {
        const [sx, sy] = v.toScreen(x, y); c.strokeStyle = PHOT_DARK.star; c.lineWidth = 2;
        for (const [a, b] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { c.beginPath(); c.moveTo(sx + a * 9, sy + b * 9); c.lineTo(sx + a * 17, sy + b * 17); c.stroke(); }
        c.fillStyle = PHOT_DARK.star; c.fillText(t.name, sx + 12, sy - 12);
      }
    }
    c.restore();
  }

  // ---------------------------------------------------------------- the card
  function render() {
    const card = el(); if (!card) return;
    card.hidden = P.mode !== 'stack'; card.innerHTML = ''; if (card.hidden) return;
    const Hd = H0(), hs = pixelScale(Hd), obj = Hd.OBJECT ? String(Hd.OBJECT).trim() : '';
    const tVal = F.target ? F.target.name : obj;
    card.append(h('h2', {}, 'Field: target, comparisons, apertures'));
    // 1. sky coordinates
    card.append(h('div', { class: 'fsec' },
      h('div', { class: 'frow' },
        h('input', { type: 'text', id: 'fTarget', class: 'grow', value: tVal, placeholder: 'target: name or RA Dec', 'aria-label': 'Target name or coordinates', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', onkeydown: (e) => { if (e.key === 'Enter') solveClick(); } }),
        h('button', { class: 'btn primary', id: 'bSolve', disabled: F.busy, onclick: solveClick, title: 'Match the stars of the first frame to Gaia DR3 and fit the sky coordinates (a TAN WCS). No account or key needed.' }, F.busy ? 'Solving…' : F.wcs && F.sol ? 'Solve again' : 'Solve WCS')),
      h('div', { class: 'status fstat ' + F.msgCls }, F.msg || (F.wcs ? '' : `No sky coordinates yet. Solving matches the stars of the first frame to Gaia DR3 near ${obj ? '“' + obj + '” or ' : ''}the header pointing${hs.scale > 0 ? `, at ${fx(hs.scale, 2)}″/px (${hs.source})` : ''}.`)),
      F.wcs ? kv([['Source', F.source], ['Scale', `${fx(F.wcs.scale, 3)}″/px`], ['Orientation', `north ${fx(F.wcs.rotation, 1)}° from +y${F.wcs.flipped ? ', mirrored (east to the right with north up)' : ''}`], F.sol ? ['Fit', `${F.sol.nMatch} stars, rms ${fx(F.sol.rms)}″ (${fx(F.sol.rmsPx)} px)${F.sol.sip ? ', SIP order ' + F.sol.sip : ''}`] : null, (() => { const c = P.cur; if (!c) return null; const [ra, dec] = F.wcs.pixToSky((c.width - 1) / 2, (c.height - 1) / 2); return ['Centre', sexagesimal(ra, dec)]; })()]) : null,
      h('details', { class: 'fopt' }, h('summary', {}, 'Options, and astrometry.net'),
        h('label', { class: 'fl' }, 'Image scale [″/px]', h('input', { type: 'text', id: 'fScale', inputmode: 'decimal', autocomplete: 'off', value: '', placeholder: hs.scale > 0 ? `${fx(hs.scale, 3)} from ${hs.source}` : 'unknown: 0.25 to 18 tried' })),
        h('label', { class: 'fl chk' }, h('input', { type: 'checkbox', checked: F.showGaia, onchange: (e) => { F.showGaia = e.target.checked; viewer.draw(); } }), 'Show Gaia stars on the image'),
        h('p', { class: 'hint' }, 'nova.astrometry.net solves almost any frame without a pointing, but its API needs a key and cannot be called from another web site (it sends no CORS headers). Upload the first frame there yourself, then load the wcs.fits (or new-image.fits) it gives back:'),
        h('div', { class: 'frow' },
          h('a', { class: 'btn', href: NOVA, target: '_blank', rel: 'noopener' }, 'Open nova.astrometry.net'),
          h('button', { class: 'btn', onclick: () => $('fNova').click() }, 'Load wcs.fits'),
          h('input', { type: 'file', id: 'fNova', hidden: true, accept: '.fits,.fit,.fts,.FITS,.wcs', onchange: (e) => { if (e.target.files[0]) loadAstrometryNet(e.target.files[0]); } })))));
    // 2. target
    const t = F.target;
    const tsec = h('div', { class: 'fsec' }, h('h3', {}, 'Target'));
    if (!F.wcs) { /* nothing to show without sky coordinates: the target is clicked with the Stars tool */ }
    else if (!t || t.unknown) tsec.append(h('p', { class: 'hint' }, t && t.unknown ? (t.unreachable ? `“${t.name}” is not in the site's catalogue, and SIMBAD (CDS Sesame) is not reachable right now: type its coordinates above.` : `“${t.name}” is not in the site's catalogue and Sesame did not know it: type its coordinates above.`) : 'Type the target\'s name or coordinates above and press Solve, or click it on the image.'));
    else {
      const isT = P.stars[0] && t.px && Math.hypot(P.stars[0].x - (t.star || t.px)[0], P.stars[0].y - (t.star || t.px)[1]) < 3;
      tsec.append(kv([['Name', `${t.name} (from ${t.from})`], ['RA, Dec', sexagesimal(t.ra, t.dec)], ['On the frame', t.px ? (t.inside ? `pixel ${fx(t.px[0], 1)}, ${fx(t.px[1], 1)}${t.star ? '' : ' (no star found there)'}` : `outside the frame (pixel ${fx(t.px[0], 0)}, ${fx(t.px[1], 0)})`) : '–'], t.gaia ? ['Gaia DR3', `G ${fx(t.gaia.g)}, BP−RP ${fx(t.gaia.bprp)}${t.gaia.variable ? ', flagged VARIABLE' : ''}`] : null]),
        t.inside ? h('div', { class: 'frow' }, isT ? h('span', { class: 'okline' }, 'This is the target (T).') : h('button', { class: 'btn primary', onclick: async () => { const [x, y] = t.star || t.px; await ctx.addStarAt(x, y, true); render(); } }, 'Use as target')) : null);
    }
    if (F.wcs) card.append(tsec);
    // 3. comparisons
    const csec = h('div', { class: 'fsec' }, h('h3', {}, 'Comparison stars'));
    if (!F.wcs) { /* Gaia ranking needs sky coordinates; "Suggest comparisons" in the Stars card works from the image */ }
    else {
      csec.append(h('div', { class: 'frow' }, h('button', { class: 'btn', id: 'bRankGaia', onclick: () => rank().catch((e) => say(String(e.message || e), 'err')) }, F.ranked ? 'Rank again' : 'Rank with Gaia'),
        F.ranked && F.ranked.some((q) => q.usable) ? h('span', { class: 'frow' }, h('button', { class: 'btn', id: 'bAddTop', onclick: () => addRanked(F.ranked.filter((q) => q.usable).slice(0, F.nTop)) }, 'Add the best'), h('select', { 'aria-label': 'How many comparison stars to add', onchange: (e) => { F.nTop = +e.target.value; } }, [1, 2, 3, 4, 5, 6, 8].map((n) => h('option', { value: n, selected: n === F.nTop }, String(n))))) : null));
      if (F.ranked) {
        const T = F.rankTarget;
        if (T && T.contamination && T.contamination.fraction > 0.01) csec.append(h('p', { class: 'warnline' }, `The target has Gaia neighbours putting ${(100 * T.contamination.fraction).toFixed(1)}% of its light in a 2 FWHM aperture (brightest G ${fx(T.contamination.list[0].g, 1)} at ${fx(T.contamination.list[0].sep, 1)}″): transit depths are diluted by that much.`));
        csec.append(h('ol', { class: 'granked' }, F.ranked.slice(0, 12).map((q) => h('li', { class: q.usable ? '' : 'bad' },
          h('span', { class: 'gmain' }, `(${fx(q.x, 0)}, ${fx(q.y, 0)}) ${q.gaia ? `G ${fx(q.gaia.g)} · BP−RP ${fx(q.gaia.bprp)}` : 'no Gaia star'}${Number.isFinite(q.dG) ? ` · ΔG ${q.dG >= 0 ? '+' : '−'}${fx(Math.abs(q.dG))}` : ''}`,
            h('small', {}, q.notes.length ? q.notes.join('; ') : 'no concerns')),
          h('button', { title: 'Add as a comparison star', 'aria-label': `Add the star at ${fx(q.x, 0)}, ${fx(q.y, 0)} as a comparison`, onclick: () => addRanked([q]) }, '+')))),
        h('p', { class: 'hint' }, 'Best first. Grey: not recommended (variable, crowded, saturated, near the edge, no Gaia counterpart, or far in brightness). The numbers on the image are these ranks; diamonds are Gaia stars (red: flagged variable).'));
      }
    }
    if (F.wcs) card.append(csec);
    // 4. apertures
    const asec = h('div', { class: 'fsec' }, h('h3', {}, 'Aperture size'));
    asec.append(h('div', { class: 'frow' }, h('button', { class: 'btn', id: 'bOptAp', onclick: () => apertures(true).catch((e) => say(String(e.message || e), 'err')) }, 'Set apertures from the stars')));
    const A = F.apertures;
    if (A) {
      const T0 = A.rows[0], cs = A.rows.slice(1).filter((r) => Number.isFinite(r.radius));
      asec.append(h('p', { class: 'hint' }, `Signal to noise peaks at an aperture radius of ${fx(T0.radius, 1)} px for the target (${fx(T0.sigmas, 2)} σ, ${fx(T0.fwhm, 2)} FWHM, holding ${(100 * T0.fraction).toFixed(0)}% of its light; SNR ${fx(T0.snr, 0)})${cs.length ? `, ${fx(Math.min(...cs.map((r) => r.radius)), 1)}–${fx(Math.max(...cs.map((r) => r.radius)), 1)} px for the comparisons` : ''}. ${A.applied ? `The reduction now tries radii from ${A.lo} to ${A.hi} σ (half to twice the target's best, at least 2 σ beyond it: seeing and guiding change during the night), and the light curve with the least scatter decides among them.` : ''} A faint star on a bright sky does best near 0.67 FWHM; brighter stars want more. Gain ${A.gainNote}.`),
        kv(A.rows.map((r) => [r.name, `${fx(r.radius, 2)} px · ${fx(r.sigmas, 2)} σ · SNR ${fx(r.snr, 0)}`])));
    } else asec.append(h('p', { class: 'hint' }, 'From each star\'s curve of growth and the sky noise: the radius with the best signal to noise, used to centre the range of apertures the reduction tries.'));
    card.append(asec);
  }
  const kv = (rows) => h('table', { class: 'kv' }, h('tbody', {}, rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
  function solveClick() { solve().catch(() => {}); }

  // ---------------------------------------------------------------- assistant tools
  function tools({ obj, N, T, r4 }) {
    const where = () => (F.wcs ? { source: F.source, arcsec_per_px: r4(F.wcs.scale), north_from_y_deg: r4(F.wcs.rotation), mirrored: F.wcs.flipped, matched_stars: F.sol ? F.sol.nMatch : undefined, rms_arcsec: F.sol ? r4(F.sol.rms) : undefined, sip_order: F.sol ? F.sol.sip : undefined } : null);
    const tgt = () => (F.target && !F.target.unknown ? { name: F.target.name, ra: r4(F.target.ra), dec: r4(F.target.dec), from: F.target.from, pixel: F.target.px ? F.target.px.map(r4) : null, on_frame: !!F.target.inside, gaia_g: F.target.gaia ? r4(F.target.gaia.g) : undefined, gaia_bp_rp: F.target.gaia ? r4(F.target.gaia.bprp) : undefined } : null);
    return [
      { name: 'photometry_solve_wcs', description: 'Give the first frame of an image stack sky coordinates (a TAN WCS) by matching its stars to Gaia DR3 (fetched from VizieR; no account or key). Uses the target name or coordinates for the pointing (else the header RA / DEC) and the header image scale (else tries 0.25 to 18″/px). Afterwards the readout shows RA / Dec and Gaia stars are drawn on the image.',
        parameters: obj({ target: T('Target name (catalogue or SIMBAD) or coordinates "hh mm ss ±dd mm ss" / "deg deg". Default: the OBJECT keyword.'), scale: N('Image scale in arcsec per pixel, when the header lacks it.'), ra: N('Pointing RA [deg] instead of a name.'), dec: N('Pointing Dec [deg].') }),
        async run(a) { const r = await solve({ target: a.target, scale: a.scale, ra: a.ra, dec: a.dec }); return { solved: true, wcs: where(), message: r.message, frame_centre_offset_arcmin: r4(r.offset), target: tgt(), next: 'photometry_choose_target puts the target where its coordinates say; photometry_rank_comparisons ranks comparison stars with Gaia.' }; } },
      { name: 'photometry_choose_target', description: 'Find the target on the first frame by its name or coordinates (needs sky coordinates: solves the WCS first when there are none) and make it the target star T.',
        parameters: obj({ name: T('Target name or coordinates.'), ra: N('RA [deg] (instead of a name).'), dec: N('Dec [deg].') }),
        async run(a) { const t = await chooseTarget(a.name ?? null, a.ra, a.dec); return { target: tgt(), star: P.stars[0] ? [r4(P.stars[0].x), r4(P.stars[0].y)] : null, used_star_centroid: !!t.star, next: 'photometry_rank_comparisons, then photometry_optimal_apertures.' }; } },
      { name: 'photometry_rank_comparisons', description: 'Rank comparison stars for the target with Gaia DR3: brightness and G magnitude close to the target, BP−RP colour close to the target\'s, known variables (Gaia phot_variable_flag, AAVSO VSX) excluded, Gaia neighbours too faint to detect counted when they put light in the aperture, plus saturation, isolation, edge distance and profile shape. Optionally adds the best N.',
        parameters: obj({ add: { type: 'integer', minimum: 0, maximum: 10, description: 'Add this many of the best usable stars as comparisons (default 0: only rank).' } }),
        async run(a) { const list = await rank(); const top = list.slice(0, 10).map((q) => ({ at: [r4(q.x), r4(q.y)], gaia_g: q.gaia ? r4(q.gaia.g) : null, bp_rp: q.gaia ? r4(q.gaia.bprp) : null, delta_g: r4(q.dG), usable: q.usable, notes: q.notes })); if (a.add) addRanked(list.filter((q) => q.usable).slice(0, a.add)); return { target: F.rankTarget && F.rankTarget.gaia ? { gaia_g: r4(F.rankTarget.gaia.g), bp_rp: r4(F.rankTarget.gaia.bprp), contamination: F.rankTarget.contamination ? r4(F.rankTarget.contamination.fraction) : null } : null, ranked: top, comparisons_now: P.stars.slice(1).map((s) => [r4(s.x), r4(s.y)]), vsx_checked: !!F.vsx }; } },
      { name: 'photometry_optimal_apertures', description: 'For the target and each comparison star, the aperture radius with the best signal to noise from its curve of growth and the sky noise; the aperture range the reduction searches is then centred on the target\'s (half to twice it, in units of the PSF σ).',
        parameters: obj({ apply: { type: 'boolean', description: 'Set the aperture range in the settings (default true).' } }),
        async run(a) { const A = await apertures(a.apply !== false); return { psf_sigma_px: r4(A.sigma), gain: Number.isFinite(A.gain) ? r4(A.gain) : 'unknown (sky-limited)', gain_note: A.gainNote, stars: A.rows.map((r) => ({ star: r.name, radius_px: r4(r.radius), radius_sigma: r4(r.sigmas), radius_fwhm: r4(r.fwhm), snr: r4(r.snr) })), aperture_range_sigma: A.applied ? [A.lo, A.hi] : null }; } },
    ];
  }

  return { F, solve, reset, render, draw, radec, wcsFor, chooseTarget, rank, apertures, loadAstrometryNet, tools, placeTarget };
}
