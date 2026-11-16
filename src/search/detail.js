// The detail drawer of the Search page: every value of one object with its catalogue, reference and the other
// catalogue's value, how the two entries were matched, the estimates with their relations, and consistency checks.
import { SOURCES, FIELDS } from '../core/sources/index.js';
import { RELATIONS } from '../core/relations.js';
import { loadIndex, lookupHost, chooseParameters, runChecks } from '../core/catalog.js';
import { readEslCatalog } from '../core/sources/eslcatalog.js';
import { esc, display, withError, unitOf, hms, dms } from './format.js';

const ORDER = ['per', 'tmid', 'drift', 't14', 'depth', 'rprs', 'ars', 'b', 'inc', 'ecc', 'omega', 'a', 'rp', 'mass', 'K', 'teq', 'insol', 'teff', 'rstar', 'mstar', 'logg', 'feh', 'lum', 'dist', 'vmag', 'gmag', 'tmag', 'jmag', 'kmag'];
const label = (id) => SOURCES.find((s) => s.id === id).label;
let indexPromise = null, eslPromise = null;

function valueRows(row, units) {
  const out = [];
  for (const k of ORDER) {
    const v = row.v[k], lim = row.lim[k];
    if (!Number.isFinite(v) && !lim) continue;
    const u = k === 'drift' ? '' : unitOf(k, units), e = row.est[k], src = row.src[k];
    let val, from;
    if (e) {
      const R = RELATIONS[e.rel];
      val = `<span class="d-val est">~${esc(display(k, v, units))} ${esc(u)}</span>`;
      from = `<b>estimated</b>: ${esc(R.name)}${R.url ? ` <a href="${esc(R.url)}" target="_blank" rel="noopener">↗</a>` : ''}, from ${esc(e.from.map((f) => FIELDS[f].label).join(', '))}${e.note ? '. ' + esc(e.note) : ''}`;
    } else if (Number.isFinite(v)) {
      val = `<span class="d-val">${esc(withError(k, v, row.e[k], units))} ${esc(u)}</span>`;
      const ref = row.ref[k], rec = row.recs[src], url = rec && rec.refUrl[k];
      from = k === 'drift' ? 'computed from σ(T₀), σ(P) and the orbits elapsed since T₀' : `<span class="tag ${src}">${SOURCES.find((s) => s.id === src).short}</span> ${ref ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(ref)}</a>` : esc(ref)) : esc(label(src))}`;
      if (k === 'mass' && row.v.massKind) from += ` · ${esc(row.v.massKind)}`;
      if (k === 'tmid' && rec && rec.info.tsys) from += ` · ${esc(rec.info.tsys)}`;
    } else {
      val = `<span class="d-val">${lim.sign > 0 ? '&lt;' : '&gt;'} ${esc(display(k, lim.value, units))} ${esc(u)}</span>`;
      from = `<span class="tag ${lim.src}">${SOURCES.find((s) => s.id === lim.src).short}</span> a limit, not a measurement`;
    }
    // the other catalogue's value
    let other = '';
    const otherId = row.cats.find((c) => c !== src && row.recs[c] && Number.isFinite(row.recs[c].v[k]));
    if (otherId && !e || (e && otherId)) {
      const o = row.recs[otherId], d = row.diff[k];
      other = `<span class="d-other${d ? ' diff' : ''}" title="${esc(label(otherId))}${d && d.nsigma ? `: differs by ${d.nsigma.toFixed(1)} sigma` : d ? ': differs' : ''}"><span class="tag ${otherId}">${SOURCES.find((s) => s.id === otherId).short}</span> ${esc(withError(k, o.v[k], o.e[k], units))}${d ? ' ≠' : ''}</span>`;
    }
    out.push(`<tr><td class="k" title="${esc(FIELDS[k].desc)}">${esc(FIELDS[k].label)}</td><td>${val}${other ? '<br>' + other : ''}</td><td class="d-src">${from}</td></tr>`);
  }
  return out.join('');
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

export function renderDetail(el, row, { units, fetchJson, onClose }) {
  const q = encodeURIComponent(row.name), m = row.match;
  const pos = Number.isFinite(row.v.ra) && Number.isFinite(row.v.dec) ? `${hms(row.v.ra)} ${dms(row.v.dec)} (J2000, ${esc(label(row.src.ra))})` : 'no coordinates';
  const names = row.cats.map((c) => `<span class="tag ${c}">${SOURCES.find((s) => s.id === c).short}</span> <a href="${esc(SOURCES.find((s) => s.id === c).planetUrl(row.recs[c]))}" target="_blank" rel="noopener">${esc(row.recs[c].name)}</a>`).join(' · ');
  const used = [...new Set(Object.values(row.est).map((e) => e.rel))];
  let html = `<div class="d-head"><h2>${esc(row.name)}</h2><button class="d-close" type="button" aria-label="Close details">✕</button></div>` +
    `<div class="d-sub">${esc(row.v.status || '')}${row.v.method ? ' · ' + esc(row.v.method) : ''}${row.v.year ? ' · ' + row.v.year : ''}${row.v.facility ? ' · ' + esc(row.v.facility) : ''}<br>${row.host ? 'Host ' + esc(row.host) + (row.v.sptype ? ' (' + esc(row.v.sptype) + ')' : '') + ' · ' : ''}${pos}<br>${names}</div>` +
    `<div class="d-links"><a class="btn primary" href="../analyze/?planet=${q}">Analyze</a><a class="btn" href="../plan/?planet=${q}">Plan</a><a class="btn" href="../observe/?planet=${q}">Sky view</a></div>`;
  if (m) {
    html += `<p class="d-note">Matched between catalogues ${m.stage === 'name' ? 'by name' : m.stage === 'alias' ? 'by an alternate name' : m.stage === 'host+letter' ? 'by host name and planet letter' : 'by position and period (no name agrees)'}` +
      `${Number.isFinite(m.sep) ? `; positions ${m.sep < 1 / 60 ? (m.sep * 3600).toFixed(1) + '″' : m.sep < 1 ? (m.sep * 60).toFixed(1) + '′' : m.sep.toFixed(1) + '°'} apart` : ''}${Number.isFinite(m.dper) ? `; periods differ by ${m.dper < 1e-6 ? 'less than 1 ppm' : (100 * m.dper).toPrecision(2) + '%'}` : ''}.</p>`;
    for (const f of m.flags) html += `<div class="d-flag">${esc(f)}</div>`;
  }
  if (row.diff.tmid) html += `<div class="d-flag">Mid-transit times: the archive ephemeris propagated ${Math.abs(row.diff.tmid.epochs)} orbits to exoplanet.eu's epoch misses it by ${row.diff.tmid.minutes.toFixed(0)} min${row.diff.tmid.nsigma ? ` (${row.diff.tmid.nsigma.toFixed(1)} σ)` : ''}.</div>`;
  html += `<h3>Values</h3><table class="d-table"><tr><th></th><th>Value${row.cats.length > 1 ? ' (and the other catalogue\'s)' : ''}</th><th>From</th></tr>${valueRows(row, units)}</table>`;
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
