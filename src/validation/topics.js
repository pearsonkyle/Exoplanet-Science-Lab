// Section 5 of the validation part of the Methods page (tab "Validation"): checks that live elsewhere in the project, each described declaratively.
// Pure data (no DOM), imported by the page, by tools/validation/project_reference.mjs and by test/validation.test.mjs.
//
// HOW TO ADD A SECTION (the full recipe is in validation/README.md, "Adding a section"):
//   1. Write the model's test in test/<name>.test.mjs against an independent reference; print one line per check as
//        ok   <name>   <numbers>          (or FAIL ...; three spaces before the numbers)
//   2. Add an entry to TOPICS below. `status: 'planned'` shows it in the "being added" list; `status: 'done'` renders it.
//   3. node tools/validation/project_reference.mjs <id>     stores the test's printed output in public/validation/project.json
//      (or write public/validation/<id>.json yourself, shape { date, tests: [{ file, exit, checks: [{ ok, name, info }] }], plot })
//      and set `json` accordingly.
//   4. node test/validation.test.mjs     asserts that every `quote` below is still what the test printed.
//
// Fields
//   id        anchor on the page and key in project.json
//   title     heading
//   purpose   ONE sentence a non-specialist understands
//   headline  { value, label }: the one number to remember, with its unit, and what it means in practice
//   rows      [{ what, result, check, quote, test }]: `check` is a substring of a check's name in the stored output of
//             `test` (default: tests[0]); `quote` must occur in that check's printed line. The test fails when it does not,
//             so a number written here cannot outlive a change in the code.
//   against   keys of CODES in refs.js (linked, with versions);  refs  keys of REFS (cited)
//   tests, generators, stored   repository paths; `command` reruns it
//   json      'project.json#<id>' (default) or the name of a file in public/validation/ with the same shape
//   plot      { type: 'lines' | 'bars' | 'intervals' | 'ranges', title, sub, height, alt }; the data are the `plot` member of the JSON
//             (a spec for src/validation/plot.js: see the builders in project_reference.mjs for examples)
//   caveat    what this check does not show (one or two sentences)

export const TOPICS = [
  {
    id: 'exotic', status: 'done', title: 'EXOTIC’s own examples, reproduced',
    purpose: 'The example data sets shipped with EXOTIC, fitted here and compared with EXOTIC’s own results.',
    headline: { value: '0.11 σ', label: 'largest shift of a fitted value from EXOTIC’s in the five-night fit, error bars within 6%; the single-night fit is within the test’s limits of 0.25σ and 15%' },
    rows: [
      { what: 'Transit model against pylightcurve, five planets up to e = 0.93', result: 'largest flux difference 1.0e-7', check: 'transit model matches pylightcurve', quote: 'max |Δflux| 1.0e-7' },
      { what: 'Single transit: posterior against EXOTIC’s lc_fitter', result: 'means within 0.25σ, widths within 15% (the test’s limits)', check: 'single transit: posterior matches EXOTIC', quote: 'means within 0.25σ, widths within 15%' },
      { what: 'Five nights with airmass trends: against glc_fitter', result: 'means within 0.11σ, widths within 6%', check: 'multiple transits: posterior matches EXOTIC', quote: 'largest mean difference 0.11σ, largest width difference 6%' },
      { what: 'Three-planet toy system: χ² of each light curve at the injected values', result: '45.11, 88.80 and 190.58 in both codes', check: 'toy light curves: chi2 at the truth matches EXOTIC', quote: '45.11 vs 45.11 (N 72), 88.80 vs 88.80 (N 108), 190.58 vs 190.58 (N 188)' },
      { what: 'HD 80606 b, velocities from seven instruments', result: 'K = 469.6 m/s (published 469.2, EXOTIC 469.9)', check: 'HD 80606 RV only: K, e, omega and P', quote: 'K 469.6 (paper 469.2, EXOTIC 469.9)' },
      { what: 'HD 80606 b, light curve + velocities + timing, against Table 7 of Pearson et al. 2022', result: 'P within 5e-4 d, i within 0.03°, e within 0.001, K within 3 m/s', check: 'HD 80606 joint fit against Pearson', quote: 'P within 5e-4 d, i within 0.03°, e within 0.001' },
    ],
    against: ['EXOTIC', 'pylightcurve'], refs: ['zellem2020', 'tsiaras2016', 'pearson2022'],
    tests: ['test/exotic.test.mjs'], generators: ['test/make_exotic_reference.py', 'test/make_exotic_fits.py'], stored: ['test/exotic_reference.json', 'test/exotic_fits.json'],
    plot: { type: 'intervals', title: 'Posterior mean ± 1σ: this code and EXOTIC on the same data', sub: 'in units of EXOTIC’s width, centred on EXOTIC’s mean; dashed: the value the data were simulated with', alt: 'Posterior intervals of this code and EXOTIC for a single transit and for five nights fitted together; they overlap almost exactly.' },
    caveat: 'Central values are comparable in the velocity and joint fits; error bars are not, because EXOTIC averages a reduced χ² over instruments and counts the light curve twice. This code’s planet mass is 0.38% higher for the same velocities (two-body factor).',
  },
  {
    id: 'sampler', status: 'done', title: 'The nested sampler on hard problems',
    purpose: 'The sampler on awkward problems with known answers (thin ridges, several peaks, funnels), alongside UltraNest.',
    headline: { value: '44 of 47', label: 'problems within tolerance on one seed of the full run; the three others are listed below, one of them not flagged by the run itself' },
    rows: [
      { what: 'Correlated Gaussian, 10 parameters, ρ = 0.99', result: 'ln Z = −7.729 ± 0.335, exact −6.931 (2.4σ low on this seed; over 32 seeds the mean offset is −0.078 ± 0.054)', check: 'a-gauss-d10-r0.99', quote: 'lnZ -7.729 ± 0.335 vs -6.931' },
      { what: 'Transit with a/R★ and inclination both free (0.99 correlated)', result: 'ln Z = 744.121 ± 0.196, quadrature 744.090; means within 0.025 sd', check: 'c-transit-b0.5-1000ppm-ars+inc', quote: 'lnZ 744.121 ± 0.196 vs 744.090' },
      { what: 'Period aliases: three separate peaks', result: 'ln Z = 2.166 ± 0.154, exact 2.121; the peaks are reported with their weights', check: 'd-aliases', quote: 'lnZ 2.166 ± 0.154 vs 2.121' },
      { what: 'Neal’s funnel, 4 parameters', result: 'ln Z = −16.872 ± 0.158, exact −16.588 (1.8σ low on this seed); over 48 seeds −0.045 ± 0.026 since the ellipsoid check, −0.24 ± 0.05 before', check: 'g-funnel-4d', quote: 'lnZ -16.872 ± 0.158 vs -16.588' },
      { what: 'Correlated Gaussian, 15 parameters, ρ = 0.99', result: 'ln Z = −10.245 ± 0.359, exact −10.397', check: 'a-gauss-d15-r0.99', quote: 'lnZ -10.245 ± 0.359 vs -10.397' },
      { what: 'Banana, 5 parameters', result: 'ln Z = −17.033 ± 0.204, exact −16.732 (1.5σ); posterior widths off by 23% on this seed, beyond the 20% tolerance', check: 'b-banana-5d', quote: 'widths within 23.4%', failing: true },
      { what: 'One narrow peak, 8 parameters (information 63 nats)', result: 'ln Z = 0.803 ± 0.373, exact 0 (2.2σ, just past the 0.8 ceiling of the check, and the run raised no warning); over 32 seeds the mean offset is 0.085 ± 0.076, so this seed is a fluctuation, not a bias', check: 'e-narrow-8d-H63', quote: 'lnZ 0.803 ± 0.373 vs 0.000', failing: true },
      { what: 'Correlated Gaussian, 20 parameters, ρ = 0.999', result: 'not converged at the one-million-call budget (reported as such)', check: 'a-gauss-d20-r0.999', quote: 'max calls reached', failing: true },
    ],
    against: ['UltraNest'], refs: ['buchner2021', 'buchner2016', 'buchner2019'],
    tests: ['test/stress.test.mjs'], generators: ['test/make_stress_reference.mjs', 'test/stress_ultranest.py'], stored: ['test/stress_reference.json', 'test/stress_ultranest.json'],
    command: 'npm run test:stress', env: { STRESS: 'full' },
    plot: { type: 'intervals', title: 'Evidence: ln Z minus the exact value', sub: 'this code and UltraNest 4.6.3 on the same likelihood, with their reported 1σ errors; 0 is the exact answer; d = number of parameters', alt: 'ln Z minus the exact value for sixteen test problems, for this code and UltraNest. Both scatter around zero by about their error bars; UltraNest did not converge on the period-alias problem.' },
    caveat: 'Funnel shapes are the weak spot: ln Z can come out low (see “Where this code is weaker”). In slice-sampling mode the scatter of ln Z between runs exceeds the quoted error, and a peak much narrower than another can be lost.',
  },
  {
    id: 'limbdark', status: 'done', title: 'Limb darkening from stellar parameters',
    purpose: 'How a star darkens toward its edge, computed from its temperature, gravity and metallicity, against ExoTETHyS.',
    headline: { value: '13 ppm', label: 'largest resulting difference in a transit light curve with the four-coefficient law, F to M dwarfs (21 ppm with the quadratic law)' },
    rows: [
      { what: 'HD 80606, TESS band, against the coefficients EXOTIC’s examples use', result: '0.56 ppm in flux', check: 'HD 80606 / TESS anchor: transit', quote: 'largest flux difference 0.56 ppm' },
      { what: 'Four-coefficient law, worst spectral type (K)', result: 'I(μ) rms 0.0009; 12.9 ppm in a transit', check: 'four-coefficient law, K stars', quote: 'flux 12.9 ppm' },
      { what: 'Quadratic law, worst spectral type (M)', result: 'I(μ) rms 0.0029; 20.8 ppm', check: 'quadratic law, M stars', quote: 'flux 20.8 ppm' },
      { what: 'Same table against ATLAS models (different atmosphere physics)', result: 'worst I(μ) rms 0.0327: the model-to-model spread dominates', check: 'PHOENIX table and ATLAS agree', quote: 'worst rms 0.0327' },
      { what: 'Any wavelength range (357 bins, 200 to 5500 nm): 39 HST/WFC3 channels', result: 'I(μ) rms median 4.8e-4, worst 9.2e-3; transit depth within 0.72%', check: '39 WFC3 spectroscopic channels', quote: 'I(mu) rms median 4.8e-4, worst 9.2e-3; depth median 3.0e-4, worst 7.2e-3', test: 'test/ldspec.test.mjs' },
    ],
    against: ['ExoTETHyS', 'pylightcurve'], refs: ['morello2020', 'husser2013', 'claret2000', 'kipping2013'],
    tests: ['test/limbdark.test.mjs', 'test/ldspec.test.mjs'], generators: ['test/make_ld_reference.py', 'test/make_ldspec_reference.py', 'tools/build_ld_table.py', 'tools/build_ld_spectral.py'], stored: ['test/limbdark_reference.json', 'test/ldspec_reference.json'],
    plot: { type: 'bars', title: 'Difference from ExoTETHyS in I(μ), rms, by law and spectral type', sub: 'worst band of 16; for scale, PHOENIX and ATLAS models differ by 0.0125 on average', alt: 'Bar chart of the rms difference in limb-darkening profile from ExoTETHyS for four laws and four spectral types; all bars are below 0.003.' },
    caveat: 'ExoTETHyS starts from the same PHOENIX files, so this tests the processing, the grid and the interpolation, not the physics. The boxcar and JWST bands have no external reference.',
  },
  {
    id: 'periodogram', status: 'done', title: 'Periodic signals in transit timing',
    purpose: 'The search for a periodic wobble in transit times, and its false-alarm probability, against astropy.',
    headline: { value: '4.0e-11', label: 'largest difference in periodogram power from astropy, relative to the peak' },
    rows: [
      { what: 'Power, four normalisations', result: '20,788 values within 4.0e-11 of the peak', check: 'power matches astropy, four normalisations', quote: '20788 values, max difference 4.0e-11 of the peak' },
      { what: 'False-alarm probabilities (Baluev and three others)', result: 'relative difference 1.4e-14', check: 'false-alarm probabilities match astropy', quote: 'max relative difference 1.4e-14' },
      { what: 'A 2-minute signal in 30 of 500 epochs', result: 'detected in 93% of 300 trials', check: 'amplitude 2 min: detected and measured', quote: 'FAP < 1% in 93%' },
      { what: 'Lists with no signal, 1000 trials', result: 'flagged at the 1% level in 1.00%', check: 'sequence on signal-free timing data', quote: 'FAP < 1% in 1.00%' },
      { what: 'Error bars too small by 45 s of unmodelled scatter', result: 'the analytic test raises false alarms in 68% of lists, the bootstrap in 1%', check: '45 s of unmodelled scatter', quote: 'FAP < 10% in 68% (Baluev), 1% (bootstrap)' },
    ],
    against: ['astropy', 'EXOTIC'], refs: ['zechmeister2009', 'baluev2008', 'vanderplas2018', 'astropy2022'],
    tests: ['test/periodogram.test.mjs'], generators: ['test/make_periodogram_reference.py'], stored: ['test/periodogram_reference.json'],
    plot: { type: 'bars', title: 'Injected signals recovered, by amplitude', sub: '30 transits out of 500 epochs, timing errors 30 to 90 s, 300 trials each; share of trials with a false-alarm probability under 1%', alt: 'Bar chart: a 1-minute timing signal is detected in 16% of trials, 2 minutes in 93%, 3 minutes in 99%, 5 minutes in 100%.' },
    caveat: 'The analytic false-alarm probability is only as good as the error bars; with underestimated errors it is far too optimistic (last row), which is why the page offers a bootstrap.',
  },
  {
    id: 'sky', status: 'done', title: 'Positions in the sky',
    purpose: 'Where stars, Sun, Moon and planets appear in the sky, against astropy with a JPL ephemeris.',
    headline: { value: '25″', label: 'largest error of a star’s position (the Moon is 1800″ across); planets within 10′' },
    rows: [
      { what: 'Stars, altitude and azimuth', result: 'max 25.2″ (20″ of it is annual aberration, not modelled)', check: 'stars: altitude and azimuth vs astropy AltAz', quote: 'max 25.2"' },
      { what: 'Sun', result: 'max 33.8″', check: 'sun topocentric alt/az', quote: 'max 33.8"' },
      { what: 'Moon', result: 'max 12.2″', check: 'moon topocentric alt/az', quote: 'max 12.2"' },
      { what: 'Saturn (the worst planet)', result: 'max 10.0′', check: 'saturn topocentric alt/az', quote: "max 10.0'" },
      { what: 'Sidereal time', result: 'max 0.30″', check: 'Greenwich apparent sidereal time', quote: 'max 0.30"' },
      { what: 'Refraction above 10°', result: 'max 6.30″', check: 'refraction (Bennett) vs ERFA', quote: 'max 6.30"' },
    ],
    against: ['astropy'], refs: ['astropy2022'],
    tests: ['test/astro.test.mjs'], generators: ['test/make_astro_reference.py'], stored: ['test/astro_reference.json'],
    plot: { type: 'ranges', title: 'Position error by object, arcseconds', sub: 'bar: from the rms to the largest error over the test instants (1975 to 2050)', alt: 'Range plot of sky-position error by object: stars, Sun, Moon, Mercury and Venus under 50 arcseconds; Mars 160; Jupiter 500; Saturn 600.' },
    caveat: 'Enough to find and frame an object, not for astrometry: Jupiter and Saturn are limited by the simple orbital elements used.',
  },
  {
    id: 'planner', status: 'done', title: 'Which transits can be observed',
    purpose: 'The planner’s list of observable transits, against astropy and the Swarthmore transit finder.',
    headline: { value: '32 of 32', label: 'of the Swarthmore finder’s events found, mid-times within 0.7 min' },
    rows: [
      { what: 'Target altitude, 400 positions', result: 'worst 0.0077°', check: 'target altitude within 0.015 deg', quote: 'worst 0.0077 deg' },
      { what: 'Sunset, sunrise and the three twilights, 274 crossings', result: 'worst 6.4 s', check: 'sunset, sunrise and the three twilights', quote: 'worst 6.4 s' },
      { what: 'Barycentric time correction (BJD_TDB − JD_UTC)', result: 'worst 3.92 s', check: 'BJD_TDB - JD_UTC within 6 s of astropy', quote: 'worst 3.92 s' },
      { what: 'Swarthmore finder: mid-transit times', result: '32 events, worst 0.70 min', check: 'Swarthmore finder, same ephemerides', quote: '32 events, worst 0.70 min' },
      { what: 'Swarthmore finder: elevations', result: 'worst 0.52°', check: 'elevations and azimuths within its 1 deg rounding', quote: 'elevation worst 0.52 deg' },
    ],
    against: ['astropy', 'swarthmore'], refs: ['astropy2022', 'jensen2013'],
    tests: ['test/observability.test.mjs'], generators: ['test/make_observability_reference.py', 'tools/compare_swarthmore.mjs'], stored: ['test/observability_reference.json', 'test/swarthmore_reference.csv'],
    caveat: 'Altitudes ignore refraction, time systems are not converted, and the Swarthmore comparison covers one site and one week.',
  },
  {
    id: 'photometry', status: 'done', title: 'From images to a light curve',
    purpose: 'Reading images, summing a star’s light, finding its centre and timing exposures, against astropy and photutils.',
    headline: { value: '4.4e-16', label: 'largest relative difference of an aperture sum from photutils' },
    rows: [
      { what: 'Aperture sums with exact pixel overlap, 4 radii × 6 stars', result: '4.4e-16 relative', check: 'aperture sums, exact overlap, match photutils', quote: 'largest relative difference 4.4e-16' },
      { what: 'Flux-weighted centroid', result: '1.4e-14 px', check: 'flux-weighted centroid matches photutils', quote: 'largest difference 1.4e-14 px' },
      { what: 'Star detection', result: 'the same six stars as DAOStarFinder, within 0.03 px', check: 'detection finds the same stars as DAOStarFinder', quote: 'positions agree within 0.03 px' },
      { what: 'FITS pixel values, six data types', result: '3.7e-16', check: 'BITPIX 8, 16, 32, 64, -32, -64 decode', quote: 'largest difference 3.7e-16', test: 'test/fits.test.mjs' },
      { what: 'UTC to BJD_TDB, 35 targets and dates', result: 'within 0.045 s', check: 'UTC -> BJD_TDB against astropy', quote: 'largest difference 0.045 s', test: 'test/fits.test.mjs' },
      { what: 'Gaussian-process detrending: likelihood against scikit-learn', result: '1.1e-13', check: 'log marginal likelihood matches scikit-learn', quote: 'difference 1.1e-13', test: 'test/gp.test.mjs' },
      { what: 'End to end on synthetic frames with an injected transit', result: 'scatter 0.372%, at the photon-noise level', check: 'residual scatter is at the photon-noise level', quote: '0.372%' },
    ],
    against: ['photutils', 'astropy', 'EXOTIC'], refs: ['bradley', 'astropy2022', 'virtanen2020'],
    tests: ['test/photometry.test.mjs', 'test/fits.test.mjs', 'test/gp.test.mjs'], generators: ['test/make_photometry_reference.py'], stored: ['test/photometry_reference.json'],
    caveat: 'Synthetic frames and two archived TESS and Kepler pixel files. One set of real ground-based frames (EXOTIC’s HAT-P-32 b sample, 142 frames) is reduced in a separate test, test/exotic_photometry.test.mjs, and compared with EXOTIC’s reduction of the same frames: the two choose different apertures and comparison stars and give Rp/R★ = 0.1452 ± 0.0032 here against 0.1562 ± 0.0034. No reduction has been compared with a published light curve.',
  },
  {
    id: 'relations', status: 'done', title: 'Estimates in the catalogue',
    purpose: 'Published relations that fill gaps in the catalogue (mass from radius, for one), each against its source.',
    headline: { value: '1.4%', label: 'largest difference of the mass-radius relation from the forecaster package' },
    rows: [
      { what: 'Chen & Kipping mass-radius relation against forecaster', result: 'largest difference 1.37%', check: 'CK17 R(M): Table 2 values', quote: 'largest difference 1.37%' },
      { what: 'Pecaut & Mamajek dwarf sequence against the published table', result: '63 rows, B9V to M9.5V, identical', check: 'dwarf table matches the published file', quote: '63 rows, B9V to M9.5V' },
      { what: 'Dwarf masses against Torres et al. 2010', result: 'within 0.022 dex (that calibration’s own scatter is 0.027)', check: 'dwarf masses vs Torres et al. 2010', quote: 'largest difference 0.022 dex' },
      { what: 'Velocity semi-amplitude of Jupiter and Earth against astropy constants', result: '12.474 and 0.08947 m/s in both', check: 'RV semi-amplitude', quote: 'Jupiter 12.474 vs 12.474 m/s; Earth 0.08947 vs 0.08947 m/s' },
    ],
    against: ['forecaster', 'astropy'], refs: ['chen2017', 'pecaut2013', 'torres2010'],
    tests: ['test/relations.test.mjs'], generators: ['test/make_relations_reference.py'], stored: ['test/relations_reference.json'],
    plot: { type: 'lines', title: 'Radius from mass: this code and forecaster', sub: 'Chen & Kipping (2017) relation; points are medians of the forecaster posterior', alt: 'Planet radius against mass on logarithmic axes from 0.1 to 100,000 Earth masses; the curve of this code passes through the forecaster points.' },
    caveat: 'These are population averages with large scatter (0.25 dex in mass at 2.5 Earth radii); no mass is estimated above 11.3 Earth radii, where the relation is not single-valued.',
  },
  {
    id: 'basics', status: 'done', title: 'Evidence, ephemerides and geometry',
    purpose: 'Smaller pieces: evidence against brute-force integration, ephemeris fits against exact arithmetic, transit geometry.',
    headline: { value: '0 of 160,000', label: 'model evaluations where the flux dips without the planet in front of the star' },
    rows: [
      { what: 'Flux dips exactly when the discs overlap', result: '160,000 samples, 0 mismatches', check: 'flux dip <=> discs overlap in front', quote: '160000 samples, 85 grazing, 58 non-transiting, mismatches 0', test: 'test/physics.test.mjs' },
      { what: 'ln Z against midpoint quadrature, three free parameters', result: 'quadrature 1640.001; sampler mean of six seeds within its reported error', check: 'rprs+tmid+inc: sampler vs quadrature', quote: 'quadrature 1640.001', test: 'test/evidence.test.mjs' },
      { what: 'Ephemeris coefficients against exact rational arithmetic', result: 'within 1.8e-6 σ', check: 'coefficients match the exact solution', quote: 'max difference 1.8e-6 sigma', test: 'test/ephemeris.test.mjs' },
      { what: 'Orbital decay of WASP-12 b from the published dP/dE', result: '−30.74 ± 2.69 ms/yr here, −30.72 ± 2.67 published', check: 'dP/dt conversion, WASP-12 b own data', quote: '-30.74 ± 2.69 vs -30.72 ± 2.67 ms/yr published', test: 'test/ephemeris.test.mjs' },
      { what: 'Several nights in one fit: ln L against quadrature over each normalisation', result: 'difference 9.5e-8 at ln L = 2468.49', check: 'ln L = sum over epochs of the a1-marginal by quadrature', quote: 'difference -9.5e-8', test: 'test/multiepoch.test.mjs' },
    ],
    against: [], refs: ['leonardi2024'],
    tests: ['test/physics.test.mjs', 'test/evidence.test.mjs', 'test/ephemeris.test.mjs', 'test/multiepoch.test.mjs', 'test/kernel.test.mjs', 'test/nested.test.mjs'], generators: ['test/make_ephemeris_reference.py', 'test/make_reference.py'], stored: ['test/ephemeris_reference.json', 'test/reference.json'],
    caveat: 'No published list of transit times has been fitted end to end and compared with its paper; only the unit conversion was.',
  },

  {
    id: 'phasecurve', status: 'done', title: 'Phase curves and eclipse mapping',
    purpose: 'The planet’s own light around its orbit: eclipse, phase curve and maps in spherical harmonics, against direct integration, batman, starry, jaxoplanet and EXOTIC.',
    headline: { value: '4.6e-13', label: 'largest error of the 16 map basis light curves against direct numerical integration, in units of the planet’s flux' },
    rows: [
      { what: 'Map basis curves to degree 3, through ingress and egress', result: 'max 4.6e-13 over 2256 values in 5 systems', check: 'basis light curves (uniform + 15 harmonics to degree 3) match direct integration', quote: 'max 4.6e-13' },
      { what: 'Uniform-disc eclipse against batman 2.5.1', result: '4.9e-13 for circular orbits, 2.5e-7 at e = 0.93', check: 'uniform-disc eclipse matches batman 2.5.1', quote: 'wasp43 4.9e-13' },
      { what: 'Map curves against starry 1.2.0', result: 'max 5.6e-7 of the planet’s flux over 48 curves', check: 'basis light curves match starry 1.2.0', quote: 'max 5.6e-7' },
      { what: 'Harmonic phase curve against EXOTIC', result: '5.0e-13 outside transit and eclipse', check: 'harmonic model reproduces EXOTIC\'s phasecurve outside transit and eclipse', quote: 'max 5.0e-13' },
      { what: 'Brightness temperature against scipy quadrature and root finding', result: 'relative 1.6e-9 over 48 cases', check: 'brightness temperature matches scipy quadrature and root finding', quote: 'max relative 1.6e-9' },
      { what: 'The same model inside the fitting likelihood', result: 'χ² identical to the model used directly', check: 'wasp43b_eclipse_map.json: chi2 through buildProblem = direct', quote: '7 epochs', test: 'test/phasemodel.test.mjs' },
    ],
    against: ['batman', 'EXOTIC', 'scipy'], refs: ['kreidberg2015', 'zellem2020'],
    tests: ['test/phasecurve.test.mjs', 'test/phasemodel.test.mjs'], generators: [], stored: [],
    caveat: 'EXOTIC’s eclipse ingress is that of a smaller body and starts late (up to 29% of the depth during ingress); here the planet’s own disc is occulted. A map of degree 3 is invisible in the phase curve and constrained only by ingress and egress. The examples are fits to already-detrended Spitzer data; instrument systematics are not modelled.',
  },
  {
    id: 'exomoon', status: 'done', title: 'Exomoons',
    purpose: 'Transits of a planet with a moon: the union of two discs on a limb-darkened star, the pair orbiting its barycentre, against quadrature, the owner’s exomoon2.py and Pandora.',
    headline: { value: '6.5e-14', label: 'largest error of the two-disc kernel against scipy quadrature, 205 cases' },
    rows: [
      { what: 'Two overlapping discs on the star', result: 'max 6.5e-14 over 205 cases and 5 limb-darkening profiles', check: 'union of two discs on a limb-darkened star = scipy quadrature', quote: 'max |error| 6.5e-14' },
      { what: 'exomoon2.py, step by step with this kernel', result: 'planet + moon within 1.3e-8', check: 'exomoon2.py reproduced step by step with this kernel', quote: 'planet + moon 1.3e-8' },
      { what: 'Pandora, whole light curves', result: 'max difference 5.2e-6', check: 'Pandora: whole light curves', quote: 'max flux difference 5.2e-6' },
      { what: 'Timing and duration variations against Kipping’s formulas', result: 'within 2.4% and 0.5% of the amplitude', check: 'measured transit times follow -TTV cos(theta)', quote: 'largest deviation 2.41% of the amplitude' },
      { what: 'Search for an injected moon', result: 'found at S/N 26; 100 noise-only searches reach 5.0', check: 'search finds the injected moon', quote: 'at S/N 26.0' },
      { what: 'Moonless light curves', result: '1 of 40 above the 95% level of noise (2 expected)', check: 'moonless data: no false alarm', quote: '1 of 40 exceed the 95% level' },
    ],
    against: ['scipy'], refs: [],
    tests: ['test/exomoon.test.mjs'], generators: [], stored: [],
    caveat: 'The moon’s orbit is circular and the planet-moon pair is treated as two bodies about a Keplerian barycentre; the star’s tide on the moon is ignored. The exomoon2.py configuration itself is unbound (2.4 Hill radii), which the page flags. No real detection has been reproduced: there is none.',
  },
  {
    id: 'nbody', status: 'done', title: 'N-body dynamics',
    purpose: 'Planets that pull on each other: transit times and velocities from an N-body integration, against REBOUND, TTVFast, EXOTIC and analytic formulas.',
    headline: { value: '1.3e-6 s', label: 'largest difference of 610 transit times from REBOUND’s IAS15 (the high-accuracy integrator here); the fast integrator is within 0.3 s on the same system' },
    rows: [
      { what: 'Transit times against REBOUND 5.2.2 (IAS15), EXOTIC’s example system', result: '1.3e-6 s over 610 transits', check: 'exotic_example: IAS15 transit times of 610 transits, tolerance 0.01 s', quote: 'minimum separation 1.3e-6 s' },
      { what: 'Same map as REBOUND’s WHFast', result: 'positions within 2.0e-12 AU after 8000 steps', check: 'exotic_example: same map as REBOUND\'s WHFast (dt 0.1399 d, corrector 5, 8000 steps), tolerance 1e-9 AU', quote: 'positions differ by 2.0e-12 AU' },
      { what: 'One planet: identical to the Keplerian model', result: 'timing 3.4e-6 s over 400 orbits, velocity 1.6e-9 m/s', check: 'one planet: same timing model and RV model as buildProblem, tolerances 1e-5 s and 1e-6 m/s', quote: 'timing 3.4e-6 s over 400 orbits' },
      { what: 'Critical angular-momentum deficit against a brute-force minimum', result: 'relative 3.8e-12 over 25 cases', check: 'critical AMD (Laskar & Petit 2017) equals the brute-force minimum over the collision line (scipy), tolerance 1e-8', quote: 'max relative difference 3.8e-12' },
      { what: 'Unseen companion recovered from 72 transit times', result: '0.1040 M Jup (injected 0.1), mean period 5.3336 d (5.3322)', check: 'polished solution recovers the perturber: mass within 15%, mean period within 0.1%, chi2 per point below 1.4', quote: '0.1040 M_Jup (truth 0.1)' },
      { what: 'The same dynamics inside the fitting likelihood', result: 'χ² 82.9 against 82.9 from the other integrator directly', check: 'chi2 from IAS15 transit times directly agrees with the Wisdom-Holman likelihood', quote: '82.879 vs 82.945', test: 'test/nbodymodel.test.mjs' },
    ],
    against: ['EXOTIC', 'scipy'], refs: ['pearson2022'],
    tests: ['test/nbody.test.mjs', 'test/nbodymodel.test.mjs'], generators: ['test/make_nbody_reference.py'], stored: ['test/nbody_reference.json'],
    caveat: 'Light curves stay Keplerian (no photodynamics), light-travel time is not applied, and there is no MEGNO: stability is judged by the Hill and AMD criteria and a short integration. The chi-square surface of a perturber has period aliases every few thousandths of a day; the search returns one solution that fits, not the only one. TTVFast, given the same Jacobi elements, differs by hundreds of seconds because it defines them differently.',
  },
  {
    id: 'atmosphere', status: 'done', title: 'Atmosphere: transmission and emission spectra',
    purpose: 'A one-dimensional atmosphere (temperature profile, composition, molecular opacities) turned into a transmission and an emission spectrum, against numerical quadrature and the radiative transfer code petitRADTRANS.',
    headline: { value: '3.4 ppm', label: 'rms difference from petitRADTRANS in the transit depth of eight molecules mixed on a low-gravity planet, over 2996 bins from 0.6 to 12 µm, with the same opacity tables and the same interpolation in both codes (the spectrum spans 3530 ppm)' },
    rows: [
      { what: 'Transit radius of an isothermal atmosphere against adaptive quadrature', result: '0.004 scale heights at 10 layers per decade of pressure, 0.0002 at 40', check: 'transit radius of an isothermal atmosphere with constant opacity matches quadrature', quote: 'worst 0.01792, 0.00425, 0.00098, 0.00022' },
      { what: 'Emergent flux of a grey atmosphere against quadrature', result: '0.17% at 10 layers per decade, 0.011% at 40', check: 'emergent flux of a grey atmosphere with a Guillot profile matches quadrature', quote: '6.9e-3, 1.7e-3, 4.3e-4, 1.1e-4' },
      { what: 'Eight molecules mixed, same k-tables and interpolation as petitRADTRANS 3.4.0', result: 'transit 3.4 ppm rms, 13.8 ppm at worst; flux 0.36% rms', check: 'warm, eight molecules: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'rms 3.4 ppm, max 13.8 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'H2O, CO, Na, K, TiO and VO on an ultra-hot Jupiter, from 0.35 µm', result: 'transit 1.2 ppm rms; flux 0.41% rms', check: 'ultra-hot, six absorbers: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'rms 1.2 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'Each of the twelve gases alone (the largest: Na)', result: 'transit 2.7 to 6.0 ppm rms, most of it a constant offset of 3 to 5 ppm', check: 'ultra-hot, Na only: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'rms 5.5 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'The same, with the tables interpolated our way (log σ in 1/T) and not petitRADTRANS\'s (σ in T)', result: 'up to 85 ppm in the far wings of the CO bands, 9.2 ppm rms', check: 'warm, CO only: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'max 84.8 ppm at 6.087', test: 'test/rt_reference.test.mjs' },
      { what: 'Which interpolation the tables themselves favour: temperature nodes the shipped tables drop', result: 'no bias in 1/T, 2.3% low when linear in T', check: 'between temperature nodes the shipped tables are unbiased when interpolated in 1/T', quote: 'mean 0.0000 dex', test: 'test/opacity.test.mjs' },
      { what: 'The tables the app ships (R = 200, 12 g-points, 2 MB per gas), at R = 100, four molecules', result: '10.4 ppm rms on the low-gravity planet, 3.6 ppm on the hot Jupiter', check: 'warm: shipped tables', quote: 'transit rms 10.4 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'The shipped tables, eight molecules', result: '13.5 ppm rms', check: 'warm, eight molecules: shipped tables', quote: 'transit rms 13.5 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'Power-law haze against petitRADTRANS', result: 'transit 3.0 ppm rms', check: 'warm, power-law haze: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'rms 3.0 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'Opaque cloud deck at 1 mbar, 480 layers', result: 'transit 5.4 ppm rms (22 ppm at 120 layers: petitRADTRANS counts the ring under the deck\'s top as half blocked)', check: 'warm, cloud deck at 1 mbar, 480 layers: transit depth matches petitRADTRANS 3.4.0 with the same k-tables', quote: 'rms 5.4 ppm', test: 'test/rt_reference.test.mjs' },
      { what: 'Cloud deck swept in pressure', result: 'the depth changes by 22 to 23 ppm per step, never below the opaque disc', check: 'cloud deck: the depth follows its top pressure smoothly and stays above the bare disc; patchy cover mixes', quote: '22.4 to 23.3 ppm', test: 'test/opacity.test.mjs' },
      { what: 'Particle extinction (Kitzmann & Heng 2018) against Mie theory', result: 'within 0.66 to 1.48 for grains larger than the wavelength over 2π; far too low below', check: 'particle extinction (Kitzmann & Heng 2018): limits, and against Mie theory', quote: '0.66 to 1.48' },
      { what: 'The 3D view\'s layers against the limb they come from', result: 'recovered to 5.5e-7', check: 'ray-marched planet: the layers\' extinction gives back the limb\'s transmittance', quote: 'recovered to 5.5e-7' },
      { what: 'Equilibrium chemistry table against FastChem between its nodes', result: '0.02 dex rms away from C/O = 1 and up to 100 × solar; 0.06 dex over the whole grid', check: 'the chemistry table reproduces FastChem between its nodes', quote: 'rms 0.018', test: 'test/chemistry.test.mjs' },
      { what: 'FastChem against our own solver for the H-He-C-N-O gas', result: 'CO, CO2, H2 identical; H2O and CH4 0.01 dex rms', check: 'FastChem agrees with our own solution of the H-He-C-N-O gas', quote: 'H2O 0.0089', test: 'test/chemistry.test.mjs' },
      { what: 'Energy-limited mass loss against the owner\'s published table (GJ 1214 b, HD 97658 b)', result: 'within 0.3%', check: 'energy-limited mass loss reproduces the table of the mass-fractionation notes', quote: '0.32%', test: 'test/escape.test.mjs' },
      { what: 'Escape integrated through time, closed form', result: 'rate × time and the Rayleigh enrichment recovered', check: 'escape through time: a constant flux gives rate x time, and the enrichment of the closed form', quote: 'hydrogen remaining 0.8351 against 0.8351', test: 'test/escape.test.mjs' },
      { what: 'Ionization fits on hydrogen, whose values are known', result: '6.33e-18 cm² at threshold, 4.19e-13 cm³/s at 10⁴ K', check: 'hydrogen: the same fits give the textbook values', quote: '6.33e-18', test: 'test/escape.test.mjs' },
      { what: 'The sodium D lines in the model spectrum', result: 'the added depth peaks at 0.588 µm with wings on both sides', check: 'sodium: the D lines stand at 0.589 µm, with wings on both sides', quote: '0.5893: 2003', test: 'test/opacity.test.mjs' },
      { what: 'A night side 500 K cooler: day, limb and night columns', result: 'limb at the mean of day and night; identical to one column with no contrast', check: 'day and night columns: emission from the day side, transmission from the mean limb', quote: 'the mean of 1020.9 and 556.9', test: 'test/opacity.test.mjs' },
      { what: 'Self-consistent temperature profile: its closure against petitRADTRANS\'s Guillot function', result: 'identical (2e-13 K)', check: 'the closure with constant opacities is the Guillot (2010) profile', quote: '2.3e-13 K', test: 'test/climate.test.mjs' },
      { what: 'The same profile for HD 209458 b against Guillot\'s calibrated opacities', result: 'energy balanced to 0.5%; γ = 0.31 (0.4), thermal opacity 2.0e-3 cm²/g (1e-2): the right order, not the same', check: 'HD 209458 b: the profile converges, balances its energy, and lands near Guillot', quote: 'emitted over required 1.005', test: 'test/climate.test.mjs' },
      { what: 'A temperature inversion: WASP-121 b\'s day side with TiO and VO, against a retrieved profile', result: 'settles in 9 passes, balanced to 0.2%; 2729 K rising to 2984 K (retrieved: about 2500 to 2800 K)', check: 'an inversion forms where TiO and VO absorb the starlight, settles, and goes away without them', quote: 'rising to 2984 K at 1.8 mbar', test: 'test/climate.test.mjs' },
      { what: 'The top of the self-consistent profile with line strength conserved, held and not held', result: '1008 K and 1022 K, atomic hydrogen under 4e-5 (the source tables gave 1884 K and 89%)', check: 'the top of the atmosphere: no runaway heating by sodium and potassium', quote: '1008 K at the top', test: 'test/climate.test.mjs' },
      { what: 'Clouds in the self-consistent profile: the solver\'s energy balance against the forward model\'s', result: 'equal to 0.002 for a deck, partial cover and a particle layer', check: 'a cloud deck, partial cover and a particle layer enter the profile', quote: 'emitted over required 0.996 by the solver and 0.996 by forwardModel', test: 'test/climate.test.mjs' },
      { what: 'Vapour pressures of water, ammonia and methane against published points', result: 'within 0.1% (water), 0.6% (ammonia), 1.3% (methane)', check: 'vapour pressures of water, ammonia and methane against published points', quote: 'CH4 at 77 K (solid, Armstrong et al. 1955): +1.04%', test: 'test/condensation.test.mjs' },
      { what: 'Condensation temperatures of five solids against Lodders (2003)', result: 'within 0.8% at 1e-4 bar', check: 'condensation curves against Lodders (2003), and the gas fraction they imply', quote: 'MgSiO3 1305 K (Lodders 1316 K, -0.8%)', test: 'test/condensation.test.mjs' },
      { what: 'Jupiter\'s ammonia and water cloud bases against an equilibrium cloud model', result: '0.58 and 5.1 bar (0.72 and 5.7 bar)', check: 'Jupiter: the ammonia and water cloud bases of an equilibrium cloud model', quote: 'ammonia ice from 0.58 bar and water from 5.1 bar', test: 'test/condensation.test.mjs' },
      { what: 'Mie scattering against scipy\'s Bessel functions', result: 'within 4e-8, 30 cases', check: 'Mie efficiencies against scipy\'s Bessel functions, and the limits', quote: 'Qext and Qsca within 3.9e-8', test: 'test/haze.test.mjs' },
      { what: 'Nitrogen collision-induced absorption against the HITRAN files', result: 'within 0.02%', check: 'collision-induced absorption of N2-N2, N2-CH4 and N2-H2: the shipped tables against the HITRAN files', quote: 'the tables are within 1.6e-4', test: 'test/haze.test.mjs' },
      { what: 'Titan: altitudes and the methane cold trap against Huygens', result: '115 mbar at 46 km (44); methane 2.5% above the trap (1.48% measured)', check: 'Titan: altitudes of the Huygens profile, surface gravity, and the methane cold trap', quote: '2.55% above the cold trap', test: 'test/haze.test.mjs' },
      { what: 'Titan in transit against Cassini\'s solar occultations (the haze is tuned to these two numbers)', result: '302 km at 0.88 µm (about 300); slope −2.16 (−1.9 to −2.2)', check: 'Titan in transit: the haze sets the altitude, as Cassini\'s solar occultations show', quote: 'effective transit altitude 302 km at 0.88 µm', test: 'test/haze.test.mjs' },
      { what: 'The Sun from the stellar grid: total irradiance at 1 au', result: '1346 W/m² (measured 1361)', check: 'the Sun from the grid: total irradiance and its spectrum at 1 au', quote: 'total 1346 W/m²', test: 'test/stellarspec.test.mjs' },
      { what: 'Stellar grid: energy of every model, and interpolation between models', result: 'σT⁴ within 5%; a left-out model within 4.1%', check: 'energy over the grid, interpolation between models, and the grid', quote: 'within 4.1% in every bin', test: 'test/stellarspec.test.mjs' },
      { what: 'Extinction law against the dust_extinction package', result: 'within 1.07% below 2.5 µm', check: 'the Fitzpatrick (1999) extinction curve against the dust_extinction package', quote: 'within 1.07% below 2.5 µm', test: 'test/sed.test.mjs' },
      { what: 'SED fit against interferometric angular diameters (HD 209458, GJ 436, HD 97658)', result: 'within 2% and 40 K; HD 189733 off by 7% and 152 K', check: 'benchmark stars: angular diameters and temperatures against interferometry', quote: 'θ 0.2245 ± 0.0022 mas (measured 0.2254 ± 0.0072; -0.4%)', test: 'test/sed.test.mjs' },
      { what: 'SED fit against AstroARIADNE\'s published fits of two stars', result: 'HD 189733: 22 K and 0.1% apart; HD 209458: 93 K and 4%', check: 'the same stars against AstroARIADNE', quote: 'Teff 5027 K against 5049.2 K', test: 'test/sed.test.mjs' },
      { what: 'SED chain against magnitudes from the raw PHOENIX files and full passbands', result: 'within 0.6 mmag', check: 'binning and thinned passbands cost under a millimagnitude', quote: 'to 0.6 mmag', test: 'test/sed.test.mjs' },
      { what: 'Spectrum matching on a synthetic low-resolution spectrum (method only)', result: '5227 ± 2 K for 5230 K put in', check: 'spectrum matching recovers a star from a low-resolution spectrum', quote: 'Teff 5227 ± 2 K', test: 'test/sed.test.mjs' },
      { what: 'Ariel noise against ArielRad (Mugnai et al. 2020), HD 209458, six channels', result: 'photon noise within 8%, totals within 5%', check: 'noise against ArielRad', quote: 'within 8% (tolerance 10%)', test: 'test/retrieval.test.mjs' },
      { what: 'A retrieval on one simulated Ariel transit', result: 'T 1257 +39 −37 K for 1300 K; water detected at Δ ln Z = 404', check: 'a retrieval recovers the atmosphere it was given', quote: 't 1257 +39 −37 (1300 K)', test: 'test/retrieval.test.mjs' },
      { what: 'Transit, three eclipses and night side of a simulated hazy hot Jupiter retrieved together', result: 'night-side contrast 501 +32 −24 K for 500 K; nine parameters within 0.8σ; converged', check: 'end to end, the hazy planet: transit, eclipses and night side together', quote: 'nightDT 500.8 +32 −24 (500)', test: 'test/retrieval.test.mjs' },
      { what: 'Joint retrieval repeated on forty draws of the noise: are the error bars the right size', result: '[M/H] scatters 1.05 ± 0.12 and C/O 1.13 ± 0.13 times the quoted error; 68% ranges hold the truth 27 of 40 times; medians up to 0.5σ to one side', check: 'over forty draws of the noise the joint retrieval\'s error bars are the right size; its medians sit up to half an error from the truth', quote: 'mh 1.05 ± 0.12, 27, -0.39', test: 'test/retrieval.test.mjs' },
      { what: 'Star lookup from stored VizieR answers, then fitted', result: '6087 K and 0.2245 mas for HD 209458 (6092 K, 0.2254 mas)', check: 'a star looked up in Gaia, 2MASS, AllWISE and Tycho-2', quote: '6087 K and 0.2245 mas', test: 'test/sed.test.mjs' },
      { what: 'The download: opacity by absorber at one level per decade, equal to the model', result: '8 levels × 1023 wavelengths; equal to 1e-4', check: 'opacity by absorber: one level per decade of pressure, every wavelength, as optical depth per scale height', quote: '8 levels', test: 'test/bundle.test.mjs' },
      { what: 'Sodium and potassium D lines against the oscillator-strength sum rule, every table node', result: 'at most 1.20 times the rule (the source tables: up to 1.7e5)', check: 'sodium and potassium: the D lines carry no more than their oscillator strength', quote: 'is at most 1.20', test: 'test/opacity.test.mjs' },
      { what: 'The WebAssembly mixing kernel against the JavaScript loop', result: 'identical to 1e-14; 2.6 times faster', check: 'the WebAssembly mixing kernel gives the JavaScript loop\'s extinction', quote: 'largest relative difference 1.1e-14', test: 'test/opacity.test.mjs' },
      { what: 'Tables cut to the data\'s range and joined to R = 100, against the shipped tables', result: '2.1 ppm rms, 20.5 ppm at most', check: 'tables cut to a wavelength window give the same spectrum there; bins joined in pairs stay within a few ppm', quote: '2.1 ppm rms and 20.5 ppm at most', test: 'test/opacity.test.mjs' },
      { what: 'Mixing two absorbers by random overlap, exact answer known', result: '0.008 in transmittance with 16 g-points each; 0.002 for the exact joint distribution', check: 'random overlap of two uncorrelated spectra reproduces their joint transmittance', quote: '0.0081 after mixing', test: 'test/opacity.test.mjs' },
      { what: 'Collision-induced absorption against the HITRAN files', result: 'within 1.2%', check: 'shipped CIA tables match the HITRAN files', quote: 'max relative difference 1.2%', test: 'test/opacity.test.mjs' },
      { what: 'Colour of a blackbody against the tabulated CIE 1931 observer', result: '0.002 in chromaticity from 2500 to 20000 K', check: 'blackbody chromaticities match the tabulated CIE 1931 observer', quote: 'max distance in (x, y) 2.1e-3' },
      { what: 'Limb colours of a grey star against quadrature', result: '0.005 in a linear sRGB channel', check: 'limb colours of a grey star match quadrature with the tabulated observer', quote: 'max difference 0.0046' },
    ],
    against: ['petitRADTRANS', 'FastChem', 'scipy'], refs: ['molliere2019', 'chubb2021', 'guillot2010', 'madhusudhan2009', 'heng2017', 'karman2019', 'stock2018', 'asplund2021', 'kitzmann2018', 'line2016', 'watson1981', 'erkaev2007', 'hunten1987', 'ribas2005', 'verner1996', 'pearson2019', 'khare1984', 'morley2012', 'visscher2010', 'wakeford2017', 'robinson2014', 'mikalevans2019', 'lodders2003', 'frayschmitt2009', 'atreya2005', 'fulchignoni2005', 'niemann2010'],
    tests: ['test/atmosphere.test.mjs', 'test/rt_reference.test.mjs', 'test/opacity.test.mjs', 'test/chemistry.test.mjs', 'test/escape.test.mjs', 'test/climate.test.mjs', 'test/condensation.test.mjs', 'test/haze.test.mjs', 'test/stellarspec.test.mjs', 'test/sed.test.mjs', 'test/retrieval.test.mjs', 'test/bundle.test.mjs'], generators: ['test/make_atmosphere_reference.py', 'test/make_rt_reference.py', 'test/make_chem_reference.py', 'test/make_haze_reference.py', 'test/make_sed_reference.py'], stored: ['test/atmosphere_reference.json', 'test/rt_reference.json', 'test/chem_reference.json', 'test/haze_reference.json', 'test/sed_reference.json', 'test/sed_benchmarks.json'],
    caveat: 'The comparison with petitRADTRANS uses the same ExoMolOP k-tables in both codes, so it tests the radiative transfer and the mixing of gases, not the line lists. No line-by-line reference was run. Collision-induced absorption is switched off in that comparison; emission has no scattering; the reflected-light colour in the 3D view is an estimate that was compared with nothing. Where the two codes differ by tens of ppm they interpolate the tables differently in temperature; which is closer to the line lists was judged from the tables\' own nodes, not from a line-by-line run. Chemistry is gas phase only (nothing condenses). The escape rates are energy-limited estimates, good to a factor of several, and the sodium ionization takes the star\'s ultraviolet from a blackbody: neither was compared with an observation.',
  },
];

/** The tests whose printed output the page shows (unique, in order). */
export const topicTests = () => [...new Set(TOPICS.filter((t) => t.status === 'done').flatMap((t) => t.tests))];
