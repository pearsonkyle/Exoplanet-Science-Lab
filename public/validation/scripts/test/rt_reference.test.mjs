// The forward model (src/core/rtmodel.js) against petitRADTRANS 3.4.0 (test/make_rt_reference.py -> rt_reference.json):
// three planets, each of the twelve shipped gases alone (eight molecules on a warm planet; Na, K, TiO, VO on an
// ultra-hot one), four mixtures of up to eight, and five with aerosols (a cloud deck on 120 and 480 layers, a
// power-law haze, enhanced Rayleigh scattering, a half-covered planet), with H2/He Rayleigh scattering: transit depth
// and emergent flux.
//   1. like for like: the same ExoMolOP k-tables in both codes (data-src/study/e1000g16, untracked: skipped with a
//      note when the folder is absent; build it with tools/opacity/study.py e1000g16; a case whose table is absent there is
//      skipped with a note)
//   2. the tables the app ships (public/opacity: R = 200, 12 g-points), both spectra binned to R = 100
// Every tolerance is stated in its check.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTable } from '../src/core/opacity.js';
import { forwardModel } from '../src/core/rtmodel.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./rt_reference.json', import.meta.url)));
const load = (dir, skipCia = true) => { const lines = []; for (const f of readdirSync(dir).filter((x) => x.endsWith('.eslo'))) { const b = readFileSync(new URL(f, dir)), t = parseTable(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); if (t.kind !== 'cia') lines.push(t); } return { lines, cia: [] }; };
const stat = (a, b, scale) => { let s = 0, m = 0, mean = 0, n = 0, at = 0; for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue; const d = (a[i] - b[i]) * scale; s += d * d; mean += d; if (Math.abs(d) > m) { m = Math.abs(d); at = i; } n++; } return { rms: Math.sqrt(s / n), max: m, mean: mean / n, at, n }; };
const relStat = (a, b) => stat(Array.from(a, (v, i) => v / b[i]), Array.from(b, () => 1), 100);
/** Average y (on bins with edges) into bins of resolving power R from lo to hi, by overlap in ln(wavelength). */
const rebin = (edges, y, R, lo, hi) => { const E = [lo]; while (E[E.length - 1] * Math.exp(1 / R) <= hi) E.push(E[E.length - 1] * Math.exp(1 / R)); const out = new Float64Array(E.length - 1); for (let b = 0; b < out.length; b++) { let s = 0, w = 0; for (let i = 0; i < y.length; i++) { const a = Math.max(E[b], edges[i]), c = Math.min(E[b + 1], edges[i + 1]); if (c > a * (1 + 1e-9)) { const f = Math.log(c / a); s += f * y[i]; w += f; } } out[b] = s / w; } return out; };
const [p0, p1, np] = ref.pressures;
/** The model of a case as forwardModel takes it: petitRADTRANS's haze_factor is our rayleighFactor. */
const modelOf = (c) => {
  const m = { ...c.model, heH2: ref.heH2 }, h = m.haze;
  if (h && h.rayleigh_times) { m.rayleighFactor = h.rayleigh_times; m.haze = null; } else if (h) m.haze = { factor: h.factor, slope: h.slope };
  return m;
};
/** The gases of a case that the folder has no table for. */
const lacking = (tables, c) => Object.keys(c.model.vmr).filter((sp) => !tables.lines.some((t) => t.species === sp));

// ---- 1. the same k-tables in both codes ---------------------------------------------------------------------------
const full = new URL('../data-src/study/e1000g16/', import.meta.url);
if (existsSync(full)) {
  const tables = load(full);
  for (const [name, c] of Object.entries(ref.cases)) {
    const miss = lacking(tables, c); if (miss.length) { console.log(`note ${name}: no R = 1000 table for ${miss.join(', ')} in data-src/study/e1000g16: not run`); continue; }
    const model = { ...modelOf(c), pTop: p0, pBottom: p1, nLayers: (c.nlev || np) - 1 }, patchy = model.cloudFraction != null && model.cloudFraction < 1;
    // like for like also means the tables interpolated between their nodes as petitRADTRANS's are ('sigmaT'); the
    // second run is the model as the app uses it
    const r = forwardModel(model, tables, { greyBelow: 0, interpolation: 'sigmaT' }), ours = forwardModel(model, tables, { greyBelow: 0 });
    // petitRADTRANS's flux call takes no cloud fraction: its flux is the fully covered planet's
    if (patchy) { r.flux = forwardModel({ ...model, cloudFraction: 1 }, tables, { greyBelow: 0, interpolation: 'sigmaT', want: { transmission: false } }).flux; ours.flux = forwardModel({ ...model, cloudFraction: 1 }, tables, { greyBelow: 0, want: { transmission: false } }).flux; }
    // petitRADTRANS's bins are a run of the table's own bins: find the offset from the first wavelength
    let o = 0; while (r.wl[o] < c.wl[0] * (1 - 2e-4)) o++;
    const grid = Math.max(...c.wl.map((w, i) => Math.abs(r.wl[o + i] / w - 1))), cut = (a) => a.subarray(o, o + c.wl.length);
    const d = stat(cut(r.depth), c.depth, 1e6), f = relStat(cut(r.flux), c.flux), span = (Math.max(...c.depth) - Math.min(...c.depth)) * 1e6;
    const coarseDeck = model.cloudTop != null && model.nLayers < 400;
    const d2 = stat(cut(ours.depth), c.depth, 1e6), f2 = relStat(cut(ours.flux), c.flux), ns = Object.keys(c.model.vmr).length;
    check(`${name}: transit depth matches petitRADTRANS ${ref.version} with the same k-tables`, grid < 2e-4 && d.rms < (coarseDeck ? 25 : 8) && d.max < (coarseDeck ? 35 : 25) && d2.rms < (coarseDeck ? 25 : 10) && d2.max < 100,
      `rms ${d.rms.toFixed(1)} ppm, max ${d.max.toFixed(1)} ppm at ${c.wl[d.at].toFixed(3)} µm, mean ${d.mean.toFixed(1)} ppm over ${d.n} bins at R = 1000, ${c.wl[0].toFixed(2)}-${c.wl[c.wl.length - 1].toFixed(0)} µm (${ns === 1 ? 'one species' : ns + ' species combined by random overlap'}; the spectrum spans ${span.toFixed(0)} ppm; tolerance ${coarseDeck ? '25 ppm rms, 35 ppm max: under an opaque deck petitRADTRANS counts the ring just below its top as half blocked, we as blocked, a difference that shrinks with the layers, see the 480-layer case' : '8 ppm rms, 25 ppm max'}). With the tables interpolated our way (log σ in 1/T instead of σ in T): rms ${d2.rms.toFixed(1)} ppm, max ${d2.max.toFixed(1)} ppm at ${c.wl[d2.at].toFixed(3)} µm, mean ${d2.mean.toFixed(1)} ppm (tolerance 10 and 100 ppm): the difference is where σ changes steeply with temperature, and there the tables' own nodes favour log σ in 1/T (test/opacity.test.mjs). Bin centres agree to ${grid.toExponential(1)}`);
    check(`${name}: emergent flux matches petitRADTRANS`, f.rms < 1.2 && f.max < 4 && f2.rms < 1.2 && f2.max < 4, `rms ${f.rms.toFixed(2)}%, max ${f.max.toFixed(2)}% at ${c.wl[f.at].toFixed(3)} µm, mean ${f.mean.toFixed(2)}%; interpolated our way rms ${f2.rms.toFixed(2)}%, max ${f2.max.toFixed(2)}%; tolerance 1.2% rms, 4% max`);
  }
} else console.log('note the like-for-like comparison needs data-src/study/e1000g16 (97 MB per species, untracked): not run here');

// ---- 2. the shipped tables, at R = 100 ---------------------------------------------------------------------------
{
  // ESL_OPACITY: another folder of tables (a trailing slash), for tools/opacity studies
  const tables = load(process.env.ESL_OPACITY ? pathToFileURL(process.env.ESL_OPACITY) : new URL('../public/opacity/', import.meta.url));
  for (const [name, c] of Object.entries(ref.cases)) {
    const miss = lacking(tables, c); if (miss.length) { check(`${name}: shipped tables`, false, `public/opacity has no table for ${miss.join(', ')}`); continue; }
    const r = forwardModel(modelOf(c), tables); if (r.cloudFraction < 1) r.flux = forwardModel({ ...modelOf(c), cloudFraction: 1 }, tables, { want: { transmission: false } }).flux;
    const lo = (c.model.range ? c.model.range[0] : 0.6) + 0.02, hi = 11.8;   // inside petitRADTRANS's range
    // petitRADTRANS's bin edges from its centres (uniform in ln)
    const step = Math.log(c.wl[c.wl.length - 1] / c.wl[0]) / (c.wl.length - 1), pe = [c.wl[0] * Math.exp(-step / 2)]; for (const w of c.wl) pe.push(w * Math.exp(step / 2));
    const mine = rebin(r.grid.edges, r.depth, 100, lo, hi), theirs = rebin(pe, c.depth, 100, lo, hi);
    const mf = rebin(r.grid.edges, r.flux, 100, lo, hi), tf = rebin(pe, c.flux, 100, lo, hi);
    const d = stat(mine, theirs, 1e6), f = relStat(mf, tf), single = Object.keys(c.model.vmr).length === 1, ftol = single ? 2.5 : 1.2;
    check(`${name}: shipped tables (R = ${Math.round(1 / Math.log(r.grid.edges[1] / r.grid.edges[0]))}, ${r.grid.ng} g-points, 60 layers) against petitRADTRANS at R = 100`, d.rms < (c.model.cloudTop != null ? 25 : 20) && d.max < 100 && f.rms < ftol,
      `transit rms ${d.rms.toFixed(1)} ppm, max ${d.max.toFixed(1)} ppm, mean ${d.mean.toFixed(1)} ppm over ${d.n} bins; flux rms ${f.rms.toFixed(2)}%, max ${f.max.toFixed(2)}%; tolerance ${c.model.cloudTop != null ? 25 : 20} ppm rms, 100 ppm max, ${ftol}% rms${single ? ' (a trace gas alone leaves the atmosphere transparent down to the bottom of the model at some wavelengths, where the flux is the temperature of the lowest layer and so depends on the layering: for SO2 alone 1.80% with 60 layers, 0.94% with 120, 0.49% with 240)' : ''}`);
  }
}
process.exit(ok ? 0 : 1);
