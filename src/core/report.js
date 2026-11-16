// The project report: one Markdown document, always in the same order, that gathers an observing project from the
// target to the result. It wraps markdownReportFor (system, data, fit set-up, result, reproduction) with what the
// session alone does not hold: the observing project (target, site, the night and event), the image reduction, the
// runs compared, a methods paragraph with its references, and the figures written next to it. No DOM; pure.
import { markdownReportFor, formatValue } from './exportScript.js';
import { methodsParagraph } from './methodsText.js';

export const REPORT_SECTIONS = ['Summary', 'Target and observation', 'Data reduction', 'System', 'Data', 'Fit set-up', 'Result', 'Model comparison', 'Methods', 'Figures', 'How to reproduce', 'References'];

const pm = (q) => { if (!q) return '–'; const f = formatValue(q.median, q.plus, q.minus); return !(q.plus > 0 || q.minus > 0) ? f.value : f.plus === f.minus ? `${f.value} ± ${f.plus}` : `${f.value} +${f.plus} −${f.minus}`; };
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |')].join('\n');
const n = (x, p = 7) => (Number.isFinite(Number(x)) ? String(Number(Number(x).toPrecision(p))) : '–');

/**
 * @param session   esl-session document, with `result` when a fit was run
 * @param opts {
 *   project:   the site's observing project record (src/site/project.js) or null
 *   reduction: { name, frames, method, aperture_px, annulus_px, comparison, scatter, time_system, software, fwhm_px } or null
 *   runs:      [{ id, label, name, logZ, err, converged, chi2, n, k }] runs on the same data, the reference first or not
 *   verdict:   the analyzer's own reading of the comparison (a sentence), optional
 *   figures:   [file names] written with the report (PNG), optional
 *   files:     [file names] written with the report (session, BibTeX, ...), optional
 *   title, author, date (ISO) }
 * @returns { markdown, bibtex, keys, notes }
 */
export function projectReport(session, opts = {}) {
  const s = session || {}, res = s.result || null, pj = opts.project || null, red = opts.reduction || null, out = [];
  const title = opts.title || (pj && (pj.title || (pj.target && pj.target.name))) || s.title || s.name || 'Analysis';
  const meth = methodsParagraph(s, opts.methods || {});
  out.push(`# ${title}`, '');
  out.push([opts.author ? `Prepared by ${opts.author}` : '', `report written ${opts.date || new Date().toISOString().slice(0, 10)}`, 'Exoplanet Science Lab'].filter(Boolean).join(' · '), '');

  // ---- 1. summary: the numbers a reader looks for first
  out.push('## Summary', '');
  if (res) {
    const P = Object.fromEntries((res.parameters || []).map((p) => [p.key, p])), D = res.derived || {};
    const pick = [['Rp/R★', P.rprs || D.rprs], ['Mid-transit time', P.tmid], ['Period [d]', P.per || D.per], ['Inclination [°]', P.inc || D.inc], ['Planet radius [R Jup]', D.rpJup], ['Planet mass [M Jup]', P.mplanet || D.mplanet], ['Equilibrium temperature [K]', D.teq], ['Impact parameter', D.b], ['Transit duration T14 [d]', D.t14]].filter(([, q]) => q);
    out.push(pick.length ? table(['Quantity', 'Median and 68% interval'], pick.map(([k, q]) => [k, pm(q)])) : 'The fit has no headline parameters.', '');
    out.push(`${res.converged ? 'The fit converged' : '**The fit did not converge** (' + (res.stop_reason || 'stopped') + ')'}; ln Z = ${n(res.logZ, 6)} ± ${n(res.logZerr, 2)}${Number.isFinite(res.chi2) ? `, χ² = ${n(res.chi2, 6)} for ${res.n_data} measurements` : ''}.`, '');
  } else out.push('No fit has been run yet: the sections below describe the set-up only.', '');

  // ---- 2. the observing project
  out.push('## Target and observation', '');
  if (pj) {
    const t = pj.target || {}, site = pj.site || {}, ev = pj.event || {}, rows = [];
    if (t.name) rows.push(['Target', t.name + (t.host && t.host !== t.name ? ` (host ${t.host})` : '')]);
    if (Number.isFinite(t.ra)) rows.push(['Position (J2000)', `RA ${n(t.ra, 8)}°, Dec ${n(t.dec, 8)}°`]);
    if (Number.isFinite(t.per)) rows.push(['Ephemeris used to plan', `P = ${n(t.per, 9)} d${Number.isFinite(t.tmid) ? `, T0 = ${n(t.tmid, 12)} BJD_TDB` : ''}${t.source ? ` (${t.source})` : ''}`]);
    if (site.name || Number.isFinite(site.lat)) rows.push(['Site', `${site.name || ''}${Number.isFinite(site.lat) ? ` (${n(site.lat, 6)}° N, ${n(site.lon, 7)}° E${Number.isFinite(site.elev) ? `, ${n(site.elev, 5)} m` : ''})` : ''}`.trim()]);
    if (ev.night || ev.mid) rows.push(['Event', `${ev.kind || 'transit'}${ev.night ? ` on the night of ${ev.night}` : ''}${ev.ingress && ev.egress ? `, ${ev.ingress} to ${ev.egress} UTC` : ''}${Number.isFinite(ev.mid) ? `, predicted mid ${n(ev.mid, 12)} BJD_TDB` : ''}${Number.isFinite(ev.sigma_min) ? ` ± ${n(ev.sigma_min, 3)} min` : ''}`]);
    const done = Object.keys(pj.done || {}); if (done.length) rows.push(['Steps marked done', done.join(', ')]);
    out.push(rows.length ? table(['', ''], rows) : 'The observing project has no target or site yet.', '');
    if (pj.notes) out.push(pj.notes, '');
  } else out.push('No observing project was kept for this analysis (the Project checklist in the site bar records the target, site and night).', '');

  // ---- 3. reduction
  out.push('## Data reduction', '');
  if (red) {
    const rows = [['Frames', red.frames], ['Photometry', red.method], ['Aperture radius [px]', red.aperture_px != null ? n(red.aperture_px, 4) : null], ['Sky annulus width [px]', red.annulus_px != null ? n(red.annulus_px, 4) : null], ['Comparison stars', red.comparison], ['Residual scatter', Number.isFinite(red.scatter) ? `${n(100 * red.scatter, 3)}%` : null], ['Median FWHM [px]', red.fwhm_px != null ? n(red.fwhm_px, 3) : null], ['Time system', red.time_system], ['Reduced with', red.software]].filter(([, v]) => v !== null && v !== undefined && v !== '');
    out.push(`${red.name ? `**${red.name}.** ` : ''}The light curve was made from the images on the Photometry page: every combination of aperture, sky annulus and comparison star was tried and the one with the least scatter about a transit fit kept.`, '', table(['', ''], rows), '');
  } else out.push('The light curve was not reduced on this site\'s Photometry page in this browser (or its record was not kept): state how it was made.', '');

  // ---- 4-7. the analysis, from the session (its own title and software line dropped)
  const body = markdownReportFor(s, { sessionFile: opts.sessionFile || 'session.json' }).split('\n'), firstH2 = body.findIndex((l) => /^## /.test(l));
  const analysis = body.slice(firstH2 < 0 ? 0 : firstH2), howIdx = analysis.findIndex((l) => /^## How to reproduce/.test(l));
  out.push(...(howIdx < 0 ? analysis : analysis.slice(0, howIdx)));

  // ---- 8. comparison of runs
  out.push('## Model comparison', '');
  const runs = (opts.runs || []).filter((r) => Number.isFinite(r.logZ));
  if (runs.length >= 2) {
    const best = runs.reduce((a, b) => (b.converged && b.logZ > a.logZ ? b : a), runs[0]);
    out.push(table(['Run', 'Free parameters', 'ln Z', 'Δ ln Z', 'χ²', 'Converged'], runs.map((r) => [`#${r.id}${r.label ? ' ' + r.label : ''}`, r.name || (r.free || []).join(', '), `${n(r.logZ, 6)} ± ${n(r.err, 2)}`, r === best ? 'reference' : n(r.logZ - best.logZ, 3), Number.isFinite(r.chi2) ? n(r.chi2, 6) : '–', r.converged ? 'yes' : 'no'])), '');
    out.push(opts.verdict || 'Δ ln Z is the log Bayes factor against the best run. A difference smaller than about 1, or than twice its error, does not choose between models: keep the simpler one.', '');
  } else out.push('Only one model was fitted. Comparing alternatives on the same data (circular against eccentric, with and without a trend) shows whether the data prefer either.', '');

  // ---- 9. methods paragraph
  out.push('## Methods', '', meth.text.replace(/\[([A-Za-z0-9_,\s]+)\]/g, (m, k) => { const ks = k.split(/,\s*/); return ks.every((x) => meth.keys.includes(x)) ? `[${ks.map((x) => '@' + x).join('; ')}]` : m; }), '');   // only real citation keys: units like [d] stay
  if (meth.notes.length) out.push('To state or check before publishing:', '', ...meth.notes.map((x) => '- ' + x), '');

  // ---- 10. figures
  out.push('## Figures', '');
  out.push((opts.figures || []).length ? opts.figures.map((f, i) => `![Figure ${i + 1}: ${f.replace(/\.png$/i, '').replace(/[_-]+/g, ' ')}](${f})`).join('\n\n') : 'No figures were written with this report.', '');

  // ---- 11-12. reproduction and references
  if (howIdx >= 0) out.push(...analysis.slice(howIdx));
  if ((opts.files || []).length) out.push('Files written with this report: ' + opts.files.map((f) => '`' + f + '`').join(', ') + '.', '');
  out.push('## References', '', `The BibTeX of the ${meth.keys.length} works cited above is in the accompanying .bib file: ${meth.keys.map((k) => '@' + k).join(', ')}.`, '');
  return { markdown: out.join('\n'), bibtex: meth.bibtex, keys: meth.keys, notes: meth.notes };
}
