// Photometry page: files -> image viewer -> stars -> worker -> light curve, tried-apertures table, export.
// Science lives in src/core (fits.js, photometry.js, gp.js) and src/photometry/pipeline.js; this file is the UI.
import { siteRoot } from '../site/nav.js';
import { openFits, readTargetPixelFile, framePointing, frameTime } from '../core/fits.js';
import { centroidIter, detectSources, lightCurveFor, tpfLightCurve, pipelineMask, tpfMedianImage, medianOf, runningMedian, METHOD_LABEL } from '../core/photometry.js';
import { lombScarglePsd, welchPsd, splitSegments, whiteNoiseLevel, photonNoiseLevel, logBinPsd, fitRedNoise, rmsVsBin, pixelMap, polySurface } from '../core/psd.js';
import { FITS_NAME, readHeaderOnly, frameKind, loadFrame, splitFits, makeFitter, PHOT_VERSION } from './pipeline.js';
import { ImageViewer } from './viewer.js';
import { renderPanel, fitCanvas, PHOT_THEME, renderFov } from './plots.js';
import { renderPsd, renderRmsBin, renderPixelMap } from './diagnostics.js';
import { BUCKET, tessFiles, keplerFiles, k2Files, fetchBytes, resolveTarget } from './mast.js';
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
  h('section', { class: 'src' },
    h('div', { class: 'card' },
      h('h2', {}, 'Your images'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'bFolder', onclick: openFolder }, 'Open a folder'),
        h('button', { class: 'btn', id: 'bFiles', onclick: () => $('inFiles').click() }, 'Open files'),
        h('input', { type: 'file', id: 'inFiles', multiple: true, accept: '.fits,.fit,.fts,.gz,.fz,.FITS,.FIT,.FTS', hidden: true, onchange: (e) => addFiles([...e.target.files]) }),
        h('input', { type: 'file', id: 'inDir', multiple: true, webkitdirectory: true, hidden: true, onchange: (e) => addFiles([...e.target.files]) })),
      h('div', { class: 'drop', id: 'drop' }, 'or drop FITS files or a folder here. Light frames are put in time order; darks, flats and bias frames are recognised from IMAGETYP or the file name and applied. A single TESS / Kepler target pixel file also works.'),
      h('div', { class: 'status', id: 'stLocal' })),
    h('div', { class: 'card' },
      h('h2', {}, 'TESS, Kepler and K2 pixels'),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'wide', id: 'inTarget', placeholder: 'TIC 100100827, KIC 11446443, EPIC 201912552, or a host name (WASP-18)', onkeydown: (e) => { if (e.key === 'Enter') findArchive(); } }),
        h('button', { class: 'btn', id: 'bFind', onclick: findArchive }, 'Find files')),
      h('div', { class: 'filelist', id: 'archList', hidden: true }),
      h('div', { class: 'status', id: 'stArch' }, 'Target pixel files are read straight from the MAST public bucket on AWS. TESScut cutouts of full-frame images cannot be fetched from a web page (no CORS); download those and open the file.'),
      h('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, h('span', { class: 'dim' }, 'Try it:'), h('a', { href: '?demo=1' }, 'WASP-18 from TESS'), h('a', { href: '?demo=2' }, 'a synthetic night of frames'), h('a', { href: '?demo=3', title: 'Every third frame of the sample data EXOTIC is tested with (HAT-P-32 b, a 6-inch MicroObservatory telescope), cut down to the three stars' }, 'real frames of HAT-P-32 b')))),
  h('section', { class: 'work', id: 'work', hidden: true },
    h('div', { class: 'view' },
      h('div', { class: 'vbar top' },
        h('button', { class: 'btn sm', id: 'bPrev', title: 'Previous frame', onclick: () => showFrame(P.frame - 1) }, '◀'),
        h('input', { type: 'range', class: 'frame', id: 'frame', min: 0, max: 0, value: 0, oninput: (e) => showFrame(+e.target.value) }),
        h('button', { class: 'btn sm', id: 'bNext', title: 'Next frame', onclick: () => showFrame(P.frame + 1) }, '▶'),
        h('span', { class: 'mono dim', id: 'frameLabel' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', id: 'bPlay', onclick: togglePlay }, 'Play'),
        h('button', { class: 'btn sm', id: 'bBlink', title: 'Alternate with the first frame', onclick: toggleBlink }, 'Blink'),
        h('button', { class: 'btn sm', id: 'bMedian', hidden: true, title: 'Median of all cadences', onclick: () => { P.showMedian = !P.showMedian; $('bMedian').classList.toggle('on', P.showMedian); showFrame(P.frame); } }, 'Median')),
      h('canvas', { class: 'img', id: 'img' }),
      h('div', { class: 'vbar' },
        h('label', {}, 'Stretch', h('select', { id: 'stKind', onchange: restretch }, ...['asinh', 'linear', 'sqrt', 'log'].map((k) => h('option', {}, k)))),
        h('label', {}, 'Black', h('input', { type: 'range', id: 'stLo', min: 0, max: 60, step: 0.5, value: 10, oninput: restretch })),
        h('label', {}, 'White', h('input', { type: 'range', id: 'stHi', min: 90, max: 100, step: 0.02, value: 99.8, oninput: restretch })),
        h('button', { class: 'btn sm', onclick: () => viewer.fit() }, 'Fit'),
        h('span', { class: 'readout', id: 'readout' }, 'scroll to zoom, drag to pan'))),
    h('div', { class: 'side' },
      h('div', { class: 'card', id: 'cardStars' }),
      h('div', { class: 'card', id: 'cardSet' }),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'bRun', onclick: run }, 'Measure'), h('button', { class: 'btn', id: 'bStop', hidden: true, onclick: () => worker && worker.postMessage({ type: 'stop' }) }, 'Stop'), h('span', { class: 'dim', id: 'runNote' })),
        h('progress', { id: 'prog', max: 1, value: 0, hidden: true }),
        h('div', { class: 'status', id: 'stRun' })))),
  h('section', { class: 'live', id: 'live', hidden: true }),
  h('section', { class: 'res', id: 'res', hidden: true }));

const viewer = new ImageViewer($('img'));
viewer.onHover = (x, y, v) => { $('readout').textContent = `x ${x.toFixed(1)}  y ${y.toFixed(1)}  ${Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(4)) : ''}`; };
viewer.onClick = onImageClick;
viewer.onDraw = drawOverlay;

const setStatus = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = 'status ' + cls; };
function restretch() { viewer.setStretch({ kind: $('stKind').value, lo: +$('stLo').value, hi: +$('stHi').value }); }

// ------------------------------------------------------------------------------------------- opening files
async function openFolder() {
  if (!canPickDir) { $('inDir').click(); return; }
  try {
    const dir = await window.showDirectoryPicker(), files = [];
    const walk = async (d, depth, path) => { for await (const [name, handle] of d.entries()) { if (handle.kind === 'file') { if (FITS_NAME.test(name) || /\.fz$/i.test(name)) { const f = await handle.getFile(); f.relPath = path + name; files.push(f); } } else if (depth < 2) await walk(handle, depth + 1, path + name + '/'); } };
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
  let files = all.filter((f) => FITS_NAME.test(f.name));
  if (!files.length) { setStatus('stLocal', 'No FITS files found (looked for .fits, .fit, .fts, optionally .gz or .fz).', 'err'); return; }
  if (files.length === 1) { try { const parts = await splitFits(await files[0].arrayBuffer(), files[0].name.replace(FITS_NAME, '')); if (parts.length > 1) files = parts.map((q, i) => new File([q.buffer], /\.fi?ts?$/i.test(q.name) ? q.name : `${q.name}_${String(i + 1).padStart(4, '0')}.fits`)); } catch { /* not a container: carry on with the one file */ } }
  setStatus('stLocal', `Reading ${files.length} header${files.length > 1 ? 's' : ''}…`);
  const lights = [], cal = { bias: [], dark: [], flat: [] }; let bad = 0, tpfFile = null;
  for (let i = 0; i < files.length; i++) {
    try {
      const hd = await readHeaderOnly(files[i]);
      if (hd.primaryEmpty && hd.ext && String(hd.ext.XTENSION || '').trim() === 'BINTABLE') { tpfFile = tpfFile || files[i]; continue; }
      const kind = frameKind(hd.header, files[i].relPath || files[i].name);
      if (kind !== 'light') { cal[kind].push(files[i]); continue; }
      const t = frameTime(hd.header, hd.comments);
      lights.push({ file: files[i], jd: t.jd, header: hd.header, comments: hd.comments });
    } catch { bad++; }
    if (i % 25 === 24) setStatus('stLocal', `Reading headers… ${i + 1} / ${files.length}`);
  }
  if (tpfFile && !lights.length) { try { await loadTpf(await tpfFile.arrayBuffer(), tpfFile.name); setStatus('stLocal', `${tpfFile.name}: target pixel file.`, 'ok'); } catch (err) { setStatus('stLocal', String(err.message || err), 'err'); } return; }
  if (!lights.length) { setStatus('stLocal', `No light frames among ${files.length} FITS files (${cal.dark.length} dark, ${cal.flat.length} flat, ${cal.bias.length} bias${bad ? ', ' + bad + ' unreadable' : ''}).`, 'err'); return; }
  lights.sort((a, b) => (Number.isFinite(a.jd) && Number.isFinite(b.jd) ? a.jd - b.jd : a.file.name.localeCompare(b.file.name, undefined, { numeric: true })));
  Object.assign(P, { mode: 'stack', lights, cal, frame: 0, stars: [], detected: [], result: null, lc: null, gp: null, tpf: null, tpfBuffer: null, cur: null, live: null });
  if (P.name === 'photometry') P.name = (lights[0].header.OBJECT && String(lights[0].header.OBJECT).trim()) || lights[0].file.name.replace(FITS_NAME, '');
  const noTime = lights.filter((l) => !Number.isFinite(l.jd)).length;
  setStatus('stLocal', `${lights.length} light frames` + (cal.dark.length + cal.flat.length + cal.bias.length ? `, ${cal.dark.length} dark, ${cal.flat.length} flat, ${cal.bias.length} bias` : '') + (bad ? `, ${bad} unreadable` : '') + (noTime ? `. ${noTime} have no time keyword.` : '.'), noTime ? 'err' : 'ok');
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

function enterWork() {
  $('work').hidden = false; $('res').hidden = true; $('res').innerHTML = ''; $('live').hidden = true; $('live').innerHTML = '';
  const n = P.mode === 'tpf' ? P.tpf.ncad : P.lights.length;
  $('frame').max = n - 1; $('frame').value = 0;
  $('bMedian').hidden = P.mode !== 'tpf';
  $('stLo').value = P.mode === 'tpf' ? 0 : 10; $('stHi').value = P.mode === 'tpf' ? 100 : 99.8; viewer.stretch.lo = +$('stLo').value; viewer.stretch.hi = +$('stHi').value;
  viewer.fitted = false;
  buildStarsCard(); buildSettings();
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
  const { data, width: w, height: hh } = P.cur, det = detectSources(data, w, hh, { max: 80 });
  P.detected = det.sources;
  if (P.stars.length === 1 || (P.stars.length === 0 && det.sources.length)) {
    // comparison stars: up to four detections closest in brightness to the target (0.3x to 3x), away from the edge and unsaturated
    const sat = P.cur.header.BITPIX === 16 ? 60000 : Infinity;
    if (!P.stars.length) { const mid = det.sources.filter((s) => s.peak < sat).sort((a, b) => Math.hypot(a.x - w / 2, a.y - hh / 2) - Math.hypot(b.x - w / 2, b.y - hh / 2))[0]; if (mid) P.stars.push({ x: mid.x, y: mid.y, peak: mid.peak }); }
    const tg = P.stars[0], tf = det.sources.reduce((b, s) => (Math.hypot(s.x - tg.x, s.y - tg.y) < Math.hypot(b.x - tg.x, b.y - tg.y) ? s : b), det.sources[0]).flux;
    const cands = det.sources.filter((s) => Math.hypot(s.x - tg.x, s.y - tg.y) > 12 && s.peak < sat && s.flux > 0.3 * tf && s.flux < 3 * tf && s.x > 20 && s.y > 20 && s.x < w - 21 && s.y < hh - 21)
      .sort((a, b) => Math.abs(Math.log(a.flux / tf)) - Math.abs(Math.log(b.flux / tf))).slice(0, 4);
    for (const c of cands) P.stars.push({ x: c.x, y: c.y, peak: c.peak });
  }
  buildStarsCard(); viewer.draw();
  setStatus('stRun', `${det.sources.length} stars found (sky ${det.background.toFixed(0)}, noise ${det.sigma.toFixed(1)} per pixel).`);
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
  el.append(h('ul', { class: 'stars' }, P.stars.map((s, i) => h('li', { class: i ? 'c' : 't' }, h('b', {}, i ? 'C' + i : 'T'), h('span', {}, `${s.x.toFixed(1)}, ${s.y.toFixed(1)}${Number.isFinite(s.peak) ? '   peak ' + s.peak.toFixed(0) : ''}`), s.peak >= sat ? h('span', { style: 'color:var(--warn);flex:none', title: 'Near the 16-bit limit: this star may be saturated' }, 'sat?') : null, h('button', { title: 'Remove', onclick: () => { P.stars.splice(i, 1); P.result = null; buildStarsCard(); viewer.draw(); } }, '✕')))));
  el.append(h('div', { class: 'row' },
    h('button', { class: 'btn sm', onclick: detect, title: 'Find stars on the first frame; with a target chosen, suggests comparison stars of similar brightness' }, P.stars.length === 1 ? 'Suggest comparisons' : 'Detect stars'),
    P.stars.length ? h('button', { class: 'btn sm', onclick: () => { P.stars = []; P.result = null; buildStarsCard(); viewer.draw(); } }, 'Clear') : null));
  if (P.stars.length === 1) el.append(h('p', { class: 'warnline' }, 'With no comparison star the light curve is the target alone: fine from space, rarely from the ground.'));
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
      h('label', {}, 'Aperture radii (× PSF σ): from, to, how many', h('div', { class: 'row3' }, h('input', { type: 'number', id: 'sA0', value: 1.5, step: 0.1, min: 0.5, title: 'from' }), h('input', { type: 'number', id: 'sA1', value: 6, step: 0.5 }), h('input', { type: 'number', id: 'sAn', value: 12, min: 1, max: 40, title: 'how many' }))),
      h('label', {}, 'Sky annulus width (× σ): from, to, how many', h('div', { class: 'row3' }, h('input', { type: 'number', id: 'sN0', value: 6, step: 0.5, min: 1 }), h('input', { type: 'number', id: 'sN1', value: 15, step: 0.5 }), h('input', { type: 'number', id: 'sNn', value: 4, min: 1, max: 20, title: 'how many' }))),
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
        ...[['pPer', 'Period [d]', 'per'], ['pTmid', 'Mid-transit [BJD]', 'tmid'], ['pRprs', 'Rp/R★', 'rprs'], ['pArs', 'a/R★', 'ars'], ['pInc', 'Inclination [°]', 'inc'], ['pEcc', 'Eccentricity', 'ecc'], ['pOm', 'ω [°]', 'omega'], ['pTu', 'Mid-transit uncertainty [d]', 'tmidUnc']].map(([id, lab, k]) => h('label', {}, lab, h('input', { type: 'text', id, value: P.planet && P.planet[k] != null ? String(P.planet[k]) : (k === 'ecc' ? '0' : k === 'omega' ? '0' : k === 'tmidUnc' ? '0.01' : '') }))),
        h('label', { class: 'full', title: 'Four coefficients of the Claret law. The default is a G star in a red band (HD 80606 in the TESS band from ExoTETHyS); the choice hardly matters for ranking apertures.' }, 'Limb darkening (Claret a1..a4)', h('input', { type: 'text', id: 'pLd', value: (P.planet && P.planet.ld ? P.planet.ld : [0.4939, -0.0729, 0.4578, -0.2158]).join(', ') }))),
      h('label', { title: 'Electrons per count, for the photon-noise limit in the diagnostics. Taken from GAIN or EGAIN in the header when present.' }, 'Gain [e⁻/ADU]', h('input', { type: 'text', id: 'sGain', value: P.lights.length && Number(P.lights[0].header.GAIN ?? P.lights[0].header.EGAIN) > 0 ? String(Number(P.lights[0].header.GAIN ?? P.lights[0].header.EGAIN)) : '', placeholder: 'unknown' })),
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
const compName = (c, n) => (c < 0 ? 'none' : c === 0 ? `all ${n}` : 'C' + c);
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
  P.lc = { kind: 'stack', time: lc.time, norm: lc.norm, err: lc.normErr, photErr: lc.photErr, photErrStar: lc.photErrStar, model: lc.model, baseline: lc.baseline, resid: lc.resid, keep: lc.keep, x: lc.x, y: lc.y, bg: lc.background, airmass: lc.airmass, fwhm: lc.fwhm, rot: lc.rot, exptime: medianOf(lc.exptime), fit: lc.fit, timeSystem: R.timeSystem };
}
function setTpfLc(i) {
  const R = P.result, row = R.opt.tried[i], lc = tpfLightCurve(P.tpf, row.mask, { quality: R.meta.quality }), good = []; for (let k = 0; k < lc.ok.length; k++) if (lc.ok[k]) good.push(k);
  const pick = (a) => Float64Array.from(good, (k) => a[k]), f = pick(lc.flux), med = medianOf(f), time = pick(lc.time), norm = f.map((v) => v / med), err = pick(lc.err).map((v) => v / med);
  // residuals for the diagnostics: flux over a running median of 0.75 d, outliers (flares, momentum dumps) set aside
  const cad = (time[time.length - 1] - time[0]) / Math.max(1, time.length - 1), win = Math.max(5, 2 * Math.floor(0.75 / cad / 2) + 1), sm = runningMedian(norm, win), resid = norm.map((v, k) => v / sm[k] - 1);
  const mad = 1.4826 * medianOf(Array.from(resid, Math.abs)), keep = Uint8Array.from(resid, (v) => (Math.abs(v) < 5 * mad ? 1 : 0));
  P.sel = i; P.gp = null;
  P.lc = { kind: 'tpf', time, norm, err, photErr: err, x: pick(lc.x), y: pick(lc.y), bg: pick(lc.bkg), keep: null, keepR: keep, resid, smooth: sm, exptime: R.meta.exptime, timeSystem: 'BJD_TDB', median: med };
}

// ------------------------------------------------------------------------------------------- diagnostics
/** Residuals now (after any detrending) and before, the points to use, and what the two plots and the map need. */
function diagnose() {
  const lc = P.lc, n = lc.time.length, keep = lc.keep || lc.keepR, before = lc.resid;
  let after = null, trendPts = null;
  if (P.gp && P.gp.kind === 'sff') { const sm = runningMedian(P.gp.detrended, Math.max(5, 2 * Math.floor(0.75 / ((lc.time[n - 1] - lc.time[0]) / (n - 1)) / 2) + 1)); after = Float64Array.from(P.gp.detrended, (v, i) => v / sm[i] - 1); trendPts = Float64Array.from(before, (v, i) => v - after[i]); }
  else if (P.gp) { after = Float64Array.from(before, (v, i) => (Number.isFinite(P.gp.trend[i]) ? v - P.gp.trend[i] : NaN)); trendPts = P.gp.trend; }
  const cur = after || before, idx = []; for (let i = 0; i < n; i++) if ((!keep || keep[i]) && Number.isFinite(cur[i]) && Number.isFinite(lc.time[i]) && Number.isFinite(lc.x[i]) && Number.isFinite(lc.y[i])) idx.push(i);
  if (idx.length < 12) return null;
  const pick = (a) => Float64Array.from(idx, (i) => a[i]), t = pick(lc.time), r = pick(cur), r0 = pick(before), e = pick(lc.err), m = r.reduce((a, b) => a + b, 0) / r.length;
  for (let i = 0; i < r.length; i++) r[i] -= m;
  const dts = Float64Array.from({ length: t.length - 1 }, (_, i) => t[i + 1] - t[i]), dt = medianOf(dts);
  let sp;
  if (idx.length <= 3000) sp = lombScarglePsd(t, r);
  else { const seg = splitSegments(t).segments; let np2 = 256; while (np2 * 8 <= idx.length && np2 < 4096) np2 *= 2; sp = welchPsd(r, dt, { nperseg: np2, segments: seg }); }
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
  if (trendPts) { const tp = pick(trendPts), ok = tp.every(Number.isFinite); surface = ok ? pixelMap(x, y, tp, { nx: g, ny: g, range: [pm.grid.x0, pm.grid.x1, pm.grid.y0, pm.grid.y1] }).mean : null; sName = P.gp.kind === 'sff' ? 'self-flat-field correction (binned)' : 'Gaussian-process trend (binned)'; }
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
      card('Comparison', row.comp < 0 ? 'none' : row.comp === 0 ? `all ${R.M.nS - 1}` : 'C' + row.comp),
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
    h('label', { class: 'dim', style: 'font-size:12px' }, h('input', { type: 'checkbox', id: 'gpTime' }), ' GP also against time'),
    P.gp ? h('button', { class: 'btn sm', onclick: () => { P.gp = null; renderResults(); } }, 'Undo detrending') : null,
    h('span', { class: 'dim', id: 'gpNote', style: 'font-size:12px' })));
  el.append(h('h2', { style: 'margin-top:14px' }, 'Is the noise white? Does the flux follow the star across the detector?'),
    h('div', { class: 'plots two' }, h('div', { class: 'card' }, cPsd), h('div', { class: 'card' }, cRms)), h('div', { class: 'card', style: 'margin-top:10px' }, cMap), h('p', { class: 'note2', id: 'diagNote' }));
  // tried table
  const tried = R.opt.tried.map((t, i) => ({ t, i })).sort((a, b) => (a.t.scatter - b.t.scatter) || 0), hasP = R.kind === 'stack' && R.opt.tried.some((t) => t.params);
  const head = R.kind === 'stack' ? ['method', 'aperture [px]', 'annulus [px]', 'comparison', 'scatter [%]', 'robust [%]', 'points', hasP ? 'Rp/R★' : 'depth [%]', ...(hasP ? ['T mid − ' + Math.floor(lc.time[0])] : [])] : ['aperture', 'pixels', 'scatter [ppm]', 'EXOTIC std [e⁻/s]', 'median flux', 'cadences'];
  const cells = (t) => (R.kind === 'stack'
    ? [METHOD_LABEL[t.method] || t.method, t.aperture ? t.aperture.toFixed(2) : '—', t.annulus ? t.annulus.toFixed(2) : '—', t.comp < 0 ? 'none' : t.comp === 0 ? 'all' : 'C' + t.comp, (100 * t.scatter).toFixed(4), (100 * t.robust).toFixed(4), t.n, hasP ? (t.params ? t.params.rprs.toFixed(4) : '—') : t.depth ? (100 * t.depth).toFixed(3) : '—', ...(hasP ? [t.params ? (t.params.tmid - Math.floor(lc.time[0])).toFixed(5) : '—'] : [])]
    : [t.name + (t.eligible ? '' : ' (too little flux)'), t.npix, (1e6 * t.scatter).toFixed(0), t.exotic.toFixed(2), t.flux.toFixed(0), t.n]);
  const tb = h('tbody', {}, tried.map(({ t, i }) => h('tr', { class: (i === R.opt.best ? 'best ' : '') + (i === P.sel ? 'sel ' : '') + (t.eligible === false ? 'inel' : ''), onclick: () => { R.kind === 'stack' ? setStackLc(i) : setTpfLc(i); renderResults(); viewer.draw(); } }, cells(t).map((v) => h('td', {}, v)))));
  const wins = R.kind === 'stack' ? Object.entries(tried.reduce((o, { t }) => { if (!(t.method in o)) o[t.method] = t.scatter; return o; }, {})).map(([m, v]) => `${METHOD_LABEL[m]} ${(100 * v).toFixed(3)}%`).join(' · ') : '';
  el.append(h('div', { class: 'card tried' }, h('h2', {}, `What was tried: ${tried.length} candidates, lowest scatter first (click a row to see it)`), wins ? h('p', { class: 'hint' }, 'Best of each method: ' + wins + (R.fitter ? '. Scored with the transit model.' : '. Scored with the quick trapezoid fit.')) : null, h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), tb))));
  el.append(h('div', { class: 'out' },
    h('button', { class: 'btn primary', onclick: openInAnalyze }, 'Open in Analyze'),
    h('button', { class: 'btn', onclick: saveCsv }, 'Save light curve (CSV)'),
    h('button', { class: 'btn', onclick: saveJson, title: 'Everything needed to repeat this reduction: software version, star positions, apertures, the row chosen, the table of what was tried, the frames and their times.' }, 'Save reduction settings (JSON)'),
    h('label', { class: 'dim', style: 'font-size:12px' }, h('input', { type: 'checkbox', id: 'useGp', disabled: !P.gp }), ' export the detrended flux')),
  h('p', { class: 'note2' }, R.kind === 'stack'
    ? 'The exported flux is target / comparison divided by its median baseline, with the airmass of each frame so that the analyzer can fit the airmass trend itself. The uncertainty is the robust scatter of the residuals of the fit, the same for every point.'
    : 'The exported flux is the aperture sum divided by its median; uncertainties are the pipeline pixel errors added in quadrature. Stellar variability is left in: flatten it in the analyzer.'));
  const draw = () => {
    const x = lc.time, off = Math.floor(x[0]), xl = `${lc.timeSystem === 'BJD_TDB' ? 'BJD_TDB' : 'JD'} − ${off}`, th = PHOT_THEME;
    // field of view with the apertures of the chosen row
    let g = fitCanvas(cFov, 474);
    if (R.kind === 'stack') {
      const rA = isAp ? row.aperture : 3 * R.sigma, rIn = isAp ? rA + R.M.gap : rA + 4, rOut = isAp ? rIn + row.annulus : rIn + 8, used = row.comp < 0 ? [0] : row.comp === 0 ? null : [0, row.comp];
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

const gpText = (g) => (g.kind === 'sff'
  ? `self-flat-field: robust scatter ${(1e6 * g.rmsBefore).toFixed(0)} → ${(1e6 * g.rmsAfter).toFixed(0)} ppm about a 1.5 d running median; ${g.windows} windows; ${g.ms.toFixed(0)} ms`
  : `residual rms ${(1e6 * g.rmsBefore).toFixed(0)} → ${(1e6 * g.rmsAfter).toFixed(0)} ppm; length scales ${g.hyper.scales.map((s, i) => s.toPrecision(2) + (i < 2 ? ' px' : ' d')).join(', ')}, amplitude ${(1e6 * g.hyper.amp).toFixed(0)} ppm, white noise ${(1e6 * g.hyper.noise).toFixed(0)} ppm; hyperparameters from ${g.nHyper} points, conditioned on ${g.nCond} of ${g.n}; ${(g.ms / 1000).toFixed(1)} s`);
async function runDetrend(kind) {
  const lc = P.lc; if (!lc || P.busy) return;
  $('bGp').disabled = true; $('bSff').disabled = true; $('gpNote').textContent = 'Fitting…';
  try {
    const payload = { time: lc.time, norm: lc.norm, resid: lc.kind === 'stack' ? lc.resid : null, keep: lc.keep || null, x: lc.x, y: lc.y };
    const g = await call(kind === 'sff' ? { type: 'sff', lc: payload, opts: {} } : { type: 'gp', lc: payload, opts: { useTime: $('gpTime').checked } });
    if (!g) throw new Error('Too few points with a centroid.');
    g.kind = kind; P.gp = g; const ut = $('gpTime').checked; renderResults(); $('gpTime').checked = ut;
  } catch (err) { $('gpNote').textContent = String(err.message || err); $('bGp').disabled = false; $('bSff').disabled = false; }
}

// ------------------------------------------------------------------------------------------- export
function lcCsv() {
  const lc = P.lc, useGp = P.gp && $('useGp') && $('useGp').checked, f = useGp ? P.gp.detrended : lc.norm, am = lc.kind === 'stack' && lc.airmass.every(Number.isFinite) && !useGp;
  const tcol = lc.timeSystem === 'BJD_TDB' ? 'BJD_TDB' : 'JD_UTC', rows = [`${tcol},flux,flux_err${am ? ',airmass' : ''}`];
  for (let i = 0; i < lc.time.length; i++) { if ((lc.keep && !lc.keep[i]) || !Number.isFinite(f[i]) || !Number.isFinite(lc.time[i])) continue; rows.push(`${lc.time[i].toFixed(7)},${f[i].toFixed(7)},${(Number.isFinite(lc.err[i]) ? lc.err[i] : 0).toFixed(7)}${am ? ',' + lc.airmass[i].toFixed(5) : ''}`); }
  return rows.join('\n') + '\n';
}
const download = (text, type, name) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const fileStem = () => P.name.replace(/[^\w.\-]+/g, '_');
function saveCsv() { download(lcCsv(), 'text/csv', fileStem() + '_lightcurve.csv'); }

/** What a reader needs to repeat or audit the reduction. */
function reductionRecord() {
  const R = P.result, lc = P.lc, row = R.opt.tried[P.sel], D = P.diag, round = (v, d = 6) => (Number.isFinite(v) ? +v.toPrecision(d) : null);
  const out = { software: 'Exoplanet Science Lab photometry', version: PHOT_VERSION, page: location.origin + location.pathname, created: new Date().toISOString(), name: P.name, kind: R.kind, timeSystem: lc.timeSystem, points: lc.time.length, exposureSeconds: round(lc.exptime) };
  if (R.kind === 'stack') {
    Object.assign(out, { target: targetInfo(), settings: R.settings, selected: { ...row, isBest: P.sel === R.opt.best }, fit: lc.fit.params ? { model: 'transit x a1 exp(a2 airmass), least squares', params: lc.fit.params, errors: lc.fit.errors, atBound: lc.fit.atBound } : { model: 'quick trapezoid', depth: round(lc.fit.depth), tmid: lc.fit.tmid, durationDays: round(lc.fit.duration) },
      tried: R.opt.tried.map((t) => ({ method: t.method, aperture: round(t.aperture), annulus: round(t.annulus), comparison: t.comp < 0 ? 'none' : t.comp === 0 ? 'all' : 'C' + t.comp, scatter: round(t.scatter), robust: round(t.robust), points: t.n })),
      frames: R.frames.map((f) => ({ name: f.name, time: f.jd, timeKeyword: f.keyword, shiftedDays: f.shifted, airmassFrom: f.airmassSource, error: f.error })), fieldRefound: R.relocated, timing: R.timing });
  } else Object.assign(out, { target: targetInfo(), file: P.tpfName, meta: R.meta, selected: { name: row.name, pixels: row.npix, scatterPpm: round(1e6 * row.scatter), mask: Array.from(row.mask), isBest: P.sel === R.opt.best }, qualityBitmask: R.meta.quality, tried: R.opt.tried.map((t) => ({ name: t.name, pixels: t.npix, scatterPpm: round(1e6 * t.scatter), eligible: t.eligible })) });
  if (P.gp) out.detrending = P.gp.kind === 'sff' ? { method: 'self-flat-fielding (Vanderburg & Johnson 2014)', windows: P.gp.windows, robustBefore: round(P.gp.rmsBefore), robustAfter: round(P.gp.rmsAfter) } : { method: 'Gaussian process on the centroid', hyper: P.gp.hyper, rmsBefore: round(P.gp.rmsBefore), rmsAfter: round(P.gp.rmsAfter), againstTime: !!P.gp.useTime };
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
  const tg = targetInfo(), lc = P.lc, ex = Number.isFinite(lc.exptime) ? lc.exptime : null;
  const hand = { kind: 'lightcurve', name: P.name, text: lcCsv(), source: 'photometry', version: PHOT_VERSION, exptime: ex, exptimeDays: ex != null ? ex / 86400 : null, target: tg.name || null, ra: Number.isFinite(tg.ra) ? tg.ra : null, dec: Number.isFinite(tg.dec) ? tg.dec : null, timeSystem: lc.timeSystem, filter: tg.filter || null, planet: P.result.cfg && P.result.cfg.planet ? P.result.cfg.planet : null };
  try { localStorage.setItem('esl.handoff', JSON.stringify(hand)); } catch (err) { setStatus('stRun', 'Could not hand the light curve over (storage is full or blocked): save the CSV and open it in Analyze.', 'err'); return; }
  location.href = new URL('analyze/?handoff=1', siteRoot()).href;
}

// ------------------------------------------------------------------------------------------- archive
async function findArchive() {
  const q = $('inTarget').value.trim(); if (!q) return;
  const list = $('archList'); list.hidden = true; list.innerHTML = ''; $('bFind').disabled = true;
  try {
    setStatus('stArch', 'Looking up the target…');
    const tg = await resolveTarget(q, siteRoot());
    if (!tg.tic && !tg.kic && !tg.epic) throw new Error(`"${q}" is not in this site's catalogue. Enter a TIC, KIC or EPIC number.`);
    let files = [];
    if (tg.kic) { setStatus('stArch', `KIC ${tg.kic}: listing Kepler files…`); files = files.concat(await keplerFiles(tg.kic)); }
    if (tg.epic) files = files.concat(await k2Files(tg.epic, (d, n) => setStatus('stArch', `EPIC ${tg.epic}: checking K2 campaigns ${d} / ${n}…`)));
    if (tg.tic) files = files.concat(await tessFiles(tg.tic, (d, n) => setStatus('stArch', `TIC ${tg.tic}: checking sector folders ${d} / ${n}…`)));
    if (!files.length) throw new Error(`No target pixel files for ${tg.name}${tg.tic ? ' (TIC ' + tg.tic + ')' : ''} in the archive bucket. A star that was only in the full-frame images has none: get a TESScut cutout from MAST and open the file.`);
    for (const f of files) list.append(h('button', { onclick: () => fetchArchive(f, tg) }, h('span', {}, `${f.mission} ${f.label}`), h('span', { class: 'dim' }, f.cadence), h('span', {}, fmtMB(f.size))));
    list.hidden = false;
    setStatus('stArch', `${tg.name}${tg.tic ? ' · TIC ' + tg.tic : ''}${tg.kic ? ' · KIC ' + tg.kic : ''}${tg.epic ? ' · EPIC ' + tg.epic : ''}: ${files.length} file${files.length > 1 ? 's' : ''}. Choose one to download and open.`, 'ok');
  } catch (err) { setStatus('stArch', String(err.message || err), 'err'); }
  $('bFind').disabled = false;
}
async function fetchArchive(f, tg) {
  try {
    const buf = await fetchBytes(BUCKET + f.key, (n, t) => setStatus('stArch', `Downloading ${f.mission} ${f.label}: ${fmtMB(n)}${t ? ' of ' + fmtMB(t) : ''}`));
    setStatus('stArch', 'Decoding…');
    await loadTpf(buf, f.key.split('/').pop());
    setStatus('stArch', `${tg.name}: ${f.mission} ${f.label} loaded (${fmtMB(buf.byteLength)}).`, 'ok');
    $('work').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { setStatus('stArch', String(err.message || err), 'err'); }
}

// ------------------------------------------------------------------------------------------- demos
// ?demo=3: the sample EXOTIC is tested with. The file is looked for in public/photometry/ first and then in test/data/
// (which only the development server serves): see the README about redistributing it.
const HATP32 = { stars: [[424, 286], [465, 183], [512, 263]], planet: { per: 2.1500082, tmid: 2455867.402743, rprs: 0.14886, ars: 5.344, inc: 88.98, ecc: 0.159, omega: 50, tmidUnc: 0.01, perUnc: 1.3e-7, ld: [2.087256262382093, -3.7643210784163745, 4.249285588883468, -1.5722207728491862] }, ra: 31.0417, dec: 46.6897, lat: 32.4164, lon: -110.7344 };
(async () => {
  const demo = new URLSearchParams(location.search).get('demo');
  try {
    if (demo === '1') {
      setStatus('stArch', 'Loading the bundled TESS cut-out of WASP-18 (700 cadences of sector 2)…');
      const buf = await (await fetch(new URL('photometry/tess_wasp18_s02_sub_tp.fits', siteRoot()))).arrayBuffer();
      await loadTpf(buf, 'tess_wasp18_s02_sub_tp.fits'); setStatus('stArch', 'WASP-18, TESS sector 2: one orbit cut from the real target pixel file.', 'ok');
      await run();
    } else if (demo === '2') {
      setStatus('stLocal', 'Making a synthetic night…'); P.name = 'ESL demo field';
      await addFiles(makeDemoFrames());
      P.stars = [DEMO_TRUTH.target, ...DEMO_TRUTH.comps.slice(0, 3)].map((s) => { const c = centroidIter(P.cur.data, P.cur.width, P.cur.height, s.x, s.y, 8); return { x: c[0], y: c[1], peak: P.cur.data[Math.round(c[1]) * P.cur.width + Math.round(c[0])] }; });
      buildStarsCard(); viewer.draw();
      await run();
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
      await run();
    }
  } catch (err) { setStatus(demo === '1' ? 'stArch' : 'stLocal', String(err.message || err), 'err'); }
  P.ready = true;
})();
