// Run page: one observing sequence from start to end. The sequence (src/core/sequence.js) says what to do; the
// camera driver (cameras.js: the local helper, any Alpaca camera, or a simulated one) takes the frame; every frame
// gets the full header of src/core/fitsheader.js and is saved where the user chose; light frames are calibrated
// with the masters made from this sequence's bias, darks and flats and reduced at once (src/core/reduce.js); at the
// end (or at any time) the light curve with the best aperture and comparison stars goes to Analyze, as from the
// Photometry page.
//
// State is the one object R below; nothing else holds data. ?sim=fast makes "Try now" a two-minute test sequence
// of 2 s frames (headless checks); ?camera=sim|helper|alpaca preselects the camera.

import clock, { mountClockBadge, helperUrl } from '../../site/clock.js';
import { siteRoot } from '../../site/nav.js';
import { alpacaCamera, simCamera } from './cameras.js';
import { makeSequence, validateSequence, nextAction, advance, startState, resume, stop, sequenceSummary, envAt } from '../../core/sequence.js';
import { frameHeader } from '../../core/fitsheader.js';
import { encodeFits, parseFits } from '../../core/fits.js';
import { createReducer, chooseStars as pickStars } from '../../core/reduce.js';
import { optimise, medianOf } from '../../core/photometry.js';
import { makeZip } from '../../core/zip.js';
import { REHEARSAL_PLANETS, nextObservableTransit, virtualClock, fluxAtUtc, t14 as transitDuration } from '../../core/rehearsal.js';
import { fromPlanEvent } from '../../core/sequence.js';
import { utcToBjdTdb } from '../../core/fits.js';
import { jdFromMs } from '../../core/timescale.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search), FAST = q.get('sim') === 'fast';
const VERSION = '0.2.0';
const R = {
  cam: null, props: null, seq: null, st: null, running: false, abort: null,
  cal: { bias: null, dark: null, flat: null },                // running sums for the masters: { sum: Float64Array, n }
  masters: null, reducer: null, stars: null, live: [], frameNo: 0, saved: [], zip: [], dir: null, lastFrame: null, log: [],
};
window.__run = R;
// the page's clock: the corrected clock, or the virtual clock of a rehearsal (a simulated night, faster than real time)
let VC = null;
const nowMs = () => (VC ? VC.now() : clock.now());
const realMs = (virtualMs) => (VC ? virtualMs / VC.speed : virtualMs);
const vclockInfo = () => ({ source: 'rehearsal', label: `simulated time (rehearsal, ${VC.speed}x)`, offset: 0, unc: 0 });                                             // for the headless checks

// ------------------------------------------------------------------------------------------------ log and status
function log(text, cls = '') {
  const at = new Date(nowMs()).toISOString().slice(11, 19);
  R.log.push({ at, text, cls });
  const li = document.createElement('li'); li.textContent = `${at}  ${text}`; if (cls) li.className = cls;
  $('r-log').append(li); $('r-log').scrollTop = 1e9;
}
const status = (t, cls = '') => { const s = $('r-status'); s.textContent = t; s.className = 'r-status' + (cls ? ' ' + cls : ''); };
function counts() {
  if (!R.st) { $('r-counts').textContent = ''; return; }
  const c = R.st.counts, C = R.seq.calibration;
  $('r-counts').textContent = `phase ${R.st.phase} · bias ${c.bias}/${C.bias} · darks ${c.dark}/${C.darks} · flats ${c.flat}/${C.flats} · lights ${c.light}${R.saved.length ? ` · saved ${R.saved.length}` : ''}`;
}

// ------------------------------------------------------------------------------------------------ camera
function camKind() { const k = $('r-camkind').value; $('r-urlrow').hidden = k !== 'alpaca'; $('r-trackrow').hidden = k !== 'sim'; return k; }
$('r-camkind').addEventListener('change', camKind);
$('r-connect').addEventListener('click', async () => {
  const k = camKind();
  try {
    status('Connecting…');
    if (k === 'sim') {
      R.cam = simFor(R.seq || readForm(true));
    } else {
      const url = k === 'helper' ? (helperUrl() || 'http://localhost:11111') : $('r-url').value.trim();
      R.cam = alpacaCamera(url);
    }
    R.props = await R.cam.connect();
    if (k === 'helper' && R.props.helper) { await clock.useHelper(R.cam.base); log('the helper’s clock is used for the exposure times'); }
    const p = R.props;
    $('r-caminfo').textContent = `${p.name}: ${p.width} × ${p.height} px${Number.isFinite(p.pixelSize) ? `, ${p.pixelSize} µm` : ''}${p.bayer ? `, colour (${p.bayer.pattern})` : ', mono'}${p.canCool ? ', cooled' : ''}${p.helper ? ' · through the local helper' : ''}.`;
    $('r-caminfo').className = 'hint';
    if (p.gain) { $('r-gain').min = p.gain[0]; $('r-gain').max = p.gain[1]; if ($('r-gain').value === '') $('r-gain').value = Math.round((p.gain[0] + p.gain[1]) / 3); }
    if (p.offset) { $('r-offset').min = p.offset[0]; $('r-offset').max = p.offset[1]; if ($('r-offset').value === '') $('r-offset').value = Math.round((p.offset[0] + p.offset[1]) / 4); }
    $('r-connect').disabled = true; $('r-disconnect').disabled = false;
    log(`connected: ${p.name}`); status('Connected.'); ready();
    pollTemp();
  } catch (err) { $('r-caminfo').textContent = err.message; $('r-caminfo').className = 'hint err'; status('Not connected.', 'err'); R.cam = null; }
});
$('r-disconnect').addEventListener('click', async () => { if (R.running) return; await R.cam?.disconnect(); R.cam = null; R.props = null; $('r-connect').disabled = false; $('r-disconnect').disabled = true; $('r-caminfo').textContent = 'Not connected.'; ready(); });
let tempTimer = 0;
async function pollTemp() {
  clearTimeout(tempTimer);
  if (!R.cam) return;
  try { const s = await R.cam.status(); if (Number.isFinite(s.ccdTemp)) { $('r-temp').textContent = `Sensor ${s.ccdTemp.toFixed(1)} °C${Number.isFinite(s.coolerPower) ? `, cooler ${s.coolerPower.toFixed(0)}%` : ''}`; R.ccdTemp = s.ccdTemp; } } catch { /* next time */ }
  tempTimer = setTimeout(pollTemp, R.running ? 5000 : 3000);
}

/** The simulated camera for a sequence: a 1.2% transit at the event's mid-time (else the middle of the window), lasting the event (else half the window). */
function simFor(seq) {
  const ev = seq && seq.event, w = seq && seq.window, pl = seq && seq.planet;
  const real = pl && [pl.rprs, pl.ars, pl.inc, pl.per, pl.tmid].every(Number.isFinite);
  const vmag = seq?.target?.mag ?? 11;
  return simCamera({ width: 240, height: 180, depth: 0.012, site: seq?.site, target: seq?.target, now: nowMs, speed: VC ? VC.speed : 1, clockInfo: VC ? vclockInfo : null,
    lightCurve: real ? fluxAtUtc({ ...pl, ra: seq.target.ra, dec: seq.target.dec }) : null,
    tmid: ev ? ev.mid : w ? (w.start + w.end) / 2 : null, duration: ev ? (ev.egress - ev.ingress) / 3600e3 : w ? (w.end - w.start) / 7200e3 : 2,
    t0: w ? w.start : null, tracking: $('r-tracking').value, clear: 30,
    // ADU/s of the target: 4000 at V = 11 (a 20-40 cm telescope); short test frames get a bright target so the transit shows
    flux: seq && seq.exposure.duration < 10 && !real ? 40000 : 4000 * 10 ** (-0.4 * (vmag - 11)) });
}

// ------------------------------------------------------------------------------------------------ sequence form
const toLocalInput = (ms) => new Date(ms).toISOString().slice(0, 19);
const fromInput = (v) => (v ? Date.parse(v + 'Z') : NaN);
function fillForm(s) {
  $('r-tname').value = s.target.name || ''; $('r-ra').value = s.target.ra; $('r-dec').value = s.target.dec;
  $('r-lat').value = s.site.lat; $('r-lon').value = s.site.lon; $('r-elev').value = s.site.elev || 0;
  $('r-start').value = toLocalInput(s.window.start); $('r-end').value = toLocalInput(s.window.end);
  $('r-exp').value = s.exposure.duration; $('r-filter').value = s.exposure.filter || ''; $('r-minalt').value = s.limits.minAlt;
  $('r-nbias').value = s.calibration.bias; $('r-ndark').value = s.calibration.darks; $('r-nflat').value = s.calibration.flats; $('r-calwhen').value = s.calibration.when;
  $('r-meridian').value = s.limits.meridian; $('r-settemp').value = s.cooler.setTemp; $('r-cooler').checked = !!s.cooler.on;
  if (s.telescope) { $('r-tel').value = s.telescope.name || ''; $('r-focal').value = s.telescope.focalLength ?? ''; $('r-angle').value = s.telescope.angle ?? 0; }
  $('r-observer').value = s.observer || '';
}
const num = (id, d = NaN) => { const v = $(id).value; return v === '' || !Number.isFinite(+v) ? d : +v; };
function readForm(quiet = false) {
  try {
    const base = R.seq || {};
    const s = makeSequence({
      ...base, id: base.id, name: base.name && base.target?.name === $('r-tname').value ? base.name : undefined,
      target: { name: $('r-tname').value || 'target', ra: num('r-ra'), dec: num('r-dec'), mag: base.target?.mag ?? null },
      site: { ...(base.site || {}), lat: num('r-lat'), lon: num('r-lon'), elev: num('r-elev', 0) },
      window: { start: fromInput($('r-start').value), end: fromInput($('r-end').value) },
      exposure: { ...(base.exposure || {}), duration: num('r-exp', 60), filter: $('r-filter').value.trim(), gain: num('r-gain', null), offset: num('r-offset', null), bin: +$('r-bin').value },
      cooler: { ...(base.cooler || {}), on: $('r-cooler').checked, setTemp: num('r-settemp', -10) },
      calibration: { ...(base.calibration || {}), bias: num('r-nbias', 0), darks: num('r-ndark', 0), flats: num('r-nflat', 0), when: $('r-calwhen').value },
      limits: { ...(base.limits || {}), minAlt: num('r-minalt', 25), meridian: $('r-meridian').value },
      telescope: { name: $('r-tel').value.trim(), focalLength: num('r-focal', NaN), angle: num('r-angle', 0) },
      observer: $('r-observer').value.trim(),
    });
    const sm = sequenceSummary(s), now = nowMs(), env = envAt(s, s.window.start), past = s.window.end < now && !R.rehearse;
    $('r-summary').textContent = `${sm.hours.toFixed(2)} h window: about ${sm.lights} light frames of ${s.exposure.duration} s, ${s.calibration.bias} bias, ${s.calibration.darks} darks, ${s.calibration.flats} flats (${sm.calibrationMinutes.toFixed(0)} min). At the start the target is at ${env.alt.toFixed(0)}° and the Sun at ${env.sun.toFixed(0)}°.` +
      (s.calibration.flats ? '' : ' No flats: stars drifting across the vignetting change brightness against each other; take flats (a panel or the twilight sky) or detrend against the centroid in Analyze.') +
      (past ? ` This window ended ${new Date(s.window.end).toISOString().slice(0, 10)}: Start would end at once (choose a later night in Plan, or rehearse it).` : '');
    $('r-summary').className = past ? 'hint warn' : 'hint';
    return s;
  } catch (err) { if (!quiet) { $('r-summary').textContent = err.message; $('r-summary').className = 'hint err'; } return null; }
}
$('r-form').addEventListener('change', (e) => { if (R.running || ['r-camkind', 'r-url', 'r-save', 'r-seqfile'].includes(e.target.id)) return; R.seq = readForm() || R.seq; ready(); });
$('r-simnow').addEventListener('click', () => {
  const now = clock.now(), s0 = R.seq || {};
  R.rehearse = null;
  const lat = num('r-lat', 31.9583), lon = num('r-lon', -111.5967);
  // a target at the meridian now, so that it is up: RA = local sidereal time
  const lst = envAt({ site: { lat, lon }, target: { ra: 0, dec: 0 } }, now).ha;
  const ra = Number.isFinite(num('r-ra')) && s0.target ? num('r-ra') : ((lst * 15) % 360 + 360) % 360;
  R.seq = makeSequence({ ...s0, target: { name: $('r-tname').value || 'Simulated target', ra, dec: Number.isFinite(num('r-dec')) && s0.target ? num('r-dec') : lat - 5 }, site: { lat, lon, elev: num('r-elev', 0), name: s0.site?.name || 'Simulated site' },
    window: { start: now + 5000, end: now + (FAST ? 2 : 30) * 60e3 }, exposure: { duration: FAST ? 2 : 10 }, calibration: { bias: 5, darks: 3, flats: 3, when: 'before' }, limits: { minAlt: 0, sunMax: 90, meridian: 'none' }, cooler: { on: true, setTemp: -10, waitMax: FAST ? 5 : 30 } });
  fillForm(R.seq); readForm(); ready(); log('a test window starting now (limits on altitude and the Sun off)');
});
$('r-planet').innerHTML = '<option value="seq">the loaded sequence, as planned</option>' + REHEARSAL_PLANETS.map((p, i) => `<option value="${i}">${p.name} (V ${p.vmag.toFixed(1)}, depth ${(100 * p.rprs * p.rprs).toFixed(1)}%, ${(24 * transitDuration(p)).toFixed(1)} h)</option>`).join('');
$('r-rehearse').addEventListener('click', () => {
  if ($('r-planet').value === 'seq') {                        // rehearse the sequence from Plan (or a file) at its own time
    const s = readForm(); if (!s) return;
    R.seq = s; R.rehearse = { speed: +$('r-speed').value }; $('r-camkind').value = 'sim'; camKind();
    $('r-seqfrom').textContent = `Rehearsal of ${s.name} at its planned time, ${R.rehearse.speed}× real time on a simulated clock${s.planet && Number.isFinite(s.planet.rprs) ? ', with the planet’s own transit' : ' (no planet parameters: a generic 1.2% transit)'}. Connect the simulated camera and press Start.`;
    log(`rehearsal of ${s.name}`); ready(); return;
  }
  const p = REHEARSAL_PLANETS[+$('r-planet').value], site = { lat: num('r-lat', 31.9583), lon: num('r-lon', -111.5967), elev: num('r-elev', 0), name: R.seq?.site?.name || 'Site' };
  const ev = nextObservableTransit(p, site, clock.now(), { nights: 90 });
  if (!ev) { $('r-summary').textContent = `No transit of ${p.name} can be seen whole from this site in the next 90 nights.`; $('r-summary').className = 'hint err'; return; }
  // exposure for the star's brightness: 60 s at V = 11.4, between 5 and 120 s
  const exp = Math.max(5, Math.min(120, Math.round(60 * 10 ** (0.4 * (p.vmag - 11.4)))));
  R.seq = fromPlanEvent(ev, site, { exposure: { duration: exp, filter: 'r' }, calibration: { bias: 9, darks: 5, flats: 5, when: 'before' }, cooler: { on: true, setTemp: -10, waitMax: 120 }, limits: { meridian: 'none' } });
  R.seq.planet = { ...R.seq.planet, rprs: p.rprs, ars: p.ars, inc: p.inc, ld: [0.40, 0.25] };
  R.seq.target.mag = p.vmag;
  R.rehearse = { speed: +$('r-speed').value };
  $('r-camkind').value = 'sim'; camKind();
  fillForm(R.seq); readForm();
  $('r-seqfrom').textContent = `Rehearsal: ${p.name}, mid-transit ${new Date(R.seq.event.mid).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${exp} s frames, run at ${R.rehearse.speed}× real time on a simulated clock. Connect the simulated camera and press Start.`;
  log(`rehearsal of the ${p.name} transit of ${new Date(R.seq.event.mid).toISOString().slice(0, 10)}`); ready();
});
$('r-prior').addEventListener('change', drawLc);
$('r-seqfile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const s = JSON.parse(await f.text()); const err = validateSequence(s); if (err.length) throw new Error(err.join('; ')); R.seq = s; R.rehearse = null; fillForm(s); readForm(); $('r-seqfrom').textContent = `From ${f.name}.`; ready(); }
  catch (err) { $('r-summary').textContent = 'Not a sequence: ' + err.message; $('r-summary').className = 'hint err'; }
});
$('r-seqsave').addEventListener('click', () => { const s = readForm(); if (s) download(new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' }), `${s.id}.json`); });

// ------------------------------------------------------------------------------------------------ saving
$('r-save').addEventListener('change', () => {
  const v = $('r-save').value;
  $('r-pickdir').hidden = v !== 'folder';
  $('r-saveinfo').textContent = v === 'folder' ? (R.dir ? `Into ${R.dir.name}/<sequence>.` : ('showDirectoryPicker' in window ? 'Choose the folder.' : 'This browser cannot write to a folder (use Chrome or Edge, or the helper).')) :
    v === 'helper' ? 'The helper writes the frames into its --save-dir.' : v === 'zip' ? 'Kept in the page and downloaded as one zip at the end: for short test sequences only.' : 'Frames are reduced and dropped; only the light curve is kept.';
  ready();
});
$('r-pickdir').addEventListener('click', async () => { try { R.dir = await window.showDirectoryPicker({ mode: 'readwrite' }); $('r-save').dispatchEvent(new Event('change')); } catch { /* cancelled */ } });
async function saveFile(name, bytes) {
  const mode = $('r-save').value, folder = R.seq.id;
  if (mode === 'folder' && R.dir) {
    const sub = await R.dir.getDirectoryHandle(folder, { create: true }), fh = await sub.getFileHandle(name, { create: true }), w = await fh.createWritable();
    await w.write(bytes); await w.close();
  } else if (mode === 'helper') {
    const base = R.cam && R.cam.base ? R.cam.base : helperUrl();
    if (!base) throw new Error('no helper to save through');
    const r = await fetch(`${base}/esl/save?name=${encodeURIComponent(name)}&folder=${encodeURIComponent(folder)}`, { method: 'PUT', body: bytes });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  } else if (mode === 'zip') R.zip.push({ name: `${folder}/${name}`, data: bytes });
  else return false;
  R.saved.push(name); return true;
}
const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };

// ------------------------------------------------------------------------------------------------ the run
function ready() {
  const ok = !!R.cam && !!R.seq && !R.running && ($('r-save').value !== 'folder' || !!R.dir) && ($('r-save').value !== 'helper' || !!(R.props && R.props.helper));
  $('r-start-btn').disabled = !ok; $('r-pause').disabled = !R.running; $('r-stop').disabled = !R.running;
  $('r-analyze').disabled = !(R.reducer && R.reducer.used >= 5);
  counts();
}
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

$('r-start-btn').addEventListener('click', () => { document.querySelector('.r-main').classList.remove('idle'); run(); });
document.querySelector('.r-main').classList.add('idle');   // run.css: on a phone the empty views fold to their captions until a sequence starts
$('r-pause').addEventListener('click', () => {
  if (!R.st) return;
  if (R.st.paused) { R.st = resume(R.st); log('resumed'); $('r-pause').textContent = 'Pause'; }
  else { R.st = { ...R.st, paused: 'paused by the observer' }; log('paused by the observer'); $('r-pause').textContent = 'Resume'; R.abort?.abort(); }
});
$('r-stop').addEventListener('click', () => { if (!R.st) return; R.st = stop(R.st); R.abort?.abort(); R.cam?.abort(); log('stopped by the observer', 'warn'); });

async function run() {
  const seq = readForm(); if (!seq) return;
  R.seq = seq; R.st = startState(); R.running = true;
  // a rehearsal: the virtual clock starts early enough for the cooling and the calibration frames before the window
  const C = seq.calibration;
  VC = R.rehearse && R.cam.kind === 'sim' ? virtualClock(seq.window.start - 60e3 - 1000 * (seq.cooler.waitMax * 0 + 30 + (C.bias * 2 + C.darks * (seq.exposure.duration + 2) + C.flats * (C.flatDuration + 2))), R.rehearse.speed) : null;
  if (VC) log(`rehearsal clock: ${new Date(VC.now()).toISOString().slice(0, 19)} UTC, ${VC.speed}× real time`);
  if (R.cam.kind === 'sim') { R.cam = simFor(seq); R.props = await R.cam.connect(); }      // the simulated sky of this sequence
  R.cal = { bias: null, dark: null, flat: null }; R.masters = null; R.reducer = null; R.stars = null; R.live = []; R.frameNo = 0; R.saved = []; R.zip = [];
  ready(); log(`sequence ${seq.id} started`);
  try {
    await R.cam.configure({ gain: num('r-gain', null), offset: num('r-offset', null), bin: +$('r-bin').value, coolerOn: seq.cooler.on, setTemp: seq.cooler.setTemp });
    await saveFile(`${seq.id}.sequence.json`, new TextEncoder().encode(JSON.stringify(seq, null, 1)));
    for (;;) {
      const now = nowMs();
      if (R.cam.kind === 'sim' || !Number.isFinite(R.ccdTemp)) { try { const s = await R.cam.status(); R.ccdTemp = s.ccdTemp; } catch { /* keep */ } }
      const a = nextAction(seq, R.st, now, { ccdTemp: R.ccdTemp });
      if (a.type === 'done') { R.st = advance(R.st, a, now); log(a.reason); break; }
      if (a.type === 'pause') {
        if (R.st.log.at(-1)?.type !== 'pause') { R.st = advance(R.st, a, now); log(a.reason, 'warn'); status(a.reason, 'warn'); $('r-pause').textContent = 'Resume'; }
        R.st = { ...R.st, paused: R.st.paused || a.reason };
        VC?.pause();                                          // a rehearsal's clock waits for the observer too
        while (R.st.paused && !R.st.stopped) await sleep(500);
        VC?.resume();
        continue;
      }
      if (a.type === 'advance') { R.st = advance(R.st, a, now); log(a.reason, a.warn ? 'warn' : ''); counts(); continue; }
      if (a.type === 'cool' || a.type === 'wait') {
        if (R.st.log.at(-1)?.reason !== a.reason || a.type === 'cool') status(a.reason);
        if (R.st.log.at(-1)?.reason !== a.reason) log(a.reason);
        R.st = advance(R.st, a, now);
        R.abort = new AbortController(); await sleep(Math.max(100, Math.min(realMs(Math.max(500, a.until - now)), FAST ? 2000 : 30000)), R.abort.signal);
        continue;
      }
      // an exposure
      status(`${a.reason}: exposing ${a.duration} s`);
      R.abort = new AbortController();
      let res;
      try { res = await R.cam.expose({ duration: a.duration, kind: a.kind, signal: R.abort.signal }); }
      catch (err) { if (R.st.stopped || R.st.paused) continue; log(`${a.kind}: ${err.message}`, 'err'); R.st = advance(R.st, a, nowMs(), { error: err.message }); await sleep(3000); continue; }
      R.st = advance(R.st, a, nowMs(), {});
      await frameDone(a, res);
      counts(); ready();
    }
  } catch (err) { log(err.message, 'err'); status(err.message, 'err'); }
  R.running = false; ready();
  await finish();
  VC = null;
}

// one frame: header, file, calibration masters or the live reduction
async function frameDone(a, res) {
  const seq = R.seq, p = R.props, n = ++R.frameNo;
  const cards = frameHeader({
    exposure: { start: res.start, duration: a.duration, kind: a.kind, filter: seq.exposure.filter },
    clock: res.clock, site: seq.site, target: seq.target,
    camera: { name: p.name, width: res.width, height: res.height, gain: num('r-gain', NaN), offset: num('r-offset', NaN), egain: p.egain, binx: +$('r-bin').value, pixelSize: p.pixelSize, ccdTemp: res.ccdTemp, setTemp: seq.cooler.on ? seq.cooler.setTemp : NaN, bayer: p.bayer },
    telescope: seq.telescope || {}, sequence: { id: seq.id, name: seq.name, frame: n }, observer: seq.observer,
    software: `Exoplanet Science Lab ${VERSION} (Run page)`, written: nowMs(), history: n === 1 ? [`sequence ${seq.id} from ${location.host}`] : [],
  });
  const bitpix = (p.maxAdu || 65535) > 65535 || res.data instanceof Int32Array ? 32 : 16;
  const bytes = encodeFits(res.data, res.width, res.height, cards, { bitpix });
  const name = `${seq.id}_${String(n).padStart(4, '0')}_${a.kind}.fits`;
  try { await saveFile(name, bytes); } catch (err) { log(`could not save ${name}: ${err.message}`, 'err'); }
  drawFrame(res);
  if (a.kind !== 'light') { addCal(a.kind, res.data); return; }
  if (!R.masters) R.masters = makeMasters();
  const data = Float32Array.from(res.data); calibrate(data, R.masters);
  const f = parseFits(bytes).hdus[0];
  if (!R.reducer) {
    R.stars = chooseStars(data, res.width, res.height);
    if (!R.stars) { log('no target star found in the first light frame: is the telescope pointing at the field?', 'err'); return; }
    R.reducer = createReducer({ stars: R.stars, target: seq.target, site: seq.site, timeAt: 'start', psf: 'gaussian', optimal: true });
    log(`stars: the target at (${R.stars[0].x.toFixed(0)}, ${R.stars[0].y.toFixed(0)}) and ${R.stars.length - 1} comparison stars`);
  }
  try {
    const pt = R.reducer.add({ data, width: res.width, height: res.height, header: f.header, comments: f.comments, name });
    pt.t = res.start + a.duration * 500; pt.ccdTemp = res.ccdTemp; pt.clockUnc = res.clock && res.clock.unc; pt.comps = pt.live > 0 ? pt.target / pt.live : NaN; pt.truth = res.truth || null;
    R.live.push(pt); drawLc(); drawTelemetry();
    $('r-lccap').textContent = `${R.live.length} points · FWHM ${(2.3548 * pt.sigma).toFixed(1)} px · sky ${pt.sky.toFixed(0)} · airmass ${Number.isFinite(pt.airmass) ? pt.airmass.toFixed(3) : '–'}${pt.relocated ? ' · field re-found' : ''}`;
  } catch (err) { log(`reduction: ${err.message}`, 'err'); }
}

// masters: mean of the frames of each kind (a running sum, so long sequences of large frames fit in memory)
function addCal(kind, data) {
  const c = R.cal[kind] || (R.cal[kind] = { sum: new Float64Array(data.length), n: 0 });
  if (c.sum.length !== data.length) return;
  for (let i = 0; i < data.length; i++) c.sum[i] += data[i];
  c.n++;
}
function makeMasters() {
  const mean = (c) => (c && c.n ? Float32Array.from(c.sum, (v) => v / c.n) : null);
  const bias = mean(R.cal.bias), dark = mean(R.cal.dark), flatRaw = mean(R.cal.flat);
  if (dark && bias) for (let i = 0; i < dark.length; i++) dark[i] -= bias[i];
  let flat = null;
  if (flatRaw) { if (bias) for (let i = 0; i < flatRaw.length; i++) flatRaw[i] -= bias[i]; const m = medianOf(Array.from(flatRaw.filter((_, i) => i % 7 === 0))); flat = flatRaw.map((v) => v / m); }
  log(`masters: bias ${R.cal.bias?.n || 0}, darks ${R.cal.dark?.n || 0}, flats ${R.cal.flat?.n || 0} (means)`);
  return { bias, dark, flat };
}
function calibrate(d, M) {
  const n = d.length, ok = (a) => a && a.length === n;
  if (ok(M.bias)) for (let i = 0; i < n; i++) d[i] -= M.bias[i];
  if (ok(M.dark)) for (let i = 0; i < n; i++) d[i] -= M.dark[i];
  if (ok(M.flat)) for (let i = 0; i < n; i++) d[i] = M.flat[i] > 0.05 ? d[i] / M.flat[i] : NaN;
}

// the target and comparison stars: src/core/reduce.js chooseStars (isolated, unsaturated, room for the sky annulus)
function chooseStars(data, w, h) {
  const c = pickStars(data, w, h, { maxAdu: R.props.maxAdu || 65535 });
  if (!c) return null;
  for (const wn of c.warnings) log(wn, 'warn');
  return c.stars;
}

// ------------------------------------------------------------------------------------------------ drawing
function drawFrame(res) {
  const cv = $('r-framecv'), W = res.width, H = res.height, sc = Math.min(1, 480 / W);
  cv.width = Math.round(W * sc); cv.height = Math.round(H * sc);
  const ctx = cv.getContext('2d'), img = ctx.createImageData(cv.width, cv.height);
  const sample = []; for (let i = 0; i < res.data.length; i += Math.max(1, Math.floor(res.data.length / 5000))) sample.push(res.data[i]);
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.05)], hi = sample[Math.floor(sample.length * 0.995)] || lo + 1;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const v = res.data[Math.floor(y / sc) * W + Math.floor(x / sc)], g = Math.max(0, Math.min(255, 255 * Math.sqrt(Math.max(0, (v - lo) / (hi - lo)))));
    const k = 4 * (y * cv.width + x); img.data[k] = img.data[k + 1] = img.data[k + 2] = g; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (R.stars && R.live.length) {
    const pos = R.live.at(-1).pos;
    for (let s = 0; s < R.stars.length; s++) { ctx.strokeStyle = s ? '#5fd4ff' : '#ffb454'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pos[2 * s] * sc, pos[2 * s + 1] * sc, 8, 0, 7); ctx.stroke(); }
  }
  $('r-framecap').textContent = `Frame ${R.frameNo} · ${new Date(res.start).toISOString().slice(11, 23)} UTC start · ${res.clock && res.clock.unc != null ? `clock ±${res.clock.unc < 1 ? res.clock.unc.toFixed(2) : res.clock.unc.toFixed(0)} ms (${res.clock.label || res.clock.source})` : 'clock not checked'}`;
  R.lastFrame = { width: W, height: H, start: res.start };
}
/** The light curve so far: a pure function of the points and a theme (screen; the same call can draw to another canvas). */
export function renderLiveCurve(ctx, W, H, pts, theme = { bg: '#070a12', axis: '#55607a', text: '#8491ad', point: '#dfe6f3', prior: '#5fd4ff' }, prior = null) {
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H);
  const ok = pts.filter((p) => Number.isFinite(p.live) && Number.isFinite(p.t));
  if (ok.length < 2) { ctx.fillStyle = theme.text; ctx.font = '13px system-ui'; ctx.fillText('Waiting for light frames…', 16, 24); return; }
  // normalised by the points outside the predicted transit when there is a prediction, else by all
  const oot = prior ? ok.filter((p) => prior(p.t) > 0.99999) : [];
  const med = medianOf((oot.length >= 3 ? oot : ok).map((p) => p.live)), y = ok.map((p) => p.live / med), t = ok.map((p) => p.t);
  const s = [...y].sort((a, b) => a - b);
  let ylo = s[Math.floor(s.length * 0.01)], yhi = s[Math.ceil(s.length * 0.99) - 1];
  if (prior) { const pm = Math.min(...Array.from({ length: 101 }, (_, k) => prior(t[0] + (t.at(-1) - t[0]) * k / 100))); ylo = Math.min(ylo, pm); yhi = Math.max(yhi, 1); }
  const pad = Math.max(0.002, (yhi - ylo) * 0.15);
  const L = 58, Rm = 12, T = 12, B = 34, x0 = t[0], x1 = Math.max(t.at(-1), t[0] + 1000), y0 = ylo - pad, y1 = yhi + pad;
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - Rm), Y = (v) => T + (y1 - v) / (y1 - y0) * (H - T - B);
  ctx.strokeStyle = theme.axis; ctx.lineWidth = 1; ctx.strokeRect(L, T, W - L - Rm, H - T - B);
  ctx.fillStyle = theme.text; ctx.font = '11px system-ui';
  for (let k = 0; k <= 4; k++) { const v = y0 + (y1 - y0) * k / 4; ctx.fillText(v.toFixed(4), 4, Y(v) + 4); }
  const long = x1 - x0 > 20 * 60e3;
  for (let k = 0; k <= 4; k++) { const v = x0 + (x1 - x0) * k / 4; ctx.fillText(new Date(v).toISOString().slice(11, long ? 16 : 19), X(v) - (long ? 14 : 22), H - 14); }
  ctx.fillText('UTC, mid-exposure (the times kept are BJD_TDB)', W / 2 - 120, H - 2);
  if (prior) {                                                // the predicted transit (the prior): what the planet's parameters say
    ctx.strokeStyle = theme.prior; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath();
    for (let k = 0; k <= 300; k++) { const tt = x0 + (x1 - x0) * k / 300, v = prior(tt); k ? ctx.lineTo(X(tt), Y(v)) : ctx.moveTo(X(tt), Y(v)); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = theme.prior; ctx.fillText('- - predicted', W - Rm - 70, T + 14);
  }
  ctx.fillStyle = theme.point; for (let i = 0; i < y.length; i++) ctx.fillRect(X(t[i]) - 1.5, Y(y[i]) - 1.5, 3, 3);
  if (y.length >= 10) {                                       // a running median of 9 points
    ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 4; i < y.length - 4; i++) { const m = medianOf(y.slice(i - 4, i + 5)); i === 4 ? ctx.moveTo(X(t[i]), Y(m)) : ctx.lineTo(X(t[i]), Y(m)); }
    ctx.stroke();
  }
}
/**
 * Telemetry strips, one per quantity, sharing the time axis: a pure function of the live points and a theme.
 * x and y are the target's position relative to the first frame (the measured track; for the simulated camera the
 * true pointing offset is drawn too), FWHM from the Gaussian fit, sky per pixel, airmass, the comparison stars'
 * summed flux relative to its median (clouds, dew), the sensor temperature and the clock's uncertainty.
 */
export function renderTelemetry(ctx, W, H, pts, theme = { bg: '#070a12', axis: '#2a3348', text: '#8491ad', line: '#dfe6f3', truth: '#ffb454', bad: '#ff6b6b' }) {
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H);
  if (pts.length < 2) { ctx.fillStyle = theme.text; ctx.font = '13px system-ui'; ctx.fillText('Telemetry appears with the light frames.', 16, 24); return; }
  const p0 = pts[0], cm = medianOf(pts.map((p) => p.comps).filter(Number.isFinite));
  const tr0 = p0.truth;
  const rows = [
    { name: 'x (px)', minSpan: 1, v: (p) => p.x - p0.x, truth: tr0 ? (p) => (p.truth ? p.truth.dx - tr0.dx : NaN) : null },
    { name: 'y (px)', minSpan: 1, v: (p) => p.y - p0.y, truth: tr0 ? (p) => (p.truth ? p.truth.dy - tr0.dy : NaN) : null },
    { name: 'FWHM (px)', v: (p) => p.fwhm, truth: tr0 ? (p) => (p.truth ? 2.3548 * p.truth.sigma : NaN) : null },
    { name: 'sky (ADU)', v: (p) => p.sky },
    { name: 'airmass', v: (p) => p.airmass, minSpan: 0.01 },
    { name: 'comparisons', v: (p) => p.comps / cm },
    { name: 'sensor °C', v: (p) => p.ccdTemp, minSpan: 1 },
    { name: 'clock ± ms', v: (p) => p.clockUnc },
  ].filter((r) => pts.some((p) => Number.isFinite(r.v(p))));
  const L = 96, Rm = 70, T = 6, B = 22, h = (H - T - B) / rows.length, t0 = pts[0].t, t1 = Math.max(pts.at(-1).t, t0 + 1);
  const X = (t) => L + (t - t0) / (t1 - t0) * (W - L - Rm);
  ctx.font = '11px system-ui';
  rows.forEach((r, k) => {
    const top = T + k * h, vals = pts.map(r.v), tv = r.truth ? pts.map(r.truth) : [];
    const all = vals.concat(tv).filter(Number.isFinite); if (!all.length) return;
    let lo = Math.min(...all), hi = Math.max(...all);
    const minSpan = Math.max(1e-6, 0.002 * Math.abs(0.5 * (lo + hi)), r.minSpan || 0);                // a flat series stays flat, not magnified noise
    if (hi - lo < minSpan) { const c = 0.5 * (lo + hi); lo = c - minSpan / 2; hi = c + minSpan / 2; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const Y = (v) => top + 3 + (hi - v) / (hi - lo) * (h - 6);
    ctx.strokeStyle = theme.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, top + h - 0.5); ctx.lineTo(W - Rm, top + h - 0.5); ctx.stroke();
    ctx.fillStyle = theme.text; ctx.fillText(r.name, 6, top + h / 2 + 4);
    ctx.fillText(hi.toPrecision(3), L - 40, top + 11); ctx.fillText(lo.toPrecision(3), L - 40, top + h - 3);
    const line = (vs, colour, w) => { ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.beginPath(); let on = false; vs.forEach((v, i) => { if (!Number.isFinite(v)) { on = false; return; } const x = X(pts[i].t), y = Y(v); on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true; }); ctx.stroke(); };
    line(vals, theme.line, 1.3);
    if (tv.length) { ctx.setLineDash([4, 3]); line(tv, theme.truth, 1.2); ctx.setLineDash([]); }       // on top: where it agrees, the measured line shows through the gaps
    pts.forEach((p, i) => { if (p.relocated && k < 2) { ctx.fillStyle = theme.bad; ctx.fillRect(X(p.t) - 1.5, top + 2, 3, h - 4); } });
    const last = vals.filter(Number.isFinite).at(-1); ctx.fillStyle = theme.line; if (Number.isFinite(last)) ctx.fillText(last.toPrecision(4), W - Rm + 6, top + h / 2 + 4);
  });
  ctx.fillStyle = theme.text;
  for (let k = 0; k <= 4; k++) { const t = t0 + (t1 - t0) * k / 4; ctx.fillText(new Date(t).toISOString().slice(11, 19), X(t) - 22, H - 6); }
  if (tr0) { ctx.fillStyle = theme.truth; ctx.fillText('— simulated truth', W - Rm - 110, H - 6); }
}
function drawTelemetry() {
  const cv = $('r-telcv'); renderTelemetry(cv.getContext('2d'), cv.width, cv.height, R.live);
  const p = R.live, p0 = p[0];
  if (p0 && p0.truth && p.length > 2) {
    const d = p.filter((q) => q.truth).map((q) => Math.hypot(q.x - p0.x - (q.truth.dx - p0.truth.dx), q.y - p0.y - (q.truth.dy - p0.truth.dy))).sort((a, b) => a - b);
    $('r-telcap').textContent = `Telemetry per light frame (white: measured; orange dashes: the simulation's truth). The measured track follows the simulated pointing to ${d[d.length >> 1].toFixed(2)} px (median), ${d.at(-1).toFixed(2)} px at worst; red marks: the field was re-found after a jump (${p.filter((q) => q.relocated).length}).`;
  }
}
/** The predicted relative flux at a UTC time (ms), from the sequence's planet, or null when its parameters are incomplete. */
function priorCurve() {
  const pl = R.seq && R.seq.planet;
  if (!$('r-prior').checked || !pl || ![pl.rprs, pl.ars, pl.inc, pl.per, pl.tmid].every(Number.isFinite)) return null;
  return fluxAtUtc({ ...pl, ra: R.seq.target.ra, dec: R.seq.target.dec });
}
function drawLc() { const cv = $('r-lccv'); renderLiveCurve(cv.getContext('2d'), cv.width, cv.height, R.live, undefined, priorCurve()); }

// ------------------------------------------------------------------------------------------------ the end: best light curve, files, Analyze
function bestCurve() {
  const res = R.reducer.result(), M = res.M;
  const opt = optimise(M, { fit: { gain: R.props.egain || 1 }, psf: true, weighted: true, fitter: null });
  const lc = opt.lc, row = opt.tried[opt.best];
  const keep = []; for (let i = 0; i < lc.time.length; i++) if ((!lc.keep || lc.keep[i]) && Number.isFinite(lc.norm[i]) && Number.isFinite(lc.time[i])) keep.push(i);
  const am = M.airmass, f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
  const text = ['BJD_TDB,flux,flux_err,airmass,xc,yc,sky,fwhm'].concat(keep.map((i) => `${lc.time[i].toFixed(7)},${lc.norm[i].toFixed(7)},${(Number.isFinite(lc.normErr?.[i]) ? lc.normErr[i] : lc.err[i]).toFixed(7)},${f(am[i], 5)},${f(lc.x?.[i], 3)},${f(lc.y?.[i], 3)},${f(lc.background?.[i], 3)},${f(lc.fwhm?.[i], 3)}`)).join('\n') + '\n';
  return { res, opt, lc, row, keep, text };
}
async function finish() {
  if (!R.reducer || R.reducer.used < 5) { status(R.st?.stopped ? `Done: ${R.st.stopped}.` : 'Done.'); return; }
  try {
    const b = bestCurve(), seq = R.seq;
    const record = { software: 'Exoplanet Science Lab (Run page)', version: VERSION, created: new Date(clock.now()).toISOString(), rehearsal: VC ? { speed: VC.speed, note: 'simulated camera on a virtual clock' } : null, sequence: seq, state: { counts: R.st.counts, stopped: R.st.stopped }, clock: clock.info(), stars: R.stars,
      selected: { method: b.row.method, aperture: b.row.aperture, annulus: b.row.annulus, comparison: b.row.comp, scatter: b.row.scatter, points: b.keep.length },
      frames: b.res.frames, log: R.log };
    await saveFile(`${seq.id}_lightcurve.csv`, new TextEncoder().encode(b.text));
    await saveFile(`${seq.id}_reduction.json`, new TextEncoder().encode(JSON.stringify(record, null, 1)));
    if ($('r-save').value === 'zip' && R.zip.length) download(makeZip(R.zip), `${seq.id}.zip`);
    R.final = { ...b, record };
    status(`Done: ${R.st.stopped || 'complete'}. Best: ${b.row.method}, aperture ${b.row.aperture?.toFixed?.(1) ?? '–'} px, scatter ${(1e3 * b.row.scatter).toFixed(2)} ppt over ${b.keep.length} points.`);
    log(`light curve: ${b.keep.length} points, scatter ${(1e3 * b.row.scatter).toFixed(2)} ppt`);
  } catch (err) { log(`final reduction: ${err.message}`, 'err'); }
  ready();
}
$('r-analyze').addEventListener('click', () => {
  if (!R.reducer || R.reducer.used < 5) return;
  const b = R.final && !R.running ? R.final : bestCurve(), seq = R.seq, ex = seq.exposure.duration;
  const hand = { kind: 'lightcurve', name: `${seq.target.name} ${new Date(seq.window.start).toISOString().slice(0, 10)}`, text: b.text, source: 'run', version: VERSION, exptime: ex, exptimeDays: ex / 86400,
    target: seq.target.name, ra: seq.target.ra, dec: seq.target.dec, timeSystem: 'BJD_TDB', filter: seq.exposure.filter || null, planet: seq.planet || null,
    // the columns Analyze can detrend against, as from the Photometry page: centroid, sky, FWHM, airmass (2026-11-19:
    // without FWHM in the baseline a simulated WASP-121 b transit came out 5-25 % shallow, the seeing following the airmass)
    time: b.keep.map((i) => b.lc.time[i]), columns: Object.fromEntries([['xc', b.lc.x], ['yc', b.lc.y], ['sky', b.lc.background], ['fwhm', b.lc.fwhm], ['airmass', b.lc.airmass]]
      .filter(([, a]) => a && b.keep.some((i) => Number.isFinite(a[i]))).map(([k, a]) => [k, b.keep.map((i) => (Number.isFinite(a[i]) ? +a[i].toPrecision(9) : null))])),
    detrend: null, comparison: null };
  try { localStorage.setItem('esl.handoff', JSON.stringify(hand)); } catch { status('Could not hand the light curve over (storage full): save the CSV and open it in Analyze.', 'err'); return; }
  location.href = new URL('analyze/?handoff=1', siteRoot()).href;
});

// ------------------------------------------------------------------------------------------------ start
clock.start(); mountClockBadge($('r-clock'));
if (q.get('from') === 'plan') {
  try { const s = JSON.parse(localStorage.getItem('esl.sequence.handoff')); if (s && !validateSequence(s).length) { R.seq = s; fillForm(s); $('r-seqfrom').textContent = `From Plan: ${s.name}.`; log(`sequence from Plan: ${s.name}`); } } catch { /* fill it in by hand */ }
}
if (!R.seq) { const now = clock.now(); $('r-start').value = toLocalInput(now + 600e3); $('r-end').value = toLocalInput(now + 4 * 3600e3); $('r-lat').value = 31.9583; $('r-lon').value = -111.5967; $('r-elev').value = 2096; }
else readForm();
if (q.get('camera')) $('r-camkind').value = q.get('camera');
$('r-planet').value = R.seq ? 'seq' : '0';
camKind(); $('r-save').dispatchEvent(new Event('change')); drawLc(); drawTelemetry(); ready();
