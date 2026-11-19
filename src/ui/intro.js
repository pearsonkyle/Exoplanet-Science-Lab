// The opening page: what do you want to do (Plan, Acquire, Analyze), which kinds of data,
// and which system. A system is found in the bundled NASA Exoplanet Archive snapshot
// (core/catalog.js), shown with where every value came from and the physical checks it
// passed, or taken from a worked example.
//
// initIntro(app) -> { open() }.  app: { h, examples, loadExample(ex), applySession(sess), fetchCatalog(name) }

import { loadIndex, searchNames, lookupHost, systemFromRows } from '../core/catalog.js';

const KINDS = [
  { key: 'transit', label: 'Transit', sub: 'light curves: radius, inclination, mid-transit time' },
  { key: 'rv', label: 'Radial velocity', sub: 'masses, eccentricity, periastron' },
  { key: 'ephemeris', label: 'Ephemeris', sub: 'mid-transit times: period, O − C, orbital decay' },
];
const TAG = { reference: ['from the reference', 'ok'], other: ['from another reference', 'warn'], derived: ['computed', 'calc'], default: ['assumed', 'bad'] };
const LABELS = { per: 'Period P (d)', tmid: 'Mid-transit T mid (BJD)', rprs: 'Rp/R★', ars: 'a/R★', inc: 'Inclination i (°)', ecc: 'Eccentricity e', omega: 'Periastron ω (°)', mplanet: 'Planet mass (M Jup)', K: 'RV amplitude K (m/s)', t14: 'Duration T₁₄ (d)', b: 'Impact parameter b',
  teff: 'T eff (K)', logg: 'log g', feh: '[Fe/H]', rstar: 'R★ (R☉)', mstar: 'M★ (M☉)' };
const fmt = (x) => { if (!Number.isFinite(x.value)) return '—'; const e = x.err > 0 ? x.err : 0, dg = e ? Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(e)))) : Math.min(6, Math.max(0, 4 - Math.floor(Math.log10(Math.abs(x.value) || 1)))); return x.value.toFixed(dg) + (e ? ` ± ${e.toFixed(dg)}` : ''); };

/** Table of values with their sources, for one planet or the star. `keys` picks and orders the rows. */
export function provenanceTable(h, values, keys) {
  const tb = h('tbody');
  for (const k of keys) {
    const x = values[k]; if (!x) continue;
    const [txt, cls] = TAG[x.kind] || [x.kind, ''];
    tb.append(h('tr', { title: x.note || '' }, h('td', {}, LABELS[k] || k), h('td', {}, fmt(x)), h('td', {}, h('span', { class: 'src ' + cls }, txt), h('small', {}, x.source && x.source !== 'computed' ? ' ' + x.source : ''), x.note ? h('small', { class: 'why' }, x.note) : null)));
  }
  return h('table', { class: 'res prov' }, h('thead', { html: '<tr><th>Parameter</th><th>Value</th><th>Where it comes from</th></tr>' }), tb);
}
/** The consistency checks of a parameter set as a list. */
export function checkList(h, checks) {
  const icon = { ok: '✓', warn: '!', fail: '✕' };
  return h('ul', { class: 'checks' }, checks.map((c) => h('li', { class: c.status }, h('b', {}, icon[c.status] || '·'), h('span', {}, c.detail || c.name))));
}

/** "TOI-1234.01", "TOI 1234", "toi1234.2" -> { host: 1234, planet: 1 | null } or null. */
export function parseTOIName(name) {
  const m = String(name || '').trim().match(/^TOI[-\s_]?(\d+)(?:\.(\d{1,2}))?$/i);
  return m ? { host: Number(m[1]), planet: m[2] ? Number(m[2]) : null } : null;
}
/**
 * A TESS candidate as a session: the TOI records of src/core/sources/toi.js (the snapshot catalog-table/toi.json) for
 * one host. Pipeline values, not a published fit: Rp/R★ = √depth; a/R★ from Kepler's law with M★ = g R★² / G (log g
 * and R★ of the TOI row, 1 M☉ when they are missing); the impact parameter from the duration, b² = (1 + k)² −
 * (a/R★ sin(π T₁₄ / P))², 0 when that is negative; circular orbits. Everything is labelled a TESS candidate.
 * Returns null when no record matches.
 */
export function sessionFromTOI(records, name, snapshot) {
  const q = parseTOIName(name); if (!q) return null;
  const all = records.filter((r) => Math.floor(Number(r.name.slice(4))) === q.host).sort((a, b) => Number(a.name.slice(4)) - Number(b.name.slice(4)));
  const pick = q.planet ? all.filter((r) => Math.round((Number(r.name.slice(4)) % 1) * 100) === q.planet) : all;
  if (!pick.length) return null;
  const v0 = pick[0].v, e0 = pick[0].e, err = (k) => (e0[k] ? 0.5 * (e0[k][0] + e0[k][1]) : 0);
  const G = 6.6743e-11, Rsun = 6.957e8, Msun = 1.98841e30;
  const rstar = v0.rstar > 0 ? v0.rstar : 1, logg = Number.isFinite(v0.logg) ? v0.logg : 4.44, mstar = Math.min(5, Math.max(0.08, (Math.pow(10, logg) / 100) * (rstar * Rsun) ** 2 / G / Msun));
  const star = { teff: Math.round(v0.teff > 0 ? v0.teff : 5700), teffErr: Math.round(err('teff')) || 150, logg: Number(logg.toFixed(3)), loggErr: err('logg') || 0.1, feh: 0, fehErr: 0.2,
    rstar: Number(rstar.toFixed(4)), rstarErr: Number((err('rstar') || 0.07 * rstar).toFixed(4)), mstar: Number(mstar.toFixed(3)), mstarErr: Number((0.15 * mstar).toFixed(3)) };
  for (const k of ['ra', 'dec']) if (Number.isFinite(v0[k])) star[k] = v0[k];
  if (Number.isFinite(v0.tmag)) star.tmag = v0.tmag;
  const letters = 'bcdefghij', planets = [], free = [], priors = {}, notes = [];
  pick.forEach((r, i) => {
    const v = r.v, per = v.per > 0 ? v.per : null;
    if (!per) { notes.push(`${r.name} has no period (a single transit): it is left out`); return; }
    const k = Math.min(0.5, Math.max(0.005, Math.sqrt(v.depth > 0 ? v.depth : 1e-3))), P = per * 86400;
    const ars = Math.cbrt((G * mstar * Msun * P * P) / (4 * Math.PI * Math.PI)) / (rstar * Rsun), t14 = v.t14 > 0 ? v.t14 : null;
    const b2 = t14 ? (1 + k) ** 2 - (ars * Math.sin((Math.PI * t14) / per)) ** 2 : 0.25, b = Math.sqrt(Math.max(0, Math.min(b2, (1 + k - 0.05) ** 2)));
    const inc = (Math.acos(Math.min(1, b / ars)) * 180) / Math.PI, L = letters[planets.length], key = (f) => (planets.length ? `${f}@${L}` : f);
    planets.push({ letter: L, values: { rprs: Number(k.toFixed(5)), ars: Number(ars.toFixed(3)), inc: Number(inc.toFixed(3)), per, tmid: v.tmid, ecc: 0, omega: 90 } });
    free.push(key('rprs'), key('inc'), key('tmid'));
    if (e0 && r.e.per) priors[key('per')] = { type: 'normal', a: per, b: Math.max(1e-6, 0.5 * (r.e.per[0] + r.e.per[1])) };
    notes.push(`${r.name} (planet ${L}): ${r.v.status}, TIC ${r.info.tic}`);
  });
  if (!planets.length) return null;
  const host = 'TOI-' + q.host, title = (q.planet ? pick[0].name : host) + ' (TESS candidate)';
  return {
    name: host, title, star, ldLaw: 'quadratic', ld: null, band: 'TESS (approx.)', planets, kepler: false, lc: null, rv: [], timing: [],
    use: { lc: true, rv: false, timing: false }, free, priors, view: 'lc', fold: false, tab: 'data', candidate: true,
    note: `TOI candidate: ${title} from the TESS Objects of Interest snapshot of ${snapshot} (NASA Exoplanet Archive / ExoFOP). These are pipeline estimates, not a published fit: Rp/R★ from the depth, a/R★ from Kepler’s law with M★ from log g and R★, the inclination from the duration, circular orbit. ${notes.join('; ')}. The light curve shown is simulated from them as a stand-in: load your own data on the Data tab.`,
  };
}

/** Turn a catalog system into a session for the app (see ui/examples.js for the shape). */
export function sessionFromCatalog(sys, kinds, snapshot, system = null) {
  const val = (v, k, d) => (v[k] && Number.isFinite(v[k].value) ? v[k].value : d), err = (v, k) => (v[k] && v[k].err > 0 ? v[k].err : 0);
  const sv = sys.star.values, wantRV = kinds.includes('rv'), wantLC = kinds.includes('transit') || !kinds.length;
  const star = { teff: Math.round(val(sv, 'teff', 5700)), teffErr: Math.round(err(sv, 'teff')) || 100, logg: Number(val(sv, 'logg', 4.4).toFixed(3)), loggErr: err(sv, 'logg') || 0.1, feh: Number(val(sv, 'feh', 0).toFixed(3)), fehErr: err(sv, 'feh') || 0.1,
    rstar: Number(val(sv, 'rstar', 1).toFixed(4)), rstarErr: Number((err(sv, 'rstar') || 0.05 * val(sv, 'rstar', 1)).toFixed(4)), mstar: Number(val(sv, 'mstar', 1).toFixed(4)), mstarErr: Number((err(sv, 'mstar') || 0.05 * val(sv, 'mstar', 1)).toFixed(4)) };
  // the host's position and 2MASS magnitudes (archive searches, time conversion, TSM and ESM), from the catalogue's system record
  if (system) for (const [k, c, d] of [['ra', 'ra', 7], ['dec', 'dec', 7], ['jmag', 'sy_jmag', 3], ['kmag', 'sy_kmag', 3]]) if (Number.isFinite(system[c])) star[k] = Number(system[c].toFixed(d));
  const letters = sys.planets.map((p, i) => (p.planet.match(/\s([a-z])$/) || [])[1] || 'bcdefghij'[i]);
  const planets = sys.planets.map((p, i) => { const v = p.values; return { letter: letters[i], values: { rprs: val(v, 'rprs', 0.1), ars: val(v, 'ars', 10), inc: val(v, 'inc', 89), per: val(v, 'per', 3), tmid: val(v, 'tmid', 0), ecc: val(v, 'ecc', 0), omega: val(v, 'omega', 0), ...(Number.isFinite(val(v, 'mplanet', NaN)) ? { mplanet: val(v, 'mplanet') } : wantRV ? { mplanet: 0.1 } : {}) } }; });
  // free by default: what each kind of data measures. Priors: the catalog's wide suggestions.
  const free = [], priors = {};
  sys.planets.forEach((p, i) => {
    const key = (f) => (i ? `${f}@${letters[i]}` : f);
    if (wantLC) free.push(key('rprs'), key('inc'), key('tmid'));
    for (const [f, pr] of Object.entries(p.priors || {})) if (['rprs', 'ars', 'inc', 'per', 'tmid', 'ecc', 'omega', 'mplanet'].includes(f) && Number.isFinite(pr.a) && Number.isFinite(pr.b)) priors[key(f)] = { type: pr.type, a: pr.a, b: pr.b };
  });
  return {
    name: sys.host, star, ldLaw: 'quadratic', ld: null, band: 'TESS (approx.)', planets, kepler: wantRV, lc: null, rv: [], timing: [],
    use: { lc: true, rv: false, timing: false }, free, priors, view: 'lc', fold: false, tab: kinds.length === 1 && kinds[0] === 'ephemeris' ? 'timing' : 'data',
    sources: { host: sys.host, snapshot, star: sys.star, planets: sys.planets.map((p, i) => ({ letter: letters[i], planet: p.planet, reference: p.reference, values: p.values, checks: p.checks })) },
    note: `Parameters for ${sys.host} loaded from the NASA Exoplanet Archive snapshot of ${snapshot}. The light curve shown is simulated from them as a stand-in: load your own data on the Data tab.`,
  };
}

export function initIntro(app) {
  const { h } = app, root = document.getElementById('intro');
  const st = { step: 'home', kinds: new Set(), index: null, sys: null, look: null, refs: {}, msg: '', busy: false, loading: null };
  const close = () => { root.hidden = true; document.body.classList.remove('intro-open'); if (app.onClose) app.onClose(); };
  const kindsArr = () => KINDS.map((k) => k.key).filter((k) => st.kinds.has(k));
  const useOf = () => { const k = kindsArr(); return k.length === 1 ? k[0] : 'all'; };

  async function lookup(name) {
    st.busy = true; st.msg = ''; render();
    try {
      if (!st.index) st.index = await loadIndex(app.fetchCatalog);
      const L = await lookupHost(st.index, name, app.fetchCatalog);
      if (!L || !L.rows || !L.rows.length) throw new Error(`“${name}” is not in the catalog snapshot. Check the spelling, or start from an example.`);
      st.look = L; st.refs = {}; st.sys = systemFromRows(L.rows, { use: useOf() }); st.step = 'system';
    } catch (err) { st.msg = err.message || String(err); }
    st.busy = false; render();
  }
  // An example opens with its stored posterior, which takes a moment on a slow machine: the button says so, the others are
  // disabled so a second click cannot start a second load, and two frames pass so that state is painted before the work starts.
  async function openExample(e) {
    if (st.loading) return;
    st.loading = e.id; st.msg = ''; render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { await app.loadExample(e); st.loading = null; close(); render(); }
    catch (err) { st.loading = null; st.msg = 'Could not load the example: ' + (err.message || err); render(); }
  }
  function rechoose() { st.sys = systemFromRows(st.look.rows, { use: useOf(), references: st.refs }); render(); }

  function home() {
    const card = (cls, title, text, items, soon, onclick) => h('button', { class: 'icard ' + cls, disabled: soon, onclick }, h('span', { class: 'ititle' }, title, soon ? h('em', {}, 'coming soon') : null), h('span', { class: 'itext' }, text), h('span', { class: 'iitems' }, items));
    return [h('p', { class: 'ilead' }, 'What would you like to do?'),
      h('div', { class: 'icards' },
        card('plan', 'Plan', 'Decide what to observe and when.', 'transit finding · observation planning · sky charts', true),
        card('acquire', 'Acquire', 'Bring in data from open archives.', 'TESS light curves · radial-velocity archives · Exoplanet Watch', true),
        card('analyze', 'Analyze', 'Model and fit the data you have.', 'transits · eclipses · phase curves · radial velocity · ephemerides', false, () => { st.step = 'kinds'; render(); }))];
  }
  function kinds() {
    const chip = (k) => { const b = h('button', { class: 'ikind' + (st.kinds.has(k.key) ? ' on' : ''), 'aria-pressed': String(st.kinds.has(k.key)), onclick: () => { st.kinds.has(k.key) ? st.kinds.delete(k.key) : st.kinds.add(k.key); render(); } }, h('b', {}, k.label), h('span', {}, k.sub)); return b; };
    const all = h('button', { class: 'chip', onclick: () => { KINDS.forEach((k) => st.kinds.add(k.key)); render(); } }, 'All together');
    const exs = app.examples.filter((e) => !st.kinds.size || e.kinds.some((k) => st.kinds.has(k)));
    const inp = h('input', { type: 'text', id: 'isearch', placeholder: 'Planet or star, e.g. HAT-P-32 b, WASP-12, TRAPPIST-1', autocomplete: 'off', 'aria-label': 'Planet or star name', list: 'inames' }), dl = h('datalist', { id: 'inames' });
    inp.addEventListener('input', async () => { if (inp.value.trim().length < 2) return; try { if (!st.index) st.index = await loadIndex(app.fetchCatalog); dl.innerHTML = ''; for (const r of searchNames(st.index, inp.value, 10)) dl.append(h('option', { value: r.label })); } catch { /* the catalog could not be read: the Look up button reports it */ } });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) lookup(inp.value.trim()); });
    return [h('p', { class: 'ilead' }, 'Analyze: which kinds of data? (optional: choosing narrows the examples below)'), h('div', { class: 'ikinds' }, KINDS.map(chip), all),
      h('p', { class: 'ilead second' }, 'Which system?'),
      h('div', { class: 'isearch' }, inp, dl, h('button', { class: 'btn primary', disabled: st.busy, onclick: () => inp.value.trim() && lookup(inp.value.trim()) }, st.busy ? 'Looking up…' : 'Look up parameters')),
      h('p', { class: 'note' + (st.msg ? ' bad' : '') }, st.msg || 'Parameters are filled in from a bundled snapshot of the NASA Exoplanet Archive. You will see where each value comes from before anything is used.'),
      h('p', { class: 'ilead second' }, 'Or start from a worked example'),
      h('div', { class: 'iexamples' + (st.loading ? ' loading' : ''), 'aria-busy': String(!!st.loading) }, exs.map((e) => h('button', { class: 'iex' + (st.loading === e.id ? ' busy' : ''), disabled: !!st.loading, onclick: () => openExample(e) },
        h('b', {}, e.title), h('span', {}, e.sub), st.loading === e.id ? h('em', { class: 'iex-wait', role: 'status' }, h('i', { class: 'spin', 'aria-hidden': 'true' }), 'Opening the example and its stored posterior…') : null))),
      h('p', { class: 'ilead second' }, 'Your saved analyses'),
      (() => { const box = h('div', { class: 'isaved' }, h('p', { class: 'note' }, 'Looking in this browser…'));
        const fill = async () => { try { const list = await app.listSaved(); box.innerHTML = '';
          if (!list.length) box.append(h('p', { class: 'note' }, 'Nothing saved yet. The Save button at the top of the analyzer stores the data, priors and results in this browser; nothing is uploaded.'));
          for (const r of list) box.append(h('div', { class: 'isave' }, h('button', { class: 'iex', onclick: async () => { try { await app.openSaved(r.id); close(); } catch (err) { st.msg = err.message; render(); } } }, h('b', {}, r.name), h('span', {}, r.summary), h('small', {}, 'saved ' + r.updated.slice(0, 16).replace('T', ' '))),
            h('button', { class: 'chip small', title: 'Delete this saved analysis', 'aria-label': 'Delete ' + r.name, onclick: async () => { if (confirm(`Delete “${r.name}” from this browser?`)) { await app.deleteSaved(r.id); fill(); } } }, '✕')));
        } catch (err) { box.innerHTML = ''; box.append(h('p', { class: 'note' }, 'Saved analyses are not available here: ' + err.message)); } };
        fill();
        const inp = h('input', { type: 'file', accept: '.json', hidden: true, 'aria-label': 'Session file' });
        inp.addEventListener('change', async () => { if (!inp.files[0]) return; try { await app.importFile(inp.files[0]); close(); } catch (err) { st.msg = 'Could not open that file: ' + err.message; render(); } });
        return h('div', {}, box, h('div', { class: 'btnrow', style: 'margin-top:8px;justify-content:flex-start' }, h('button', { class: 'chip', onclick: () => inp.click() }, 'Open a session file…'), inp)); })(),
      h('div', { class: 'btnrow' }, h('a', { class: 'chip', href: app.home || '../', style: 'text-decoration:none' }, '← Home'), h('button', { class: 'chip', onclick: close }, 'Skip: keep the current system'))];
  }
  function system() {
    const sys = st.sys, out = [h('p', { class: 'ilead' }, `${sys.host}: ${sys.planets.length} planet${sys.planets.length > 1 ? 's' : ''} in the catalog`)];
    out.push(h('p', { class: 'note' }, `Snapshot of the NASA Exoplanet Archive from ${st.look.snapshot || st.index.date}. For each planet the reference with the most complete and physically self-consistent set is preferred over the newest; anything it lacks is filled in and labelled.`));
    out.push(h('h4', {}, 'Star'), h('p', { class: 'note' }, sys.star.how || ''), provenanceTable(h, sys.star.values, ['teff', 'logg', 'feh', 'rstar', 'mstar']));
    if (sys.star.checks && sys.star.checks.length) out.push(checkList(h, sys.star.checks));
    for (const p of sys.planets) {
      const sel = h('select', { 'aria-label': `Reference for ${p.planet}` }, (p.alternatives || []).map((a) => h('option', { value: a.reference, selected: a.reference === p.reference.label }, `${a.reference}${a.pubdate ? ' · ' + a.pubdate : ''} · score ${a.score.toFixed(0)}${a.failed && a.failed.length ? ` · ${a.failed.length} failed check${a.failed.length > 1 ? 's' : ''}` : ''}${a.isDefault ? ' · archive default' : ''}`)));
      sel.addEventListener('change', () => { st.refs = { ...st.refs, [p.planet]: sel.value }; rechoose(); });
      out.push(h('h4', {}, p.planet, p.reference.url ? h('a', { href: p.reference.url, target: '_blank', rel: 'noopener' }, p.reference.label + ' ↗') : h('span', {}, p.reference.label)));
      out.push(h('div', { class: 'field' }, h('span', {}, 'Reference'), sel), h('p', { class: 'note' }, 'Chosen because: ' + (p.reference.why || '')));
      out.push(provenanceTable(h, p.values, ['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'omega', 'mplanet', 'K', 't14', 'b']));
      out.push(h('details', { open: p.checks.some((c) => c.status !== 'ok') }, h('summary', {}, `Physical checks: ${p.checks.filter((c) => c.status === 'ok').length} pass` + (p.checks.some((c) => c.status === 'warn') ? `, ${p.checks.filter((c) => c.status === 'warn').length} to look at` : '') + (p.checks.some((c) => c.status === 'fail') ? `, ${p.checks.filter((c) => c.status === 'fail').length} fail` : '')), checkList(h, p.checks)));
    }
    out.push(h('p', { class: 'note' }, 'Priors start wide (the catalog only centres them), so the fit is driven by your data. Times are used as the archive lists them, without converting between time systems.'));
    out.push(h('div', { class: 'btnrow' }, h('button', { class: 'chip', onclick: () => { st.step = 'kinds'; render(); } }, '← Back'),
      h('button', { class: 'btn primary', onclick: () => { app.applySession(sessionFromCatalog(sys, kindsArr(), st.look.snapshot || st.index.date, st.look.system)); close(); } }, 'Use these parameters')));
    return out;
  }
  function render() {
    root.innerHTML = '';
    const body = st.step === 'home' ? home() : st.step === 'kinds' ? kinds() : system();
    root.append(h('div', { class: 'ibox ' + st.step }, h('div', { class: 'ihead' }, h('span', { class: 'brand-mark' }), h('h2', {}, 'Exoplanet Science Lab'), h('button', { class: 'chip small iclose', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'itag' }, 'Model and fit exoplanet observations in your browser. Nothing you load leaves your computer.'), ...body));
  }
  return { lookup(name) { st.step = 'kinds'; root.hidden = false; document.body.classList.add('intro-open'); lookup(name); },
    open(step = 'kinds') { st.step = step; st.msg = ''; root.hidden = false; document.body.classList.add('intro-open'); render(); } };
}
