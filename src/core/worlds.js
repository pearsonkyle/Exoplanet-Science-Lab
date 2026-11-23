// Ready-made model descriptions (as forwardModel takes them) of a few worlds, from hot to cold: starting points for
// the Atmosphere page, the Python package and the tests. `tables` names the opacity tables a model needs.
// Values and their sources are given with each; what is tuned, and to what, is said.
import { DEFAULT_MODEL } from './rtmodel.js';

const MJ = 1.89813e27, RJ = 71492;   // kg, km (as src/core/derive.js)
const H2_CIA = ['H2-H2', 'H2-He'];

export const WORLDS = {
  // Mancini et al. (2018, A&A 613, A41)
  'WASP-39 b': { about: 'A hot Saturn-mass planet, the first target of JWST\'s transmission spectra.', tables: ['H2O', 'CO2', 'CO', 'CH4', ...H2_CIA], ars: 11.4,
    model: { ...DEFAULT_MODEL, pTop: 1e-8, nLayers: 80, planet: { mplanet: 0.281, rplanet: 1.279, pRef: 0.01 }, star: { rstar: 0.939, teff: 5485, ars: 11.4 }, tp: { kind: 'guillot', teq: 1166, tint: 100, kappaIR: 1e-3, gamma: 0.4 } } },
  // Delrez et al. (2016, MNRAS 458, 4025): Teq = 2358 K. The day side keeps its heat (f = 1/2); TiO and VO stay in the gas
  // and the profile that follows from them is inverted (Mikal-Evans et al. 2019 retrieve 2500 to 2800 K between 30 and 5 mbar).
  'WASP-121 b, day side': { about: 'An ultra-hot Jupiter whose titanium and vanadium oxides absorb starlight high up: a temperature inversion.', tables: ['H2O', 'CO', 'Na', 'K', 'TiO', 'VO', ...H2_CIA], ars: 3.75, chem: true,
    model: { ...DEFAULT_MODEL, planet: { mplanet: 1.18, rplanet: 1.81, pRef: 0.01 }, star: { rstar: 1.46, teff: 6460, ars: 3.75 }, vmr: {}, chemistry: { mh: 0 }, condensation: { rainout: true }, tp: { kind: 'consistent', teq: 2358, tint: 100, f: 0.5 } } },
  // Galileo probe: 166.1 K at 1 bar, d ln T / d ln P = 0.306 below (Seiff et al. 1998); a 110 K tropopause near 0.1 bar and
  // a stratosphere warming to 160 K at 1 mbar (rounded from the same profile). Gases at three times the solar N/H, O/H
  // and C/H of Anders & Grevesse (1989), near what the probe and Juno found for carbon and nitrogen; ammonia and water rain out.
  Jupiter: { about: 'A cold gas giant: ammonia and water condense and rain out, leaving methane to shape the spectrum.', tables: ['CH4', 'NH3', 'H2O', ...H2_CIA], ars: 1118,
    model: { ...DEFAULT_MODEL, planet: { mplanet: 1, rplanet: 1, pRef: 1 }, star: { rstar: 1, teff: 5772, ars: 1118 }, pTop: 1e-6, pBottom: 30, nLayers: 80,
      tp: { kind: 'table', p: [1e-6, 1e-3, 1e-2, 0.1, 0.3, 1, 3, 10, 30], t: [160, 160, 130, 110, 115, 166.1, 232.5, 336.0, 470.0] },
      vmr: { CH4: (3 * 2 * 3.62e-4) / 1.195, NH3: (3 * 2 * 1.12e-4) / 1.195, H2O: (3 * 2 * 8.51e-4) / 1.195 }, condensation: { rainout: true, only: ['NH3', 'H2O'] },
      cloud: { follow: 'NH3', extent: 0.5, tau: 5, radius: 1, q0: 40, albedo: 0.98 } } },
  // Huygens: 93.65 K and 1.467 bar at the surface, tropopause 70.43 K near 115 mbar, stratopause 186 K near 0.3 mbar,
  // mesopause 152 K at 490 km (Fulchignoni et al. 2005, Nature 438, 785); the points between are read off between
  // those. Methane 5.65% at the surface (Niemann et al. 2010), cold-trapped above; hydrogen 0.1%. GM and radius: JPL.
  // The haze is Khare et al.'s tholin as spheres. Its three numbers (radius 0.2 micron, optical depth 6 at 1 micron,
  // spread ~ P^0.55) are tuned so that a transit reaches about 300 km at 0.88 micron with extinction falling about as
  // 1/wavelength^2, as Cassini's solar occultations show (Robinson et al. 2014, PNAS 111, 9042). Titan's real haze is
  // made of fractal aggregates of 0.05 micron monomers (Tomasko et al. 2008); a sphere size is an effective one.
  Titan: { about: 'A nitrogen atmosphere under an orange organic haze, with methane as its condensable gas and a solid surface at 1.5 bar.', tables: ['CH4', 'N2-N2', 'N2-CH4', 'N2-H2'], ars: 2060,
    model: { ...DEFAULT_MODEL, planet: { mplanet: 1.3452e23 / MJ, rplanet: 2574.76 / RJ, pRef: 1.467 }, star: { rstar: 1, teff: 5772, ars: 2060 }, bulk: 'N2', pTop: 1e-8, pBottom: 1.467, nLayers: 80,
      tp: { kind: 'table', p: [1e-8, 2.5e-6, 3e-5, 3e-4, 2e-3, 1e-2, 3e-2, 0.115, 0.3, 0.6, 1.0, 1.467], t: [160, 152, 170, 186, 165, 140, 100, 70.43, 76, 82, 88, 93.65] },
      vmr: { CH4: 0.0565, H2: 0.001 }, condensation: { rainout: true, only: ['CH4'], humidity: 1 },
      cloud: { material: 'tholin', top: 1e-6, base: 1.467, tau: 6, ref: 1, radius: 0.2, sigma: 0.4, power: 0.55 } } },
};
