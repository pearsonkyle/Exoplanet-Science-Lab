// What each worked example teaches: a short card shown when the example opens, in four parts that read in under a
// minute — what you are looking at, two or three things to try (each a button that does it through the analyzer's
// own API, so it is also undoable), how to read the result, and the physics in a few lines. No numbers are typed here:
// the cards point at what the page shows, so they stay true when an example's data or fit change.
//
// EXPLAIN[id] = { see, try: [{ label, does, run(api) }], read, physics: [lines], more: Methods section id }

const tab = (api, t) => { try { api.showTab(t); } catch { /* the tab may not exist on this layout */ } };
const view = (api, o) => { try { api.setView(o); } catch { /* not every view applies */ } };
// the camera and the loop are buttons of the 3D view (analyze/index.html): pressing them keeps one code path
const press = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
const camera = (which) => press(`#viewseg [data-view="${which}"]`);
const loop = (which) => press(`[data-loop="${which}"]`);
const fit = (api) => { tab(api, 'fit'); return api.run(); };

export const EXPLAIN = {
  single: {
    see: 'One night of a hot Jupiter crossing its star, as a small telescope records it: the dip is the planet blocking a disc that is darker at its edge, the slow slope is the atmosphere thickening as the star sets.',
    try: [
      { label: 'Fit it', does: 'Frees Rp/R★, the inclination, the mid-time and the airmass slope, and runs nested sampling.', run: (api) => { for (const k of ['rprs', 'inc', 'tmid', 'a2']) { try { api.setFree(k, true); } catch { /* not free-able here */ } } return fit(api); } },
      { label: 'Uniform disc', does: 'Switches limb darkening off: the bottom of the transit turns flat and the edges sharp.', run: (api) => api.setLimbDarkening({ law: 'uniform' }) },
      { label: 'See it from Earth', does: 'The 3D view as a telescope sees it: watch the planet cross the darker limb.', run: () => camera('earth') },
    ],
    read: 'Rp/R★ sets the depth (depth ≈ (Rp/R★)²); the inclination and a/R★ set how long ingress takes against the whole transit; the mid-time is the anchor of every future prediction. The Results tab says whether the error bars match the scatter.',
    physics: ['A transit dims the star by the fraction of its light behind the planet.', 'Limb darkening rounds the bottom of the dip; its coefficients follow the star\'s temperature and the filter.', 'Airmass adds a smooth trend that is fitted at the same time, not removed first.'],
    more: 'transit',
  },
  multi: {
    see: 'Five nights of the same planet. Each night has its own baseline and airmass trend; the planet is shared, so the period is measured from the spacing of the transits.',
    try: [
      { label: 'Fold them', does: 'Stacks every night on the orbital phase: the transits should line up.', run: (api) => view(api, { fold: true }) },
      { label: 'Free the period', does: 'Lets the fit measure P from the nights\' spacing.', run: (api) => { api.setFree('per', true); tab(api, 'fit'); } },
    ],
    read: 'With the period free, its uncertainty is the mid-time uncertainty divided by the number of orbits between the nights: widely spaced nights pin it down far better than many close ones.',
    physics: ['One planet, several epochs: shared Rp/R★, inclination and period; a separate normalisation and airmass term per night.', 'The normalisations are integrated out analytically, so they cost no sampling time.'],
    more: 'likelihood',
  },
  'hd80606-tess': {
    see: 'TESS watching HD 80606 b, a planet on one of the most eccentric orbits known (e ≈ 0.93): it races past the star in days and spends months far away.',
    try: [
      { label: 'Top-down view', does: 'Shows the orbit from above: how close the planet passes at periastron.', run: () => camera('top') },
      { label: 'Full orbit', does: 'Plays the whole 111-day orbit.', run: () => loop('orbit') },
    ],
    read: 'The transit is long and shallow; its duration with e and ω held at their known values constrains a/R★ and the inclination together.',
    physics: ['The transit duration depends on the speed at conjunction, not only on the period: eccentric orbits can make transits much longer or shorter than a circular orbit would.', 'The TESS light here is diluted by a companion star (HD 80607); the dilution term corrects the depth.'],
    more: 'orbits',
  },
  'hd80606-rv': {
    see: 'Radial velocities from seven instruments: the star\'s motion towards and away from us as the planet tugs it. The sharp swing is periastron.',
    try: [
      { label: 'Fold on the period', does: 'Plots every velocity against orbital phase.', run: (api) => view(api, { view: 'rv', fold: true }) },
      { label: 'Run the fit', does: 'Fits the period, eccentricity, ω, the mass and one zero point and jitter per instrument.', run: (api) => { return fit(api); } },
    ],
    read: 'K (the velocity amplitude) and the period give the planet\'s minimum mass; e and ω set the shape of the curve. Each instrument has its own zero point, which the fit integrates out.',
    physics: ['Velocity = K [cos(ω + ν) + e cos ω] for each planet.', 'Jitter is extra noise per instrument (the star itself, or the instrument), added in quadrature.'],
    more: 'rv',
  },
  'hd80606-joint': {
    see: 'Transit, velocities and mid-times together: one orbit has to explain all three. a/R★ comes from Kepler\'s law with the star\'s mass and radius.',
    try: [
      { label: 'Velocities', does: 'Switches the data window to the velocities with the same orbit.', run: (api) => view(api, { view: 'rv' }) },
      { label: 'Timing', does: 'The Timing tab: the transits and eclipse measured over 15 years.', run: (api) => tab(api, 'timing') },
    ],
    read: 'A joint fit is worth it when the data constrain different things: the transit gives Rp/R★ and the inclination, the velocities the mass and the shape of the orbit, the times the period.',
    physics: ['Kepler\'s third law ties a/R★ to the period and the star\'s density.', 'The planet\'s true mass follows once the inclination is known from the transit.'],
    more: 'multiplanet',
  },
  toi1873: {
    see: 'TOI-1873: three planets of one star in real TESS light curves and NEID velocities. Each planet has its own transit; the velocities carry the sum of their pulls. The outer planet was seen in only three transits, so its period is one of a few aliases.',
    try: [
      { label: 'Planet c', does: 'Shows planet c\'s folded transit.', run: (api) => api.showPlanet('c') },
      { label: 'Velocities', does: 'The velocity curve with each planet\'s part.', run: (api) => view(api, { view: 'rv' }) },
    ],
    read: 'With three planets the velocity signal is a sum; the transits fix each planet\'s period and phase, which is what lets the velocities be split between them.',
    physics: ['Planet keys carry their letter (per@c, mplanet@d).', 'An outer planet seen in few transits has a period known only up to an integer alias.'],
    more: 'multiplanet',
  },
  'toi1873-oc': {
    see: 'Only the transit times of TOI-1873\'s planets: each time minus a straight-line prediction (O − C) shows whether the planet keeps perfect time.',
    try: [{ label: 'O − C and periodogram', does: 'The Timing tab: the linear ephemeris, the residuals and their periodogram.', run: (api) => tab(api, 'timing') }],
    read: 'A flat O − C within the error bars means a constant period. A peak in the periodogram well above its false-alarm level means the times vary periodically — the first hint of another body.',
    physics: ['T(n) = T0 + n P; O − C is what is left.', 'The periodogram looks for a sinusoid at every trial period of the residuals.'],
    more: 'timing',
  },
  kepler88: {
    see: 'Kepler-88 b\'s transits arrive up to half a day early or late, in a slow 630-day cycle. Nothing else transits: the tug comes from a hidden planet, c, near the 2:1 resonance, and an N-body fit of b\'s times alone weighs it.',
    try: [{ label: 'O − C', does: 'b\'s timing variations: the measured times against the best N-body model.', run: (api) => tab(api, 'timing') }, { label: 'Top-down view', does: 'The two orbits: c, which never transits, just outside the 2:1 resonance.', run: () => camera('top') }],
    read: 'The TTV amplitude fixes c\'s mass; the super-period and the shape of the curve fix its period and both eccentricities. The mass agrees with the radial velocities measured years later — timing alone found it.',
    physics: ['Near a period ratio of 2 the planets meet at nearly the same place each time, so their pulls add up orbit after orbit.', 'The fit integrates both planets (N-body) and compares the predicted transit times of b with the 119 measured ones.'],
    more: 'nbody',
  },
  ttvpair: {
    see: 'Two transiting planets near a resonance pull on each other, so both drift early and late in opposite senses. The size of each drift weighs the other planet — no velocities needed.',
    try: [{ label: 'O − C', does: 'The anti-correlated timing variations of the two planets.', run: (api) => tab(api, 'timing') }, { label: 'Top-down view', does: 'The two orbits and their spacing.', run: () => camera('top') }],
    read: 'Planet c\'s TTV amplitude measures b\'s mass and the other way round. Compare the masses with the radii: the densities say whether they are rocky or puffy.',
    physics: ['The TTV period is the super-period 1 / |j/P₂ − (j−1)/P₁|.', 'Masses from TTVs are independent of radial velocities and work for faint stars.'],
    more: 'nbody',
  },
  'hd80606-rm': {
    see: 'During a transit the planet blocks part of a rotating star: first the side turning towards us, then the side turning away, so the star\'s measured velocity shifts — the Rossiter–McLaughlin effect. The 3D star is coloured by its fitted rotation: blue where it comes towards us, red where it goes away, tilted by the fitted λ.',
    try: [{ label: 'Velocities in transit', does: 'The velocity curve around the transit with the anomaly.', run: (api) => view(api, { view: 'rv' }) }, { label: 'See it from Earth', does: 'Watch which half of the star the planet covers as it crosses.', run: () => camera('earth') }],
    read: 'The shape of the anomaly gives λ, the angle between the star\'s spin and the orbit on the sky; its size gives v sin i. A symmetric anomaly means an aligned orbit; HD 80606 b\'s is lopsided — the orbit is tilted.',
    physics: ['The anomaly is the velocity of the light the planet hides, weighted by limb darkening.', 'Highly eccentric planets like this one are thought to have been pushed onto tilted orbits by a distant companion.'],
    more: 'rm',
  },
  decay: {
    see: 'Fifteen years of mid-transit times of WASP-12 b. A constant period would make them fall on a straight line; they curve.',
    try: [
      { label: 'The O − C diagram', does: 'Each time minus the linear prediction: the curvature is the orbit shrinking.', run: (api) => tab(api, 'timing') },
    ],
    read: 'The quadratic term is the period\'s rate of change. Compare the linear and quadratic ephemerides by their evidence on the Timing tab; χ²/dof far above 1 means the quoted errors are too small or something else varies.',
    physics: ['A planet so close to its star raises a tidal bulge; the lag of that bulge slowly takes angular momentum from the orbit.', 'dP/dt of milliseconds per year becomes minutes of shift after a decade.'],
    more: 'timing',
  },
  ephemeris: {
    see: 'Forty mid-transit times. Fitting a straight line through them (time against epoch) gives the period and a reference time to predict the next transits.',
    try: [{ label: 'Timing tab', does: 'The fit, the O − C and the periodogram of the residuals.', run: (api) => tab(api, 'timing') }],
    read: 'The predicted time\'s uncertainty grows with every orbit away from the measurements: a well-placed new observation shrinks it.',
    physics: ['T(n) = T0 + n P.', 'Periodic O − C is a sign of another body; a curve is a changing period.'],
    more: 'timing',
  },
  phasecurve: {
    see: 'A whole orbit of WASP-43 b at 4.5 µm: the planet\'s own light rises towards the eclipse as its hot dayside turns to us, and drops when the planet passes behind the star.',
    try: [
      { label: 'Phase curve', does: 'Shows the planet\'s light against phase.', run: (api) => view(api, { view: 'phase' }) },
    ],
    read: 'The eclipse depth is the dayside brightness; the amplitude is the day–night contrast; the offset of the peak from the eclipse is how far the hottest spot is carried by winds.',
    physics: ['Flux = star × transits + planets\' light.', 'The planet\'s brightness must stay positive everywhere, including the nightside.'],
    more: 'phasecurve',
  },
  eclipsemap: {
    see: 'Eclipses of WASP-43 b: as the star covers the planet, the light lost at each moment comes from a different strip of its disc, which maps the brightness across the dayside.',
    try: [
      { label: 'Slow down', does: 'Use the speed slider (time per second) to watch an ingress.', run: () => null },
    ],
    read: 'A degree-1 map has a brightness, a contrast and a hotspot direction; degree 2 adds detail the data may not support — compare their evidences.',
    physics: ['Ingress and egress resolve the dayside in longitude and, for an inclined orbit, latitude.', 'The map is a sum of spherical harmonics, constrained to be positive.'],
    more: 'phasecurve',
  },
  'eclipsemap-sim': { see: 'A simulated degree-2 map recovered from three eclipses and a transit.', try: [], read: 'Compare the recovered map with the one used to simulate it.', physics: ['Simulated data show what a map of this degree needs: precision and coverage.'], more: 'phasecurve' },
  exomoon: {
    see: 'Twelve transits of a planet with a moon: the planet wobbles around the shared centre of mass, so its transits come early or late, and the moon adds its own small dip.',
    try: [{ label: '3D view', does: 'Watch the moon orbit the planet as it crosses.', run: () => camera('free') }],
    read: 'Moon detections need both effects: timing variations from the wobble and the moon\'s own transit.',
    physics: ['The barycentre moves on the planet\'s orbit; the planet and moon move around it.'],
    more: 'exomoon',
  },
  nbody: {
    see: 'A hot Jupiter with an unseen companion near the 2:1 resonance: their mutual pulls make the transits drift early and late in a slow cycle.',
    try: [{ label: 'O − C', does: 'The transit-timing variations against epoch.', run: (api) => tab(api, 'timing') }, { label: 'Companion search', does: 'A grid of possible companions that would produce these variations.', run: (api) => tab(api, 'system') }],
    read: 'The TTV period ("super-period") locates the companion near a resonance; the amplitude scales with its mass.',
    physics: ['Near a period ratio j:j−1 the perturbations add up orbit after orbit.', 'An N-body integration replaces Kepler orbits when planets pull on each other.'],
    more: 'nbody',
  },
};

EXPLAIN.toy1873 = EXPLAIN.toi1873;   // the old id of the three-planet example

/** The card for an example, built with the page's h(); null when there is nothing for it. */
export function explainCard(id, { api, h, onClose } = {}) {
  const E = EXPLAIN[id]; if (!E || !h) return null;
  const msg = h('p', { class: 'ex-msg', role: 'status' });
  const buttons = (E.try || []).map((t) => h('button', { class: 'chip small', title: t.does, onclick: async () => { msg.textContent = t.does; try { await t.run(api); } catch (err) { msg.textContent = String((err && err.message) || err); } } }, t.label));
  return h('section', { class: 'ex-explain', 'aria-label': 'About this example' },
    h('div', { class: 'ex-head' }, h('b', {}, 'About this example'), onClose ? h('button', { class: 'ex-x', 'aria-label': 'Close', onclick: onClose }, '✕') : null),
    h('p', { class: 'ex-see' }, E.see),
    buttons.length ? h('div', { class: 'ex-try' }, h('span', { class: 'ex-k' }, 'Try'), ...buttons) : null, msg,
    h('details', { class: 'ex-more' }, h('summary', {}, 'How to read it'), h('p', {}, E.read), h('ul', {}, ...(E.physics || []).map((x) => h('li', {}, x))),
      E.more ? h('a', { href: `../methods/#${E.more}`, target: '_blank', rel: 'noopener' }, 'The method, with its checks →') : null));
}
