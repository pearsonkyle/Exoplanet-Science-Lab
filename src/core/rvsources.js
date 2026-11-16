// Radial velocities from public archives: which catalogues hold RV time series that a browser can fetch, how to ask
// them, and how to read what they return. Pure: no DOM, no fetch. The caller passes a `fetchText(url)` function, so the
// same code runs in a page, in Node (tests read saved responses from test/data/rv/) and in a worker.
//
// What a browser can reach (checked 2026-11-16 with curl, Origin header set; see the report in test/rvsources.test.mjs):
//   VizieR ASU (viz-bin/asu-tsv) on the CfA and IDIA mirrors answers with Access-Control-Allow-Origin: *. The CDS
//   main site returned 404 for viz-bin that day and TAPVizieR timed out; both stay in the mirror list as fallbacks.
//   NASA Exoplanet Archive TAP sends no Access-Control-Allow-Origin header and has no RV time-series table.
//   DACE's API host (dace-api.unige.ch) did not resolve; its public RVs are served to its Python client.
//   ESO's TAP (archive.eso.org/tap_obs) allows CORS but serves spectra, not velocities; HARPS velocities come
//   from the HARPS RVBank below, which is the ESO archive re-reduced.
//
// Every source is a VizieR catalogue with a star list carrying positions and a table of velocities. A search is two
// requests per source: the star list by position (cone of a few arcsec around the host), then the velocities by the
// catalogue's own star name. Each instrument era with its own zero point (CCD and fibre upgrades) becomes its own set.

export const VIZIER_MIRRORS = ['https://vizier.cfa.harvard.edu', 'https://vizier.idia.ac.za', 'https://vizier.cds.unistra.fr'];

/**
 * The catalogues searched. `split` cuts a set at the dates of instrument changes that shift the zero point
 * ({ at: [BJD...], names: [...] }); `group` splits by a column (the Lick dewar). `sameAs`: a source holding the same
 * observations (only one of them should enter a fit).
 */
export const RV_SOURCES = [
  {
    id: 'hires-talor2019', label: 'Keck/HIRES, corrected (Tal-Or et al. 2019)', instrument: 'HIRES', catalog: 'J/MNRAS/484/L8',
    list: 'J/MNRAS/484/L8/stars', data: 'J/MNRAS/484/L8/table1', name: 'Name', time: 'BJD', rv: 'RVcor', err: 'e_RVcor',
    timeStandard: 'BJD (barycentric, as published)', bibcode: '2019MNRAS.484L...8T', doi: '10.1093/mnrasl/sly227', reference: 'Tal-Or, L. et al. 2019, MNRAS, 484, L8',
    split: { at: [2453225], names: ['HIRES pre-2004', 'HIRES post-2004'], why: 'the HIRES CCD was replaced in August 2004' }, sameAs: 'hires-butler2017',
    about: 'The velocities of Butler et al. (2017) with small nightly zero-point offsets and a long-term drift removed.',
  },
  {
    id: 'hires-butler2017', label: 'Keck/HIRES (Butler et al. 2017)', instrument: 'HIRES', catalog: 'J/AJ/153/208',
    list: 'J/AJ/153/208/targets', data: 'J/AJ/153/208/table1', name: 'Name', time: 'BJD', rv: 'RV', err: 'e_RV',
    timeStandard: 'BJD (barycentric, as published)', bibcode: '2017AJ....153..208B', doi: '10.3847/1538-3881/aa66ca', reference: 'Butler, R. P. et al. 2017, AJ, 153, 208',
    split: { at: [2453225], names: ['HIRES pre-2004', 'HIRES post-2004'], why: 'the HIRES CCD was replaced in August 2004' }, sameAs: 'hires-talor2019',
    about: 'The LCES HIRES/Keck survey, 1996-2014, as published.',
  },
  {
    id: 'harps-rvbank', label: 'ESO/HARPS (RVBank, Trifonov et al. 2020)', instrument: 'HARPS', catalog: 'J/A+A/636/A74',
    list: 'J/A+A/636/A74/list', data: 'J/A+A/636/A74/rvbank', name: 'Name', time: 'BJD', rv: 'DRVmlcnzp', err: 'e_DRVmlcnzp', flag: 'Flag',
    timeStandard: 'BJD (barycentric, as published)', bibcode: '2020A&A...636A..74T', doi: '10.1051/0004-6361/201936686', reference: 'Trifonov, T. et al. 2020, A&A, 636, A74',
    split: { at: [2457170], names: ['HARPS pre-2015', 'HARPS post-2015'], why: 'the HARPS fibres were replaced in May 2015' },
    about: 'Every public HARPS spectrum to 2018 re-reduced with SERVAL, corrected for the nightly zero point (RV_mlc_nzp). Points with a SERVAL flag are left out.',
  },
  {
    id: 'lick-fischer2014', label: 'Lick/Hamilton (Fischer et al. 2014)', instrument: 'Lick', catalog: 'J/ApJS/210/5',
    list: 'J/ApJS/210/5/table1', data: 'J/ApJS/210/5/table2', name: 'Name', time: 'JD', timeOffset: 2400000, rv: 'RVel', err: 'e_RVel', group: 'CCD',
    timeStandard: 'JD − 2400000 as published (barycentric correction applied to the velocities)', bibcode: '2014ApJS..210....5F', doi: '10.1088/0067-0049/210/1/5', reference: 'Fischer, D. A. et al. 2014, ApJS, 210, 5',
    groupName: (g) => `Lick dewar ${g}`, about: 'The 25-year Lick planet search, 1987-2011. Each dewar (CCD) is its own set.',
  },
];
export const sourceById = (id) => RV_SOURCES.find((s) => s.id === id) || null;

const enc = (v) => encodeURIComponent(String(v));
/** A VizieR ASU-TSV URL: base + /viz-bin/asu-tsv? + the parameters in order. */
export function asuURL(base, params) {
  return `${base.replace(/\/$/, '')}/viz-bin/asu-tsv?` + params.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}
/** The star list of a source, searched within `radius` arcsec of (ra, dec) degrees J2000, nearest first. */
export function listQuery(src, ra, dec, { radius = 10, base = VIZIER_MIRRORS[0] } = {}) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) throw new Error('the star’s coordinates are needed to search the archives');
  return asuURL(base, [['-source', src.list], ['-c', `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`], ['-c.rs', radius], ['-out', src.name], ['-out.add', '_r'], ['-sort', '_r']]);
}
/** Every velocity of one star of a source, by the catalogue's name for it. */
export function dataQuery(src, name, { base = VIZIER_MIRRORS[0] } = {}) {
  const cols = [src.name, src.time, src.rv, src.err, src.flag, src.group].filter(Boolean);
  return asuURL(base, [['-source', src.data], [src.name, name], ['-out', cols.join(',')], ['-out.max', 'unlimited']]);
}

/**
 * Read a VizieR ASU-TSV response. Returns { status, message, tables: [{ name, columns, units, rows }] }:
 * status 'ok' (at least one row), 'empty' (a valid answer with no rows), or 'error' (the server could not answer:
 * a database connection error, an HTML error page, an unknown catalogue).
 */
export function parseASU(text) {
  const s = String(text || '');
  if (/^\s*</.test(s)) return { status: 'error', message: 'the server returned a web page instead of a table (the service may be down)', tables: [] };
  if (/STDB_ERR|No server is available|Postgres connect error|-- no connection|Can't connect to/.test(s)) return { status: 'error', message: 'the VizieR server could not reach its database (a temporary fault: another mirror usually answers)', tables: [] };
  const errLine = s.split('\n').find((l) => /^#\*\*\*|^#\+\+\+\s*Error|Unknown catalog/i.test(l));
  const lines = s.split(/\r?\n/), tables = [];
  let cur = null, stage = 0;   // 0: looking for a table; 1: header next; 2: units next; 3: dashes next; 4: rows
  for (const l of lines) {
    if (l.startsWith('#Table')) { cur = { name: '', columns: [], units: [], rows: [] }; tables.push(cur); stage = 1; continue; }
    if (cur && l.startsWith('#Name:')) { cur.name = l.slice(6).trim(); continue; }
    if (l.startsWith('#')) { if (stage === 4) stage = 0; continue; }
    if (!cur || stage === 0) continue;
    if (!l.trim()) { if (stage === 4) stage = 0; continue; }
    const c = l.split('\t');
    if (stage === 1) { cur.columns = c.map((x) => x.trim()); stage = 2; }
    else if (stage === 2) { cur.units = c.map((x) => x.trim()); stage = 3; }
    else if (stage === 3) { stage = 4; if (!/^-+/.test(l)) cur.rows.push(c.map((x) => x.trim())); }   // the dashed rule under the units
    else cur.rows.push(c.map((x) => x.trim()));
  }
  if (!tables.length && errLine) return { status: 'error', message: errLine.replace(/^#+\s*/, ''), tables: [] };
  const n = tables.reduce((a, t) => a + t.rows.length, 0);
  return { status: n ? 'ok' : 'empty', message: n ? '' : 'no rows', tables };
}
const col = (tb, name) => tb.columns.indexOf(name);

/** Stars of a star-list response: [{ name, sep (arcsec) }], nearest first. */
export function parseStarList(text, src) {
  const r = parseASU(text);
  if (r.status === 'error') throw new Error(r.message);
  const tb = r.tables[0]; if (!tb) return [];
  const iN = col(tb, src.name), iR = col(tb, '_r');
  return tb.rows.map((row) => ({ name: row[iN], sep: iR >= 0 ? Number(row[iR]) : NaN })).filter((x) => x.name).sort((a, b) => (a.sep || 0) - (b.sep || 0));
}

/**
 * Velocities of one star from a data response: { sets: [{ name, instrument, t, v, e, n, span, medErr, era }], notes, dropped }.
 * Times are absolute days (the source's time offset added), velocities and errors in m/s. Rows of other stars, rows
 * without a velocity or a positive error, and flagged rows (HARPS RVBank) are left out and counted.
 */
export function parseRVTable(text, src, starName) {
  const r = parseASU(text);
  if (r.status === 'error') throw new Error(r.message);
  const tb = r.tables[0], notes = [], dropped = { other: 0, missing: 0, flagged: 0 };
  if (!tb) return { sets: [], notes, dropped };
  const iN = col(tb, src.name), iT = col(tb, src.time), iV = col(tb, src.rv), iE = col(tb, src.err), iF = src.flag ? col(tb, src.flag) : -1, iG = src.group ? col(tb, src.group) : -1;
  if (iT < 0 || iV < 0 || iE < 0) throw new Error(`${src.data}: the response has no ${[iT < 0 && src.time, iV < 0 && src.rv, iE < 0 && src.err].filter(Boolean).join(', ')} column`);
  const kms = /km/.test(tb.units[iV] || ''), scale = kms ? 1000 : 1, off = src.timeOffset || 0;
  const groups = new Map();
  for (const row of tb.rows) {
    if (starName && iN >= 0 && row[iN] !== starName) { dropped.other++; continue; }
    const t = Number(row[iT]) + off, v = Number(row[iV]) * scale, e = Number(row[iE]) * scale;
    if (row[iV] === '' || row[iT] === '' || !Number.isFinite(t) || !Number.isFinite(v) || !(e > 0)) { dropped.missing++; continue; }
    if (iF >= 0 && row[iF] !== '' && Number(row[iF]) !== 0) { dropped.flagged++; continue; }
    let g = '';
    if (iG >= 0) { g = row[iG]; if (!g || g === '--') { dropped.missing++; continue; } g = src.groupName ? src.groupName(g) : `${src.instrument} ${g}`; }
    else if (src.split) { let k = 0; while (k < src.split.at.length && t >= src.split.at[k]) k++; g = src.split.names[k]; }
    else g = src.instrument;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([t, v, e]);
  }
  const sets = [];
  for (const [g, rows] of groups) {
    rows.sort((a, b) => a[0] - b[0]);
    const t = Float64Array.from(rows, (x) => x[0]), v = Float64Array.from(rows, (x) => x[1]), e = Float64Array.from(rows, (x) => x[2]);
    sets.push({ name: g, instrument: src.instrument, t, v, e, ...summarizeSet({ t, e }) });
  }
  sets.sort((a, b) => a.t[0] - b.t[0]);
  if (kms) notes.push('km/s converted to m/s');
  if (dropped.flagged) notes.push(`${dropped.flagged} flagged point${dropped.flagged > 1 ? 's' : ''} left out`);
  if (dropped.missing) notes.push(`${dropped.missing} row${dropped.missing > 1 ? 's' : ''} without a velocity or error left out`);
  if (src.split && sets.length > 1) notes.push(`split in two because ${src.split.why}: each part has its own zero point`);
  return { sets, notes, dropped };
}

/** n, span in days, first and last time, median error. */
export function summarizeSet({ t, e }) {
  const n = t.length, s = Float64Array.from(e).sort();
  return { n, span: n ? t[n - 1] - t[0] : 0, t0: n ? t[0] : NaN, t1: n ? t[n - 1] : NaN, medErr: n ? s[n >> 1] : NaN };
}

/**
 * Why a request failed, in words: a browser reports a cross-origin refusal and a dead network alike as a TypeError
 * ("Failed to fetch", "NetworkError when attempting to fetch resource", "Load failed"), with no status.
 */
export function describeFailure(err) {
  const m = (err && err.message) || String(err);
  if (/Failed to fetch|NetworkError|Load failed|CORS|cross-origin|ERR_FAILED/i.test(m)) return 'this archive cannot be reached from a browser here (the server refused the cross-origin request, or the network is down)';
  if (/HTTP 404/.test(m)) return 'the archive mirror does not serve this table (HTTP 404)';
  return m;
}

/** Where a set came from, as stored with the dataset in the session. */
export function provenanceOf(src, set, { star, url, retrieved, mirror } = {}) {
  return { source: src.id, catalog: src.catalog, table: src.data, column: src.rv, reference: src.reference, bibcode: src.bibcode, doi: src.doi, instrument: set.instrument, set: set.name,
    star: star || null, n: set.n ?? set.t.length, time_standard: src.timeStandard, url: url || null, mirror: mirror || null, retrieved: retrieved || null };
}

/**
 * Ask every source for a star's velocities. ra, dec in degrees (J2000). `fetchText(url)` returns the body as text
 * (or throws); each source tries the mirrors in turn until one gives a valid answer. Resolves with one entry per
 * source: { source, status: 'found' | 'none' | 'error', star, sep, sets, notes, url, mirror, message }, and never rejects
 * because of one source.
 */
export async function findRadialVelocities({ ra, dec, fetchText, sources = RV_SOURCES, mirrors = VIZIER_MIRRORS, radius = 10, now = () => new Date().toISOString() }) {
  const one = async (src) => {
    let lastErr = 'no mirror answered', none = null;
    for (const base of mirrors) {
      try {
        const lu = listQuery(src, ra, dec, { radius, base }), stars = parseStarList(await fetchText(lu), src);
        // "no star here" is asked of a second mirror before it is believed: a mirror whose database is half-down can
        // answer a well-formed empty table (seen on the CfA mirror, 2026-11-16)
        if (!stars.length) { if (none) return none; none = { source: src, status: 'none', sets: [], notes: [], url: lu, mirror: base, message: `no star within ${radius}″ in ${src.catalog}` }; continue; }
        const star = stars[0], du = dataQuery(src, star.name, { base }), r = parseRVTable(await fetchText(du), src, star.name);
        const retrieved = now();
        const sets = r.sets.map((s) => ({ ...s, provenance: provenanceOf(src, s, { star: star.name, url: du, retrieved, mirror: base }) }));
        return { source: src, status: sets.length ? 'found' : 'none', star: star.name, sep: star.sep, sets, notes: r.notes, url: du, mirror: base, message: sets.length ? '' : `${star.name} is listed but has no usable velocities` };
      } catch (err) { lastErr = describeFailure(err); }
    }
    if (none) return { ...none, message: none.message + ` (one mirror answered; ${lastErr})` };
    return { source: src, status: 'error', sets: [], notes: [], message: lastErr };
  };
  return Promise.all(sources.map(one));
}
