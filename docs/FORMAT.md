# The ESL session format (version 1)

One JSON document describes an analysis: the system, the data, what is free and with which priors, the sampler
settings and, once run, the result. The analyzer saves and exports it, the worked examples are stored as it,
and the Python package and the assistant read and write it. `src/core/session.js` validates it, turns it into
the specification `buildProblem` takes (`specFromSession`), runs it (`runSession`) and summarises the posterior
(`summarizeFit`).

```jsonc
{
  "format": "esl-session", "version": 1,
  "software": { "name": "exoplanet-science-lab", "version": "0.2.0", "commit": null },
  "created": "2026-11-15T20:00:00Z",
  "name": "HD 80606",                       // system or host name
  "title": "HD 80606 b: transit + velocities + timing",   // optional, what this analysis is
  "notes": "",

  "star": { "teff": 5565, "teffErr": 92, "logg": 4.4, "loggErr": 0.1, "feh": 0.35, "fehErr": 0.06,
            "rstar": 1.05, "rstarErr": 0.01, "mstar": 1.05, "mstarErr": 0.047 },      // R in R_sun, M in M_sun

  "limb_darkening": { "law": "nonlinear",   // uniform | linear | quadratic | kipping | sqrt | nonlinear (Claret 4); "squareroot" is read as "sqrt"
                      "mode": "coeffs",     // "coeffs": coefficients are parameters; "star": they follow Teff / [Fe/H]
                      "band": "TESS (approx.)", "band_custom": [500, 900],
                      "coefficients": [0.4939, -0.0729, 0.4578, -0.2158] },

  "planets": [                               // the first planet's parameter keys are plain; later ones carry "@letter"
    { "letter": "b", "parameters": { "rprs": 0.1, "ars": 94.45, "inc": 89.269, "per": 111.4367,
                                     "tmid": 2458888.0757, "ecc": 0.93132, "omega": -58.699, "mplanet": 4.2 } }
  ],                                         // tmid absolute; inc, omega in degrees; mplanet in M_Jup; K (m/s) may replace mplanet
  "kepler": true,                            // a/R* follows from Kepler's law (M*, R*, P, Mp) instead of "ars"

  "time_reference": 2458887,                 // times are measured from here inside a fit; all times in this file are absolute

  "data": {
    "light_curve": { "name": "TESS", "time": [...], "flux": [...], "flux_err": [...], "airmass": null,
                     "exposure_min": 2,
                     "epoch": null,          // or one integer per point: which observation it belongs to
                     "epochs": [],           // [{ "name", "airmass": bool, "exposure_min"? }], one per observation
                     "columns": { "xc": [...], "yc": [...], "sky": [...] },   // optional: detector columns, one value per point (null where missing)
                     "detrend": null },      // optional: the systematics model built from them (below)
    "radial_velocity": [ { "name": "HIRES_k", "time": [...], "velocity": [...], "velocity_err": [...],     // m/s
                           "exposure_min": 10 } ],   // optional: the Rossiter–McLaughlin anomaly is averaged over it
    "timing": [ { "planet": "b", "kind": "transit", "time": 2455210.642, "err": 0.004, "source": "Hebrard et al. 2010" } ]
  },

  "fit": {
    "use": { "lc": true, "rv": true, "timing": true },      // which kinds of data enter the likelihood
    "free": [ { "key": "per", "label": "P", "unit": "d", "prior": { "type": "uniform", "a": 111.3, "b": 111.5 } },
              { "key": "mplanet@c", "prior": { "type": "normal", "a": 0.09, "b": 0.02 } } ],
              // prior types: uniform (a = min, b = max), normal (a = mean, b = sd); for tmid, a (and b when uniform) are absolute;
              // also truncnormal (a = mean, b = sd, lo, hi), loguniform (a, b) and categorical (values: [...], weights?: [...],
              // a discrete parameter such as the period alias "nalias")
    "fixed": { "a2": 0, "rvlin": 0, "jit@rv1": 2.0 },        // anything that is not a planet parameter and not free
    "timing_noise": 0,                                        // days, added in quadrature to every timing error
    "sampler": { "nlive": 400, "fracRemain": 0.01, "seed": 42, "maxCalls": 1000000 }
  },

  "result": null                             // filled by runSession, see below
}
```

Parameter keys: planet parameters `rprs, ars, inc, per, tmid, ecc, omega, mplanet, K`; limb darkening `ld0..ld3`;
airmass slope `a2` (one light curve) or `a2@<epoch number>`; light-curve jitter `jitlc` (ppm) or `jitlc@<epoch number>`,
dilution `dil` (flux of other stars over the target's; `dil@<epoch number>`); Rossiter–McLaughlin `vsini` (km/s) and
`lambda` (degrees, per planet `lambda@<letter>`); velocities `rvlin`, `rvquad`, `jit@rv<number>`;
star `mstar`, `rstar`, `teff`, `feh`; period alias `palias`, `nalias` (per planet, below). `ars` is never free.

`result` after a run:

```jsonc
{ "logZ": 3362.8, "logZerr": 0.2, "information": 31.5, "ess": 2100, "ncalls": 59826, "seconds": 25.0,
  "converged": true, "stop_reason": "converged", "warnings": ["e and omega are -0.98 correlated: ..."],
  "parameters": [ { "key": "per", "label": "P", "unit": "d", "median": 111.436807, "plus": 7.1e-5, "minus": 7.0e-5, "best": 111.436811 } ],
  "derived": { "K": { "median": 469.86, "plus": 0.4, "minus": 0.4 }, "ars": {...}, "t14": {...}, "emid": {...}, "b": {...} },   // per planet: "K@c", ...
  "best": { "per": 111.436811, "...": 0 },             // every parameter at the best-fit point, times absolute
  "chi2": 1670.1, "chi2_parts": { "light_curve": 95.0, "radial_velocity": 1564.0, "timing": 8.3 }, "n_data": 1168, "bic": 1780.9,
  "rv_zero_points": [ { "name": "HIRES_k", "gamma": -80.6, "jitter": 0 } ],
  "samples": { "keys": ["per", "..."], "values": [[...], ...], "logl": [...] }    // optional: equal-weight draws, times relative to time_reference
}
```

Rules for writers: all times absolute; arrays as plain JSON numbers; unknown keys are kept and ignored; a newer
`version` than a reader knows is refused. Limb darkening in `"star"` mode needs the bundled tables and is set up
by the application, not by `specFromSession`.

## Optional model blocks

These are absent from a plain transit or velocity session. Readers must keep keys they do not know.

```jsonc
// the planet's own light (src/core/phasecurve.js). A planet has it when its parameters include "fpfs".
"phase": { "mode": "harmonic",          // "harmonic": fpfs, contrast, hotspot, h2c, h2s; "map": fpfs and y1m1, y10, y11, y2m2 ... up to lmax
           "lmax": 1,                    // degree of the map (1 to 3), map mode only
           "ltt": true,                  // delay the planet's light by its travel time across the orbit (needs star.rstar)
           "band_micron": [4.0, 5.0],    // band of the observation, for brightness temperatures only
           "positive_map": true },       // optional: zero prior mass for a map whose surface brightness is negative anywhere on
                                         //   the sphere (exact minimum for degree 1 and 2, grid + search for 3). The planet's flux
                                         //   is always required to be >= 0 at every phase (nightside included). In harmonic mode
                                         //   this tests the degree-1 map of the curve (forbids contrast > 0.8: stricter than physics)
// planet parameters then also hold: fpfs, contrast, hotspot (deg), h2c, h2s, ellip (ppm), beam (ppm), y10, y11, ...

// a moon of a planet (src/core/exomoon.js): planet parameters hold rmoon (Rm/R*), permoon (d), phmoon (0..1 at mid-transit),
// mmoon (Mm/Mp), imoon (deg). The moon is in the model when "rmoon" is present.

// the planets pull on each other (src/core/nbody.js): mid-transit and mid-eclipse times, velocities and the light curve
// (photodynamics) come from one N-body integration. Every planet needs "mplanet" and the star "mstar"; the light curve
// also needs "rstar" (or, without "kepler", the first planet's a/R*, from which R* follows).
"nbody": { "epoch": 2459154.89,          // the planets' per, tmid, ecc, omega, inc are their osculating elements at this time
           "elements": "mean",           // optional: per and tmid of each planet are instead the straight line through its
                                         //   simulated mid-transit times over the span of the data (the observed ephemeris);
                                         //   the osculating values are found by iteration. Lets a planet's own P and T0 be
                                         //   sampled together with a companion. Default "osculating".
           "linear": true,               // optional, times only: fit a straight line in epoch to each planet's simulated
                                         //   times inside the likelihood (then its P and T0 are not sampled). Leave it out
                                         //   when a light curve is in the fit, and with "elements": "mean".
           "photo": true,                // optional: false keeps Keplerian light curves (default true)
           "ltt": false,                 // optional: light-travel time across the system, referred to the barycentre
                                         //   (transits seen a/c early, eclipses a/c late); needs rstar
           "integrator": "wh",           // "wh" (Wisdom-Holman, default) | "ias15" (slower, exact to rounding)
           "stepsPerOrbit": 20, "exactSync": false,    // Wisdom-Holman settings (optional; defaults 30 and true)
           "nodesPerOrbit": 150 },       // optional: spacing of the position tracks of the light curve
// With "nbody", planets are treated one at a time in the light curve (mutual planet-planet events are not modelled), and a
// planet with its own light ("fpfs") or a moon keeps its Keplerian curve.

// an epoch of the light curve may carry its own exposure: data.light_curve.epochs[k].exposure_min

// physical-viability priors (src/core/physical.js), all off unless named: a point that fails has zero prior mass
"physical": { "crossing": true,          // adjacent orbits' radial ranges do not overlap: a_out (1 - e_out) > a_in (1 + e_in)
              "hill": true,              // Gladman (1993) Hill stability of every adjacent pair, eccentric, coplanar
              "hill_spacing": 8,         // every adjacent pair at least this many mutual Hill radii apart (Chambers et al. 1996 style)
              "amd": true,               // AMD stability, coplanar (Laskar & Petit 2017)
              "roche": true,             // periastron outside the star and outside roche_factor Rp (M*/Mp)^(1/3)
              "roche_factor": 2.16,      // Rappaport et al. 2013; 2.44 for a fluid body
              "megno": { "orbits": 300, "max": 2.5 } },   // expensive: integrate, reject <Y> > max or a failed integration
// Hill, hill_spacing and megno need star.mstar; masses are mplanet (or from K). With "physical" (or phase.positive_map)
// result.prior_volume = { V, lnV, lnVerr, draws, rejected: { test: count }, logZ_renormalised } is written by runSession:
// the prior mass that passes, from 20000 prior draws, and ln Z - ln V (the evidence of the renormalised prior).

// period alias of a planet seen in a few transits (src/core/aliases.js): its parameters hold "palias" (the span between
// transits, d) and "nalias"; the period is palias / nalias. Free "nalias@d" with a categorical prior over the allowed N:
//   { "key": "nalias@d", "prior": { "type": "categorical", "values": [1, 2, 3, 4, 7] } }   (aliasScan finds them; aliasPrior
//   gives "geometric" weights proportional to N^(2/3)). The posterior weight of each value is its probability.

// Rossiter–McLaughlin options (src/core/rm.js); the anomaly itself is on when "vsini" is set
"rm": { "ld_law": "quadratic", "ld": [0.65, 0.08],   // limb darkening of the spectrograph's band (default: the fit's)
        "method": "ccf",                 // optional: what a Gaussian fit to the CCF measures (default: first moment of the light)
        "beta": 3.0,                     // km/s, dispersion of the local line (instrumental + thermal); needed by "ccf"
        "zeta": 0,                       // km/s, macroturbulence (Gaussian approximation), optional
        "beta0": null,                   // km/s, measured out-of-transit CCF dispersion; modelled when null
        "exposure_min": 10,              // optional, for every RV set without its own exposure_min
        "supersample": 5 },              // sub-exposures of the averaging
// A catalogue v sin i is a prior on "vsini": { "type": "truncnormal", "a": 1.7, "b": 0.3, "lo": 0, "hi": 4.7 } (rm.js vsiniPrior).
```

Text exports of a session (Python script, Markdown report, LaTeX tables) are written by `src/core/exportScript.js`.
`"mode": "star"` limb darkening is set up for readers outside the browser by `prepareSession` / `ldTieForSession` in
`src/core/pyentry.js`.

## Spectroscopy

A session saved by the Spectroscopy page (`analyze/spectroscopy/`, `spectroscopyToSession` / `spectroscopyFromSession`
in `src/core/spectroscopy.js`) is an ordinary session, so the analyzer and `runSession` open it, plus one block.
The session's `data.light_curve` is the white light curve. Once a white-light fit exists it is the **detrended**
curve (flux divided by the fitted baseline, errors as scaled for the fit), because a session has no baseline
regressors; the curve as measured is in `spectroscopy.white_light`. `limb_darkening.band` is `"Custom range"`
with `band_custom` the white-light range in nm.

```jsonc
"spectroscopy": {
  "version": 1,
  "kind": "transit",                          // or "eclipse": depths are then Fp/F* (Rp/R*)^2 and the planet has "fpfs"
  "source": { "kind": "JWST x1dints", "files": ["jw01366003001_04101_00001-seg001_nrs1_x1dints.fits"], "meta": { "instrument": "NIRSPEC", "grating": "G395H", "...": 0 } },
                                              // kind "simulation" for simulated data
  "settings": { "bins": { "mode": "R", "R": 100, "wlMin": null, "wlMax": null },   // mode: R | width | n | columns | native | edges
                "baseline": "linear",         // none | linear | quadratic, per light curve, integrated out
                "steps": [2459791.62031],     // absolute times of steps in the baseline (a tilt event)
                "ldLaw": "quadratic", "errorMode": "max",   // pipeline | scatter | max
                "commonMode": false, "kepler": false, "clean": { "window": 11, "nsigma": 5 } },
  "bins": { "mode": "R", "R": 100 },
  "white_light": { "lo": 2.86, "hi": 5.18,    // micron
                   "time": [...], "flux": [...], "flux_err": [...], "exposure_min": 1.052, "detrended_in_session": true },
  "white_fit": { "parameters": [{ "key": "rprs", "median": 0.14603, "plus": 5e-5, "minus": 5e-5, "best": 0.14603 }],
                 "values": { "rprs": 0.14603, "ars": 11.47, "inc": 87.83, "per": 4.0552941, "tmid": 2459791.612084, "...": 0 },   // the geometry every channel used
                 "depth": { "median": 0.021324, "plus": 1.3e-5, "minus": 1.3e-5 }, "err_scale": 1.13, "logZ": 0, "ncalls": 0, "converged": true,
                 "baseline": "linear", "free": [{ "key": "rprs", "prior": { "type": "uniform", "a": 0.05, "b": 0.44 } }],
                 "ld": [0.08, 0.12], "ld_law": "quadratic", "residual_rms": 1.36e-4, "expected_rms": 1.05e-4, "beta": 1.87 },   // or null
  "channels": [ { "lo": 2.861, "hi": 2.890, "wl": 2.876, "ncol": 43, "scale": 1.23,   // micron; scale: the median divided out of the summed flux
                  "time": null,               // null: the white light curve's times
                  "flux": [...], "flux_err": [...] } ],
  "spectrum": [ { "wl": 2.876, "lo": 2.861, "hi": 2.890, "depth": 0.02150, "plus": 7e-5, "minus": 7e-5, "err": 7e-5,
                  "value": 0.14663,           // Rp/R* (or Fp/F*)
                  "rms": 0.0011, "expected": 0.0011, "ratio": 1.0, "beta": 1.2, "errScale": 1.0, "redChi2": 1.0, "n": 465 } ],   // or null
  "simulation": null                          // or { "inputs": { "telescope", "area_m2", "throughput", "noise_floor_ppm", "excess", "cadence_s", ... },
                                              //      "truth": [{ "wl", "lo", "hi", "depth", "sigma", "electrons" }], "depth": { "depth0", "slope", "features" } }
}
```

The spectra themselves (the time by wavelength cube) are not stored: a session holds the binned channel light
curves, and restoring one gives those channels as they were binned. Readers that do not know the block keep it.

`data.regressors` of a fit specification (columns of a linear baseline, integrated out by `buildProblem`) is not stored
as such: a session stores the columns it is built from and how, and readers build it again (src/core/data.js
`applyDetrend`, which calls src/core/detrend.js):

```js
"columns": { "xc": [...], "yc": [...], "sky": [...], "fwhm": [...], "comp": [...], "pld1": [...], ... },   // names as in detrend.js DETREND_COLUMNS
"detrend": {
  "columns": ["xc", "yc", "xy"],     // linear terms: column names, or "xy", "xc2", "yc2" (products and squares of the centroids);
                                     // each is standardised within each epoch and gets its own coefficient per epoch, integrated out with a1
  "poly": 1,                         // order of a Legendre polynomial in time per epoch, 0 to 3
  "pld": ["pld1", "pld2"],           // PLD components to add as they are (standardised)
  "kernel": null                     // or { "features": ["xc", "yc"], "neighbors": 50 }: nearest-neighbour kernel regression, built
}                                    // epoch by epoch; a fit with it conditions on the data, so its ln Z is not comparable with one without
```

The analyzer keeps the columns through epochs, trimming, clipping and binning (binned columns are weighted like the flux)
and rebuilds the model for the points that remain. `specFromSession` (src/core/session.js) rebuilds it the same way
(`applyDetrend`), so `runSession`, the Python package and the MCP server fit a session with its systematics model.
