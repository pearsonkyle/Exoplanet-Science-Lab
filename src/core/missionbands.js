// Named wavelength ranges of space-mission spectroscopic modes, for limb darkening (ldspec.js takes any
// [nm, nm] range) and for the spectroscopic simulator (spectroscopy.js). No DOM.
//
// Every entry is a TOP-HAT: the published wavelength limits of the mode and nothing else. No throughput curve
// is bundled (none was downloaded for this file), so a "band" here weights every wavelength inside its limits
// equally, per photon, exactly as the boxcar bands of the bundled 37-band table do. `R` is the nominal
// resolving power quoted for the mode, used only as the default channel width of a simulation.
//
// Sources of the limits
//   JWST: JWST User Documentation (JDox), jwst-docs.stsci.edu, instrument "Observing Modes" pages for
//         NIRISS SOSS, NIRSpec Bright Object Time Series, NIRCam Grism Time Series and MIRI Low Resolution
//         Spectroscopy. NIRCam limits are those already used by the 37-band table (src/core/ldest.js).
//   Ariel: Tinetti et al. 2018, Experimental Astronomy 46, 135 (doi:10.1007/s10686-018-9598-x), Table 1; the
//         Ariel Definition Study Report ("Red Book"), ESA/SCI(2020)1, Table 4-1.
//
// The limb darkening table (src/data/ld_spectral.js) ends at 5500 nm. Bands that reach beyond it (MIRI LRS,
// Ariel AIRS-Ch1 above 5.5 micron) are flagged by `beyondTable`; channelLimbDarkening() in spectroscopy.js
// then uses the part inside, or the reddest 200 nm of the table when nothing is inside, and says so.

export const LD_TABLE_MAX_NM = 5500;

const band = (mission, mode, lo, hi, R, kind, note) => ({ mission, mode, range: [lo, hi], micron: [lo / 1000, hi / 1000], R, kind, note: note || '', beyondTable: hi > LD_TABLE_MAX_NM });

/** name -> { mission, mode, range [nm, nm], micron [um, um], R, kind: 'spectrometer' | 'photometer', note, beyondTable } */
export const MISSION_BANDS = {
  'JWST NIRISS SOSS order 1': band('JWST', 'NIRISS SOSS order 1', 900, 2800, 700, 'spectrometer', 'GR700XD, R about 700 at 1.25 micron'),
  'JWST NIRISS SOSS order 2': band('JWST', 'NIRISS SOSS order 2', 600, 1400, 1400, 'spectrometer', 'GR700XD, usable to about 0.85 micron on the SUBSTRIP256 subarray'),
  'JWST NIRSpec PRISM': band('JWST', 'NIRSpec PRISM/CLEAR', 600, 5300, 100, 'spectrometer', 'R from about 30 at 1.2 micron to 300 at 5 micron'),
  'JWST NIRSpec G395H': band('JWST', 'NIRSpec G395H/F290LP', 2870, 5140, 2700, 'spectrometer', 'two detectors; the gap between NRS1 and NRS2 falls near 3.72 to 3.82 micron'),
  'JWST NIRSpec G395M': band('JWST', 'NIRSpec G395M/F290LP', 2870, 5100, 1000, 'spectrometer'),
  'JWST NIRCam F322W2': band('JWST', 'NIRCam grism F322W2', 2430, 4010, 1600, 'spectrometer'),
  'JWST NIRCam F444W': band('JWST', 'NIRCam grism F444W', 3880, 4990, 1600, 'spectrometer'),
  'JWST MIRI LRS': band('JWST', 'MIRI LRS slitless', 5000, 12000, 100, 'spectrometer', 'R about 40 at 5 micron, 160 at 10 micron'),
  'Ariel VISPhot': band('Ariel', 'VISPhot', 500, 600, 1, 'photometer'),
  'Ariel FGS1': band('Ariel', 'FGS1', 600, 800, 1, 'photometer'),
  'Ariel FGS2': band('Ariel', 'FGS2', 800, 1100, 1, 'photometer'),
  'Ariel NIRSpec': band('Ariel', 'NIRSpec', 1100, 1950, 15, 'spectrometer', 'R >= 15'),
  'Ariel AIRS-Ch0': band('Ariel', 'AIRS-Ch0', 1950, 3900, 100, 'spectrometer', 'R >= 100'),
  'Ariel AIRS-Ch1': band('Ariel', 'AIRS-Ch1', 3900, 7800, 30, 'spectrometer', 'R >= 30'),
};

export const bandsOf = (mission) => Object.entries(MISSION_BANDS).filter(([, b]) => b.mission === mission).map(([name, b]) => ({ name, ...b }));

/**
 * Telescopes for the simulator. `area` is the collecting area in m^2.
 *   Ariel: 1.1 m x 0.73 m elliptical primary, 0.64 m^2 (Tinetti et al. 2018; Red Book section 4).
 *   JWST:  25.4 m^2 (JDox, "JWST Telescope").
 * `throughput` is ONE number per telescope: the fraction of photons collected by the primary that end up as
 * detected electrons (optics x detector), the same at every wavelength. It is an assumption for the user to
 * edit, not a value taken from a mission document. `noiseFloorPpm` likewise.
 */
export const TELESCOPES = {
  Ariel: { name: 'Ariel', area: 0.64, throughput: 0.3, noiseFloorPpm: 20, bands: ['Ariel VISPhot', 'Ariel FGS1', 'Ariel FGS2', 'Ariel NIRSpec', 'Ariel AIRS-Ch0', 'Ariel AIRS-Ch1'], simR: { 'Ariel NIRSpec': 15, 'Ariel AIRS-Ch0': 50, 'Ariel AIRS-Ch1': 15 } },
  JWST: { name: 'JWST', area: 25.4, throughput: 0.3, noiseFloorPpm: 10, bands: ['JWST NIRSpec PRISM'], simR: { 'JWST NIRSpec PRISM': 50, 'JWST NIRSpec G395H': 100, 'JWST NIRSpec G395M': 100, 'JWST NIRISS SOSS order 1': 100, 'JWST NIRCam F322W2': 100, 'JWST NIRCam F444W': 100, 'JWST MIRI LRS': 30 } },
};

/**
 * Channels of a simulated observation: every photometer is one channel, every spectrometer band is cut into
 * channels of constant resolving power R = lambda / dlambda (the last channel takes what is left when it is at
 * least half a channel wide, otherwise it is merged into the one before).
 * Returns [{ name, band, lo, hi, wl (micron) }].
 */
export function instrumentChannels(telescope, bandNames, simR = {}) {
  const tel = typeof telescope === 'string' ? TELESCOPES[telescope] : telescope, out = [];
  for (const name of bandNames || tel.bands) {
    const b = MISSION_BANDS[name]; if (!b) throw new Error('Unknown band: ' + name);
    const [lo, hi] = b.micron, R = simR[name] ?? (tel.simR && tel.simR[name]) ?? b.R;
    if (b.kind === 'photometer' || !(R > 1)) { out.push({ name, band: name, lo, hi, wl: 0.5 * (lo + hi) }); continue; }
    const q = (2 * R + 1) / (2 * R - 1), edges = [lo];      // a channel centred on c spans c (1 -/+ 1/2R)
    while (edges[edges.length - 1] * q < hi) edges.push(edges[edges.length - 1] * q);
    if (hi - edges[edges.length - 1] >= 0.5 * (edges[edges.length - 1] * q - edges[edges.length - 1]) || edges.length === 1) edges.push(hi); else edges[edges.length - 1] = hi;
    for (let i = 0; i + 1 < edges.length; i++) out.push({ name: `${name} ${i + 1}`, band: name, lo: edges[i], hi: edges[i + 1], wl: 0.5 * (edges[i] + edges[i + 1]) });
  }
  return out;
}
