// TESS, Kepler and K2 products straight from the browser.
//
// mast.stsci.edu (the portal API, the Download/file endpoint, TESScut) sends no Access-Control-Allow-Origin
// header for other sites, so a page cannot call it (checked with curl on 2026-11-15). The same files are in
// the public AWS bucket `stpubdata`, which answers both object listings and GETs with
// Access-Control-Allow-Origin: * and supports Range (checked again 2026-11-16, also for the HLSP folders). So: list
// the folders of a target, then fetch the files.
//   TESS SPOC    tess/public/tid/s{sector:04}/{tic:016 split 4/4/4/4}/tess{date}-s{sector}-{tic}-{scid}-s_tp.fits / -s_lc.fits
//                (2 min) and ...-a_fast-tp.fits / -a_fast-lc.fits (20 s)
//   TESS-SPOC    mast/hlsp/tess-spoc/s{sector:04}/target/{tic split}/hlsp_tess-spoc_tess_phot_{tic:016}-s{sector:04}_tess_v1_tp.fits
//                / _lc.fits: TPFs and light curves cut from the full-frame images (30 min to sector 26, 10 min to 55, 200 s after)
//   QLP          mast/hlsp/qlp/s{sector:04}/{tic split}/hlsp_qlp_tess_ffi_s{sector:04}-{tic:016}_tess_v01_llc.fits (FFI light curves)
//   Kepler       kepler/public/target_pixel_files/{kic:09 first 4}/{kic:09}/kplr{kic}-{date}_lpd-targ.fits.gz (lpd long, spd short)
//                kepler/public/lightcurves/{same}/kplr{kic}-{date}_llc.fits / _slc.fits
//   K2           k2/public/target_pixel_files/c{campaign}/{epic first 4}00000/{epic digits 5-6}000/ktwo{epic}-c{campaign:02}_lpd-targ.fits.gz
//                k2/public/lightcurves/c{campaign}/.../ktwo{epic}-c{campaign:02}_llc.fits
//                (campaign folders c0 ... c19, with c91/c92, c101/c102, c111/c112 for the split campaigns)
// Not reachable this way: TESScut cutouts of the full-frame images, TGLC (filed by camera and CCD), K2SFF and EVEREST
// light curves (not in the bucket).

export const BUCKET = 'https://stpubdata.s3.us-east-1.amazonaws.com/';

/** List objects under a prefix. Returns [{ key, size }] (and, with delimiter, { prefixes }). */
export async function s3List(prefix, delimiter = '', fetchFn = fetch) {
  const out = [], prefixes = []; let token = '';
  for (let page = 0; page < 20; page++) {
    const url = `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${delimiter ? '&delimiter=' + encodeURIComponent(delimiter) : ''}${token ? '&continuation-token=' + encodeURIComponent(token) : ''}`;
    const r = await fetchFn(url); if (!r.ok) throw new Error('The archive bucket answered ' + r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>.*?<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs)) out.push({ key: m[1], size: +m[2] });
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>(.*?)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(m[1]);
    const t = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
    if (!t) break; token = t[1];
  }
  out.prefixes = prefixes;
  return out;
}

const pad = (v, n) => String(v).padStart(n, '0');
const ticPath = (tic) => { const t = pad(tic, 16); return `${t.slice(0, 4)}/${t.slice(4, 8)}/${t.slice(8, 12)}/${t.slice(12, 16)}/`; };
export function tessPrefix(tic, sector) { return `tess/public/tid/s${pad(sector, 4)}/${ticPath(tic)}`; }
export function tessSpocPrefix(tic, sector) { return `mast/hlsp/tess-spoc/s${pad(sector, 4)}/target/${ticPath(tic)}`; }
export function qlpPrefix(tic, sector) { return `mast/hlsp/qlp/s${pad(sector, 4)}/${ticPath(tic)}`; }
/** Exposure of the full-frame images in a sector [s]: 1800 to sector 26, 600 to 55, 200 after. */
export const ffiExposure = (sector) => (sector <= 26 ? 1800 : sector <= 55 ? 600 : 200);
const cadLabel = (s) => (s < 60 ? `${s} s` : s % 60 ? `${(s / 60).toFixed(1)} min` : `${s / 60} min`);

/**
 * What a bucket key is: { mission, kind: 'tpf' | 'lc', author: 'SPOC' | 'TESS-SPOC' | 'QLP' | 'Kepler' | 'K2', exptime [s],
 * cadence (label), sector | quarterDate | campaign, ffi: bool } or null for other files (validation reports, PDFs).
 */
export function classifyKey(key) {
  const name = key.split('/').pop(); let m;
  if ((m = name.match(/^tess\d+-s(\d{4})-\d{16}-\d{4}-(s|a_fast)[_-](tp|lc)\.fits$/))) { const fast = m[2] === 'a_fast'; return { mission: 'TESS', author: 'SPOC', kind: m[3] === 'tp' ? 'tpf' : 'lc', sector: +m[1], exptime: fast ? 20 : 120, cadence: fast ? '20 s' : '2 min', ffi: false }; }
  if ((m = name.match(/^hlsp_tess-spoc_tess_phot_\d{16}-s(\d{4})_tess_v\d+_(tp|lc)\.fits$/))) { const s = +m[1], e = ffiExposure(s); return { mission: 'TESS', author: 'TESS-SPOC', kind: m[2] === 'tp' ? 'tpf' : 'lc', sector: s, exptime: e, cadence: `FFI ${cadLabel(e)}`, ffi: true }; }
  if ((m = name.match(/^hlsp_qlp_tess_ffi_s(\d{4})-\d{16}_tess_v\d+_llc\.fits$/))) { const s = +m[1], e = ffiExposure(s); return { mission: 'TESS', author: 'QLP', kind: 'lc', sector: s, exptime: e, cadence: `FFI ${cadLabel(e)}`, ffi: true }; }
  if ((m = name.match(/^kplr\d{9}-(\d{13})_(lpd|spd)-targ\.fits\.gz$/))) return { mission: 'Kepler', author: 'Kepler', kind: 'tpf', quarterDate: m[1], exptime: m[2] === 'lpd' ? 1765.5 : 58.85, cadence: m[2] === 'lpd' ? '30 min' : '1 min', ffi: false };
  if ((m = name.match(/^kplr\d{9}-(\d{13})_(llc|slc)\.fits$/))) return { mission: 'Kepler', author: 'Kepler', kind: 'lc', quarterDate: m[1], exptime: m[2] === 'llc' ? 1765.5 : 58.85, cadence: m[2] === 'llc' ? '30 min' : '1 min', ffi: false };
  if ((m = name.match(/^ktwo\d{9}-c(\d{2,3})_(lpd|spd)-targ\.fits\.gz$/))) return { mission: 'K2', author: 'K2', kind: 'tpf', campaign: +m[1], exptime: m[2] === 'lpd' ? 1765.5 : 58.85, cadence: m[2] === 'lpd' ? '30 min' : '1 min', ffi: false };
  if ((m = name.match(/^ktwo\d{9}-c(\d{2,3})_(llc|slc)\.fits$/))) return { mission: 'K2', author: 'K2', kind: 'lc', campaign: +m[1], exptime: m[2] === 'llc' ? 1765.5 : 58.85, cadence: m[2] === 'llc' ? '30 min' : '1 min', ffi: false };
  return null;
}
// Kepler quarters by the date stamp of their files (start of each quarter's data, from the archive's file names)
const KEPLER_Q = [['2009131105131', 1], ['2009166043257', 2], ['2009259160929', 3], ['2009350155506', 4], ['2010078095331', 5], ['2010174085026', 6], ['2010265121752', 7], ['2010355172524', 8], ['2011073133259', 9], ['2011177032512', 10], ['2011271113734', 11], ['2012004120508', 12], ['2012088054726', 13], ['2012179063303', 14], ['2012277125453', 15], ['2013011073258', 16], ['2013098041711', 17]];
/** Kepler quarter of a file's date stamp (the last quarter whose first file is not later; short-cadence months share their quarter's). */
export function keplerQuarter(stamp) { let q = 0; for (const [d, n] of KEPLER_Q) if (stamp >= d) q = n; return stamp < '2009131105131' ? 0 : q; }

/** One record per product: the classification, the key, size, a label and a stable id. */
function product(o) {
  const c = classifyKey(o.key); if (!c) return null;
  const seg = c.mission === 'TESS' ? `Sector ${c.sector}` : c.mission === 'Kepler' ? `Quarter ${keplerQuarter(c.quarterDate)}` : `Campaign ${String(c.campaign).length === 3 ? String(c.campaign).slice(0, 2) + ' part ' + String(c.campaign)[2] : c.campaign > 19 ? String(c.campaign)[0] + ' part ' + String(c.campaign)[1] : c.campaign}`;
  if (c.mission === 'Kepler') c.quarter = keplerQuarter(c.quarterDate);
  // group: the sector, quarter or campaign (short-cadence Kepler quarters come as three monthly files in one group)
  return { ...c, key: o.key, size: o.size, label: seg + (c.mission === 'Kepler' && c.exptime < 100 ? ` (${c.quarterDate.slice(0, 4)} day ${c.quarterDate.slice(4, 7)})` : ''), group: c.mission === 'TESS' ? c.sector : c.mission === 'Kepler' ? c.quarter : c.campaign, id: o.key.split('/').pop() };
}

/** Sectors that exist in the bucket (one request). */
export async function tessSectorList(fetchFn = fetch) {
  const l = await s3List('tess/public/tid/', '/', fetchFn);
  return l.prefixes.map((p) => +p.match(/s(\d{4})\/$/)?.[1]).filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * Every TESS product of a TIC id the bucket holds: SPOC 20 s and 2 min TPFs and light curves, TESS-SPOC FFI TPFs and
 * light curves, QLP FFI light curves. Three small listings per sector, 16 sectors at a time.
 */
export async function tessProducts(tic, onProgress = () => {}, fetchFn = fetch) {
  const sectors = await tessSectorList(fetchFn), found = []; let done = 0;
  const one = async (s) => {
    for (const pre of [tessPrefix(tic, s), tessSpocPrefix(tic, s), qlpPrefix(tic, s)]) {
      try { for (const o of await s3List(pre, '', fetchFn)) { const p = product(o); if (p) found.push(p); } } catch { /* a failed listing is a missing product */ }
    }
    onProgress(++done, sectors.length);
  };
  for (let i = 0; i < sectors.length; i += 16) await Promise.all(sectors.slice(i, i + 16).map(one));
  return sortProducts(found);
}

/** Kepler TPFs and light curves of a KIC id (two listings). */
export async function keplerProducts(kic, fetchFn = fetch) {
  const k = pad(kic, 9), out = [];
  for (const base of ['kepler/public/target_pixel_files/', 'kepler/public/lightcurves/']) for (const o of await s3List(`${base}${k.slice(0, 4)}/${k}/`, '', fetchFn)) { const p = product(o); if (p) out.push(p); }
  return sortProducts(out);
}

/** Folder of an EPIC id inside a campaign folder ('c1/', 'c102/', ...). */
export function k2Prefix(epic, campaignFolder, base = 'target_pixel_files') { const e = String(epic); return `k2/public/${base}/${campaignFolder}${e.slice(0, 4)}00000/${e.slice(4, 6)}000/ktwo${e}-`; }

/** K2 TPFs and light curves of an EPIC id in every campaign: one listing of the campaign folders, then two per campaign. */
export async function k2Products(epic, onProgress = () => {}, fetchFn = fetch) {
  const camps = (await s3List('k2/public/target_pixel_files/', '/', fetchFn)).prefixes.map((p) => p.match(/(c\d+\/)$/)?.[1]).filter(Boolean), found = []; let done = 0;
  const one = async (c) => {
    for (const base of ['target_pixel_files', 'lightcurves']) { try { for (const o of await s3List(k2Prefix(epic, c, base), '', fetchFn)) { const p = product(o); if (p) found.push(p); } } catch { /* not observed */ } }
    onProgress(++done, camps.length);
  };
  for (let i = 0; i < camps.length; i += 12) await Promise.all(camps.slice(i, i + 12).map(one));
  return sortProducts(found);
}

const AUTHOR_ORDER = { SPOC: 0, Kepler: 0, K2: 0, 'TESS-SPOC': 1, QLP: 2 };
function sortProducts(a) { return a.sort((p, q) => p.mission.localeCompare(q.mission) || p.group - q.group || (p.kind === q.kind ? 0 : p.kind === 'lc' ? -1 : 1) || AUTHOR_ORDER[p.author] - AUTHOR_ORDER[q.author] || p.exptime - q.exptime); }

/**
 * One product per sector (quarter, campaign), as the owner's TOI extraction does it (cadence_policy): taking 20 s and
 * 2 min of the same sector would count the same photons twice. kind: 'lc' | 'tpf'; cadence: 'shortest' | 'longest' |
 * a cadence label ('20 s', '2 min', '30 min', '1 min', 'FFI') to require; authors: allowed authors in order of
 * preference; groups: the sectors / quarters / campaigns to keep (all when empty). A Kepler short-cadence quarter
 * keeps its three monthly files.
 * @returns { chosen: [product], alternatives: { [group]: [labels] } }
 */
export function chooseProducts(products, { kind = 'lc', cadence = 'shortest', authors = ['SPOC', 'Kepler', 'K2', 'TESS-SPOC', 'QLP'], groups = null } = {}) {
  const by = new Map(), alternatives = {}, ok = [];
  for (const p of products) {
    if (p.kind !== kind || !authors.includes(p.author)) continue;
    if (groups && groups.length && !groups.includes(p.group)) continue;
    const lab = `${p.author} ${p.cadence}`; (alternatives[p.group] = alternatives[p.group] || []); if (!alternatives[p.group].includes(lab)) alternatives[p.group].push(lab);
    if (cadence !== 'shortest' && cadence !== 'longest' && !(cadence === 'FFI' ? p.ffi : p.cadence === cadence)) continue;
    ok.push(p);
    const cur = by.get(p.group);
    const better = !cur || (cadence === 'longest' ? p.exptime > cur.exptime : p.exptime < cur.exptime) || (p.exptime === cur.exptime && authors.indexOf(p.author) < authors.indexOf(cur.author));
    if (better) by.set(p.group, p);
  }
  const chosen = ok.filter((p) => { const b = by.get(p.group); return b && p.author === b.author && p.exptime === b.exptime; });
  return { chosen: chosen.sort((a, b) => a.group - b.group || a.key.localeCompare(b.key)), alternatives };
}

/** GET with progress. Returns an ArrayBuffer. */
export async function fetchBytes(url, onProgress = () => {}, signal = undefined) {
  const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body) return await r.arrayBuffer();
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; onProgress(n, total); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

/**
 * Turn what the user typed into an archive id: "TIC 100100827", "KIC 11446443", "EPIC 201912552", "TOI-1873", a bare
 * number (taken as TIC), or a host / planet name looked up in the site's own catalogue snapshot (public/catalog/index.json,
 * whose host entries carry their TIC, KIC and EPIC aliases). TOIs are looked up in public/catalog-table/toi.json.
 * Returns { tic, kic, epic, name } with what was found.
 */
export async function resolveTarget(text, siteRoot) {
  const s = text.trim(); let m;
  if ((m = s.match(/^tic[\s\-_]*(\d+)$/i))) return { tic: +m[1], name: 'TIC ' + m[1] };
  if ((m = s.match(/^(kic|kplr)[\s\-_]*(\d+)$/i))) return { kic: +m[2], name: 'KIC ' + m[2] };
  if ((m = s.match(/^(epic|ktwo)[\s\-_]*(\d{9})$/i))) return { epic: +m[2], name: 'EPIC ' + m[2] };
  if (/^\d+$/.test(s)) return { tic: +s, name: 'TIC ' + s };
  if ((m = s.match(/^toi[\s\-_]*(\d+)(\.\d+)?$/i))) {
    const tois = await toiRecords(siteRoot), hit = tois.find((r) => Math.floor(parseFloat(r.name.slice(4))) === +m[1]);
    if (hit) return { tic: +hit.info.tic, name: `TOI-${m[1]}`, toi: +m[1] };
  }
  const norm = (v) => v.toLowerCase().replace(/[\s\-_]+/g, '');
  const want = norm(s), wantHost = norm(s.replace(/\s+[b-i]$/i, ''));
  const idx = await (await fetch(new URL('catalog/index.json', siteRoot))).json();
  for (const h of idx.hosts || []) {
    const names = h.filter((v) => typeof v === 'string');
    if (!names.some((n) => { const q = norm(n); return q === want || q === wantHost; })) continue;
    const out = { name: names[0] };
    for (const n of names) { let k; if ((k = n.match(/^TIC (\d+)$/))) out.tic = +k[1]; else if ((k = n.match(/^KIC (\d+)$/))) out.kic = +k[1]; else if ((k = n.match(/^EPIC (\d+)$/))) out.epic = +k[1]; }
    return out;
  }
  return { name: s };
}

let toiCache = null;
/** The TOI table (src/core/sources/toi.js records), loaded once. */
export async function toiRecords(siteRoot) {
  if (!toiCache) toiCache = (async () => { const { default: toi } = await import('../core/sources/toi.js'); return toi.records(await (await fetch(new URL('catalog-table/toi.json', siteRoot))).json()).records; })();
  return toiCache;
}
