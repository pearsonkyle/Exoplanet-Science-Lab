// Generates the reference pages of the documentation site from the code itself, so they cannot drift:
//   docs/reference/core/<module>.md   every exported function and constant of src/core with its doc comment
//   docs/reference/core/index.md      the list of modules with their header comment
//   docs/reference/browser-api.md     window.__esl.api from the API_DOC table of src/ui/api.js (with the live playground)
//   docs/reference/mcp-tools.md       every assistant / MCP tool from TOOL_SPECS of src/assistant/toolspec.js (with Try it)
// Run: node tools/docs/gen_reference.mjs   (npm run docs:gen runs it with the Python generator)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'reference');
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');   // braces: markdown-it-attrs would read { ... } as attributes
const code = (s) => '`' + String(s).replace(/`/g, '') + '`';

// ---- JavaScript core ------------------------------------------------------------------------------------------
/** The doc comment (/** ... *\/) or run of // lines just above `idx`, as plain text. */
function commentBefore(src, idx) {
  const before = src.slice(0, idx).replace(/\s+$/, '');
  if (before.endsWith('*/')) {
    const a = before.lastIndexOf('/**'); if (a < 0) return '';
    return before.slice(a + 3, -2).split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
  }
  const lines = before.split('\n'), out = [];
  for (let i = lines.length - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) out.unshift(lines[i].replace(/^\s*\/\/ ?/, ''));
  return out.join('\n').trim();
}
/** The header comment of a module: its leading // lines. */
const header = (src) => { const out = []; for (const l of src.split('\n')) { if (/^\s*\/\//.test(l)) out.push(l.replace(/^\s*\/\/ ?/, '')); else if (l.trim() === '' && !out.length) continue; else break; } return out.join('\n').trim(); };
/** Turn a doc comment into Markdown: @param / @returns lines become a list, the rest stays prose (in a code block when it is ASCII art). */
function docMd(c) {
  if (!c) return '_No description in the source._\n';
  const lines = c.split('\n'), prose = [], tags = [];
  for (const l of lines) { const m = /^@(param|returns?|throws)\s+(.*)$/.exec(l.trim()); if (m) tags.push([m[1], m[2]]); else if (tags.length && /^\s{2,}\S/.test(l)) tags[tags.length - 1][1] += ' ' + l.trim(); else prose.push(l); }
  let out = '';
  const p = prose.join('\n').trim();
  if (p) out += /\n\s{2,}\S/.test(p) || /[=]{1}\s|->|\s{3,}/.test(p) ? '```text\n' + p + '\n```\n' : esc(p) + '\n';
  if (tags.length) out += '\n' + tags.map(([k, v]) => `- **${k === 'param' ? 'param' : k === 'throws' ? 'throws' : 'returns'}** ${esc(v)}`).join('\n') + '\n';
  return out;
}
function coreModules() {
  const dir = join(ROOT, 'src', 'core'), files = [];
  const walk = (d, rel) => { for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name), rel + f.name + '/'); else if (f.name.endsWith('.js')) files.push(rel + f.name); } };
  walk(dir, '');
  rmSync(join(OUT, 'core'), { recursive: true, force: true }); mkdirSync(join(OUT, 'core'), { recursive: true });
  const index = [];
  for (const f of files.sort()) {
    const src = readFileSync(join(dir, f), 'utf8'), name = f.replace(/\.js$/, ''), slug = name.replace(/\//g, '-');
    const items = [];
    for (const m of src.matchAll(/^export\s+(async\s+)?(function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/gm)) {
      const sig = m[2].startsWith('function') ? `${m[1] || ''}${m[3]}${m[4] || '()'}` : m[3];
      items.push({ name: m[3], kind: m[2].startsWith('function') ? 'function' : m[2], sig, doc: commentBefore(src, m.index) });
    }
    const named = [...src.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
    const head = header(src);
    let md = `---\noutline: [2, 3]\n---\n# ${code('src/core/' + f)}\n\n${head ? docMd(head) + '\n' : ''}`;
    md += `Import: ${code(`import { … } from './src/core/${f}'`)} — no DOM, runs in Node and the browser.\n\n`;
    for (const it of items) md += `## ${it.name}\n\n\`\`\`js\n${it.kind === 'function' ? 'function ' : it.kind + ' '}${it.sig}\n\`\`\`\n\n${docMd(it.doc)}\n`;
    if (named.length) md += `## Also exported\n\n${named.map(code).join(', ')}\n`;
    // the source comments are plain text: keep Vue from reading them as a template
    md = md.replace(/^(# .*\n)/m, '$1\n::: v-pre\n') + '\n:::\n';
    writeFileSync(join(OUT, 'core', slug + '.md'), md);
    index.push({ f, slug, first: (head.split(/(?<=\.)\s/)[0] || '').replace(/\n/g, ' '), n: items.length + named.length });
  }
  writeFileSync(join(OUT, 'core', 'index.md'), `# JavaScript core\n\nThe science code of the site (\`src/core\`): plain ES modules with no DOM, the same files the web pages, the Python package and the MCP server run. Every model is tested in \`test/\` against an independent reference before anything is built on it.\n\n| Module | Exports | What it is |\n| --- | --- | --- |\n${index.map((x) => `| [${code(x.f)}](./${x.slug}) | ${x.n} | ${esc(x.first)} |`).join('\n')}\n`);
  return index;
}

// ---- schemas as readable tables ----------------------------------------------------------------------------------
function schemaRows(props = {}, required = [], prefix = '') {
  const rows = [];
  for (const [k, s] of Object.entries(props || {})) {
    const t = s.enum ? s.enum.map((v) => code(JSON.stringify(v))).join(' · ') : s.type === 'array' ? `array of ${s.items && s.items.type ? s.items.type : 'values'}` : s.anyOf ? s.anyOf.map((x) => x.type || 'value').join(' or ') : s.type || 'value';
    rows.push(`| ${code(prefix + k)}${required.includes(k) ? ' **required**' : ''} | ${t} | ${esc(s.description || '')} |`);
    if (s.type === 'object' && s.properties) rows.push(...schemaRows(s.properties, s.required || [], prefix + k + '.'));
  }
  return rows;
}
const table = (props, req) => { const r = schemaRows(props, req); return r.length ? `| Argument | Type | Description |\n| --- | --- | --- |\n${r.join('\n')}\n` : '_No arguments._\n'; };
/** A minimal example argument object: required fields filled with a placeholder of the right type. */
function example(schema) {
  const out = {};
  for (const k of schema.required || []) { const s = schema.properties[k] || {}; out[k] = s.enum ? s.enum[0] : s.type === 'number' || s.type === 'integer' ? 0 : s.type === 'boolean' ? true : s.type === 'array' ? [] : s.type === 'object' ? {} : ''; }
  return out;
}

// ---- browser API ----------------------------------------------------------------------------------------------------
async function browserApi() {
  const { API_DOC } = await import(join(ROOT, 'src', 'ui', 'api.js'));
  let md = `---\noutline: [2, 2]\n---\n# Browser API: \`window.__esl.api\`\n\nThe analyzer page exposes everything its panels do as plain functions on \`window.__esl.api\`. The headless checks, the assistant and your own scripts use the same surface. Every call that changes something is one undo step; a call that cannot do what was asked throws an Error that says why.\n\nTimes are days relative to \`state().lightCurve.timeReference\`; where a call takes a time, a value above 100000 is read as a Julian date (BJD) and converted.\n\n## Try it\n\nThe analyzer runs below, from this site. Write JavaScript against \`api\` and press **Run**; \`return\` a value to see it. Nothing leaves your browser.\n\n<ApiPlayground />\n\n`;
  for (const [name, [desc, args, returns]] of Object.entries(API_DOC)) {
    const props = Object.fromEntries(args.map(([n, s]) => [n, s])), req = args.filter((a) => a[2]).map((a) => a[0]);
    md += `## ${name}\n\n\`\`\`js\napi.${name}(${args.map(([n, , r]) => (r ? n : n + '?')).join(', ')})  // → ${returns}\n\`\`\`\n\n${esc(desc)}\n\n${args.length ? table(props, req) : ''}\n`;
  }
  writeFileSync(join(OUT, 'browser-api.md'), md);
  return Object.keys(API_DOC).length;
}

// ---- MCP / assistant tools -------------------------------------------------------------------------------------------
async function mcpTools() {
  const { TOOL_SPECS } = await import(join(ROOT, 'src', 'assistant', 'toolspec.js'));
  const groups = {};
  for (const t of TOOL_SPECS) (groups[t.group || 'other'] = groups[t.group || 'other'] || []).push(t);
  const first = (d) => esc(String(d || '').split(/(?<=\.)\s/)[0]);
  const args = (t) => { const p = t.parameters.properties || {}, req = t.parameters.required || []; const names = Object.keys(p); return names.length ? names.map((n) => (req.includes(n) ? `**${n}**` : n)).join(', ') : '—'; };
  const where = (t) => (t.where === 'browser' ? 'page' : t.where === 'mcp' ? 'MCP' : 'both');
  let md = `---\noutline: [2, 2]\n---\n# MCP and assistant tools\n\nThe tools the MCP server and the in-page assistant share (generated from \`src/assistant/toolspec.js\`). Arguments in **bold** are required; ✎ marks tools that change something. *Where*: both, the page only (they need the open page), or the MCP server only. How to connect a client: [MCP server](../guide/mcp).\n\n`;
  for (const [g, list] of Object.entries(groups)) {
    md += `## ${g[0].toUpperCase() + g.slice(1)}\n\n| Tool | What it does | Arguments | Where |\n| --- | --- | --- | --- |\n`;
    for (const t of list) md += `| \`${t.name}\`${t.readOnly ? '' : ' ✎'} | ${first(t.description)} | ${args(t)} | ${where(t)} |\n`;
    md += '\n';
  }
  md += `Each tool's full description and argument schema is what an MCP client receives from \`tools/list\`.\n`;
  writeFileSync(join(OUT, 'mcp-tools.md'), md);
  return TOOL_SPECS.length;
}

// ---- worked examples ---------------------------------------------------------------------------------------------
async function examples() {
  const { EXAMPLES } = await import(join(ROOT, 'src', 'ui', 'examples.js'));
  const { EXAMPLES: PROV } = await import(join(ROOT, 'src', 'methods', 'content.js'));
  const { EXPLAIN } = await import(join(ROOT, 'src', 'learn', 'explain.js'));
  const prov = Object.fromEntries(PROV.map((e) => [e.id, e]));
  let md = `# Worked examples\n\nOpen any of these from **Analyze → Start**, or with \`api.loadExample(id)\` ([Browser API](../reference/browser-api)) or \`load_example\` ([MCP tools](../reference/mcp-tools)). Each opens with a stored posterior (press Run to sample it again) and a card saying what to look at. Examples marked *simulated* use generated data; the others are real observations, with their source and licence below.\n\n`;
  for (const e of EXAMPLES) {
    const p = prov[e.id] || {}, x = EXPLAIN[e.id] || {};
    md += `## ${esc(e.title)}\n\n\`${e.id}\` · ${(e.kinds || []).join(', ')} · ${esc(e.sub || '')}\n\n${x.see ? esc(x.see) + '\n\n' : ''}${p.data ? `**Data.** ${esc(p.data)}\n\n` : ''}${p.licence ? `**Licence.** ${esc(p.licence)}\n\n` : ''}${p.verdict ? `**Checked.** ${esc(p.verdict)}${p.command ? ` (\`${p.command}\`)` : ''}.\n\n` : ''}`;
  }
  writeFileSync(join(ROOT, 'docs', 'guide', 'examples.md'), md);
  return EXAMPLES.length;
}

mkdirSync(OUT, { recursive: true });
const nEx = await examples();
const mods = coreModules(), nApi = await browserApi(), nTools = await mcpTools();
console.log(`docs: ${mods.length} core modules, ${nApi} browser API functions, ${nTools} tools, ${nEx} examples`);
