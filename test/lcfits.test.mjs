// FITS light-curve tables (src/core/lcfits.js) against astropy-written files in the TESS SPOC and Kepler layouts
// (test/make_lcfits_reference.py): time reference added back, quality-flagged and blank rows left out, flux divided
// by its median, then read by the analyzer's own parseLightCurve.
import { readFileSync } from 'node:fs';
import { lightCurveFromFits, looksLikeFits } from '../src/core/lcfits.js';
import { parseLightCurve } from '../src/core/data.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const ref = JSON.parse(readFileSync(new URL('./lcfits_reference.json', import.meta.url)));
for (const [file, R] of Object.entries(ref)) {
  const b = readFileSync(new URL('./data/' + file, import.meta.url)), buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const { csv, meta } = await lightCurveFromFits(buf), d = parseLightCurve(csv, file);
  const t0 = d.t[0] + d.tRef, tl = d.t[d.t.length - 1] + d.tRef;
  check(`${file}: rows kept and dropped`, d.t.length === R.n && meta.dropped.quality === R.flagged && meta.dropped.nonfinite === R.blank, `${d.t.length} of ${R.n + R.flagged + R.blank} kept; ${meta.dropped.quality} flagged, ${meta.dropped.nonfinite} blank`);
  check(`${file}: absolute BJD_TDB times`, Math.abs(t0 - R.t0) < 1e-6 && Math.abs(tl - R.t_last) < 1e-6 && d.timeStandard === 'bjd_tdb', `first ${t0.toFixed(6)}, last ${tl.toFixed(6)} against ${R.t0.toFixed(6)}, ${R.t_last.toFixed(6)}; standard ${d.timeStandard} (${meta.timeSystem} from ${meta.timeColumn} + ${meta.bjdRef})`);
  check(`${file}: PDCSAP flux and error over the median`, Math.abs(d.f[0] - R.f0) < 1e-6 && Math.abs(d.e[0] - R.e0) < 1e-9 && meta.fluxColumn === 'PDCSAP_FLUX', `first flux ${d.f[0].toFixed(7)} against ${R.f0.toFixed(7)}, error ${d.e[0].toExponential(4)} against ${R.e0.toExponential(4)}; ${meta.mission} ${meta.object}`);
  check(`${file}: recognised as FITS`, looksLikeFits(buf));
}
{
  const b = readFileSync(new URL('./data/lc_tess_small.fits', import.meta.url)), buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const { meta } = await lightCurveFromFits(buf, { flux: 'SAP_FLUX', quality: 'none' });
  check('another flux column and no quality cut on request', meta.fluxColumn === 'SAP_FLUX' && meta.dropped.quality === 0 && meta.kept === 119, `${meta.kept} rows from SAP_FLUX (only the blank time is dropped: SAP has no blanks here)`);
  const img = readFileSync(new URL('./data/syn_small_f32.fits', import.meta.url));
  let msg = ''; try { await lightCurveFromFits(img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength)); } catch (e) { msg = e.message; }
  check('an image is refused with a pointer to the Photometry page', /Photometry/.test(msg), msg);
}
process.exit(ok ? 0 : 1);
