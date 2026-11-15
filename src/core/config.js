// Save and load a fit set-up (parameter values, which are free, and their priors)
// as JSON or YAML. The YAML reader handles the subset this module writes:
// nested maps of scalars by indentation, comments, no lists or flow syntax.

export function configToObject(S, params) {
  const out = { system: S.name, ld_law: S.ldLaw, ld_mode: S.ldMode, parameters: {} };
  for (const p of params) {
    const pr = S.priors[p.key] || {}, e = { value: S.values[p.key] ?? S.star[p.key], fit: !!S.free[p.key], prior: pr.type || 'uniform' };
    if (e.prior === 'normal') { e.mean = pr.a; e.std = pr.b; } else { e.min = pr.a; e.max = pr.b; }
    out.parameters[p.key] = e;
  }
  out.sampler = { live_points: S.sampler.nlive, stop_at_remainder: S.sampler.fracRemain, seed: S.sampler.seed };
  return out;
}

export function toYAML(obj, indent = 0) {
  let s = '';
  for (const [k, v] of Object.entries(obj)) {
    const pad = ' '.repeat(indent);
    if (v && typeof v === 'object') s += `${pad}${k}:\n${toYAML(v, indent + 2)}`;
    else s += `${pad}${k}: ${typeof v === 'string' && /[:#]|^\s|\s$|^$/.test(v) ? JSON.stringify(v) : v}\n`;
  }
  return s;
}

export function parseYAML(text) {
  const root = {}, stack = [{ indent: -1, obj: root }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!m) throw new Error('Cannot read line: ' + raw.trim());
    const indent = m[1].length, key = m[2].trim(); let val = m[3].trim();
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === '') { parent[key] = {}; stack.push({ indent, obj: parent[key] }); continue; }
    if (/^".*"$|^'.*'$/.test(val)) val = val.slice(1, -1);
    else if (val === 'true' || val === 'false') val = val === 'true';
    else if (val === 'null' || val === '~') val = null;
    else if (!Number.isNaN(Number(val))) val = Number(val);
    parent[key] = val;
  }
  return root;
}

/** Accepts JSON or YAML text. Returns the normalised object or throws a readable error. */
export function parseConfig(text) {
  const t = text.trim();
  let o;
  try { o = t.startsWith('{') ? JSON.parse(t) : parseYAML(t); } catch (err) { throw new Error('Not valid JSON or YAML: ' + err.message); }
  if (!o || typeof o.parameters !== 'object') throw new Error('The file has no "parameters" section.');
  const params = {};
  for (const [k, e] of Object.entries(o.parameters)) {
    if (!e || typeof e !== 'object') continue;
    const type = e.prior === 'normal' || (e.mean !== undefined && e.min === undefined) ? 'normal' : 'uniform';
    const prior = type === 'normal' ? { type, a: Number(e.mean), b: Number(e.std ?? e.sigma) } : { type, a: Number(e.min), b: Number(e.max) };
    params[k] = { value: e.value === undefined || e.value === null ? undefined : Number(e.value), fit: !!e.fit, prior: Number.isFinite(prior.a) && Number.isFinite(prior.b) ? prior : null };
  }
  return { system: o.system, ldLaw: o.ld_law, ldMode: o.ld_mode, params, sampler: o.sampler || {} };
}
