// The detail drawer of the Search page: every value of one object with its catalogue, reference and the other
// catalogue's value, how the two entries were matched, the estimates with their relations, and consistency checks.
import { SOURCES, FIELDS, timingSigma } from '../core/sources/index.js';
import { RELATIONS } from '../core/relations.js';
import { loadIndex, lookupHost, chooseParameters, runChecks } from '../core/catalog.js';
import { readEslCatalog } from '../core/sources/eslcatalog.js';
import { esc, display, withError, unitOf, hms, dms, minutes, UNIT_NAMES } from './format.js';

// the drawer's comparison table, in groups; position and brightness share one
const GROUPS = [['Orbit', ['per', 'tmid', 'drift', 'inc', 'ecc', 'omega', 'a']], ['Transit', ['t14', 'depth', 'rprs', 'ars', 'b']], ['Planet', ['rp', 'mass', 'K', 'teq', 'insol']],
  ['Star', ['teff', 'rstar', 'mstar', 'logg', 'feh', 'lum']], ['Distance and brightness', ['dist', 'vmag', 'gmag', 'tmag', 'jmag', 'kmag']]];
const label = (id) => SOURCES.find((s) => s.id === id).label;
const short = (id) => SOURCES.find((s) => s.id === id).short;
let indexPromise = null, eslPromise = null;
const sig = (e) => (e ? (e[0] + e[1]) / 2 : 0);

/** A value and its error as two lines: the number, then "± e" or "+a −b" (display units, no unit). */
function valueHtml(k, v, err, units) {
  const t = withError(k, v, err, units), m = t.match(/^(\S+)\s+(.*)$/);
  return m ? `<span class="n">${esc(m[1])}</span><span class="pm">${esc(m[2])}</span>` : `<span class="n">${esc(t)}</span>`;
}
/** One catalogue's value of field k for the drawer: value, error, limit, reference. */
function catCell(row, c, k, units, now) {
  const rec = row.recs[c];
  if (k === 'drift') {
    const ts = timingSigma({ per: rec.v.per, tmid: rec.v.tmid, perErr: sig(rec.e.per), tmidErr: sig(rec.e.tmid) }, now);
    return ts ? `<span class="n">${esc(minutes(ts.sigma * 1440))}</span><span class="ref">${ts.n} orbits from T₀</span>` : '<span class="none">—</span>';
  }
  const v = rec.v[k], lim = rec.lim[k];
  let h;
  if (Number.isFinite(v)) h = valueHtml(k, v, rec.e[k], units);
  else if (lim) h = `<span class="n">${lim.sign > 0 ? '&lt;' : '&gt;'} ${esc(display(k, lim.value, units))}</span><span class="ref">limit</span>`;
  else return '<span class="none">—</span>';
  const ref = rec.ref[k], url = rec.refUrl[k], extra = [];
  if (k === 'mass' && rec.v.massKind) extra.push(esc(rec.v.massKind));
  if (k === 'tmid' && rec.info.tsys) extra.push(esc(rec.info.tsys));
  if (k === 'tmid' && c === 'eu' && rec.info.ephemeris) extra.push(rec.info.ephemeris.epoch === 'transit' ? 'tzero_tr' : 'tconj');
  if (ref) extra.unshift(url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(ref)}</a>` : esc(ref));
  return h + (extra.length ? `<span class="ref">${extra.join(' · ')}</span>` : '');
}
/** The values of every catalogue side by side, grouped, with the disagreements marked. */
function compareTable(row, units, now) {
  const cats = row.cats, two = cats.length > 1;
  const head = `<thead><tr><th scope="col">Parameter</th><th scope="col">Unit</th>${cats.map((c) => `<th scope="col" class="c"><span class="tag ${c}">${short(c)}</span> ${{ nea: 'NASA archive', eu: 'exoplanet.eu', toi: 'TOI list' }[c] || esc(label(c))}</th>`).join('')}${two ? '<th scope="col" class="dx" title="Do the two catalogues agree within their errors?">Agree?</th>' : ''}</tr></thead>`;
  let body = '';
  for (const [g, keys] of GROUPS) {
    let rows = '';
    for (const k of keys) {
      const has = cats.some((c) => Number.isFinite(row.recs[c].v[k]) || row.recs[c].lim[k] || (k === 'drift' && row.recs[c].e.per && row.recs[c].e.tmid)), e = row.est[k];
      if (!has && !e) continue;
      const F = FIELDS[k], u = k === 'drift' ? '' : unitOf(k, units), d = row.diff[k];
      let cells;
      if (!has) {
        const R = RELATIONS[e.rel];
        cells = `<td colspan="${cats.length}" class="estc"><span class="n est">~${esc(display(k, e.value, units))}</span><span class="ref">estimated: ${esc(R.name)}${R.url ? ` <a href="${esc(R.url)}" target="_blank" rel="noopener">↗</a>` : ''}, from ${esc(e.from.map((f) => FIELDS[f].label).join(', '))}${e.note ? '. ' + esc(e.note) : ''}</span></td>`;
      } else cells = cats.map((c) => `<td class="c${row.src[k] === c && two ? ' used' : ''}"${row.src[k] === c && two ? ' title="The value the table shows"' : ''}>${catCell(row, c, k, units, now)}</td>`).join('');
      let dx = '';
      if (two) {
        const both = has && cats.every((c) => Number.isFinite(row.recs[c].v[k]));
        if (d) dx = `<td class="dx bad" title="${esc(d.minutes != null ? `The archive's ephemeris propagated ${Math.abs(d.epochs)} orbits to exoplanet.eu's epoch misses it by ${d.minutes.toFixed(0)} min` : `The catalogues differ by ${(100 * d.frac).toPrecision(2)}%`)}${d.nsigma ? `, ${d.nsigma.toFixed(1)} σ` : ', no errors to compare with'}"><span class="badge">≠${d.nsigma ? ` ${d.nsigma < 100 ? d.nsigma.toFixed(1) : d.nsigma < 1e4 ? d.nsigma.toFixed(0) : '>10⁴'}σ` : ''}</span></td>`;
        else dx = `<td class="dx${both ? ' ok' : ''}"${both ? ' title="Within their errors (or within the size floor)"' : ''}>${both && k !== 'drift' ? '✓' : ''}</td>`;
      }
      rows += `<tr class="${d ? 'differs' : ''}"><th scope="row" title="${esc(F.desc)}">${esc(F.label)}</th><td class="u" title="${esc(UNIT_NAMES[u] || (k === 'drift' ? 'shown with each value' : 'dimensionless'))}">${esc(u || (k === 'drift' ? '' : '–'))}</td>${cells}${dx}</tr>`;
    }
    if (rows) body += `<tbody><tr class="grp"><th colspan="${2 + cats.length + (two ? 1 : 0)}" scope="colgroup">${esc(g)}</th></tr>${rows}</tbody>`;
  }
  return `<div class="d-cmpwrap"><table class="d-cmp${two ? ' two' : ''}">${head}${body}</table></div>`;
}
/** The ephemerides the object has (best-timed, archive default, exoplanet.eu), the one in use marked. */
function ephTable(row, which, now) {
  const E = row.ephemerides || {}, used = row.eph && row.eph.used, list = [['best', 'NASA best-timed'], ['default', 'NASA archive default'], ['eu', 'exoplanet.eu'], ['own', 'TOI list']];
  const lines = list.filter(([k]) => E[k] || (k === 'eu' && row.recs.eu)).map(([k, name]) => {
    const e = E[k];
    if (!e) return `<tr><th scope="row">${name}</th><td colspan="4" class="none">none usable: ${esc(E.rejected && E.rejected.eu || 'no period and epoch')}</td></tr>`;
    const ts = timingSigma(e, now), on = used === k;
    return `<tr class="${on ? 'on' : ''}"><th scope="row">${name}${on ? ' <span class="inuse">in use</span>' : ''}</th><td>${valueHtml('per', e.per, e.perE, 'earth')}</td><td>${valueHtml('tmid', e.tmid, e.tmidE, 'earth')}</td><td>${ts ? esc(minutes(ts.sigma * 1440)) : '<span class="none">no errors</span>'}</td>` +
      `<td class="ref">${e.ref ? (e.refUrl ? `<a href="${esc(e.refUrl)}" target="_blank" rel="noopener">${esc(e.ref)}</a>` : esc(e.ref)) : k === 'eu' ? 'no reference per value' : ''}${e.mixed ? ' (two papers)' : ''}</td></tr>`;
  });
  if (!lines.length) return '';
  const fb = row.eph && row.eph.fallback ? `<div class="d-flag">† ${esc(row.eph.fallback)}.</div>` : '';
  return `<h3>Ephemerides</h3>${fb}<div class="d-cmpwrap"><table class="d-eph"><thead><tr><th scope="col"></th><th scope="col">P <small>d</small></th><th scope="col">T₀ <small>BJD</small></th><th scope="col">σ(T) now</th><th scope="col">Reference</th></tr></thead><tbody>${lines.join('')}</tbody></table></div>` +
    '<p class="d-note">σ(T) now: 1σ of the transit nearest today, sqrt(σ_T0² + (N σ_P)²), P and T₀ from one solution. Choose the one the table uses under Ephemeris.</p>';
}

/** The Observe page for this object: its name, and its host and position for when Observe does not know the name. */
export function skyLink(row) {
  const p = new URLSearchParams({ planet: row.name });
  if (row.host) p.set('host', row.host);
  if (Number.isFinite(row.v.ra) && Number.isFinite(row.v.dec)) { p.set('ra', row.v.ra.toFixed(5)); p.set('dec', row.v.dec.toFixed(5)); }
  return '../observe/?' + p.toString().replace(/\+/g, '%20');
}

const checkList = (checks) => (checks.length ? '<ul class="chk">' + checks.map((c) => `<li><span class="st ${c.status}">${c.status}</span><span class="tx">${esc(c.detail)}</span></li>`).join('') + '</ul>' : '<p class="d-note">Not enough quantities to check anything against anything else.</p>');

// Checks on the values of one catalogue record (no estimates): the same tests catalog.js runs on archive references.
function ownChecks(rec) {
  const q = {}, map = { a: 'aAU' };
  for (const k of ['per', 'ars', 'a', 'rprs', 'depth', 't14', 'b', 'inc', 'ecc', 'omega', 'K', 'mass', 'rp', 'logg', 'mstar', 'rstar']) {
    if (Number.isFinite(rec.v[k])) q[map[k] || k] = { value: rec.v[k], err: rec.e[k] ? (rec.e[k][0] + rec.e[k][1]) / 2 : null };
  }
  return runChecks(q, { transit: !!rec.v.transit, massProv: /sin/i.test(rec.v.massKind || '') ? 'Msini' : rec.v.massKind ? 'Mass' : '' });
}

export function renderDetail(el, row, { units, eph = 'best', now = Date.now() / 86400000 + 2440587.5, fetchJson, onClose }) {
  const q = encodeURIComponent(row.name), m = row.match;
  const pos = Number.isFinite(row.v.ra) && Number.isFinite(row.v.dec) ? `${hms(row.v.ra)} ${dms(row.v.dec)} (J2000, ${esc(label(row.src.ra))})` : 'no coordinates';
  const names = row.cats.map((c) => `<span class="tag ${c}">${SOURCES.find((s) => s.id === c).short}</span> <a href="${esc(SOURCES.find((s) => s.id === c).planetUrl(row.recs[c]))}" target="_blank" rel="noopener">${esc(row.recs[c].name)}</a>`).join(' · ');
  const used = [...new Set(Object.values(row.est).map((e) => e.rel))];
  let html = `<div class="d-head"><h2>${esc(row.name)}</h2><button class="d-close" type="button" aria-label="Close details">✕</button></div>` +
    `<div class="d-sub">${esc(row.v.status || '')}${row.v.method ? ' · ' + esc(row.v.method) : ''}${row.v.year ? ' · ' + row.v.year : ''}${row.v.facility ? ' · ' + esc(row.v.facility) : ''}<br>${row.host ? 'Host ' + esc(row.host) + (row.v.sptype ? ' (' + esc(row.v.sptype) + ')' : '') + ' · ' : ''}${pos}<br>${names}</div>` +
    `<div class="d-links"><a class="btn primary" href="../analyze/?planet=${q}">Analyze</a><a class="btn" href="../plan/?planet=${q}">Plan</a><a class="btn" href="${esc(skyLink(row))}" title="The Observe page with this star marked, its card open and the view turned to it">Sky view</a></div>`;
  if (m) {
    html += `<p class="d-note">Matched between catalogues ${m.stage === 'name' ? 'by name' : m.stage === 'alias' ? 'by an alternate name' : m.stage === 'host+letter' ? 'by host name and planet letter' : 'by position and period (no name agrees)'}` +
      `${Number.isFinite(m.sep) ? `; positions ${m.sep < 1 / 60 ? (m.sep * 3600).toFixed(1) + '″' : m.sep < 1 ? (m.sep * 60).toFixed(1) + '′' : m.sep.toFixed(1) + '°'} apart` : ''}${Number.isFinite(m.dper) ? `; periods differ by ${m.dper < 1e-6 ? 'less than 1 ppm' : (100 * m.dper).toPrecision(2) + '%'}` : ''}.</p>`;
    for (const f of m.flags) html += `<div class="d-flag">${esc(f)}</div>`;
  }
  if (row.diff.tmid) html += `<div class="d-flag">Mid-transit times: the archive ephemeris propagated ${Math.abs(row.diff.tmid.epochs)} orbits to exoplanet.eu's epoch misses it by ${row.diff.tmid.minutes.toFixed(0)} min${row.diff.tmid.nsigma ? ` (${row.diff.tmid.nsigma.toFixed(1)} σ)` : ''}.</div>`;
  html += `<h3>Values${row.cats.length > 1 ? ': NASA archive and exoplanet.eu' : ''}</h3>` + (row.cats.length > 1 ? '<p class="d-note">Each catalogue\'s own value ± its error. ≠ marks a difference beyond 3σ of the combined errors (and beyond a size floor); the highlighted cell is the one the table shows.</p>' : '') + compareTable(row, units, now) + ephTable(row, eph, now);
  if (used.length) html += '<h3>Relations used for the estimates</h3><ul class="d-cite">' + used.map((id) => { const R = RELATIONS[id]; return `<li><b>${esc(R.name)}</b>. ${esc(R.cite)}. ${esc(R.formula)}. Valid: ${esc(R.valid)}.</li>`; }).join('') + '</ul>';
  html += '<h3>Suggested priors</h3><div id="d-priors"><button class="btn" type="button" id="d-priors-btn">Show the priors of the ESL catalogue</button> <span class="d-note">loads the offline catalogue once (about 2 MB compressed)</span></div>';
  html += '<h3>Consistency checks</h3><div id="d-checks"><p class="d-note">Checking…</p></div>';
  el.innerHTML = html;
  el.querySelector('.d-close').addEventListener('click', onClose);
  const showPriors = () => {
    const pb = el.querySelector('#d-priors');
    pb.innerHTML = '<p class="d-note">Loading…</p>';
    eslPromise ||= fetchJson('esl-catalog/catalog.json').then(readEslCatalog);
    eslPromise.then((cat) => {
      if (!el.contains(pb)) return;
      const p = cat.get(row.name) || row.cats.map((c) => cat.get(row.recs[c].name)).find(Boolean), keys = p ? Object.keys(p.priors) : [];
      if (!keys.length) { pb.innerHTML = `<p class="d-note">${row.recs.toi && row.cats.length === 1 ? 'TESS candidates are not in the ESL catalogue.' : 'The ESL catalogue has no priors for this object: it lists no orbit or star to centre them on.'}</p>`; return; }
      const f = p.priorsFrom, g = (x) => (Math.abs(x) >= 1e5 ? String(+x.toPrecision(13)) : String(+x.toPrecision(6)));
      pb.innerHTML = `<p class="d-note">Starting priors for a fit, from the ESL catalogue (catalogue snapshots of ${esc(cat.meta.snapshots ? Object.values(cat.meta.snapshots)[0] : '')}). ` +
        (f && f.basis !== 'merged' ? `Centred on ${f.referenceUrl ? `<a href="${esc(f.referenceUrl)}" target="_blank" rel="noopener">${esc(f.reference)}</a>` : esc(f.reference)}, the reference chosen for a ${f.basis === 'rv' ? 'radial-velocity' : f.basis === 'transit' ? 'transit' : 'general'} analysis, which need not be the source of the composite values above.` : 'Centred on the merged catalogue values above (this object has no per-reference rows).') +
        ' They are wide on purpose: the catalogue centres them, the data decide.</p>' +
        '<table class="d-table"><tr><th></th><th>Prior</th><th>Why</th></tr>' + keys.map((k) => { const x = p.priors[k]; return `<tr><td class="k">${esc(k)}</td><td><span class="d-val">${x.type === 'uniform' ? `U(${g(x.a)}, ${g(x.b)})` : `N(${g(x.a)}, ${g(x.b)})`}</span></td><td class="d-src">${esc(x.why)}</td></tr>`; }).join('') + '</table>' +
        '<p class="d-note">Units: days, degrees, m/s, Jupiter masses, solar units, K. The whole catalogue: <a href="../esl-catalog/catalog.json" download>catalog.json</a>, <a href="../esl-catalog/manifest.json" target="_blank" rel="noopener">manifest</a>.</p>';
    }).catch((err) => { eslPromise = null; if (el.contains(pb)) pb.innerHTML = `<p class="d-note">Could not load the ESL catalogue (${esc(err.message)}).</p>`; });
  };
  el.querySelector('#d-priors-btn').addEventListener('click', showPriors);
  if (eslPromise) showPriors();                                           // already loaded: no need to ask again

  // checks: for an archive planet, on the reference chosen from every published one (catalog.js); otherwise on the row's own values
  const box = el.querySelector('#d-checks');
  const own = () => row.cats.filter((c) => c !== 'nea').map((c) => `<p class="d-note">On the values ${esc(label(c))} lists${c === 'toi' ? ' (pipeline estimates)' : ''}:</p>` + checkList(ownChecks(row.recs[c]))).join('');
  if (!row.recs.nea) { box.innerHTML = own(); return; }
  indexPromise ||= loadIndex((f) => fetchJson('catalog/' + f));
  indexPromise.then(async (index) => {
    const host = await lookupHost(index, row.recs.nea.name, (f) => fetchJson('catalog/' + f));
    if (!el.contains(box)) return;                                        // another row was opened meanwhile
    const p = host && chooseParameters(host.rows, row.recs.nea.name, { use: row.v.transit ? 'transit' : 'rv' });
    if (!p) { box.innerHTML = '<p class="d-note">Not in the per-reference snapshot.</p>' + own(); return; }
    const alts = p.alternatives;
    box.innerHTML = `<p class="d-note">The archive has ${alts.length} reference${alts.length > 1 ? 's' : ''} for this planet. The most complete and self-consistent one for a ${p.use === 'rv' ? 'radial-velocity' : 'transit'} analysis is ` +
      `${p.reference.url ? `<a href="${esc(p.reference.url)}" target="_blank" rel="noopener">${esc(p.reference.label)}</a>` : esc(p.reference.label)}: ${esc(p.reference.why)}. This is the set the analyzer loads.</p>` + checkList(p.checks) +
      (alts.length > 1 ? `<p class="d-note">Other references: ${alts.filter((a) => !a.chosen).slice(0, 8).map((a) => `${esc(a.reference)} (score ${a.score.toFixed(0)}${a.failed.length ? ', fails ' + esc(a.failed.join(', ')) : ''})`).join('; ')}${alts.length > 9 ? '; …' : ''}</p>` : '') + own();
  }).catch((err) => { if (el.contains(box)) box.innerHTML = `<p class="d-note">Could not load the per-reference snapshot (${esc(err.message)}).</p>` + own(); });
}
