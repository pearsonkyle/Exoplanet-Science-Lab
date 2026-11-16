// Reader for the ESL catalogue, public/esl-catalog/catalog.json: the NASA Exoplanet Archive and exoplanet.eu merged
// into one row per planet, with gap-filled estimates and suggested priors, built offline by
// tools/build_esl_catalog.py (which runs buildTable, systemFromRows and suggestPriors and packs what they return).
// No DOM and no imports: this file and catalog.json are all a page or a notebook needs.
//
//   const cat = readEslCatalog(JSON.parse(text));
//   const p = cat.get('hat-p-32b');
//   p.values.per, p.errors.per ([lower, upper]), p.src.per ('nea'), p.ref.per ('Kokori et al. 2023'), p.refUrl.per
//   p.est.K        { value, rel: 'rvk', relation: 'RV semi-amplitude ...', cite, from: ['mass', 'mstar', 'per'], note, chain }
//   p.priors.rprs  { type: 'uniform', a, b, why }      p.priors.per  { type: 'normal', a: mean, b: std, why }
//   p.priorsFrom   { basis: 'transit', reference, referenceUrl, star, starUrl }
//
// Units are those of fields.js: days (times are JD as the catalogue gives them, normally BJD_TDB), depth as a
// fraction, Jupiter units for the planet, solar units for the star, a in au, degrees, m/s, K, pc.
//
// File layout (format 'esl-catalog', v 1). Everything repeated is a table at the top; a planet holds indices.
//   snapshots   { nea, eu, ps }: the date each source snapshot was taken.   credits: licence and acknowledgement per source.
//   sources     ['nea', 'eu', 'toi']        fields  [[key, 'n' | 's', unit, description], ...]
//   refs        [[label, link], ...]        link is an ADS bibcode (https://ui.adsabs.harvard.edu/abs/<link>/abstract), a full URL or ''
//   prov        [[source index, ref index or -1], ...]       provenance of a value
//   strs        [string, ...]               values of the string fields, and the notes of the estimates
//   relations   [[key, name, citation], ...]                 the relations of src/core/relations.js
//   estInfo     [[relation index, [field indices used], note (index into strs) or -1, chain 0 | 1], ...]
//   priorKeys   ['per', 'tmid', ...]        priorTypes ['uniform', 'normal']        priorWhy [[type index, why], ...]
//   bases       ['transit', 'rv', 'all', 'merged']
//   planets     [{ n: name, h: host, c: bit mask over sources, t: 1 when it transits, a: [names in the other catalogues],
//                  v:  [[prov, field, value, error, field, value, error, ...], ...]   catalogue values grouped by provenance;
//                      error is 0 (none), a number (symmetric) or [lower, upper]; for an 's' field value indexes strs
//                  l:  [field, value, sign, source, ...]            limits (sign as the catalogue flags it: 1 upper, -1 lower)
//                  e:  [field, value, estInfo, ...]                 gap-filled estimates (never a field that is in v)
//                  p:  [priorKey, a, b, priorWhy, ...]              uniform: a = min, b = max; normal: a = mean, b = std
//                  pb: [basis, ref of the chosen reference or -1, ref of the star or -1] }, ...]   sorted by name
//   basis 'transit' | 'rv' | 'all': the priors are systemFromRows(rows, { use: basis }) of src/core/catalog.js on every
//   published reference of the NASA archive, so they are centred on the CHOSEN REFERENCE, which need not be the
//   composite value in `values`. basis 'merged': suggestPriors on the merged row (no per-reference rows exist for a
//   planet only in exoplanet.eu); the `why` then ends in "(value is other)" for a catalogue value or
//   "(value is derived)" for an estimate.

const ADS = 'https://ui.adsabs.harvard.edu/abs/';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Wrap a parsed catalog.json. Returns
 *   { meta: { format, v, about, snapshots, credits }, size, fields: {key: {kind, unit, desc}}, relations: {key: {name, cite}},
 *     names(): [planet names], has(name), get(name) -> planet | null, at(i) -> planet, find(fn) -> planet | null, all() -> iterator }
 * Names are matched exactly first, then ignoring case, spaces and punctuation ("wasp12b"), then against the names
 * the other catalogues use ("WASP-12 Ab").
 * A planet is { name, host, cats: ['nea', 'eu'], transit, aliases, values, errors: {field: [lower, upper]}, src: {field: source id},
 *   ref: {field: label}, refUrl: {field: url}, lim: {field: {value, sign, src}}, est: {field: {value, rel, relation, cite, from, note, chain}},
 *   priors: {key: {type, a, b, why}}, priorsFrom: {basis, reference, referenceUrl, star, starUrl} | null }.
 * `values` holds catalogue values only; the estimates are in `est` (the `v` of a buildTable row is both together).
 */
export function readEslCatalog(json) {
  if (!json || json.format !== 'esl-catalog' || json.v !== 1 || !Array.isArray(json.planets)) throw new Error('ESL catalogue: unknown format');
  const { sources, fields, refs, prov, strs, relations, estInfo, priorKeys, priorTypes, priorWhy, bases, planets } = json;
  const url = (link) => (!link ? '' : /^[a-z]+:\/\//i.test(link) ? link : ADS + link + '/abstract');
  const refOf = (i) => (i >= 0 && refs[i] ? { label: refs[i][0], url: url(refs[i][1]) } : { label: '', url: '' });

  function expand(P) {
    const o = { name: P.n, host: P.h, cats: sources.filter((_, i) => P.c & (1 << i)), transit: !!P.t, aliases: P.a ? P.a.slice() : [],
      values: {}, errors: {}, src: {}, ref: {}, refUrl: {}, lim: {}, est: {}, priors: {}, priorsFrom: null };
    for (const g of P.v || []) {
      const [si, ri] = prov[g[0]], r = refOf(ri);
      for (let i = 1; i < g.length; i += 3) {
        const [key, kind] = fields[g[i]], e = g[i + 2];
        o.values[key] = kind === 's' ? strs[g[i + 1]] : g[i + 1];
        if (e) o.errors[key] = Array.isArray(e) ? [e[0], e[1]] : [e, e];
        if (si >= 0) o.src[key] = sources[si];
        if (r.label) { o.ref[key] = r.label; if (r.url) o.refUrl[key] = r.url; }
      }
    }
    const l = P.l || [], e = P.e || [], p = P.p || [];
    for (let i = 0; i < l.length; i += 4) o.lim[fields[l[i]][0]] = { value: l[i + 1], sign: l[i + 2], src: sources[l[i + 3]] };
    for (let i = 0; i < e.length; i += 3) {
      const [ri, from, note, chain] = estInfo[e[i + 2]], rel = relations[ri];
      o.est[fields[e[i]][0]] = { value: e[i + 1], rel: rel[0], relation: rel[1], cite: rel[2], from: from.map((f) => fields[f][0]), note: note >= 0 ? strs[note] : '', chain: !!chain };
    }
    for (let i = 0; i < p.length; i += 4) { const [ti, why] = priorWhy[p[i + 3]]; o.priors[priorKeys[p[i]]] = { type: priorTypes[ti], a: p[i + 1], b: p[i + 2], why }; }
    if (P.pb) { const r = refOf(P.pb[1]), s = refOf(P.pb[2]); o.priorsFrom = { basis: bases[P.pb[0]], reference: r.label, referenceUrl: r.url, star: s.label, starUrl: s.url }; }
    return o;
  }

  let exact = null, loose = null;
  const lookup = (name) => {
    if (!exact) {
      exact = new Map(); loose = new Map();
      planets.forEach((P, i) => { if (!exact.has(P.n)) exact.set(P.n, i); });
      planets.forEach((P, i) => { const k = norm(P.n); if (k && !loose.has(k)) loose.set(k, i); });
      // names of the other catalogues never shadow a planet's own name
      planets.forEach((P, i) => { for (const a of P.a || []) { const k = norm(a); if (k && !loose.has(k)) loose.set(k, i); } });
    }
    const s = String(name ?? '').trim();
    return exact.get(s) ?? loose.get(norm(s)) ?? -1;
  };

  return {
    meta: { format: json.format, v: json.v, about: json.about || '', snapshots: json.snapshots || {}, credits: json.credits || [] },
    size: planets.length,
    fields: Object.fromEntries(fields.map(([key, kind, unit, desc]) => [key, { kind: kind === 's' ? 'str' : 'num', unit, desc }])),
    relations: Object.fromEntries(relations.map(([key, name, cite]) => [key, { name, cite }])),
    names: () => planets.map((P) => P.n),
    has: (name) => lookup(name) >= 0,
    get: (name) => { const i = lookup(name); return i >= 0 ? expand(planets[i]) : null; },
    at: (i) => (planets[i] ? expand(planets[i]) : null),
    find: (fn) => { for (const P of planets) { const o = expand(P); if (fn(o)) return o; } return null; },
    all: function* () { for (const P of planets) yield expand(P); },
  };
}
