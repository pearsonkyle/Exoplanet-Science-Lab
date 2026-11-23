// A star's magnitudes and parallax from public catalogues, for the SED fit (src/core/sed.js): the queries to send
// to VizieR (Ochsenbein, Bauer & Marcout 2000) and what to make of the answers. No network here: the page fetches the
// URLs (through fetchOr) and hands the text back; test/sed.test.mjs runs this on stored answers.
//
// Two steps, because stars move. Gaia DR3 is asked at the position the site's own catalogue has for a planet host
// (near Gaia's epoch), or else by name (the server resolves it), and the brightest source within 30 arcsec is taken
// (or the one of the catalogue's G magnitude); its position and proper motion then give where the star was at the epochs of 2MASS (about
// 1999), Tycho-2 (1991.5, catalogued at J2000 with its motion) and AllWISE (2010.5), and those are asked by position.
// What is switched off, with the reason kept: 2MASS bands whose quality flag is not A; WISE W1 brighter than 8.1 and
// W2 brighter than 6.7 (saturated: their catalogue magnitudes run bright), any WISE band whose quality is U (an upper
// limit) or whose contamination flag is set; Gaia with RUWE above 1.4 is kept but remarked on (an unresolved companion).

export const VIZIER = ['https://vizier.cfa.harvard.edu/viz-bin/asu-tsv', 'https://vizier.cds.unistra.fr/viz-bin/asu-tsv'];   // the CfA mirror first (it answers requests from a web page; checked 2026-11-20), then the CDS service
const TABLES = {
  gaia: ['I/355/gaiadr3', 'Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,e_Plx,Gmag,e_Gmag,BPmag,e_BPmag,RPmag,e_RPmag,RUWE,Teff,logg,[Fe/H]'],
  tmass: ['II/246/out', '2MASS,Jmag,e_Jmag,Hmag,e_Hmag,Kmag,e_Kmag,Qflg'],
  wise: ['II/328/allwise', 'AllWISE,W1mag,e_W1mag,W2mag,e_W2mag,W3mag,e_W3mag,W4mag,e_W4mag,qph,ccf'],
  tycho: ['I/259/tyc2', 'TYC1,TYC2,TYC3,BTmag,e_BTmag,VTmag,e_VTmag'],
};
const EPOCH = { tmass: 1999.5, wise: 2010.5, tycho: 2000.0 }, GAIA_EPOCH = 2016.0;

/** The query for one catalogue: by name (Gaia) or at a position { ra, dec } in degrees. base: one of VIZIER. */
export function catalogueUrl(base, which, target, radiusArcsec = which === 'gaia' ? 30 : 8) {
  if (!target) throw new Error('no star found to ask the catalogues about');
  const [source, cols] = TABLES[which], c = typeof target === 'string' ? target.trim() : `${target.ra.toFixed(6)} ${target.dec >= 0 ? '+' : ''}${target.dec.toFixed(6)}`;
  return `${base}?-source=${encodeURIComponent(source)}&-c=${encodeURIComponent(c)}&-c.rs=${radiusArcsec}&-out.max=30&-sort=_r&-out=_r,${cols.split(',').map(encodeURIComponent).join(',')}`;
}

/** Rows of a VizieR tab-separated answer as objects (numbers where they parse; '' where empty). */
export function parseTsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l && !l.startsWith('#')), i = lines.findIndex((l) => /^-[-\t ]*$/.test(l));
  if (i < 2) return [];
  const head = lines[i - 2].split('\t').map((s) => s.trim());
  return lines.slice(i + 1).filter((l) => l.trim()).map((l) => { const c = l.split('\t'), o = {}; head.forEach((h, k) => { const v = (c[k] ?? '').trim(); o[h] = v !== '' && Number.isFinite(Number(v)) && !/^(Source|2MASS|AllWISE|Qflg|qph|ccf)$/.test(h) ? Number(v) : v; }); return o; });
}

/** The star among Gaia's sources near the position asked: the one closest to a known G magnitude (`gmag`, from a catalogue) when given, else the brightest in G. null if none. */
export function pickGaia(rows, gmag = null) { const ok = rows.filter((r) => Number.isFinite(r.Gmag)); if (!ok.length) return null; return Number.isFinite(gmag) ? ok.reduce((a, b) => (Math.abs(b.Gmag - gmag) < Math.abs(a.Gmag - gmag) ? b : a)) : ok.reduce((a, b) => (b.Gmag < a.Gmag ? b : a)); }

/** Where Gaia's star was at the epoch of another catalogue: { ra, dec } in degrees. */
export function positionAt(gaia, which) {
  const dt = EPOCH[which] - GAIA_EPOCH, pmRa = Number.isFinite(gaia.pmRA) ? gaia.pmRA : 0, pmDe = Number.isFinite(gaia.pmDE) ? gaia.pmDE : 0;
  return { ra: gaia.RA_ICRS + (pmRa * dt) / 3.6e6 / Math.cos((gaia.DE_ICRS * Math.PI) / 180), dec: gaia.DE_ICRS + (pmDe * dt) / 3.6e6 };
}

/**
 * Magnitudes for the fit from the catalogues' rows (each: parseTsv's rows, nearest first; gaia: the row picked).
 * Returns { obs: [{ band, mag, err, use, why? }], plx: [mas, err] | null, gaia: { teff, logg, feh } (Gaia's own
 *           estimates where given, for comparison only), notes: [string], ids: { gaia, tmass, wise, tycho } }.
 */
export function photometryFrom({ gaia = null, tmass = [], wise = [], tycho = [] }) {
  const obs = [], notes = [], ids = {}, num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const add = (band, mag, err, why = null, floor = 0.01) => { if (Number.isFinite(num(mag))) obs.push({ band, mag: num(mag), err: Number.isFinite(num(err)) && num(err) > 0 ? num(err) : floor, use: !why, ...(why ? { why } : {}) }); };
  if (gaia) {
    ids.gaia = String(gaia.Source || ''); add('Gaia BP', gaia.BPmag, gaia.e_BPmag); add('Gaia G', gaia.Gmag, gaia.e_Gmag); add('Gaia RP', gaia.RPmag, gaia.e_RPmag);
    if (num(gaia.RUWE) > 1.4) notes.push(`Gaia's RUWE is ${gaia.RUWE}: the astrometry fits a single star poorly (often an unresolved companion); the parallax and the magnitudes may be affected.`);
    if (num(gaia.Gmag) < 6) notes.push('Brighter than G = 6: Gaia\'s magnitudes need a saturation correction that is not applied here.');
  } else notes.push('No Gaia DR3 source was found for this name.');
  const t = tycho[0]; if (t) { ids.tycho = `TYC ${t.TYC1}-${t.TYC2}-${t.TYC3}`; add('Tycho BT', t.BTmag, t.e_BTmag, num(t.e_BTmag) > 0.15 ? 'too faint for Tycho (error above 0.15 mag)' : null); add('Tycho VT', t.VTmag, t.e_VTmag, num(t.e_VTmag) > 0.15 ? 'too faint for Tycho (error above 0.15 mag)' : null); }
  const m = tmass[0]; if (m) { ids.tmass = String(m['2MASS'] || ''); const q = String(m.Qflg || '   '); ['J', 'H', 'K'].forEach((b, k) => add(`2MASS ${b === 'K' ? 'Ks' : b}`, m[b + 'mag'], m['e_' + b + 'mag'], q[k] === 'A' ? null : `2MASS quality ${q[k] || '?'}${/[CDE]/.test(q[k]) ? ' (saturated or poor)' : ''}`)); }
  const w = wise[0]; if (w) {
    ids.wise = String(w.AllWISE || ''); const q = String(w.qph || '    '), cc = String(w.ccf || '0000'), sat = [8.1, 6.7, 3.8, -0.4];
    [1, 2, 3, 4].forEach((b, k) => { const mag = num(w[`W${b}mag`]); add(`WISE W${b}`, mag, w[`e_W${b}mag`], q[k] === 'U' || q[k] === 'X' ? 'an upper limit' : mag < sat[k] ? `saturated (brighter than ${sat[k]})` : cc[k] && cc[k] !== '0' ? `contamination flag ${cc[k]}` : null); });
  }
  const plx = gaia && num(gaia.Plx) > 0 && num(gaia.e_Plx) > 0 ? [gaia.Plx, gaia.e_Plx] : null;
  if (plx) { const d = 1000 / plx[0]; notes.push(`Distance ${d.toFixed(d < 100 ? 1 : 0)} pc: ${d < 70 ? 'inside the local cavity, where there is almost no dust; the extinction is set to zero' : `some dust is likely; extinction up to ${suggestAv(d).toFixed(2)} mag is allowed (about 1 mag per kpc beyond 70 pc; a dust map would do better)`}.`); }
  return { obs, plx, gaia: gaia ? { teff: num(gaia.Teff), logg: num(gaia.logg), feh: num(gaia['[Fe/H]']) } : null, notes, ids };
}

/** A largest extinction worth considering at a distance [pc]: none within 70 pc, then 1 mag per kpc, at most 3. */
export const suggestAv = (dPc) => (dPc <= 70 ? 0 : Math.min(3, Math.round(((dPc - 70) / 1000) * 20) / 20 + 0.05));
