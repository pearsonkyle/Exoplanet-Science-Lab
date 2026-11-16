// Photometry page: files -> image viewer -> stars -> worker -> light curve, tried-apertures table, export.
// Science lives in src/core (fits.js, photometry.js, gp.js) and src/photometry/pipeline.js; this file is the UI.
import { siteRoot } from '../site/nav.js';
import { openFits, readTargetPixelFile, framePointing, frameTime, pixelScale } from '../core/fits.js';
import { centroidIter, detectSources, fitPsf, lightCurveFor, tpfLightCurve, pipelineMask, tpfMedianImage, medianOf, runningMedian, METHOD_LABEL } from '../core/photometry.js';
import { lombScarglePsd, welchPsd, splitSegments, whiteNoiseLevel, photonNoiseLevel, logBinPsd, fitRedNoise, rmsVsBin, pixelMap, polySurface } from '../core/psd.js';
import { FITS_NAME, readHeaderOnly, frameKind, loadFrame, splitFits, makeFitter, PHOT_VERSION, tpfPld } from './pipeline.js';
import { DETREND_COLUMNS } from '../core/detrend.js';
import { aavsoReport } from '../core/aavso.js';
import { ImageViewer } from './viewer.js';
import { createInspector } from './inspect.js';
import { rankComparisons, saturationLevel, psfShape } from '../core/imexam.js';
import { renderPanel, fitCanvas, PHOT_THEME, renderFov } from './plots.js';
import { renderPsd, renderRmsBin, renderPixelMap } from './diagnostics.js';
import { BUCKET, tessProducts, keplerProducts, k2Products, chooseProducts, fetchBytes, resolveTarget } from './mast.js';
import { expandZips, ZIP_NAME } from '../core/zip.js';
import { createSeries } from './series.js';
import { makeDemoFrames, DEMO_TRUTH } from './demo.js';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $ = (id) => document.getElementById(id);
const fmtMB = (b) => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';

const P = {
  mode: null, lights: [], cal: { bias: [], dark: [], flat: [] }, frame: 0, cur: null, stars: [], detected: [],
  tpf: null, tpfBuffer: null, tpfName: '', customMask: null, pixelMode: false, tpfTarget: null, showMedian: false,
  result: null, lc: null, sel: -1, gp: null, busy: false, name: 'photometry', live: null, planet: null,
  // detrending chosen for the analyzer (src/core/detrend.js): linear regressors by name, time polynomial, PLD components (TPF), kernel regression
  detrend: { columns: [], poly: 0, pld: 0, kernel: false, neighbors: 50, kernelFwhm: false }, pld: null,
};
window.__phot = P;

// ------------------------------------------------------------------------------------------- worker
let worker = null, seq = 0; const pending = new Map();
function call(msg, onProgress) {
  if (!worker) {
    worker = new Worker(new URL('../worker/photometry.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => { const m = ev.data, p = pending.get(m.id); if (!p) return; if (m.type === 'progress') p.onProgress && p.onProgress(m); else { pending.delete(m.id); m.type === 'done' ? p.resolve(m.result) : p.reject(new Error(m.message)); } };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'The photometry worker failed to start.')); pending.clear(); };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ ...msg, id }); });
}

// ------------------------------------------------------------------------------------------- layout
const app = $('app');
const canPickDir = typeof window.showDirectoryPicker === 'function';
app.append(
  h('div', { class: 'srcbar card', id: 'srcbar', hidden: true }),
  h('section', { class: 'src', id: 'srcSec' },
    h('div', { class: 'card' },
      h('h2', {}, 'Your images'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'bFolder', onclick: openFolder }, 'Open a folder'),
        h('button', { class: 'btn', id: 'bFiles', onclick: () => $('inFiles').click() }, 'Open files'),
        h('input', { type: 'file', id: 'inFiles', multiple: true, accept: '.fits,.fit,.fts,.gz,.fz,.zip,.FITS,.FIT,.FTS,.ZIP', hidden: true, onchange: (e) => addFiles([...e.target.files]) }),
        h('input', { type: 'file', id: 'inDir', multiple: true, webkitdirectory: true, hidden: true, onchange: (e) => addFiles([...e.target.files]) })),
      h('div', { class: 'drop', id: 'drop' }, 'or drop FITS files, a folder or a .zip here (zips of frames or of whole folders, with calibration subfolders, are read without unpacking them). Light frames are put in time order; darks, flats and bias frames are recognised from IMAGETYP, the file name or the folder and applied. TESS / Kepler / K2 target pixel files and light-curve files work too; several sectors are stitched.'),
      h('div', { class: 'status', id: 'stLocal' })),
    h('div', { class: 'card' },
      h('h2', {}, 'TESS, Kepler and K2: pixels and light curves'),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'wide', id: 'inTarget', 'aria-label': 'Star to look for in the TESS, Kepler and K2 archives', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'TIC 100100827, KIC 11446443, EPIC 201912552, or a host name (WASP-18)', onkeydown: (e) => { if (e.key === 'Enter') findArchive(); } }),
        h('button', { class: 'btn', id: 'bFind', onclick: findArchive }, 'Find files')),
      h('div', { class: 'filelist', id: 'archList', hidden: true }),
      h('div', { class: 'status', id: 'stArch' }, 'Light curves (SPOC, TESS-SPOC, QLP, Kepler, K2) and target pixel files are read straight from the MAST public bucket on AWS. TESScut cutouts of full-frame images cannot be fetched from a web page (no CORS); download those and open the file.'),
      h('div', { id: 'archPick', hidden: true }),
      h('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, h('span', { class: 'dim' }, 'Try it:'), h('a', { href: '?demo=1' }, 'WASP-18 from TESS'), h('a', { href: '?demo=2' }, 'a synthetic night of frames'), h('a', { href: '?demo=3', title: 'Every third frame of the sample data EXOTIC is tested with (HAT-P-32 b, a 6-inch MicroObservatory telescope), cut down to the three stars' }, 'real frames of HAT-P-32 b')))),
  h('section', { class: 'work', id: 'work', hidden: true },
    h('div', { class: 'view' },
      h('div', { class: 'vbar top' },
        h('button', { class: 'btn sm', id: 'bPrev', title: 'Previous frame', 'aria-label': 'Previous frame', onclick: () => showFrame(P.frame - 1) }, '◀'),
        h('input', { type: 'range', class: 'frame', id: 'frame', 'aria-label': 'Frame', min: 0, max: 0, value: 0, oninput: (e) => showFrame(+e.target.value) }),
        h('button', { class: 'btn sm', id: 'bNext', title: 'Next frame', 'aria-label': 'Next frame', onclick: () => showFrame(P.frame + 1) }, '▶'),
        h('span', { class: 'mono dim', id: 'frameLabel' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', id: 'bPlay', onclick: togglePlay }, 'Play'),
        h('button', { class: 'btn sm', id: 'bBlink', title: 'Alternate with the first frame', onclick: toggleBlink }, 'Blink'),
        h('button', { class: 'btn sm', id: 'bMedian', hidden: true, title: 'Median of all cadences', onclick: () => { P.showMedian = !P.showMedian; $('bMedian').classList.toggle('on', P.showMedian); showFrame(P.frame); } }, 'Median')),
      h('div', { class: 'vbar tools', id: 'toolbar' }),
      h('canvas', { class: 'img', id: 'img', role: 'img', 'aria-label': 'The current frame. Tap or click a star to choose it; drag to pan, pinch or scroll to zoom.' }),
      h('div', { class: 'vbar' },
        h('label', {}, 'Stretch', h('select', { id: 'stKind', onchange: restretch }, ...['asinh', 'linear', 'sqrt', 'log'].map((k) => h('option', {}, k)))),
        h('label', {}, 'Black', h('input', { type: 'range', id: 'stLo', min: 0, max: 60, step: 0.5, value: 10, oninput: restretch })),
        h('label', {}, 'White', h('input', { type: 'range', id: 'stHi', min: 90, max: 100, step: 0.02, value: 99.8, oninput: restretch })),
        h('button', { class: 'btn sm', title: 'Fit the whole image in the view', onclick: () => viewer.fit() }, 'Fit'),
        h('span', { class: 'readout', id: 'readout', 'aria-live': 'off' }, typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'pinch to zoom, drag to pan, tap to pick' : 'scroll to zoom, drag to pan'))),
    h('div', { class: 'side' },
      h('div', { class: 'card', id: 'cardInspect', hidden: true }),
      h('div', { class: 'card', id: 'cardStars' }),
      h('div', { class: 'card', id: 'cardSet' }),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'bRun', onclick: run }, 'Measure'), h('button', { class: 'btn', id: 'bStop', hidden: true, onclick: () => worker && worker.postMessage({ type: 'stop' }) }, 'Stop'), h('span', { class: 'dim', id: 'runNote' })),
        h('progress', { id: 'prog', max: 1, value: 0, hidden: true }),
        h('div', { class: 'status', id: 'stRun' })))),
  h('section', { class: 'live', id: 'live', hidden: true }),
  h('section', { class: 'res', id: 'res', hidden: true }),
  h('section', { class: 'res series', id: 'series', hidden: true }));

const viewer = new ImageViewer($('img'));
viewer.onHover = (x, y, v) => { $('readout').textContent = `x ${x.toFixed(1)}  y ${y.toFixed(1)}  ${Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(4)) : ''}`; };
const insp = createInspector({ P, viewer, h, $, card: $('cardInspect'), bar: $('toolbar'), gain: () => numOf('sGain'), note: (t) => { $('readout').textContent = t; }, addStar: (x, y, asTarget) => addStarAt(x, y, asTarget) });
viewer.onClick = (x, y, e) => { if (!insp.click(x, y)) onImageClick(x, y, e); };
viewer.onDraw = (c, v) => { drawOverlay(c, v); insp.draw(c, v); };
window.__phot.inspector = insp;

const setStatus = (id, text, cls = '') => {
  const el = $(id); el.textContent = text; el.className = 'status ' + cls;
  // the loading cards are folded once something is open: their messages show in the bar instead
  const m = (id === 'stLocal' || id === 'stArch') && document.querySelector('#srcbar .srcstat'); if (m) { m.textContent = text; m.className = 'srcstat ' + cls; }
};
function restretch() { viewer.setStretch({ kind: $('stKind').value, lo: +$('stLo').value, hi: +$('stHi').value }); }

// ------------------------------------------------------------------------------------------- opening files
async function openFolder() {
  if (!canPickDir) { $('inDir').click(); return; }
  try {
    const dir = await window.showDirectoryPicker(), files = [];
    const walk = async (d, depth, path) => { for await (const [name, handle] of d.entries()) { if (handle.kind === 'file') { if (FITS_NAME.test(name) || /\.fz$/i.test(name) || ZIP_NAME.test(name)) { const f = await handle.getFile(); f.relPath = path + name; files.push(f); } } else if (depth < 3) await walk(handle, depth + 1, path + name + '/'); } };
    await walk(dir, 0, '');
    P.name = dir.name; await addFiles(files);
  } catch (err) { if (err.name !== 'AbortError') setStatus('stLocal', String(err.message || err), 'err'); }
}

async function entriesToFiles(items) {
  const out = [], walk = async (entry, depth) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file((f) => { f.relPath = entry.fullPath; res(f); }, rej)));
    else if (entry.isDirectory && depth < 3) { const rd = entry.createReader(); for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const e of batch) await walk(e, depth + 1); } }
  };
  for (const e of items) await walk(e, 0);
  return out;
}
{
  const drop = $('drop'), over = (v) => drop.classList.toggle('over', v);
  window.addEventListener('dragover', (e) => { e.preventDefault(); over(true); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) over(false); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); over(false);
    const entries = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    try { addFiles(entries.length ? await entriesToFiles(entries) : [...e.dataTransfer.files]); } catch (err) { setStatus('stLocal', String(err.message || err), 'err'); }
  });
}

async function addFiles(all) {
  // zips (of frames or of whole folders, calibration subfolders included) become lazy Files of their entries (src/core/zip.js)
  let zipNote = '';
  if (all.some((f) => ZIP_NAME.test(f.name))) {
    setStatus('stLocal', 'Reading the zip directory…');
    try { const ex = await expandZips(all, { filter: (path) => FITS_NAME.test(path) }); all = ex.files; zipNote = ` from ${ex.zips} zip${ex.zips > 1 ? 's' : ''}${ex.skipped.length ? ` (${ex.skipped.length} entries not read: ${[...new Set(ex.skipped.map((q) => q.why))].join('; ')})` : ''}`; } catch (err) { setStatus('stLocal', String(err.message || err), 'err'); return; }
  }
  let files = all.filter((f) => FITS_NAME.test(f.name));
  if (!files.length) { setStatus('stLocal', `No FITS files found${zipNote} (looked for .fits, .fit, .fts, optionally .gz or .fz, also inside .zip files).`, 'err'); return; }
  if (files.length === 1) { try { const parts = await splitFits(await files[0].arrayBuffer(), files[0].name.replace(FITS_NAME, '')); if (parts.length > 1) files = parts.map((q, i) => new File([q.buffer], /\.fi?ts?$/i.test(q.name) ? q.name : `${q.name}_${String(i + 1).padStart(4, '0')}.fits`)); } catch { /* not a container: carry on with the one file */ } }
  setStatus('stLocal', `Reading ${files.length} header${files.length > 1 ? 's' : ''}…`);
  const lights = [], cal = { bias: [], dark: [], flat: [] }, tpfs = [], lcs = []; let bad = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const hd = await readHeaderOnly(files[i]);
      if (hd.primaryEmpty && hd.ext && String(hd.ext.XTENSION || '').trim() === 'BINTABLE') {
        // a target pixel file has a FLUX column with a 2-D TDIM; anything else with a time column is a light-curve table
        const E = hd.ext, cols = Object.keys(E).filter((k) => /^TTYPE\d+$/.test(k)).map((k) => ({ name: String(E[k]).trim().toUpperCase(), dim: E['TDIM' + k.slice(5)] }));
        (cols.some((c) => c.name === 'FLUX' && c.dim) ? tpfs : lcs).push(files[i]); continue;
      }
      const kind = frameKind(hd.header, files[i].relPath || files[i].name);
      if (kind !== 'light') { cal[kind].push(files[i]); continue; }
      const t = frameTime(hd.header, hd.comments);
      lights.push({ file: files[i], jd: t.jd, header: hd.header, comments: hd.comments });
    } catch { bad++; }
    if (i % 25 === 24) setStatus('stLocal', `Reading headers… ${i + 1} / ${files.length}`);
  }
  if (!lights.length && tpfs.length === 1 && !lcs.length) { const tpfFile = tpfs[0]; try { await loadTpf(await tpfFile.arrayBuffer(), tpfFile.name); setStatus('stLocal', `${tpfFile.name}: target pixel file${zipNote}.`, 'ok'); } catch (err) { setStatus('stLocal', String(err.message || err), 'err'); } return; }
  if (!lights.length && (tpfs.length || lcs.length)) { await loadSeriesFiles([...lcs.map((f) => ({ file: f, kind: 'lc' })), ...tpfs.map((f) => ({ file: f, kind: 'tpf' }))], zipNote); return; }
  if (!lights.length) { setStatus('stLocal', `No light frames among ${files.length} FITS files (${cal.dark.length} dark, ${cal.flat.length} flat, ${cal.bias.length} bias${bad ? ', ' + bad + ' unreadable' : ''}).`, 'err'); return; }
  lights.sort((a, b) => (Number.isFinite(a.jd) && Number.isFinite(b.jd) ? a.jd - b.jd : a.file.name.localeCompare(b.file.name, undefined, { numeric: true })));
  Object.assign(P, { mode: 'stack', lights, cal, frame: 0, stars: [], detected: [], suggest: [], result: null, lc: null, gp: null, tpf: null, tpfBuffer: null, cur: null, live: null });
  if (P.name === 'photometry') P.name = (lights[0].header.OBJECT && String(lights[0].header.OBJECT).trim()) || lights[0].file.name.replace(FITS_NAME, '');
  const noTime = lights.filter((l) => !Number.isFinite(l.jd)).length;
  setStatus('stLocal', `${lights.length} light frames` + (cal.dark.length + cal.flat.length + cal.bias.length ? `, ${cal.dark.length} dark, ${cal.flat.length} flat, ${cal.bias.length} bias` : '') + zipNote + (bad ? `, ${bad} unreadable` : '') + (noTime ? `. ${noTime} have no time keyword.` : '.'), noTime ? 'err' : 'ok');
  frameCache.clear();
  enterWork();
  await showFrame(0, false);
}

async function loadTpf(buffer, name) {
  const tpf = readTargetPixelFile(await openFits(buffer));
  Object.assign(P, { mode: 'tpf', tpf, tpfBuffer: buffer, tpfName: name, lights: [], frame: 0, stars: [], result: null, lc: null, gp: null, customMask: new Uint8Array(tpf.nx * tpf.ny), pixelMode: false, tpfTarget: null, showMedian: true });
  P.name = `${tpf.object || name.replace(FITS_NAME, '')}${tpf.sector != null ? ' sector ' + tpf.sector : tpf.quarter != null ? (tpf.mission === 'K2' ? ' C' : ' Q') + tpf.quarter : ''}`;
  P.tpfMedian = tpfMedianImage(tpf);
  enterWork();
  $('bMedian').classList.add('on');
  await showFrame(0, false);
}

// ------------------------------------------------------------------------------------------- several sectors (light curves)
const series = createSeries({ P, h, $, el: $('series'), call: (m, p) => call(m, p), setStatus: (id, t, c) => setStatus(id, t, c), siteRoot, download: (...a) => download(...a), stem: () => fileStem(), name: () => P.name });
window.__phot.seriesView = series;   // (P.series is its state)
/** Show light curves (parts from src/photometry/prep.js) stitched, with the preparation for transit fitting. */
function enterSeries(parts, info = {}) {
  if (playT) togglePlay(); stopBlink();
  Object.assign(P, { mode: 'series', result: null, lc: null, gp: null, tpf: null, tpfBuffer: null, lights: [], stars: [] });
  P.name = info.name || parts[0]?.object || 'light curves'; P.series.parts = parts;
  foldSources();
  $('work').hidden = true; $('res').hidden = true; $('res').innerHTML = ''; $('live').hidden = true;
  series.show(parts, info);
}
/** Light-curve files and TPFs (Files or { buffer, name }) → parts in the worker → series mode. */
async function loadSeriesFiles(items, note = '', info = {}, stId = 'stLocal') {
  const msg = []; const bufs = [];
  for (const it of items) bufs.push({ buffer: it.buffer || await it.file.arrayBuffer(), name: it.name || it.file.name, kind: it.kind });
  setStatus(stId, `Reading ${bufs.length} file${bufs.length > 1 ? 's' : ''}${bufs.some((b) => b.kind === 'tpf') ? ' (target pixel files: each gets the aperture search)' : ''}…`);
  const opts = { quality: $('qPreset') ? $('qPreset').value : 'default', flux: $('lcFlux') ? $('lcFlux').value : 'pdcsap', k2: $('k2Sys') && $('k2Sys').value === 'pld' ? 'pld' : null, thrusters: !!($('k2Thr') && $('k2Thr').checked) };
  const r = await call({ type: 'parts', items: bufs, opts }, (m) => { if (m.stage === 'parts') setStatus(stId, `Reading ${m.done + 1} / ${m.total}: ${m.name}`); });
  if (r.errors.length) msg.push(`${r.errors.length} not read (${r.errors.map((e) => `${e.name}: ${e.error}`).join('; ')})`);
  if (!r.parts.length) { setStatus(stId, 'No light curve could be read. ' + msg.join(' '), 'err'); return; }
  const o = r.parts[0].object || '';
  setStatus(stId, `${r.parts.length} light curve${r.parts.length > 1 ? 's' : ''}${note}${msg.length ? '; ' + msg.join('; ') : ''}.`, msg.length ? 'err' : 'ok');
  enterSeries(r.parts.sort((a, b) => a.t[0] - b.t[0]), { name: info.name || o || r.parts[0].name, tic: info.tic ?? (/^TIC (\d+)/.exec(o)?.[1] ? +/^TIC (\d+)/.exec(o)[1] : null), kic: info.kic ?? (/^KIC (\d+)/.exec(o)?.[1] ? +/^KIC (\d+)/.exec(o)[1] : null), epic: info.epic ?? (/^EPIC (\d+)/.exec(o)?.[1] ? +/^EPIC (\d+)/.exec(o)[1] : null), object: o });
}

function foldSources() {
  // once something is open, the loading cards fold into one line so the image is near the top (a phone shows little else)
  $('srcSec').classList.add('loaded'); const bar = $('srcbar'); bar.hidden = false; bar.innerHTML = '';
  const last = [$('stLocal'), $('stArch')].find((e) => e.classList.contains('ok') || e.classList.contains('err'));
  bar.append(h('span', { class: 'mono' }, P.name), h('span', { class: 'dim' }, P.mode === 'series' ? `${P.series.parts.length} light curves` : P.mode === 'tpf' ? `${P.tpf.ncad} cadences` : `${P.lights.length} frames${P.cal.dark.length + P.cal.flat.length + P.cal.bias.length ? ' + calibration' : ''}`), h('span', { class: 'grow' }),
    h('button', { class: 'btn sm', onclick: () => { const open = $('srcSec').classList.toggle('loaded'); bar.querySelector('button').textContent = open ? 'Open other files' : 'Hide'; } }, 'Open other files'),
    h('span', { class: 'srcstat ' + (last ? last.className.replace('status', '') : '') }, last ? last.textContent : ''));
}
function enterWork() {
  foldSources();
  $('work').hidden = false; $('res').hidden = true; $('res').innerHTML = ''; $('live').hidden = true; $('live').innerHTML = ''; $('series').hidden = true;
  const n = P.mode === 'tpf' ? P.tpf.ncad : P.lights.length;
  $('frame').max = n - 1; $('frame').value = 0;
  $('bMedian').hidden = P.mode !== 'tpf';
  $('stLo').value = P.mode === 'tpf' ? 0 : 10; $('stHi').value = P.mode === 'tpf' ? 100 : 99.8; viewer.stretch.lo = +$('stLo').value; viewer.stretch.hi = +$('stHi').value;
  viewer.fitted = false;
  buildStarsCard(); buildSettings(); insp.reset();
  setStatus('stRun', ''); $('runNote').textContent = P.mode === 'tpf' ? '' : 'pick the target first';
}

// ------------------------------------------------------------------------------------------- frames
const frameCache = new Map();
let showSeq = 0;
async function showFrame(i, keep = true) {
  const n = P.mode === 'tpf' ? P.tpf.ncad : P.lights.length;
  i = Math.max(0, Math.min(n - 1, i)); P.frame = i; $('frame').value = i;
  const my = ++showSeq;
  if (P.mode === 'tpf') {
    const t = P.tpf, np = t.nx * t.ny;
    P.cur = { data: P.showMedian ? P.tpfMedian : t.flux.subarray(i * np, (i + 1) * np), width: t.nx, height: t.ny };
    $('frameLabel').textContent = P.showMedian ? `median of ${t.ncad} cadences` : `cadence ${i + 1} / ${t.ncad}   ${Number.isFinite(t.time[i]) ? (t.time[i] + t.bjdRef - 2457000).toFixed(4) + ' BTJD' : 'no time'}${t.quality[i] ? '   flag ' + t.quality[i] : ''}`;
  } else {
    let fr = frameCache.get(i);
    if (!fr) { try { fr = await loadFrame(P.lights[i].file); } catch (err) { setStatus('stRun', String(err.message || err), 'err'); return; } frameCache.set(i, fr); if (frameCache.size > 3) frameCache.delete(frameCache.keys().next().value); }
    if (my !== showSeq) return;
    P.cur = fr;
    const l = P.lights[i];
    $('frameLabel').textContent = `${i + 1} / ${n}   ${l.file.name}${Number.isFinite(l.jd) ? '   JD ' + l.jd.toFixed(5) : ''}`;
  }
  viewer.setImage(P.cur.data, P.cur.width, P.cur.height, keep);
  insp.frameChanged();
}
let playT = null, blinkT = null, blinkBack = 0;
function togglePlay() { if (playT) { clearInterval(playT); playT = null; } else { stopBlink(); let busy = false; playT = setInterval(async () => { if (busy) return; busy = true; const n = +$('frame').max + 1; await showFrame((P.frame + 1) % n); busy = false; }, P.mode === 'tpf' ? 60 : 180); if (P.mode === 'tpf' && P.showMedian) { P.showMedian = false; $('bMedian').classList.remove('on'); } } $('bPlay').classList.toggle('on', !!playT); }
function stopBlink() { if (blinkT) { clearInterval(blinkT); blinkT = null; showFrame(blinkBack); } $('bBlink').classList.remove('on'); }
function toggleBlink() { if (blinkT) { stopBlink(); return; } if (playT) togglePlay(); blinkBack = P.frame || Math.min(+$('frame').max, 1); let flip = false; blinkT = setInterval(() => { flip = !flip; showFrame(flip ? 0 : blinkBack); }, 500); $('bBlink').classList.add('on'); }

// ------------------------------------------------------------------------------------------- stars
function onImageClick(x, y) {
  if (P.busy) return;
  if (P.mode === 'tpf') {
    const xi = Math.round(x), yi = Math.round(y), t = P.tpf;
    if (P.pixelMode) { P.customMask[yi * t.nx + xi] ^= 1; } else P.tpfTarget = { x: xi, y: yi };
    buildStarsCard(); viewer.draw(); return;
  }
  if (P.frame !== 0) { setStatus('stRun', 'Stars are picked on the first frame; showing it now.'); showFrame(0); return; }
  const { data, width: w, height: hh } = P.cur;
  const near = P.stars.findIndex((s) => Math.hypot(s.x - x, s.y - y) < 6);
  if (near >= 0) { P.stars.splice(near, 1); }
  else { const c = centroidIter(data, w, hh, x, y, 8); P.stars.push(c[2] > 0 ? { x: c[0], y: c[1], peak: data[Math.round(c[1]) * w + Math.round(c[0])] } : { x, y, peak: NaN }); }
  P.result = null; buildStarsCard(); viewer.draw();
}

function detect() {
  if (P.mode !== 'stack' || !P.cur) return;
  if (P.frame !== 0) { showFrame(0).then(detect); return; }
  const { data, width: w, height: hh } = P.cur, sat = saturationLevel(P.cur.header || {}).level, det = detectSources(data, w, hh, { max: 120, saturation: sat });
  P.detected = det.sources;
  if (!P.stars.length && det.sources.length) {
    // no target yet: the unsaturated star nearest the centre of the frame
    const mid = det.sources.filter((q) => !q.saturated).sort((a, b) => Math.hypot(a.x - w / 2, a.y - hh / 2) - Math.hypot(b.x - w / 2, b.y - hh / 2))[0];
    if (mid) P.stars.push({ x: mid.x, y: mid.y, peak: mid.peak });
  }
  P.suggest = [];
  if (P.stars.length) {
    const tg = P.stars[0], near = det.sources.reduce((b, q) => (Math.hypot(q.x - tg.x, q.y - tg.y) < Math.hypot(b.x - tg.x, b.y - tg.y) ? q : b), det.sources[0]);
    const f = fitPsf(data, w, hh, tg.x, tg.y, 8, { model: 'gaussian', rotate: true }), fwhm = f.ok ? psfShape(f).fwhm : 4;
    // the shape of the brightest 40 candidates, so blends, galaxies and trailed stars can be told apart
    const shaped = det.sources.map((q, i) => { if (i >= 40 || q.saturated) return q; const g = fitPsf(data, w, hh, q.x, q.y, Math.max(5, Math.round(2 * fwhm)), { model: 'gaussian', rotate: true, sigma: fwhm / 2.3548 }); return g.ok ? { ...q, ...psfShape(g) } : q; });
    P.suggest = rankComparisons(shaped, { x: tg.x, y: tg.y, flux: near ? near.flux : 1 }, { w, h: hh, fwhm, saturation: sat }).filter((q) => !P.stars.some((st) => Math.hypot(st.x - q.x, st.y - q.y) < 3)).slice(0, 10);
    if (P.stars.length === 1) for (const c of P.suggest.filter((q) => q.usable).slice(0, 4)) P.stars.push({ x: c.x, y: c.y, peak: c.peak });
    P.suggest = P.suggest.filter((q) => !P.stars.some((st) => Math.hypot(st.x - q.x, st.y - q.y) < 3));
  }
  P.result = null; buildStarsCard(); viewer.draw();
  setStatus('stRun', `${det.sources.length} stars found (sky ${det.background.toFixed(0)}, noise ${det.sigma.toFixed(1)} per pixel).`);
}

/** Add a star where the inspector points (refined by a centroid on the first frame, where stars are defined). */
async function addStarAt(x, y, asTarget) {
  if (P.mode !== 'stack') return;
  if (P.frame !== 0) await showFrame(0);
  const { data, width: w, height: hh } = P.cur, c = centroidIter(data, w, hh, x, y, 8), st = c[2] > 0 ? { x: c[0], y: c[1], peak: data[Math.round(c[1]) * w + Math.round(c[0])] } : { x, y, peak: NaN };
  const at = P.stars.findIndex((q) => Math.hypot(q.x - st.x, q.y - st.y) < 3); if (at >= 0) P.stars.splice(at, 1);
  if (asTarget) P.stars.unshift(st); else P.stars.push(st);
  P.result = null; buildStarsCard(); viewer.draw();
  setStatus('stRun', asTarget ? 'Target set. Pick comparison stars, or let "Suggest comparisons" rank them.' : `Comparison C${P.stars.length - 1} added.`);
}

function buildStarsCard() {
  const el = $('cardStars'); el.innerHTML = '';
  if (P.mode === 'tpf') {
    const t = P.tpf, pm = pipelineMask(t), nc = P.customMask.reduce((a, b) => a + b, 0);
    el.append(h('h2', {}, 'Target pixel file'),
      h('p', { class: 'hint' }, h('b', {}, t.object || P.tpfName), ` · ${t.mission}${t.sector != null ? ' sector ' + t.sector : ''}${t.quarter != null ? (t.mission === 'K2' ? ' campaign ' : ' quarter ') + t.quarter : ''} · ${t.ncad} cadences of ${t.nx} × ${t.ny} px · ${Number.isFinite(t.exptime) ? (t.cadence * 1440).toFixed(t.cadence * 1440 < 1 ? 2 : 1) + ' min' : ''}`),
      h('p', { class: 'hint' }, pm ? `The pipeline aperture (${pm.reduce((a, b) => a + b, 0)} px) is outlined. It, its dilations, threshold masks and circles are all tried.` : 'No pipeline aperture in this file: threshold masks and circles are tried.', t.bkgSubtracted ? '' : ' Fluxes are not background-subtracted here, so the sky is taken from the pixels outside each aperture.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm' + (P.pixelMode ? ' on' : ''), onclick: () => { P.pixelMode = !P.pixelMode; buildStarsCard(); } }, P.pixelMode ? 'Clicking toggles pixels' : 'Draw my own aperture'),
        nc ? h('button', { class: 'btn sm', onclick: () => { P.customMask.fill(0); buildStarsCard(); viewer.draw(); } }, `Clear ${nc} px`) : null),
      h('p', { class: 'hint', style: 'margin-top:8px' }, P.pixelMode ? 'Click pixels to add or remove them; your aperture is tried with the others.' : P.tpfTarget ? `Target set at pixel (${P.tpfTarget.x}, ${P.tpfTarget.y}).` : 'Click a pixel to say where the target is (default: the brightest pixel of the pipeline aperture).'));
    return;
  }
  el.append(h('h2', {}, 'Stars'));
  if (!P.stars.length) el.append(h('p', { class: 'hint' }, 'Click the target on the first frame, then one or more comparison stars. Click a star again to remove it.'));
  const sat = P.cur && P.cur.header && P.cur.header.BITPIX === 16 ? 60000 : Infinity;
  el.append(h('ul', { class: 'stars' }, P.stars.map((s, i) => h('li', { class: i ? 'c' : 't' }, h('b', {}, i ? 'C' + i : 'T'), h('span', {}, `${s.x.toFixed(1)}, ${s.y.toFixed(1)}${Number.isFinite(s.peak) ? '   peak ' + s.peak.toFixed(0) : ''}`), s.peak >= sat ? h('span', { style: 'color:var(--warn);flex:none', title: 'Near the 16-bit limit: this star may be saturated' }, 'sat?') : null, h('button', { title: 'Remove', 'aria-label': `Remove ${i ? 'comparison star C' + i : 'the target'}`, onclick: () => { P.stars.splice(i, 1); P.result = null; buildStarsCard(); viewer.draw(); } }, '✕')))));
  el.append(h('div', { class: 'row' },
    h('button', { class: 'btn sm', onclick: detect, title: 'Find stars on the first frame and rank comparison stars: similar brightness, unsaturated, isolated, away from the edge, with a normal round profile' }, P.stars.length === 1 ? 'Suggest comparisons' : 'Detect stars'),
    P.stars.length ? h('button', { class: 'btn sm', onclick: () => { P.stars = []; P.result = null; buildStarsCard(); viewer.draw(); } }, 'Clear') : null));
  if (P.stars.length === 1) el.append(h('p', { class: 'warnline' }, 'With no comparison star the light curve is the target alone: fine from space, rarely from the ground.'));
  if (P.suggest && P.suggest.length) el.append(h('details', { class: 'sugg', open: P.stars.length < 3 }, h('summary', {}, `Other candidates, best first (${P.suggest.length})`),
    h('ul', { class: 'stars' }, P.suggest.map((q) => h('li', { class: q.usable ? 'c' : 'bad' }, h('span', {}, `${q.x.toFixed(0)}, ${q.y.toFixed(0)}  ${q.ratio >= 1 ? q.ratio.toFixed(1) + '× brighter' : (1 / q.ratio).toFixed(1) + '× fainter'}${q.notes.length ? ' · ' + q.notes.filter((n) => !/fainter|brighter/.test(n)).join(', ') : ''}`),
      h('button', { title: 'Add as a comparison star', 'aria-label': `Add the star at ${q.x.toFixed(0)}, ${q.y.toFixed(0)} as a comparison`, onclick: () => { P.stars.push({ x: q.x, y: q.y, peak: q.peak }); P.suggest = P.suggest.filter((z) => z !== q); P.result = null; buildStarsCard(); viewer.draw(); } }, '+'))))));
  $('runNote').textContent = P.stars.length ? '' : 'pick the target first';
}

function buildSettings() {
  const el = $('cardSet'); el.innerHTML = '';
  if (P.mode === 'tpf') { el.hidden = true; return; }
  el.hidden = false;
  const p0 = P.lights.length ? framePointing(P.lights[0].header) : {}, v = (x, d = 5) => (Number.isFinite(x) ? String(+x.toFixed(d)) : '');
  const nCal = P.cal.bias.length + P.cal.dark.length + P.cal.flat.length;
  el.append(h('details', { class: 'set', open: true },
    h('summary', {}, 'Settings'),
    h('div', { class: 'grid2' },
      h('label', {}, 'Aperture radii (× PSF σ): from, to, how many', h('div', { class: 'row3' }, h('input', { type: 'number', id: 'sA0', value: 1.5, step: 0.1, min: 0.5, inputmode: 'decimal', title: 'from', 'aria-label': 'Smallest aperture radius, in PSF sigma' }), h('input', { type: 'number', id: 'sA1', value: 6, step: 0.5, inputmode: 'decimal', title: 'to', 'aria-label': 'Largest aperture radius, in PSF sigma' }), h('input', { type: 'number', id: 'sAn', value: 12, min: 1, max: 40, inputmode: 'numeric', title: 'how many', 'aria-label': 'Number of aperture radii' }))),
      h('label', {}, 'Sky annulus width (× σ): from, to, how many', h('div', { class: 'row3' }, h('input', { type: 'number', id: 'sN0', value: 6, step: 0.5, min: 1, inputmode: 'decimal', title: 'from', 'aria-label': 'Narrowest sky annulus, in PSF sigma' }), h('input', { type: 'number', id: 'sN1', value: 15, step: 0.5, inputmode: 'decimal', title: 'to', 'aria-label': 'Widest sky annulus, in PSF sigma' }), h('input', { type: 'number', id: 'sNn', value: 4, min: 1, max: 20, inputmode: 'numeric', title: 'how many', 'aria-label': 'Number of sky annulus widths' }))),
      h('label', { title: 'PSF photometry competes with the apertures in the same table. The Gaussian has a free position angle, as in EXOTIC.' }, 'PSF photometry', h('select', { id: 'sPsf' }, h('option', { value: 'both' }, 'Gaussian + Moffat'), h('option', { value: 'gaussian' }, 'Gaussian'), h('option', { value: 'moffat' }, 'Moffat'), h('option', { value: 'none' }, 'none'))),
      h('label', { title: 'Optimal extraction (Naylor 1998): pixels weighted by the PSF profile, one profile for every star of a frame. Elliptical apertures follow the first frame\'s PSF when it is elongated by more than 25% (trailed or astigmatic stars).' }, 'Also try', h('span', { class: 'row', style: 'gap:10px;padding-top:3px' }, h('label', { style: 'flex-direction:row;gap:4px' }, h('input', { type: 'checkbox', id: 'sOpt', checked: true }), 'optimal'), h('label', { style: 'flex-direction:row;gap:4px' }, h('input', { type: 'checkbox', id: 'sEll' }), 'ellipses'))),
      h('label', { title: 'Where in the exposure the header time is. The FITS standard says DATE-OBS is the start; EXOTIC adds half an exposure only when the keyword comment says "start".' }, 'Header time is the', h('select', { id: 'sAt' }, h('option', { value: 'start' }, 'start of exposure'), h('option', { value: 'mid' }, 'middle'), h('option', { value: 'exotic' }, "EXOTIC's rule"))),
      h('label', { title: 'Degrees, or hh mm ss. Needed to turn UTC into BJD_TDB.' }, 'Target RA', h('input', { type: 'text', id: 'sRa', value: v(p0.ra), placeholder: 'deg or hh mm ss' })),
      h('label', {}, 'Target Dec', h('input', { type: 'text', id: 'sDec', value: v(p0.dec), placeholder: 'deg or dd mm ss' })),
      h('label', { title: 'Only used to compute the airmass when the header has none.' }, 'Site latitude', h('input', { type: 'text', id: 'sLat', value: v(p0.lat, 4), placeholder: 'deg' })),
      h('label', {}, 'Site longitude (E +)', h('input', { type: 'text', id: 'sLon', value: v(p0.lon, 4), placeholder: 'deg' })),
      h('label', {}, 'Baseline', h('select', { id: 'sOrd' }, h('option', { value: 1 }, 'airmass (or linear in time)'), h('option', { value: 2 }, '+ quadratic in time'))),
      h('label', { class: 'full', title: 'How each candidate light curve is scored. Quick: a trapezoid found by a grid, no knowledge of the planet. Transit model: the real model times a1 exp(a2 airmass), least squares inside the bounds EXOTIC uses; needs the planet\'s parameters and a few seconds.' }, 'Score each candidate with', h('select', { id: 'sScore', onchange: () => { $('planetBox').hidden = $('sScore').value !== 'transit'; } }, h('option', { value: 'quick' }, 'a quick trapezoid fit'), h('option', { value: 'transit' }, "the transit model (EXOTIC's fit)"))),
      h('div', { class: 'full grid2', id: 'planetBox', hidden: true },
        ...[['pPer', 'Period [d]', 'per'], ['pTmid', 'Mid-transit [BJD]', 'tmid'], ['pRprs', 'Rp/R★', 'rprs'], ['pArs', 'a/R★', 'ars'], ['pInc', 'Inclination [°]', 'inc'], ['pEcc', 'Eccentricity', 'ecc'], ['pOm', 'ω [°]', 'omega'], ['pTu', 'Mid-transit uncertainty [d]', 'tmidUnc']].map(([id, lab, k]) => h('label', {}, lab, h('input', { type: 'text', id, inputmode: k === 'omega' ? null : 'decimal', autocomplete: 'off', value: P.planet && P.planet[k] != null ? String(P.planet[k]) : (k === 'ecc' ? '0' : k === 'omega' ? '0' : k === 'tmidUnc' ? '0.01' : '') }))),
        h('label', { class: 'full', title: 'Four coefficients of the Claret law. The default is a G star in a red band (HD 80606 in the TESS band from ExoTETHyS); the choice hardly matters for ranking apertures.' }, 'Limb darkening (Claret a1..a4)', h('input', { type: 'text', id: 'pLd', value: (P.planet && P.planet.ld ? P.planet.ld : [0.4939, -0.0729, 0.4578, -0.2158]).join(', ') }))),
      h('label', { title: 'Electrons per count, for the photon-noise limit in the diagnostics. Taken from GAIN or EGAIN in the header when present.' }, 'Gain [e⁻/ADU]', h('input', { type: 'text', id: 'sGain', inputmode: 'decimal', autocomplete: 'off', value: P.lights.length && Number(P.lights[0].header.GAIN ?? P.lights[0].header.EGAIN) > 0 ? String(Number(P.lights[0].header.GAIN ?? P.lights[0].header.EGAIN)) : '', placeholder: 'unknown' })),
      nCal ? h('label', {}, 'Calibration', h('select', { id: 'sCal' }, h('option', { value: 1 }, `use ${P.cal.bias.length} bias, ${P.cal.dark.length} dark, ${P.cal.flat.length} flat`), h('option', { value: 0 }, 'ignore'))) : h('label', {}, 'Calibration', h('span', { class: 'dim', style: 'padding-top:4px' }, 'no darks / flats found')))));
}
const angle = (s, hours = false) => { s = String(s || '').trim(); if (!s) return NaN; if (/^[+-]?\d+(\.\d*)?$/.test(s)) return +s; const p = s.split(/[:\s]+/).map(Number); if (p.some((x) => !Number.isFinite(x))) return NaN; const v = (Math.abs(p[0]) + (p[1] || 0) / 60 + (p[2] || 0) / 3600) * (/^-/.test(s) ? -1 : 1); return hours ? v * 15 : v; };

// ------------------------------------------------------------------------------------------- overlay
function drawOverlay(c, v) {
  c.lineWidth = 1.5; c.font = '11px ui-monospace, Menlo, monospace';
  if (P.mode === 'tpf') {
    const t = P.tpf, outline = (mask, color, dash) => {
      c.strokeStyle = color; c.setLineDash(dash || []); c.beginPath();
      for (let y = 0; y < t.ny; y++) for (let x = 0; x < t.nx; x++) {
        if (!mask[y * t.nx + x]) continue;
        const [x0, y1] = v.toScreen(x - 0.5, y - 0.5), [x1, y0] = v.toScreen(x + 0.5, y + 0.5), on = (xx, yy) => xx >= 0 && yy >= 0 && xx < t.nx && yy < t.ny && mask[yy * t.nx + xx];
        if (!on(x - 1, y)) { c.moveTo(x0, y0); c.lineTo(x0, y1); } if (!on(x + 1, y)) { c.moveTo(x1, y0); c.lineTo(x1, y1); }
        if (!on(x, y - 1)) { c.moveTo(x0, y1); c.lineTo(x1, y1); } if (!on(x, y + 1)) { c.moveTo(x0, y0); c.lineTo(x1, y0); }
      }
      c.stroke(); c.setLineDash([]);
    };
    const pm = pipelineMask(t), selMask = P.result && P.sel >= 0 ? P.result.opt.tried[P.sel].mask : null;
    if (pm && !selMask) outline(pm, PHOT_THEME.star);
    if (pm && selMask) outline(pm, '#ffc56b66', [3, 3]);
    if (selMask) outline(selMask, PHOT_THEME.ok);
    if (P.customMask.some((x) => x)) outline(P.customMask, PHOT_THEME.model, [5, 3]);
    const tg = P.tpfTarget || (P.result && P.result.opt.target);
    if (tg) { const [sx, sy] = v.toScreen(tg.x, tg.y); c.strokeStyle = PHOT_THEME.bad; c.beginPath(); c.moveTo(sx - 6, sy); c.lineTo(sx + 6, sy); c.moveTo(sx, sy - 6); c.lineTo(sx, sy + 6); c.stroke(); }
    return;
  }
  for (const s of P.detected) { const [sx, sy] = v.toScreen(s.x, s.y); c.strokeStyle = '#8491ad88'; c.lineWidth = 1; c.beginPath(); c.arc(sx, sy, 4, 0, 6.2832); c.stroke(); }
  const R = P.result && P.result.kind === 'stack' ? P.result : null, row = R && P.sel >= 0 ? R.opt.tried[P.sel] : null, M = R && R.M, L = P.live, lp = L && L.pos.get(P.frame), lm = L && L.msg;
  const k = R ? R.frameOf.get(P.frame) : undefined, isAp = row && (row.method === 'aperture' || row.method === 'ellipse');
  const rA = isAp ? row.aperture : R ? 3 * R.sigma : lm ? lm.liveAperture : 8, rIn = isAp ? rA + M.gap : lm ? rA + lm.gap : rA + 4, rOut = isAp ? rIn + row.annulus : lm ? rIn + lm.liveAnnulus : rIn + 8;
  P.stars.forEach((s, i) => {
    let x = s.x, y = s.y, known = P.frame === 0;
    if (M && k != null) { x = M.x[k * M.nS + i]; y = M.y[k * M.nS + i]; known = true; }
    else if (lp) { x = lp[2 * i]; y = lp[2 * i + 1]; known = true; }
    const [sx, sy] = v.toScreen(x, y), col = i ? PHOT_THEME.model : PHOT_THEME.star;
    c.globalAlpha = known ? 1 : 0.35; c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash([]);
    c.beginPath(); c.arc(sx, sy, Math.max(3, rA * v.scale), 0, 6.2832); c.stroke();
    c.setLineDash([4, 4]); c.lineWidth = 1; c.beginPath(); c.arc(sx, sy, rIn * v.scale, 0, 6.2832); c.stroke(); c.beginPath(); c.arc(sx, sy, rOut * v.scale, 0, 6.2832); c.stroke(); c.setLineDash([]);
    c.fillStyle = col; c.fillText(i ? 'C' + i : 'T', sx + Math.max(3, rA * v.scale) + 3, sy - 3); c.globalAlpha = 1;
  });
}

// ------------------------------------------------------------------------------------------- running
const numOf = (id) => { const el = $(id); if (!el) return NaN; const v = parseFloat(String(el.value).trim()); return Number.isFinite(v) ? v : NaN; };
function planetFromForm() {
  if (!$('sScore') || $('sScore').value !== 'transit') return null;
  const pl = { per: numOf('pPer'), tmid: numOf('pTmid'), rprs: numOf('pRprs'), ars: numOf('pArs'), inc: numOf('pInc'), ecc: numOf('pEcc') || 0, omega: numOf('pOm') || 0, tmidUnc: numOf('pTu') || 0.01, perUnc: 0, ld: String($('pLd').value).split(/[,\s]+/).map(Number).filter(Number.isFinite).slice(0, 4) };
  while (pl.ld.length < 4) pl.ld.push(0);
  if (![pl.per, pl.tmid, pl.rprs, pl.ars, pl.inc].every(Number.isFinite)) throw new Error('To score with the transit model, fill in the period, mid-transit time, Rp/R★, a/R★ and inclination (or choose the quick fit).');
  return pl;
}

async function run() {
  if (P.busy) return;
  if (P.mode === 'stack' && !P.stars.length) { setStatus('stRun', 'Click the target star on the first frame.', 'err'); return; }
  if (playT) togglePlay(); stopBlink();
  P.busy = true; $('bRun').disabled = true; $('bStop').hidden = P.mode !== 'stack'; $('prog').hidden = false; $('prog').value = 0; setStatus('stRun', 'Working…');
  const t0 = performance.now();
  try {
    if (P.mode === 'tpf') {
      const cfg = { x: P.tpfTarget?.x, y: P.tpfTarget?.y, customMask: P.customMask.some((x) => x) ? P.customMask : null };
      const res = await call({ type: 'tpf', buffer: P.tpfBuffer, cfg });
      P.result = res; P.sel = res.opt.best; P.gp = null;
      if (P.sel < 0) throw new Error('No aperture gave a usable light curve.');
      setTpfLc(P.sel);
      setStatus('stRun', `${res.opt.tried.length} apertures tried in ${res.timing.optimise.toFixed(0)} ms (file decoded in ${res.timing.read.toFixed(0)} ms).`, 'ok');
    } else {
      const num = (id, d) => { const x = +$(id).value; return Number.isFinite(x) && x > 0 ? x : d; };
      const planet = planetFromForm();
      const cfg = {
        stars: P.stars.map((s) => ({ x: s.x, y: s.y })), nAper: Math.round(num('sAn', 12)), nAnn: Math.round(num('sNn', 4)), aperRange: [num('sA0', 1.5), num('sA1', 6)], annRange: [num('sN0', 6), num('sN1', 15)],
        psf: $('sPsf').value, optimal: $('sOpt').checked, ellipse: $('sEll').checked ? 'auto' : false, score: planet ? 'transit' : 'quick', planet, gain: numOf('sGain') > 0 ? numOf('sGain') : undefined,
        timeAt: $('sAt').value, target: { ra: angle($('sRa').value, true), dec: angle($('sDec').value) }, site: { lat: angle($('sLat').value), lon: angle($('sLon').value) }, fit: { order: +$('sOrd').value },
      };
      const useCal = $('sCal') && $('sCal').value === '1';
      startLive(P.lights.length);
      const res = await call({ type: 'stack', files: P.lights.map((l) => l.file), cfg, cal: useCal ? P.cal : null }, onLive);
      res.frameOf = new Map(); let li = 0; for (const f of res.frames) { if (f.index != null) res.frameOf.set(li, f.index); li++; }
      res.fitOpts = { ...(res.opt.fitOpts || {}), order: cfg.fit.order, airmass: res.M.airmass.subarray(0, res.M.count).every(Number.isFinite) ? res.M.airmass.subarray(0, res.M.count) : null };
      res.fitter = res.usedTransit ? makeFitter(cfg) : null; res.cfg = cfg; res.gainKnown = cfg.gain > 0 || !!(res.meta && res.meta.gain); res.fitOpts.gain = cfg.gain || (res.meta && res.meta.gain) || 1;
      P.result = res; P.sel = res.opt.best; P.gp = null;
      if (P.sel < 0) throw new Error('No aperture gave a usable light curve.');
      setStackLc(P.sel);
      const fps = res.M.count / ((res.timing.read + res.timing.measure) / 1000);
      setStatus('stRun', `${res.M.count} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s (${fps.toFixed(1)} frames/s: reading ${(res.timing.read / res.M.count).toFixed(0)} ms, measuring ${(res.timing.measure / res.M.count).toFixed(0)} ms per frame; search over ${res.opt.tried.length} candidates ${(res.timing.optimise / 1000).toFixed(2)} s)${res.relocated ? `; field re-found ${res.relocated}×` : ''}.`, 'ok');
    }
    $('live').hidden = true; P.live = null;
    renderResults(); viewer.draw();
  } catch (err) { setStatus('stRun', String(err.message || err), 'err'); if (P.live) P.live.failed = true; }
  P.busy = false; $('bRun').disabled = false; $('bStop').hidden = true; $('prog').hidden = true;
}

// ------------------------------------------------------------------------------------------- live view of a running stack
// Everything the worker reports per frame is drawn as it arrives: the frame with the apertures on the tracked
// stars, a running light curve (target over comparisons at about 3 sigma), centroid, sky, FWHM, airmass, the time
// left; then the search table as it fills.
function startLive(n) {
  const el = $('live'); el.hidden = false; el.innerHTML = '';
  const cv = () => h('canvas');
  const L = P.live = { n, k: 0, t: [], ratio: [], x: [], y: [], sky: [], fwhm: [], am: [], rot: [], pos: new Map(), rows: [], best: -1, total: 0, done: 0, lastShow: 0, lastDraw: 0, cLc: cv(), cXY: cv(), cSky: cv(), cFw: cv(), cAm: cv(), info: h('div', { class: 'liveinfo mono' }), tbl: h('div', { class: 'livetbl' }), msg: null, reloc: 0 };
  el.append(h('h2', {}, 'Measuring'), L.info,
    h('div', { class: 'plots' }, h('div', { class: 'card' }, L.cLc), h('div', { class: 'stack' }, h('div', { class: 'card' }, L.cXY), h('div', { class: 'card' }, L.cSky))),
    h('div', { class: 'plots two' }, h('div', { class: 'card' }, L.cFw), h('div', { class: 'card' }, L.cAm)),
    h('div', { class: 'card tried' }, h('h2', {}, 'Search over apertures, annuli, comparison stars and methods'), L.tbl));
  L.tbl.textContent = 'starts when the last frame has been measured';
}
const fmtSec = (s) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);
const compName = (c, n) => (c === 'w' ? `${n} weighted` : c < 0 ? 'none' : c === 0 ? `all ${n}` : 'C' + c);
function onLive(p) {
  const L = P.live; if (!L) return;
  const now = performance.now();
  if (p.stage === 'frames') {
    $('prog').value = p.done / p.total;
    L.k = p.done; L.t.push(p.jd); L.ratio.push(p.live); L.x.push(p.x); L.y.push(p.y); L.sky.push(p.sky); L.fwhm.push(p.fwhm); L.am.push(p.airmass); L.rot.push(p.rot); L.pos.set(p.file, p.pos); L.msg = p; if (p.relocated) L.reloc++;
    setStatus('stRun', `Frame ${p.done} / ${p.total}   ${p.name}`);
    if (now - L.lastShow > 220 || p.done === p.total) { L.lastShow = now; showFrame(p.file); }
  } else if (p.stage === 'optimise') {
    if (p.restart) L.rows = [];
    for (const r of p.rows) L.rows.push(r); L.best = p.best; L.total = p.total; L.done = p.done;
    $('prog').value = p.done / p.total; setStatus('stRun', `Trying candidates ${p.done} / ${p.total}`);
  } else { setStatus('stRun', `Master ${p.stage}: ${p.done} / ${p.total}`); return; }
  if (now - L.lastDraw > 90 || (p.stage === 'frames' && p.done === p.total) || (p.stage === 'optimise' && p.done === p.total)) { L.lastDraw = now; drawLive(); }
}
function drawLive() {
  const L = P.live; if (!L || !L.msg) return;
  const p = L.msg, th = PHOT_THEME, x = L.t.some((v) => !Number.isFinite(v)) ? L.t.map((_, i) => i) : L.t, off = Number.isFinite(x[0]) && x[0] > 1e5 ? Math.floor(x[0]) : 0, xl = off ? `JD − ${off}` : 'frame';
  L.info.textContent = `frame ${L.k} / ${L.n}   ${(L.k / p.elapsed).toFixed(1)} frames/s   ${L.k < L.n ? fmtSec(p.eta) + ' left' : 'frames done in ' + fmtSec(p.elapsed)}   PSF σ ${p.sigma.toFixed(2)} px   live aperture ${p.liveAperture.toFixed(1)} px${L.reloc ? `   field re-found ${L.reloc}×` : ''}${Math.abs(p.rot) > 0.05 ? `   field rotation ${p.rot.toFixed(2)}°` : ''}`;
  const med = medianOf(L.ratio.filter(Number.isFinite)) || 1;
  let g = fitCanvas(L.cLc, 316); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: L.ratio.map((v) => v / med), color: th.data, kind: 'dots', label: P.stars.length > 1 ? 'target / comparisons' : 'target' }], xLabel: xl, yLabel: 'relative flux', xOffset: off, title: 'Running light curve (before the search)' }, th);
  g = fitCanvas(L.cXY, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: L.x.map((v) => v - L.x[0]), color: th.star, kind: 'dots', label: 'x' }, { y: L.y.map((v) => v - L.y[0]), color: th.model, kind: 'dots', label: 'y' }], yLabel: 'px', xOffset: off, title: 'Centroid drift of the target' }, th);
  g = fitCanvas(L.cSky, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: L.sky, color: th.warn, kind: 'dots' }], yLabel: 'counts / px', xOffset: off, title: 'Sky background' }, th);
  g = fitCanvas(L.cFw, 130); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: L.fwhm, color: th.post, kind: 'dots' }], yLabel: 'px', xOffset: off, title: 'FWHM of the target' }, th);
  g = fitCanvas(L.cAm, 130); const hasAm = L.am.some(Number.isFinite); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: hasAm ? L.am : L.rot, color: th.ok, kind: 'dots' }], yLabel: hasAm ? 'sec z' : 'deg', xOffset: off, title: hasAm ? 'Airmass' : 'Field rotation' }, th);
  if (L.rows.length) {
    const nC = P.stars.length - 1, top = L.rows.map((r, i) => ({ r, i })).filter((q) => Number.isFinite(q.r.scatter)).sort((a, b) => a.r.scatter - b.r.scatter).slice(0, 8), b = L.best >= 0 ? L.rows[L.best] : null;
    L.tbl.innerHTML = '';
    L.tbl.append(h('p', { class: 'hint' }, `${L.done} of ${L.total} candidates tried` + (b ? `. Best so far: ${METHOD_LABEL[b.method]}${b.aperture ? ` ${b.aperture.toFixed(2)} px, annulus ${b.annulus.toFixed(2)} px` : ''}, comparison ${compName(b.comp, nC)}, scatter ${(100 * b.scatter).toFixed(3)}%.` : '.')),
      h('table', {}, h('thead', {}, h('tr', {}, ['method', 'aperture [px]', 'annulus [px]', 'comparison', 'scatter [%]', 'points'].map((t) => h('th', {}, t)))), h('tbody', {}, top.map(({ r }) => h('tr', {}, [METHOD_LABEL[r.method], r.aperture ? r.aperture.toFixed(2) : '—', r.annulus ? r.annulus.toFixed(2) : '—', compName(r.comp, nC), (100 * r.scatter).toFixed(4), r.n].map((v) => h('td', {}, v)))))));
  }
}

function setStackLc(i) {
  const R = P.result, row = R.opt.tried[i], lc = i === R.opt.best && R.opt.lc ? R.opt.lc : lightCurveFor(R.M, row, R.fitOpts, R.fitter);
  P.sel = i; P.gp = null;
  const cm = medianOf(Array.from(lc.comparison).filter((v) => Number.isFinite(v) && v > 0));
  P.lc = { kind: 'stack', comp: row.comp < 0 ? null : Float64Array.from(lc.comparison, (v) => v / cm), weights: lc.weights, time: lc.time, norm: lc.norm, err: lc.normErr, photErr: lc.photErr, photErrStar: lc.photErrStar, model: lc.model, baseline: lc.baseline, resid: lc.resid, keep: lc.keep, x: lc.x, y: lc.y, bg: lc.background, airmass: lc.airmass, fwhm: lc.fwhm, rot: lc.rot, exptime: medianOf(lc.exptime), fit: lc.fit, timeSystem: R.timeSystem };
}
function setTpfLc(i) {
  const R = P.result, row = R.opt.tried[i], lc = tpfLightCurve(P.tpf, row.mask, { quality: R.meta.quality }), good = []; for (let k = 0; k < lc.ok.length; k++) if (lc.ok[k]) good.push(k);
  const pick = (a) => Float64Array.from(good, (k) => a[k]), f = pick(lc.flux), med = medianOf(f), time = pick(lc.time), norm = f.map((v) => v / med), err = pick(lc.err).map((v) => v / med);
  // residuals for the diagnostics: flux over a running median of 0.75 d, outliers (flares, momentum dumps) set aside
  const cad = (time[time.length - 1] - time[0]) / Math.max(1, time.length - 1), win = Math.max(5, 2 * Math.floor(0.75 / cad / 2) + 1), sm = runningMedian(norm, win), resid = norm.map((v, k) => v / sm[k] - 1);
  const mad = 1.4826 * medianOf(Array.from(resid, Math.abs)), keep = Uint8Array.from(resid, (v) => (Math.abs(v) < 5 * mad ? 1 : 0));
  P.sel = i; P.gp = null;
  P.pld = null;
  P.lc = { kind: 'tpf', good, mask: row.mask, time, norm, err, photErr: err, x: pick(lc.x), y: pick(lc.y), bg: pick(lc.bkg), keep: null, keepR: keep, resid, smooth: sm, exptime: R.meta.exptime, timeSystem: 'BJD_TDB', median: med };
}

// ------------------------------------------------------------------------------------------- diagnostics
/** Residuals now (after any detrending) and before, the points to use, and what the two plots and the map need. */
function diagnose() {
  const lc = P.lc, n = lc.time.length, keep = lc.keep || lc.keepR, before = lc.resid;
  let after = null, trendPts = null;
  if (P.gp && (P.gp.kind === 'sff' || P.gp.kind === 'pld')) { const sm = runningMedian(P.gp.detrended, Math.max(5, 2 * Math.floor(0.75 / ((lc.time[n - 1] - lc.time[0]) / (n - 1)) / 2) + 1)); after = Float64Array.from(P.gp.detrended, (v, i) => v / sm[i] - 1); trendPts = Float64Array.from(before, (v, i) => v - after[i]); }
  else if (P.gp) { after = Float64Array.from(before, (v, i) => (Number.isFinite(P.gp.trend[i]) ? v - P.gp.trend[i] : NaN)); trendPts = P.gp.trend; }
  const cur = after || before, idx = []; for (let i = 0; i < n; i++) if ((!keep || keep[i]) && Number.isFinite(cur[i]) && Number.isFinite(lc.time[i]) && Number.isFinite(lc.x[i]) && Number.isFinite(lc.y[i])) idx.push(i);
  if (idx.length < 12) return null;
  const pick = (a) => Float64Array.from(idx, (i) => a[i]), t = pick(lc.time), r = pick(cur), r0 = pick(before), e = pick(lc.err), m = r.reduce((a, b) => a + b, 0) / r.length;
  for (let i = 0; i < r.length; i++) r[i] -= m;
  const dts = Float64Array.from({ length: t.length - 1 }, (_, i) => t[i + 1] - t[i]), dt = medianOf(dts);
  let sp;
  if (idx.length <= 3000) sp = lombScarglePsd(t, r);
  else {
    // Welch over the continuous stretches; when gaps (K2 thruster firings left out, downlinks) leave no stretch as long as a
    // segment, the Lomb-Scargle periodogram of all points instead
    const seg = splitSegments(t).segments; let np2 = 256; while (np2 * 8 <= idx.length && np2 < 4096) np2 *= 2;
    try { sp = welchPsd(r, dt, { nperseg: np2, segments: seg }); } catch { try { sp = welchPsd(r, dt, { nperseg: 128, segments: seg }); } catch { sp = lombScarglePsd(t, r); } }
  }
  const f = Array.from(sp.f).filter((v) => v > 0), p = Array.from(sp.p).slice(sp.p.length - f.length), lb = logBinPsd(f, p, 26);
  let fit = null; try { fit = fitRedNoise(lb.f, lb.p, { nAvg: lb.n }); } catch { fit = null; }
  const white = whiteNoiseLevel(e, sp.dt || dt), ph = lc.photErr ? medianOf(pick(lc.photErr).filter(Number.isFinite)) : NaN, phStar = lc.photErrStar ? medianOf(pick(lc.photErrStar).filter(Number.isFinite)) : NaN;
  const marks = [];
  if (P.result.kind === 'tpf' && P.result.meta.mission === 'K2') marks.push({ f: 24 / 5.88, label: 'K2 roll 5.9 h' });
  if (lc.fit && lc.fit.hasTransit && lc.fit.duration > 0) marks.push({ f: 1 / lc.fit.duration, label: `transit ${(lc.fit.duration * 24).toFixed(1)} h` });
  const rb = rmsVsBin(r, { dt, t });
  const g = Math.max(6, Math.min(24, Math.round(Math.sqrt(idx.length / 5)))), x = pick(lc.x), y = pick(lc.y), m0 = r0.reduce((a, b) => a + b, 0) / r0.length;
  const pm = pixelMap(x, y, r0, { nx: g, ny: g });
  let surface, sName;
  if (trendPts) { const tp = pick(trendPts), ok = tp.every(Number.isFinite); surface = ok ? pixelMap(x, y, tp, { nx: g, ny: g, range: [pm.grid.x0, pm.grid.x1, pm.grid.y0, pm.grid.y1] }).mean : null; sName = P.gp.kind === 'sff' ? 'self-flat-field correction (binned)' : P.gp.kind === 'pld' ? 'pixel-level decorrelation (binned)' : P.gp.kind === 'regress' ? 'decorrelation trend (binned)' : 'Gaussian-process trend (binned)'; }
  let poly = null; try { poly = polySurface(x, y, r0, 2, null, { grid: pm.grid }); } catch { poly = null; }
  if (!surface && poly) { surface = poly.surface; sName = 'order-2 polynomial surface (a fit, not removed)'; }
  return { n: idx.length, dt: sp.dt || dt, f, p, lb, fit, white, photon: Number.isFinite(ph) ? photonNoiseLevel(ph, sp.dt || dt) : null, photonStar: Number.isFinite(phStar) ? photonNoiseLevel(phStar, sp.dt || dt) : null, ph, phStar, marks, rb, pm, surface, sName, m0, x, y, poly, rms: Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length), detrended: !!after, method: idx.length <= 3000 ? 'Lomb-Scargle' : 'Welch' };
}

// ------------------------------------------------------------------------------------------- results
function renderResults() {
  const el = $('res'), R = P.result, lc = P.lc, row = R.opt.tried[P.sel], best = P.sel === R.opt.best; el.hidden = false; el.innerHTML = '';
  const card = (k, v, sub) => h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v', html: v + (sub ? ` <small>${sub}</small>` : '') }));
  const sum = h('div', { class: 'sum' }), isAp = row.method === 'aperture' || row.method === 'ellipse';
  if (R.kind === 'stack') {
    const pr = lc.fit.params;
    sum.append(card(best ? 'Best method' : 'Selected', METHOD_LABEL[row.method] || row.method),
      card('Aperture', isAp ? row.aperture.toFixed(2) + ' px' : '—', isAp ? `${(row.aperture / R.sigma).toFixed(2)} σ` : ''),
      card('Sky annulus', isAp ? `${(row.aperture + R.M.gap).toFixed(1)}–${(row.aperture + R.M.gap + row.annulus).toFixed(1)} px` : '—'),
      card('Comparison', compName(row.comp, R.M.nS - 1), row.comp === 'w' && row.weights ? 'weights ' + row.weights.map((w) => w.toFixed(2)).join(' : ') : ''),
      card('Residual scatter', (100 * row.scatter).toFixed(3) + ' %', `robust ${(100 * row.robust).toFixed(3)} %`),
      pr ? card('Transit fit', `R<sub>p</sub>/R<sub>★</sub> ${pr.rprs.toFixed(4)}`, `T<sub>mid</sub> ${pr.tmid.toFixed(5)}`) : card('Quick fit', lc.fit.hasTransit ? `depth ${(100 * lc.fit.depth).toFixed(2)} %` : 'no transit seen', lc.fit.hasTransit ? `${(lc.fit.duration * 24).toFixed(2)} h` : ''),
      card('Frames', String(R.M.count), `PSF σ ${R.sigma.toFixed(2)} px${R.relocated ? `, re-found ${R.relocated}×` : ''}`),
      card('Time', R.timeSystem === 'BJD_TDB' ? 'BJD<sub>TDB</sub>' : R.timeSystem === 'UTC' ? 'JD<sub>UTC</sub>' : R.timeSystem, R.frames.find((f) => f.keyword)?.keyword || ''));
  } else {
    const m = R.meta;
    sum.append(card(best ? 'Best aperture' : 'Selected', row.name), card('Pixels', String(row.npix)), card('Scatter', (1e6 * row.scatter).toFixed(0) + ' ppm', 'robust, about a 1 h smooth'),
      card('Cadences', String(lc.time.length), `of ${m.ncad}`), card('Median flux', lc.median.toFixed(0), 'e⁻/s'), card('Time', 'BJD<sub>TDB</sub>', m.mission));
  }
  el.append(h('h2', {}, 'Report'), sum);
  if (R.kind === 'stack' && R.timeSystem !== 'BJD_TDB') el.append(h('p', { class: 'warnline' }, R.timeSystem === 'none' ? 'These frames have no time keyword that could be read.' : `Times are ${R.timeSystem}, not BJD_TDB: enter the target's RA and Dec under Settings and measure again to convert.`));
  if (R.kind === 'stack' && R.scoreNote) el.append(h('p', { class: 'warnline' }, R.scoreNote));
  if (R.kind === 'stack' && !R.fitOpts.airmass) el.append(h('p', { class: 'note2' }, 'No airmass in the headers (and no site and target to compute it from), so the baseline is a line in time.'));
  const cFov = h('canvas'), cLc = h('canvas'), cRes = h('canvas'), cXY = h('canvas'), cBg = h('canvas'), cAm = h('canvas'), cFw = h('canvas'), cPsd = h('canvas'), cRms = h('canvas'), cMap = h('canvas');
  el.append(h('div', { class: 'plots report' }, h('div', { class: 'card' }, cFov), h('div', { class: 'card' }, cLc, cRes)),
    h('div', { class: 'plots four' }, h('div', { class: 'card' }, cXY), h('div', { class: 'card' }, cBg), h('div', { class: 'card' }, cAm), R.kind === 'stack' ? h('div', { class: 'card' }, cFw) : null));
  el.append(h('div', { class: 'out' },
    h('button', { class: 'btn', id: 'bGp', onclick: () => runDetrend('gp') }, 'Detrend with centroids (Gaussian process)'),
    h('button', { class: 'btn', id: 'bSff', title: 'Vanderburg & Johnson (2014): flux against the position along the roll, in windows of 6 days. Meant for K2.', onclick: () => runDetrend('sff') }, 'Self-flat-field (K2 roll)'),
    R.kind === 'tpf' ? h('button', { class: 'btn', id: 'bPld', title: 'Pixel-level decorrelation as EVEREST and lightkurve\'s PLDCorrector do it for K2: fractional pixel fluxes and their products to third order (16 principal components each), background pixels, a spline for the star, 5σ clipping; K2 thruster firings are left out. On K2-3 (campaign 1) the CDPP goes from 5822 to 40 ppm (lightkurve PLDCorrector 48 ppm).', onclick: () => runDetrend('pld') }, 'Pixel-level decorrelation (K2)') : null,
    R.kind === 'tpf' ? h('button', { class: 'btn', id: 'bPrepTpf', title: 'Mask the known transits, flatten with a biweight, clip, and cut a window around every transit (the owner\'s TOI extraction).', onclick: prepFromTpf }, 'Prepare for transit fitting…') : null,
    h('label', { class: 'dim', style: 'font-size:12px' }, h('input', { type: 'checkbox', id: 'gpTime' }), ' GP also against time'),
    P.gp ? h('button', { class: 'btn sm', onclick: () => { P.gp = null; renderResults(); } }, 'Undo detrending') : null,
    h('span', { class: 'dim', id: 'gpNote', style: 'font-size:12px' })),
    detrendCard());
  el.append(h('h2', { style: 'margin-top:14px' }, 'Is the noise white? Does the flux follow the star across the detector?'),
    h('div', { class: 'plots two' }, h('div', { class: 'card' }, cPsd), h('div', { class: 'card' }, cRms)), h('div', { class: 'card', style: 'margin-top:10px' }, cMap), h('p', { class: 'note2', id: 'diagNote' }));
  // tried table
  const tried = R.opt.tried.map((t, i) => ({ t, i })).sort((a, b) => (a.t.scatter - b.t.scatter) || 0), hasP = R.kind === 'stack' && R.opt.tried.some((t) => t.params);
  const head = R.kind === 'stack' ? ['method', 'aperture [px]', 'annulus [px]', 'comparison', 'scatter [%]', 'robust [%]', 'points', hasP ? 'Rp/R★' : 'depth [%]', ...(hasP ? ['T mid − ' + Math.floor(lc.time[0])] : [])] : ['aperture', 'pixels', 'scatter [ppm]', 'EXOTIC std [e⁻/s]', 'median flux', 'cadences'];
  const cells = (t) => (R.kind === 'stack'
    ? [METHOD_LABEL[t.method] || t.method, t.aperture ? t.aperture.toFixed(2) : '—', t.annulus ? t.annulus.toFixed(2) : '—', t.comp === 'w' ? 'weighted' : t.comp < 0 ? 'none' : t.comp === 0 ? 'all' : 'C' + t.comp, (100 * t.scatter).toFixed(4), (100 * t.robust).toFixed(4), t.n, hasP ? (t.params ? t.params.rprs.toFixed(4) : '—') : t.depth ? (100 * t.depth).toFixed(3) : '—', ...(hasP ? [t.params ? (t.params.tmid - Math.floor(lc.time[0])).toFixed(5) : '—'] : [])]
    : [t.name + (t.eligible ? '' : ' (too little flux)'), t.npix, (1e6 * t.scatter).toFixed(0), t.exotic.toFixed(2), t.flux.toFixed(0), t.n]);
  const tb = h('tbody', {}, tried.map(({ t, i }) => h('tr', { class: (i === R.opt.best ? 'best ' : '') + (i === P.sel ? 'sel ' : '') + (t.eligible === false ? 'inel' : ''), tabindex: i === P.sel ? 0 : -1, 'aria-selected': String(i === P.sel), onkeydown: triedKey, onclick: () => { R.kind === 'stack' ? setStackLc(i) : setTpfLc(i); renderResults(); viewer.draw(); } }, cells(t).map((v) => h('td', {}, v)))));
  const wins = R.kind === 'stack' ? Object.entries(tried.reduce((o, { t }) => { if (!(t.method in o)) o[t.method] = t.scatter; return o; }, {})).map(([m, v]) => `${METHOD_LABEL[m]} ${(100 * v).toFixed(3)}%`).join(' · ') : '';
  el.append(h('div', { class: 'card tried' }, h('h2', {}, `What was tried: ${tried.length} candidates, lowest scatter first (select a row to see it)`), wins ? h('p', { class: 'hint' }, 'Best of each method: ' + wins + (R.fitter ? '. Scored with the transit model.' : '. Scored with the quick trapezoid fit.')) : null, h('div', { class: 'scroll xscroll' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), tb))));
  el.append(h('div', { class: 'out' },
    h('button', { class: 'btn primary', onclick: openInAnalyze }, 'Open in Analyze'),
    h('button', { class: 'btn', onclick: saveCsv }, 'Save light curve (CSV)'),
    h('button', { class: 'btn', onclick: saveJson, title: 'Everything needed to repeat this reduction: software version, star positions, apertures, the row chosen, the table of what was tried, the frames and their times.' }, 'Save reduction settings (JSON)'),
    R.kind === 'stack' && lc.fit && lc.fit.params ? h('button', { class: 'btn', onclick: () => { const d = $('aavsoBox'); d.hidden = !d.hidden; }, title: "The AAVSO Exoplanet Watch report EXOTIC writes (the same format, character for character), for submission to the AAVSO Exoplanet Database." }, 'AAVSO report…') : null,
    h('label', { class: 'dim', style: 'font-size:12px' }, h('input', { type: 'checkbox', id: 'useGp', disabled: !P.gp }), ' export the detrended flux')),
  R.kind === 'stack' && lc.fit && lc.fit.params ? aavsoBox() : null,
  h('p', { class: 'note2' }, R.kind === 'stack'
    ? 'The exported flux is target / comparison divided by its median baseline, with the airmass of each frame so that the analyzer can fit the airmass trend itself. The uncertainty is the robust scatter of the residuals of the fit, the same for every point.'
    : 'The exported flux is the aperture sum divided by its median; uncertainties are the pipeline pixel errors added in quadrature. Stellar variability is left in: flatten it in the analyzer.'));
  const draw = () => {
    const x = lc.time, off = Math.floor(x[0]), xl = `${lc.timeSystem === 'BJD_TDB' ? 'BJD_TDB' : 'JD'} − ${off}`, th = PHOT_THEME;
    // field of view with the apertures of the chosen row
    let g = fitCanvas(cFov, 474);
    if (R.kind === 'stack') {
      const rA = isAp ? row.aperture : 3 * R.sigma, rIn = isAp ? rA + R.M.gap : rA + 4, rOut = isAp ? rIn + row.annulus : rIn + 8, used = row.comp === 'w' || row.comp === 0 ? null : row.comp < 0 ? [0] : [0, row.comp];
      const fr = frameCache.get(0) || (P.frame === 0 ? P.cur : null);
      if (fr) renderFov(g.ctx, g.W, g.H, { data: fr.data, width: fr.width, height: fr.height, stars: Array.from({ length: R.M.nS }, (_, s) => ({ x: R.M.x[s], y: R.M.y[s] })), rA, rIn, rOut, used, title: `Field of view, first frame${R.meta && R.meta.pixelScale ? ` (${R.meta.pixelScale.toFixed(2)}″/px)` : ''}` }, th);
      else { loadFrame(P.lights[0].file).then((f0) => { frameCache.set(0, f0); if (P.redraw === draw) draw(); }).catch(() => {}); }
    } else {
      const t = P.tpf, im = P.tpfMedian; renderFov(g.ctx, g.W, g.H, { data: im, width: t.nx, height: t.ny, stars: [], rA: 0, rIn: 0, rOut: 0, lo: 0, hi: 100, title: `Median image, ${t.nx} × ${t.ny} px (aperture outlined in the viewer above)` }, th);
    }
    const s = [{ y: lc.norm, color: th.data, kind: 'dots', mask: lc.keep, label: 'relative flux', err: lc.kind === 'stack' ? lc.err[0] : null }];
    if (lc.model) s.push({ y: lc.model, color: th.model, kind: 'line', label: R.fitter ? 'transit model × airmass' : 'quick fit' });
    if (P.gp) s.unshift({ y: P.gp.detrended, color: th.post, kind: 'dots', label: 'detrended', alpha: 0.9 }), s[1].alpha = 0.35;
    g = fitCanvas(cLc, R.kind === 'stack' ? 330 : 474); renderPanel(g.ctx, g.W, g.H, { x, series: s, yLabel: 'relative flux', xOffset: off, title: `${P.name}: ${R.kind === 'stack' ? (METHOD_LABEL[row.method] || row.method) : row.name}`, xLabel: R.kind === 'stack' ? null : xl }, th);
    if (R.kind === 'stack') { g = fitCanvas(cRes, 144); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: lc.resid.map((v) => 100 * v), color: th.data, kind: 'dots', mask: lc.keep }, { y: lc.resid.map(() => 0), color: th.model, kind: 'line', size: 1 }], yLabel: 'residual [%]', xOffset: off, xLabel: xl }, th); } else cRes.style.display = 'none';
    const mx = medianOf(lc.x), my = medianOf(lc.y);
    g = fitCanvas(cXY, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: lc.x.map((v) => v - mx), color: th.star, kind: 'dots', label: 'x' }, { y: lc.y.map((v) => v - my), color: th.model, kind: 'dots', label: 'y' }], yLabel: 'centroid [px]', xOffset: off, title: 'Centroid − median' }, th);
    g = fitCanvas(cBg, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: lc.bg, color: th.warn, kind: 'dots' }], yLabel: lc.kind === 'stack' ? 'counts / px' : 'e⁻/s / px', xOffset: off, title: 'Sky background' }, th);
    if (R.kind === 'stack') {
      const hasAm = lc.airmass.some(Number.isFinite), rotates = lc.rot.some((v) => Math.abs(v) > 0.05);
      g = fitCanvas(cAm, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: hasAm ? lc.airmass : lc.rot, color: th.ok, kind: 'dots' }], yLabel: hasAm ? 'sec z' : 'deg', xOffset: off, title: hasAm ? 'Airmass' : 'Field rotation' }, th);
      g = fitCanvas(cFw, 150); renderPanel(g.ctx, g.W, g.H, { x, series: rotates && hasAm ? [{ y: lc.rot, color: th.post, kind: 'dots' }] : [{ y: lc.fwhm, color: th.post, kind: 'dots' }], yLabel: rotates && hasAm ? 'deg' : 'px', xOffset: off, title: rotates && hasAm ? 'Field rotation since the first frame' : 'FWHM of the target' }, th);
    } else { g = fitCanvas(cAm, 150); renderPanel(g.ctx, g.W, g.H, { x, series: [{ y: lc.resid.map((v) => 1e6 * v), color: th.data, kind: 'dots', mask: lc.keepR }], yLabel: 'ppm', xOffset: off, title: 'Flux − 0.75 d running median' }, th); }
    // diagnostics
    const D = diagnose(); P.diag = D;
    if (D) {
      const ppm = lc.kind === 'tpf' || D.rms < 2e-3, sc = ppm ? 1e12 : 1e4, unit = ppm ? 'ppm' : '%', u1 = ppm ? 1e6 : 100;
      g = fitCanvas(cPsd, 300); renderPsd(g.ctx, g.W, g.H, { f: D.f, p: D.p, binned: D.lb, white: D.white, photon: lc.kind === 'stack' && !R.gainKnown && D.ph > D.rms ? null : D.photon, fit: D.fit, marks: D.marks, fUnit: '1/d', pScale: sc, yLabel: `PSD (${unit}² d)`, title: `Power spectrum of the residuals${D.detrended ? ' after detrending' : ''} (${D.method}, ${D.n} points)` }, th);
      g = fitCanvas(cRms, 300); renderRmsBin(g.ctx, g.W, g.H, { n: D.rb.n, rms: D.rb.rms, expected: D.rb.expected, rmsErr: D.rb.rmsErr, dt: D.dt, beta: { value: D.rb.beta, n: D.rb.nBeta }, scale: u1, unit, title: `Scatter against bin size${D.detrended ? ' after detrending' : ''}` }, th);
      g = fitCanvas(cMap, 330); renderPixelMap(g.ctx, g.W, g.H, { map: Float64Array.from(D.pm.mean, (v) => v - D.m0), surface: D.surface ? Float64Array.from(D.surface, (v) => v - (P.gp ? 0 : D.m0)) : null, x: D.x, y: D.y, grid: D.pm.grid, count: D.pm.count, title: `Pixel map: mean residual against the target's centroid (${D.n} points, ${D.pm.grid.nx} × ${D.pm.grid.ny} bins; before detrending)`, titles: ['binned residuals', D.sName || 'surface', 'binned residuals − surface'] }, th);
      const pct = (v) => (ppm ? (1e6 * v).toFixed(0) + ' ppm' : (100 * v).toFixed(3) + '%');
      $('diagNote').textContent = `Residual rms ${pct(D.rms)} per point. ` + (lc.kind === 'stack'
        ? (R.gainKnown ? `Expected from photon noise of the stars alone ${pct(D.phStar)}, with the measured sky noise under the aperture ${pct(D.ph)} (gain ${R.fitOpts.gain} e⁻/ADU; scintillation is not included). ` : D.ph > D.rms ? `The headers give no gain. At 1 e⁻/ADU photon noise alone would be ${pct(D.phStar)}, more than the scatter measured, so the camera's gain is at least ${((D.phStar / D.rms) ** 2).toFixed(1)} e⁻/ADU; enter it under Settings to see the photon-noise limit. ` : `The headers give no gain; at an assumed 1 e⁻/ADU photon noise would be ${pct(D.phStar)} (${pct(D.ph)} with the sky). `) + 'The error-bar line is the scatter used as the uncertainty of every point. '
        : `The pipeline's error bars (photon and read noise) give ${pct(medianOf(Array.from(lc.err)))}. `)
        + `β = ${D.rb.beta.toFixed(2)} at ${D.rb.nBeta} points per bin (1 for white noise; multiply error bars by β when the noise is correlated). `
        + (D.fit && D.fit.red ? `The spectrum rises towards low frequencies as f^−${D.fit.gamma.toFixed(1)} below ${D.fit.knee.toFixed(1)} per day.` : 'The spectrum shows no power-law rise.')
        + (D.poly ? ` An order-2 surface in (x, y) would take the rms from ${pct(D.poly.rmsBefore)} to ${pct(D.poly.rmsAfter)}.` : '');
    }
  };
  P.redraw = draw; draw();
  if (P.gp) $('gpNote').textContent = gpText(P.gp);
}
window.addEventListener('resize', () => { if (P.live && !$('live').hidden) drawLive(); if (P.redraw && !$('res').hidden) P.redraw(); });

const gpText = (g) => (g.kind === 'regress'
  ? `decorrelation against ${[...g.names, ...(g.kernel ? [`kernel regression on ${(g.spec.kernel.features || []).join(', ')} (${g.kernel} neighbours)`] : [])].join(', ')}: rms ${(1e6 * g.rmsBefore).toFixed(0)} → ${(1e6 * g.rmsAfter).toFixed(0)} ppm per point${Number.isFinite(g.hourAfter) ? `, ${(1e6 * g.hourBefore).toFixed(0)} → ${(1e6 * g.hourAfter).toFixed(0)} ppm in 1-hour bins` : ''}, ${g.n} points${g.dropped.length ? '; not used: ' + g.dropped.map((d) => `${d.name} (${d.why})`).join(', ') : ''}; ${g.ms.toFixed(0)} ms. A preview: the analyzer fits these together with the transit.`
  : g.kind === 'pld'
  ? `pixel-level decorrelation, order ${g.order} (${g.ncols} regressors: ${g.names.join('; ')}): CDPP ${g.cdppBefore.toFixed(0)} → ${g.cdppAfter.toFixed(1)} ppm (6.5 h, lightkurve's metric); ${g.clipped} cadences clipped${g.thrusters ? `, ${g.thrusters.dropped} thruster-firing cadences left out` : ''}; ${(g.ms / 1000).toFixed(1)} s`
  : g.kind === 'sff'
  ? `self-flat-field: robust scatter ${(1e6 * g.rmsBefore).toFixed(0)} → ${(1e6 * g.rmsAfter).toFixed(0)} ppm about a 1.5 d running median; ${g.windows} windows; ${g.ms.toFixed(0)} ms`
  : `residual rms ${(1e6 * g.rmsBefore).toFixed(0)} → ${(1e6 * g.rmsAfter).toFixed(0)} ppm; length scales ${g.hyper.scales.map((s, i) => s.toPrecision(2) + (i < 2 ? ' px' : ' d')).join(', ')}, amplitude ${(1e6 * g.hyper.amp).toFixed(0)} ppm, white noise ${(1e6 * g.hyper.noise).toFixed(0)} ppm; hyperparameters from ${g.nHyper} points, conditioned on ${g.nCond} of ${g.n}; ${(g.ms / 1000).toFixed(1)} s`);
async function runDetrend(kind) {
  const lc = P.lc; if (!lc || P.busy) return;
  $('bGp').disabled = true; $('bSff').disabled = true; if ($('bReg')) $('bReg').disabled = true; if ($('bPld')) $('bPld').disabled = true; $('gpNote').textContent = 'Fitting…';
  try {
    const payload = { time: lc.time, norm: lc.norm, resid: lc.kind === 'stack' ? lc.resid : null, keep: lc.keep || null, x: lc.x, y: lc.y };
    if (kind === 'regress') { payload.columns = lcColumns(); payload.norm = lc.norm; }
    let g;
    if (kind === 'pld') {
      const row = P.result.opt.tried[P.sel], r = await call({ type: 'pld', buffer: P.tpfBuffer, mask: row.mask, good: lc.good, opts: { order: 3, ncomp: 16, thrusters: P.tpf.mission === 'K2' } });
      const at = new Map(r.good.map((c, k) => [c, k])), det = Float64Array.from(lc.good, (c) => (at.has(c) ? r.corrected[at.get(c)] : NaN));
      g = { ...r, detrended: det, rmsBefore: r.cdppBefore * 1e-6, rmsAfter: r.cdppAfter * 1e-6 };
    } else g = await call(kind === 'sff' ? { type: 'sff', lc: payload, opts: {} } : kind === 'regress' ? { type: 'regress', lc: payload, spec: detrendSpec(), opts: {} } : { type: 'gp', lc: payload, opts: { useTime: $('gpTime').checked } });
    if (!g) throw new Error('Too few points with a centroid.');
    g.kind = kind; P.gp = g; const ut = $('gpTime').checked; renderResults(); $('gpTime').checked = ut;
  } catch (err) { $('gpNote').textContent = String(err.message || err); $('bGp').disabled = false; $('bSff').disabled = false; if ($('bReg')) $('bReg').disabled = false; if ($('bPld')) $('bPld').disabled = false; }
}

/** The reduced TPF light curve (detrended when "export the detrended flux" is ticked) into the long-light-curve view. */
function prepFromTpf() {
  const lc = P.lc, R = P.result, row = R.opt.tried[P.sel], t = P.tpf, useGp = P.gp && $('useGp') && $('useGp').checked, f = useGp ? P.gp.detrended : lc.norm;
  const part = { name: P.name, mission: t.mission, sector: t.sector, quarter: t.mission === 'Kepler' ? t.quarter : null, campaign: t.mission === 'K2' ? t.quarter : null, author: 'pixels', t: Float64Array.from(lc.time), f: Float64Array.from(f), e: Float64Array.from(lc.err), x: lc.x, y: lc.y, exptime: t.exptime, aperture: row.name, npix: row.npix, object: t.object, ra: t.ra, dec: t.dec, source: 'target pixel file', correction: useGp && P.gp.kind === 'pld' ? { method: 'PLD order ' + P.gp.order, before: P.gp.cdppBefore, after: P.gp.cdppAfter } : null };
  const o = String(t.object || ''), id = t.id, tg = P.archiveTarget || {};
  enterSeries([part], { name: tg.name || o || P.name, tic: tg.tic ?? (t.mission === 'TESS' ? +id : null), kic: tg.kic ?? (t.mission === 'Kepler' ? +id : null), epic: tg.epic ?? (t.mission === 'K2' ? +id : null), object: o });
}

// ------------------------------------------------------------------------------------------- export
function lcCsv({ columns = true } = {}) {
  const lc = P.lc, useGp = P.gp && $('useGp') && $('useGp').checked, f = useGp ? P.gp.detrended : lc.norm, am = lc.kind === 'stack' && lc.airmass.every(Number.isFinite) && !useGp;
  // the detrending columns travel with the light curve (the analyzer fits them with the transit; detrend.js)
  const cols = useGp || !columns ? {} : lcColumns(), names = Object.keys(cols), fmt = (v) => (Number.isFinite(v) ? +v.toPrecision(9) : '');
  const tcol = lc.timeSystem === 'BJD_TDB' ? 'BJD_TDB' : 'JD_UTC', rows = [`${tcol},flux,flux_err${am ? ',airmass' : ''}${names.map((n) => ',' + n).join('')}`];
  for (let i = 0; i < lc.time.length; i++) { if ((lc.keep && !lc.keep[i]) || !Number.isFinite(f[i]) || !Number.isFinite(lc.time[i])) continue; rows.push(`${lc.time[i].toFixed(7)},${f[i].toFixed(7)},${(Number.isFinite(lc.err[i]) ? lc.err[i] : 0).toFixed(7)}${am ? ',' + lc.airmass[i].toFixed(5) : ''}${names.map((n) => ',' + fmt(cols[n][i])).join('')}`); }
  return rows.join('\n') + '\n';
}

/** The detrending columns of the current light curve, one value per point of P.lc: centroid, FWHM, sky, comparison flux; PLD components of a TPF. */
function lcColumns() {
  const lc = P.lc, out = { xc: lc.x, yc: lc.y, sky: lc.bg };
  if (lc.kind === 'stack') { out.fwhm = lc.fwhm; if (lc.comp) out.comp = lc.comp; }
  if (lc.kind === 'tpf' && P.detrend.pld > 0) {
    if (!P.pld || P.pld.ncomp !== P.detrend.pld || P.pld.sel !== P.sel) { const B = tpfPld(P.tpf, lc.mask, lc.good, P.detrend.pld); P.pld = B ? { ...B, sel: P.sel } : null; }
    if (P.pld) P.pld.regressors.forEach((x, k) => { out['pld' + (k + 1)] = x; });
  }
  return out;
}

/** What the user chose for the analyzer, in the form detrend.js detrendFromColumns reads. */
function detrendSpec() {
  const D = P.detrend, isTpf = P.lc && P.lc.kind === 'tpf';
  return { columns: D.columns.filter((c) => (isTpf ? !['fwhm', 'comp', 'airmass'].includes(c) : true)), poly: D.poly | 0, pld: isTpf && D.pld > 0 ? Array.from({ length: P.pld ? P.pld.ncomp : D.pld }, (_, k) => 'pld' + (k + 1)) : [],
    kernel: D.kernel ? { features: ['xc', 'yc', ...(D.kernelFwhm && !isTpf ? ['fwhm'] : [])], neighbors: D.neighbors | 0 } : null };
}

function detrendCard() {
  const D = P.detrend, isStack = P.lc.kind === 'stack', avail = isStack ? ['xc', 'yc', 'xc2', 'yc2', 'xy', 'fwhm', 'sky', 'comp'] : ['xc', 'yc', 'xc2', 'yc2', 'xy', 'sky'];
  const label = { ...DETREND_COLUMNS, comp: 'comparison flux' };
  const box = (c) => h('label', { class: 'chk', title: label[c] }, h('input', { type: 'checkbox', checked: D.columns.includes(c), disabled: c === 'comp' && !P.lc.comp, onchange: (e) => { D.columns = e.target.checked ? [...new Set([...D.columns, c])] : D.columns.filter((x) => x !== c); } }), ' ' + ({ xc: 'x', yc: 'y', xc2: 'x²', yc2: 'y²', xy: 'x·y', fwhm: 'FWHM', sky: 'sky', comp: 'comparison' }[c]));
  return h('details', { class: 'card detrend', open: D.columns.length || D.poly || D.pld || D.kernel },
    h('summary', {}, 'Decorrelation for the analyzer'),
    h('p', { class: 'hint' }, 'Choose what the systematics are fitted against. Nothing is removed from the light curve you export: the columns go with it, and the analyzer fits their coefficients together with the transit (integrated out analytically), or the kernel regression inside every likelihood call. ', isStack ? 'Airmass is fitted there already (a1 exp(a2 X)).' : 'For space data the pixel-level decorrelation (PLD, Deming et al. 2015) usually does best.'),
    h('div', { class: 'row wrap' }, h('span', { class: 'dim' }, 'Linear in'), ...avail.map(box)),
    h('div', { class: 'row wrap' },
      h('label', {}, 'Polynomial in time ', h('select', { onchange: (e) => { D.poly = +e.target.value; } }, ...[0, 1, 2, 3].map((k) => h('option', { value: k, selected: D.poly === k }, k ? `order ${k}` : 'none')))),
      !isStack ? h('label', { title: 'Principal components of the fractional pixel fluxes inside the aperture (Deming et al. 2015). 0: off.' }, 'PLD components ', h('input', { type: 'number', min: 0, max: 12, step: 1, value: D.pld, style: 'width:4em', onchange: (e) => { D.pld = Math.max(0, Math.min(12, Math.round(+e.target.value || 0))); } })) : null),
    h('div', { class: 'row wrap' },
      h('label', { class: 'chk', title: 'Nearest-neighbour Gaussian kernel regression on the centroids (Knutson et al. 2012, Lewis et al. 2013; EXOTIC lc_fitter with features): the systematic of each point is a Gaussian-weighted mean of data / transit over its nearest neighbours in centroid space, recomputed inside every likelihood call.' }, h('input', { type: 'checkbox', checked: D.kernel, onchange: (e) => { D.kernel = e.target.checked; } }), ' kernel regression on x, y'),
      isStack ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: D.kernelFwhm, onchange: (e) => { D.kernelFwhm = e.target.checked; } }), ' and FWHM') : null,
      h('label', {}, 'neighbours ', h('input', { type: 'number', min: 5, max: 500, step: 5, value: D.neighbors, style: 'width:5em', onchange: (e) => { D.neighbors = Math.max(5, Math.min(500, Math.round(+e.target.value || 50))); } }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', id: 'bReg', onclick: () => runDetrend('regress') }, 'Preview the decorrelation'), h('span', { class: 'dim', style: 'font-size:12px' }, 'fits the residuals only; the export keeps the raw flux unless "export the detrended flux" is ticked')));
}

/** AAVSO Exoplanet Watch report (src/core/aavso.js): a small form for what the frames cannot say, then the file. */
function aavsoBox() {
  const tg = targetInfo(), R = P.result, f = (id, lab, val, ph) => h('label', {}, lab, h('input', { type: 'text', id, value: val ?? '', placeholder: ph || '', autocomplete: 'off' }));
  return h('div', { class: 'card', id: 'aavsoBox', hidden: true },
    h('h2', {}, 'AAVSO exoplanet report'),
    h('p', { class: 'hint' }, 'The format EXOTIC writes for the AAVSO Exoplanet Database. The fit here is least squares (formal errors, the duration of the best fit); EXOTIC reports its nested-sampling posterior. The DETREND columns are the airmass and the fitted baseline.'),
    h('div', { class: 'grid2' },
      f('aObs', 'AAVSO observer code', '', 'e.g. KPEA'), f('aSec', 'Secondary observer codes', ''), f('aCam', 'Camera type', 'CCD'), f('aBin', 'Binning', '1x1'),
      f('aFilt', 'Filter', tg.filter || '', 'e.g. CV, R, I'), f('aStar', 'Host star', (tg.name || P.name).replace(/\s*[a-k]$/, '')), f('aPl', 'Planet', P.planetName || tg.name || P.name), f('aNotes', 'Notes', `Reduced with Exoplanet Science Lab ${PHOT_VERSION}`)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: saveAavso }, 'Save AAVSO report'), h('span', { class: 'dim', id: 'aavsoNote', style: 'font-size:12px' })));
}
/** The AAVSO report text and its file name, from the form's fields; throws when the observer code is missing. */
function aavsoText() {
  const lc = P.lc, fit = lc.fit, pl = P.result.cfg.planet, v = (id) => String($(id).value || '').trim(), keep = []; for (let i = 0; i < lc.time.length; i++) if ((!lc.keep || lc.keep[i]) && Number.isFinite(lc.norm[i])) keep.push(i);
  if (!v('aObs')) throw new Error('The AAVSO observer code is required.');
  // the fit is of target / comparison in counts; the report (like EXOTIC's final fit) is of the normalised flux, so a1 is divided by the same constant
  const pick = (a) => keep.map((i) => a[i]), b0 = medianOf(keep.map((i) => fit.baseline[i] / lc.baseline[i]).filter(Number.isFinite));
  const text = aavsoReport({ software: `Exoplanet Science Lab photometry v${PHOT_VERSION}`, obscode: v('aObs'), secondaryObscodes: v('aSec'), camera: v('aCam') || 'CCD', star: v('aStar'), planet: v('aPl'), binning: v('aBin') || '1x1', exposure: Number.isFinite(lc.exptime) ? lc.exptime : -1, notes: v('aNotes'),
    compStar: P.stars.length > 1 && P.result.opt.tried[P.sel].comp > 0 ? { x: String(P.stars[P.result.opt.tried[P.sel].comp].x.toFixed(1)), y: String(P.stars[P.result.opt.tried[P.sel].comp].y.toFixed(1)) } : null, filter: v('aFilt'), filterDesc: null, wlMin: null, wlMax: null,
    prior: { per: pl.per, perUnc: pl.perUnc || 0, rprs: pl.rprs, rprsUnc: 0, ars: pl.ars, arsUnc: 0, inc: pl.inc, incUnc: 0, ecc: pl.ecc || 0 }, ld: (pl.ld || [0, 0, 0, 0]).map((u) => [u, 0]),
    fit: { ...fit.params, a1: fit.params.a1 / b0 }, errors: { tmid: fit.errors.tmid || 0, rprs: fit.errors.rprs || 0, inc: fit.errors.inc || 0, a1: 0, a2: fit.errors.a2 || 0 }, durations: [fit.duration],
    rows: { time: pick(lc.time), flux: pick(lc.norm), err: pick(lc.err), airmass: pick(lc.airmass).map((x) => (Number.isFinite(x) ? x : 0)), airmassModel: pick(lc.baseline) } });
  return { text, points: keep.length, name: `AAVSO_${v('aPl').replace(/[^\w.\-]+/g, '_')}_${new Date((lc.time[0] - 2440587.5) * 864e5).toISOString().slice(0, 10)}.txt` };
}
function saveAavso() {
  try { const r = aavsoText(); download(r.text, 'text/plain', r.name); $('aavsoNote').textContent = `${r.points} points written.`; } catch (err) { $('aavsoNote').textContent = err.message; }
}

/** The record the analyzer reads on ?handoff=1 (and the assistant's photometry_send_to_analyze). */
function handoffRecord() {
  const tg = targetInfo(), lc = P.lc, ex = Number.isFinite(lc.exptime) ? lc.exptime : null, useGp = P.gp && $('useGp') && $('useGp').checked;
  const keep = []; for (let i = 0; i < lc.time.length; i++) if ((!lc.keep || lc.keep[i]) && Number.isFinite(lc.norm[i]) && Number.isFinite(lc.time[i])) keep.push(i);
  const cols = useGp ? {} : lcColumns(), spec = detrendSpec(), any = !useGp && (spec.columns.length || spec.poly || spec.pld.length || spec.kernel);
  // the CSV text carries time, flux, error (and airmass) only; the detrending columns are in `columns` (keeps the record small for long TESS series)
  return { kind: 'lightcurve', name: P.name, text: lcCsv({ columns: false }), source: 'photometry', version: PHOT_VERSION, exptime: ex, exptimeDays: ex != null ? ex / 86400 : null, target: tg.name || null, ra: Number.isFinite(tg.ra) ? tg.ra : null, dec: Number.isFinite(tg.dec) ? tg.dec : null, timeSystem: lc.timeSystem, filter: tg.filter || null, planet: P.result.cfg && P.result.cfg.planet ? P.result.cfg.planet : null,
    // detrending: the columns (aligned with `time`, the rows of `text`) and what the user chose to fit them with (detrend.js detrendFromColumns)
    time: keep.map((i) => lc.time[i]), columns: Object.fromEntries(Object.entries(cols).map(([k, a]) => [k, keep.map((i) => (Number.isFinite(a[i]) ? +a[i].toPrecision(9) : null))])), detrend: any ? spec : null,
    comparison: lc.kind === 'stack' ? { choice: P.result.opt.tried[P.sel].comp, weights: lc.weights || null } : null };
}
const download = (text, type, name) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const fileStem = () => P.name.replace(/[^\w.\-]+/g, '_');
function saveCsv() { download(lcCsv(), 'text/csv', fileStem() + '_lightcurve.csv'); }

/** What a reader needs to repeat or audit the reduction. */
// The table of candidates is one tab stop (the shown row): arrows move along it, Enter or space shows a row.
function triedKey(e) {
  const tr = e.currentTarget, to = e.key === 'ArrowDown' ? tr.nextElementSibling : e.key === 'ArrowUp' ? tr.previousElementSibling : null;
  if (to) { e.preventDefault(); to.focus(); } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); const sel = document.querySelector('.tried tr.sel'); if (sel) sel.focus(); }
}
function reductionRecord() {
  const R = P.result, lc = P.lc, row = R.opt.tried[P.sel], D = P.diag, round = (v, d = 6) => (Number.isFinite(v) ? +v.toPrecision(d) : null);
  const out = { software: 'Exoplanet Science Lab photometry', version: PHOT_VERSION, page: location.origin + location.pathname, created: new Date().toISOString(), name: P.name, kind: R.kind, timeSystem: lc.timeSystem, points: lc.time.length, exposureSeconds: round(lc.exptime) };
  if (R.kind === 'stack') {
    Object.assign(out, { target: targetInfo(), settings: R.settings, selected: { ...row, isBest: P.sel === R.opt.best }, fit: lc.fit.params ? { model: 'transit x a1 exp(a2 airmass), least squares', params: lc.fit.params, errors: lc.fit.errors, atBound: lc.fit.atBound } : { model: 'quick trapezoid', depth: round(lc.fit.depth), tmid: lc.fit.tmid, durationDays: round(lc.fit.duration) },
      tried: R.opt.tried.map((t) => ({ method: t.method, aperture: round(t.aperture), annulus: round(t.annulus), comparison: t.comp === 'w' ? 'weighted' : t.comp < 0 ? 'none' : t.comp === 0 ? 'all' : 'C' + t.comp, weights: t.weights || undefined, scatter: round(t.scatter), robust: round(t.robust), points: t.n })),
      frames: R.frames.map((f) => ({ name: f.name, time: f.jd, timeKeyword: f.keyword, shiftedDays: f.shifted, airmassFrom: f.airmassSource, error: f.error })), fieldRefound: R.relocated, timing: R.timing });
  } else Object.assign(out, { target: targetInfo(), file: P.tpfName, meta: R.meta, selected: { name: row.name, pixels: row.npix, scatterPpm: round(1e6 * row.scatter), mask: Array.from(row.mask), isBest: P.sel === R.opt.best }, qualityBitmask: R.meta.quality, tried: R.opt.tried.map((t) => ({ name: t.name, pixels: t.npix, scatterPpm: round(1e6 * t.scatter), eligible: t.eligible })) });
  out.detrendForAnalyzer = detrendSpec();
  if (P.gp) out.detrending = P.gp.kind === 'regress' ? { method: 'linear regressors / kernel regression (preview; refitted with the transit in the analyzer)', names: P.gp.names, kernelNeighbors: P.gp.kernel, rmsBefore: round(P.gp.rmsBefore), rmsAfter: round(P.gp.rmsAfter), hourBefore: round(P.gp.hourBefore), hourAfter: round(P.gp.hourAfter) } : P.gp.kind === 'sff' ? { method: 'self-flat-fielding (Vanderburg & Johnson 2014)', windows: P.gp.windows, robustBefore: round(P.gp.rmsBefore), robustAfter: round(P.gp.rmsAfter) } : P.gp.kind === 'pld' ? { method: `pixel-level decorrelation (EVEREST / lightkurve PLDCorrector form), order ${P.gp.order}`, regressors: P.gp.names, cdppBefore: round(P.gp.cdppBefore), cdppAfter: round(P.gp.cdppAfter), thrusters: P.gp.thrusters } : { method: 'Gaussian process on the centroid', hyper: P.gp.hyper, rmsBefore: round(P.gp.rmsBefore), rmsAfter: round(P.gp.rmsAfter), againstTime: !!P.gp.useTime };
  if (D) out.diagnostics = { residualRms: round(D.rms), beta: round(D.rb.beta), betaBin: D.rb.nBeta, whiteLevel: round(D.white), photonLevel: round(D.photon), photonNoisePerPoint: round(D.ph), redNoise: D.fit ? { red: D.fit.red, gamma: round(D.fit.gamma), knee: round(D.fit.knee) } : null };
  return out;
}
function targetInfo() {
  const R = P.result;
  if (R.kind === 'tpf') return { name: R.meta.object || P.name, ra: R.meta.ra, dec: R.meta.dec, mission: R.meta.mission, id: R.meta.id };
  const t = R.settings.target || {}, hd = P.lights[0] ? framePointing(P.lights[0].header) : {};
  return { name: (R.meta && R.meta.object) || P.name, ra: Number.isFinite(t.ra) ? t.ra : hd.ra, dec: Number.isFinite(t.dec) ? t.dec : hd.dec, telescope: R.meta && R.meta.telescope, filter: R.meta && R.meta.filter };
}
function saveJson() { download(JSON.stringify(reductionRecord(), null, 1), 'application/json', fileStem() + '_reduction.json'); }
function openInAnalyze() {
  // text, name: what the analyzer reads today; the rest travels with it (exposure time in seconds and days, the target named in the headers, the planet if one was given)
  const hand = handoffRecord();
  // a short record of how the light curve was made, for the project report the assistant writes (src/core/report.js)
  try { const R = P.result, row = R.opt.tried[P.sel], lc = P.lc, fw = lc.fwhm ? medianOf(Array.from(lc.fwhm).filter(Number.isFinite)) : NaN;
    localStorage.setItem('esl.reduction.last', JSON.stringify({ name: P.name, at: new Date().toISOString(), frames: R.kind === 'stack' ? P.lights.length : P.tpf ? P.tpf.ncad : null, method: R.kind === 'stack' ? METHOD_LABEL[row.method] || row.method : `target pixel file, ${row.name || 'mask'}`,
      aperture_px: R.kind === 'stack' && Number.isFinite(row.aperture) ? +row.aperture.toPrecision(4) : null, annulus_px: R.kind === 'stack' && Number.isFinite(row.annulus) ? +row.annulus.toPrecision(4) : null,
      comparison: R.kind === 'stack' ? compName(row.comp, P.stars.length - 1) : null, scatter: Number.isFinite(row.scatter) ? +row.scatter.toPrecision(4) : null, fwhm_px: Number.isFinite(fw) ? +fw.toPrecision(4) : null, time_system: lc.timeSystem || null, software: `Exoplanet Science Lab photometry ${PHOT_VERSION}` })); } catch { /* the report then says the record was not kept */ }
  try { localStorage.setItem('esl.handoff', JSON.stringify(hand)); } catch (err) { setStatus('stRun', 'Could not hand the light curve over (storage is full or blocked): save the CSV and open it in Analyze.', 'err'); return; }
  location.href = new URL('analyze/?handoff=1', siteRoot()).href;
}

// ------------------------------------------------------------------------------------------- archive
async function findArchive() {
  const q = $('inTarget').value.trim(); if (!q) return;
  const list = (P.archive && P.archive.listEl) || $('archList'); list.hidden = true; list.innerHTML = ''; $('archPick').hidden = true; $('archPick').innerHTML = ''; $('bFind').disabled = true;
  try {
    setStatus('stArch', 'Looking up the target…');
    const tg = await resolveTarget(q, siteRoot());
    if (!tg.tic && !tg.kic && !tg.epic) throw new Error(`"${q}" is not in this site's catalogue. Enter a TIC, KIC or EPIC number, or a TOI.`);
    let files = [];
    if (tg.kic) { setStatus('stArch', `KIC ${tg.kic}: listing Kepler files…`); files = files.concat(await keplerProducts(tg.kic)); }
    if (tg.epic) files = files.concat(await k2Products(tg.epic, (d, n) => setStatus('stArch', `EPIC ${tg.epic}: checking K2 campaigns ${d} / ${n}…`)));
    if (tg.tic) files = files.concat(await tessProducts(tg.tic, (d, n) => setStatus('stArch', `TIC ${tg.tic}: checking sector folders ${d} / ${n} (SPOC, TESS-SPOC, QLP)…`)));
    if (!files.length) throw new Error(`No light curves or target pixel files for ${tg.name}${tg.tic ? ' (TIC ' + tg.tic + ')' : ''} in the archive bucket. A star seen only in the full-frame images and not in TESS-SPOC or QLP has none: get a TESScut cutout from MAST and open the file.`);
    P.archive = { target: tg, products: files, listEl: list };
    for (const f of files) list.append(h('button', { onclick: () => fetchArchive(f, tg) }, h('span', {}, `${f.mission} ${f.label}`), h('span', { class: 'dim' }, `${f.kind === 'tpf' ? 'pixels' : 'light curve'} · ${f.author} ${f.cadence}`), h('span', {}, fmtMB(f.size))));
    buildArchivePicker();
    const groups = new Set(files.map((f) => `${f.mission} ${f.group}`));
    setStatus('stArch', `${tg.name}${tg.tic ? ' · TIC ' + tg.tic : ''}${tg.kic ? ' · KIC ' + tg.kic : ''}${tg.epic ? ' · EPIC ' + tg.epic : ''}: ${files.length} files in ${groups.size} ${tg.tic ? 'sectors' : tg.kic ? 'quarters' : 'campaigns'}. Choose the sectors and the cadence, or one file below.`, 'ok');
  } catch (err) { setStatus('stArch', String(err.message || err), 'err'); }
  $('bFind').disabled = false;
}

/** The sector / cadence / source picker over the products found (one product per sector, EXOTIC's cadence_policy). */
function buildArchivePicker() {
  const A = P.archive, box = $('archPick'), listEl = A.listEl; box.innerHTML = ''; box.hidden = false;
  const tess = A.products.some((p) => p.mission === 'TESS'), authors = [...new Set(A.products.map((p) => p.author))];
  A.sel = A.sel || { kind: A.products.some((p) => p.kind === 'lc') ? 'lc' : 'tpf', cadence: 'shortest', authors: authors.filter((a) => a !== 'QLP' || authors.length === 1), groups: null };
  const groups = [...new Map(A.products.map((p) => [`${p.mission}|${p.group}`, p])).values()].sort((a, b) => a.mission.localeCompare(b.mission) || a.group - b.group);
  if (!A.sel.groups) A.sel.groups = groups.map((g) => `${g.mission}|${g.group}`);
  const pick = () => {
    const out = [];
    for (const mission of [...new Set(groups.map((g) => g.mission))]) {
      const gs = A.sel.groups.filter((k) => k.startsWith(mission + '|')).map((k) => +k.split('|')[1]);
      if (gs.length) out.push(...chooseProducts(A.products.filter((p) => p.mission === mission), { kind: A.sel.kind, cadence: A.sel.cadence, authors: [...A.sel.authors].sort((x, y) => ['SPOC', 'Kepler', 'K2', 'TESS-SPOC', 'QLP'].indexOf(x) - ['SPOC', 'Kepler', 'K2', 'TESS-SPOC', 'QLP'].indexOf(y)), groups: gs }).chosen);
    }
    return out;
  };
  A.pick = pick;
  const summary = h('span', { class: 'dim', id: 'archSum' }), refresh = () => { const c = pick(), mb = c.reduce((a, p) => a + p.size, 0); summary.textContent = `${c.length} file${c.length === 1 ? '' : 's'}, ${fmtMB(mb)}${A.sel.kind === 'tpf' && mb > 300 * 1048576 ? ' (large: pixels of many sectors take a while)' : ''}`; $('bArchLoad').disabled = !c.length; };
  const opt = (v, l, cur) => h('option', { value: v, selected: v === cur }, l);
  box.append(
    h('div', { class: 'grid2', style: 'margin-top:8px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))' },
      h('label', {}, 'Product', h('select', { id: 'archKind', onchange: (e) => { A.sel.kind = e.target.value; refresh(); } }, opt('lc', 'light curves', A.sel.kind), opt('tpf', 'target pixel files', A.sel.kind))),
      h('label', { title: 'One product per sector: the same photons in 20 s and 2 min must not be counted twice (the owner\'s TOI extraction does the same).' }, 'Cadence', h('select', { id: 'archCad', onchange: (e) => { A.sel.cadence = e.target.value; refresh(); } }, ...[['shortest', 'shortest available'], ['longest', 'longest available'], ...(tess ? [['20 s', '20 s only'], ['2 min', '2 min only'], ['FFI', 'full-frame images only']] : [['30 min', 'long cadence only'], ['1 min', 'short cadence only']])].map(([v, l]) => opt(v, l, A.sel.cadence)))),
      h('label', { title: 'lightkurve\'s quality masks. default: cadences that are certainly bad; hard: also cosmic rays, stray light, rolling bands; hardest: any flag.' }, 'Quality mask', h('select', { id: 'qPreset' }, ...['default', 'hard', 'hardest', 'none'].map((v) => opt(v, v, 'default')))),
      h('label', { title: 'Light-curve files: the systematics-corrected flux (PDCSAP, or QLP\'s KSPSAP) or the simple aperture flux.' }, 'Flux of light-curve files', h('select', { id: 'lcFlux' }, opt('pdcsap', 'PDCSAP (corrected)', 'pdcsap'), opt('sap', 'SAP (aperture sum)', 'pdcsap'))),
      A.products.some((p) => p.mission === 'K2') ? h('label', { title: 'For K2 pixels: pixel-level decorrelation (EVEREST-style, third order) of the best aperture before stitching.' }, 'K2 pixels', h('select', { id: 'k2Sys' }, opt('pld', 'PLD (EVEREST-style)', 'pld'), opt('none', 'aperture sum only', 'pld'))) : null,
      A.products.some((p) => p.mission === 'K2') ? h('label', { class: 'chk', style: 'flex-direction:row;gap:5px;align-items:center' }, h('input', { type: 'checkbox', id: 'k2Thr', checked: true }), 'drop thruster firings') : null),
    authors.length > 1 ? h('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, h('span', { class: 'dim' }, 'From'), ...authors.map((a) => h('label', { class: 'chk', title: { SPOC: 'Mission pipeline, 2 min and 20 s postage stamps', 'TESS-SPOC': 'SPOC run on the full-frame images (HLSP)', QLP: 'MIT Quick-Look Pipeline, full-frame images (HLSP; light curves only)' }[a] || '' }, h('input', { type: 'checkbox', checked: A.sel.authors.includes(a), onchange: (e) => { A.sel.authors = e.target.checked ? [...new Set([...A.sel.authors, a])] : A.sel.authors.filter((x) => x !== a); refresh(); } }), ' ' + a))) : null,
    h('div', { class: 'filelist', id: 'archGroups', style: 'max-height:180px' }, ...groups.map((g) => { const k = `${g.mission}|${g.group}`, alts = [...new Set(A.products.filter((p) => p.mission === g.mission && p.group === g.group).map((p) => `${p.kind === 'tpf' ? 'TPF' : 'LC'} ${p.author} ${p.cadence}`))];
      return h('label', { class: 'chk', style: 'display:flex;gap:8px;padding:4px 8px;border-bottom:1px solid var(--line);font-size:12px' }, h('input', { type: 'checkbox', checked: A.sel.groups.includes(k), 'aria-label': `${g.mission} ${g.label}`, onchange: (e) => { A.sel.groups = e.target.checked ? [...new Set([...A.sel.groups, k])] : A.sel.groups.filter((x) => x !== k); refresh(); } }), h('span', {}, `${g.mission} ${g.label.replace(/ \(.*\)$/, '')}`), h('span', { class: 'dim', style: 'margin-left:auto;text-align:right' }, alts.join(' · '))); })),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: () => { A.sel.groups = groups.map((g) => `${g.mission}|${g.group}`); buildArchivePicker(); } }, 'All'), h('button', { class: 'btn sm', onclick: () => { A.sel.groups = []; buildArchivePicker(); } }, 'None'),
      h('button', { class: 'btn primary', id: 'bArchLoad', onclick: () => loadArchive(pick()) }, 'Load and stitch'), summary),
    h('details', { style: 'margin-top:6px;font-size:12px' }, h('summary', { class: 'dim' }, 'Or open one file'), listEl));
  listEl.hidden = false; refresh();
}

/** Download the chosen products and open them: one TPF in the pixel view, otherwise stitched in the light-curve view. */
async function loadArchive(chosen) {
  if (!chosen.length) return;
  const tg = P.archive.target;
  if (chosen.length === 1 && chosen[0].kind === 'tpf') return fetchArchive(chosen[0], tg);
  $('bArchLoad').disabled = true;
  try {
    const items = []; let got = 0; const total = chosen.reduce((a, p) => a + p.size, 0);
    // a few downloads at a time
    for (let i = 0; i < chosen.length; i += 4) {
      await Promise.all(chosen.slice(i, i + 4).map(async (f) => { const prev = { n: 0 }; const buf = await fetchBytes(BUCKET + f.key, (n) => { got += n - prev.n; prev.n = n; setStatus('stArch', `Downloading ${chosen.length} files: ${fmtMB(got)} of ${fmtMB(total)}`); }); items.push({ buffer: buf, name: `${f.mission} ${f.label} ${f.author} ${f.cadence}`, kind: f.kind, product: f }); }));
    }
    items.sort((a, b) => a.product.group - b.product.group);
    await loadSeriesFiles(items, ` (${fmtMB(total)} from the archive bucket)`, { name: tg.name, tic: tg.tic, kic: tg.kic, epic: tg.epic }, 'stArch');
  } catch (err) { console.warn(err); setStatus('stArch', String(err.message || err), 'err'); }
  if ($('bArchLoad')) $('bArchLoad').disabled = false;
}

async function fetchArchive(f, tg) {
  try {
    const buf = await fetchBytes(BUCKET + f.key, (n, t) => setStatus('stArch', `Downloading ${f.mission} ${f.label}: ${fmtMB(n)}${t ? ' of ' + fmtMB(t) : ''}`));
    setStatus('stArch', 'Decoding…');
    if (f.kind === 'lc') { await loadSeriesFiles([{ buffer: buf, name: `${f.mission} ${f.label} ${f.author} ${f.cadence}`, kind: 'lc' }], '', { name: tg.name, tic: tg.tic, kic: tg.kic, epic: tg.epic }, 'stArch'); return; }
    await loadTpf(buf, f.key.split('/').pop());
    P.archiveTarget = tg;
    setStatus('stArch', `${tg.name}: ${f.mission} ${f.label} loaded (${fmtMB(buf.byteLength)}).`, 'ok');
    $('work').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) { setStatus('stArch', String(err.message || err), 'err'); }
}

// ------------------------------------------------------------------------------------------- demos
// ?demo=3: the sample EXOTIC is tested with. The file is looked for in public/photometry/ first and then in test/data/
// (which only the development server serves): see the README about redistributing it.
const HATP32 = { stars: [[424, 286], [465, 183], [512, 263]], planet: { per: 2.1500082, tmid: 2455867.402743, rprs: 0.14886, ars: 5.344, inc: 88.98, ecc: 0.159, omega: 50, tmidUnc: 0.01, perUnc: 1.3e-7, ld: [2.087256262382093, -3.7643210784163745, 4.249285588883468, -1.5722207728491862] }, ra: 31.0417, dec: 46.6897, lat: 32.4164, lon: -110.7344 };
(async () => {
  const demo = new URLSearchParams(location.search).get('demo'), look = new URLSearchParams(location.search).has('inspect');   // inspect: load the demo frames without measuring
  try {
    if (demo === '1') {
      setStatus('stArch', 'Loading the bundled TESS cut-out of WASP-18 (700 cadences of sector 2)…');
      const buf = await (await fetch(new URL('photometry/tess_wasp18_s02_sub_tp.fits', siteRoot()))).arrayBuffer();
      await loadTpf(buf, 'tess_wasp18_s02_sub_tp.fits'); setStatus('stArch', 'WASP-18, TESS sector 2: one orbit cut from the real target pixel file.', 'ok');
      if (!look) await run();
    } else if (demo === '2') {
      setStatus('stLocal', 'Making a synthetic night…'); P.name = 'ESL demo field';
      await addFiles(makeDemoFrames());
      P.stars = [DEMO_TRUTH.target, ...DEMO_TRUTH.comps.slice(0, 3)].map((s) => { const c = centroidIter(P.cur.data, P.cur.width, P.cur.height, s.x, s.y, 8); return { x: c[0], y: c[1], peak: P.cur.data[Math.round(c[1]) * P.cur.width + Math.round(c[0])] }; });
      buildStarsCard(); viewer.draw();
      if (!look) await run();
    } else if (demo === '3') {
      setStatus('stLocal', 'Loading 48 real frames of HAT-P-32 b…');
      let r = await fetch(new URL('photometry/hatp32_exotic_sample.fits', siteRoot())); if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) r = await fetch(new URL('test/data/hatp32_exotic_sample.fits', siteRoot()));
      if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) throw new Error('The HAT-P-32 b frames are not on this server (public/photometry/hatp32_exotic_sample.fits).');
      const parts = await splitFits(await r.arrayBuffer(), 'hatp32');
      P.name = 'HAT-P-32 b'; P.planet = HATP32.planet;
      await addFiles(parts.map((q) => new File([q.buffer], q.name.replace(/\.FITS$/i, '') + '.fits')));
      const hd = P.cur.header, ox = hd.CROPX0 || 0, oy = hd.CROPY0 || 0;
      P.stars = HATP32.stars.map(([x, y]) => { const c = centroidIter(P.cur.data, P.cur.width, P.cur.height, x - ox, y - oy, 8); return { x: c[0], y: c[1], peak: P.cur.data[Math.round(c[1]) * P.cur.width + Math.round(c[0])] }; });
      buildStarsCard(); buildSettings(); viewer.draw();
      $('sAt').value = 'exotic'; $('sRa').value = String(HATP32.ra); $('sDec').value = String(HATP32.dec); $('sLat').value = String(HATP32.lat); $('sLon').value = String(HATP32.lon); $('sAn').value = 20; $('sNn').value = 10;
      $('sScore').value = 'transit'; $('planetBox').hidden = false;
      setStatus('stLocal', 'HAT-P-32 b, 2017-12-20, a 6-inch MicroObservatory telescope: every third frame of the sample data EXOTIC is tested with, cut down to the three stars (the window follows the field in steps of 8 px). Tile-compressed FITS, decoded here.', 'ok');
      if (!look) await run();
    }
  } catch (err) { setStatus(demo === '1' ? 'stArch' : 'stLocal', String(err.message || err), 'err'); }
  P.ready = true;
})();

// ---- window.__esl.photometry: what the site's assistant drives (the contract is at the top of src/assistant/pages.js)
{
  const T = (description, extra = {}) => ({ type: 'string', description, ...extra }), N = (description, extra = {}) => ({ type: 'number', description, ...extra }), obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const r4 = (x) => (Number.isFinite(x) ? +x.toPrecision(4) : null);
  const HDR = ['OBJECT', 'DATE-OBS', 'EXPTIME', 'FILTER', 'TELESCOP', 'INSTRUME', 'NAXIS1', 'NAXIS2', 'AIRMASS', 'GAIN'];
  const frames = (limit = 8) => (P.mode === 'series' ? { kind: 'light curves (several sectors)', name: P.name, ...series.state() } : P.mode === 'tpf' ? { kind: 'target pixel file', file: P.tpfName, object: P.tpf && P.tpf.object, mission: P.tpf && P.tpf.mission }
    : P.mode === 'stack' ? { kind: 'image stack', light_frames: P.lights.length, calibration: { bias: P.cal.bias.length, dark: P.cal.dark.length, flat: P.cal.flat.length }, first_frames: P.lights.slice(0, limit).map((l) => ({ name: l.file.name, jd: Number.isFinite(l.jd) ? +l.jd.toFixed(5) : null })), header_of_first: Object.fromEntries(HDR.filter((k) => P.lights[0].header[k] !== undefined).map((k) => [k, P.lights[0].header[k]])) }
    : { kind: 'nothing loaded', how: 'The user opens a folder of FITS frames (or a .zip of them) or drops them on the page; FITS or zip files attached to this chat can be loaded with photometry_load_files; photometry_find_archive and photometry_load_archive fetch TESS / Kepler / K2 light curves or pixels; the page\'s address parameter demo=2 makes a synthetic night.' });
  const settings = () => (document.getElementById('sA0') ? { aperture_radii_psf_sigma: [numOf('sA0'), numOf('sA1')], aperture_count: numOf('sAn'), annulus_width_psf_sigma: [numOf('sN0'), numOf('sN1')], annulus_count: numOf('sNn'), psf_photometry: $('sPsf').value, scoring: $('sScore') ? $('sScore').value : undefined, time_at: $('sAt').value, target_ra: $('sRa').value || null, target_dec: $('sDec').value || null, site_lat: $('sLat').value || null, site_lon: $('sLon').value || null, baseline: Number($('sOrd').value), gain: numOf('sGain') || null, calibration: $('sCal') ? $('sCal').value === '1' : null } : undefined);
  const outcome = () => {
    if (!P.result || !P.lc) return { has_result: false };
    const rec = reductionRecord(), s = rec.selected || {};
    return { has_result: true, name: P.name, points: rec.points, time_system: rec.timeSystem, exposure_s: rec.exposureSeconds, candidates_tried: (rec.tried || []).length,
      selected: rec.kind === 'stack' ? { method: s.method, aperture_px: r4(s.aperture), annulus_px: r4(s.annulus), comparison: s.comp === undefined ? undefined : compName(s.comp, P.stars.length - 1), scatter: r4(s.scatter), is_the_best: s.isBest } : { aperture: s.name, pixels: s.pixels, scatter_ppm: s.scatterPpm, is_the_best: s.isBest },
      quick_fit: rec.fit ? Object.fromEntries(Object.entries(rec.fit).filter(([, v]) => typeof v !== 'object' || v === null).map(([k, v]) => [k, typeof v === 'number' ? (/tmid|time/i.test(k) ? +v.toFixed(5) : r4(v)) : v])) : undefined, diagnostics: rec.diagnostics ? { residual_rms: rec.diagnostics.residualRms, red_noise_beta: rec.diagnostics.beta, photon_noise_per_point: rec.diagnostics.photonNoisePerPoint } : undefined,
      next: 'photometry_send_to_analyze hands this light curve to the analyzer; photometry_save writes it as CSV.' };
  };
  const tools = [
    { name: 'photometry_frames', core: true, readOnly: true, description: 'What is loaded on the photometry page: the image stack (number of light and calibration frames, the first file names and times, the main header keywords of the first frame) or the target pixel file, the stars chosen, the settings, and whether a light curve exists.',
      parameters: obj({ limit: { type: 'integer', description: 'How many frame names to list (default 8).', minimum: 1, maximum: 60 } }),
      run({ limit }) { return { ...frames(limit), stars: P.stars.length ? { target: P.stars[0] && [Math.round(P.stars[0].x), Math.round(P.stars[0].y)], comparisons: P.stars.slice(1).map((s) => [Math.round(s.x), Math.round(s.y)]) } : undefined, settings: settings(), result: outcome(), busy: P.busy }; } },
    { name: 'photometry_load_files', description: 'Load FITS files that the user attached to this chat into the photometry page: image frames (also .zip archives of frames or of whole folders with calibration subfolders), one target pixel file, or several TESS / Kepler / K2 light-curve files or TPFs (stitched).', confirm: () => (P.result ? 'Loading other frames replaces the reduction on this page.' : null),
      parameters: obj({ files: { type: 'array', items: { type: 'string', description: 'file name' }, description: 'Names of attached FITS or zip files (see list_files). Omit for every attached one.' } }),
      async run({ files: names }, { files }) {
        const all = files.list().filter((f) => /\.((fits?|fts)(\.(gz|fz))?|zip)$/i.test(f.name) && (!names || names.includes(f.name)));
        if (!all.length) throw new Error('no attached FITS file' + (names ? ' with those names' : '') + ': ask the user to attach the frames (the paperclip), or to open their folder on the page');
        await addFiles(all.map((f) => { const rec = files.get(f.name); if (!rec || !rec.blob) throw new Error(`${f.name} was attached as text, not as an image`); return new File([rec.blob], f.name); }));
        return { loaded: frames(), next: P.mode === 'stack' ? 'photometry_pick_stars (or let the page choose), then photometry_run.' : P.mode === 'series' ? 'photometry_prepare masks the transits, flattens and cuts the windows.' : 'photometry_run.' };
      } },
    { name: 'photometry_pick_stars', description: 'Choose the target and comparison stars on the first frame of an image stack: by pixel coordinates, or automatically (the star nearest the centre and up to four of similar brightness).',
      parameters: obj({ target: { type: 'array', items: N('pixel'), description: 'x, y of the target on the first frame. Omit to choose automatically.' }, comparisons: { type: 'array', items: { type: 'array', items: N('pixel'), description: 'x, y' }, description: 'x, y of each comparison star.' } }),
      async run({ target, comparisons }) {
        if (P.mode !== 'stack') throw new Error('stars are chosen on an image stack; a target pixel file needs none');
        if (P.frame !== 0 || !P.cur) await showFrame(0);
        const at = ([x, y]) => { const c = centroidIter(P.cur.data, P.cur.width, P.cur.height, x, y, 8); return { x: c[0], y: c[1], peak: P.cur.data[Math.round(c[1]) * P.cur.width + Math.round(c[0])] }; };
        P.stars = target ? [at(target), ...(comparisons || []).map(at)] : [];
        if (!target || !(comparisons || []).length) detect(); else { buildStarsCard(); viewer.draw(); }
        return { target: P.stars[0] ? [r4(P.stars[0].x), r4(P.stars[0].y)] : null, comparisons: P.stars.slice(1).map((s) => [r4(s.x), r4(s.y)]), other_candidates: (P.suggest || []).slice(0, 5).map((q) => ({ at: [r4(q.x), r4(q.y)], flux_ratio: r4(q.ratio), notes: q.notes })), note: P.stars.length ? 'Positions are refined to the centroid of the nearest star; comparisons are ranked by brightness match, isolation, saturation, edge distance and profile shape.' : 'No star was found.' };
      } },
    { name: 'photometry_examine_star', readOnly: true, description: 'Radial profile of the star nearest a pixel position on the frame shown (like IRAF imexam): FWHM from Gaussian and Moffat fits, half-flux diameter, elongation, peak against saturation, sky level and noise, signal to noise. Shows the result on the page.',
      parameters: obj({ x: N('x pixel'), y: N('y pixel') }, ['x', 'y']),
      async run({ x, y }) {
        if (P.mode !== 'stack' || !P.cur) throw new Error('load an image stack first');
        insp.setTool('profile'); insp.examine(x, y); const r = insp.I.prof, sc = pixelScale(P.cur.header || {}).scale;
        return { centre: [r4(r.x), r4(r.y)], fwhm_moffat_px: r4(r.moffat.fwhm), moffat_beta: r4(r.moffat.beta), fwhm_gaussian_px: r4(r.gaussian.fwhm), half_flux_diameter_px: r4(r.hfd), arcsec_per_px: r4(sc), elongation: r.shape ? r4(r.shape.ellipticity) : null, peak: r4(r.peak), saturated: r.saturated, sky: r4(r.background), sky_sigma: r4(r.backgroundSigma), snr: r4(r.snr) };
      } },
    { name: 'photometry_focus_map', readOnly: true, description: 'Measure every unsaturated, isolated star of the frame shown and describe the focus across the field: median FWHM, centre against corners (field curvature), corner spread (tilt), elongation and whether stars all point the same way (tracking). Shows the map on the page.',
      parameters: obj({ grid: { type: 'integer', description: 'Cells per side (2 to 5, default 3).', minimum: 2, maximum: 5 } }),
      async run({ grid }) {
        if (P.mode !== 'stack' || !P.cur) throw new Error('load an image stack first');
        if (grid) insp.I.grid = grid; insp.setTool('focus'); insp.measureFocus(); const S = insp.I.focus.summary;
        return { stars: S.n, median_fwhm_px: r4(S.fwhm), centre_fwhm_px: r4(S.fwhmCentre), corner_fwhm_px: S.fwhmCorners.map(r4), corners_softer_by: r4(S.curvature), corner_spread: r4(S.tilt), worst_corner: S.worstCorner, median_elongation: r4(S.ellipticity), same_direction: r4(S.coherence), verdict: S.verdict };
      } },
    { name: 'photometry_set_apertures', core: true, description: 'Set the range of apertures and sky annuli the reduction tries (in units of the PSF width σ) and how many of each; the best combination is chosen by the scatter of the light curve.',
      parameters: obj({ aperture_from: N('Smallest aperture radius, × σ (default 1.5).', { minimum: 0.5 }), aperture_to: N('Largest aperture radius, × σ (default 6).'), aperture_count: { type: 'integer', description: 'How many radii between them.', minimum: 1, maximum: 60 }, annulus_from: N('Narrowest sky annulus, × σ (default 6).', { minimum: 1 }), annulus_to: N('Widest sky annulus, × σ (default 15).'), annulus_count: { type: 'integer', description: 'How many annuli.', minimum: 1, maximum: 30 },
        psf: T('PSF photometry competing with the apertures.', { enum: ['both', 'gauss', 'moffat', 'none'] }) }),
      run(a) {
        if (P.mode !== 'stack' || !document.getElementById('sA0')) throw new Error(P.mode === 'tpf' ? 'a target pixel file tries its own set of pixel masks: there is nothing to set' : 'load an image stack first');
        const set = (id, v) => { if (v !== undefined) { const el = $(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
        if (a.aperture_from !== undefined && a.aperture_to !== undefined && !(a.aperture_to > a.aperture_from)) throw new Error('aperture_to must be larger than aperture_from');
        set('sA0', a.aperture_from); set('sA1', a.aperture_to); set('sAn', a.aperture_count); set('sN0', a.annulus_from); set('sN1', a.annulus_to); set('sNn', a.annulus_count);
        if (a.psf !== undefined) { const opt = [...$('sPsf').options].find((o) => o.value === a.psf || o.value.startsWith(a.psf)); if (opt) set('sPsf', opt.value); }
        return { settings: settings(), next: 'photometry_run measures every frame with these.' };
      } },
    { name: 'photometry_set_options', description: 'Set the reduction options besides the apertures: where the header time sits in the exposure, the target position (for BJD_TDB), the site (for the airmass when the header has none), the baseline, the gain, whether calibration frames are used, and how candidates are scored (a quick trapezoid, or the transit model with the planet\'s parameters).',
      parameters: obj({ time_at: T('Where the header time is: start of the exposure, middle, or EXOTIC\'s rule.', { enum: ['start', 'mid', 'exotic'] }), ra: T('Target RA, degrees or hh mm ss.'), dec: T('Target Dec, degrees or dd mm ss.'), site_lat: N('Site latitude, degrees.'), site_lon: N('Site longitude, degrees east.'),
        baseline: { type: 'integer', description: '1: airmass (or linear in time); 2: plus a quadratic in time.', enum: [1, 2] }, gain: N('Electrons per count.'), calibration: { type: 'boolean', description: 'Use the bias, dark and flat frames found (when there are any).' },
        score: T('How each candidate light curve is scored.', { enum: ['quick', 'transit'] }), planet: obj({ per: N('Period [d]'), tmid: N('Mid-transit [BJD_TDB]'), rprs: N('Rp/R*'), ars: N('a/R*'), inc: N('Inclination [deg]'), ecc: N('Eccentricity'), omega: N('omega [deg]'), tmid_unc: N('Uncertainty of the mid-transit time [d]'), ld: { type: 'array', items: N('coefficient'), description: 'Claret a1..a4' } }) }),
      run(a) {
        if (P.mode !== 'stack' || !$('sAt')) throw new Error(P.mode === 'tpf' ? 'a target pixel file has no such options' : 'load an image stack first');
        const set = (id, v) => { if (v === undefined || v === null || !$(id)) return; $(id).value = String(v); $(id).dispatchEvent(new Event('change', { bubbles: true })); };
        set('sAt', a.time_at); set('sRa', a.ra); set('sDec', a.dec); set('sLat', a.site_lat); set('sLon', a.site_lon); set('sOrd', a.baseline); set('sGain', a.gain);
        if (a.calibration !== undefined && $('sCal')) set('sCal', a.calibration ? 1 : 0);
        if (a.score) { set('sScore', a.score); $('planetBox').hidden = a.score !== 'transit'; }
        const pl = a.planet || {}; set('pPer', pl.per); set('pTmid', pl.tmid); set('pRprs', pl.rprs); set('pArs', pl.ars); set('pInc', pl.inc); set('pEcc', pl.ecc); set('pOm', pl.omega); set('pTu', pl.tmid_unc); if (Array.isArray(pl.ld)) set('pLd', pl.ld.join(', '));
        if (a.score === 'transit') planetFromForm();     // says now which planet values are missing
        return { settings: settings(), next: 'photometry_run measures every frame with these.' };
      } },
    { name: 'photometry_set_detrend', description: 'Choose what the systematics are fitted against when the light curve goes to the analyzer: linear terms in the centroids, FWHM, sky or comparison flux, a polynomial in time, pixel-level decorrelation components (target pixel files), and nearest-neighbour kernel regression on the centroids. Nothing is removed from the light curve; the analyzer fits these with the transit.',
      parameters: obj({ columns: { type: 'array', items: T('column', { enum: ['xc', 'yc', 'xc2', 'yc2', 'xy', 'fwhm', 'sky', 'comp'] }), description: 'Linear regressors (empty for none).' }, poly: { type: 'integer', minimum: 0, maximum: 3, description: 'Polynomial order in time (0: none).' }, pld: { type: 'integer', minimum: 0, maximum: 12, description: 'PLD components (target pixel files only).' }, kernel: { type: 'boolean', description: 'Kernel regression on the centroids.' }, kernel_fwhm: { type: 'boolean', description: 'Kernel also in FWHM (image stacks).' }, neighbors: { type: 'integer', minimum: 5, maximum: 500, description: 'Neighbours of the kernel (default 50).' } }),
      run(a) {
        if (!P.lc) throw new Error('reduce the frames first (photometry_run): the choices apply to a light curve');
        const D = P.detrend, isStack = P.lc.kind === 'stack', avail = isStack ? ['xc', 'yc', 'xc2', 'yc2', 'xy', 'fwhm', 'sky', 'comp'] : ['xc', 'yc', 'xc2', 'yc2', 'xy', 'sky'];
        if (a.columns) { const bad = a.columns.filter((c) => !avail.includes(c)); if (bad.length) throw new Error(`not available for this light curve: ${bad.join(', ')} (available: ${avail.join(', ')})`); D.columns = [...new Set(a.columns)]; }
        if (a.poly !== undefined) D.poly = a.poly; if (a.pld !== undefined) { if (isStack && a.pld) throw new Error('PLD needs a target pixel file'); D.pld = a.pld; }
        if (a.kernel !== undefined) D.kernel = a.kernel; if (a.kernel_fwhm !== undefined) D.kernelFwhm = a.kernel_fwhm; if (a.neighbors !== undefined) D.neighbors = a.neighbors;
        renderResults();
        return { detrend: detrendSpec(), next: 'photometry_send_to_analyze carries these to the analyzer, which fits them with the transit.' };
      } },
    { name: 'photometry_aavso_report', description: 'Write the AAVSO Exoplanet Watch report (EXOTIC\'s format) of the reduced light curve into the conversation\'s files. Needs the observer\'s AAVSO code; the fit must have used the transit model (photometry_set_options score "transit").',
      parameters: obj({ observer_code: T('AAVSO observer code (required).'), secondary_codes: T('Other observers\' codes.'), camera: T('Camera type (default CCD).'), binning: T('Binning (default 1x1).'), filter: T('Filter (e.g. CV, R).'), star: T('Host star name.'), planet: T('Planet name.'), notes: T('Notes.') }, ['observer_code']),
      async run(a, ctx = {}) {
        if (!P.lc || !P.result || P.result.kind !== 'stack') throw new Error('reduce an image stack first (photometry_run)');
        if (!P.result.cfg || !P.result.cfg.planet) throw new Error('the AAVSO report needs the transit-model fit: photometry_set_options with score "transit" and the planet, then photometry_run');
        const box = $('aavsoBox'); if (box) box.hidden = false;
        const set = (id, v) => { if (v !== undefined && $(id)) $(id).value = String(v); };
        set('aObs', a.observer_code); set('aSec', a.secondary_codes); set('aCam', a.camera); set('aBin', a.binning); set('aFilt', a.filter); set('aStar', a.star); set('aPl', a.planet); set('aNotes', a.notes);
        const r = aavsoText();
        if (ctx.files && ctx.files.write) { const w = await ctx.files.write(r.name, r.text, 'text/plain'); return { written: w.name, points: r.points }; }
        download(r.text, 'text/plain', r.name); return { saved: r.name, points: r.points };
      } },
    { name: 'photometry_run', core: true, description: 'Run the reduction: measure every frame (or the target pixel file), try every aperture, annulus and comparison choice, and keep the light curve with the least scatter. Returns what was selected and the quality of the result.',
      parameters: obj({}),
      async run() {
        if (!P.mode) throw new Error('nothing is loaded: the user opens a folder of FITS frames on the page, or attaches them to this chat (photometry_load_files)');
        if (P.busy) throw new Error('a reduction is already running');
        await run();
        if (!P.result || !P.lc) throw new Error($('stRun').textContent || 'the reduction did not finish');
        return outcome();
      } },
    { name: 'photometry_save', description: 'Write the reduced light curve as CSV (time, flux, error, airmass) and the reduction record as JSON to the files of this conversation.', parameters: obj({}),
      async run(_, { files }) { if (!P.lc) throw new Error('there is no light curve yet: photometry_run first'); const a = await files.write(fileStem() + '_lightcurve.csv', lcCsv(), 'text/csv'), b = await files.write(fileStem() + '_reduction.json', JSON.stringify(reductionRecord(), null, 1), 'application/json'); return { written: [a.name, b.name], note: 'On the analyze page, load_light_curve with the CSV file name fits it.' }; } },
    { name: 'photometry_find_archive', readOnly: true, description: 'List what the public MAST bucket holds for a star (TIC / KIC / EPIC id, TOI number, or a host name in the catalogue): every sector (Kepler quarter, K2 campaign) with its light curves and target pixel files: SPOC 2 min and 20 s, TESS-SPOC and QLP full-frame products, Kepler and K2 long and short cadence. Shows the picker on the page.',
      parameters: obj({ target: T('e.g. "TOI-1873", "TIC 328933398", "KIC 11446443", "EPIC 201367065", "WASP-18"') }, ['target']),
      async run({ target }) {
        $('inTarget').value = target; await findArchive();
        if (!P.archive || !P.archive.products.length) throw new Error($('stArch').textContent || 'nothing found');
        const by = {}; for (const p of P.archive.products) { const k = `${p.mission} ${p.label.replace(/ \(.*\)$/, '')}`; (by[k] = by[k] || new Set()).add(`${p.kind === 'tpf' ? 'TPF' : 'LC'} ${p.author} ${p.cadence} (${(p.size / 1048576).toFixed(1)} MB)`); }
        return { target: P.archive.target, products: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, [...v]])), next: 'photometry_load_archive with the sectors and cadence to stitch them; one TPF opens in the pixel view.' };
      } },
    { name: 'photometry_load_archive', description: 'Download and stitch products found by photometry_find_archive: one product per sector (never 20 s and 2 min of the same sector together), each normalised by its own median. A single target pixel file opens in the pixel view instead.',
      parameters: obj({ kind: T('Light curves or target pixel files (TPFs get the aperture search, and PLD for K2).', { enum: ['lc', 'tpf'] }), cadence: T('Which product per sector.', { enum: ['shortest', 'longest', '20 s', '2 min', 'FFI', '30 min', '1 min'] }), sources: { type: 'array', items: T('pipeline', { enum: ['SPOC', 'TESS-SPOC', 'QLP', 'Kepler', 'K2'] }), description: 'Allowed pipelines in order of preference (default: all but QLP).' }, sectors: { type: 'array', items: N('sector, quarter or campaign number'), description: 'Which to load (default all).' }, quality: T("lightkurve's quality mask", { enum: ['default', 'hard', 'hardest', 'none'] }), flux: T('Light-curve column', { enum: ['pdcsap', 'sap'] }) }),
      confirm: () => 'This downloads files from the MAST bucket (light curves are 1 to 3 MB a sector; TPFs 40 MB or more).',
      async run(a) {
        if (!P.archive) throw new Error('photometry_find_archive first');
        const A = P.archive; A.sel = A.sel || {};
        if (a.kind) A.sel.kind = a.kind; if (a.cadence) A.sel.cadence = a.cadence; if (a.sources) A.sel.authors = a.sources;
        if (a.sectors) A.sel.groups = A.products.filter((p) => a.sectors.includes(p.group)).map((p) => `${p.mission}|${p.group}`).filter((v, i, x) => x.indexOf(v) === i);
        buildArchivePicker(); if (a.quality && $('qPreset')) $('qPreset').value = a.quality; if (a.flux && $('lcFlux')) $('lcFlux').value = a.flux;
        await loadArchive(A.pick());
        if (P.mode === 'series') return { loaded: series.state(), next: 'photometry_prepare (it looks up the known planets and TOIs of the star itself).' };
        if (P.mode === 'tpf') return { loaded: frames(), next: 'photometry_run.' };
        throw new Error($('stArch').textContent || 'nothing loaded');
      } },
    { name: 'photometry_prepare', description: 'Prepare the loaded light curves (several sectors, or the reduced TPF) for transit fitting as the owner\'s TOI extraction does: mask every known transit, flatten each sector with a time-windowed biweight (window chosen by injected transits when "auto"), clip outliers at 4σ (never in transit), drop 30 min after gaps, and cut a window of ±2.5 T14 around every transit. Planets come from the catalogue and the TOI list unless given.',
      parameters: obj({ planets: { type: 'array', items: obj({ name: T('name'), per: N('period [d]'), tmid: N('mid-transit [BJD_TDB]'), t14_hours: N('duration [h] (optional)') }, ['per', 'tmid']), description: 'Planets to mask (added to those looked up).' }, lookup: { type: 'boolean', description: 'Look up the known planets and TOIs of the star (default true when none are set).' },
        window: T('Biweight window in days (e.g. "1.5"), or "auto" (chosen by injected transits; the default).'), pad: N('Mask ± pad × T14/2 (default 1.5).'), clip_sigma: N('Clip threshold (default 4).'), trim_minutes: N('Dropped after gaps (default 30).'), bin_seconds: N('Bin to this cadence (0: native).'), half_width: N('Window half-width in T14 (default 2.5).') }),
      async run(a) {
        if (P.mode === 'tpf' && P.lc) prepFromTpf();
        if (P.mode !== 'series') throw new Error('load light curves (photometry_load_archive or photometry_load_files) or reduce a TPF (photometry_run) first');
        for (const q of a.planets || []) series.S.planets.push({ name: q.name || `planet ${series.S.planets.length + 1}`, per: q.per, tmid: q.tmid, t14: q.t14_hours > 0 ? q.t14_hours / 24 : NaN, t14Source: q.t14_hours > 0 ? 'given' : '', source: 'assistant', use: true });
        if (a.lookup === true || (a.lookup !== false && !series.S.planets.length)) await series.lookup();
        const o = {}; if (a.window !== undefined) o.window = String(a.window) === 'auto' ? 'auto' : parseFloat(a.window) > 0 ? parseFloat(a.window) : 'auto'; if (a.pad) o.pad = a.pad; if (a.clip_sigma) o.clipSigma = a.clip_sigma; if (a.trim_minutes !== undefined) o.trimMinutes = a.trim_minutes; if (a.bin_seconds !== undefined) o.binTo = a.bin_seconds; if (a.half_width) o.durations = a.half_width;
        series.render(); await series.prepare(o);
        return { ...series.state(), next: 'photometry_send_to_analyze hands the transit windows (or with which "all" the whole flattened curve) to the analyzer.' };
      } },
    { name: 'photometry_send_to_analyze', core: true, description: 'Hand the reduced light curve to the analyzer and go there (the exposure time and the target name travel with it). After photometry_prepare: the transit windows (default) or the whole flattened light curve. The request continues on the analyze page, where the light curve is already loaded.', parameters: obj({ which: T('After photometry_prepare: the transit windows or all points.', { enum: ['windows', 'all'] }) }),
      run(a = {}) {
        if (P.mode === 'series') { const rec = series.handoff(a.which || 'windows'); localStorage.setItem('esl.handoff', JSON.stringify(rec)); return { handed_over: rec.name, navigate: { page: 'analyze', params: { handoff: 1 } } }; }
        if (!P.lc) throw new Error('there is no light curve yet: photometry_run first');
        // the same record the page's own "Open in Analyze" button leaves for the analyzer
        const lc = P.lc;
        localStorage.setItem('esl.handoff', JSON.stringify(handoffRecord()));
        return { handed_over: `${P.name}: ${lc.time.length} points`, navigate: { page: 'analyze', params: { handoff: 1 } } };
      } },
  ];
  (window.__esl = window.__esl || {}).photometry = { tools, ready: () => P.ready === true,
    state: () => { const f = frames(3); if (P.mode === 'series') { const st = series.state(); return [`Photometry: ${st.parts.length} light curves of ${P.name} (${st.parts.map((p) => p.segment).join(', ')}).`, st.prepared ? `Prepared: ${st.prepared.points} points, ${st.prepared.windows} transit windows; ready to hand to the analyzer.` : `Not prepared yet; ${st.planets.length} planets to mask.`]; } return [`Photometry: ${f.kind}${P.mode === 'stack' ? `, ${f.light_frames} light frames (${P.name}), ${P.stars.length} stars chosen` : P.mode === 'tpf' ? ` ${f.file}` : ''}${P.busy ? '; a reduction is running' : ''}.`, P.lc ? `Light curve: ${P.lc.time.length} points (${P.name}); ready to hand to the analyzer.` : 'No light curve yet.']; } };
}
