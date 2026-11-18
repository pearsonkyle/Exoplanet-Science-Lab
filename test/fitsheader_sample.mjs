// Frames written by frameHeader + encodeFits for the astropy check (test/make_fitsheader_reference.py runs this):
//   node test/fitsheader_sample.mjs <dir>     writes <dir>/frame_<n>.fits and <dir>/inputs.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { frameHeader } from '../src/core/fitsheader.js';
import { encodeFits } from '../src/core/fits.js';
import { makeWcs } from '../src/core/platesolve.js';

export const CASES = [
  { name: 'kitt-peak-hatp32', exposure: { start: Date.UTC(2026, 10, 19, 4, 12, 33, 250), duration: 60, kind: 'light', filter: 'r' },
    clock: { source: 'https-date', label: 'pearsonkyle.github.io Date header', offset: -4998, unc: 23 },
    site: { name: 'Kitt Peak', lat: 31.9583, lon: -111.5967, elev: 2096 }, target: { name: 'HAT-P-32', ra: 31.0428, dec: 46.6878 },
    camera: { name: 'ZWO ASI2600MM Pro', width: 64, height: 48, gain: 100, offset: 50, egain: 0.25, binx: 2, pixelSize: 3.76, ccdTemp: -10.02, setTemp: -10, readoutMode: 0 },
    telescope: { name: 'RC 8 inch', focalLength: 1625, aperture: 203, angle: 12.5 }, mount: { pierSide: 'west' },
    sequence: { id: 'seq-20261119-hatp32', name: 'HAT-P-32 b transit 2026-11-19', frame: 17 }, observer: 'Test Observer',
    history: ['written by test/fitsheader_sample.mjs', "a long history line that is longer than seventy-two characters so that it is split over two cards"], bitpix: 16 },
  { name: 'paranal-south-solved', exposure: { start: Date.UTC(2025, 5, 3, 8, 59, 30, 5), duration: 120.5, kind: 'light', filter: 'V' },
    clock: { source: 'helper-gps', label: 'helper · gpsd PPS', offset: 12.3, unc: 1 },
    site: { name: 'Paranal', lat: -24.6272, lon: -70.4042, elev: 2635 }, target: { name: "WASP-46 (O'Brien's test: a quote)", ra: 318.7366, dec: -55.8718 },
    camera: { name: 'ZWO ASI294MC Pro', width: 50, height: 40, gain: 120, egain: 0.9, pixelSize: 4.63, bayer: { pattern: 'RGGB' } },
    telescope: { name: 'a telescope with a very long name that does not fit on one header card at all, so it continues', focalLength: 800 },
    wcs: makeWcs({ crval: [318.7366, -55.8718], crpix: [25.5, 20.5], cd: [-2.5e-4, 1e-5, 1e-5, 2.5e-4], width: 50, height: 40 }).header(), bitpix: 32 },
  { name: 'greenwich-dark-noclock', exposure: { start: Date.UTC(2024, 1, 29, 18, 0, 0), duration: 30, kind: 'dark' },
    clock: { source: 'system', offset: 0, unc: null }, site: { name: 'Greenwich', lat: 51.4769, lon: 0, elev: 46 },
    camera: { name: 'Simulated camera', width: 32, height: 32, pixelSize: 5 }, telescope: { focalLength: 500 }, bitpix: -32 },
];

const dir = process.argv[2];
if (dir) {
  mkdirSync(dir, { recursive: true });
  CASES.forEach((c, i) => {
    const cards = frameHeader(c), w = c.camera.width, h = c.camera.height, n = w * h;
    const data = new Float64Array(n); for (let k = 0; k < n; k++) data[k] = c.bitpix === -32 ? k * 0.25 - 3 : (k * 37) % 60000 + (c.bitpix === 32 ? -1000 : 0);
    writeFileSync(join(dir, `frame_${i}.fits`), encodeFits(data, w, h, cards, { bitpix: c.bitpix }));
  });
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(CASES, null, 1));
  console.log(`wrote ${CASES.length} frames to ${dir}`);
}
