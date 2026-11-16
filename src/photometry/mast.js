// TESS and Kepler target pixel files straight from the browser.
//
// mast.stsci.edu (the portal API, the Download/file endpoint, TESScut) sends no Access-Control-Allow-Origin
// header for other sites, so a page cannot call it (checked with curl on 2026-11-15). The same files are in
// the public AWS bucket `stpubdata`, which answers both object listings and GETs with
// Access-Control-Allow-Origin: * and supports Range. So: list the folder of a target, then fetch the file.
//   TESS    tess/public/tid/s{sector:04}/{tic:016 split 4/4/4/4}/tess{date}-s{sector}-{tic}-{scid}-s_tp.fits  (2 min; a_fast = 20 s)
//   Kepler  kepler/public/target_pixel_files/{kic:09 first 4}/{kic:09}/kplr{kic}-{date}_lpd-targ.fits.gz       (lpd long, spd short cadence)
//   K2      k2/public/target_pixel_files/c{campaign}/{epic first 4}00000/{epic digits 5-6}000/ktwo{epic}-c{campaign:02}_lpd-targ.fits.gz
//           (campaign folders c0 ... c19, with c91/c92, c101/c102, c111/c112 for the split campaigns; checked 2026-11-15:
//           ktwo201912552-c01_lpd-targ.fits.gz answers 200 with Access-Control-Allow-Origin: *)
// FFI cutouts (TESScut) are not available this way.

export const BUCKET = 'https://stpubdata.s3.us-east-1.amazonaws.com/';

/** List objects under a prefix. Returns [{ key, size }] (and, with delimiter, { prefixes }). */
export async function s3List(prefix, delimiter = '') {
  const out = [], prefixes = []; let token = '';
  for (let page = 0; page < 20; page++) {
    const url = `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${delimiter ? '&delimiter=' + encodeURIComponent(delimiter) : ''}${token ? '&continuation-token=' + encodeURIComponent(token) : ''}`;
    const r = await fetch(url); if (!r.ok) throw new Error('The archive bucket answered ' + r.status);
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
export function tessPrefix(tic, sector) { const t = pad(tic, 16); return `tess/public/tid/s${pad(sector, 4)}/${t.slice(0, 4)}/${t.slice(4, 8)}/${t.slice(8, 12)}/${t.slice(12, 16)}/`; }

/** Sectors that exist in the bucket (one request). */
export async function tessSectorList() {
  const l = await s3List('tess/public/tid/', '/');
  return l.prefixes.map((p) => +p.match(/s(\d{4})\/$/)?.[1]).filter(Number.isFinite).sort((a, b) => a - b);
}

/** Target pixel files of a TIC id in every sector: one small listing per sector, 16 at a time. */
export async function tessFiles(tic, onProgress = () => {}) {
  const sectors = await tessSectorList(), found = []; let done = 0;
  const one = async (s) => {
    try { for (const o of await s3List(tessPrefix(tic, s))) if (/_tp\.fits$/.test(o.key)) found.push({ mission: 'TESS', sector: s, key: o.key, size: o.size, cadence: /a_fast/.test(o.key) ? '20 s' : '2 min', label: `Sector ${s}` }); } catch { /* a failed listing is a missing sector */ }
    onProgress(++done, sectors.length);
  };
  for (let i = 0; i < sectors.length; i += 16) await Promise.all(sectors.slice(i, i + 16).map(one));
  return found.sort((a, b) => a.sector - b.sector || a.size - b.size);
}

/** Target pixel files of a KIC id (all quarters, one listing). */
export async function keplerFiles(kic) {
  const k = pad(kic, 9), l = await s3List(`kepler/public/target_pixel_files/${k.slice(0, 4)}/${k}/`);
  return l.filter((o) => /-targ\.fits\.gz$/.test(o.key)).map((o) => { const long = /_lpd-/.test(o.key), d = o.key.match(/-(\d{13})_/)?.[1] || ''; return { mission: 'Kepler', key: o.key, size: o.size, cadence: long ? '30 min' : '1 min', label: `${d.slice(0, 4)} day ${d.slice(4, 7)}` }; });
}

/** Folder of an EPIC id inside a campaign folder ('c1/', 'c102/', ...). */
export function k2Prefix(epic, campaignFolder) { const e = String(epic); return `k2/public/target_pixel_files/${campaignFolder}${e.slice(0, 4)}00000/${e.slice(4, 6)}000/ktwo${e}-`; }

/** Target pixel files of an EPIC id in every K2 campaign: one listing of the campaign folders, then one small listing per campaign. */
export async function k2Files(epic, onProgress = () => {}) {
  const camps = (await s3List('k2/public/target_pixel_files/', '/')).prefixes.map((p) => p.match(/(c\d+\/)$/)?.[1]).filter(Boolean), found = []; let done = 0;
  const one = async (c) => {
    try { for (const o of await s3List(k2Prefix(epic, c))) if (/-targ\.fits\.gz$/.test(o.key)) { const n = c.replace(/\D/g, ''); found.push({ mission: 'K2', campaign: +n, key: o.key, size: o.size, cadence: /_lpd-/.test(o.key) ? '30 min' : '1 min', label: `Campaign ${n.length === 3 ? n.slice(0, 2) + ' part ' + n[2] : n.length === 2 && +n > 19 ? n[0] + ' part ' + n[1] : n}` }); } } catch { /* a failed listing is a campaign without this star */ }
    onProgress(++done, camps.length);
  };
  for (let i = 0; i < camps.length; i += 12) await Promise.all(camps.slice(i, i + 12).map(one));
  return found.sort((a, b) => a.campaign - b.campaign || a.size - b.size);
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
 * Turn what the user typed into an archive id: "TIC 100100827", "KIC 11446443", "EPIC 201912552", a bare number (taken as TIC), or
 * a host / planet name looked up in the site's own catalogue snapshot (public/catalog/index.json, whose host
 * entries carry their TIC, KIC and EPIC aliases). Returns { tic, kic, epic, name } with what was found.
 */
export async function resolveTarget(text, siteRoot) {
  const s = text.trim(); let m;
  if ((m = s.match(/^tic[\s\-_]*(\d+)$/i))) return { tic: +m[1], name: 'TIC ' + m[1] };
  if ((m = s.match(/^(kic|kplr)[\s\-_]*(\d+)$/i))) return { kic: +m[2], name: 'KIC ' + m[2] };
  if ((m = s.match(/^(epic|ktwo)[\s\-_]*(\d{9})$/i))) return { epic: +m[2], name: 'EPIC ' + m[2] };
  if (/^\d+$/.test(s)) return { tic: +s, name: 'TIC ' + s };
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
