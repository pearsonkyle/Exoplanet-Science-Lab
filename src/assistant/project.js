// The project as the assistant knows it, carried from page to page: where the user observes from, the planet, the
// event they planned, the data loaded, the fits made (with their headline numbers), the files produced. It is built
// only from tool results (what the pages returned), kept in the browser's storage (store.js) and put, as a short
// PROJECT block, in front of the live state card of every request, so the model knows where the user is in the
// project on any page without carrying the conversation that got there.
//
// No DOM. updateProject() is pure: it returns a new object.

const MAX_FITS = 6, MAX_FILES = 10;
export function emptyProject() { return { v: 1, updated: 0, pages: [], site: null, nights: null, target: null, candidates: [], planned: null, system: null, data: [], fits: [], files: [], rv: null }; }
const str = (v) => (v === undefined || v === null ? '' : String(v));
const cut = (s, n) => (str(s).length > n ? str(s).slice(0, n - 1) + '…' : str(s));
const keyOf = (name) => str(name).split(' ')[0];
/** The fitted value of a key from a result's "parameters" map (keys like "rprs (Rp/R*, …)"). */
const param = (pars, key) => { if (!pars) return null; const k = Object.keys(pars).find((n) => keyOf(n) === key); return k ? pars[k] : null; };
const row = (t) => t && ({ index: t.index, planet: t.planet, event: t.event, night_of: t.night_of, ingress_utc: t.ingress_utc, mid_utc: t.mid_utc, egress_utc: t.egress_utc, local_times: t.local_times, observable: t.observable, timing_1sigma: t.timing_1sigma, altitude: t.altitude, moon: t.moon, depth_ppt: t.depth_ppt, magnitude: t.magnitude, conditions_of_100: t.conditions_of_100 });

/**
 * The project after one tool call. ev: { page, name, args, data (the tool's result object), ok }.
 * Calls that failed, or that the project does not follow, leave it as it was.
 */
export function updateProject(p0, ev, now = Date.now()) {
  const p = { ...emptyProject(), ...(p0 || {}) }, d = ev && ev.data, name = ev && ev.name;
  if (!ev || !ev.ok || !d || typeof d !== 'object') return p0 || p;
  const next = { ...p, updated: now };
  if (ev.page && next.pages[next.pages.length - 1] !== ev.page) next.pages = [...next.pages, ev.page].slice(-8);
  switch (name) {
    case 'plan_set_site': if (d.site) next.site = cut(d.site, 120); break;
    case 'plan_set_dates': if (d.dates) next.nights = cut(d.dates, 80); break;
    case 'plan_set_target': if (d.target && d.target !== 'all planets') next.target = d.target; break;
    case 'plan_list_transits':
      if (d.site) next.site = cut(d.site, 120); if (d.dates) next.nights = cut(d.dates, 80);
      if (Array.isArray(d.transits)) next.candidates = d.transits.slice(0, 3).map((t) => ({ index: t.index, planet: t.planet, mid_utc: t.mid_utc, observable: t.observable, conditions_of_100: t.conditions_of_100 }));
      break;
    case 'plan_open_transit':
      if (d.transit) { next.planned = { ...row(d.transit), ...(d.mid_bjd_tdb ? { mid_bjd_tdb: d.mid_bjd_tdb } : {}), opened_in: ev.args && ev.args.in }; next.target = d.transit.planet || next.target; }
      break;
    case 'lookup_planet': if (d.loaded) { next.system = { name: d.loaded, period_d: d.period_d }; if (!d.kept_data) { next.simulated_mid = null; next.data = []; } } break;
    case 'load_light_curve': case 'simulate_light_curve': case 'load_example': case 'import_session': case 'open_saved': {
      const lines = [].concat(d.loaded || d.simulated || d.data || []).filter(Boolean).map((x) => cut(x, 160));
      if (lines.length) next.data = [...next.data.filter((x) => !/^light curve/.test(x)), ...lines.filter((x) => /^light curve/.test(x)), ...lines.filter((x) => !/^light curve/.test(x) && !next.data.includes(x))].slice(-4);
      if (d.system && typeof d.system === 'string') next.system = { name: d.system };
      next.simulated_mid = name === 'simulate_light_curve' && d.mid_transit ? d.mid_transit : null;
      break;
    }
    case 'load_radial_velocities': next.rv = { sets: d.all_sets || d.added || null }; break;
    case 'run_fit': {
      if (!d.has_result) break;
      const f = { run: d.run || '', system: (next.system && next.system.name) || '', fitted: cut(d.fitted || '', 160), rprs: param(d.parameters, 'rprs'), tmid: param(d.parameters, 'tmid'), lnZ: d.evidence ? `${d.evidence.lnZ} ± ${d.evidence.error}` : '', converged: d.converged, at: now };
      if (d.mid_transit_bjd) f.tmid_bjd = d.mid_transit_bjd;
      next.fits = [...next.fits, f].slice(-MAX_FITS);
      break;
    }
    case 'run_experiment': if (d.experiment) next.fits = [...next.fits, { run: d.experiment, system: (next.system && next.system.name) || '', verdict: cut((d.comparison || {}).verdict || '', 200), at: now }].slice(-MAX_FITS); break;
    default: break;
  }
  // files the user can download, whichever tool wrote them
  const written = [].concat(d.written || []).map((w) => (typeof w === 'string' ? w : w && w.file)).filter(Boolean).concat(d.report_file ? [d.report_file] : []);
  if (written.length) next.files = [...next.files.filter((f) => !written.includes(f)), ...written].slice(-MAX_FILES);
  if (/^api_/.test(str(name)) && /veloc|radial|_rv/.test(str(name))) next.rv = { from: name, result: cut(JSON.stringify(d), 300) };
  return next;
}

/** The PROJECT block of the prompt: a few short lines, empty when nothing is known yet. caps: what this version can do. */
export function projectCard(p, { caps = null } = {}) {
  const L = [];
  if (p && p.updated) {
    if (p.site || p.nights) L.push(`Observing from: ${p.site || 'not set'}${p.nights ? `; nights: ${p.nights}` : ''}`);
    if (p.target) L.push(`Target: ${p.target}`);
    if (p.planned) { const e = p.planned; L.push(`Planned event (chosen on the plan page): ${e.planet} ${e.event || 'transit'} on the night of ${e.night_of || '?'}: ingress ${e.ingress_utc}, mid ${e.mid_utc}, egress ${e.egress_utc}${e.mid_bjd_tdb ? ` (mid-transit BJD_TDB ${e.mid_bjd_tdb})` : ''}; ${e.observable ? 'observable: ' + e.observable : ''}${e.altitude ? `, altitude ${e.altitude}` : ''}${e.moon ? `, Moon ${e.moon}` : ''}${e.conditions_of_100 ? `, conditions ${e.conditions_of_100}/100` : ''}`); }
    else if (p.candidates && p.candidates.length) L.push(`Candidates listed on the plan page: ${p.candidates.map((c) => `#${c.index} ${c.planet} mid ${c.mid_utc} (${c.observable}${c.conditions_of_100 ? ', ' + c.conditions_of_100 + '/100' : ''})`).join('; ')}`);
    if (p.system) L.push(`System in the analyzer: ${p.system.name}${p.system.period_d ? ` (P = ${p.system.period_d} d)` : ''}`);
    if (p.planned && p.planned.mid_bjd_tdb && p.system) {
      const same = Math.abs(Number(p.simulated_mid) - Number(p.planned.mid_bjd_tdb)) < 1e-3;
      L.push(same ? `The light curve is simulated for the planned night (mid-transit BJD_TDB ${p.simulated_mid}).` : `No light curve of the planned night yet: simulate_light_curve with mid_transit "planned" makes one (what is loaded is not that night).`);
    }
    if (p.data && p.data.length) L.push(`Data: ${p.data.join('; ')}`);
    if (p.rv) L.push(`Radial velocities: ${p.rv.sets ? JSON.stringify(p.rv.sets).slice(0, 160) : p.rv.result || 'loaded'}`);
    for (const f of (p.fits || []).slice(-3)) L.push(f.verdict ? `Experiment ${f.run}: ${f.verdict}` : `Fit ${f.run} of ${f.system || 'the system'}: ${[f.rprs ? `rprs ${f.rprs}` : '', f.tmid ? `tmid ${f.tmid}` : '', f.lnZ ? `ln Z ${f.lnZ}` : ''].filter(Boolean).join(', ')}${f.converged === false ? ' (NOT converged)' : ''}`);
    if (p.files && p.files.length) L.push(`Files produced: ${p.files.join(', ')}`);
    if (p.pages && p.pages.length > 1) L.push(`Pages so far: ${p.pages.join(' → ')}`);
  }
  if (caps) for (const c of caps) L.push(c);
  return L.length ? 'PROJECT (carried across pages; from earlier tool results)\n' + L.map((x) => '- ' + x).join('\n') : '';
}

/**
 * What this version of the site can and cannot do that a request may need, from the tools the pages declare.
 * specs: the tool list of the page the conversation is on (null elsewhere). Returns lines for projectCard.
 */
export function capabilities(specs, page) {
  if (page !== 'analyze' || !Array.isArray(specs)) return [];
  const text = (t) => `${t.name} ${t.description || ''}`;
  const rv = specs.find((t) => /^api_/.test(t.name) && /(archiv|fetch|download|retriev|query|search)/i.test(text(t)) && /(radial|velocit|\brv\b)/i.test(text(t)) && !/^api_add/.test(t.name));
  const rvAdd = specs.find((t) => t !== rv && /^api_add/.test(t.name) && /(radial|velocit|\brv\b)/i.test(text(t)));
  const coach = specs.find((t) => /^api_/.test(t.name) && /(project|coach|guide|next step)/i.test(text(t)));
  const out = [rv ? `Archival radial velocities (only when the user asks for them): ${rv.name} searches the archives for the host star (call it once)${rvAdd ? `; ${rvAdd.name} adds a set it found` : ''}. If it finds no set, tell the user so and stop: change nothing else. With sets added: set_kepler on, choose_data with light_curve and radial_velocity true, free mplanet as well, run_fit.` : 'Archival radial velocities (only when the user asks for them): this version of the analyzer cannot fetch them from an archive (no tool does). If the user asks for them, say so plainly at once and change nothing; offer load_radial_velocities with a file the user attaches.'];
  if (coach) out.push(`Project guide: ${coach.name}.`);
  return out;
}
