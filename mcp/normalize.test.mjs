// The server's own tools take the argument shapes tool-calling models actually send (mcp/normalize.mjs), and
// explain the ones they cannot take. Cases are the failing calls of gemma4-e4b-coder on the ESL v2 evaluation
// (Quant-Tuner, 2026-11-26), and the documented shapes, which must give identical results.
//   node mcp/normalize.test.mjs   (about a minute: a few SED fits and spectra)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeArgs, cleanKey, bandOf, magnitudesOf, atmosphereRequest, pairArg } from './normalize.mjs';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const HERE = dirname(fileURLToPath(import.meta.url));
const throws = (f) => { try { f(); return ''; } catch (e) { return e.message; } };

// ---- unit: the repairs ----------------------------------------------------------------------------------------
check('keys lose quotes and the Gemma string delimiter, also on one side only', cleanKey('<|"|>2MASS_Ks') === '2MASS_Ks' && cleanKey('<|"|>Gaia G<|"|>') === 'Gaia G' && cleanKey('`2MASS J`') === '2MASS J' && cleanKey('"TESS"') === 'TESS' && cleanKey('Gaia G') === 'Gaia G');
const ez = normalizeArgs({ chemistry: { co: {}, mh: 0 } }, { properties: { chemistry: { type: 'object', properties: { co: { type: 'number' }, mh: { type: 'number' } } } } });
check('an empty object where a number is asked for means "not given"', !('co' in ez.chemistry) && ez.chemistry.mh === 0, JSON.stringify(ez));
const nz = normalizeArgs({ model: { planet: { mplanet: '1.19', rplanet: '1.23', pRef: '0.01' } }, R: '50', save_as: '42', world: null },
  { properties: { model: { type: 'object' }, R: { type: 'number' }, save_as: { type: 'string' }, world: { type: 'string' } } });
check('numeric strings become numbers unless the schema asks for a string; null optional fields are left out', nz.model.planet.mplanet === 1.19 && nz.model.planet.pRef === 0.01 && nz.R === 50 && nz.save_as === '42' && !('world' in nz), JSON.stringify(nz));
check('band names: case, _ and - for spaces, a unique suffix (with case: G is Gaia, g is not)', bandOf('2MASS_J').band === '2MASS J' && bandOf('gaia-g').band === 'Gaia G' && bandOf('Ks').band === '2MASS Ks' && bandOf('TESS').band === 'TESS' && bandOf('G').band === 'Gaia G');
check('band names: B and V alone are Johnson\'s; an ambiguous short name names its candidates; an unknown one fails', bandOf('V').band === 'Johnson V' && bandOf('B').band === 'Johnson B' && /could be SDSS g, PS1 g, APASS g: use the full band name/.test(bandOf('g').error) && /no passband "Q"/.test(bandOf('Q').error), bandOf('g').error);
const mo = magnitudesOf({ 'Gaia G': { value: 11.1945, error: 0.003 }, '2MASS Ks': [9.804, 0.018], 'Johnson V': '11.305 ± 0.04' });
check('magnitudes: [m, e], { value, error } and "m ± e" give the same observations', mo.length === 3 && mo[0].mag === 11.1945 && mo[0].err === 0.003 && mo[2].err === 0.04, JSON.stringify(mo));
const ma = magnitudesOf([{ band: 'Gaia G', mag: 11.19, err: 0.003 }, { band: '2MASS J', mag: 10.1, err: 0.02 }, { band: '2MASS Ks', mag: 9.8, err: 0.02 }]);
check('magnitudes: an array of { band, mag, err } is taken too', ma.length === 3 && ma[1].band === '2MASS J');
const amb = throws(() => magnitudesOf({ G: [11.19, 0.003], Ks: [9.8, 0.02], r: [11.3, 0.04] }));
check('magnitudes: short ambiguous names fail with the candidates, the band list and an example call', !/"G" could be/.test(amb) && /"r" could be/.test(amb) && /Example call/.test(amb) && !/Ks/.test(amb.split('Bands:')[0]), amb.slice(0, 200));
const per = magnitudesOf({ 'Gaia G': { G: 14.5134, error: 0.005 }, '2MASS J': { J: '13.1', err: '0.02' }, '2MASS Ks': [12.9, 0.03] });
check('magnitudes: { "<band>": value, "error": e } per band is read as [value, e]', per[0].mag === 14.5134 && per[0].err === 0.005 && per[1].mag === 13.1);
check('magnitudes: fewer than three says how many were accepted', /at least three magnitudes; got 2 \(Gaia G, 2MASS J\)/.test(throws(() => magnitudesOf({ 'Gaia G': [1, 0.1], '2MASS J': [1, 0.1] }))));
const worlds = ['WASP-39 b', 'WASP-121 b, day side', 'Jupiter', 'Titan'];
const pr = atmosphereRequest({ model: { planet: { mplanet: 1.19, rplanet: 1.23, pRef_mbar: 10 } } }, worlds);
check('pRef_mbar is read as millibar', pr.args.model.planet.pRef === 0.01 && !('pRef_mbar' in pr.args.model.planet) && !pr.warnings.length);
const p10 = throws(() => atmosphereRequest({ model: { planet: { mplanet: 1.19, rplanet: 1.23, pRef: 10 } } }, worlds));
check('pRef above 1.5 bar without its unit said is refused, naming both readings', /"pRef_mbar": 10 \(or "pRef": 0.01\)/.test(p10) && /"pRef_bar": 10/.test(p10), p10);
const pb = atmosphereRequest({ model: { planet: { mplanet: 1.19, rplanet: 1.23, pRef_bar: 10 } } }, worlds);
check('pRef_bar says it: taken as given, with the warning', pb.args.model.planet.pRef === 10 && !('pRef_bar' in pb.args.model.planet) && /if this one was given at 10 mbar/.test(pb.warnings[0] || ''));
const ti = atmosphereRequest({ model: { planet: { mplanet: 0.0225, rplanet: 0.0368, pRef: 1.467 } } }, worlds);
check('pRef up to 1.5 bar (Titan\'s surface, 1.467) passes with the warning', ti.args.model.planet.pRef === 1.467 && ti.warnings.length === 1);
check('pRef with pRef_bar that disagrees is refused', /give one/.test(throws(() => atmosphereRequest({ model: { planet: { mplanet: 1, rplanet: 1, pRef: 2, pRef_bar: 10 } } }, worlds))));
check('a prior of zero width is refused: it would fix the value instead of fitting it', /would fix feh at 0 instead of fitting it/.test(throws(() => pairArg('feh', [0, 0], 'dex', [], { prior: true })))
  && pairArg('feh', [0, 0.3], 'dex', [], { prior: true })[1] === 0.3 && pairArg('parallax', [1.2, 0], 'mas', [])[1] === 0);
const wErr = throws(() => atmosphereRequest({ world: 'HATS-77 b' }, worlds));
check('a planet name in world: the error lists the presets and shows how to model the planet', /world only takes a preset/.test(wErr) && /leave world out/.test(wErr) && /"planet": \{"mplanet"/.test(wErr), wErr.slice(0, 120));
check('a preset named with other case is found', atmosphereRequest({ world: 'titan' }, worlds).args.world === 'Titan');
const strP = throws(() => atmosphereRequest({ model: { planet: { mplanet: 'heavy', rplanet: 1.2, pRef: 0.01 } } }, worlds));
check('a planet value that is not a number: the error says which, what it got and the unit', /mplanet must be a positive number in M_Jup; got "heavy"/.test(strP), strP);
const prior = throws(() => atmosphereRequest({ priors: { teq: [1600, 800] } }, worlds, { name: 'atmosphere_retrieve' }));
check('a reversed prior: the error gives the received pair and the likely fix', /got \[1600, 800\]: did you mean \[800, 1600\]/.test(prior), prior);
check('equal prior bounds: the error says how to hold the value instead', /leave it out of free and set it in model/.test(throws(() => atmosphereRequest({ priors: { teq: [1818, 1818] } }, worlds, { name: 'atmosphere_retrieve' }))));
check('priors as { low, high } are taken', atmosphereRequest({ priors: { teq: { low: 800, high: 1600 } } }, worlds, { name: 'atmosphere_retrieve' }).args.priors.teq[1] === 1600);

// ---- through the server -------------------------------------------------------------------------------------
const ws = mkdtempSync(join(tmpdir(), 'esl-mcp-norm-'));
const connect = async (env) => { const c = new Client({ name: 'normalize-test', version: '1' }); await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(HERE, 'server.mjs'), '--workspace', ws], env: { ...process.env, ...env }, stderr: 'ignore' })); return c; };
const typed = await connect({ ESL_MCP_SCHEMA: 'typed' }), client = await connect({ ESL_MCP_SCHEMA: '' });
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const text = r.content[0].text; let data = null; try { data = JSON.parse(text); } catch { /* text */ } return { isError: !!r.isError, text, data }; };

const listed = (await typed.listTools()).tools, star = listed.find((t) => t.name === 'star_fit'), atm = listed.find((t) => t.name === 'atmosphere_spectrum');
check('tools/list with ESL_MCP_SCHEMA=typed: typed schemas (magnitude pairs, the planet\'s numbers, presets as an enum)', star.inputSchema.properties.magnitudes.additionalProperties.items.type === 'number' && atm.inputSchema.properties.model.properties.planet.properties.mplanet.type === 'number' && atm.inputSchema.properties.world.enum.includes('Titan'));
const v1 = (await client.listTools()).tools, v1atm = v1.find((t) => t.name === 'atmosphere_spectrum'), v1star = v1.find((t) => t.name === 'star_fit');
check('tools/list by default: the 0.1.0 schemas, unchanged', v1atm.inputSchema.properties.model.type === 'object' && !v1atm.inputSchema.properties.model.properties && !('planet_name' in v1atm.inputSchema.properties) && !v1star.inputSchema.properties.magnitudes.additionalProperties);
const tf = await typed.callTool({ name: 'star_fit', arguments: { magnitudes: { G: [7.52, 0.003], '2MASS_J': ['6.591', '0.02'], Ks: { value: 6.308, error: 0.026 } }, av_max: 0 } });
check('the repairs work the same with the typed list', !tf.isError, tf.content[0].text.slice(0, 120));
await typed.close();

// HD 209458 as in mcp/test.mjs, documented shape, then the shapes models send
const M = { 'Gaia BP': [7.793284, 0.002848], 'Gaia G': [7.521246, 0.002776], 'Gaia RP': [7.080288, 0.003844], 'Tycho BT': [8.334, 0.017], 'Tycho VT': [7.699, 0.012], '2MASS J': [6.591, 0.02], '2MASS H': [6.366, 0.038], '2MASS Ks': [6.308, 0.026], 'WISE W3': [6.32, 0.016], 'WISE W4': [6.265, 0.053] };
const base = await call('star_fit', { magnitudes: M, parallax: [20.7694, 0.0266], logg: [4.28, 0.1], feh: [0, 0.1], av_max: 0 });
const mangled = Object.fromEntries(Object.entries(M).map(([k, v], i) => [[`<|"|>${k}<|"|>`, `\`${k}\``, k.replace(' ', '_'), k][i % 4], i % 2 ? { value: String(v[0]), error: String(v[1]) } : v.map(String)]));
const fixed = await call('star_fit', { magnitudes: mangled, parallax: { value: '20.7694', error: '0.0266' }, logg: ['4.28', '0.1'], feh: [0, 0.1], av_max: '0', unused: null });
check('star_fit: the documented call still fits HD 209458', !base.isError && Math.abs(base.data.teff_K.value - 6092) < 100, base.isError ? base.text : `${base.data.teff_K.value} K`);
check('star_fit: delimiter-, backtick- and underscore-mangled bands with string and { value, error } numbers give the same fit', !fixed.isError && fixed.data.teff_K.value === base.data.teff_K.value && fixed.data.radius_Rsun.value === base.data.radius_Rsun.value, fixed.isError ? fixed.text.slice(0, 200) : '');
const swapped = await call('star_fit', { magnitudes: M, parallax: [0.0266, 20.7694], av_max: 0 });
check('star_fit: a parallax whose error exceeds it is used as given, with a warning on the order', !swapped.isError && swapped.data.warnings.some((w) => /\[value, error\]/.test(w)));
const short = await call('star_fit', { magnitudes: { G: [7.52, 0.003], Ks: [6.31, 0.026], r: [7.7, 0.01] } });   // r: SDSS, PS1 or APASS
check('star_fit: ambiguous short names fail with a message naming the fix', short.isError && /use the full band name/.test(short.text) && /Example call/.test(short.text));
const gkv = await call('star_fit', { magnitudes: { G: [7.521246, 0.002776], Ks: [6.308, 0.026], V: [7.65, 0.01] }, av_max: 0 });
check('star_fit: G, Ks and V alone are Gaia G, 2MASS Ks and Johnson V', !gkv.isError && gkv.data.bands.map((b) => b.band).join() === 'Gaia G,2MASS Ks,Johnson V', gkv.isError ? gkv.text.slice(0, 150) : '');

// the atmosphere of a planet that is not a preset, as the evaluation asked for it
const spec = { model: { planet: { mplanet: 1.19, rplanet: 1.23, pRef: 0.01 }, star: { rstar: 1.02, teff: 5659, ars: 7.83 }, tp: { kind: 'guillot', teq: 1429, tint: 100, kappaIR: 0.001, gamma: 0.4 }, chemistry: { mh: 0 } }, wl_min: 0.3, wl_max: 2.0, R: 50 };
const a1 = await call('atmosphere_spectrum', { ...spec, save_as: 'a1.csv' });
const strs = JSON.parse(JSON.stringify(spec), (k, v) => (typeof v === 'number' && k !== 'R' ? String(v) : v));
const a2 = await call('atmosphere_spectrum', { ...strs, planet_name: 'HATS-33 b', world: null, save_as: 'a2.csv' });
const a3 = await call('atmosphere_spectrum', { ...spec, model: { ...spec.model, planet: { mplanet: 1.19, rplanet: 1.23, pRef_mbar: 10 } }, save_as: 'a3.csv' });
check('atmosphere_spectrum: the documented call works', !a1.isError, a1.isError ? a1.text : '');
check('atmosphere_spectrum: numbers sent as strings, world: null and a planet_name give the same spectrum, labelled', !a2.isError && a2.data.planet_name === 'HATS-33 b' && a2.data.transit_depth_ppm.largest.value === a1.data.transit_depth_ppm.largest.value, a2.isError ? a2.text.slice(0, 200) : '');
check('atmosphere_spectrum: pRef_mbar 10 is the same as pRef 0.01', !a3.isError && a3.data.transit_depth_ppm.smallest.value === a1.data.transit_depth_ppm.smallest.value);
const named = await call('atmosphere_spectrum', { world: 'HATS-33 b', save_as: 'a4.csv' });
check('atmosphere_spectrum: a planet name in world fails with the way to model it', named.isError && /leave world out/.test(named.text));
const bar = await call('atmosphere_spectrum', { ...spec, model: { ...spec.model, planet: { mplanet: 1.19, rplanet: 1.23, pRef: 10 } }, save_as: 'a5.csv' });
const barOk = await call('atmosphere_spectrum', { ...spec, model: { ...spec.model, planet: { mplanet: 1.19, rplanet: 1.23, pRef_bar: 10 } }, save_as: 'a5.csv' });
check('atmosphere_spectrum: pRef 10 is refused with both readings; pRef_bar 10 runs and warns', bar.isError && /pRef_mbar/.test(bar.text) && !barOk.isError && (barOk.data.warnings || []).some((w) => /pRef_mbar 10/.test(w)), bar.text.slice(0, 160));

await client.close();
console.log(ok ? 'ALL OK' : 'SOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
