// The ESL catalogue (public/esl-catalog/, built by tools/build_esl_catalog.py) read back through
// src/core/sources/eslcatalog.js and compared with the live merge it was packed from: buildTable for the values,
// provenance and estimates, systemFromRows / suggestPriors for the priors. Also the manifest: checksums, sizes, counts.
// A FAIL "stale" means a snapshot under public/ changed after the catalogue was built: rerun
//   .venv-plan/bin/python tools/build_esl_catalog.py --no-download
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readEslCatalog } from '../src/core/sources/eslcatalog.js';
import { loadSources, buildTable, FIELDS } from '../src/core/sources/index.js';
import { loadIndex, lookupHost, systemFromRows, suggestPriors } from '../src/core/catalog.js';
import { RELATIONS } from '../src/core/relations.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const pub = (p) => new URL('../public/' + p, import.meta.url);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const fin = Number.isFinite;
const close = (a, b, tol) => a === b || Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));

// --- the reader on a hand-made file
{
  const tiny = { format: 'esl-catalog', v: 1, snapshots: { nea: 'd1', eu: 'd2', ps: 'd3' }, credits: [], sources: ['nea', 'eu', 'toi'],
    fields: [['per', 'n', 'd', 'Period'], ['tmid', 'n', 'JD', 'T mid'], ['method', 's', '', 'Method'], ['K', 'n', 'm/s', 'K'], ['mass', 'n', 'Mjup', 'Mass'], ['ecc', 'n', '', 'e']],
    refs: [['Smith et al. 2020', '2020AJ....159....1S'], ['Site', 'https://example.org/x']], prov: [[0, 0], [1, -1], [0, 1]], strs: ['Transit', 'from M sin i'],
    relations: [['rvk', 'RV semi-amplitude', 'a citation']], estInfo: [[0, [4, 0], 1, 1]], priorKeys: ['per', 'tmid'], priorTypes: ['uniform', 'normal'], priorWhy: [[1, 'std = 5 sigma'], [0, '± 0.02 d']],
    bases: ['transit', 'rv', 'all', 'merged'],
    planets: [{ n: 'Aa-1 b', h: 'Aa-1', c: 3, t: 1, a: ['Aa-1 Ab'], v: [[0, 0, 3.25, 0.001, 1, 2459000.5, [0.002, 0.003]], [1, 2, 0, 0], [2, 4, 1.5, 0]], l: [5, 0.1, 1, 0], e: [3, 150.5, 0], p: [0, 3.25, 0.005, 0, 1, 2458999.5, 2459001.5, 1], pb: [0, 0, 1] },
      { n: 'Bb-2 b', h: 'Bb-2', c: 2, v: [[1, 0, 10, 0]] }] };
  const C = readEslCatalog(tiny), p = C.get('aa1b'), q = C.get('Bb-2 b');
  check('reader: values, errors, provenance', p && p.values.per === 3.25 && p.errors.per.join() === '0.001,0.001' && p.errors.tmid.join() === '0.002,0.003' && p.src.per === 'nea' && p.ref.per === 'Smith et al. 2020' &&
    p.refUrl.per === 'https://ui.adsabs.harvard.edu/abs/2020AJ....159....1S/abstract' && p.values.method === 'Transit' && p.src.method === 'eu' && !p.ref.method && p.refUrl.mass === 'https://example.org/x' && !p.errors.mass);
  check('reader: limits, estimates, priors', p.lim.ecc.value === 0.1 && p.lim.ecc.sign === 1 && p.lim.ecc.src === 'nea' && p.est.K.value === 150.5 && p.est.K.rel === 'rvk' && p.est.K.from.join() === 'mass,per' && p.est.K.note === 'from M sin i' && p.est.K.chain === true &&
    !('K' in p.values) && p.priors.per.type === 'normal' && p.priors.per.b === 0.005 && p.priors.tmid.type === 'uniform' && p.priors.tmid.why === '± 0.02 d' &&
    p.priorsFrom.basis === 'transit' && p.priorsFrom.reference === 'Smith et al. 2020' && p.priorsFrom.star === 'Site' && p.priorsFrom.starUrl === 'https://example.org/x');
  check('reader: identity and lookup', p.cats.join() === 'nea,eu' && p.transit === true && q.cats.join() === 'eu' && q.transit === false && q.priorsFrom === null && Object.keys(q.priors).length === 0 &&
    C.get('Aa-1 Ab').name === 'Aa-1 b' && C.get('nothing') === null && C.has('AA-1B') && C.size === 2 && C.names().join() === 'Aa-1 b,Bb-2 b' && C.at(1).name === 'Bb-2 b' && [...C.all()].length === 2 && C.find((x) => !x.transit).name === 'Bb-2 b');
  let threw = 0; for (const bad of [null, {}, { format: 'esl-catalog', v: 2, planets: [] }]) try { readEslCatalog(bad); } catch { threw++; }
  check('reader: unknown format is refused', threw === 3);
}

// --- the built catalogue against the live merge
const files = ['esl-catalog/catalog.json', 'esl-catalog/manifest.json', 'catalog-table/nea.json', 'catalog-eu/planets.json', 'catalog/index.json'];
if (!files.every((f) => existsSync(pub(f)))) check('catalogue and snapshots are built (.venv-plan/bin/python tools/build_esl_catalog.py)', false, files.filter((f) => !existsSync(pub(f))).join(', '));
else {
  const raw = readFileSync(pub('esl-catalog/catalog.json')), json = JSON.parse(raw), man = JSON.parse(readFileSync(pub('esl-catalog/manifest.json')));
  const t0 = performance.now(), C = readEslCatalog(json), tRead = performance.now() - t0;

  // manifest: files
  const mf = man.files.find((f) => f.name === 'catalog.json');
  check('manifest: checksum and size of every file', man.files.length >= 1 && man.files.every((f) => { const b = readFileSync(pub('esl-catalog/' + f.name)); return b.length === f.bytes && sha(b) === f.sha256; }), `catalog.json ${(raw.length / 1e6).toFixed(2)} MB, sha256 ${sha(raw).slice(0, 16)}...`);
  check('manifest: gzip size', Math.abs(gzipSync(raw, { level: 9 }).length - mf.gzipBytes) < 0.02 * mf.gzipBytes, `${(mf.gzipBytes / 1e6).toFixed(2)} MB gzipped`);
  check('size: under 10 MB, under 3 MB gzipped', raw.length < 10e6 && mf.gzipBytes < 3e6);
  check('manifest: format, version, build date, software, licences, schema', man.format === 'esl-catalog' && man.formatVersion === json.v && /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(man.built) &&
    man.software.version === JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version &&
    man.licences.some((l) => l.id === 'nea' && /NASA Exoplanet Archive, which is operated by the California Institute of Technology/.test(l.acknowledgement)) &&
    man.licences.some((l) => l.id === 'eu' && /Creative Commons Attribution 4.0/.test(l.licence) && /portal exoplanet.eu of The Extrasolar Planets Encyclopaedia/.test(l.acknowledgement)) &&
    man.schema && man.schema.planet && man.schema.tables && JSON.stringify(json.credits) === JSON.stringify(man.licences), `built ${man.built}, ESL ${man.software.version}`);

  // manifest: the snapshots it was built from are the ones on disk
  const snap = (id) => man.snapshots.find((s) => s.id === id);
  const disk = { nea: readFileSync(pub('catalog-table/nea.json')), eu: readFileSync(pub('catalog-eu/planets.json')), ps: readFileSync(pub('catalog/index.json')) };
  const fresh = ['nea', 'eu', 'ps'].filter((id) => sha(disk[id]) !== snap(id).sha256);
  check('not stale: built from the snapshots now on disk', fresh.length === 0, fresh.length ? 'changed since the build: ' + fresh.join(', ') + '; rerun tools/build_esl_catalog.py --no-download' : `nea ${snap('nea').date}, eu ${snap('eu').date}, ps ${snap('ps').date}`);
  check('snapshot dates in the file and the manifest agree', ['nea', 'eu', 'ps'].every((id) => json.snapshots[id] === snap(id).date && /^\d{4}-\d\d-\d\d$/.test(snap(id).date)));

  // live merge, from the same bytes
  const parsed = { 'catalog-table/nea.json': disk.nea, 'catalog-eu/planets.json': disk.eu };
  const L = await loadSources(async (f) => JSON.parse(parsed[f]), ['nea', 'eu']);
  const T = buildTable(L, { now: 2461000 });
  const fetchCat = async (name) => JSON.parse(name === 'index.json' ? disk.ps : readFileSync(pub('catalog/' + name)));
  const index = await loadIndex(fetchCat);
  const rowOf = new Map(T.rows.map((r) => [r.name, r]));

  // counts
  const all = [...C.all()], cnt = man.counts;
  const n = (f) => all.filter(f).length;
  check('counts: one planet per merged row, names unique and sorted', C.size === T.rows.length && C.size === cnt.planets && new Set(C.names()).size === C.size && C.names().every((x, i, a) => i === 0 || a[i - 1] < x) && all.every((p) => rowOf.has(p.name)), `${C.size} planets`);
  check('counts: catalogues', cnt.matchedInBoth === T.counts.both && cnt.nasaArchiveOnly === T.counts.neaOnly && cnt.exoplanetEuOnly === T.counts.euOnly && cnt.inNasaArchive === L.nea.records.length && cnt.inExoplanetEu === L.eu.records.length &&
    n((p) => p.cats.join() === 'nea,eu') === cnt.matchedInBoth && n((p) => p.cats.join() === 'nea') === cnt.nasaArchiveOnly && n((p) => p.cats.join() === 'eu') === cnt.exoplanetEuOnly &&
    cnt.matchedInBoth + cnt.nasaArchiveOnly + cnt.exoplanetEuOnly === cnt.planets && snap('nea').rows === cnt.inNasaArchive && snap('eu').rows === cnt.inExoplanetEu && snap('ps').planets === index.nplanets,
    `${cnt.matchedInBoth} in both, ${cnt.nasaArchiveOnly} NASA archive only, ${cnt.exoplanetEuOnly} exoplanet.eu only`);
  const nPri = n((p) => Object.keys(p.priors).length > 0), nEst = n((p) => Object.keys(p.est).length > 0);
  const sum = (f) => all.reduce((s, p) => s + f(p), 0);
  check('counts: priors and estimates', nPri === cnt.withPriors && nEst === cnt.withEstimates && nEst === T.rows.filter((r) => r.nest > 0).length && sum((p) => Object.keys(p.priors).length) === cnt.priors &&
    sum((p) => Object.keys(p.est).length) === cnt.estimates && sum((p) => Object.keys(p.values).length) === cnt.values && n((p) => p.transit) === cnt.transiting && cnt.transiting === T.rows.filter((r) => r.v.transit).length &&
    Object.values(cnt.priorsByBasis).reduce((a, b) => a + b, 0) === cnt.withPriors && Object.entries(cnt.priorsByBasis).every(([b, k]) => n((p) => p.priorsFrom && p.priorsFrom.basis === b) === k),
    `${nPri} with priors (${Object.entries(cnt.priorsByBasis).map(([b, k]) => `${b} ${k}`).join(', ')}), ${nEst} with at least one estimate, ${cnt.values} values, ${cnt.estimates} estimates, ${cnt.priors} priors`);
  check('priors: every planet of the NASA archive got them from its published references', all.every((p) => !p.cats.includes('nea') || (p.priorsFrom && p.priorsFrom.basis !== 'merged' && p.priorsFrom.reference)) && all.every((p) => p.cats.includes('nea') || !p.priorsFrom || p.priorsFrom.basis === 'merged'));
  const empty = all.filter((p) => !Object.keys(p.priors).length);
  check('priors: the planets without any have no orbit or star to centre one on', empty.length === man.oddities.emptyPriors.n && empty.every((p) => !['per', 'tmid', 'rprs', 'ars', 'inc', 'ecc', 'K', 'mass', 'teff', 'rstar', 'mstar', 'logg', 'feh'].some((k) => fin(rowOf.get(p.name).v[k]))), `${empty.length}: ${empty.map((p) => p.name).join(', ')}`);
  check('manifest: nothing went wrong in the build', ['neaNotInPs', 'chooseFailed', 'nonFinitePriors', 'duplicateNames'].every((k) => man.oddities[k].n === 0), JSON.stringify(Object.fromEntries(Object.entries(man.oddities).map(([k, v]) => [k, v.n]))));

  // values, errors, provenance, limits and estimates of EVERY planet against the buildTable row
  const SKIP = new Set(['name', 'host', 'transit', 'drift']);
  let worstV = 0, worstE = 0, worstEst = 0, nV = 0, bad = [];
  const cmpRow = (p) => {
    const r = rowOf.get(p.name), errs = [];
    if (p.host !== r.host || p.cats.join() !== r.cats.join() || p.transit !== !!r.v.transit) errs.push('identity');
    const keys = Object.keys(r.v).filter((k) => !SKIP.has(k) && !r.est[k] && (FIELDS[k].kind === 'num' ? fin(r.v[k]) : r.v[k] !== ''));
    if (keys.slice().sort().join() !== Object.keys(p.values).sort().join()) errs.push('fields');
    for (const k of keys) {
      nV++;
      if (FIELDS[k].kind === 'str') { if (p.values[k] !== r.v[k]) errs.push(k); }
      else if (k === 'per' || k === 'tmid') { if (p.values[k] !== r.v[k]) errs.push(k + ' not exact'); }
      else { const d = Math.abs(p.values[k] - r.v[k]) / Math.max(Math.abs(r.v[k]), 1e-300); if (r.v[k] !== 0 && d > worstV) worstV = d; if (!close(p.values[k], r.v[k], 1e-11)) errs.push(k); }
      const e = r.e[k], pe = p.errors[k];
      if (!!e !== !!pe) { if (!(e && e[0] === 0 && e[1] === 0)) errs.push(k + ' error missing'); }
      else if (e) for (const j of [0, 1]) { if (k === 'per' || k === 'tmid' ? pe[j] !== e[j] : !close(pe[j], e[j], 1e-9)) errs.push(k + ' error'); else if (e[j]) worstE = Math.max(worstE, Math.abs(pe[j] - e[j]) / Math.abs(e[j])); }
      if (p.src[k] !== r.src[k]) errs.push(k + ' src');
      if ((p.ref[k] || '') !== (r.ref[k] || '')) errs.push(k + ' ref');
      if ((p.refUrl[k] || '') !== ((r.recs[r.src[k]] && r.recs[r.src[k]].refUrl[k]) || '')) errs.push(k + ' refUrl');
    }
    if (Object.keys(p.lim).sort().join() !== Object.keys(r.lim).sort().join() || Object.keys(p.lim).some((k) => !close(p.lim[k].value, r.lim[k].value, 1e-11) || p.lim[k].sign !== r.lim[k].sign || p.lim[k].src !== r.lim[k].src)) errs.push('limits');
    if (Object.keys(p.est).sort().join() !== Object.keys(r.est).sort().join()) errs.push('estimate keys');
    else for (const k of Object.keys(r.est)) {
      const a = p.est[k], b = r.est[k];
      if (!close(a.value, b.value, 1e-8) || a.rel !== b.rel || a.from.join() !== b.from.join() || a.note !== b.note || a.chain !== b.chain || a.relation !== RELATIONS[b.rel].name || a.cite !== RELATIONS[b.rel].cite || k in p.values) errs.push('estimate ' + k);
      else if (b.value) worstEst = Math.max(worstEst, Math.abs(a.value - b.value) / Math.abs(b.value));
    }
    if (errs.length) bad.push(`${p.name}: ${errs.slice(0, 4).join(', ')}`);
  };
  for (const p of all) cmpRow(p);
  check('every planet: values, errors, source, reference, limits and estimates equal the buildTable row', bad.length === 0 && nV === cnt.values,
    bad.length ? `${bad.length} differ: ${bad.slice(0, 5).join('; ')}` : `${nV} values of ${all.length} planets; periods and T_mid exact, others within ${worstV.toExponential(1)}, errors ${worstE.toExponential(1)}, estimates ${worstEst.toExponential(1)} (relative)`);

  // priors against the live code
  const systems = new Map();
  const livePriors = async (p) => {
    const r = rowOf.get(p.name);
    if (r.recs.nea) {
      const e = index.exact.get(r.recs.nea.name), use = e.transit ? 'transit' : e.rv ? 'rv' : 'all', key = e.hostIndex + use;
      if (!systems.has(key)) systems.set(key, systemFromRows((await lookupHost(index, r.recs.nea.name, fetchCat)).rows, { use }));
      const pl = systems.get(key).planets.find((x) => x.planet === r.recs.nea.name);
      return { basis: use, priors: pl.priors, reference: pl.reference.label, referenceUrl: pl.reference.url, star: pl.reference.stellar || '', starUrl: pl.reference.stellarUrl || '' };
    }
    const values = {};
    for (const k of ['per', 'tmid', 'rprs', 'ars', 'inc', 'b', 't14', 'ecc', 'omega', 'K', 'mplanet', 'teff', 'logg', 'feh', 'rstar', 'mstar']) {
      const f = k === 'mplanet' ? 'mass' : k;
      if (fin(r.v[f])) values[k] = { value: r.v[f], err: r.e[f] ? (r.e[f][0] + r.e[f][1]) / 2 : null, kind: r.est[f] ? 'derived' : 'other' };
    }
    return { basis: 'merged', priors: suggestPriors(values), reference: '', referenceUrl: '', star: '', starUrl: '' };
  };
  let worstP = 0; const dropped = [];
  const cmpPriors = async (p) => {
    const live = await livePriors(p), errs = [];
    // the build drops a prior no sampler can use (uniform with min >= max, normal with zero width) and lists it in the manifest
    for (const [k, q] of Object.entries(live.priors)) if (q.type === 'uniform' ? !(q.a < q.b) : !(q.b > 0)) { dropped.push(`${p.name} ${k}`); delete live.priors[k]; }
    if (Object.keys(live.priors).sort().join() !== Object.keys(p.priors).sort().join()) errs.push('keys');
    else for (const [k, q] of Object.entries(live.priors)) {
      const s = p.priors[k], tol = k === 'tmid' ? 1e-15 : k === 'per' ? 1e-14 : 1e-8;
      if (s.type !== q.type || s.why !== q.why || !close(s.a, q.a, tol) || !close(s.b, q.b, tol)) errs.push(k);
      else for (const j of ['a', 'b']) if (q[j]) worstP = Math.max(worstP, Math.abs(s[j] - q[j]) / Math.abs(q[j]));
    }
    const f = p.priorsFrom || { basis: live.basis, reference: '', referenceUrl: '', star: '', starUrl: '' };
    if (Object.keys(live.priors).length && (f.basis !== live.basis || f.reference !== live.reference || f.referenceUrl !== live.referenceUrl || f.star !== live.star || f.starUrl !== live.starUrl)) errs.push('basis or reference');
    return errs;
  };
  const euOnly = all.find((p) => p.cats.join() === 'eu' && p.transit && Object.keys(p.est).length > 2 && p.priors.rprs && p.priors.per);
  const rvOnly = all.find((p) => p.priorsFrom && p.priorsFrom.basis === 'rv'), imaged = all.find((p) => p.priorsFrom && p.priorsFrom.basis === 'all');
  const withEst = all.find((p) => p.cats.includes('nea') && p.est.K && p.est.mass);
  const named = ['HAT-P-32 b', 'WASP-12 b', 'HD 80606 b', 'TRAPPIST-1 e', '55 Cnc e', euOnly.name, rvOnly.name, imaged.name, withEst.name];
  for (const name of named) {
    const p = C.get(name), errs = p ? await cmpPriors(p) : ['not in the catalogue'];
    const pr = p && p.priors, f = p && p.priorsFrom;
    check(`priors of ${name} equal the live ${f && f.basis === 'merged' ? 'suggestPriors on the merged row' : 'systemFromRows'}`, errs.length === 0,
      errs.length ? errs.join(', ') : `${f.basis}${f.reference ? ', ' + f.reference : ''}${f.star && f.star !== f.reference ? ', star ' + f.star : ''}: ${Object.keys(pr).length} priors` + (pr.rprs ? `, Rp/R* U(${pr.rprs.a}, ${pr.rprs.b})` : '') + (pr.per ? `, P N(${pr.per.a}, ${pr.per.b})` : ''));
  }
  {
    const h = C.get('HAT-P-32 b');
    check('HAT-P-32 b: a transiting planet in both catalogues, period near 2.15 d, priors bracket the values', h.cats.join() === 'nea,eu' && h.transit && Math.abs(h.values.per - 2.15) < 0.001 && h.src.per === 'nea' && !!h.ref.per && h.errors.per[0] > 0 &&
      h.priors.rprs.type === 'uniform' && h.priors.rprs.a < h.values.rprs && h.values.rprs < h.priors.rprs.b && h.priors.per.type === 'normal' && Math.abs(h.priors.per.a - h.values.per) < 1e-4 && h.priorsFrom.basis === 'transit' && /^https:\/\/ui\.adsabs/.test(h.priorsFrom.referenceUrl),
      `P = ${h.values.per} d (${h.ref.per}); priors from ${h.priorsFrom.reference}`);
    const e = C.get(euOnly.name), kinds = Object.values(e.priors).map((q) => (/\(value is (\w+)\)$/.exec(q.why) || [])[1]);
    check('exoplanet.eu-only planet: every prior says whether its value is a catalogue value or an estimate', kinds.every((k) => k === 'other' || k === 'derived') && Object.entries(e.priors).every(([k, q]) => /derived\)$/.test(q.why) === !!e.est[k === 'mplanet' ? 'mass' : k]),
      `${e.name}: ${kinds.filter((k) => k === 'other').length} on catalogue values, ${kinds.filter((k) => k === 'derived').length} on estimates (${Object.keys(e.est).join(', ')})`);
    check('lookup by a typed name and by the other catalogue\'s name', C.get('wasp12b').name === 'WASP-12 b' && C.get('WASP-12 Ab').name === 'WASP-12 b' && C.get('  hd80606 B ').name === 'HD 80606 b' && C.get('no such planet') === null);
  }
  // a spread of 400 more, every 21st planet
  const t1 = performance.now(), sample = all.filter((_, i) => i % 21 === 7), wrong = [];
  for (const p of sample) { const errs = await cmpPriors(p); if (errs.length) wrong.push(`${p.name}: ${errs.join(', ')}`); }
  check(`priors of ${sample.length} more planets (every 21st) equal the live code`, wrong.length === 0, wrong.length ? `${wrong.length} differ: ${wrong.slice(0, 5).join('; ')}` : `largest relative difference ${worstP.toExponential(1)} (rounding); ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  check('every stored prior is finite, of a known type and usable', all.every((p) => Object.values(p.priors).every((q) => fin(q.a) && fin(q.b) && (q.type === 'uniform' ? q.a < q.b : q.type === 'normal' && q.b > 0) && q.why)));
  {
    // the ones the build dropped (manifest entries read "<planet> <key> <type>(a, b)"): recompute each of those planets
    const un = man.oddities.unusablePriors, before = dropped.length, listed = un.first.map((s) => /^(.*) (\w+) (?:uniform|normal)\(/.exec(s)).map((m) => [m[1], m[2]]);
    for (const name of new Set(listed.map((x) => x[0]))) { const p = all.find((x) => x.name === name); if (p) await cmpPriors(p); }
    const mine = new Set(dropped.slice(before)), theirs = new Set(listed.map((x) => x.join(' ')));
    check('unusable priors listed in the manifest are the ones the live code returns, and are absent from the file', un.n === un.first.length && mine.size === theirs.size && [...theirs].every((x) => mine.has(x)) &&
      listed.every(([name, k]) => !(k in C.get(name).priors)) && dropped.every((x) => theirs.has(x)), `${un.n}: ${un.first.join('; ')}`);
  }
  console.log(`info   read ${C.size} planets in ${tRead.toFixed(1)} ms; expanding all of them ${(() => { const t = performance.now(); for (const _ of C.all()); return (performance.now() - t).toFixed(0); })()} ms; JSON.parse ${(() => { const t = performance.now(); JSON.parse(raw); return (performance.now() - t).toFixed(0); })()} ms`);
}
process.exit(ok ? 0 : 1);
