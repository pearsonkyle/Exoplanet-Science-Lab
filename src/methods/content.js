// The Methods document: one source for the page (methods/, src/methods/main.js) and for docs/METHODS.md
// (tools/build_methods_md.mjs). Pure data, importable from Node.
//
// Rules for editing
//   - Describe the code as it is. Every statement here was taken from the source file named in `code`; when the code
//     changes, change the text in the same commit.
//   - A number comes with its check. `checks` entries are either { topic, rows } (text and numbers are then read from
//     src/validation/topics.js, which test/validation.test.mjs ties to the stored test output) or a sentence that names
//     the test that prints the number.
//   - `limits` are the assumptions and known problems, in plain words; take them from HANDOFF.md "Known issues".
//   - `refs` are keys of src/validation/refs.js (add and verify the entry there first).
//
// Inline markup (both renderers): $tex$ (the subset of src/methods/tex.js), {{code}}, **bold**, [text](url),
// [@key] for a citation, and (v:anchor) as a link target for an anchor of the Validation tab (src/validation/anchors.js maps it).
// Blocks: a string is a paragraph; { eq } a displayed equation; { ul } a list; { h } a sub-heading;
// { table: { head, rows } } a table; { stub } a placeholder.

const r = String.raw;

export const TITLE = 'Methods';
export const LEAD = 'What Exoplanet Science Lab computes and how: the equations as implemented, the parameters and their default priors, the numerical method with its measured accuracy, the assumptions and known limits, and the references. Written to be cited and adapted in the methods section of a paper.';

export const INTRO = [
  r`Each section below describes one technique as the source code implements it; the file is named under the heading. Accuracy statements link to the test or the [Validation](v:summary) entry that produces the number. Where something is not modelled, was not tested, or disagrees with a published value, the section says so under "Assumptions and limits".`,
  r`Notation: $R_\star$, $M_\star$ stellar radius and mass; $k = R_p/R_\star$; $a/R_\star$ scaled semi-major axis; $i$ inclination; $P$ period; $T_0$ mid-transit time; $e$, $\omega$ eccentricity and argument of periastron; $\nu$, $E$, $M$ true, eccentric and mean anomaly; $\mu = \sqrt{1 - r^2}$ with $r$ the projected distance from the centre of the stellar disc in stellar radii.`,
];

export const SECTIONS = [
  // =================================================================================================================
  {
    id: 'conventions', title: 'Time standards and conventions', code: ['src/core/kepler.js', 'src/core/data.js', 'src/core/fits.js', 'src/core/observability.js', 'src/core/derive.js'],
    body: [
      { h: 'Geometry' },
      r`The sky plane is $X, Y$ in units of the stellar radius and $+Z$ points to the observer. With $u = \omega + \nu$ the planet is at`,
      { eq: r`X = -r\cos u, \qquad Y = -r \sin u \cos i, \qquad Z = r \sin u \sin i, \qquad r = \frac{a}{R_\star}\,(1 - e\cos E)` },
      r`so the planet is in front of the star when $Z > 0$. Mid-transit $T_0$ is inferior conjunction, $\omega + \nu = \pi/2$; mid-eclipse is superior conjunction, $\omega + \nu = -\pi/2$. These are not the times of smallest projected separation on an inclined eccentric orbit (see [Kepler solver and orbits](#orbits)). Radial velocities are positive when the star recedes. $\omega$ is the same number as the $\omega$ of radvel and pyaneti ([Validation: sign and angle conventions](v:rv-conventions)).`,
      { h: 'Times in the analyzer' },
      r`Times are used as given. The reader ({{parseLightCurve}}) recognises the zero point of the time column from a header or from the size of the numbers (JD; MJD = JD − 2400000.5; RJD = JD − 2400000; BTJD = JD − 2457000; BKJD = JD − 2454833) and adds it; it does **not** convert between time scales (UTC, TT, TDB) or between geocentric, heliocentric and barycentric times. Inside a fit, times are measured from an integer reference ({{data.tRef}}, the floor of the first time) so that Julian dates keep their precision in double arithmetic; results are reported as absolute times again. Catalogue epochs are taken as the catalogue lists them and assumed to be $\mathrm{BJD}_\mathrm{TDB}$; a different stated time system is flagged, not converted.`,
      { h: 'Times from image headers' },
      r`The photometry page converts the UTC mid-exposure time of each frame to $\mathrm{BJD}_\mathrm{TDB}$ [@eastman2010] when the target coordinates are known ({{utcToBjdTdb}}):`,
      { eq: r`\mathrm{BJD}_\mathrm{TDB} = \mathrm{JD}_\mathrm{UTC} + \frac{\Delta\mathrm{AT} + 32.184\,\mathrm{s} + 0.001657\,\mathrm{s}\,\sin g + 0.000014\,\mathrm{s}\,\sin 2g}{86400\,\mathrm{s}} + \frac{\mathbf{r}_\oplus \cdot \hat{n}}{c}` },
      r`with $\Delta\mathrm{AT}$ = TAI − UTC from a leap-second table (1972 to 2017-01-01, 37 s held afterwards), $g = 357.53^\circ + 0.9856003^\circ\,(\mathrm{JD} - 2451545.0)$, $\hat{n}$ the unit vector of the target's ICRS coordinates, and $\mathbf{r}_\oplus$ the Earth's barycentric position: the low-precision solar theory of [@meeus1998] (chapter 25) for the heliocentric Earth plus the Sun's offset from the barycentre due to Jupiter, Saturn, Uranus and Neptune from the Keplerian elements of [@standish]. The mid-exposure time is the header's start time plus half the exposure, unless the keyword or its comment says it is already a mid or end time; TAI, GPS, TT and TDB header times are first converted to UTC.`,
      r`The planner uses a second, simpler conversion ({{jdUtcToBjdTdb}} in {{observability.js}}): the light time to the Sun's centre instead of the barycentre, and TDB = TT.`,
      { h: 'Constants' },
      r`{{src/core/derive.js}}: $R_\odot$ = 6.957e8 m, $R_\mathrm{Jup}$ = 7.1492e7 m, $R_\oplus$ = 6.3781e6 m, au = 1.495978707e11 m, $GM_\odot$ = 1.32712440018e20 m³ s⁻², $M_\mathrm{Jup}/M_\odot$ = 9.5459426398e-4, $G$ = 6.6743e-11 (SI), $T_{\mathrm{eff},\odot}$ = 5772 K, day = 86400 s.`,
    ],
    checks: [
      { topic: 'photometry', rows: [4] },
      { topic: 'planner', rows: [2] },
      r`Sign and $\omega$ convention against radvel, pyaneti and a reference obtained by differentiating the orbit in 30-digit arithmetic: {{node test/validation.test.mjs}} ("sign", "omega").`,
    ],
    limits: [
      r`No conversion between time standards in the analyzer, the Timing tab, the catalogue or the planner's input: mixing $\mathrm{BJD}_\mathrm{TDB}$ with $\mathrm{JD}_\mathrm{UTC}$ or HJD moves a mid-transit time by up to about 8 minutes (heliocentric correction) plus 69 s (TDB − UTC in 2017 and later). The user must supply one consistent time standard.`,
      r`The header conversion leaves out the observatory's position on the Earth (up to 21 ms), the Shapiro delay, parallax and proper motion. HJD header times are passed through unconverted. The leap-second table ends in 2017.`,
      r`The project has three separate implementations of Sun position and time conversion ({{fits.js}}, {{astro.js}}, {{observability.js}}) with different accuracy; they have not been merged.`,
    ],
    refs: ['eastman2010', 'meeus1998', 'standish', 'astropy2022'],
  },

  // =================================================================================================================
  {
    id: 'transit', title: 'Transit model and limb darkening', code: ['src/core/transit.js', 'src/core/limbdark.js', 'src/core/ldest.js', 'src/core/ldspec.js', 'tools/build_ld_table.py', 'tools/build_ld_spectral.py'],
    body: [
      { h: 'Limb-darkening laws' },
      r`Every law is mapped onto the four-coefficient law of [@claret2000],`,
      { eq: r`\frac{I(\mu)}{I(1)} = 1 - \sum_{n=1}^{4} a_n \left(1 - \mu^{n/2}\right), \qquad \mu = \sqrt{1 - r^2}` },
      r`of which the others are exact special cases: linear $I = 1 - u(1-\mu)$ is $a_2 = u$; quadratic $I = 1 - u_1(1-\mu) - u_2(1-\mu)^2$ is $a_2 = u_1 + 2u_2$, $a_4 = -u_2$; the $(q_1, q_2)$ form of [@kipping2013] is the quadratic law with $u_1 = 2\sqrt{q_1}\,q_2$, $u_2 = \sqrt{q_1}\,(1 - 2q_2)$; the square-root law $I = 1 - c(1-\mu) - d(1-\sqrt{\mu})$ is $a_1 = d$, $a_2 = c$. A profile that is negative anywhere, brightens toward the limb, or has non-positive total flux is outside the prior: the likelihood rejects it (tested on 25 values of $\mu$).`,
      { h: 'Flux' },
      r`With $F(r) = \int_0^r I(r')\,r'\,dr'$, which is in closed form for this law, the vector field $F(r)/r^2\,(x, y)$ has divergence $I(r)$, so the flux behind the planet's disc is a line integral around the boundary of the occulted region (Green's theorem):`,
      { eq: r`\frac{\Delta F}{F} = \frac{1}{2\pi F(1)} \oint \frac{F(r)}{r^2}\,(x\,dy - y\,dx), \qquad F(1) = \frac{1 - \sum a_n}{2} + \frac{a_1}{2.5} + \frac{a_2}{3} + \frac{a_3}{3.5} + \frac{a_4}{4}` },
      r`The boundary is an arc of the planet's limb, parametrised by the angle $\varphi$ about the planet's centre, plus, during ingress and egress, an arc of the stellar limb where the integrand is the constant $F(1)$ and the contribution is analytic. With the planet's centre at projected distance $z$ and radius $p$, $r^2 = z^2 + p^2 + 2zp\cos\varphi$ along the planet's limb. When the planet is wholly on the disc, further than 0.02 stellar radii from the limb and not covering the centre, the integrand is smooth and periodic and a 12-node midpoint rule is used. Otherwise the arc is integrated with 20 Gauss-Legendre nodes after the substitution $\varphi = \varphi_A + (\pi - \varphi_A)u^2$, which removes the square-root branch point where the arc meets the stellar limb. Near the stellar centre ($r^2 < 10^{-3}$) $F(r)/r^2$ is evaluated by a series. A uniform disc uses the closed-form overlap area of two circles. The model flux is $1 - \Delta F/F$ when the planet is in front ($Z > 0$) and 1 otherwise.`,
      { h: 'Where the coefficients come from' },
      { ul: [
        r`**Free parameters**, sampled with the other parameters.`,
        r`**A model-atmosphere table** ({{src/data/ld_table.js}}, built by {{tools/build_ld_table.py}}): PHOENIX-ACES specific intensities [@husser2013], obtained through the file list and cache of LDTK [@parviainen2015ldtk], integrated with photon weighting over 37 passbands for $T_\mathrm{eff}$ = 2300 to 8000 K, $\log g$ = 4.0, 4.5, 5.0 (5.5 at or below 4000 K) and [Fe/H] = −0.5, 0, +0.5. Measured response curves (those shipped with pylightcurve) are used for TESS, Kepler, CHEOPS, Johnson UBV, Cousins RI, SDSS ugriz and 2MASS JHKs; the remaining bands are boxcars. The stellar limb is placed at the steepest gradient of the model intensity and the radius rescaled to it, as in ExoTETHyS [@morello2020]; the four-coefficient law is fitted by least squares for $\mu \ge 0.1$, and refitted under constraints when the unconstrained fit is not monotonic or goes negative. The other laws are fitted to that profile (constrained to physical coefficients). The application interpolates trilinearly in $T_\mathrm{eff}$, $\log g$ and [Fe/H] and clamps, with a flag, outside the grid.`,
        r`**Any wavelength range** ({{src/core/ldspec.js}}, table built by {{tools/build_ld_spectral.py}}): the same models in 357 bins from 200 to 5500 nm, stored as a mean plus 40 principal components. The profile of a band is the flux- and response-weighted mean of the bins' profiles, $I_\mathrm{band}(\mu) = \sum_b w_b F_b I_b(\mu) / \sum_b w_b F_b$, then constrained to be physical.`,
        r`**A grey atmosphere** (fallback when no table applies): $I(\mu) \propto \int_0^\infty B_\lambda[T(\mu x)]\,e^{-x}\,dx$ with $T^4 = \frac{3}{4}T_\mathrm{eff}^4\,[\tau + q(\tau)]$, $q(\tau) = 0.7104 - 0.1331\,e^{-3.4488\tau}$, averaged over nine wavelengths of the band with photon weighting; the law is then fitted by least squares on 60 values of $\mu$ from 0.02 to 1. It depends on $T_\mathrm{eff}$ and wavelength only.`,
        r`**Following the star** in a fit: $T_\mathrm{eff}$ (and [Fe/H] when a table is in use) are sampled with priors at their measured uncertainties, and the coefficients are computed from each sample ({{makeLDTie}}: tabulated once per fit on 17 × 7 knots plus every table node inside the prior, bilinear in between). The coefficients are then confined to the family a star of that kind can produce.`,
      ] },
    ],
    checks: [
      r`Flux against scipy adaptive quadrature of the area integral on an orbit computed in 30-digit arithmetic, 41 light curves (uniform, linear, quadratic and four-coefficient laws; $k$ from 0.01 to 0.3; grazing; $e$ up to 0.93): worst error 3.1e-11, tolerance 1e-10; at the kernel's branch points (contacts, centre) 1.4e-10. Printed by {{node test/validation.test.mjs}}, recomputed in the [Validation tab](v:transit).`,
      r`Kernel alone against scipy quadrature over 680 geometries ($k$ from 0.01 to 1.2) and five profiles: {{node test/kernel.test.mjs}}.`,
      { topic: 'limbdark', rows: [0, 1, 2, 3, 4] },
      { topic: 'exotic', rows: [0] },
      { topic: 'basics', rows: [0] },
    ],
    limits: [
      r`The flux is accurate to about 1e-10, not to rounding error; the closed form of [@agol2020] for the quadratic law is more accurate and faster. Every law is integrated numerically here.`,
      r`Not modelled: star spots and faculae, stellar oblateness and gravity darkening, planetary oblateness, rings, refraction, the planet's night-side emission during transit (unless the phase-curve model is on). Dilution by other stars in the aperture is an optional term of the likelihood ([The likelihood](#likelihood)); the bundled TESS light curve of HD 80606 is diluted by HD 80607, and its stored example result is fitted without that term.`,
      r`One limb-darkening law and band for all light curves in a fit (no multi-band fits).`,
      r`The comparison with ExoTETHyS tests the processing, the grid and the interpolation, not the atmosphere physics: both start from the same PHOENIX files. PHOENIX and ATLAS models differ by 0.0125 rms in $I(\mu)$ on average, which is larger than every processing error quoted here. The boxcar and JWST bands have no external reference. Below $\mu = 0.1$ the profile is an extrapolation. Stars outside the grid are clamped to its edge. Beyond 5.5 µm there is no table.`,
    ],
    refs: ['claret2000', 'kipping2013', 'husser2013', 'parviainen2015ldtk', 'morello2020', 'agol2020', 'tsiaras2016'],
  },

  // =================================================================================================================
  {
    id: 'exposure', title: 'Exposure averaging', code: ['src/core/model.js (autoSupersample)', 'src/core/transit.js (transitModel)', 'src/core/session.js'],
    body: [
      r`A detector integrates the flux over each exposure. When an exposure time $\Delta t$ is given, the model at time $t_i$ is the mean of $n$ evaluations at the centres of $n$ equal slices of the exposure:`,
      { eq: r`\bar{f}(t_i) = \frac{1}{n} \sum_{j=0}^{n-1} f\!\left(t_i + \left(j - \frac{n-1}{2}\right)\frac{\Delta t}{n}\right)` },
      r`With several planets the product of the planets' fluxes is averaged, not the product of the averages. The number of sub-samples is chosen automatically from the ingress duration $\tau = (T_{14} - T_{23})/2$ (closed-form durations, at least 1e-4 d) and the depth $\delta = k^2$:`,
      { eq: r`n = \left\lceil \frac{\Delta t}{\tau} \sqrt{\frac{\delta}{6 \times 10^{-6}}} \right\rceil, \quad \text{made odd, at most 41; } n = 1 \text{ when the expression is } \le 1` },
      r`This follows from the error of the midpoint rule, about (curvature) × $(\Delta t/n)^2/24$ with a curvature of order $4\delta/\tau^2$ during ingress, for a target of 1 ppm. Each epoch of a light curve may carry its own exposure time and then gets its own $n$.`,
    ],
    checks: [
      r`Against the mean of 4001 evaluations of the exact quadratic-law flux ({{node test/validation.test.mjs}}): 30 min exposures of a hot Jupiter (ingress 21 min), automatic $n$ = 41: 5.0e-7; 2 min exposures of the same planet, $n$ = 5: 6.9e-7; 30 min exposures of a small planet on a 1 d orbit (ingress 1.6 min), $n$ = 41: 1.3e-7; with 101 sub-samples the three cases give 7.4e-8, 1.7e-9 and 1.3e-8. See [Validation: exposure averaging](v:transit-exposure).`,
    ],
    limits: [
      r`The count is capped at 41, so the residual grows for exposures much longer than ingress; the analyzer offers no manual setting; a count can be given by hand only through the programming interface ({{spec.supersample}} and {{segments[s].supersample}} of {{buildProblem}}).`,
      r`The exposure is assumed to be a uniform window centred on the time stamp, with no dead time and no read-out weighting. The exposure time is whatever the user or the file header supplies.`,
      r`The count is chosen once, from the parameter values at the start of a fit, not re-evaluated for each sample. Because a session saved after a fit holds the fitted values, re-running a stored session can choose a different count: {{hd80606-tess.json}} re-runs to 12,813 likelihood calls instead of the stored 12,837 (0.004σ in the result).`,
    ],
    refs: ['winn2010'],
  },

  // =================================================================================================================
  {
    id: 'orbits', title: 'Kepler solver and orbits', code: ['src/core/kepler.js'],
    body: [
      r`The mean anomaly is $M(t) = M_0 + 2\pi (t - T_0)/P$, with $M_0$ the mean anomaly at inferior conjunction: $\nu_c = \pi/2 - \omega$, $E_c = 2\arctan\!\left[\sqrt{(1-e)/(1+e)}\,\tan(\nu_c/2)\right]$, $M_0 = E_c - e\sin E_c$. Kepler's equation $E - e\sin E = M$ is solved from the starting value $E_0 = M + 0.85\,e\,\mathrm{sgn}(\sin M)$ [@danby1987] with the update`,
      { eq: r`\delta_1 = -\frac{f}{f'}, \quad \delta_2 = -\frac{f}{f' + \frac{1}{2}\delta_1 f''}, \quad \delta_3 = -\frac{f}{f' + \frac{1}{2}\delta_2 f'' + \frac{1}{6}\delta_2^2 f'''}, \quad E \leftarrow E + \delta_3` },
      r`where $f = E - e\sin E - M$, iterated until $|\delta_3| < 10^{-15}\max(1, |E|)$ (at most 30 iterations; two to four are needed). The true anomaly is $\nu = 2\,\mathrm{atan2}\!\left(\sqrt{1+e}\,\sin\frac{E}{2},\ \sqrt{1-e}\,\cos\frac{E}{2}\right)$. Eccentricities are limited to $e \le 0.999$. Circular orbits skip the solver.`,
      r`Event times follow from the anomaly of the event: periastron $\nu = 0$, mid-eclipse $\omega + \nu = -\pi/2$. Durations ($T_{14}$, $T_{23}$ and the eclipse equivalents $E_{14}$, $E_{23}$) are found numerically: the time at which the projected separation equals $1 \pm k$ is bracketed from the conjunction and refined by 60 bisections, on each side. The closed-form durations of [@winn2010] (eqs. 14 to 16) are used only to choose the exposure sub-sampling and for catalogue estimates. The impact parameter is $b = (a/R_\star)\cos i\,(1 - e^2)/(1 + e\sin\omega)$.`,
    ],
    checks: [
      r`{{node test/validation.test.mjs}}, against 30-digit arithmetic: true anomaly within 2.4e-15 rad for $e$ = 0.05 to 0.999 (residual of the equation 4.4e-16); periastron and eclipse times of 21 orbits within 2.3e-10 s; $T_{14}$, $T_{23}$, $E_{14}$, $E_{23}$ of 10 orbits within 1.3e-10 s. The closed-form duration is exact for circular orbits and up to 0.91% short otherwise. See [Validation: the orbit and its timing](v:orbit).`,
    ],
    limits: [
      r`**One published number is not reproduced.** For HD 80606 b this code gives an eclipse duration $E_{14}$ = 0.08337 d, equal to root finding on the 30-digit orbit (0.08337 d); [@pearson2022] list 0.0717 d. The transit duration agrees (0.4985 d against 0.499 d). No method tried reproduces the published eclipse duration, and its origin is unknown.`,
      r`For HD 80606 b the time of smallest projected separation is 11.4 min before conjunction. A mid-time measured from the symmetry of a light curve is closer to the midpoint of the contacts than to conjunction; the three should not be mixed for inclined eccentric orbits ([Validation](v:orbit-midtransit)).`,
      r`Orbits are fixed Keplerian ellipses: no apsidal or nodal precession, no light-travel-time correction of transit times, no relativistic terms. Mutual perturbations need the [N-body](#nbody) option.`,
    ],
    refs: ['danby1987', 'winn2010', 'pearson2022'],
  },

  // =================================================================================================================
  {
    id: 'rv', title: 'Radial velocities', code: ['src/core/rv.js', 'src/core/model.js'],
    body: [
      r`The velocity of the star in dataset $d$ at time $t$ is`,
      { eq: r`v_d(t) = \gamma_d + \sum_p K_p \left[\cos(\omega_p + \nu_p(t)) + e_p \cos\omega_p\right] + c_1 (t - t_\mathrm{ref}) + c_2 (t - t_\mathrm{ref})^2` },
      { eq: r`K = \left(\frac{2\pi G}{P}\right)^{1/3} \frac{M_p \sin i}{(M_\star + M_p)^{2/3}\sqrt{1 - e^2}}` },
      r`with the same orbit as the transit model, so the star recedes before mid-transit and approaches after it. $t_\mathrm{ref}$ is the earliest velocity. A planet's amplitude is computed from its mass (the sampled parameter is $M_p$ in Jupiter masses), or $K$ can be given directly. $\gamma_d$ is the zero point of instrument $d$ and is integrated out analytically (see [The likelihood](#likelihood)); each instrument also has a jitter $s_d$ added in quadrature to its uncertainties. $c_1$ and $c_2$ (keys {{rvlin}}, {{rvquad}}) are shared by all instruments. The inverse (mass from $K$) is solved by fixed-point iteration.`,
      { h: 'Where the semi-amplitude comes from' },
      r`Momentum about the barycentre: the star and the planet move on similar ellipses about their common centre of mass, $M_\star a_\star = M_p a_p$, so the star's semi-major axis is a fraction of the relative orbit's $a = a_\star + a_p$:`,
      { eq: r`a_\star = a\,\frac{M_p}{M_\star + M_p}` },
      r`A Keplerian orbit seen at inclination $i$ moves the star along the line of sight at $v_r = K\left[\cos(\omega + \nu) + e\cos\omega\right]$, with $K$ the orbital speed scale of the star times $\sin i$ (from $r = a_\star(1 - e^2)/(1 + e\cos\nu)$ and the constant specific angular momentum $r^2\dot\nu = 2\pi a_\star^2\sqrt{1 - e^2}/P$):`,
      { eq: r`K = \frac{2\pi}{P}\,\frac{a_\star \sin i}{\sqrt{1 - e^2}}` },
      r`Kepler's third law for the relative orbit gives $a$ from the period and the total mass:`,
      { eq: r`a^3 = \frac{G\,(M_\star + M_p)\,P^2}{4\pi^2}` },
      r`Putting the three together, $\frac{2\pi}{P}\left[\frac{G (M_\star + M_p) P^2}{4\pi^2}\right]^{1/3} = \left[\frac{2\pi G (M_\star + M_p)}{P}\right]^{1/3}$, and multiplying by $M_p/(M_\star + M_p)$ leaves $(M_\star + M_p)^{1/3 - 1} = (M_\star + M_p)^{-2/3}$: the equation above. {{src/core/rv.js}} \`semiAmplitude\` evaluates it with the IAU nominal $G M_\odot$ and the Jupiter-to-Sun mass ratio; \`massFromK\` inverts it by iteration, because $M_p$ appears on both sides.`,
    ],
    checks: [
      r`Velocity curves of 5 orbits up to $e$ = 0.93 against 30-digit arithmetic: worst 1.3e-14 $K$; $K$ from the masses against the two-body formula with IAU nominal constants: 3.1e-8 relative ({{node test/validation.test.mjs}}; [Validation: the star's velocity](v:rv)).`,
      { topic: 'exotic', rows: [4] },
      { topic: 'relations', rows: [3] },
    ],
    limits: [
      r`The reflex motion uses the two-body factor $M_p/(M_\star + M_p)$. EXOTIC scales by $M_p/M_\star$, so for the same velocities the mass from this code is higher by $M_p/M_\star$ (0.38% for HD 80606 b).`,
      r`Not modelled: stellar activity (no Gaussian process or activity indicators in the likelihood), light-travel time, instrument-specific trends. The jitter is white. The Rossiter-McLaughlin anomaly is optional ([Rossiter-McLaughlin effect](#rm)).`,
      r`Stellar mass (and radius, when $a/R_\star$ follows from Kepler's law) are held at their input values unless made free; the uncertainty of a planet mass then does not include that of the stellar mass, and the Results tab says so.`,
      r`For the HD 80606 velocities $\chi^2$ = 1555 for 264 points with the jitters at zero (stored result {{public/examples/results/hd80606-rv.json}}), so formal uncertainties from that fit are too small unless the jitters are freed.`,
    ],
    refs: ['fulton2018', 'pearson2022', 'zellem2020'],
  },

  // =================================================================================================================
  {
    id: 'rm', title: 'Rossiter-McLaughlin effect', code: ['src/core/rm.js', 'src/core/model.js (buildProblem)'],
    body: [
      r`When {{vsini}} is set, every planet in front of the star adds to the velocities the shift of the flux-weighted mean velocity of the light that is not covered. The star rotates as a solid body; in the sky frame of the orbit (planet moving toward $+X$ across the disc, the orbit normal projected onto $+Y$, the chord at $Y = -b$) a point of the disc recedes at`,
      { eq: r`v(x, y) = v\sin i_\star\,(x\cos\lambda - y\sin\lambda)` },
      r`with $\lambda$ the sky-projected obliquity, the angle from the projected orbit normal to the projected stellar spin (ellc's convention [@maxted2016]; $\lambda = 0$ aligned, $180^\circ$ retrograde). With the Claret-law intensity $I$ of the fit's limb darkening (or another law given for the spectrograph's band through {{spec.rm}}) the anomaly is`,
      { eq: r`\Delta v = -\frac{\int_\mathrm{occ} I\,v\,dA}{F_\star - \int_\mathrm{occ} I\,dA}` },
      r`the quantity Ohta et al. expand for a small planet [@ohta2005]. The integral over the occulted area is not approximated: the first moment $\int_\mathrm{occ} I\,x'\,dA$ along the line from the star's centre to the planet's is a line integral of $F(r) = \int_0^r I r\,dr$ (the closed form of the transit model) around the occulted region, an arc of the planet's limb with 40 Gauss-Legendre nodes plus, in ingress and egress, an arc of the stellar limb; the moment perpendicular to that line vanishes by symmetry. The blocked flux is the transit model's. Each planet has its own $\lambda$ (key {{lambda@c}}, falling back to {{lambda}}); the star's {{vsini}} is in km/s.`,
      { h: 'What a Gaussian fit to the CCF measures (option)' },
      r`With {{spec.rm.method}} = 'ccf' the anomaly is instead the shift of the centre of a Gaussian fitted to the cross-correlation function. Every surface element contributes a Gaussian line of dispersion $\beta_p$ (instrumental and thermal, {{beta}}; macroturbulence {{zeta}} adds $\zeta^2/2$ to $\beta_p^2$, a Gaussian approximation), the occulted light is a fraction $f$ with mean velocity $v_p$ (both from the integrals above), and to first order in $f$ the linearised least-squares fit moves by`,
      { eq: r`\Delta v = -\frac{f}{1 - f}\,g\,v_p\left(\frac{2\beta_0^2}{\beta_0^2 + \beta_p^2}\right)^{3/2}\exp\left(-\frac{v_p^2}{2(\beta_0^2 + \beta_p^2)}\right)` },
      r`[@hirano2010; @boue2013], with $\beta_0$ the dispersion of the out-of-transit CCF (measured, {{beta0}}, or that of the Gaussian that best fits the modelled rotation-broadened profile) and $g$ the correction for a profile that is not Gaussian (its area over the fitted Gaussian's, and the curvature term the out-of-transit residual leaves in the Hessian): 1.000 for $v\sin i/\beta_p$ = 0.57, 0.974 for 4. Both are tabulated against $v\sin i/\beta_p$ once per fit.`,
      { h: 'Exposures, limb darkening, priors (options)' },
      r`Each velocity dataset may carry its exposure ({{exposure_min}}; or {{spec.rm.exptime}} for all), over which the anomaly is averaged with {{supersample}} sub-samples (default 5); the Keplerian part is not averaged. The limb darkening of the anomaly is the spectrograph's band when {{spec.rm.ld}} is given. A catalogue $v\sin i_\star$ enters as a normal prior truncated at zero (vsiniPrior). The true obliquity follows from $\cos\psi = \cos i_\star\cos i + \sin i_\star\sin i\cos\lambda$ when $i_\star$ is known.`,
    ],
    checks: [
      r`Against a brute-force pixel sum (4000 × 4000 pixels over the planet's disc, star flux by scipy quadrature; {{test/make_rm_reference.py}}): 160 cases (uniform, quadratic and four-coefficient laws, $k$ = 0.01 to 0.2, inside the disc, on the limb, in ingress and egress, four obliquities), largest difference 1.0e-7 $v\sin i$ or 8.9 ppm of the anomaly, every case within the pixel sum's own error ({{node test/rm.test.mjs}}).`,
      r`Uniform star with the planet on the disc against $\Delta v = -v\sin i\,x_s k^2/(1 - k^2)$: 3.5e-18. The small-planet limit of Ohta et al. [@ohta2005]: relative difference 8.0e-4, 8.8e-5 and 7.9e-6 at $k$ = 0.03, 0.01, 0.003, falling as $k^2$.`,
      r`CCF form against a brute-force disc integration (3000 × 3000 pixels of the star, 700 × 700 of the planet, each a Gaussian line, binned in velocity) with Gaussians fitted by scipy to the out-of-transit and in-transit profiles ({{test/make_rm_ccf_reference.py}}; 120 cases: $v\sin i$ = 1.7 to 12 km/s with $\beta$ = 3 km/s, and 5 km/s with $\beta$ = 2.5, $\zeta$ = 4 km/s; $\lambda$ = 0°, 40°; $k$ = 0.05, 0.1; six positions): $\beta_0$ within 1.7e-4, the anomaly within 0.14% of its largest value at $v\sin i/\beta$ = 0.57, 0.38% at 1, 0.93% at 2, 1.48% at 4. The first moment misses the fitted centre by 2.6%, 7.4%, 21% and 35% at those ratios. Exposure averaging (20 min, 7 sub-samples) is within 0.051 m/s of a 4001-point average where the exposure changes the anomaly by 4.05 m/s ({{node test/rmccf.test.mjs}}).`,
      r`HD 80606 b from the bundled velocities (SOPHIE 2009 February 14, 48 points of which 28 in transit; HIRES 2009 June 5, 12 and 8), orbit of the stored joint fit with $k$ = 0.1001 (Winn et al. 2009; the TESS curve is diluted by HD 80607), limb darkening of 390 to 690 nm: $v\sin i$ = 1.47 +0.22 −0.17 km/s and $\lambda$ = 58 +16 −12° with the orbit fixed, 1.49 +0.22 −0.17 km/s and 57 +17 −12° with $P$, $T_0$, $e$, $\omega$, $M_p$ free under the joint posterior, 1.47 and 57° with the CCF form ($\beta$ = 3 km/s) and 10-minute exposures. Hébrard et al. 2010 give $\lambda$ = 42 ± 8° and $v\sin i$ ≈ 1.7 km/s from the full transit of 2010 January, which is not in this file (1.1σ and 0.6σ away); Winn et al. 2009 give 50 +61 −36° from the HIRES night ({{node test/hd80606rm.test.mjs}}).`,
      r`Whole curves from the orbit against ellc's flux-weighted velocities [@maxted2016] ({{test/make_rm_ellc_reference.py}}; $a/R_\star$ = 10, $k$ = 0.1, $v\sin i$ = 5 km/s, $\lambda$ = 0°, 30°, −45°, 120° at $i$ = 87° and 89.5°): at most 0.026 m/s of 23 to 39 m/s; the opposite sign of $\lambda$ misses by at least 5.3 m/s. A fit to 70 simulated in-transit velocities (2 m/s) returns $v\sin i$ = 4.97 ± 0.09 km/s (5) and $\lambda$ = 30.0 ± 1.0° (30).`,
    ],
    limits: [
      r`By default the anomaly is the first moment of the uncovered light, which is what iodine-cell velocities approximate; the CCF form is an option for the whole fit (not per dataset), first order in the occulted fraction, with Gaussian local lines and a Gaussian macroturbulence (Hirano et al. 2011's radial-tangential profile is not implemented), and its $\beta_0$ depends on the velocity window of the fit (here $\pm(v\sin i + 6\beta_p)$) unless the measured one is given.`,
      r`Solid-body rotation, no differential rotation or convective blueshift; the planet is dark (its own light and a moon are not in the anomaly); planets are added independently (no overlap of two planets on the disc).`,
      r`With N-body dynamics the anomaly uses the Keplerian sky positions. Exposure averaging applies to the anomaly only.`,
    ],
    refs: ['ohta2005', 'maxted2016', 'hirano2010', 'boue2013'],
  },

  // =================================================================================================================
  {
    id: 'likelihood', title: 'The likelihood', code: ['src/core/model.js (buildProblem)', 'src/core/priors.js', 'src/main.js (defaultPrior)'],
    body: [
      r`There is one likelihood, {{buildProblem}}. It is the sum of independent Gaussian terms for the light curve(s), the velocities and the event times, each with its normalisation, so that the evidence is a normalised marginal likelihood.`,
      { h: 'Light curves' },
      r`A dataset holds one or more epochs $s$ (nights, visits, orbits). The model for point $i$ of epoch $s$ is $a_s\,m_i$ with`,
      { eq: r`m_i = e^{\kappa_s X_i} \prod_p f_p(t_i)` },
      r`where $f_p$ is planet $p$'s (exposure-averaged) transit flux, $X_i$ the airmass and $\kappa_s$ the airmass coefficient of the epoch (absent without an airmass column). The normalisation $a_s$ enters linearly and is integrated out analytically with a uniform prior $a_s \sim U(0, 2)$ instead of being sampled:`,
      { eq: r`\ln L_s = -\frac{1}{2}\chi^2_{s,\min} + \frac{1}{2}\ln\frac{2\pi}{\sum_i m_i^2/\sigma_i^2} - \ln 2 - \frac{1}{2}\sum_i \ln(2\pi\sigma_i^2), \qquad \chi^2_{s,\min} = \sum_i \frac{d_i^2}{\sigma_i^2} - \frac{\left(\sum_i d_i m_i/\sigma_i^2\right)^2}{\sum_i m_i^2/\sigma_i^2}` },
      r`The Gaussian integral over $a_s$ is taken over the whole real line, which is exact to the extent that the conditional posterior of $a_s$ lies well inside (0, 2); the reader divides fluxes by their median when it is more than 2% from 1 (and always for magnitudes). The conditional best value $\hat{a}_s = \sum d_i m_i/\sigma_i^2 \,/ \sum m_i^2/\sigma_i^2$ is the weighted least-squares amplitude and is what the plots show.`,
      r`{{buildProblem}} also accepts linear regressors $x_k$ per point (a slope in time, a centroid): the baseline of epoch $s$ becomes $e^{\kappa_s X}(a_s + \sum_k c_{sk} x_k)$ and all $p$ linear coefficients are integrated out together, with $c_{sk} \sim U(-1, 1)$:`,
      { eq: r`\ln L_s = -\frac{1}{2}\chi^2_{s,\min} + \frac{1}{2}\left(p \ln 2\pi - \ln\det A\right) - p\ln 2 - \frac{1}{2}\sum_i \ln(2\pi\sigma_i^2), \qquad A = G^{T} W G` },
      r`where the columns of $G$ are the model times $(1, x_1, \ldots)$. A session stores the detector columns and the detrending choice ({{docs/FORMAT.md}}), and {{specFromSession}} rebuilds the regressors (or the kernel) from them exactly as the analyzer does, so a session re-run headlessly or from Python is fitted with its systematics model.`,
      { h: 'Light-curve jitter and dilution' },
      r`An optional white-noise jitter $j_s$ per epoch (key {{jitlc}}, or {{jitlc@2}} for the second epoch; in ppm) is added in quadrature, $\sigma_i^2 = e_i^2 + j_s^2$, everywhere above: in the weights and in $-\frac{1}{2}\sum_i \ln(2\pi\sigma_i^2)$, which is what stops a free jitter from growing without bound. For the information criteria $\chi^2$ is replaced by $\chi^2 + \sum_i \ln(\sigma_i^2/e_i^2)$, as for the velocity jitter.`,
      r`Dilution (third light) by other stars in the aperture: with $d$ the ratio of their flux to the target's (key {{dil}}, per epoch {{dil@2}}), the astrophysical model is replaced by`,
      { eq: r`m_i \to \frac{m_i + d}{1 + d}` },
      r`before the airmass term, the regressors and the kernel, so it is still 1 out of transit and every depth is divided by $1 + d$. A contamination fraction $D$ of the light in the aperture (TESS's CROWDSAP is $1 - D$) is $d = D/(1 - D)$. Without a measurement of $d$ (photometry of the neighbour, a second band) it is degenerate with $k$ and should be fixed or given a prior.`,
      { h: 'Velocities' },
      r`For dataset $d$ with residuals $r_i = v_i - v_\mathrm{model}(t_i)$ (model without $\gamma_d$), variances $\sigma_i^2 + s_d^2$, weights $w_i = 1/(\sigma_i^2 + s_d^2)$ and $\gamma_d \sim U(-10^5, 10^5)$ m/s integrated out:`,
      { eq: r`\ln L_d = -\frac{1}{2}\left[\sum_i w_i r_i^2 - \frac{(\sum_i w_i r_i)^2}{\sum_i w_i}\right] - \frac{1}{2}\sum_i \ln\!\left[2\pi(\sigma_i^2 + s_d^2)\right] + \frac{1}{2}\ln\frac{2\pi}{\sum_i w_i} - \ln(2\times10^5)` },
      r`The $\ln(\sigma^2 + s^2)$ term is what keeps a free jitter from growing without bound.`,
      { h: 'Event times' },
      r`Mid-transit times of a planet are compared with $T_0 + E P$ and mid-eclipse times with the superior conjunction plus $E P$, $E$ being the nearest whole orbit; an optional timing noise $\sigma_t$ is added in quadrature:`,
      { eq: r`\ln L_\mathrm{tim} = -\frac{1}{2}\sum_i \left[\frac{(t_i - T_0 - E_i P)^2}{\sigma_i^2 + \sigma_t^2} + \ln 2\pi(\sigma_i^2 + \sigma_t^2)\right]` },
      { h: 'Prior support' },
      r`A point is rejected ($\ln L = -10^{100}$) when $e \notin [0, 0.999)$, $P \le 0$, $(a/R_\star)(1 - e) \le 1$, $k \le 0$, $M_p < 0$, a jitter is negative, the limb-darkening profile is not physical, or an optional model reports an impossible configuration. Priors are uniform or normal (truncated normal and log-uniform exist for programmatic use), applied as transforms of the unit cube.`,
      { h: 'Default priors in the analyzer' },
      r`These are starting points computed from the current value $v$ of each parameter ({{defaultPrior}} in {{src/main.js}}); every prior is shown and editable on the Fit tab and is written into the session and the exported script. Report the priors you used.`,
      { table: { head: ['Parameter', 'Default prior'], rows: [
        [r`$R_p/R_\star$`, r`$U(\max(0.001, 0.5v),\ \min(0.6, 1.6v))$`],
        [r`$i$`, r`$U(\max(60^\circ, v - 5^\circ),\ 90^\circ)$`],
        [r`$P$`, r`one light curve: $N(v,\ \max(10^{-6}, 10^{-5}v))$ d; several epochs: $U$ about $v$ wide enough to move the last transit by a quarter of $T_{14}$ relative to the first`],
        [r`$T_0$`, r`$U(v \pm \max(0.01,\ 0.2\,T_{14}))$ d`],
        [r`$e$`, r`$U(0,\ \min(0.95, \max(0.3, v + 0.2)))$`],
        [r`$\omega$`, r`$U(v \pm 30^\circ)$`],
        [r`$M_p$`, r`$U(0,\ \max(5v, 0.02))\ M_\mathrm{Jup}$`],
        [r`limb darkening`, r`$U(v \pm 0.3)$ per coefficient; $q_1, q_2 \sim U(0, 1)$`],
        [r`airmass coefficient $\kappa$`, r`$U(-0.2, 0.2)$`],
        [r`velocity trend`, r`$c_1 \sim U(-0.1, 0.1)$ m/s/d; $c_2 \sim U(-10^{-3}, 10^{-3})$ m/s/d²`],
        [r`jitter`, r`$U(0,\ \max(15, 5\times\text{median } \sigma))$ m/s`],
        [r`light-curve jitter`, r`$U(0,\ \max(500, 3\times\text{median } \sigma))$ ppm`],
        [r`dilution $d$`, r`$U(0,\ \max(1, 3v))$; not ticked when added`],
        [r`$v\sin i_\star$, $\lambda$`, r`$U(0,\ \max(20, 3v))$ km/s; $U(-180^\circ, 180^\circ)$`],
        [r`$M_\star$, $R_\star$`, r`$N(v, \sigma)$ with the catalogue uncertainty, or 5% of the value`],
        [r`$T_\mathrm{eff}$, [Fe/H]`, r`$N(v, \sigma)$ with the catalogue uncertainty, or 100 K and 0.1 dex`],
        [r`planet's light`, r`$F_p/F_\star \sim U(0, \max(0.05, 3v))$; contrast $U(0, 1)$; hot-spot offset $U(-90^\circ, 90^\circ)$; second harmonic $U(-0.25, 0.25)$; ellipsoidal $U(0, 500)$ ppm; beaming $U(-50, 50)$ ppm; map coefficients $U(-0.6, 0.6)$ for degree 1, $U(-0.3, 0.3)$ above`],
        [r`moon`, r`$R_m/R_\star \sim U(0, \max(0.05, 2.5v))$; period $U(0.97v, 1.03v)$; phase $U(0, 1)$; mass ratio $U(0, 0.1)$; tilt $U(0^\circ, 60^\circ)$`],
      ] } },
      r`A look-up in the catalogue suggests wider priors from the published uncertainties ({{suggestPriors}}: for example $R_p/R_\star$ uniform within $\pm\max(10\sigma, 0.5k)$, $P$ normal with $\max(5\sigma, 10^{-5}P)$, $T_0$ uniform within $\pm\max(10\sqrt{\sigma_{T}^2 + (N\sigma_P)^2},\ 0.5\,T_{14},\ 0.02\,\mathrm{d})$). The Fit tab's "EXOTIC's bounds" preset sets $R_p/R_\star \in [0, 1.25v]$, $i \pm 5^\circ$, $T_0$ within a quarter orbit and the airmass coefficient in $[-3, 3]$.`,
      { h: 'Information criteria' },
      r`$\mathrm{BIC} = \chi^2 + k\ln n$ [@schwarz1978], $\mathrm{AIC} = \chi^2 + 2k$ and $\chi^2/(n - k)$ are reported at the best-fitting point, with $k$ the number of sampled parameters plus the analytically integrated ones (one normalisation per epoch, one zero point per velocity dataset) and $n$ the number of measurements of every kind.`,
    ],
    checks: [
      { topic: 'basics', rows: [4, 1] },
      r`Light-curve jitter and dilution: $\ln L$ of a two-epoch light curve at four values of the jitters and $d$ against the integral over $a_s$ done numerically (scipy quad; {{test/make_lcnoise_reference.py}}): largest difference 1.2e-6; maximum-likelihood jitters 1470.71 and 617.61 ppm against scipy's 1470.70 and 617.57; injected 1500 and 600 ppm recovered as 1489 +107 −101 and 592 +110 −120; every point of a limb-darkened, exposure-averaged transit obeys depth$(d)$ = depth$(0)/(1 + d)$ to 1.6e-16; a fit without the correction returns $k/\sqrt{1 + d}$ ({{node test/lcnoise.test.mjs}}).`,
      r`Detrending in sessions: the regressors {{specFromSession}} builds equal the centroids standardised by hand plus a Legendre $P_1(t)$, the likelihood equals the analyzer's import path exactly, and {{runSession}} recovers $k$ = 0.1006 ± 0.0005 (0.1) where the same session without its systematics model gives 0.1124 ± 0.0003 ({{node test/sessiondetrend.test.mjs}}; the Python package gives the Node $\chi^2$ to 1e-12, {{python/tests/test_detrend.py}}).`,
      r`$\ln L$ against an independent Python implementation whose models come from exoplanet-core and radvel: largest difference 3.8e-6 over 24 points in four problems ({{node test/validation.test.mjs}}).`,
      { topic: 'exotic', rows: [3] },
    ],
    limits: [
      r`The noise model is white and Gaussian: the uncertainties as given, plus the optional light-curve jitter. There is no correlated-noise term in the likelihood and no outlier model. Underestimated error bars without a jitter give posteriors that are too narrow and exaggerate every evidence difference.`,
      r`Detrending is a multiplicative $e^{\kappa X}$ airmass term per epoch plus, when the light curve carries detector columns, linear regressors or a kernel model. Space-based systematics without such columns must be removed before the fit; the phase-curve examples use data detrended elsewhere.`,
      r`All epochs share one $T_0$ and $P$ (no per-epoch mid-times in a joint fit), one exposure model per epoch and one limb-darkening band.`,
      r`With several planets the light curve is the product of the planets' fluxes: planet-planet occultations during simultaneous transits are not modelled, and when planets have their own light the star's light is counted twice at the 1e-6 level.`,
    ],
    refs: ['schwarz1978', 'zellem2020'],
  },

  // =================================================================================================================
  {
    id: 'sampler', title: 'Nested sampling', code: ['src/core/nested.js (MiniNest)', 'src/core/fitRunner.js', 'src/core/stats.js'],
    body: [
      r`Posteriors and the evidence $Z = \int L(\theta)\,\pi(\theta)\,d\theta$ are computed by nested sampling [@skilling2006] with a sampler written for this project, {{MiniNest}}, which follows the strategy of UltraNest [@buchner2021]. Parameters are sampled in the unit cube and mapped through the inverse cumulative distribution of each prior.`,
      { h: 'Algorithm' },
      { ul: [
        r`**Live points.** $N = \max(400, 2d + 10)$ by default for $d$ free parameters, drawn uniformly in the unit cube.`,
        r`**Shrinkage.** At each iteration the live point of lowest likelihood $L_i$ is retired with weight $w_i = X_{i-1}\,(1 - e^{-1/N})$ and the prior volume shrinks as $\ln X_i = \ln X_{i-1} - 1/N$; then $Z = \sum_i L_i w_i$ plus the remaining live points, each with weight $X/N$. Live points with exactly equal likelihood (plateaus) are retired together with the volume rule of [@fowlie2021].`,
        r`**Region.** New points are drawn uniformly from the MLFriends region [@buchner2016; @buchner2019]: live points are whitened, $t = A^{-1}(u - \bar{u})$ with $AA^{T}$ the covariance of the live points about the mean of their own cluster; the region is the union of balls of radius $r$ around the live points, intersected with an ellipsoid $|t|^2 \le R^2$ and the unit cube. $r$ is the largest distance from a left-out point to its nearest selected neighbour over 20 bootstrap rounds; the ellipsoid is enlarged by the largest ratio found when it is re-fitted to each bootstrap sample (UltraNest keeps the shape fixed, which biased $\ln Z$ upward with dimension in our tests). Clusters are found by linking points closer than $r$. The region is rebuilt after every $\max(20, N/5)$ replacements and its volume is not allowed to grow.`,
        r`**Slice sampling.** When drawing from the region costs more than three times a slice-sampled point (measured in likelihood calls), the sampler switches to slice sampling [@neal2003] from a random live point: $\max(10, 2d)$ steps, each along either the difference of two live points of the same cluster or a random direction in the whitened space, with a bracket from the ellipsoid chord or from stepping out, and shrinkage on rejection. It switches back when the region costs less than 1.5 times a slice point.`,
        r`**Self-test.** The rank at which each new point enters the live set must be uniform [@buchner2016; @buchner2023]. A Kolmogorov-Smirnov test of the ranks of region-drawn points is made after each rebuild (threshold $p < 10^{-5}$, at least 600 ranks) and at termination ($p < 10^{-3}$). On failure the region is no longer trusted: the sampler continues in slice mode and, if less than 30% of the budget is spent, restarts from fresh prior draws.`,
        r`**Termination.** The run stops as converged when the live points can hold less than a fraction $f$ of the evidence, $L_{\max} X / (Z + L_{\max} X) < f$, with $f$ = 0.01 by default. It also stops at a budget of likelihood calls (default 10⁶) or seconds; such a run returns what it has with {{converged: false}}.`,
      ] },
      { h: 'Uncertainty of the evidence' },
      r`The volumes are random: each shrinkage factor is distributed as $\mathrm{Beta}(n_i, 1)$, $n_i$ being the number of live points at step $i$. $\ln Z$ is recomputed for 200 simulated sequences $X_{i+1} = X_i\,U^{1/n_i}$ (fixed seed) and its standard deviation taken; terms for plateaus, for the scatter of the final live points, and, in an unconverged run, half the range the remaining live points could add, are added in quadrature. The information $H$ and the effective sample size $(\sum w)^2/\sum w^2$ are reported with it.`,
      { h: 'Posterior summaries' },
      r`The result is a weighted sample. Reported values are weighted medians with the 15.87% and 84.13% quantiles (no interpolation between sample points). Equal-weight draws for plots, derived quantities and stored posteriors are made by systematic resampling with a fixed seed.`,
      { h: 'Warnings' },
      r`The sampler writes warnings in plain words: not converged (with the fraction of evidence still in the live points); fewer than 150 effective samples; sampling efficiency below 1%; a failed insertion-order test and whether the run restarted; more than half of the points from slice sampling; a posterior piled against an edge of its prior, or equal to its prior; separate peaks with their weights; pairs of parameters correlated above 0.95, with advice. They are stored in the session and belong in a paper's description of the fit when present.`,
      { h: 'Reproducibility' },
      r`The random-number generator is sfc32 seeded from the session (seed 42 by default). For a given seed a run is the same every time on the same JavaScript engine; only the optional time limit depends on the clock.`,
      { h: 'What the evidence can and cannot be used for' },
      r`$\ln Z$ is a normalised marginal likelihood: the Gaussian normalisations are included, the priors are proper, and the analytically integrated parameters carry their prior widths. It can therefore be compared between models **fitted to the same data with the same error bars**, when both runs converged. It cannot be used: across different data or error bars; from an unconverged run (it is then a lower limit); between an N-body fit with the profiled straight line and a Keplerian fit; or without regard to the priors, since widening a prior on a constrained parameter lowers $\ln Z$ by the logarithm of the factor. Its quoted uncertainty is the sampling error only.`,
    ],
    checks: [
      { topic: 'sampler', rows: [0, 1, 2, 3, 4, 5] },
      { topic: 'basics', rows: [1] },
      r`Four simulated problems against dynesty (3000 live points), UltraNest and emcee on an independent Python likelihood ({{node test/validation.test.mjs}}): posterior means within 0.04σ and widths within 3.5%; $\ln Z$ within 0.31 (1.5 combined σ) of dynesty and UltraNest; over eight seeds the mean $\ln Z$ is within 0.09 of the reference and its scatter between seeds (0.07 to 0.21) is no larger than about the reported error (0.12 to 0.20). [Validation: fits and their error bars](v:fits).`,
      r`Coverage, 300 simulated data sets each: the truth lies inside the 68% interval in 67.0 to 68.0% of transit fits and 69.0 to 73.3% of velocity fits (expected 68 ± 2.7%; the velocity amplitude and $\omega$ are 2σ high), and inside the 95% interval in 94.0 to 96.7% (same test). The data are simulated with this code's own model and white noise, so this tests the sampler and the likelihood, not the model.`,
    ],
    limits: [
      r`Funnel-shaped posteriors bias the evidence low by a few tenths, sometimes without a warning; the project's notes record 0.5 to 0.9 on some seeds.`,
      r`In slice mode the scatter of $\ln Z$ between runs exceeds the quoted error (rms pull up to 1.9 in the stress suite).`,
      r`In the stored run of {{test/nested.test.mjs}} an 8-dimensional correlated Gaussian gives $\ln Z$ = −23.357 ± 0.274 against the exact −23.966, that is 0.61 (2.2 reported σ) high; the 2- and 5-dimensional cases are within 1σ.`,
      r`A mode much narrower than another can be lost. Twenty parameters with correlations of 0.999 do not converge within the default budget (reported as such).`,
      r`A run stopped early has an effective sample size near 1; its intervals mean nothing, and the Results tab says so instead of showing them.`,
      r`Not implemented: a variable number of live points, a separate metric per mode, warm starts, resuming from disk.`,
      r`Coverage has been verified only on data simulated by this code's model with white noise. Correlated noise and model misspecification are untested.`,
    ],
    refs: ['skilling2006', 'buchner2016', 'buchner2019', 'buchner2021', 'buchner2023', 'neal2003', 'fowlie2021', 'speagle2020', 'foremanmackey2013'],
  },

  // =================================================================================================================
  {
    id: 'comparison', title: 'Model comparison and its cautions', code: ['src/main.js (readBayes, runAlarms)', 'src/core/model.js (infoCriteria)'],
    body: [
      r`The Results tab keeps every run on the same data and compares them by $\Delta\ln Z$, the logarithm of the Bayes factor [@kass1995], against the run with the highest evidence. The thresholds 2.5 and 5 (odds of about 12 and 150 to 1) are the scale of [@trotta2008], an adaptation of Jeffreys' scale; the requirement that a difference also exceed 1 and twice its uncertainty is the software's own, deliberately conservative. With $\sigma_\Delta$ the quadrature sum of the two evidence uncertainties,`,
      { table: { head: ['Condition', 'Reading'], rows: [
        [r`either run not converged`, 'not comparable'],
        [r`$|\Delta\ln Z| < \max(1, 2\sigma_\Delta)$`, 'indistinguishable'],
        [r`up to 2.5`, 'weakly disfavoured'],
        [r`2.5 to 5 (odds of about 12 to 150)`, 'moderately disfavoured'],
        [r`above 5`, 'strongly disfavoured'],
      ] } },
      r`Runs on other data are hidden from the comparison. Each run also lists reasons not to trust its evidence: not converged; fewer than 200 effective samples; insertion-order test with $p < 0.01$; $\chi^2/N$ above 1.6 (error bars too small or model incomplete, which exaggerates every $\Delta\ln Z$) or below 0.5; sampler warnings; priors on shared parameters that differ from the reference run (part of $\Delta\ln Z$ is then the change of prior volume); different kinds of data in the fit.`,
      r`The Timing tab compares ephemeris models by $\mathrm{BIC} = \chi^2 + k\ln n$ [@schwarz1978] and describes a difference above 2, 6 and 10 as positive, strong and very strong, the scale of [@kass1995] for twice the log Bayes factor.`,
    ],
    checks: [
      r`{{test/evidence.test.mjs}} checks that a transit model is preferred over no transit on simulated data ($\Delta\ln Z$ = 6164.6 in the stored output); there is no test of model comparison between two close models.`,
    ],
    limits: [
      r`The evidence depends on the prior widths chosen. A model comparison in a paper should state the priors of both models and, ideally, show that the conclusion survives a reasonable change of them.`,
      r`The uncertainty of $\ln Z$ is sampling error. Systematic bias of the sampler (see [Nested sampling](#sampler)) is of the same size as the "indistinguishable" threshold; differences below about 1 should not be interpreted.`,
      r`The BIC is an approximation that ignores the priors. On signal-free timing lists the BIC alone prefers a sinusoid in 58% of cases (project notes), which is why the Timing tab also requires a significant periodogram peak.`,
      r`Both criteria assume the error bars are right. They are not rescaled during a fit. The Data tab's "Rescale errors" multiplies every error bar of an epoch by one factor $\beta_k = \sqrt{\chi^2_k / (n_k (N - k)/N)}$, with $k$ the free parameters plus one normalisation per epoch, so that $\chi^2/(N - k) = 1$ about the model on screen; the relative sizes of the error bars are kept ({{test/data.test.mjs}}).`,
    ],
    refs: ['kass1995', 'trotta2008', 'schwarz1978'],
  },

  // =================================================================================================================
  {
    id: 'timing', title: 'Ephemerides, timing, periodograms and orbital decay', code: ['src/core/ephemeris.js', 'src/core/periodogram.js', 'src/ui/timingTab.js'],
    body: [
      { h: 'Ephemerides' },
      r`Mid-transit times $t_i \pm \sigma_i$ at whole-orbit epochs $E_i$ are fitted by weighted linear least squares with`,
      { eq: r`T(E) = T_0 + P E \qquad \text{or} \qquad T(E) = T_0 + P E + \frac{1}{2}\frac{dP}{dE}E^2, \qquad \frac{dP}{dt} = \frac{1}{P}\frac{dP}{dE}` },
      r`The fit is done in a centred, scaled epoch variable with a time offset removed, then mapped back to epoch 0, so Julian dates keep their precision. The covariance is $(G^{T} W G)^{-1}$ from the error bars as given; it is **not** rescaled by $\chi^2$, and the tab says so when $\chi^2/\mathrm{dof} > 2$. The uncertainty of a predicted time is $\sigma_T^2(E) = g^{T} C g$ with $g = (1, E, E^2)$ in the scaled variable, and $\sigma(dP/dt)$ includes the covariance with $P$. When a list has no epoch column, $E_i = \mathrm{round}[(t_i - t_\mathrm{ref})/P]$ with the system period; a time more than 0.2 periods from a whole orbit raises a warning. The quadratic term is the only decay model: it describes orbital decay, or apsidal precession to first order; there is no separate precession model. Linear and quadratic fits are compared by BIC.`,
      { h: 'Periodic signals in the residuals' },
      r`The residuals from the ephemeris are searched with the generalised Lomb-Scargle periodogram [@zechmeister2009] (weights $1/\sigma_i^2$, floating mean), in the normalisation $p(f) = 1 - \chi^2(f)/\chi^2_0$, where $\chi^2(f)$ is that of the best sinusoid plus constant at frequency $f$. Epochs are a lattice, so the shortest period searched is two lattice steps (a true Nyquist limit) and the longest twice the time span, on a grid oversampled 10 times. The false-alarm probability of the highest peak is the analytic bound of [@baluev2008], $\mathrm{FAP} \approx 1 - (1 - \mathrm{FAP}_\mathrm{single})\,e^{-\tau(z)}$, as implemented in astropy [@vanderplas2018]; a bootstrap over the residuals (1000 resamples) is available on request. A sinusoid is then fitted to the times themselves together with the ephemeris (linear least squares with a Gauss-Newton refinement of the period), the periodogram of what is left is computed, and a second sinusoid is tried. A sinusoid is recommended only if its peak has FAP below 1% **and** it lowers the BIC.`,
    ],
    checks: [
      { topic: 'basics', rows: [2, 3] },
      { topic: 'periodogram', rows: [0, 1, 2, 3, 4] },
      r`Coverage of the ephemeris fit over 4000 noise realisations and the comparison with exact rational arithmetic: {{node test/ephemeris.test.mjs}}.`,
    ],
    limits: [
      r`No published list of mid-transit times has been fitted end to end and compared with its paper; only the conversion from $dP/dE$ to $dP/dt$ was (WASP-12 b, [@leonardi2024]).`,
      r`The analytic false-alarm probability trusts the error bars: with errors underestimated by 45 s of unmodelled scatter it raises false alarms in 68% of signal-free lists, the bootstrap in 1% (stored test output). Use the bootstrap when $\chi^2/\mathrm{dof}$ of the ephemeris is well above 1.`,
      r`Times are taken as given, with no conversion between time standards; the calendar column of predicted transits reads the listed time as UTC.`,
      r`A periodic signal in transit times has many physical explanations; the periodogram gives a period and amplitude, not a companion. See [N-body dynamics](#nbody).`,
    ],
    refs: ['zechmeister2009', 'baluev2008', 'vanderplas2018', 'astropy2022', 'leonardi2024', 'schwarz1978'],
  },

  // =================================================================================================================
  {
    id: 'multiplanet', title: 'Several planets and Kepler-tied a/R★', code: ['src/core/model.js', 'src/core/rv.js (arsFromKepler)'],
    body: [
      r`A fit can hold several planets. The first planet's parameters have plain keys ({{per}}, {{rprs}}); the others carry their letter ({{per@c}}). Limb darkening belongs to the star and is shared. The light curve is the product of the planets' fluxes, the velocity the sum of their reflex terms, and each planet's event times are compared with its own ephemeris.`,
      r`$a/R_\star$ is **never a sampled parameter**. With the inclination free the two trade off through the impact parameter $b = (a/R_\star)\cos i$: a transit of fixed duration and depth can be reproduced along a ridge in the ($a/R_\star$, $i$) plane, which costs the sampler several times more likelihood calls and inflates the uncertainty of $i$ without adding information that the stellar density does not already give. $a/R_\star$ is therefore either held at its input value, or, with "a/R★ from Kepler's law", computed for every sample from`,
      { eq: r`\frac{a}{R_\star} = \frac{1}{R_\star}\left[\frac{G\,(M_\star + M_p)\,P^2}{4\pi^2}\right]^{1/3}` },
      r`so that the photometry, the velocities and the timing describe one orbit. $M_\star$ and $R_\star$ can then be free parameters with normal priors at their measured uncertainties, which propagates the stellar density uncertainty into $a/R_\star$, $b$ and the durations.`,
    ],
    checks: [
      { topic: 'sampler', rows: [1] },
      { topic: 'exotic', rows: [3, 5] },
      r`Project notes (README, "The sampler"): a transit fit with both $a/R_\star$ and $i$ free needed 47,000 likelihood calls and gave $\sigma(i)$ = 0.84°, against 11,600 calls and 0.076° with $a/R_\star$ fixed. These two numbers are from a development run and are not asserted by a test.`,
    ],
    limits: [
      r`Holding $a/R_\star$ fixed without freeing the star understates the uncertainty of $i$, $b$ and the durations: the quoted intervals are conditional on that value. For publication, use Kepler's law with $M_\star$ and $R_\star$ free under their measured uncertainties, or state the value $a/R_\star$ was fixed at and its source.`,
      r`The stellar density implied by a transit is not fitted independently of $M_\star$ and $R_\star$; an inconsistent stellar density (blend, wrong star) shows only as a poor fit.`,
      r`Seventeen free parameters for three planets converge in about 950,000 likelihood calls, close to the default budget.`,
    ],
    refs: ['winn2010', 'seager2003'],
  },

  // =================================================================================================================
  {
    id: 'viability', title: 'Physical priors: stable orbits and period aliases', code: ['src/core/physical.js', 'src/core/aliases.js', 'src/core/model.js (spec.physical, nalias)', 'src/core/priors.js (categorical)'],
    body: [
      r`Optional prior constraints, each off unless {{spec.physical}} switches it on, applied in the likelihood before any model is computed (a point that fails has zero prior mass). Semi-major axes come from Kepler's law with each planet's period and mass, masses from {{mplanet}} or from $K$. **crossing**: the radial ranges of adjacent orbits do not overlap, $a_2(1 - e_2) > a_1(1 + e_1)$. **hill**: Gladman's Hill stability of each adjacent pair on coplanar eccentric orbits [@gladman1993],`,
      { eq: r`\mu^{-3}\left(\mu_1 + \frac{\mu_2}{\ell^2}\right)\left(\mu_1\gamma_1 + \mu_2\gamma_2\ell\right)^2 > 1 + 3^{4/3}\frac{\mu_1\mu_2}{\mu^{4/3}},\qquad \ell = \sqrt{a_2/a_1},\ \gamma_i = \sqrt{1 - e_i^2}` },
      r`which for circular orbits is a separation of $2\sqrt{3}$ mutual Hill radii $R_H = [(m_1 + m_2)/3M_\star]^{1/3}(a_1 + a_2)/2$. **hillSpacing**: every adjacent pair at least that many $R_H$ apart (about 10 for three or more planets to survive $10^8$ orbits [@chambers1996]). **amd**: AMD stability [@laskar2017] with coplanar orbits, $C/\Lambda_\mathrm{out} < C_c(\alpha, \gamma)$ for each pair and $C/\Lambda_1 < 1$. **roche**: periastron outside the star and outside $f\,R_p\,(M_\star/M_p)^{1/3}$, $f$ = 2.16 (Rappaport et al. 2013). **megno**: a short integration of the variational equations [@cincotta2000] for each candidate (expensive).`,
      r`A truncated prior changes the evidence. The sampler integrates $L\pi$ over the allowed region, so its $Z$ is that of "this prior and a viable system"; the evidence of the renormalised prior $\pi/V$ is $Z/V$, with $V$ the prior mass that passes, estimated from 20,000 prior draws and stored by runSession as {{result.prior_volume}} ($\ln V$, and $\ln Z - \ln V$). Use $\ln Z$ to compare viable models with each other; $\ln Z - \ln V$ always gains about $-\ln V$ when the data already sit in the allowed region.`,
      { h: 'Period aliases' },
      r`A planet seen in transits a span $S$ apart has $P = S/N$. aliasScan predicts every transit of each $N$ and drops an $N$ that puts a transit inside covered data (more than half of its $T_{14}$ window observed) more than 0.1 d from every one seen, the rule of the owner's EXOTIC analysis of TOI-1873. The survivors go to the sampler as one categorical parameter {{nalias}} with {{palias}} = $S$, $P$ = palias/nalias, uniform or geometric ($\propto N^{2/3}$, the transit probability) weights; or one run per $N$, compared afterwards.`,
    ],
    checks: [
      r`Gladman's criterion against a numpy transcription on 200 random eccentric pairs: 2.2e-16; its circular limit is 3.4640, 3.4637, 3.4624, 3.4563, 3.4283 mutual Hill radii at $\mu$ = 1e-7 to 1e-3, tending to $2\sqrt{3}$ = 3.4641. AMD, critical AMD and $\beta$ against numpy/brentq on 100 systems of two to four planets: 1.9e-15. Two Jupiters around a Sun 3.0 $R_H$ apart are rejected and 4.0 accepted ({{test/make_viability_reference.py}}, {{node test/viability.test.mjs}}).`,
      r`With a flat likelihood the sampler's $\ln Z$ with the crossing test is −2.197 against the analytic $\ln V$ = −2.282 (expected scatter 0.15). Two planets in 30 simulated velocities (25 m/s, $e$ = 0.05 and 0.10): $\ln Z$ = −161.69 ± 0.22 without tests, −161.45 (crossing, $\ln V$ = −1.44), −162.00 (hill, −2.54), −161.99 (amd, −1.82): the data sit in the allowed region; a spacing of 8 $R_H$, which excludes the true pair (6.4 $R_H$), costs 49 in $\ln Z$ against $\ln V$ = −3.32.`,
      r`TOI-1873 d (three transits 900.191 and 900.186 d apart, TESS coverage of 16 sectors read from the owner's time series, {{test/make_alias_reference.py}}): allowed $N$ = 1, 2, 3, 4, 7, as in the owner's analysis, with the covered and missed transits of every $N$ up to 25 equal to EXOTIC's stored scan. A simulated planet with three transits 900 d apart (truth $N$ = 3): the categorical run gives $p(N{=}3)$ = 0.895 and $p(N{=}2)$ = 0.105 against 0.882 ± 0.028 and 0.117 ± 0.028 from one run per $N$, and its $\ln Z$ (3295.99 ± 0.18) equals the mean of theirs (3295.76 ± 0.16) ({{node test/aliases.test.mjs}}).`,
    ],
    limits: [
      r`Mutual inclinations are not known from transits and velocities, so Hill and AMD tests assume coplanar orbits. Neither criterion knows about resonances, which can protect crossing orbits (and the AMD test ignores the mean-motion-resonance overlap correction of later work).`,
      r`Masses from $K$ are minimum masses when the inclination is unknown. A planet without a mass counts as massless (only crossing is tested for it).`,
      r`The MEGNO screen integrates a few hundred orbits per likelihood call; it is for a final check of a narrow posterior, not for a broad search.`,
    ],
    refs: ['gladman1993', 'chambers1996', 'laskar2017', 'cincotta2000'],
  },

  // =================================================================================================================
  {
    id: 'phasecurve', title: 'Phase curves and eclipse maps', code: ['src/core/phasecurve.js'],
    body: [
      r`When a planet has the parameter $F_p/F_\star$ ({{fpfs}}), its own light is added to the model. The flux relative to the star alone is`,
      { eq: r`F(t) = S(t)\,T(t) + F_p(t)\,V(t)` },
      r`with $T$ the transit, $S$ optional stellar terms, $F_p$ the planet's flux and $V$ the visible fraction of the planet's disc. $F_p/F_\star$ is the dayside surface brightness relative to the star's, so the eclipse depth is $D = (F_p/F_\star)\,k^2$. The orbital phase is $\phi = \omega + \nu + 90^\circ$, zero at mid-eclipse and $180^\circ$ at mid-transit for any eccentricity.`,
      { h: 'Harmonic phase curve' },
      { eq: r`F_p(\phi) = D\,\frac{(2 - C) + C\cos(\phi + \phi_h)}{2 - C + C\cos\phi_h} + D\left[h_{2c}(\cos 2\phi - 1) + h_{2s}\sin 2\phi\right]` },
      r`$C \in [0, 1]$ is the contrast, (maximum − minimum)/maximum of the first-order curve; $\phi_h$ is the hot-spot offset in degrees, positive east, so that the curve peaks $\phi_h$ before mid-eclipse; $h_{2c}$, $h_{2s}$ are second-harmonic amplitudes as fractions of the depth. By construction $F_p(0) = D$ and $F_p \ge 0$. The flux is floored at zero.`,
      { h: 'Eclipse' },
      r`In this mode the planet is a uniform disc and $V = 1 - A_\mathrm{lens}/(\pi k^2)$, with $A_\mathrm{lens}$ the area common to the stellar and planetary discs (closed form), when the planet is behind the star. The planet's own disc is occulted, with its true radius.`,
      { h: 'Stellar terms' },
      { eq: r`S = 1 - A_\mathrm{ellip}\left(\frac{a}{r}\right)^{3}\cos 2\phi - A_\mathrm{beam}\left[\cos(\omega + \nu) + e\cos\omega\right]` },
      r`with the ellipsoidal and beaming amplitudes in ppm; both default to zero.`,
      { h: 'Light-travel time' },
      r`Optionally (it needs $R_\star$) the model is evaluated at the retarded time $t' = t - (R_\star/c)\,[\,r_\mathrm{tr}\sin i - Z(t)\,]$, one fixed-point step, which is zero at mid-transit and delays mid-eclipse by $(R_\star/c)(r_\mathrm{tr} + r_\mathrm{ecl})\sin i$, that is $2a/c$ for a circular orbit.`,
      { h: 'Maps' },
      r`In map mode the planet's surface brightness is $I(\theta, \lambda) = I_0\,[1 + \sum_{l,m} y_{lm} Y_{lm}(\theta, \lambda)]$ in real spherical harmonics up to degree 3, normalised as in starry [@luger2019] with $Y_{00} = 1$, in a frame whose $z$ axis points to the star (longitude measured east from the substellar point) and whose $y$ axis is the orbit normal; rotation is synchronous. Out of eclipse the disc-integrated flux is analytic, $F_p = D_n\,[1 + \frac{2}{3}\,\mathbf{v}\cdot\mathbf{o} + \frac{1}{4}\,\mathbf{o}^{T} Q\,\mathbf{o}]$, with $\mathbf{o}$ the direction to the observer and $\mathbf{v}$, $Q$ the degree-1 and degree-2 parts of the map; degree 3 contributes nothing out of eclipse. $D_n$ is set so that the unocculted flux at $\phi = 0$ equals $D$. During eclipse ingress and egress the flux of the visible part of the disc is obtained from ten moments $\frac{1}{\pi}\int x^a y^b z^c\,dA$, each a Green's-theorem line integral: closed form along the planet's limb and 12 Gauss-Legendre nodes along the stellar limb. A fit rejects maps whose disc-integrated flux is negative; rejecting maps with negative surface brightness is an option, off by default.`,
      { h: 'Positive planets' },
      r`Always: the planet's unocculted flux must be non-negative at every phase (so the nightside too); the smallest value over the orbit is found from 72 phases and a golden-section search. With {{phase.positive_map}} the surface brightness must also be non-negative everywhere on the sphere, zero prior mass otherwise. Its minimum is exact for degree 1 ($1 - |\mathbf{v}|$) and degree 2 (the minimum of $1 + \mathbf{v}\cdot\mathbf{b} + \mathbf{b}^T Q\,\mathbf{b}$ on $|\mathbf{b}| = 1$, a trust-region problem: the multiplier is the root of a secular equation in the eigenbasis of $Q$, plus the "hard case"), and from a 5° grid and a pattern search for degree 3. In harmonic mode the option tests the degree-1 map of the first-order curve, which is stricter than physics requires: a contrast above 0.8 needs degree 2 or more, not a negative map. phaseSummary(requirePositive) gives no temperatures, albedo or hot spot for a model that is not physical, so posterior summaries can be taken over physical draws only.`,
      { h: 'Temperatures' },
      r`A brightness temperature is found by solving $\int B_\lambda(T_b)\,d\lambda = (F_p/F_\star)\int B_\lambda(T_\mathrm{eff})\,d\lambda$ over the band by bisection, the star being a blackbody at $T_\mathrm{eff}$. Day and night temperatures are those of the unocculted flux at $\phi = 0$ and $180^\circ$. Bond albedo and heat redistribution follow [@cowan2011]: $T_0 = T_\mathrm{eff}/\sqrt{a/R_\star}$, $A_B = 1 - \frac{1}{2}(3x + 5y)$, $\varepsilon = 8y/(3x + 5y)$ with $x = (T_d/T_0)^4$, $y = (T_n/T_0)^4$.`,
    ],
    checks: [
      { topic: 'phasecurve', rows: [0, 1, 2, 3, 4, 5] },
      r`Smallest brightness of 120 random maps of degree 1 to 3 (37 negative somewhere) against a 0.25° grid polished by Nelder-Mead in numpy ({{test/make_mappos_reference.py}}): 2.2e-16 (degree 1), 1.6e-15 (degree 2), 2.4e-12 (degree 3), none classified differently. The smallest flux over the orbit is within 5.6e-11 of the depth of 100,000 phases ({{node test/phasepositive.test.mjs}}).`,
      r`WASP-43 b eclipse map refitted with {{positive_map}} (PHASEPOS_FULL=1): degree 1 holds $y_{10}$ at the edge, 0.568 +0.005 −0.008 (stored, unconstrained: 0.703 ± 0.037, a map negative on 8.4% of the sphere), $y_{1,-1}$ is bounded at −0.03 ± 0.06 (stored: 0.11 +0.22 −0.24, its prior), and $\ln Z$ falls by 11.6 ($\ln V$ = −0.63 of prior mass removed). Degree 2 positive keeps $y_{10}$ = 0.705 ± 0.034 with $y_{20}$ = 0.17 ± 0.05, $y_{1,-1}$ = 0.00 ± 0.06, and $\ln Z$ 1.2 below the unconstrained degree-1 fit ($\ln V$ = −1.22).`,
    ],
    limits: [
      r`The examples fit Spitzer light curves that were already detrended elsewhere, jointly with that pipeline's own phase-curve model; instrument systematics are not modelled here, and those light curves are not independent of a degree-1 map.`,
      r`The north-south coefficient $y_{1,-1}$ is unconstrained in both map examples and runs into its prior unless the map is required to be positive, which bounds it (above).`,
      r`With several planets the fluxes are multiplied, which counts the star's light twice at the 1e-6 level.`,
      r`The star is a blackbody for brightness temperatures. Reflected light and thermal emission are not distinguished. A contrast above 0.8 corresponds to a degree-1 map that is negative near the antistellar point.`,
      r`EXOTIC's phase-curve model differs on purpose: its eclipse ingress is that of a body of radius $k\sqrt{F_p/F_\star}$ and starts late (up to 29% of the depth during ingress).`,
    ],
    refs: ['luger2019', 'cowan2011', 'stevenson2017', 'kreidberg2015', 'zellem2020'],
  },

  // =================================================================================================================
  {
    id: 'exomoon', title: 'Exomoons', code: ['src/core/exomoon.js'],
    body: [
      r`A planet has a moon when it has the parameter $R_m/R_\star$ ({{rmoon}}). Planet and moon orbit their common barycentre, which follows the planet's Keplerian orbit; the moon's orbit is circular. Parameters: $R_m/R_\star$; the moon's period $P_m$; its phase at the planet's mid-transit (0 = between planet and observer); the mass ratio $q = M_m/M_p$ (default 0, in which case the planet does not move about the barycentre); and one tilt angle about the transit chord (0 = coplanar and prograde). The separation follows from Kepler's law,`,
      { eq: r`\frac{a_m}{R_\star} = \frac{a}{R_\star}\left(\frac{P_m}{P}\right)^{2/3}\left(\frac{\mu}{1+\mu}\right)^{1/3}, \qquad \mu = \frac{M_p (1 + q)}{M_\star}` },
      r`and the positions are barycentre $- \frac{q}{1+q}\,\mathbf{d}$ for the planet and barycentre $+ \frac{1}{1+q}\,\mathbf{d}$ for the moon, $\mathbf{d}$ being the moon-planet vector. The blocked flux is that of the union of the two discs: the sum of the two single-disc terms of the [transit model](#transit) minus the flux behind the region common to planet, moon and star, a Green's-theorem sum over arcs of the three circles (20 Gauss-Legendre nodes per half-arc). A moon wholly behind or in front of the planet's disc adds nothing.`,
      r`Stability is reported, not enforced: the Hill radius $r_H = (a/R_\star)(1 - e)(\mu/3)^{1/3}$, the limits of [@domingos2006] ($a_m < 0.4895\,r_H\,(1 - 1.0305e)$ prograde, $0.9309\,r_H\,(1 - 1.0764e)$ retrograde) and a Roche limit. The likelihood only requires that the two bodies do not overlap.`,
      r`"Search for a moon" is a matched filter on the residuals of the planet-only fit: templates of a reference moon on a grid of period (uniform in frequency) and phase, with the planet's own depth and mid-time projected out; the statistic is the signal-to-noise ratio $\sum w r m / \sqrt{\sum w m^2}$. The false-alarm probability is the fraction of searches of white-noise realisations, drawn from the error bars, that reach the same value.`,
      r`Timing and duration variations are compared with the amplitudes of [@kipping2009]: $\mathrm{TTV} = a_w / v_B$ and $\mathrm{TDV} = \bar{T}\,(2\pi a_w/P_m)/v_B$ with $a_w = a_m\,q/(1+q)$.`,
    ],
    checks: [{ topic: 'exomoon', rows: [0, 1, 2, 3, 4, 5] }],
    limits: [
      r`The moon's orbit is circular; the star's tide on the moon is ignored (two bodies about a Keplerian barycentre); one orientation angle only. The moon's own light is not modelled.`,
      r`No real detection has been reproduced: there is none. The example is simulated.`,
      r`The configuration of the reference script this was ported from is unbound (2.4 Hill radii), which the page flags.`,
      r`The search's false-alarm rate assumes white noise with the stated error bars. The moon is not drawn in the three-dimensional view.`,
    ],
    refs: ['kipping2009', 'domingos2006', 'heller2014', 'hippke2022'],
  },

  // =================================================================================================================
  {
    id: 'nbody', title: 'N-body dynamics', code: ['src/core/nbody.js', 'src/core/model.js'],
    body: [
      r`With the N-body option, mid-transit times and stellar velocities come from an integration of the star and planets instead of independent Keplerian orbits. The planets' $P$, $T_0$, $e$, $\omega$, $i$ (and an optional node angle) are read as osculating elements at a stated epoch, in Jacobi coordinates with planets ordered by period, in the frame of the [conventions](#conventions). Units are au, days and solar masses. With all planet masses zero the result is the Keplerian model.`,
      { ul: [
        r`**Wisdom-Holman map** (default): the splitting of [@wisdom1991] in Jacobi coordinates as in WHFast [@rein2015whfast], drift-kick-drift, with the Kepler drift solved in universal variables and symplectic correctors [@wisdom2006] of order 5 by default. The step is fixed at $\min_p [P_p (1 - e_p)^{3/2}/\sqrt{1 + e_p}]$ divided by 30 (20 in the example and the companion search).`,
        r`**IAS15**: the 15th-order Gauss-Radau integrator of [@rein2015ias15] (after [@everhart1985]) with adaptive steps, precision parameter $10^{-9}$. It is used only when selected; a close encounter under the Wisdom-Holman map (separation below one mutual Hill radius) is reported with advice to rerun, not handled automatically.`,
        r`**Transit times**: the root of the star-centred sky-plane condition, by default the conjunction $X\cos\Omega + Y\sin\Omega = 0$ in the likelihood (or the minimum separation $\mathbf{R}_\mathrm{sky}\cdot\mathbf{V}_\mathrm{sky} = 0$ as in TTVFast [@deck2014]), with the planet in front; refined by Newton iteration on a two-body arc.`,
        r`**Velocity**: $-\dot{Z}_\star$ of the star in the barycentric frame, positive when receding.`,
        r`**In the likelihood**: observed mid-transit times are matched to the nearest simulated transit. With {{nbody.linear}} a weighted straight line in epoch is fitted to each planet's residuals inside the likelihood, so the transiting planet's own $T_0$ and $P$ need not be sampled.`,
      ] },
      r`Stability is reported from the mutual Hill separation (two planets are Hill-stable beyond $2\sqrt{3}$ mutual Hill radii, [@gladman1993]; with three or more planets a separation below 10 is flagged, [@chambers1996]), orbit crossing, the AMD criterion of [@laskar2017] and, on request, a short integration with a shadow particle. "Search for an unseen companion" scores a grid of perturber mass and period (eight starting phases each) by the $\chi^2$ of the observed times against the integration with a straight line profiled out, then polishes the best cell by Nelder-Mead. The analytic amplitudes of [@lithwick2012] and [@agol2005] are available for comparison.`,
    ],
    checks: [{ topic: 'nbody', rows: [0, 1, 2, 3, 4, 5] }],
    limits: [
      r`Light curves and mid-eclipse times from the integration are described in the next section (Photodynamics). Light-travel time is optional ({{nbody.ltt}}).`,
      r`A fit that samples the transiting planet's own period and $T_0$ as osculating elements did not converge in 150,000 likelihood calls, which is why the straight line is profiled by default; mean-ephemeris elements (next section) make that fit converge at about six integrations per call. A profiled parameter is not marginalised: the evidence of such a fit is not comparable with that of a Keplerian fit, and the uncertainties are conditional on the best line.`,
      r`The $\chi^2$ surface of a perturber has period aliases every few thousandths of a day. The search returns one solution that fits, not the only one.`,
      r`TTVFast, given the same Jacobi elements, differs by hundreds of seconds because it defines them differently (stored test output); compare codes through state vectors or transit times, not elements.`,
    ],
    refs: ['wisdom1991', 'wisdom2006', 'rein2015whfast', 'rein2015ias15', 'everhart1985', 'rein2012', 'deck2014', 'lithwick2012', 'agol2005', 'holman2005', 'gladman1993', 'chambers1996', 'laskar2017', 'pearson2019'],
  },

  // =================================================================================================================
  {
    id: 'photodynamics', title: 'Photodynamics', code: ['src/core/nbody.js (dynamicalModel, simulate, osculatingFromMean, megno)', 'src/core/model.js (spec.nbody)'],
    body: [
      r`With {{spec.nbody}} set and a light curve in the fit, the light curve is computed from the same integration as the transit times and velocities. The integrator writes every body's position and velocity at evenly spaced nodes (150 per orbit of the innermost planet by default) only over the spans covered by data; each planet's sky-plane position relative to the star at a sample time is interpolated by cubic Hermite polynomials from the positions and velocities at the neighbouring nodes, and the separation is passed to the transit kernel of the transit-model section, through the same exposure averaging as Keplerian curves.`,
      r`**Light-travel time** ({{nbody.ltt}}): each body is taken at its retarded time, with the barycentre's sky plane as reference, so a transit is seen about $a/c$ early and an eclipse about $a/c$ late.`,
      r`**Mid-eclipse times** in the timing likelihood come from the same integration (roots of the superior-conjunction condition).`,
      r`**Mean-ephemeris elements** ({{nbody.elements: "mean"}}): a planet's sampled period and $T_0$ are those of the straight line through its simulated transits over the span of the data; the osculating elements at the reference epoch are found by fixed-point iteration (each step one integration). This removes the ridge between a companion's mass and the transiting planet's osculating period that defeats sampling in osculating elements.`,
      r`**MEGNO** [@cincotta2000] is integrated alongside a short run (variational equations, Gauss–Radau quadrature on the IAS15 nodes): about 2 for a regular orbit, growing linearly for a chaotic one; it enters the stability findings.`,
    ],
    checks: [
      r`{{node test/nbodyphoto.test.mjs}} (references from REBOUND 5.2.2 and batman, {{test/make_nbodyphoto_reference.py}}): with all masses zero the photodynamical curve equals the Keplerian one to 1.0e-9 of the flux (3.6e-14 at 600 nodes per orbit); a strongly perturbed pair (1 and 2 $M_\mathrm{J}$ at 10 and 20.3 d, 2819 points over 125 d, where the Keplerian curve is wrong by 12,049 ppm) agrees with REBOUND IAS15 positions through batman's kernel to 0.008 ppm with IAS15, 57 ppm with the Wisdom–Holman map at its defaults and 14 ppm at 60 steps per orbit; 30-minute exposures 0.004 ppm; light-travel time 0.02 ppm against REBOUND at retarded times. Mid-eclipse times: 3.8e-8 s from REBOUND for 18 eclipses. MEGNO 2.0004, 1.9955, 1.9987 on the example system after 2000 orbits (REBOUND 2.0008, 2.0020).`,
      r`Mean elements: periods recovered to 1.6e-11 d after a round trip; a five-parameter fit of the timing example (both planets' ephemerides and the companion's mass) converged in 19,032 calls, companion $0.1004 \pm 0.0063\,M_\mathrm{J}$ (injected 0.100), with {{NBODY_FIT=1}}.`,
    ],
    limits: [
      r`Planets are treated one at a time in the light curve: the area two planets share on the disc during a mutual event is counted twice. A planet with its own light or a moon keeps a Keplerian curve.`,
      r`The Wisdom–Holman map's timing error grows with time and with the square of the masses (7 s over 125 d for the pair above); pairs of giant planets with precise photometry need IAS15 or more steps per orbit.`,
      r`The straight-line profile ({{nbody.linear}}) corrects times only and is refused together with a light curve. Mean elements cost about six integrations per call and are not found inside a mean-motion resonance (the point is rejected).`,
      r`The value of MEGNO for a chaotic orbit is not reproducible between codes, only "about 2" against "much more"; the Lyapunov time from a run stopped at MEGNO = 20 is an order of magnitude.`,
    ],
    refs: ['rein2015ias15', 'rein2015whfast', 'wisdom1991', 'cincotta2000', 'kreidberg2015'],
  },
  {
    id: 'spectroscopy', title: 'Time-series spectroscopy', code: ['src/core/spectroscopy.js', 'src/core/missionbands.js', 'src/core/model.js (data.regressors)', 'src/spectra/'],
    body: [
      r`Input is extracted one-dimensional spectra over time: JWST {{x1dints.fits}} files (both pipeline layouts, one row per integration or one extension per integration, segments joined in time and detectors in wavelength) or a table of flux against time and wavelength (CSV, ECSV). There is no spectral extraction from images.`,
      { h: 'Cleaning and binning' },
      r`A point more than 5 robust standard deviations from an 11-point running median in time is replaced. A column is dropped when more than 20% of its points are bad, when its median flux is not positive or differs by more than 50% from its neighbours', or when its error bars are five times the typical ones. Channels are sums over columns (constant resolving power, constant width, $N$ channels, or a fixed number of columns), with errors added in quadrature, normalised by their median. Error bars are widened to the point-to-point scatter when that is larger (the default; pipeline errors or scatter alone can be chosen).`,
      { h: 'Baseline' },
      r`Every light curve, white or spectroscopic, goes through the one likelihood ({{buildProblem}}) with optional regressors $x_k$ per epoch (scaled time, its square, step functions at given times):`,
      { eq: r`F(t) = m(t)\,e^{a_2 X(t)}\left(a_1 + \sum_k c_k\,x_k(t)\right)` },
      r`with $a_1$ and the $c_k$ integrated out analytically together (a Gaussian integral with the determinant of the weighted normal matrix), each $c_k$ under a flat prior of width 2.`,
      { h: 'White light, then channels' },
      r`The white light curve is fitted by nested sampling for $k$, $T_0$ and $i$; $a/R_\star$ is fixed or follows from Kepler's law with $R_\star$ free under a normal prior. Each channel is then fitted for its depth ($k$, or $F_p/F_\star$ for an eclipse) with the geometry fixed at the white-light solution and limb-darkening coefficients from the PHOENIX table [@husser2013] for the channel's wavelength range and the star. With one free parameter the posterior is integrated on a 241-point grid of the same likelihood. Limb darkening with a normal prior, or the geometry with normal priors, sends the channel fit to the nested sampler instead.`,
      { h: 'Products' },
      r`The spectrum with 16th–84th percentile errors; per-channel residual rms against the error bars; the binned-rms test of the noise section; the depth in atmospheric scale heights $H = k_B T_\mathrm{eq}/(\mu m_\mathrm{H} g)$ for interpretation (with $\mu$ chosen by the user, 2.3 by default), the change of depth per scale height being $2 k H/R_\star$.`,
      { h: 'Simulator' },
      r`Simulated observations use photon noise from a black-body star seen through a telescope of collecting area $A$ (Ariel 0.64 m² [@tinetti2018], JWST 25.4 m²) and a throughput $\tau$, plus a noise floor $f$:`,
      { eq: r`N_e = A\,\tau\,\Delta t\,\pi\left(\frac{R_\star}{d}\right)^2 \int \frac{2c}{\lambda^4}\frac{\mathrm{d}\lambda}{e^{hc/\lambda k_B T} - 1}, \qquad \sigma^2 = \frac{(1+x)^2}{N_e} + f^2\,\frac{T_{14}}{\Delta t}` },
      r`$\tau$ (0.3) and $f$ (20 ppm Ariel, 10 ppm JWST) are editable inputs and are not taken from mission documents. This is a simple radiometric estimate, not ArielRad or PandExo.`,
    ],
    checks: [
      r`{{node test/spectroscopy.test.mjs}} (44 checks): readers against astropy, exact (real G395H files to 2.4e-15); the marginal likelihood with regressors against a {{scipy.integrate.tplquad}} integral to 9.4e-5 in $\ln L$, coefficients against {{numpy.linalg.solve}} to 1.4e-9; photon rate against {{scipy.integrate.quad}} to 8.4e-9; Ariel-to-JWST noise ratio 6.300 $= \sqrt{25.4/0.64}$.`,
      r`Injection and recovery: pulls (recovered − injected)/$\sigma$ of mean 0.084 and standard deviation 0.980 over 228 simulated Ariel channels (70% within 1$\sigma$, 96% within 2$\sigma$); 0.296 and 0.981 over 36 channels made with batman [@kreidberg2015] with the geometry at the truth, 0.471 and 0.978 with the geometry from the white-light fit.`,
      r`Real data, WASP-39 b with NIRSpec G395H (JWST ERS program 1366, standard-pipeline {{x1dints}}): the mirror-tilt step is found automatically (−3275 ppm, 75$\sigma$); white-light depth 21324 ± 13 ppm, residual rms 136 ppm. At $R = 100$ (56 channels) the spectrum follows the published one [@alderson2023] with correlation 0.974 and a scatter of the differences of 91 ppm (1.10 combined $\sigma$), but lies **202 ppm lower on average**. The offset is not explained (geometry, fixed limb darkening and the standard-pipeline extraction against the paper's custom reductions are candidates; none was isolated). This test needs 207 MB of public files and is skipped without them.`,
    ],
    limits: [
      r`Channel error bars do not include the uncertainty of the shared geometry; a change of the white-light inclination moves all channels together.`,
      r`All bands are top-hats; no measured throughput curves are used. The JWST and Ariel wavelength limits are those of the mission documentation and should be checked against the instrument's current values before quoting.`,
      r`Limb darkening beyond 5.5 µm (MIRI LRS, the red end of Ariel AIRS-Ch1) lies outside the PHOENIX table and is extrapolated; the page flags it.`,
      r`Not read: HST/WFC3 spatial scans and any two-dimensional product ({{calints}}, {{rateints}}). NIRSpec PRISM data and the published PRISM spectrum were not compared. Sessions hold the binned channel light curves, not the cube.`,
      r`Exposure averaging uses midpoint sub-samples; batman's end-to-end spacing differs by 3.7 ppm in the test.`,
    ],
    refs: ['alderson2023', 'tinetti2018', 'husser2013', 'kreidberg2015', 'winn2008', 'mancini2018'],
  },

  // =================================================================================================================
  {
    id: 'derived', title: 'Derived quantities and uncertainty propagation', code: ['src/core/derive.js', 'src/core/session.js (summarizeFit)', 'src/main.js', 'src/core/stellar.js', 'src/core/hz.js'],
    body: [
      r`The system table (modelled on Table 7 of [@pearson2022]) is computed from the fitted parameters and the stellar inputs:`,
      { table: { head: ['Quantity', 'Expression'], rows: [
        ['transit depth', r`$k^2$ (geometric, no limb darkening)`],
        ['planet radius', r`$k\,R_\star$`],
        ['semi-major axis', r`$(a/R_\star)\,R_\star$`],
        ['impact parameter', r`$b = (a/R_\star)\cos i\,(1-e^2)/(1+e\sin\omega)$; at eclipse with $1 - e\sin\omega$`],
        ['durations, eclipse and periastron times', r`numerical, see [Kepler solver and orbits](#orbits)`],
        ['stellar density', r`$\rho_\star = 3\pi (a/R_\star)^3/(G P^2)$ (planet mass neglected)`],
        ['equilibrium temperature', r`$T_\mathrm{eq} = T_\mathrm{eff}\sqrt{R_\star/2a}$ (zero albedo, full redistribution, at the semi-major axis)`],
        ['insolation', r`$R_\star^2\,(T_\mathrm{eff}/5772\,\mathrm{K})^4/a^2$ in Earth units, $a$ in au`],
        ['velocity semi-amplitude', r`$K$ of [Radial velocities](#rv), when the planet has a mass`],
        ['planet density', r`from $M_p$ and $k R_\star$`],
      ] } },
      { h: 'Propagation' },
      r`Derived quantities are computed on equal-weight posterior draws (600), one evaluation per draw, and summarised by the median and the 15.87% and 84.13% quantiles, so correlations between parameters are carried through. In the analyzer, $R_\star$, $M_\star$ and $T_\mathrm{eff}$ are drawn for each sample from normal distributions with their input uncertainties, unless they were fitted or are tied through Kepler's law or the velocities, in which case the fitted or held values are used. In the headless path ({{runSession}}, the Python package) the stellar values are used as given, **without** their uncertainties, unless they were free parameters.`,
      { h: 'Stellar mass and radius' },
      r`When only $T_\mathrm{eff}$, $\log g$ and [Fe/H] are known, mass and radius come from the eclipsing-binary calibration of [@torres2010], with its scatter (0.027 dex in $\log M$, 0.014 dex in $\log R$) added in quadrature to the propagated input errors; the result is flagged as extrapolated below 0.6 $M_\odot$ or outside 3800 to 10000 K.`,
      { h: 'Habitable zone' },
      r`The limits are the effective fluxes of [@kopparapu2013; @kopparapu2014], $S_\mathrm{eff} = S_\odot + aT + bT^2 + cT^3 + dT^4$ with $T = T_\mathrm{eff} - 5780$ K (clamped to 2600 to 7200 K), converted to $d/R_\star = 215.032\,(T_\mathrm{eff}/5780)^2/\sqrt{S_\mathrm{eff}}$. The band drawn is averaged over the $T_\mathrm{eff}$ uncertainty and an albedo range; the albedo scaling is a heuristic of this application, not part of the published limits.`,
    ],
    checks: [
      { topic: 'relations', rows: [3, 2] },
      r`For HD 80606 b the catalogue look-up selects [@pearson2022] and the system table is compared with its Table 7 in {{node test/catalog.test.mjs}}; the eclipse duration is the exception described under [Kepler solver and orbits](#orbits).`,
    ],
    limits: [
      r`A planet radius or mass in physical units is only as good as the stellar radius and mass. If the star was held fixed, the quoted uncertainty of $R_p$, $a$ and $M_p$ excludes the stellar uncertainty in the headless path and includes it only through the resampling described above in the analyzer. State which applies.`,
      r`The equilibrium temperature assumes zero albedo and full redistribution. The transit depth is $k^2$, not the limb-darkened minimum of the light curve.`,
      r`The Torres calibration returns 1.05 $M_\odot$ and 1.02 $R_\odot$ for solar inputs, the known offset of that relation.`,
    ],
    refs: ['pearson2022', 'torres2010', 'kopparapu2013', 'kopparapu2014', 'winn2010'],
  },

  // =================================================================================================================
  {
    id: 'catalogue', title: 'Catalogue sources, merging and provenance', code: ['src/core/catalog.js', 'src/core/sources/', 'src/core/relations.js', 'tools/build_catalog.py', 'tools/build_catalog_table.py', 'tools/build_catalog_eu.py', 'tools/build_esl_catalog.py'],
    body: [
      { h: 'Sources' },
      r`The site works from dated snapshots, because the archives cannot be queried from a browser page. (1) The NASA Exoplanet Archive [@akeson2013] Planetary Systems table {{ps}}, every published reference of every planet, and the composite table {{pscomppars}}, through its TAP service. (2) The Extrasolar Planets Encyclopaedia, exoplanet.eu [@schneider2011], from its CSV export. (3) The TESS Objects of Interest table [@guerrero2021] as served by the NASA archive. Each snapshot records its date, query and row counts; the merged offline catalogue ({{public/esl-catalog/}}) carries checksums of its inputs.`,
      { h: 'Choosing the parameters of a planet' },
      r`For a look-up in the analyzer, every reference of the planet is scored and the highest score is used ({{chooseParameters}}): 100 × completeness (weighted by what the chosen kind of analysis needs; a derivable quantity counts in part) + consistency (−25 per failed check, −60 per fatal one, −8 per warning, +1.5 per passed check up to 6) + recency (up to 3) + small terms (the archive's default flag, stellar parameters from the same paper, candidates and controversial planets marked down). The consistency checks compare a reported quantity with the value implied by the reference's other numbers and count the difference in $\sigma$ with a fractional floor: $a/R_\star$ against Kepler's third law; stellar density from $a/R_\star$ and $P$ against $M_\star$, $R_\star$; $\log g$ against $M_\star$, $R_\star$; $a$ against $(a/R_\star)R_\star$; the impact parameter; the transit duration (numerical); the depth against $k^2$; $k$ against the radii; $K$ against the mass; periastron outside the star; the transit geometry. A difference up to $3\sigma$ passes, up to $5\sigma$ warns, beyond fails.`,
      r`Whatever the chosen reference lacks is filled in a fixed order and **labelled**: reported by the chosen reference; derived from its own numbers; taken from another reference (named); derived from a mix; assumed (for example $e = 0$ when only an upper limit exists, or [Fe/H] = 0). The page shows every value with its label and source, and the alternatives with their scores.`,
      { h: 'Merging catalogues' },
      r`For the Search and Plan pages the two planet catalogues are matched in stages: identical normalised names; aliases; host and planet letter; then position within 1 arcminute with periods within 3%. A match from the later stages is rejected when the positions differ by more than 0.25° (unless the periods agree to 0.1%) or the periods by more than 20%. Period and epoch are always taken from the same catalogue. Values that differ by more than $3\sigma$ and by more than a per-quantity floor are marked as disagreeing. For the planner, the ephemeris is the published ($P$, $T_0$) pair that predicts the smallest timing uncertainty today, $\sqrt{\sigma_{T_0}^2 + (N\sigma_P)^2}$.`,
      { h: 'Estimates' },
      r`Missing quantities are estimated from named relations, never overwriting a catalogue value, and marked as estimates (with a flag when an estimate is built on another estimate): the mass-radius relation of [@chen2017] (no mass above the radius where it stops being single-valued); the dwarf sequence of [@pecaut2013]; [@torres2010]; and exact geometry for depth [@seager2003], duration and impact parameter [@winn2010], equilibrium temperature (zero albedo, full redistribution) and $K$. The relation of [@otegi2020] is implemented as an alternative.`,
    ],
    checks: [
      { topic: 'relations', rows: [0, 1, 2] },
      r`Snapshot of 2026-11-15 (the index files under {{public/catalog*/}} and {{public/esl-catalog/manifest.json}}): 40,414 rows of {{ps}} for 6,470 planets around 4,862 hosts; 8,479 exoplanet.eu planets; 8,175 TOIs; 8,561 planets in the merged catalogue, 6,388 matched in both (5,882 by name, 254 by alias, 31 by host and letter, 221 by position).`,
      r`Selection logic on constructed references with planted inconsistencies and on real systems: {{node test/catalog.test.mjs}}, {{node test/sources.test.mjs}}, {{node test/eslcatalog.test.mjs}}.`,
    ],
    limits: [
      r`The scoring weights and thresholds are judgement calls, not calibrated against anything. The chosen reference is a starting point; a paper should cite the original publications of the values it uses, which the provenance labels identify.`,
      r`Catalogue values are not re-derived from data. Time systems are flagged but not converted. Choosing an ephemeris by its quoted errors favours publications with optimistic errors.`,
      r`Population relations have large scatter and are not measurements. Estimated values must not be reported as measured.`,
      r`TOIs are not matched to confirmed planets. Only the offline path of the merged-catalogue builder has been run.`,
    ],
    refs: ['akeson2013', 'schneider2011', 'guerrero2021', 'chen2017', 'otegi2020', 'pecaut2013', 'torres2010', 'seager2003', 'winn2010'],
  },

  // =================================================================================================================
  {
    id: 'observability', title: 'Observability and sky positions', code: ['src/core/observability.js', 'src/core/astro.js', 'src/core/asteroids.js', 'src/core/horizon.js', 'src/core/skyfield.js', 'src/core/healpix.js'],
    body: [
      r`Two modules compute positions; both take UT1 = UTC and use the algorithms of [@meeus1998]: IAU 1976 precession, the mean sidereal time of 1982, a four-term nutation, the low-precision Sun (chapter 25) and a truncated lunar theory (chapter 47). The sky view ({{astro.js}}) adds the planets from the Keplerian elements of [@standish] with light-time iteration, apparent sidereal time, and refraction for display by the formulas of Bennett and Sæmundsson as given by [@meeus1998] (see also [@bennett1982]). The planner ({{observability.js}}) uses mean sidereal time for the target, topocentric parallax for the Moon, and the airmass of [@kasten1989].`,
      { h: 'Which transits are observable' },
      r`Transit $n$ is at $T_n = T_0 + nP$, converted from $\mathrm{BJD}_\mathrm{TDB}$ to UTC, with ingress and egress at $T_n \mp T_{14}/2$. Its mid-time uncertainty is`,
      { eq: r`\sigma_n = \sqrt{\sigma_{T_0}^2 + (n\,\sigma_P)^2}` },
      r`which assumes $T_0$ and $P$ uncorrelated. A transit is listed as observable in full when the whole region of interest, from one hour before ingress to one hour after egress, has the target above 30° altitude with the Sun below −18°; complete transits with a shorter baseline, and partial ones, are listed as such. All three limits are settings. Rise, set and twilight times are found by sampling every 10 minutes and bisecting.`,
      { h: 'Bright asteroids and paths' },
      r`The sky view draws eight bright asteroids (Ceres, Pallas, Juno, Vesta, Hebe, Iris, Hygiea, Eunomia) from osculating elements of the JPL Small-Body Database bundled in {{asteroids.js}} (epoch JD 2461200.5 TDB, ecliptic J2000), propagated as two-body orbits about the Sun (Kepler's equation as for the planets), with light-time iteration and the Earth of {{astro.js}}; magnitudes are the IAU $H, G$ system of Bowell et al. (1989) with $H$ and $G$ from the same database. A card's "Show path" draws where a satellite (SGP4), the Moon, a planet or an asteroid goes: across the sky tonight, or among the stars over ±3 days to ±6 months (drawn in J2000, so it turns with the stars), with time or date ticks.`,
      r`Against JPL Horizons (geocentric astrometric RA and Dec, five dates from 200 days before the epoch to a year after, {{test/asteroids.test.mjs}}): at most 56″ within 200 days of the epoch and 138″ a year after it (Hygiea; the other seven under 40″), magnitudes within 0.003 mag. Perturbations by the planets are not modelled, so the error keeps growing away from the epoch; the elements are refreshed by {{test/make_asteroid_reference.py}}.`,
      { h: 'Terrain horizon' },
      r`The horizon profile is traced through elevation tiles (Mapzen/Tilezen Terrarium) along great circles out to 150 km on a spherical Earth, with terrestrial refraction through an effective radius $R/(1 - k)$, $k$ = 0.13.`,
      { h: 'Survey image of a field' },
      r`The sky view shows a real image of a target's field from an open survey (DSS2, 2MASS, Pan-STARRS DR1, SDSS DR9, DESI Legacy Surveys DR10 or AllWISE, as HiPS maps of CDS). Each image is a square of 512 pixels on one gnomonic (TAN) plane about the target [@calabretta2002], north up and east to the left; neighbouring images lie on the same plane, so the mosaic and its overlays stay continuous. The page resamples the survey's HiPS tiles onto that grid itself (nearest pixel, at the shallowest tile order whose pixels are no larger than the image's): each output pixel's direction is located in the HEALPix nested scheme of Górski et al. (2005) at the order of the tile pixels, its upper bits naming the tile and its lower bits the pixel inside it. CDS hips2fits, given the same WCS, is the fallback.`,
      r`The stars are Gaia DR3 [@gaia2023] from VizieR [@ochsenbein2000], moved to the date shown by their proper motions. The target is the Gaia star nearest to the catalogue position within 8″, the one closest to the catalogue's V when several are; a neighbour is a possible comparison star when its $\Delta G = G - G_\star$ lies in the chosen range, Gaia does not flag it as variable, it is more than 10″ from the target and, with a detector outline, inside the outline. Separations are the haversine formula; position angles, east of north, are`,
      { eq: r`\theta = \mathrm{atan2}\left(\sin\Delta\alpha\cos\delta_2,\ \cos\delta_1\sin\delta_2 - \sin\delta_1\cos\delta_2\cos\Delta\alpha\right)` },
    ],
    checks: [
      { topic: 'sky', rows: [0, 1, 2, 3, 4, 5] },
      { topic: 'planner', rows: [0, 1, 2, 3, 4] },
    ],
    limits: [
      r`Positions are good enough to find and frame a target and to decide observability, not for astrometry: annual aberration of stars (20″), proper motion, parallax and polar motion are not modelled, and Jupiter and Saturn are limited to about 10′ by the simple elements.`,
      r`Planner altitudes are geometric (no refraction). The planner's barycentric correction uses the Sun's centre and is good to about 4 s.`,
      r`The ephemeris uncertainty ignores the covariance of $T_0$ and $P$ and trusts the published errors; an ephemeris that is stale or optimistic gives a window that is too narrow.`,
      r`The comparison with the Swarthmore transit finder covers one site and one week. Terrain data have 30 m to 300 m pixels and contain no buildings or trees; summits come out 0.08° to 0.14° low in the three places checked.`,
      r`Survey images are for finding a field and judging its comparison stars, not for photometry: they are the survey's display images (JPEG or PNG, stretched), resampled to the nearest pixel. ΔG is in Gaia's G band, not the observer's filter. The hips2fits fallback has not been seen to answer (CDS returned HTTP 404 on 2026-11-16), so its use of the WCS is untested.`,
    ],
    refs: ['meeus1998', 'standish', 'bennett1982', 'kasten1989', 'jensen2013', 'astropy2022', 'anderson2012', 'calabretta2002', 'gaia2023', 'ochsenbein2000'],
  },

  // =================================================================================================================
  {
    id: 'photometry', title: 'Image photometry', code: ['src/core/photometry.js', 'src/core/fits.js', 'src/photometry/pipeline.js', 'src/photometry/transitfit.js'],
    body: [
      r`The photometry page turns a stack of FITS frames, or a TESS, Kepler or K2 target pixel file, into a differential light curve. The method follows EXOTIC [@zellem2020], with the differences listed below. Pixel centres are at integer coordinates.`,
      { ul: [
        r`**Sky.** The median of the pixels whose centres lie in an annulus around the star, after iterative clipping at 3σ about the median (5 iterations). The annulus starts 2 px outside the aperture.`,
        r`**Centroid.** A flux-weighted centroid above a threshold of 3σ over the local sky in a box, re-centred until it moves by less than 0.01 px, followed by a Gaussian-windowed centroid. Stars are tracked from frame to frame; when the field jumps, rotates or flips (meridian flip), sources are re-detected and matched by triangle similarity [@groth1986; @valdes1995; @beroiz2020] and a similarity transform is fitted.`,
        r`**Aperture sum.** The exact overlap area of a circle (or an ellipse of the same area) with each pixel, the algorithm of photutils [@bradley]. Flux = sum − area × sky.`,
        r`**PSF photometry.** An elliptical Gaussian, $B + A\exp[-(x'^2/2\sigma_x^2 + y'^2/2\sigma_y^2)]$ with flux $2\pi A\sigma_x\sigma_y$, or a Moffat profile, $B + A(1 + r^2/\gamma^2)^{-\beta}$ with flux $\pi A\gamma^2/(\beta - 1)$, fitted to a box by unweighted Levenberg-Marquardt with analytic derivatives; the model is averaged over each pixel when the star is undersampled.`,
        r`**Optimal extraction.** The sky-limited estimator of [@naylor1998] with a Gaussian profile $P$ taken from the brightest well-fitted star of the frame: $F = \sum P\,(d - B)/\sum P^2$. The pixel variance is assumed uniform.`,
        r`**Comparison stars.** The target's flux is divided by one comparison star or by the unweighted sum of all of them; the alternative "no comparison star" is always tried.`,
        r`**Choice of aperture, annulus and comparison.** Every combination of 12 aperture radii from 1.5 to 6 times the PSF σ of the first frame, 4 annulus widths from 6 to 15σ, each comparison choice, and the PSF and optimal fluxes, is reduced to a light curve; the one with the smallest scatter of residuals is kept. The residuals are from a least-squares fit of a baseline linear in airmass (or time) and a trapezoidal transit, located once and then held to the same window for every candidate, with one pass of clipping at 4 robust σ. With a known planet the candidates can instead be scored with the transit model of this document through the same likelihood, with EXOTIC's bounds.`,
        r`**Calibration.** Bias, dark and flat frames found among the files (IMAGETYP, OBSTYPE or the file name) are combined pixel by pixel with the median. The master dark and master flat have the master bias subtracted; the flat is divided by its median. Each light frame becomes (frame − bias − dark) / flat; pixels where the flat is below 0.05 are blanked.`,
        r`**Airmass** is read from the header or computed as $\sec z$.`,
        r`**Time.** Mid-exposure UTC converted to $\mathrm{BJD}_\mathrm{TDB}$ as described under [Time standards](#conventions).`,
      ] },
      { h: 'Uncertainties' },
      r`The uncertainty attached to every point of the exported light curve is one number: the robust scatter (1.4826 × median absolute deviation) of the residuals of the fit just described, relative to the median flux. A photon-noise estimate is computed for diagnosis only,`,
      { eq: r`\sigma_F^2 = \frac{F}{g} + n_\mathrm{pix}\,\sigma_\mathrm{sky}^2\left(1 + \frac{n_\mathrm{pix}}{n_\mathrm{sky}}\right), \qquad \frac{\sigma_R}{R} = \sqrt{\frac{\sigma_T^2}{T^2} + \frac{\sigma_C^2}{C^2}}` },
      r`in ADU, with $g$ the gain in e⁻/ADU (from the header keywords GAIN or EGAIN, or typed; 1 when unknown), $\sigma_\mathrm{sky}$ the scatter in the annulus (which contains sky, read and dark noise), $n_\mathrm{pix}$ the aperture area, $n_\mathrm{sky}$ the annulus area, and $R = T/C$ the ratio of target to comparison.`,
      { h: 'Detrending' },
      r`For pointing-driven systematics (K2, TESS) two detrenders are offered: the self-flat-field of [@vanderburg2014] (flux against arclength along the principal axis of the centroids, in windows, with a running-median trend removed) and a Gaussian process with a squared-exponential kernel on the centroid coordinates (optionally time), whose hyperparameters maximise the marginal likelihood on a subset of points; the light curve is divided by 1 + trend.`,
    ],
    checks: [
      { topic: 'photometry', rows: [0, 1, 2, 3, 6] },
      r`EXOTIC's sample frames (HAT-P-32 b, 142 MicroObservatory frames) reduced by both codes: {{node test/exotic_photometry.test.mjs}}. The numbers are in the reproducibility table below; the two reductions choose different apertures and comparison stars and their $R_p/R_\star$ differ by 2.3σ.`,
    ],
    limits: [
      r`The exported error bars are a single empirical scatter, the same for every point; they do not follow airmass, clouds or the star's count rate, and they include any real signal that the trapezoid does not describe. There is no read-noise or scintillation term in the per-point estimate, and the gain defaults to 1 e⁻/ADU.`,
      r`Choosing the aperture and comparison star that minimise the residual scatter of a transit fit is a selection on the data: it can bias the scatter low. On EXOTIC's sample the choice of comparison star moves $R_p/R_\star$ by more than its formal uncertainty.`,
      r`Darks are not scaled by exposure time: dark frames must have the light frames' exposure (or be left out). The flat is not dark-subtracted. There is no saturation or non-linearity correction beyond flagging saturated stars and leaving them out of the comparison candidates.`,
      r`Checked on synthetic frames, two archived TESS and Kepler pixel files, and one set of real ground-based frames compared with EXOTIC's reduction of the same frames; no reduction here has been compared with a published light curve. At EXOTIC's own aperture this code's scatter is higher (0.599% against 0.573%) and the reason was not found.`,
      r`HCOMPRESS-compressed FITS files are not read.`,
    ],
    refs: ['zellem2020', 'bradley', 'naylor1998', 'groth1986', 'valdes1995', 'beroiz2020', 'vanderburg2014', 'merline1995', 'ricker2015', 'borucki2010'],
  },

  // =================================================================================================================
  {
    id: 'spacelc', title: 'TESS, Kepler and K2 light curves: quality, stitching, transit-aware detrending, K2 systematics', code: ['src/core/lcprep.js', 'src/core/k2.js', 'src/core/zip.js', 'src/photometry/prep.js', 'src/photometry/mast.js'],
    body: [
      r`The photometry page lists every product the public MAST bucket holds for a star (SPOC 2-minute and 20-second postage stamps, TESS-SPOC and QLP products of the full-frame images, Kepler and K2 long and short cadence; light curves and target pixel files) and loads one product per sector, as the owner's TOI extraction does: 20 s and 2 min of the same sector are the same photons and must not both enter a likelihood. A target pixel file is reduced with the aperture search of the previous section.`,
      { ul: [
        r`**Quality.** lightkurve's bitmasks [@lightkurve2018]: 'default' (TESS 17087, Kepler and K2 1130799) unless another preset is chosen. Light-curve files: PDCSAP (or SAP) with the same mask.`,
        r`**Stitching.** Each sector (quarter, campaign) is divided by its own median; a cadence less than 1 s after another is dropped.`,
        r`**Transit mask.** Points with $|((t - T_0 + P/2) \;\mathrm{mod}\;P) - P/2| < 1.5\,T_{14}/2$ for any known planet, $T_{14} = (P/\pi)\,\mathrm{arcsin}\left(\sqrt{(1+k)^2 - b^2}/(a/R_\star \sin i)\right)$ (with the eccentric factor); planets from the catalogue and the TOI list [@guerrero2021], or typed.`,
        r`**Trend.** wotan's time-windowed biweight [@hippke2019]: for every point, Tukey's biweight location (c = 5, from the median and the MAD, iterated to $10^{-6}$ MAD) of the unmasked points within $\pm w/2$, segments split at gaps longer than 1 h. With "auto" the window $w$ is chosen per sector by injecting box transits of the longest duration (1500 ppm) away from the real ones, unmasked, and maximising recovered depth × $\sqrt{T_{14}/\Delta t}$ / noise (EXOTIC's optimize_window).`,
        r`**Clip and trim.** 4σ about a Savitzky–Golay smooth of 30 min, never in transit; 30 min after every gap longer than an hour.`,
        r`**Windows.** $\pm 2.5\,T_{14}$ around every predicted transit with points inside it; another planet's transit in a window is reported and, when its geometry is known, divided out.`,
        r`**K2.** Pixel-level decorrelation [@deming2015] as EVEREST [@luger2016; @luger2018] and lightkurve's PLDCorrector set it up for K2: the 3σ threshold-mask pixels over the aperture flux, their products to third order (16 principal components per order), the principal components of the background pixels (below the median image, normalised), a degree-5 B-spline in time with $n/50$ columns for the star, fitted jointly by least squares with Gaussian priors (10× the flux scatter) and 5σ clipping, five times; the pixel and background parts are removed. Thruster firings are flagged from QUALITY bits 20 and 21 and from 5σ jumps of the centroid along the roll arc [@vanderburg2014].`,
        r`**CDPP** is lightkurve's estimate_cdpp (Savitzky–Golay flatten, 5σ clip, the standard deviation of a 13-cadence running mean), with both lengths scaled from Kepler's 29.4-minute cadence when sectors of other cadences are compared.`,
        r`**Zips.** Zip archives are read from their central directory (ZIP64 included); a deflated entry becomes the slice of the archive between a 10-byte gzip header and a trailer made from the directory's CRC-32 and size, so frames are inflated one at a time as the pipeline reads them.`,
      ] },
    ],
    checks: [
      r`Against lightkurve 2.6 on the WASP-18 (TESS), TrES-2 (Kepler) and K2-3 (K2) pixel files: the cadences of every quality preset, times to 0 µs, aperture flux 3e-7 and centroids 3e-7 of the CCD coordinate (lightkurve sums float32), SAP_FLUX of the pipeline's light-curve files to 1.2e-7, threshold masks identical, CDPP to 4e-5: {{node test/tpf_lightkurve.test.mjs}}.`,
      r`Biweight trend against wotan to 1.9e-9 with and without transit masks, EXOTIC's T14, mask, clip, trim, binning, window injection (7e-7) and alias scan exactly, lightkurve's flatten (5e-12) and CDPP (1e-8), the chain on TrES-2's pixels (trend 2.4e-7, depth 13184 ppm both): {{node test/lcprep.test.mjs}}.`,
      r`K2-3, campaign 1, CDPP at 6.5 h: raw SAP 5822 ppm; self-flat-field 326 ppm (lightkurve SFFCorrector 158); PLD order 3 40.2 ppm (lightkurve PLDCorrector 48.0; the pipeline's PDCSAP 186); thruster firings from the centroid match 154 of 172 flagged cadences: {{node test/k2.test.mjs}}.`,
      r`Zips written by Python's zipfile (stored, deflated, ZIP64, nested, .fits.gz inside) and EXOTIC's sample-data zip: {{node test/zip.test.mjs}}.`,
    ],
    limits: [
      r`TESScut cutouts, TGLC, K2SFF and EVEREST light curves cannot be fetched from a page (no CORS, or not in the bucket). Sectors of different cadence go to the analyzer as one light curve with one exposure time (the median); the analyzer does not yet read the window index the hand-off carries ("Split by orbit" does the same).`,
      r`The self-flat-field here is worse than lightkurve's on the whole K2-3 campaign (326 against 158 ppm) and better on its first 24 days; the reason was not found. Dropping the unflagged thruster firings did not lower the CDPP of K2-3.`,
      r`The window injection is EXOTIC's procedure; its point counts are scaled for cadences coarser than 2 min, and on a quiet star (TrES-2) every window recovers the injected depth equally, so the choice is then arbitrary.`,
    ],
    refs: ['hippke2019', 'lightkurve2018', 'guerrero2021', 'deming2015', 'luger2016', 'luger2018', 'vanderburg2014'],
  },

  // =================================================================================================================
  {
    id: 'imexam', title: 'Image inspection, focus and comparison stars', code: ['src/core/imexam.js', 'src/photometry/inspect.js', 'src/core/lcfits.js'],
    body: [
      r`The photometry page has the inspection tools of IRAF's imexam [@tody1986] and SAOImage DS9 [@joye2003]: a radial profile, a line cut, region statistics, a pixel table, the FITS header, and a map of the focus across the field. They act on the frame shown, calibrated as above.`,
      { ul: [
        r`**Radial profile.** The centre is refined as for photometry. The sky is the 3σ-clipped median of the pixels between $r_\mathrm{max} + 2$ and $r_\mathrm{max} + 8$ px. A Gaussian $A e^{-r^2/2\sigma^2}$ (FWHM $2\sqrt{2\ln 2}\,\sigma$) and a Moffat profile $A(1 + r^2/\gamma^2)^{-\beta}$ [@moffat1969] (FWHM $2\gamma\sqrt{2^{1/\beta} - 1}$) are fitted by least squares to every pixel inside $r_\mathrm{max}$, sky subtracted. The binned profile drawn is the mean in 1 px annuli with exact pixel overlaps, as photutils' RadialProfile [@bradley]. $r_\mathrm{max}$ is set to about 3 FWHM after a first pass.`,
        r`**Curve of growth and half-flux diameter.** Sky-subtracted sums in circles every 0.25 px with exact overlaps. The half-flux diameter (HFD) is twice the radius holding half the flux inside $r_\mathrm{max}$, found by linear interpolation; it equals the FWHM for a Gaussian and is the usual focusing number because it does not depend on the profile's shape.`,
        r`**Signal to noise.** $F/\sqrt{F/g + n_\mathrm{pix}\sigma_\mathrm{sky}^2}$ for the circle of radius $r_\mathrm{max}$.`,
        r`**Saturation.** SATURATE, SATLEVEL, DATAMAX or MAXLIN from the header, else the largest value of the integer format (with BZERO and BSCALE).`,
        r`**Elongation.** A Gaussian with free position angle fitted to a box of about 2 FWHM (the PSF fit of the photometry): ellipticity $1 - b/a$ and the direction of the major axis.`,
        r`**Focus across the field.** Stars are detected, and saturated stars, stars with a neighbour brighter than 5% of their flux within 2.5 box half-widths, and failed fits are dropped. Each remaining star gets the rotated Gaussian fit (twice: the second with a box of 4σ of the median star). The field is cut into $n \times n$ cells, each with the median FWHM and ellipticity and the ellipticity-weighted mean of $e^{2i\theta}$. A quadratic surface in $x, y$ is fitted to the FWHM with one 3σ rejection; its minimum, when inside the frame, is marked as the sharpest point. The summary compares the corner cells with the centre cell (curvature), the corners with each other (tilt), and reports $|\langle e\,e^{2i\theta}\rangle| / \langle e\rangle$, near 1 when every star is stretched the same way (tracking, guiding, wind) and near 0 for optical patterns, and $\langle e \cos 2(\theta - \phi)\rangle / \langle e\rangle$ over stars away from the centre ($\phi$ the direction from the centre: +1 radial, −1 tangential).`,
        r`**Ranking comparison stars.** For each detected star: $|\ln(F/F_\mathrm{target})|$, plus 3 when the flux ratio is outside 1/10 to 10, plus 10 when saturated, plus $1 + 2(4 - d)/4$ when a neighbour brighter than 10% of it lies within $d < 4$ FWHM, plus 2 within 4 FWHM of the edge, plus 1.5 when its FWHM exceeds the median by 30% (a blend or a galaxy), plus 1 when its ellipticity exceeds both 0.3 and the median of the field by 0.15 (a field where every star is stretched the same way singles none out). Lower is better; the four best usable stars are proposed when only the target is chosen. The light-curve search still tries every comparison choice and keeps the one with the least scatter.`,
        r`**FITS light-curve tables.** The analyzer reads TESS, Kepler and K2 light-curve files: the first binary table, TIME plus BJDREFI + BJDREFF (BTJD = BJD$_\mathrm{TDB}$ − 2457000, BKJD = BJD$_\mathrm{TDB}$ − 2454833), the first of PDCSAP_FLUX, KSPSAP_FLUX, DET_FLUX, FCOR, FLUX, SAP_FLUX (or a column chosen by name) with its error column, rows with a non-zero QUALITY flag or a blank time or flux left out, and flux and errors divided by the median.`,
      ] },
    ],
    checks: [
      r`Against photutils and scipy on six stars of a real frame (EXOTIC's HAT-P-32 b sample), and on synthetic stars and fields: {{node test/imexam.test.mjs}}. FITS tables written by astropy in the SPOC and Kepler layouts: {{node test/lcfits.test.mjs}}.`,
    ],
    limits: [
      r`The FWHM fits assume a round profile; the elongation comes from a separate elliptical fit. Undersampled stars (FWHM below about 2 px) are fitted to pixel values without averaging the model over the pixel, which widens the FWHM by about $\sqrt{\sigma^2 + 1/12}/\sigma$ (2% at σ = 1.5 px).`,
      r`The focus verdicts use fixed thresholds (15% for curvature and tilt, ellipticity 0.12 to 0.15, coherence 0.6) chosen on synthetic fields; they describe the frame, not its cause. Seeing and wind change from frame to frame, so a single frame can mislead.`,
      r`Comparison stars are ranked on one frame, and from the image alone variability and colour are not known; with sky coordinates the next section adds both from Gaia DR3 and VSX.`,
      r`Saturation is read from the header or the data format only; a camera that saturates below its format limit (common for 16-bit CMOS) is not recognised without a SATURATE keyword.`,
    ],
  },
  {
    id: 'platesolve', title: 'Sky coordinates, the target by name, Gaia comparison stars and optimal apertures', code: ['src/core/platesolve.js', 'src/core/fieldstars.js', 'src/core/imexam.js', 'src/photometry/wcs.js'],
    body: [
      r`The photometry page gives the first frame a world coordinate system (WCS) without an account or a key: its stars are matched to Gaia DR3 [@gaia2016; @gaia2023], fetched from VizieR [@ochsenbein2000] by the page, and a gnomonic (TAN) projection [@calabretta2002] is fitted to the pairs. A WCS already in the header is used as it is; one returned by astrometry.net [@lang2010] can be loaded from its wcs.fits. The other frames get theirs through the frame-to-frame transform of the reduction (triangle matching of their stars to the first frame's).`,
      { ul: [
        r`**Pointing and scale.** The target's position from what the user types (coordinates, or a name looked up in the site's catalogue and then in CDS Sesame), else the header RA / DEC (OBJCTRA, OBJCTDEC, ...); the scale from the header (IM_SCALE, PIXSCALE, ..., the CD matrix, or $206.265\,p/f$ from XPIXSZ and FOCALLEN) within ±15%, else from 0.25 to 18″/px in six overlapping steps of ±42%. Gaia stars to $G < 19.5$ (the brightest 3000) are taken within one image diagonal of the target, or 0.75 of a diagonal of the header pointing, and moved to the frame's epoch with their proper motions.`,
        r`**Stars.** Those of the frame's detection, each re-centred by a Gaussian fit (the box centroid is pulled by neighbours and the sky on undersampled frames). Only as many Gaia stars are used as about twice the number detected per field area, brightest first.`,
        r`**Matching.** Triangles of the 22 brightest stars and of the brightest catalogue stars, sides between 6% and 80% of the short side of the frame, are compared by their side ratios $(r_1, r_2) = (a/c, b/c)$ within 0.008 [@groth1986; @valdes1995]; mirror images are allowed (orientations opposite), and the scale $c_\mathrm{sky}/c_\mathrm{pix}$ must lie in the allowed range. Each pair of similar triangles proposes a similarity transform (scale, rotation, parity, offset); the proposals are binned (0.02 in ln scale, 2° in rotation, a few pixels in offset), and the 60 best-supported are checked against every detected star: the transform bringing the most stars within 2.5 px of a catalogue star wins after five rounds of re-matching and refitting. It is accepted with at least $\max(6, 2\lambda + 3)$ pairs, $\lambda$ being the number expected by chance from the density of catalogue stars.`,
        r`**Fit.** The standard coordinates $(\xi, \eta)$ of the catalogue stars about a tangent point are fitted by linear least squares as polynomials in the pixel offsets $(u, v)$ from CRPIX (the image centre): degree 1 gives the CD matrix, degree 2 is TAN-SIP [@shupe2005] with $A_{pq}, B_{pq} = \mathrm{CD}^{-1}$ times the quadratic coefficients. CRVAL is moved to where the constant terms vanish and the fit repeated until it stays put. All stars are re-matched within $\min(3, \max(1, 3\,\mathrm{rms}))$ px, stars beyond 3 rms are dropped, and SIP order 2 is kept when it lowers the corrected Akaike criterion $2n\ln\mathrm{rms}^2 + 2k + 2k(k+1)/(2n - k - 1)$ (6 against 12 parameters) by 2 or more, judged on the stars the SIP fit keeps. A solution needs at least $\max(8, 3\lambda + 5)$ matched stars and an rms under 1 px. Sky to pixel inverts the SIP polynomials by Newton's method; AP and BP are fitted on a grid for the header.`,
        r`**The target.** Its catalogue position is projected with the WCS, re-centred on the star there, and offered as the target; its RA and Dec fill the BJD settings.`,
        r`**Comparison stars with Gaia.** Each detected star takes the nearest Gaia star within 1.5 px. The image ranking of the previous section is extended: plus $0.3\,|\Delta G|$, plus $\min(4, |\Delta(G_\mathrm{BP} - G_\mathrm{RP})|/0.4)$ against the target's colour (noted above 0.5 mag; extinction and the band's response differ with colour, so a colour mismatch leaves an airmass trend in the ratio), plus 10 and not usable when Gaia flags it VARIABLE or a VSX [@watson2006] entry lies within $\max(3'', 1.5\,\mathrm{px})$, plus $\min(4, 8D)$ for the light $D = \sum 10^{-0.4(G_i - G)}$ of other Gaia stars within 2 FWHM, too faint to be detected or not (not usable above 5%), plus 2 and not usable without a Gaia counterpart. The same $D$ is reported for the target, since it dilutes the transit depth.`,
        r`**Optimal aperture.** From each star's curve of growth $S(r)$, the radius maximising $S/\sqrt{S/g + \pi r^2\sigma_\mathrm{sky}^2}$ [@howell1989; @naylor1998], interpolated by a parabola through the peak; for a Gaussian star with negligible photon noise the maximum is at $1.585\sigma = 0.673$ FWHM. Without a GAIN keyword, $g = \mathrm{sky}/\sigma_\mathrm{sky}^2$ (the 3σ-clipped σ corrected by 1.3%), a lower bound because read noise adds to the variance. The radii the reduction tries are set from half to twice the target's optimum in units of its PSF σ, and at least 2σ beyond it; the light curve's scatter still decides.`,
      ] },
    ],
    checks: [
      r`The least-squares WCS against astropy's fit_wcs_from_points [@astropy2022] on the same star lists (TAN at Dec 2° and 78°, and TAN-SIP), round trips through the header and src/core/fits.js readWcs, 24 synthetic fields (random rotation, mirror, 3% scale error, pointing off by up to 40% of the field, 25% of the stars missing and 15% spurious, SIP in a quarter), an unrelated catalogue (no solution claimed), the optimal radius against the analytic maximum, the gain bound, and the real HAT-P-32 b frame against an independent solution (photutils detection, brute-force match, astropy fit), with the Gaia and VSX answers saved: {{node test/platesolve.test.mjs}}. The page against live VizieR: {{test/platesolve_check.py}}.`,
    ],
    limits: [
      r`The matcher needs about eight stars in common with Gaia and a pointing within about one image diagonal (the target's name or the header); astrometry.net solves blind and is the way out when both fail. Its API needs a key and sends no CORS headers (checked 2026-11-16), so the page cannot call it: the user uploads the frame there and loads the file it returns.`,
      r`The scale must be known to ±15% or found in the six steps (up to six catalogue queries). Distortion beyond SIP order 2 (very wide fields, fisheye lenses) is not modelled.`,
      r`Colour, magnitude and contamination use Gaia's G band, not the observer's filter. The VSX and Gaia variability flags list known variables only; a quiet star in both can still vary.`,
      r`The optimal aperture is for one frame; seeing and guiding change during a night, which is why it only centres the search.`,
    ],
  },
  {
    id: 'noise', title: 'Noise diagnostics', code: ['src/core/psd.js', 'src/core/gp.js', 'src/photometry/diagnostics.js'],
    body: [
      r`Residuals are examined in three ways. None of them enters the likelihood; they tell the user whether the white-noise assumption of the fit holds.`,
      { h: 'Power spectrum' },
      r`The one-sided power spectral density is normalised so that its integral from 0 to the Nyquist frequency is the variance: for evenly sampled data $P_k = 2\,\Delta t\,|\sum_j w_j x_j e^{-2\pi i jk/n}|^2/\sum_j w_j^2$ (not doubled at zero and Nyquist), by a fast Fourier transform, or averaged over half-overlapping Hann-windowed segments [@welch1967]; for uneven sampling the Lomb-Scargle periodogram is scaled to the same density. White noise of variance $\sigma^2$ then sits at`,
      { eq: r`P_\mathrm{white} = 2\,\sigma^2\,\Delta t` },
      r`and the level expected from the error bars is $2\,\langle\sigma_i^2\rangle\,\Delta t$. A model $P(f) = W + A f^{-\gamma}$ can be fitted to the logarithm of the (bias-corrected) spectrum; red noise is flagged when it improves the fit significantly and the knee lies inside the sampled band.`,
      { h: 'Gaps, stitched data and changed exposure times' },
      r`On the photometry page the spectrum of the residuals is the Lomb-Scargle PSD of every unbroken stretch, each scaled with its own median cadence, averaged on one frequency grid with weights equal to the number of points; a stretch ends where a step exceeds five times the larger of the median steps just before and just after it, so a change of cadence (stitched 2-min and 30-min data, a longer exposure later in the night) is not a gap and a real gap is. The white and photon-noise levels are averaged over the stretches the same way. One Lomb-Scargle over a whole gapped series takes its cadence as span / (n − 1), which a gap inflates: 4% high for a TESS sector with its downlink gap, 22 times for three nights a week apart in the test.`,
      { h: 'RMS against bin size' },
      r`The residuals are averaged in non-overlapping bins of $N$ points ($M$ bins) and the rms of the bin means is compared with the white-noise expectation [@pont2006; @winn2008], in the convention of [@cubillos2017]:`,
      { eq: r`\sigma_N^\mathrm{expected} = \frac{\sigma_1}{\sqrt{N}}\sqrt{\frac{M}{M-1}}, \qquad \beta = \max_N \frac{\sigma_N}{\sigma_N^\mathrm{expected}}` },
      r`with an uncertainty $\sigma_N/\sqrt{2M}$ and the maximum taken over bin sizes with at least 10 bins. $\beta > 1$ indicates correlated noise. On the photometry page the bins have a fixed duration ($N$ times the median cadence, laid on the clock from the start of each stretch) and need at least half their nominal points; the expectation then uses each bin's own occupancy, $\sigma_1^2\langle 1/n_b\rangle M/(M-1)$, so lost frames and changed exposure times do not shorten or lengthen the bins.`,
      { h: 'Photon and scintillation noise' },
      r`For reference the page computes the CCD equation of [@merline1995], $\sigma^2 = S + n_\mathrm{pix}(1 + n_\mathrm{pix}/n_\mathrm{sky})(gB + D + R^2) + (\sigma_\mathrm{scint} S)^2$ in electrons, and the scintillation estimate $\sigma_\mathrm{scint} = 0.09\,D^{-2/3}X^{7/4}(2t)^{-1/2}e^{-h/8000\,\mathrm{m}}$ [@young1967; @dravins1998] for a telescope of diameter $D$ (cm), airmass $X$, exposure $t$ (s) and altitude $h$.`,
      { h: 'Pixel map' },
      r`Every frame's centroid drawn as a point coloured by the relative pixel response there (1 + the fitted systematics in x and y: the kernel, Gaussian-process or order-2 polynomial surface), as in the Spitzer IRAC maps of github.com/pearsonkyle/Exoplanet-Mapping; equal scale in x and y unless the centroid cloud is more than 3 : 1, then a square box.`,
    ],
    checks: [
      r`{{node test/psd.test.mjs}} (references: scipy 1.13.1, astropy 6.0.1, MC3 3.2.1): periodogram density against {{scipy.signal.periodogram}} within 5.2e-14 of the highest peak; Welch against {{scipy.signal.welch}} within 1.0e-15; Lomb-Scargle density against astropy within 7.7e-15; rms against bin size, expectation and $\beta$ against {{mc3.stats.time_avg}} within 7.1e-15; red-noise fit against {{scipy.optimize.least_squares}} within 1.8e-8.`,
      r`Gaps and cadences (same test, synthetic white noise): a TESS-like sector with a 1.2-day gap and 2% of cadences lost averages to 1.011 of $2\sigma^2\Delta t$ (one periodogram: 1.039); three nights a week apart 0.992 (one periodogram: 22 times too high); stitched 2-min and 30-min data 0.983 of the matching level; on a night whose exposure doubles halfway with 5% of frames lost, the mean of $(\sigma_N/\sigma_N^\mathrm{expected})^2$ over 966 bins from 60 nights is 0.996, and an added random walk gives $\beta = 3.3$.`,
      { topic: 'photometry', rows: [5] },
    ],
    limits: [
      r`$\beta$ is a maximum over bin sizes and is biased high for white noise (1.14 on a 20,000-point white series in the test). MC3's asymmetric uncertainty for fewer than 36 bins is not reproduced.`,
      r`These are diagnostics. $\beta$ is not applied to the error bars and no correlated-noise model enters the fit; if the diagnostics show red noise, the posterior widths from the white-noise likelihood are too small, and the paper should say what was done about it.`,
    ],
    refs: ['welch1967', 'pont2006', 'winn2008', 'cubillos2017', 'merline1995', 'young1967', 'dravins1998', 'virtanen2020'],
  },

  // =================================================================================================================
  {
    id: 'session', title: 'The session format and reproducibility', code: ['docs/FORMAT.md', 'src/core/session.js', 'src/core/exportScript.js', 'python/', 'tools/build_example_results.py'],
    body: [
      r`An analysis is one JSON document ({{docs/FORMAT.md}}, format {{esl-session}} version 1): the star, the limb-darkening law and coefficients, the planets' parameters, the data (light curve with epochs and exposure, velocities per instrument, event times), which kinds of data enter the fit, every free parameter with its prior, every fixed value, the sampler settings including the seed, the software version, and, after a run, the result: evidence and its uncertainty, information, effective sample size, number of likelihood calls, convergence and stop reason, warnings, medians and quantiles, derived quantities, the best-fitting point with its $\chi^2$ by kind of data, and optionally equal-weight posterior draws. All times in the file are absolute.`,
      r`The same document runs in the browser, headless in Node ({{runSession}}), in the Python package, which executes the same JavaScript core rather than a translation, and through the MCP server. The Results tab also writes a Python script that rebuilds the fit with every prior as an editable line, a Markdown report and LaTeX tables.`,
      r`**To make a published result reproducible**, archive the session file with posterior draws (for example as supplementary material or in a data repository) and cite the software version it records. Re-running the file with the same version reproduces the run.`,
    ],
    checks: [
      r`{{node test/session.test.mjs}}: a session turned into a likelihood reproduces EXOTIC's $\chi^2$ on the three-planet example (light curves 324.49 against 324.49, velocities 37.58 against 37.58); a run recovers the injected masses and survives a JSON round trip.`,
      r`Python against Node on stored sessions ({{python/README.md}}, "What was reproduced"): five of six reproduce exactly (same number of likelihood calls, identical medians and $\ln Z$); {{hd80606-tess.json}} takes 12,813 calls against 12,837 and agrees to 0.004σ. An exported script run under the package reproduces the JavaScript result to 4e-14 relative ({{test/exportScript.test.mjs}}).`,
      r`Every bundled example opens with a stored posterior ({{public/examples/results/}}), rebuilt by {{tools/build_example_results.py}}; the reproducibility table below quotes those files.`,
    ],
    limits: [
      r`Identical results need the same software version and the same family of JavaScript engine: the sampler's path depends on the last digit of the engine's mathematical functions. Between Node 22 and the Python package's default runtime the call counts are identical and medians agree to 1e-15 relative; another engine may differ within sampling noise.`,
      r`The session does not record the time standard of the data, the source of fixed limb-darkening coefficients, or whether star-tied limb darkening used the table or the grey atmosphere. The paragraph generator below lists these as items to state by hand.`,
      r`The software version in a session is a string ({{0.2.0}}); no commit hash is recorded yet, and there is no archived release with a DOI. The Python package was run on macOS arm64 with Python 3.12 only and is not on PyPI.`,
      r`Star-tied limb darkening is set up by the application, not by {{specFromSession}}; outside the browser use {{prepareSession}} of the Python entry points.`,
    ],
    refs: [],
  },
];

// =====================================================================================================================
// Reproducibility: the bundled examples. "This code" values are read from the stored result of each example
// (public/examples/results/<id>.json) when the table is rendered; nothing here is a result of this code typed by hand.
// `published` values are those recorded in this repository (the file is named); where the repository holds no
// uncertainty for a published value, none is printed.
//   get: ['parameters', key] | ['derived', key] | ['calc', name]   (calc: a product formed from stored medians)
// =====================================================================================================================
const T7 = 'Pearson et al. 2022, Table 7, as recorded in test/exotic.test.mjs';
export const EXAMPLES = [
  {
    id: 'single', title: 'HAT-P-32 b, one simulated night', data: 'Simulated by this code (EXOTIC example single_transit: a ground-based night with an airmass trend).', licence: 'Generated here; no third-party data.', cite: ['zellem2020'],
    compare: [{ topic: 'exotic', row: 1 }], verdict: 'EXOTIC’s posterior on the same simulated data is reproduced within the limits shown', command: 'node test/exotic.test.mjs',
  },
  {
    id: 'multi', title: 'HAT-P-32 b, five simulated nights', data: 'Simulated by this code (EXOTIC example multiple_transit: five nights, each with its own airmass trend; the period is free).', licence: 'Generated here; no third-party data.', cite: ['zellem2020'],
    compare: [{ topic: 'exotic', row: 2 }], verdict: 'EXOTIC’s posterior on the same simulated data is reproduced within the limits shown', command: 'node test/exotic.test.mjs',
  },
  {
    id: 'hd80606-tess', title: 'HD 80606 b, TESS transit', data: 'TESS 2-minute light curve of the February 2020 transit, the file of EXOTIC’s examples/joint_rv_transit (public/examples/hd80606/2458888_08_lightcurve.csv).', licence: 'No licence stated in this repository for the file. TESS data are public (MAST); the reduced light curve is from the EXOTIC repository.', cite: ['pearson2022', 'ricker2015', 'zellem2020'],
    compare: [
      { what: 'i [°]', get: ['parameters', 'inc'], published: '89.24', source: T7 },
      { what: 'T mid [BJD]', get: ['parameters', 'tmid'], published: '2458888.07466', source: T7 },
      { what: 'Rp/R★', get: ['parameters', 'rprs'], published: 'not comparable', source: 'the published radius uses a depth corrected for the light of HD 80607; this light curve is diluted and no correction is applied (README, "System table": the fitted radius is about 30% too small)', bad: true },
    ], verdict: 'partly: the mid-time agrees; the inclination is 0.03° from the published value, 3.6 times this fit’s formal uncertainty (a/R★ is held fixed); the radius ratio is NOT reproduced (dilution)', command: '.venv/bin/python tools/build_example_results.py   # or open the example in the analyzer and press Run',
  },
  {
    id: 'hd80606-rv', title: 'HD 80606 b, velocities from seven instruments', data: '264 radial velocities (ELODIE, HIRES, HRS, SOPHIE, APF) as compiled in EXOTIC’s examples/radial_velocity (public/examples/hd80606/HD80606_RV.csv).', licence: 'No licence stated in this repository; the measurements are from the publications compiled by Pearson et al. 2022.', cite: ['pearson2022', 'zellem2020'],
    compare: [
      { what: 'K [m/s]', get: ['derived', 'K'], published: '469.22', source: T7 },
      { what: 'e', get: ['parameters', 'ecc'], published: '0.93183', source: T7 },
      { what: 'ω [°]', get: ['parameters', 'omega'], published: '−58.887', source: T7 },
      { what: 'P [d]', get: ['parameters', 'per'], published: '111.436765', source: T7 },
    ], verdict: 'reproduced within the test’s limits (K within 5 m/s, e within 0.002, ω within 0.5°, P within 0.002 d); formal errors are too small because χ² = 1555 for 264 points without jitter', command: 'node test/exotic.test.mjs',
  },
  {
    id: 'hd80606-joint', title: 'HD 80606 b, transit + velocities + timing', data: 'The TESS light curve and velocities above, four mid-transit times and one mid-eclipse time (sources named in each row of the session file).', licence: 'As the two rows above.', cite: ['pearson2022', 'zellem2020'],
    compare: [
      { what: 'P [d]', get: ['parameters', 'per'], published: '111.436765', source: T7 },
      { what: 'i [°]', get: ['parameters', 'inc'], published: '89.24', source: T7 },
      { what: 'e', get: ['parameters', 'ecc'], published: '0.93183', source: T7 },
      { what: 'ω [°]', get: ['parameters', 'omega'], published: '−58.887', source: T7 },
      { what: 'T mid [BJD]', get: ['parameters', 'tmid'], published: '2458888.07466', source: T7 },
      { what: 'K [m/s]', get: ['derived', 'K'], published: '469.22', source: T7 },
      { what: 'a/R★', get: ['derived', 'ars'], published: '94.452', source: T7 },
      { what: 'T14 [d]', get: ['derived', 't14'], published: '0.499', source: 'Pearson et al. 2022, as recorded in public/validation/orbit.json. With the paper’s own parameters this code gives 0.4985 d (test/validation.test.mjs); the stored fit differs because its radius ratio and impact parameter come from the diluted TESS light curve', bad: true },
      { what: 'eclipse duration E14 [d]', get: ['derived', 'e14'], published: '0.0717', source: 'Pearson et al. 2022, as recorded in public/validation/orbit.json; the 30-digit orbit gives 0.08337 d', bad: true },
    ], verdict: 'orbit and mass agree within the test’s limits (P within 5e-4 d, i within 0.03°, e within 0.001, K within 3 m/s), though several differ from the published values by 1.5 to 2 times this fit’s formal uncertainties, which are too small (χ² = 1675 for 1168 measurements; the star is held fixed). The transit duration of this fit and the eclipse duration are NOT reproduced', command: 'node test/exotic.test.mjs && node test/validation.test.mjs',
  },
  {
    id: 'hd80606-rm', title: 'HD 80606 b, the Rossiter–McLaughlin effect', data: 'The 264 velocities above and the five mid-times; the two partial transits in the file, SOPHIE 2009 February 14 (Moutou et al. 2009) and HIRES 2009 June 5 (Winn et al. 2009), are datasets of their own with free jitters (public/examples/hd80606/README.md). Rp/R★ held at 0.1001 (Winn et al. 2009) because the TESS radius is diluted by HD 80607; the anomaly uses quadratic limb darkening of the 390–690 nm band (the session’s rm block); no light curve in the fit.', licence: 'As the rows above.', cite: ['pearson2022'],
    compare: [
      { what: 'λ [°]', get: ['parameters', 'lambda'], published: '42 ± 8', source: 'Hébrard et al. 2010 (A&A 516, A95), from the full SOPHIE transit of 2010 January 14, which is not in this file; as quoted in test/examples_real.test.mjs' },
      { what: 'v sin i★ [km/s]', get: ['parameters', 'vsini'], published: 'about 1.7', source: 'as given in the task notes of test/hd80606rm.test.mjs (taken as ± 0.3); not re-read from a paper here' },
    ], verdict: 'λ and v sin i★ agree (about 1σ and 0.6σ) from two partial transits; the same data with the orbit fixed give 1.47 km/s and 58° (test/hd80606rm.test.mjs). The model is the first moment of the uncovered light (a CCF form exists, not used here), without exposure averaging', command: 'node test/examples_real.test.mjs && node test/hd80606rm.test.mjs',
  },
  {
    id: 'toi1873', title: 'TOI-1873, TESS + NEID (real data; planet d a candidate)', data: 'TESS SPOC light curves of 13 sectors as extracted and detrended in EXOTIC’s examples/toi-3planet, windows around every transit of b, c and d binned to 10 min (2876 points, 53 epochs); 37 NEID velocities of the published pyaneti analysis (public/examples/toi1873/README.md).', licence: 'TESS data are public (MAST). The NEID velocities and the pyaneti results were shared with the owner by collaborators; no licence is stated and they may be unpublished: decide before the repository goes public.', cite: ['ricker2015', 'barragan2019', 'zellem2020'],
    compare: [
      { what: 'P b [d]', get: ['parameters', 'per'], published: '7.0057048 +0.0000265 −0.0000208', source: 'EXOTIC/examples/toi-3planet/2p_circ_prod_params.dat (pyaneti, Barragán et al. 2019), as typed in test/examples_real.test.mjs' },
      { what: 'Rp/R★ b', get: ['parameters', 'rprs'], published: '0.02683 ± 0.00074', source: 'same' },
      { what: 'i b [°]', get: ['parameters', 'inc'], published: '88.91 +0.45 −0.43', source: 'same' },
      { what: 'Mp b [M Jup]', get: ['parameters', 'mplanet'], published: '0.0285 ± 0.0075 (9.07 ± 2.39 M⊕)', source: 'same' },
      { what: 'P c [d]', get: ['parameters', 'per@c'], published: '24.9339464 ± 0.000055', source: 'same' },
      { what: 'Rp/R★ c', get: ['parameters', 'rprs@c'], published: '0.03979 +0.00085 −0.00082', source: 'same' },
      { what: 'i c [°]', get: ['parameters', 'inc@c'], published: '89.72 +0.19 −0.24', source: 'same' },
      { what: 'Mp c [M Jup]', get: ['parameters', 'mplanet@c'], published: '0.0871 ± 0.0158 (27.7 ± 5.0 M⊕)', source: 'same' },
      { what: 'Mp d [M Jup]', get: ['parameters', 'mplanet@d'], published: 'none (candidate)', source: 'EXOTIC’s own three-planet fit gives 17.6 ± 7.1 M⊕ (examples/toi-3planet/README.md); not a publication' },
    ], verdict: 'ephemerides, inclinations and both masses agree with the published two-planet fit within 0.6σ (c’s mass 0.03σ, b’s −0.4σ); the radius ratios differ by −1.5σ (b) and +1.6σ (c). Planet d: N = 7 (128.6 d) holds 85% of the posterior, 900 d 0%; its mass is 13 +8 −7 M⊕. The run stopped at its budget of 1.5 million calls with 2.6% of the evidence possibly left (NOT converged): read ln Z as a lower limit', command: 'node test/examples_real.test.mjs   # ESL_FULL=1 reruns the sampler (about 2 hours)',
  },
  {
    id: 'toy1873', title: 'toy-1873: three planets, light curves and velocities (synthetic)', data: 'Synthetic system of EXOTIC’s examples/multi_planet (modelled on TOI-1873; the real data are the row above): three light-curve files and 40 velocities with injected truth.', licence: 'Synthetic; from the EXOTIC repository.', cite: ['zellem2020'],
    compare: [{ topic: 'exotic', row: 3 }], verdict: 'reproduced (identical χ² at the injected values)', command: 'node test/exotic.test.mjs && node test/session.test.mjs',
  },
  {
    id: 'phasecurve', title: 'WASP-43 b, full-orbit phase curve at 4.5 µm', data: 'One Spitzer IRAC channel 2 visit (BJD 2458738.3 to 2458739.4), already detrended, from github.com/pearsonkyle/Exoplanet-Mapping (commit 3af871c); binned to 120 s here.', licence: 'That repository has no licence file; it is the site owner’s repository and its README asks for its white paper to be cited (public/examples/phasecurve/README.md). Spitzer data are public (IRSA).', cite: ['stevenson2017', 'hellier2011'],
    compare: [
      { what: 'T mid [BJD]', get: ['parameters', 'tmid'], published: '2458738.834783 ± 0.000070', source: 'header of the Exoplanet-Mapping file, as recorded in public/examples/phasecurve/README.md' },
      { what: 'eclipse depth [ppm]', get: ['calc', 'depthPpm'], published: '3810 ± 100', source: 'same' },
      { what: 'hot-spot offset [°]', get: ['parameters', 'hotspot'], published: '1.6 ± 1.4', source: 'same' },
    ], verdict: 'reproduces the source repository’s own fit; the light curve was detrended jointly with that fit, so this is not an independent check, and no value from a journal article is compared', command: 'node test/make_phasecurve_examples.mjs <Exoplanet-Mapping checkout> && node test/phasemodel.test.mjs',
  },
  {
    id: 'eclipsemap', title: 'WASP-43 b, eclipse map of degree 1', data: 'The visit above plus windows around four more eclipses and two transits from two other Spitzer visits (same repository).', licence: 'As the row above.', cite: ['stevenson2017', 'hellier2011', 'luger2019'],
    compare: [
      { what: 'Fp/F★', get: ['parameters', 'fpfs'], published: 'none', source: 'no published map of these data is recorded in this repository' },
      { what: 'y1,−1 (north-south)', get: ['parameters', 'y1m1'], published: 'none', source: 'unconstrained: the posterior fills its prior' },
    ], verdict: 'no published value to compare; internal check only (χ² through the likelihood equals the model used directly)', command: 'node test/phasemodel.test.mjs',
  },
  {
    id: 'eclipsemap-sim', title: 'Simulated eclipse map of degree 2 (WASP-18 b orbit)', data: 'Simulated by this code: three eclipses and a transit, 60 ppm per 60 s, seed 20261115; orbit of WASP-18 b.', licence: 'Generated here; no third-party data.', cite: ['coulombe2023'],
    compare: [
      { what: 'Fp/F★', get: ['parameters', 'fpfs'], published: '0.36 (injected)', source: 'notes of the session file' },
      { what: 'y1,0', get: ['parameters', 'y10'], published: '0.42 (injected)', source: 'same' },
      { what: 'y1,1', get: ['parameters', 'y11'], published: '0.07 (injected)', source: 'same' },
      { what: 'y1,−1', get: ['parameters', 'y1m1'], published: '0.15 (injected)', source: 'same' },
      { what: 'y2,0', get: ['parameters', 'y20'], published: '−0.06 (injected)', source: 'same' },
      { what: 'y2,2', get: ['parameters', 'y22'], published: '0.04 (injected)', source: 'same' },
    ], verdict: 'injected values recovered within the posterior (a self-consistency test: the data were made with this model)', command: 'node test/make_phasecurve_examples.mjs <Exoplanet-Mapping checkout>',
  },
  {
    id: 'exomoon', title: 'Simulated planet with a moon, 12 transits', data: 'Simulated by this code (public/examples/exomoon/make_example.mjs, seed 20261115): a Jupiter-size planet at 45 d with a moon, 250 ppm.', licence: 'Generated here; no third-party data.', cite: [],
    compare: [
      { what: 'Rm/R★', get: ['parameters', 'rmoon'], published: '0.02 (injected)', source: 'notes of the session file' },
      { what: 'moon period [d]', get: ['parameters', 'permoon'], published: '3.7 (injected)', source: 'same' },
    ], verdict: 'injected values recovered (self-consistency; no real exomoon exists to reproduce)', command: 'node public/examples/exomoon/make_example.mjs && node test/exomoon.test.mjs',
  },
  {
    id: 'nbody', title: 'Simulated hot Jupiter with a companion near 2:1, 72 mid-transit times', data: 'Simulated with this project’s IAS15 integrator (public/examples/nbody/make_example.mjs).', licence: 'Generated here; no third-party data.', cite: [],
    compare: [
      { what: 'companion mass [M Jup]', get: ['parameters', 'mplanet@c'], published: '0.100 (injected)', source: 'public/examples/nbody/truth.json' },
    ], verdict: 'injected mass recovered; the transiting planet’s T0 and P are profiled, not sampled', command: 'node public/examples/nbody/make_example.mjs && node test/nbody.test.mjs && node test/nbodymodel.test.mjs',
  },
  {
    id: 'toi1873-oc', title: 'TOI-1873, linear ephemerides and O − C of 50 TESS mid-times (real data)', data: 'The mid-transit times of EXOTIC’s per-transit fits of the TESS light curves (examples/toi-3planet, toi1873_transit_fits.json): 39 of b, 8 of c, 3 of d (public/examples/toi1873/transit_times.csv).', licence: 'TESS data are public (MAST); the times are EXOTIC’s measurements, no licence stated.', cite: ['ricker2015', 'zellem2020'],
    compare: [
      { what: 'P b [d]', get: ['parameters', 'per'], published: '7.0057545 ± 0.0000182 (EXOTIC, same times)', source: 'toi1873_transit_fits.json, weighted least squares; pyaneti from the light curves: 7.0057048' },
      { what: 'P c [d]', get: ['parameters', 'per@c'], published: '24.9339738 ± 0.0000528 (EXOTIC, same times)', source: 'same; pyaneti: 24.9339464' },
    ], verdict: 'the periods equal EXOTIC’s on the same times (0.00σ and 0.01σ; b is 1.6σ from pyaneti’s, c 0.4σ). No periodicity in the O − C: strongest peaks at false-alarm probabilities of 25% (b) and 80% (c), as EXOTIC also finds', command: 'node test/examples_real.test.mjs',
  },
  {
    id: 'kepler88', title: 'Kepler-88 (KOI-142), the non-transiting planet c weighed by the transit timing of b (real data)', data: '119 mid-transit times of Kepler-88 b (two flagged outliers left out) from the Kepler TTV catalogue of Holczer et al. 2016 (ApJS 225, 9; VizieR J/ApJS/225/9, table3, rows of KOI-142.01; public/examples/kepler88/README.md). N-body model, b’s T0 and P profiled, c at i = 87°, both eccentricity vectors free; 8.66 min of timing noise added in quadrature (the catalogue errors, given to one figure, are too small for this model).', licence: 'VizieR catalogue data (CDS terms, https://cds.unistra.fr/vizier-org/licences_vizier.html); Kepler data are public (MAST).', cite: ['borucki2010'],
    compare: [
      { what: 'Mp c [M Jup]', get: ['parameters', 'mplanet@c'], published: '0.674 ± 0.016 (Weiss et al. 2020); 0.626 +0.029 −0.033 (Nesvorný et al. 2013)', source: 'NASA Exoplanet Archive rows in this repository’s snapshot (public/catalog), as typed in test/examples_real.test.mjs' },
      { what: 'P c [d]', get: ['parameters', 'per@c'], published: '22.26492 ± 0.00067 (Weiss et al. 2020); 22.3395 +0.0019 −0.0017 (Nesvorný et al. 2013)', source: 'same; this fit’s period is osculating at BJD 2454954.5, so it compares with Nesvorný’s osculating value' },
    ], verdict: 'c’s mass, 0.671 ± 0.006 M Jup from b’s timing alone, agrees with Weiss et al. 2020 (−0.2σ) and Nesvorný et al. 2013 (+1.4σ); its osculating period is 22.3349 ± 0.0007 d against Nesvorný’s osculating 22.3395 (−2.4σ; Weiss’s 22.265 is defined differently and not comparable); both eccentricities (0.0558, 0.0572) match the published 0.0559 and 0.0563 to 0.0572. The uncertainties rest on the 8.66 min of timing noise added to the catalogue errors', command: 'node public/examples/kepler88/make_example.mjs && node tools/build_example_results_node.mjs kepler88 && node test/examples_real.test.mjs',
  },
  {
    id: 'ttvpair', title: 'Simulated pair near 2:1, masses from timing alone', data: 'Simulated with this project’s IAS15 integrator (public/examples/ttvpair/make_example.mjs, seed 20261116): every transit of two warm Saturns over 1460 d, 113 times.', licence: 'Generated here; no third-party data.', cite: ['lithwick2012'],
    compare: [
      { what: 'Mp b [M Jup]', get: ['parameters', 'mplanet'], published: '0.14 (injected)', source: 'public/examples/ttvpair/truth.json' },
      { what: 'Mp c [M Jup]', get: ['parameters', 'mplanet@c'], published: '0.09 (injected)', source: 'same' },
    ], verdict: 'both injected masses recovered (−0.3σ and +0.1σ) with circular orbits held; no velocities in the fit', command: 'node public/examples/ttvpair/make_example.mjs && node test/examples_real.test.mjs',
  },
  {
    id: null, title: 'Mid-transit times: EXOTIC’s 40-time list and its WASP-12 b list', data: 'public/examples/ephemeris/transit_times.csv (40 simulated times, written from the arrays of EXOTIC’s examples/ephemeris; they run to 2028 and their observatory labels are made up) and wasp12_decay_times.csv (457 real times of WASP-12 b compiled in EXOTIC’s examples/ephemeris/fit_decay.py from Exoplanet Watch, ExoClock and the Exoplanet Transit Database; the file labels every row “literature”).', licence: 'No licence stated in this repository; compiled in the EXOTIC repository from the sources labelled in each row.', cite: ['zellem2020', 'leonardi2024'],
    compare: [{ topic: 'basics', row: 3 }], verdict: 'the conversion dP/dE to dP/dt is reproduced on published numbers; a fit of the 457-time list is NOT compared with a published decay rate', command: 'node test/ephemeris.test.mjs && node test/periodogram.test.mjs',
  },
  {
    id: null, title: 'HAT-P-32 b, 142 MicroObservatory frames (image photometry)', data: 'EXOTIC’s sample data set (EXOTIC_sampledata-1.0.0, HatP32Dec202017), kept in test/data as cut-outs and not served by the site.', licence: 'The sample data state no licence (README); for that reason the frames are not in public/.', cite: ['zellem2020'],
    compare: [
      { what: 'Rp/R★', fixed: '0.1452 ± 0.0032', published: '0.1562 ± 0.0034 (EXOTIC 4.3.1 on the same frames)', source: 'README, "Photometry"; printed by test/exotic_photometry.test.mjs', bad: true },
      { what: 'T mid − 2458107', fixed: '0.71311 ± 0.00106', published: '0.71359 ± 0.00108 (EXOTIC 4.3.1)', source: 'same' },
      { what: 'residual scatter', fixed: '0.496%', published: '0.573% (EXOTIC 4.3.1)', source: 'same' },
    ], verdict: 'timing agrees; Rp/R★ differs by 2.3σ, mostly through the choice of comparison star. Compared with EXOTIC’s reduction, not with a published light curve', command: 'node test/exotic_photometry.test.mjs',
  },
];

/** The four comparisons the Validation tab recomputes in the browser (not in project.json): numbers as printed by the test on DATE. */
export const LIVE = {
  date: '2026-11-15', command: 'node test/validation.test.mjs',
  rows: [
    { id: 'transit', title: 'Transit flux', source: 'public/validation/transit.json, generated by tools/validation/make_transit.py (inputs chosen by this project; reference: scipy quadrature on a 30-digit orbit)', result: '41 light curves: worst error 3.1e-11 (tolerance 1e-10); branch points 1.4e-10; automatic exposure averaging 1.3e-7 to 6.9e-7' },
    { id: 'orbit', title: 'Orbit and timing', source: 'public/validation/orbit.json, tools/validation/make_orbit.py (reference: 30-digit arithmetic)', result: 'true anomaly 2.4e-15 rad up to e = 0.999; event times 2.3e-10 s; durations 1.3e-10 s. HD 80606 b eclipse duration: 0.08337 d here and in the reference, 0.07169 d published: NOT reproduced' },
    { id: 'rv', title: 'Radial velocity', source: 'public/validation/rv.json, tools/validation/make_rv.py', result: '5 orbits up to e = 0.93: worst 1.3e-14 K; K from masses 3.1e-8 relative' },
    { id: 'fits', title: 'Posteriors, evidence, coverage', source: 'public/validation/fits.json and esl.json (four simulated data sets; tools/validation/make_fits.py, esl_reference.mjs)', result: 'means within 0.04σ and widths within 3.5% of dynesty or the exact posterior; ln Z within 0.31; 68% coverage 67.0 to 73.3% over 300 trials (expected 68 ± 2.7%)' },
  ],
};

/** Third-party data and what this repository states about their terms (for the reproducibility table's footnote). */
export const DATA_TERMS = [
  ['NASA Exoplanet Archive (ps, pscomppars, TOI tables)', 'public/catalog/, public/catalog-table/', 'No licence text stored; the archive’s acknowledgement sentence is stored and shown.', ['akeson2013', 'guerrero2021']],
  ['exoplanet.eu', 'public/catalog-eu/', 'CC BY 4.0, as stated in the site’s footer and stored in the snapshot; acknowledgement shown under the table.', ['schneider2011']],
  ['PHOENIX-ACES specific intensities (derived coefficient tables only)', 'src/data/ld_table.js, src/data/ld_spectral.js', 'No licence stated in this repository.', ['husser2013']],
  ['Star catalogue for the sky view (XHIP through d3-celestial)', 'public/sky/', 'd3-celestial data: BSD 3-Clause, © 2015 Olaf Frohn (stored in each file). No licence stated for XHIP itself.', ['anderson2012']],
  ['TESS and Kepler target pixel files (test fixtures; one TESS cut-out served as a demo)', 'public/photometry/, test/data/', 'No licence stated in this repository; public mission data from MAST.', ['ricker2015', 'borucki2010']],
  ['Land outline', 'public/observatories/land-110m.json', 'Natural Earth, public domain (stored in the file).', []],
];
