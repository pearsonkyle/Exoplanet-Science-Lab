// Bibliography and software table of the Validation page. Pure data, importable from Node.
//
// Every entry was checked on 2026-11-15 against Crossref (title, authors, journal, volume, page, year) and, where an
// arXiv number is given, against the arXiv API; ASCL entries against ascl.net. Exceptions are marked `note`.
// Add an entry here before citing it: cite('key') in the page code throws on an unknown key.

const doi = (d) => 'https://doi.org/' + d, arx = (a) => 'https://arxiv.org/abs/' + a, ads = (b) => 'https://ui.adsabs.harvard.edu/abs/' + encodeURIComponent(b);

export const REFS = {
  agol2020: { short: 'Agol, Luger & Foreman-Mackey 2020', authors: 'Agol, E., Luger, R. & Foreman-Mackey, D.', year: 2020, title: 'Analytic Planetary Transit Light Curves and Derivatives for Stars with Polynomial Limb Darkening', where: 'AJ, 159, 123', doi: '10.3847/1538-3881/ab4fee', arxiv: '1908.03222' },
  astropy2022: { short: 'Astropy Collaboration 2022', authors: 'Astropy Collaboration, Price-Whelan, A. M., Lim, P. L., Earl, N., et al.', year: 2022, title: 'The Astropy Project: Sustaining and Growing a Community-oriented Open-source Project and the Latest Major Release (v5.0) of the Core Package', where: 'ApJ, 935, 167', doi: '10.3847/1538-4357/ac7c74' },
  baluev2008: { short: 'Baluev 2008', authors: 'Baluev, R. V.', year: 2008, title: 'Assessing the statistical significance of periodogram peaks', where: 'MNRAS, 385, 1279', doi: '10.1111/j.1365-2966.2008.12689.x', arxiv: '0711.0330' },
  barragan2019: { short: 'Barragán et al. 2019', authors: 'Barragán, O., Gandolfi, D. & Antoniciello, G.', year: 2019, title: 'pyaneti: a fast and powerful software suite for multiplanet radial velocity and transit fitting', where: 'MNRAS, 482, 1017', doi: '10.1093/mnras/sty2472', arxiv: '1809.04609' },
  barragan2022: { short: 'Barragán et al. 2022', authors: 'Barragán, O., Aigrain, S., Rajpaul, V. M. & Zicher, N.', year: 2022, title: 'pyaneti – II. A multidimensional Gaussian process approach to analysing spectroscopic time-series', where: 'MNRAS, 509, 866', doi: '10.1093/mnras/stab2889', arxiv: '2109.14086' },
  bradley: { short: 'Bradley et al. (Photutils)', authors: 'Bradley, L., et al.', year: 2016, title: 'Photutils: Photometry tools', where: 'Astrophysics Source Code Library, ascl:1609.011', url: 'https://ascl.net/1609.011' },
  buchner2016: { short: 'Buchner 2016', authors: 'Buchner, J.', year: 2016, title: 'A statistical test for Nested Sampling algorithms', where: 'Statistics and Computing, 26, 383', doi: '10.1007/s11222-014-9512-y', arxiv: '1407.5459' },
  buchner2019: { short: 'Buchner 2019', authors: 'Buchner, J.', year: 2019, title: 'Collaborative Nested Sampling: Big Data versus Complex Physical Models', where: 'PASP, 131, 108005', doi: '10.1088/1538-3873/aae7fc', arxiv: '1707.04476' },
  buchner2021: { short: 'Buchner 2021', authors: 'Buchner, J.', year: 2021, title: 'UltraNest - a robust, general purpose Bayesian inference engine', where: 'JOSS, 6, 3001', doi: '10.21105/joss.03001', arxiv: '2101.09604' },
  chen2017: { short: 'Chen & Kipping 2017', authors: 'Chen, J. & Kipping, D.', year: 2017, title: 'Probabilistic Forecasting of the Masses and Radii of Other Worlds', where: 'ApJ, 834, 17', doi: '10.3847/1538-4357/834/1/17' },
  claret2000: { short: 'Claret 2000', authors: 'Claret, A.', year: 2000, title: '', where: 'A&A, 363, 1081 (the four-coefficient limb-darkening law)', url: ads('2000A&A...363.1081C'), note: 'No DOI exists. Journal, volume, page and year were confirmed from the reference lists of Kreidberg 2015 and Morello et al. 2020 in Crossref; the title is not printed because it could not be checked online (CDS was unavailable).' },
  czesla2019: { short: 'Czesla et al. 2019', authors: 'Czesla, S., et al.', year: 2019, title: 'PyA: Python astronomy-related packages', where: 'Astrophysics Source Code Library, ascl:1906.010', url: 'https://ascl.net/1906.010' },
  foremanmackey2013: { short: 'Foreman-Mackey et al. 2013', authors: 'Foreman-Mackey, D., Hogg, D. W., Lang, D. & Goodman, J.', year: 2013, title: 'emcee: The MCMC Hammer', where: 'PASP, 125, 306', doi: '10.1086/670067', arxiv: '1202.3665' },
  foremanmackey2021: { short: 'Foreman-Mackey et al. 2021', authors: 'Foreman-Mackey, D., Luger, R., Agol, E., Barclay, T., et al.', year: 2021, title: 'exoplanet: Gradient-based probabilistic inference for exoplanet data & other astronomical time series', where: 'JOSS, 6, 3285', doi: '10.21105/joss.03285' },
  fulton2018: { short: 'Fulton et al. 2018', authors: 'Fulton, B. J., Petigura, E. A., Blunt, S. & Sinukoff, E.', year: 2018, title: 'RadVel: The Radial Velocity Modeling Toolkit', where: 'PASP, 130, 044504', doi: '10.1088/1538-3873/aaaaa8', arxiv: '1801.01947' },
  husser2013: { short: 'Husser et al. 2013', authors: 'Husser, T.-O., Wende-von Berg, S., Dreizler, S., Homeier, D., et al.', year: 2013, title: 'A new extensive library of PHOENIX stellar atmospheres and synthetic spectra', where: 'A&A, 553, A6', doi: '10.1051/0004-6361/201219058' },
  jensen2013: { short: 'Jensen 2013', authors: 'Jensen, E.', year: 2013, title: 'Tapir: A web interface for transit/eclipse observability', where: 'Astrophysics Source Code Library, ascl:1306.007', url: 'https://ascl.net/1306.007' },
  kipping2013: { short: 'Kipping 2013', authors: 'Kipping, D. M.', year: 2013, title: 'Efficient, uninformative sampling of limb darkening coefficients for two-parameter laws', where: 'MNRAS, 435, 2152', doi: '10.1093/mnras/stt1435', arxiv: '1308.0009' },
  kreidberg2015: { short: 'Kreidberg 2015', authors: 'Kreidberg, L.', year: 2015, title: 'batman: BAsic Transit Model cAlculatioN in Python', where: 'PASP, 127, 1161', doi: '10.1086/683602', arxiv: '1507.08285' },
  leonardi2024: { short: 'Leonardi et al. 2024', authors: 'Leonardi, P., Nascimbeni, V., et al.', year: 2024, title: 'TASTE V. A new ground-based investigation of orbital decay in the ultra-hot Jupiter WASP-12b', where: 'arXiv:2402.12120', arxiv: '2402.12120', note: 'Checked against arXiv only; the journal reference was not looked up.' },
  mandel2002: { short: 'Mandel & Agol 2002', authors: 'Mandel, K. & Agol, E.', year: 2002, title: 'Analytic Light Curves for Planetary Transit Searches', where: 'ApJ, 580, L171', doi: '10.1086/345520', arxiv: 'astro-ph/0210099' },
  maxted2016: { short: 'Maxted 2016', authors: 'Maxted, P. F. L.', year: 2016, title: 'ellc: A fast, flexible light curve model for detached eclipsing binary stars and transiting exoplanets', where: 'A&A, 591, A111', doi: '10.1051/0004-6361/201628579', arxiv: '1603.08484' },
  morello2020: { short: 'Morello et al. 2020', authors: 'Morello, G., Claret, A., Martin-Lagarde, M., Cossou, C., et al.', year: 2020, title: 'The ExoTETHyS Package: Tools for Exoplanetary Transits around Host Stars', where: 'AJ, 159, 75', doi: '10.3847/1538-3881/ab63dc' },
  mpmath: { short: 'mpmath', authors: 'The mpmath development team', year: '', title: 'mpmath: a Python library for arbitrary-precision floating-point arithmetic', where: 'software', url: 'https://mpmath.org/', note: 'Software citation as the project words it; no year is printed because none was checked.' },
  parviainen2015: { short: 'Parviainen 2015', authors: 'Parviainen, H.', year: 2015, title: 'PyTransit: fast and easy exoplanet transit modelling in Python', where: 'MNRAS, 450, 3233', doi: '10.1093/mnras/stv894', arxiv: '1504.07433' },
  pearson2022: { short: 'Pearson et al. 2022', authors: 'Pearson, K. A., Beichman, C., Fulton, B. J., Esposito, T. M., et al.', year: 2022, title: 'Utilizing a Global Network of Telescopes to Update the Ephemeris for the Highly Eccentric Planet HD 80606 b and to Ensure the Efficient Scheduling of JWST', where: 'AJ, 164, 178', doi: '10.3847/1538-3881/ac8dee', arxiv: '2208.14520' },
  pecaut2013: { short: 'Pecaut & Mamajek 2013', authors: 'Pecaut, M. J. & Mamajek, E. E.', year: 2013, title: 'Intrinsic Colors, Temperatures, and Bolometric Corrections of Pre-main-sequence Stars', where: 'ApJS, 208, 9', doi: '10.1088/0067-0049/208/1/9' },
  speagle2020: { short: 'Speagle 2020', authors: 'Speagle, J. S.', year: 2020, title: 'dynesty: a dynamic nested sampling package for estimating Bayesian posteriors and evidences', where: 'MNRAS, 493, 3132', doi: '10.1093/mnras/staa278', arxiv: '1904.02180' },
  torres2010: { short: 'Torres, Andersen & Giménez 2010', authors: 'Torres, G., Andersen, J. & Giménez, A.', year: 2010, title: 'Accurate masses and radii of normal stars: modern results and applications', where: 'A&ARv, 18, 67', doi: '10.1007/s00159-009-0025-1' },
  tsiaras2016: { short: 'Tsiaras et al. 2016', authors: 'Tsiaras, A., Waldmann, I. P., Rocchetto, M., Varley, R., et al.', year: 2016, title: 'A New Approach to Analyzing HST Spatial Scans: The Transmission Spectrum of HD 209458 b', where: 'ApJ, 832, 202', doi: '10.3847/0004-637X/832/2/202', arxiv: '1511.07796' },
  vanderplas2018: { short: 'VanderPlas 2018', authors: 'VanderPlas, J. T.', year: 2018, title: 'Understanding the Lomb–Scargle Periodogram', where: 'ApJS, 236, 16', doi: '10.3847/1538-4365/aab766' },
  virtanen2020: { short: 'Virtanen et al. 2020', authors: 'Virtanen, P., Gommers, R., Oliphant, T. E., Haberland, M., et al.', year: 2020, title: 'SciPy 1.0: fundamental algorithms for scientific computing in Python', where: 'Nature Methods, 17, 261', doi: '10.1038/s41592-019-0686-2' },
  winn2010: { short: 'Winn 2010', authors: 'Winn, J. N.', year: 2010, title: 'Transits and Occultations', where: 'chapter of Exoplanets, ed. S. Seager (Tucson: University of Arizona Press); arXiv:1001.2010', arxiv: '1001.2010', note: 'Title and book as given on arXiv; page numbers not checked.' },
  zechmeister2009: { short: 'Zechmeister & Kürster 2009', authors: 'Zechmeister, M. & Kürster, M.', year: 2009, title: 'The generalised Lomb-Scargle periodogram', where: 'A&A, 496, 577', doi: '10.1051/0004-6361:200811296' },
  zellem2020: { short: 'Zellem et al. 2020', authors: 'Zellem, R. T., Pearson, K. A., Blaser, E., Fowler, M., et al.', year: 2020, title: 'Utilizing Small Telescopes Operated by Citizen Scientists for Transiting Exoplanet Follow-up', where: 'PASP, 132, 054401', doi: '10.1088/1538-3873/ab7ee7', arxiv: '2003.09046' },
};

/** Where a reference can be read: DOI first, then arXiv, then the URL. */
export const refLink = (key) => { const r = REFS[key]; if (!r) throw new Error('unknown reference: ' + key); return r.doi ? doi(r.doi) : r.arxiv ? arx(r.arxiv) : r.url; };
export const refLinks = (key) => { const r = REFS[key], out = []; if (r.doi) out.push(['doi:' + r.doi, doi(r.doi)]); if (r.arxiv) out.push(['arXiv:' + r.arxiv, arx(r.arxiv)]); if (r.url) out.push([r.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), r.url]); return out; };

/**
 * The external software. `v` names the key in the stored `versions` blocks of public/validation/*.json; `fixed` is a
 * version that comes from another stored reference (the test's own *_reference.json) and is written here by hand.
 * `issues` is the upstream tracker (never a made-up issue number).
 */
const gh = (r) => 'https://github.com/' + r;
export const CODES = {
  batman: { name: 'batman', v: 'batman', lang: 'C', repo: gh('lkreidberg/batman'), docs: 'https://lkreidberg.github.io/batman/', cite: ['kreidberg2015'], used: 'light curves, Kepler solver, event times' },
  PyTransit: { name: 'PyTransit', v: 'PyTransit', lang: 'numba', repo: gh('hpparvi/PyTransit'), docs: 'https://pytransit.readthedocs.io/', cite: ['parviainen2015'], used: 'light curves, Kepler solver, durations' },
  'exoplanet-core': { name: 'exoplanet-core', v: 'exoplanet-core', lang: 'Rust', repo: gh('exoplanet-dev/exoplanet-core'), cite: ['agol2020', 'foremanmackey2021'], used: 'exact quadratic-law flux (the starry algorithm), Kepler solver' },
  PyAstronomy: { name: 'PyAstronomy', v: 'PyAstronomy', lang: 'Fortran', repo: gh('sczesla/PyAstronomy'), docs: 'https://pyastronomy.readthedocs.io/', cite: ['czesla2019', 'mandel2002'], used: 'light curves (Mandel & Agol routines), Kepler solver' },
  ellc: { name: 'ellc', v: 'ellc', lang: 'Fortran', repo: gh('pmaxted/ellc'), docs: 'https://pypi.org/project/ellc/', cite: ['maxted2016'], used: 'light curves' },
  pylightcurve: { name: 'pylightcurve', v: 'pylightcurve', lang: 'Python', repo: gh('ucl-exoplanets/pylightcurve'), cite: ['tsiaras2016'], used: 'light curves, eclipse time, durations' },
  EXOTIC: { name: 'EXOTIC', v: 'EXOTIC', lang: 'Python', repo: gh('rzellem/EXOTIC'), cite: ['zellem2020'], used: 'light curves, radial velocities, its bundled examples' },
  pyaneti: { name: 'pyaneti', v: 'pyaneti', lang: 'Fortran', repo: gh('oscaribv/pyaneti'), docs: gh('oscaribv/pyaneti') + '/wiki', cite: ['barragan2019', 'barragan2022'], used: 'light curves (quadratic law), Kepler solver, periastron time, radial velocities' },
  radvel: { name: 'radvel', v: 'radvel', lang: 'C / Python', repo: gh('California-Planet-Search/radvel'), docs: 'https://radvel.readthedocs.io/', cite: ['fulton2018'], used: 'radial velocities, Kepler solver, event times' },
  emcee: { name: 'emcee', v: 'emcee', lang: 'Python', repo: gh('dfm/emcee'), docs: 'https://emcee.readthedocs.io/', cite: ['foremanmackey2013'], used: 'posteriors' },
  dynesty: { name: 'dynesty', v: 'dynesty', lang: 'Python', repo: gh('joshspeagle/dynesty'), docs: 'https://dynesty.readthedocs.io/', cite: ['speagle2020'], used: 'posteriors, evidence' },
  UltraNest: { name: 'UltraNest', v: 'ultranest', lang: 'Python / Cython', repo: gh('JohannesBuchner/UltraNest'), docs: 'https://johannesbuchner.github.io/UltraNest/', cite: ['buchner2021', 'buchner2016', 'buchner2019'], used: 'posteriors, evidence, the sampler stress suite' },
  mpmath: { name: 'mpmath', v: 'mpmath', lang: 'Python', repo: gh('mpmath/mpmath'), docs: 'https://mpmath.org/', cite: ['mpmath'], used: 'the 30-digit reference orbit', reference: true },
  scipy: { name: 'SciPy', v: 'scipy', lang: 'Fortran / C', repo: gh('scipy/scipy'), docs: 'https://scipy.org/', cite: ['virtanen2020'], used: 'adaptive quadrature of the reference flux', reference: true },
  // used by the project's other tests (section 5); versions as recorded in each test's stored reference
  astropy: { name: 'astropy', v: 'astropy', vnote: 'for this page’s references; 6.1.7 and 6.0.1 in the other tests, as recorded in each stored reference', lang: 'Python / C', repo: gh('astropy/astropy'), docs: 'https://www.astropy.org/', cite: ['astropy2022', 'vanderplas2018'], used: 'sky positions, time scales, Lomb-Scargle periodogram, FITS reading', elsewhere: true },
  ExoTETHyS: { name: 'ExoTETHyS', fixed: 'as called through pylightcurve 4.0.4', lang: 'Python', repo: gh('ucl-exoplanets/ExoTETHyS'), cite: ['morello2020'], used: 'limb-darkening coefficients from PHOENIX and ATLAS models', elsewhere: true },
  photutils: { name: 'photutils', fixed: '1.11.0', lang: 'Python', repo: gh('astropy/photutils'), docs: 'https://photutils.readthedocs.io/', cite: ['bradley'], used: 'aperture sums, centroids, star detection', elsewhere: true },
  forecaster: { name: 'forecaster', fixed: 'astro-forecaster from PyPI (version not recorded)', lang: 'Python', repo: gh('chenjj2/forecaster'), cite: ['chen2017'], used: 'mass-radius relation', elsewhere: true },
  swarthmore: { name: 'Swarthmore transit finder (Tapir)', fixed: 'web service; its output is stored in test/swarthmore_reference.csv', lang: 'web service', repo: 'https://astro.swarthmore.edu/transits/', cite: ['jensen2013'], used: 'observable transits for a site and week', elsewhere: true },
};
export const issuesUrl = (code) => CODES[code].repo + '/issues';
