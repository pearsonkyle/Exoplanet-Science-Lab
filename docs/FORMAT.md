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
                     "epochs": [] },         // [{ "name", "airmass": bool, "exposure_min"? }], one per observation
    "radial_velocity": [ { "name": "HIRES_k", "time": [...], "velocity": [...], "velocity_err": [...] } ],   // m/s
    "timing": [ { "planet": "b", "kind": "transit", "time": 2455210.642, "err": 0.004, "source": "Hebrard et al. 2010" } ]
  },

  "fit": {
    "use": { "lc": true, "rv": true, "timing": true },      // which kinds of data enter the likelihood
    "free": [ { "key": "per", "label": "P", "unit": "d", "prior": { "type": "uniform", "a": 111.3, "b": 111.5 } },
              { "key": "mplanet@c", "prior": { "type": "normal", "a": 0.09, "b": 0.02 } } ],
              // prior types: uniform (a = min, b = max), normal (a = mean, b = sd); for tmid, a (and b when uniform) are absolute
    "fixed": { "a2": 0, "rvlin": 0, "jit@rv1": 2.0 },        // anything that is not a planet parameter and not free
    "timing_noise": 0,                                        // days, added in quadrature to every timing error
    "sampler": { "nlive": 400, "fracRemain": 0.01, "seed": 42, "maxCalls": 1000000 }
  },

  "result": null                             // filled by runSession, see below
}
```

Parameter keys: planet parameters `rprs, ars, inc, per, tmid, ecc, omega, mplanet, K`; limb darkening `ld0..ld3`;
airmass slope `a2` (one light curve) or `a2@<epoch number>`; velocities `rvlin`, `rvquad`, `jit@rv<number>`;
star `mstar`, `rstar`, `teff`, `feh`. `ars` is never free.

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
           "band_micron": [4.0, 5.0] },  // band of the observation, for brightness temperatures only
// planet parameters then also hold: fpfs, contrast, hotspot (deg), h2c, h2s, ellip (ppm), beam (ppm), y10, y11, ...

// a moon of a planet (src/core/exomoon.js): planet parameters hold rmoon (Rm/R*), permoon (d), phmoon (0..1 at mid-transit),
// mmoon (Mm/Mp), imoon (deg). The moon is in the model when "rmoon" is present.

// the planets pull on each other (src/core/nbody.js): mid-transit times and velocities come from an N-body integration
"nbody": { "epoch": 2459154.89,          // the planets' per, tmid, ecc, omega, inc are their osculating elements at this time
           "linear": true,               // fit a straight line in epoch to each planet's simulated times inside the likelihood
           "stepsPerOrbit": 20, "exactSync": false },   // integrator settings (optional)

// an epoch of the light curve may carry its own exposure: data.light_curve.epochs[k].exposure_min
```

Text exports of a session (Python script, Markdown report, LaTeX tables) are written by `src/core/exportScript.js`.
`"mode": "star"` limb darkening is set up for readers outside the browser by `prepareSession` / `ldTieForSession` in
`src/core/pyentry.js`.
