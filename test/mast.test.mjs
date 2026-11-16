// The archive-bucket inventory of the photometry page (src/photometry/mast.js): what each file name in the public
// stpubdata bucket is, and the one-product-per-sector choice of the owner's TOI extraction (cadence_policy). With
// ESL_NET=1 the real listings of TOI-1873 (TIC 328933398, SPOC 2 min and 20 s, TESS-SPOC and QLP FFI products), Kepler
// TrES-2 and K2-3 are fetched (about 300 small requests); without it that part is skipped.
import { classifyKey, chooseProducts, ffiExposure, keplerQuarter, tessProducts, keplerProducts, k2Products } from '../src/photometry/mast.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };

const keys = {
  'tess/public/tid/s0020/0000/0003/2893/3398/tess2019357164649-s0020-0000000328933398-0165-s_lc.fits': { author: 'SPOC', kind: 'lc', sector: 20, exptime: 120 },
  'tess/public/tid/s0020/0000/0003/2893/3398/tess2019357164649-s0020-0000000328933398-0165-s_tp.fits': { author: 'SPOC', kind: 'tpf', sector: 20, exptime: 120 },
  'tess/public/tid/s0040/0000/0003/2893/3398/tess2021175071901-s0040-0000000328933398-0211-a_fast-lc.fits': { author: 'SPOC', kind: 'lc', sector: 40, exptime: 20 },
  'tess/public/tid/s0040/0000/0003/2893/3398/tess2021175071901-s0040-0000000328933398-0211-a_fast-tp.fits': { author: 'SPOC', kind: 'tpf', sector: 40, exptime: 20 },
  'mast/hlsp/tess-spoc/s0020/target/0000/0003/2893/3398/hlsp_tess-spoc_tess_phot_0000000328933398-s0020_tess_v1_tp.fits': { author: 'TESS-SPOC', kind: 'tpf', sector: 20, exptime: 1800 },
  'mast/hlsp/qlp/s0060/0000/0003/2893/3398/hlsp_qlp_tess_ffi_s0060-0000000328933398_tess_v01_llc.fits': { author: 'QLP', kind: 'lc', sector: 60, exptime: 200 },
  'kepler/public/lightcurves/0114/011446443/kplr011446443-2009131105131_llc.fits': { author: 'Kepler', kind: 'lc', quarter: 1, exptime: 1765.5 },
  'kepler/public/target_pixel_files/0114/011446443/kplr011446443-2009259160929_spd-targ.fits.gz': { author: 'Kepler', kind: 'tpf', quarter: 3, exptime: 58.85 },
  'k2/public/lightcurves/c1/201300000/67000/ktwo201367065-c01_llc.fits': { author: 'K2', kind: 'lc', campaign: 1, exptime: 1765.5 },
  'k2/public/target_pixel_files/c102/228600000/29000/ktwo228629075-c102_lpd-targ.fits.gz': { author: 'K2', kind: 'tpf', campaign: 102, exptime: 1765.5 },
};
let good = 0; for (const [k, want] of Object.entries(keys)) { const c = classifyKey(k); if (c && Object.entries(want).every(([f, v]) => (f === 'quarter' ? keplerQuarter(c.quarterDate) === v : c[f] === v))) good++; else console.log('   ', k, c); }
check('bucket file names classified (SPOC 2 min / 20 s, TESS-SPOC, QLP, Kepler long / short, K2, split campaigns)', good === Object.keys(keys).length && classifyKey('tess/public/tid/s0002/0000/0001/0010/0827/tess2018235142541-s0002-s0002-0000000100100827-00109_dvr.pdf') === null, `${good} of ${Object.keys(keys).length}; validation reports ignored`);
check('FFI exposure by sector (30 min to S26, 10 min to S55, 200 s after)', ffiExposure(20) === 1800 && ffiExposure(40) === 600 && ffiExposure(56) === 200);
{
  const P = (author, sector, exptime, kind = 'lc', ffi = false) => ({ mission: 'TESS', author, group: sector, exptime, kind, ffi, cadence: exptime === 20 ? '20 s' : exptime === 120 ? '2 min' : `FFI ${exptime / 60} min`, key: `${author}-${sector}-${exptime}-${kind}` });
  const list = [P('SPOC', 20, 120), P('TESS-SPOC', 20, 1800, 'lc', true), P('QLP', 20, 1800, 'lc', true), P('SPOC', 40, 20), P('SPOC', 40, 120), P('TESS-SPOC', 40, 600, 'lc', true), P('QLP', 47, 600, 'lc', true), P('SPOC', 40, 120, 'tpf')];
  const a = chooseProducts(list), b = chooseProducts(list, { cadence: 'longest' }), c = chooseProducts(list, { cadence: '2 min' }), d = chooseProducts(list, { cadence: 'FFI', authors: ['QLP', 'TESS-SPOC'] }), e = chooseProducts(list, { groups: [40] }), f = chooseProducts(list, { kind: 'tpf' });
  check("one product per sector: 'shortest' (EXOTIC's default), 'longest', a fixed cadence, FFI only, chosen sectors, TPFs", a.chosen.map((p) => p.key).join() === 'SPOC-20-120-lc,SPOC-40-20-lc,QLP-47-600-lc' && b.chosen.map((p) => p.key).join() === 'TESS-SPOC-20-1800-lc,TESS-SPOC-40-600-lc,QLP-47-600-lc' && c.chosen.length === 2 && d.chosen.map((p) => p.author).join() === 'QLP,TESS-SPOC,QLP' && e.chosen.length === 1 && e.chosen[0].exptime === 20 && f.chosen.length === 1,
    `shortest: ${a.chosen.map((p) => `S${p.group} ${p.author} ${p.cadence}`).join(', ')}; alternatives in S40: ${a.alternatives[40].join(', ')}`);
}
if (process.env.ESL_NET === '1') {
  const t0 = performance.now(), T = await tessProducts(328933398), ms = performance.now() - t0, sectors = [...new Set(T.map((p) => p.group))];
  const has = (a, cad) => T.some((p) => p.author === a && (!cad || p.cadence === cad));
  check('live: TOI-1873 products in the bucket (SPOC 2 min and 20 s, TESS-SPOC, QLP)', has('SPOC', '2 min') && has('SPOC', '20 s') && has('TESS-SPOC') && has('QLP'), `${T.length} products in ${sectors.length} sectors (${sectors.join(', ')}), ${(ms / 1000).toFixed(1)} s; ${['SPOC', 'TESS-SPOC', 'QLP'].map((a) => `${a} ${T.filter((p) => p.author === a).length}`).join(', ')}`);
  const K = await keplerProducts(11446443), K2 = await k2Products(201367065);
  check('live: Kepler TrES-2 and K2-3 products', K.some((p) => p.kind === 'lc') && K.some((p) => p.kind === 'tpf') && K2.some((p) => p.kind === 'lc' && p.campaign === 1) && K2.some((p) => p.kind === 'tpf'), `Kepler: ${K.length} files over quarters ${[...new Set(K.map((p) => p.group))].join(', ')}; K2-3: ${K2.map((p) => `C${p.campaign} ${p.kind}`).join(', ')}`);
} else console.log('skip live bucket listings (set ESL_NET=1)');
process.exit(ok ? 0 : 1);
