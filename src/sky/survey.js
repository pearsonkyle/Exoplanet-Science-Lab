// The survey image of a target's field, over the Observe page: a real image of the sky from an open survey (HiPS
// tiles read from CORS mirrors and resampled here onto a TAN plane about the target, or CDS hips2fits), with the Gaia
// DR3 stars of the field (magnitude, colour, distance and ΔG from the target, the possible comparison stars), a
// measuring tool, a scale bar, a detector outline and neighbouring fields. Imported by main.js on first use.
// The geometry is src/core/skyfield.js and src/core/healpix.js (tested in test/skyfield.test.mjs).
import * as G from '../core/skyfield.js';
import { hipsTileUrl } from '../core/healpix.js';
import { gaiaConeUrl, parseGaia, atEpoch } from '../core/platesolve.js';
import { parseASU, VIZIER_MIRRORS } from '../core/rvsources.js';
import { reportDown, reportUp } from '../site/net.js';

const IRSA = 'https://irsa.ipac.caltech.edu/data/hips/CDS', ESAC = 'https://skies.esac.esa.int', CDS = 'https://alasky.cds.unistra.fr', CDS2 = 'https://alaskybis.cds.unistra.fr';
/** The surveys offered: HiPS id (for hips2fits), deepest tile order, tile mirrors (all send CORS headers), credit. */
export const SURVEYS = [
  { key: 'dss', id: 'CDS/P/DSS2/color', label: 'DSS2 colour (optical, whole sky)', order: 9, mirrors: [`${IRSA}/DSS2/color`, `${ESAC}/DSSColor`, `${CDS}/DSS/DSSColor`, `${CDS2}/DSS/DSSColor`], credit: 'DSS2: Digitized Sky Survey, STScI/NASA (colour by CDS)' },
  { key: 'dssred', id: 'CDS/P/DSS2/red', label: 'DSS2 red (whole sky)', order: 9, mirrors: [`${IRSA}/DSS2/red`, `${CDS}/DSS/DSS2Merged`, `${CDS2}/DSS/DSS2Merged`], credit: 'DSS2: Digitized Sky Survey, STScI/NASA' },
  { key: '2mass', id: 'CDS/P/2MASS/color', label: '2MASS colour (J, H, Ks; whole sky)', order: 9, mirrors: [`${IRSA}/2MASS/Color`, `${ESAC}/2MASSColor`, `${CDS}/2MASS/Color`, `${CDS2}/2MASS/Color`], credit: '2MASS: University of Massachusetts and IPAC/Caltech, NASA/NSF' },
  { key: 'ps1', id: 'CDS/P/PanSTARRS/DR1/color-z-zg-g', label: 'Pan-STARRS DR1 colour (north of −30°)', order: 11, mirrors: [`${CDS}/Pan-STARRS/DR1/color-z-zg-g`, `${CDS2}/Pan-STARRS/DR1/color-z-zg-g`], credit: 'Pan-STARRS1 Surveys: the PS1 Science Consortium' },
  { key: 'sdss', id: 'CDS/P/SDSS9/color', label: 'SDSS DR9 colour (a third of the sky)', order: 10, mirrors: [`${IRSA}/SDSS/DR9/color`, `${ESAC}/SDSS9Color`, `${CDS}/SDSS/DR9/color`], credit: 'SDSS: the Sloan Digital Sky Survey (SDSS-III)' },
  { key: 'legacy', id: 'CDS/P/DESI-Legacy-Surveys/DR10/color', label: 'DESI Legacy Surveys DR10 (two thirds of the sky)', order: 11, ext: 'png', mirrors: [`${CDS}/DESI-legacy-surveys/DR10/CDS_P_DESI-Legacy-Surveys_DR10_color`, `${CDS2}/DESI-legacy-surveys/DR10/CDS_P_DESI-Legacy-Surveys_DR10_color`], credit: 'DESI Legacy Imaging Surveys (LBNL, NOIRLab)' },
  { key: 'wise', id: 'CDS/P/allWISE/color', label: 'AllWISE colour (infrared, whole sky)', order: 8, mirrors: [`${IRSA}/AllWISE/RGB-W4-W2-W1`, `${ESAC}/AllWISEColor`, `${CDS}/AllWISE/RGB-W4-W2-W1`], credit: 'AllWISE: NASA/JPL-Caltech/UCLA, IPAC' },
];
const HIPS2FITS = [`${CDS}/hips-image-services/hips2fits`, `${CDS2}/hips-image-services/hips2fits`];
export const SIZES = [5, 10, 15, 30, 60];      // arcmin, the width of one image
const N = 512, MAX_CELLS = 4;                   // pixels of one image; at most 4 images along each axis
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : { ...d, ...JSON.parse(v) }; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtG = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—'), sgn = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d) : '—');

// ---------------------------------------------------------------- fetching
const timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
/** An image with CORS (so that its pixels can be read), or null when the server has no such tile (outside a survey's footprint). */
function loadImage(url, ms = 20000) {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    const t = setTimeout(() => { img.src = ''; reject(new Error('timed out')); }, ms);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}
const tileCache = new Map();      // url -> Promise<Uint8ClampedArray | null>
function tilePixels(url, W) {
  if (!tileCache.has(url)) {
    if (tileCache.size > 160) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(url, loadImage(url).then((img) => {
      if (!img) return null;
      const c = document.createElement('canvas'); c.width = c.height = W; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, W, W);
      return x.getImageData(0, 0, W, W).data;
    }).catch((e) => { tileCache.delete(url); throw e; }));
  }
  return tileCache.get(url);
}
/** Cell (i, j) resampled from the survey's HiPS tiles: { canvas, source, empty }. Tries the mirrors in turn. */
async function cellFromTiles(sv, plane, i, j) {
  const map = G.hipsCellMap(plane, i, j, N, { tileWidth: 512, maxOrder: sv.order }), ext = sv.ext || 'jpg';
  let last = null;
  for (const base of sv.mirrors) {
    try {
      const px = await Promise.all(map.tiles.map((t) => tilePixels(hipsTileUrl(base, map.order, t, ext), 512)));
      if (px.every((p) => !p)) { last = new Error(`no tiles at ${new URL(base).host}`); continue; }
      const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), out = x.createImageData(N, N), o = out.data;
      for (let k = 0; k < N * N; k++) { const t = map.which[k], p = t >= 0 ? px[t] : null; if (!p) continue; const a = map.off[k] * 4; o[4 * k] = p[a]; o[4 * k + 1] = p[a + 1]; o[4 * k + 2] = p[a + 2]; o[4 * k + 3] = 255; }
      x.putImageData(out, 0, 0);
      return { canvas: c, source: `HiPS tiles (order ${map.order}) from ${new URL(base).host}`, host: new URL(base).host, empty: px.some((p) => !p) };
    } catch (e) { last = e; }
  }
  throw last || new Error('no mirror answered');
}
let h2fDown = false;      // hips2fits did not answer this session: do not wait for it again
async function cellFromHips2fits(sv, plane, i, j) {
  if (h2fDown) throw new Error('hips2fits is not answering');
  for (const base of HIPS2FITS) {
    try { const img = await loadImage(G.hips2fitsUrl(base, sv.id, G.cellWcs(plane, i, j, N), sv.ext === 'png' ? 'png' : 'jpg'), 15000); if (img) { const c = document.createElement('canvas'); c.width = c.height = N; c.getContext('2d').drawImage(img, 0, 0, N, N); return { canvas: c, source: 'CDS hips2fits', host: new URL(base).host }; } } catch { /* the next one */ }
  }
  h2fDown = true; throw new Error('hips2fits is not answering');
}
async function fetchText(url) { const r = await fetch(url, { signal: timeout(30000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }
async function gaiaCone(ra, dec, radius) {
  let last;
  for (const base of VIZIER_MIRRORS) { try { const r = parseGaia(await fetchText(gaiaConeUrl(base, ra, dec, radius, { gmax: 19, max: 3000 })), parseASU); reportUp('VizieR (Gaia DR3)'); return r; } catch (e) { last = e; } }
  reportDown('VizieR (Gaia DR3)', last);
  throw last;
}

// ---------------------------------------------------------------- the panel
/**
 * Open the survey image for a target. host: the element to cover (the sky); target { name, ra, dec (deg, ICRS),
 * mag (V or null) }; year: the epoch for Gaia's proper motions. Returns the controller (also kept as `current`).
 */
let current = null;
export function openSurvey(host, target, { year = 2026, onClose } = {}) {
  if (current) current.close();
  const P = store.get('esl.sky.survey', { survey: 'dss', size: 15, dgMin: -1, dgMax: 1, all: false, outline: false, ow: 15, oh: 15, orot: 0, cs: 0.6, cnx: 2048, cny: 2048 });
  const V = { target, year, plane: null, cells: new Map(), gaia: [], gaiaKeys: new Set(), gaiaState: 'idle', gaiaErr: '', gaiaPending: 0, tgt: null, nb: [], hover: null, meas: null, view: null };
  const el = document.createElement('section'); el.className = 'survey'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Survey image of ' + target.name);
  el.innerHTML = `<header class="sv-head"><div><div class="type">Survey image</div><h2>${esc(target.name)}</h2><div class="sub" id="svSub"></div></div><button class="sv-x" data-sv="close" aria-label="Close the survey image" title="Close (Esc)">×</button></header>
    <details class="sv-set"${matchMedia('(max-width: 760px)').matches ? '' : ' open'}><summary>Survey, comparison stars, detector</summary><div class="sv-controls">
      <label>Survey <select data-sv="survey">${SURVEYS.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select></label>
      <label>Image width <select data-sv="size">${SIZES.map((a) => `<option value="${a}">${a}′</option>`).join('')}</select></label>
      <label title="Gaia stars whose G is within this range of the target's are marked as possible comparison stars (not flagged variable, more than 10″ away)">Comparison ΔG <span class="sv-pair"><input type="number" data-sv="dgMin" step="0.5" min="-10" max="0" aria-label="Brightest, magnitudes relative to the target"> to <input type="number" data-sv="dgMax" step="0.5" min="0" max="10" aria-label="Faintest, magnitudes relative to the target"></span></label>
      <label class="sv-chk"><input type="checkbox" data-sv="all"> All Gaia stars</label>
      <details class="sv-det"><summary><label class="sv-chk"><input type="checkbox" data-sv="outline"> Detector outline</label></summary>
        <div class="sv-grid"><label>Width ′<input type="number" data-sv="ow" step="0.5" min="0.5" max="240"></label><label>Height ′<input type="number" data-sv="oh" step="0.5" min="0.5" max="240"></label><label>Angle °<input type="number" data-sv="orot" step="5" min="-180" max="360" title="Turned from north toward east"></label></div>
        <div class="sv-grid"><label>Pixel scale ″<input type="number" data-sv="cs" step="0.01" min="0.01" max="60"></label><label>Pixels x<input type="number" data-sv="cnx" step="1" min="1" max="20000"></label><label>Pixels y<input type="number" data-sv="cny" step="1" min="1" max="20000"></label></div>
        <button class="sv-btn" data-sv="camera">Outline from the camera</button></details>
    </div></details>
    <div class="sv-stage"><canvas class="sv-canvas" aria-label="Survey image with the Gaia stars of the field. Hover or tap a star for its values; drag to measure."></canvas>
      <button class="sv-arrow n" data-dir="n" title="Load the field to the north" aria-label="Load the field to the north">N</button><button class="sv-arrow s" data-dir="s" title="Load the field to the south" aria-label="Load the field to the south">S</button>
      <button class="sv-arrow e" data-dir="e" title="Load the field to the east" aria-label="Load the field to the east">E</button><button class="sv-arrow w" data-dir="w" title="Load the field to the west" aria-label="Load the field to the west">W</button>
      <div class="sv-zoom"><button data-sv="zin" aria-label="Zoom in">+</button><button data-sv="zout" aria-label="Zoom out">−</button><button data-sv="fit" aria-label="Fit the field" title="Fit the field">⤢</button></div>
      <div class="sv-tip" hidden></div></div>
    <div class="sv-info"><p class="sv-meas" id="svMeas">Drag between two points to measure. Hover or tap a star for its values.</p><div id="svSummary"></div></div>
    <p class="sv-credit" id="svCredit"></p>`;
  host.appendChild(el);
  const q = (k) => el.querySelector(`[data-sv="${k}"]`), cv = el.querySelector('.sv-canvas'), ctx = cv.getContext('2d'), tip = el.querySelector('.sv-tip'), stage = el.querySelector('.sv-stage');
  for (const k of ['survey', 'size', 'dgMin', 'dgMax', 'ow', 'oh', 'orot', 'cs', 'cnx', 'cny']) q(k).value = P[k];
  q('all').checked = !!P.all; q('outline').checked = !!P.outline;
  const survey = () => SURVEYS.find((s) => s.key === P.survey) || SURVEYS[0];
  const save = () => store.set('esl.sky.survey', P);
  const css = (name, d) => getComputedStyle(el).getPropertyValue(name).trim() || d;

  // ---- the field: a plane about the target, cells on it
  function reset() {
    V.plane = G.makePlane(target.ra, target.dec, P.size * 60 / N); V.cells = new Map(); V.meas = null; V.view = null; V.hover = null;
    V.gaiaPending = 0; V.gaiaErr = '';   // requests for the old plane are ignored when they return
    addCell(0, 0); loadGaia(0, 0); summary(); draw();
  }
  function addCell(i, j) {
    const key = `${i},${j}`; if (V.cells.has(key)) return;
    const cell = { i, j, state: 'loading', canvas: null, source: '', err: '' }, sv = survey(), plane = V.plane; V.cells.set(key, cell);
    (async () => {
      try { Object.assign(cell, await cellFromTiles(sv, plane, i, j)); }
      catch (e1) { try { Object.assign(cell, await cellFromHips2fits(sv, plane, i, j)); } catch { reportDown('Sky survey images (CDS HiPS)', e1); throw e1; } }
    })().then(() => { cell.state = 'ok'; reportUp('Sky survey images (CDS HiPS)'); }).catch((e) => { cell.state = 'error'; cell.err = String(e.message || e); })
      .finally(() => { if (V.plane === plane) { credit(); draw(); } });
  }
  function loadGaia(i, j) {
    const plane = V.plane, [ra, dec] = G.cellCentreSky(plane, i, j, N), radius = P.size / Math.SQRT2 + 0.2; V.gaiaPending++; V.gaiaState = 'loading'; credit();
    gaiaCone(ra, dec, radius).then((stars) => {
      if (V.plane !== plane) return;
      for (const s of atEpoch(stars, year)) if (!V.gaiaKeys.has(s.source)) { V.gaiaKeys.add(s.source); V.gaia.push(s); }
      V.gaia.sort((a, b) => (Number.isFinite(a.g) ? a.g : 99) - (Number.isFinite(b.g) ? b.g : 99));
      if (!V.tgt && !target.field) V.tgt = G.findTarget(V.gaia, target.ra, target.dec, { radius: 8, mag: target.mag });
      classify();
    }).catch((e) => { if (V.plane === plane) V.gaiaErr = String(e.message || e); })
      // several cones load at once after the field is extended: the state settles when the last one is back, and one
      // failure among them does not hide the stars the others brought
      .finally(() => { if (V.plane !== plane) return; V.gaiaPending = Math.max(0, V.gaiaPending - 1); if (!V.gaiaPending) V.gaiaState = V.gaia.length || !V.gaiaErr ? 'ok' : 'error'; credit(); summary(); draw(); });
  }
  const outline = () => (P.outline ? G.outlineCorners(V.plane, +P.ow, +P.oh, +P.orot) : null);
  function classify() {
    const t = V.tgt || { ra: target.ra, dec: target.dec, g: NaN };
    V.nb = G.neighbours(V.gaia, V.tgt ? V.tgt : null, { dgMin: +P.dgMin, dgMax: +P.dgMax, plane: V.plane, outline: outline() });
    if (!V.tgt) V.nb = V.nb.map((s) => ({ ...s, sep: G.separation(t.ra, t.dec, s.ra, s.dec), pa: G.positionAngle(t.ra, t.dec, s.ra, s.dec) }));
    // plane pixels of every star, once; only the stars on a loaded image count (the cones are circles about the images)
    for (const s of V.nb) { const [u, v] = V.plane.toPlane(s.ra, s.dec); s.u = u; s.v = v; s.inField = s.isTarget || V.cells.has(`${Math.round(-u / N)},${Math.round(-v / N)}`); if (!s.inField) s.comp = false; }
    V.nb = V.nb.filter((s) => s.inField);
  }
  const extent = () => { let i0 = 0, i1 = 0, j0 = 0, j1 = 0; for (const c of V.cells.values()) { i0 = Math.min(i0, c.i); i1 = Math.max(i1, c.i); j0 = Math.min(j0, c.j); j1 = Math.max(j1, c.j); } return { i0, i1, j0, j1 }; };
  /** Load the next row or column of images on one side; past four, the far side is dropped (the field moves). */
  function extend(dir) {
    const x = extent(), add = [];
    if (dir === 'n' || dir === 's') { const j = dir === 'n' ? x.j1 + 1 : x.j0 - 1; for (let i = x.i0; i <= x.i1; i++) add.push([i, j]); if (x.j1 - x.j0 + 2 > MAX_CELLS) dropWhere((c) => c.j === (dir === 'n' ? x.j0 : x.j1)); }
    else { const i = dir === 'e' ? x.i1 + 1 : x.i0 - 1; for (let j = x.j0; j <= x.j1; j++) add.push([i, j]); if (x.i1 - x.i0 + 2 > MAX_CELLS) dropWhere((c) => c.i === (dir === 'e' ? x.i0 : x.i1)); }
    for (const [i, j] of add) addCell(i, j);
    // the stars of the new strip: one cone per new image
    for (const [i, j] of add) loadGaia(i, j);
    classify(); summary(); V.view = null; draw();
  }
  function dropWhere(f) { for (const [k, c] of V.cells) if (f(c)) V.cells.delete(k); }

  // ---- screen <-> plane
  function fit() {
    const x = extent(), W = cv.clientWidth, H = cv.clientHeight, w = (x.i1 - x.i0 + 1) * N, h = (x.j1 - x.j0 + 1) * N;
    const k = Math.min((W - 24) / w, (H - 24) / h), [cu, cv2] = [-(x.i0 + x.i1) / 2 * N, -(x.j0 + x.j1) / 2 * N];
    V.view = { k, ox: W / 2 - cu * k, oy: H / 2 - cv2 * k };
  }
  const toScreen = (u, v) => [V.view.ox + u * V.view.k, V.view.oy + v * V.view.k];
  const toPlane = (x, y) => [(x - V.view.ox) / V.view.k, (y - V.view.oy) / V.view.k];
  function zoomAt(f, x, y) { const [u, v] = toPlane(x, y); V.view.k = Math.max(0.05, Math.min(16, V.view.k * f)); V.view.ox = x - u * V.view.k; V.view.oy = y - v * V.view.k; draw(); }

  // ---- drawing
  let raf = 0;
  function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
  function paint() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    if (!V.view) fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const k = V.view.k, ok = css('--ok', '#6fe3a5'), warn = css('--warn', '#ffb454'), model = css('--model', '#5fd4ff'), txt = '#e6ecf7';
    ctx.imageSmoothingEnabled = k < 2; ctx.imageSmoothingQuality = 'high';
    for (const c of V.cells.values()) {
      const [cu, cvv] = G.cellCentre(c.i, c.j, N), [x, y] = toScreen(cu - N / 2, cvv - N / 2), s = N * k;
      if (c.canvas) ctx.drawImage(c.canvas, x, y, s, s);
      else { ctx.strokeStyle = '#ffffff44'; ctx.setLineDash([5, 5]); ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); ctx.setLineDash([]); ctx.fillStyle = '#c6cfe0'; ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(c.state === 'error' ? 'This image could not be loaded' : 'Loading the image…', x + s / 2, y + s / 2); if (c.state === 'error') { ctx.fillStyle = '#8491ad'; ctx.fillText(c.err.slice(0, 70), x + s / 2, y + s / 2 + 16); } }
    }
    const lw = (a) => { ctx.lineWidth = a; };
    // the detector outline
    const ol = outline();
    if (ol) {
      ctx.strokeStyle = model; lw(1.6); ctx.setLineDash([7, 4]); ctx.beginPath(); ol.forEach((p, n) => { const [x, y] = toScreen(p[0], p[1]); if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      const top = ol.reduce((a, b) => (toScreen(...b)[1] < toScreen(...a)[1] ? b : a)), [tx, ty] = toScreen(top[0], top[1]); label(`${(+P.ow).toFixed(1)}′ × ${(+P.oh).toFixed(1)}′${+P.orot ? ` · ${(+P.orot).toFixed(0)}°` : ''}`, tx, ty - 8, model, 'center');
    }
    // the Gaia stars: all of them faintly (optional), the comparison candidates in green, the target in amber
    const r0 = (s) => Math.max(3, Math.min(14, (17 - (Number.isFinite(s.g) ? s.g : 18)) * 1.2 * Math.sqrt(Math.max(0.6, Math.min(2.5, k)))));
    for (const s of V.nb) {
      if (s.isTarget || (!s.comp && !P.all)) continue;
      const [x, y] = toScreen(s.u, s.v); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      ctx.strokeStyle = s.comp ? ok : s.variable ? '#ff9aa5aa' : '#ffffff66'; lw(s.comp ? 1.8 : 1); ctx.beginPath(); ctx.arc(x, y, r0(s) + (s.comp ? 3 : 1.5), 0, 7); ctx.stroke();
      if (s.comp && k > 0.35) label(sgn(s.dG, 1), x + r0(s) + 6, y - r0(s) - 2, ok);
    }
    const tg = V.tgt ? toScreen(...V.plane.toPlane(V.tgt.ra, V.tgt.dec)) : toScreen(0, 0), rt = V.tgt ? r0(V.tgt) + 6 : 10;
    ctx.strokeStyle = '#000a'; lw(4.5); ring(tg, rt); ctx.strokeStyle = warn; lw(2); ring(tg, rt);
    label(target.name, tg[0] + rt + 8, tg[1] + rt + 10, warn);
    // hover
    if (V.hover) { const [x, y] = toScreen(V.hover.u, V.hover.v); ctx.strokeStyle = '#fff'; lw(2); ring([x, y], r0(V.hover) + 6); }
    // the measurement
    if (V.meas) {
      const [a, b] = [toScreen(...V.meas.p), toScreen(...V.meas.q)];
      for (const [col, w] of [['#000c', 4], [warn, 1.8]]) { ctx.strokeStyle = col; lw(w); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
      for (const p of [a, b]) { ctx.fillStyle = warn; ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 7); ctx.fill(); }
      const m = G.measure(V.plane, V.meas.p, V.meas.q); label(m.text, (a[0] + b[0]) / 2 + 10, (a[1] + b[1]) / 2 - 10, txt);
    }
    // the scale bar and the compass
    const sb = G.scaleBar(V.plane.scale / k, Math.min(180, W * 0.3)), bx = 16, by = H - 22;
    ctx.fillStyle = '#000a'; ctx.fillRect(bx - 8, by - 22, sb.px + 16, 34);
    ctx.strokeStyle = txt; lw(2); ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by + 5); ctx.moveTo(bx, by); ctx.lineTo(bx + sb.px, by); ctx.moveTo(bx + sb.px, by - 5); ctx.lineTo(bx + sb.px, by + 5); ctx.stroke();
    label(sb.label, bx + sb.px / 2, by - 11, txt, 'center');
    const cx = W - 46, cy = H - 46; ctx.strokeStyle = txt; lw(1.6); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 28); ctx.moveTo(cx, cy); ctx.lineTo(cx - 28, cy); ctx.stroke();
    label('N', cx, cy - 36, txt, 'center'); label('E', cx - 38, cy + 1, txt, 'center');
  }
  function ring(p, r) { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.stroke(); }
  function label(s, x, y, col, align = 'left') { ctx.font = '600 11.5px Inter, system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineWidth = 3.5; ctx.strokeStyle = '#000c'; ctx.strokeText(s, x, y); ctx.fillStyle = col; ctx.fillText(s, x, y); }

  // ---- the words
  function credit() {
    const sv = survey(), hosts = [...new Set([...V.cells.values()].map((c) => c.source).filter(Boolean))];
    const empty = [...V.cells.values()].some((c) => c.empty), failed = [...V.cells.values()].filter((c) => c.state === 'error');
    el.querySelector('#svCredit').innerHTML = `Image: ${esc(sv.credit)}; HiPS by CDS, Strasbourg${hosts.length ? ` (${esc(hosts.join('; '))})` : ''}. Stars: ESA/Gaia/DPAC, Gaia DR3 (Gaia Collaboration 2023), through VizieR (CDS).`
      + (empty ? ' <span class="sv-warn">Part of the field is outside this survey.</span>' : '') + (failed.length ? ` <span class="sv-warn">${failed.length} image${failed.length > 1 ? 's' : ''} could not be loaded: try another survey.</span>` : '')
      + (V.gaiaState === 'loading' ? ' <span>Fetching the Gaia stars…</span>' : V.gaiaState === 'error' ? ` <span class="sv-warn">Gaia stars could not be fetched (${esc(V.gaiaErr)}).</span>` : '');
  }
  function summary() {
    const t = V.tgt, sub = el.querySelector('#svSub');
    sub.textContent = target.field && !t ? 'The middle of the view (no target star): distances are from the centre' : t ? `Gaia DR3 ${t.source} · G ${fmtG(t.g)} · BP−RP ${fmtG(t.bprp)}${t.variable ? ' · variable in Gaia' : ''}` : V.gaiaState === 'ok' ? 'Not found in Gaia DR3 within 8″ of the catalogue position (too bright, or a moving object)' : '';
    if (V.gaiaState !== 'ok') { el.querySelector('#svSummary').innerHTML = ''; return; }
    const comps = V.nb.filter((s) => s.comp), lo = sgn(+P.dgMin, 1), hi = sgn(+P.dgMax, 1), inside = P.outline ? ' inside the detector outline' : ' in the loaded field';
    const row = (s) => `<tr data-src="${esc(s.source)}"><td>${fmtG(s.g)}</td><td>${sgn(s.dG)}</td><td>${fmtG(s.bprp)}</td><td>${G.angleText(s.sep)}</td><td>${s.pa.toFixed(0)}°</td></tr>`;
    el.querySelector('#svSummary').innerHTML = !t ? `<p class="sv-note">${V.nb.length} Gaia stars in the field; ΔG needs the target in Gaia.</p>` :
      `<details class="sv-comps"${comps.length ? ' open' : ''}><summary><b>${comps.length}</b> possible comparison star${comps.length === 1 ? '' : 's'}${inside} (ΔG ${lo} to ${hi}, not variable, beyond 10″) · ${V.nb.length} Gaia stars with G &lt; 19 on the image${V.cells.size > 1 ? 's' : ''}</summary>` +
      (comps.length ? `<table class="sv-table"><tr><th>G</th><th>ΔG</th><th>BP−RP</th><th>From target</th><th>PA</th></tr>${comps.slice(0, 30).map(row).join('')}</table>${comps.length > 30 ? `<p class="sv-note">and ${comps.length - 30} more.</p>` : ''}` : '<p class="sv-note">Widen the ΔG range, load neighbouring fields, or enlarge the image.</p>') + '</details>';
  }
  function showTip(s, x, y) {
    if (!s) { tip.hidden = true; return; }
    const what = s.isTarget ? 'the target' : s.comp ? 'possible comparison star' : s.variable ? 'variable in Gaia' : '';
    tip.innerHTML = `<b>Gaia DR3 ${esc(s.source)}</b>${what ? ` <span class="${s.comp ? 'ok' : s.isTarget ? 'tg' : 'var'}">${what}</span>` : ''}<br>G ${fmtG(s.g)} · BP−RP ${fmtG(s.bprp)}${!s.isTarget && Number.isFinite(s.dG) ? ` · ΔG ${sgn(s.dG)}` : ''}<br>${s.isTarget ? '' : `${G.angleText(s.sep)} from the target · PA ${s.pa.toFixed(1)}°`}`;
    tip.hidden = false; const W = stage.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(W - tw - 6, x + 14)) + 'px'; tip.style.top = Math.max(6, y - th - 12 < 6 ? y + 16 : y - th - 12) + 'px';
  }
  function nearest(x, y, tol) {
    let best = null, bd = tol;
    for (const s of V.nb) { if (!s.comp && !P.all && !s.isTarget) continue; const [sx, sy] = toScreen(s.u, s.v), d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  const measText = () => { const m = G.measure(V.plane, V.meas.p, V.meas.q); el.querySelector('#svMeas').innerHTML = `<b>${m.text}</b> <small>(separation, and position angle from the first point, east of north)</small>`; return m; };

  // ---- pointers: hover or tap a star, drag to measure, wheel or two fingers to zoom
  const pts = new Map(); let drag = null, pinch = null;
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const snap = (x, y) => { const s = nearest(x, y, 12); return s ? [s.u, s.v] : toPlane(x, y); };
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e); pts.set(e.pointerId, [x, y]); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: V.view.k }; drag = null; return; }
    drag = { x, y, p: snap(x, y), moved: false, type: e.pointerType };
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [x, y]);
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomAt((pinch.k * d / Math.max(20, pinch.d)) / V.view.k, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); return; }
    if (drag) {
      if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) > 6) drag.moved = true;
      if (drag.moved) { V.meas = { p: drag.p, q: snap(x, y) }; measText(); showTip(null); draw(); }
      return;
    }
    if (e.pointerType === 'mouse') { const s = nearest(x, y, 12); if (s !== V.hover) { V.hover = s; draw(); } showTip(s, x, y); }
  });
  const up = (e) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (drag && !drag.moved) { const s = nearest(drag.x, drag.y, drag.type === 'touch' ? 24 : 12); V.hover = s; showTip(s, drag.x, drag.y); if (!s && V.meas) { V.meas = null; el.querySelector('#svMeas').textContent = 'Drag between two points to measure. Hover or tap a star for its values.'; } draw(); }
    drag = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); drag = null; pinch = null; });
  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drag) { V.hover = null; showTip(null); draw(); } });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.002), x, y); }, { passive: false });

  // ---- controls
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.dir) return extend(b.dataset.dir);
    const k = b.dataset.sv, W = cv.clientWidth, H = cv.clientHeight;
    if (k === 'close') api.close();
    else if (k === 'zin') zoomAt(1.4, W / 2, H / 2); else if (k === 'zout') zoomAt(1 / 1.4, W / 2, H / 2); else if (k === 'fit') { V.view = null; draw(); }
    else if (k === 'camera') { const f = G.cameraField(+P.cs, +P.cnx, +P.cny); P.ow = +f.w.toFixed(2); P.oh = +f.h.toFixed(2); q('ow').value = P.ow; q('oh').value = P.oh; P.outline = true; q('outline').checked = true; save(); classify(); summary(); draw(); }
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.sv; if (!k) return;
    P[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.tagName === 'SELECT' && k !== 'survey' ? +e.target.value : e.target.type === 'number' ? +e.target.value : e.target.value;
    save();
    if (k === 'survey') { const keep = [...V.cells.values()].map((c) => [c.i, c.j]); V.cells = new Map(); for (const [i, j] of keep) addCell(i, j); credit(); draw(); }
    else if (k === 'size') { V.gaia = []; V.gaiaKeys = new Set(); V.tgt = null; V.nb = []; reset(); }
    else { classify(); summary(); draw(); }
  });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  const onKey = (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '') && e.key !== 'Escape') return;
    if (e.key === 'Escape') { api.close(); e.stopImmediatePropagation(); e.preventDefault(); return; }
    const m = { ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'e', ArrowRight: 'w' }[e.key];
    if (m) extend(m); else if (e.key === '+' || e.key === '=') zoomAt(1.4, cv.clientWidth / 2, cv.clientHeight / 2); else if (e.key === '-') zoomAt(1 / 1.4, cv.clientWidth / 2, cv.clientHeight / 2); else return;
    e.stopImmediatePropagation(); e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  const ro = new ResizeObserver(() => { V.view = null; draw(); }); ro.observe(cv);

  const api = {
    V, el,
    close() { window.removeEventListener('keydown', onKey, true); ro.disconnect(); el.remove(); if (current === api) current = null; if (onClose) onClose(); },
    extend, setSurvey(key) { const s = SURVEYS.find((x) => x.key === key || x.id === key); if (!s) throw new Error('unknown survey ' + key); q('survey').value = s.key; q('survey').dispatchEvent(new Event('change', { bubbles: true })); },
    set(k, v) { const inp = q(k); if (!inp) throw new Error('no setting ' + k);
      // only the listed widths: an unlisted one would leave a scale of 0
      if (k === 'size') v = SIZES.reduce((a, b) => (Math.abs(b - +v) < Math.abs(a - +v) ? b : a));
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v; inp.dispatchEvent(new Event('change', { bubbles: true })); },
    measure(p, q2) { V.meas = { p, q: q2 }; draw(); return measText(); },
    toScreen: (u, v) => toScreen(u, v), draw: paint,
    /** Resolves when the images and the Gaia stars of the field are in (or failed). */
    async settled(ms = 60000) { const t0 = performance.now(); while (performance.now() - t0 < ms && (V.gaiaState === 'loading' || [...V.cells.values()].some((c) => c.state === 'loading'))) await new Promise((r) => setTimeout(r, 200)); return api.report(); },
    report() {
      const sv = survey(), cells = [...V.cells.values()];
      return { target: target.name, survey: sv.label, image_width_arcmin: P.size, images: cells.map((c) => ({ i: c.i, j: c.j, state: c.state, source: c.source || undefined, error: c.err || undefined })),
        gaia: V.gaiaState, target_in_gaia: V.tgt ? { source: V.tgt.source, G: +V.tgt.g.toFixed(3), bp_rp: Number.isFinite(V.tgt.bprp) ? +V.tgt.bprp.toFixed(3) : null } : null, delta_g_range: [+P.dgMin, +P.dgMax], outline_arcmin: P.outline ? [+P.ow, +P.oh, +P.orot] : null,
        stars_in_field: V.nb.length, comparison_candidates: V.nb.filter((s) => s.comp).slice(0, 20).map((s) => ({ source: s.source, G: +s.g.toFixed(3), dG: +s.dG.toFixed(3), bp_rp: Number.isFinite(s.bprp) ? +s.bprp.toFixed(3) : null, sep_arcsec: +s.sep.toFixed(1), pa_deg: +s.pa.toFixed(1) })),
        credit: el.querySelector('#svCredit').textContent };
    },
  };
  current = api; reset(); setTimeout(() => cv.focus?.(), 0);
  return api;
}
export const currentSurvey = () => current;
