"""EXOTIC's multi-planet fitter API on the Exoplanet Science Lab core.

The classes have the names, fields and behaviour of ``exotic/api/multi_fitter.py`` so a script written for it
needs one changed line::

    from exotic.api import multi_fitter as m      # before
    from esl import multi_fitter as m             # after

    planets = {"b": m.SystemParameters(...), "c": m.SystemParameters(...)}
    free    = {"b": m.ParameterSet(mplanet=1), "c": m.ParameterSet(mplanet=1)}
    bounds  = {"b": m.Bounds(upper=m.ParameterSet(mplanet=0.05), lower=m.ParameterSet(mplanet=0)), ...}
    system  = m.MultiPlanetSystem(planets=planets, free=free, bounds=bounds, transit=[lc, ...], radial_velocity=[rv])
    fit = m.MultiPlanetFit(system, live=300, seed=42)
    fit.parameters, fit.errors, fit.derived, system.radial_velocity[0].model

What differs, because the likelihood is ESL's (``buildProblem`` in ``src/core/model.js``), not EXOTIC's:

* The photometric scale of each light curve and the zero point of each velocity dataset are integrated out
  analytically instead of profiled; ``a1`` is therefore never a free parameter (asking for it is ignored with a warning).
* The reflex motion uses the two-body mass ratio Mp / (M* + Mp); EXOTIC uses Mp / M*.
* chi-square is summed over every measurement with the Gaussian normalisation, so the evidence is normalised.
* Normal priors are available (``MultiPlanetSystem.priors``), and timing data (``ephemeris_transit``,
  ``ephemeris_eclipse``) enter the same likelihood.
* The sampler is ESL's MiniNest. ``live``, ``max_ncalls``, ``seed``, ``stepsampler`` and ``nsteps`` are mapped onto
  it; ``improvement_loops`` has no equivalent and is ignored.
* ``n_sub`` keeps EXOTIC's meaning of "1 = instantaneous"; above 1 the exposure time is passed on and the core
  chooses the number of sub-samples itself.

``fit.session`` is the ESL session that was run (``fit.session.save("x.json")`` opens in the browser) and
``fit.result`` its result, with posterior medians and 68% intervals; ``fit.parameters`` and ``fit.errors`` follow
EXOTIC (maximum-likelihood point and posterior standard deviation).
"""
from __future__ import annotations

import warnings
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from pydantic import Field

from . import functions as _f
from .models import (Array, Data, FitSettings, FreeParameter, LightCurve, LimbDarkening, Model, Planet, PlanetParameters, Prior, RadialVelocity, Result, Sampler,
                     Session, Star, TimingPoint, Use)

AU = 1.495978707e11
RSUN = 6.957e8
MJUP_MSUN = 9.5459426398e-4



def transit(times: Any, values: Any, precision: Any = None) -> np.ndarray:
    """Transit model with EXOTIC's signature: ``values`` holds ``rprs, per, ars, ecc, inc, omega, tmid, u0..u3``."""
    return _f.transit(times, values)


def radial_velocity(time: Any, params: Any, dt: float = 0.0001) -> np.ndarray:
    """Radial velocity [m/s] with EXOTIC's signature. ``params``: ``per, tmid, ecc, omega, inc`` and ``mplanet``,
    ``mstar`` (or ``K``). The two-body amplitude is used, not EXOTIC's Mp / M* scaling."""
    return _f.radial_velocity(time, params)


class SystemParameters(Model):
    """Parameters of one planet and its star (the stellar ones are read from the first planet)."""

    rstar: float = Field(1.05, description="Stellar radius in units of solar radius")
    mstar: float = Field(1.05, description="Stellar mass in units of solar mass")
    u0: float = Field(0.49387060813646527, description="Limb darkening coefficient u0 (Claret four-parameter law)")
    u1: float = Field(-0.07294561715247563, description="Limb darkening coefficient u1")
    u2: float = Field(0.4578497817617948, description="Limb darkening coefficient u2")
    u3: float = Field(-0.21582471000247333, description="Limb darkening coefficient u3")
    rprs: float = Field(0.1, description="Planet radius in units of stellar radius")
    ars: float = Field(0.1, description="Semi-major axis in units of stellar radius (recomputed from Kepler's law in a fit)")
    per: float = Field(111.4367, description="Orbital period in days")
    inc: float = Field(89.269, description="Orbital inclination in degrees")
    ecc: float = Field(0.93132, description="Orbital eccentricity")
    omega: float = Field(-58.699, description="Argument of periastron in degrees")
    tmid: float = Field(2458888.075, description="Mid-transit time in BJD")
    a1: float = Field(1, description="Airmass coefficient a1 in f(sec(z)) = a1*exp(a2*sec(z)); integrated out in ESL, kept for compatibility")
    a2: float = Field(0, description="Airmass coefficient a2 in f(sec(z)) = a1*exp(a2*sec(z))")
    fpfs: float = Field(0.5, description="Planet flux over star flux (F_p/F_s)")
    mplanet: float = Field(4.20, description="Planet mass in units of Jupiter mass")
    rv_linear: float = Field(0, description="Linear RV trend in m/s/day")
    rv_quad: float = Field(0, description="Quadratic RV trend in m/s/day^2")

    def evaluate(self, function: str, times: Any) -> np.ndarray:
        if function == "transit":
            return _f.transit(times, self)
        if function in ("rv", "radial_velocity"):
            return _f.radial_velocity(times, self)
        if function in ("ephemeris_transit", "ephemeris_eclipse"):
            return np.asarray(times, dtype=float)
        raise NotImplementedError(f"'{function}' is not a model of the ESL core yet (transit and radial_velocity are)")


class ParameterSet(Model):
    """The parameters that may be fitted: those that are not None are free (their value is not used)."""

    rprs: Optional[float] = Field(None, description="Planet radius in units of stellar radius")
    per: Optional[float] = Field(None, description="Orbital period in days")
    inc: Optional[float] = Field(None, description="Orbital inclination in degrees")
    ecc: Optional[float] = Field(None, description="Orbital eccentricity")
    omega: Optional[float] = Field(None, description="Argument of periastron in degrees")
    tmid: Optional[float] = Field(None, description="Mid-transit time in BJD")
    a1: Optional[float] = Field(None, description="Not a parameter in ESL: the normalisation is integrated out")
    a2: Optional[float] = Field(None, description="Airmass coefficient a2 in f(sec(z)) = a1*exp(a2*sec(z))")
    fpfs: Optional[float] = Field(None, description="Planet flux over star flux (F_p/F_s)")
    mplanet: Optional[float] = Field(None, description="Planet mass in units of Jupiter mass")
    rv_linear: Optional[float] = Field(None, description="Linear RV trend in m/s/day")
    rv_quad: Optional[float] = Field(None, description="Quadratic RV trend in m/s/day^2")
    rv_jitter: Optional[float] = Field(None, description="Per-instrument RV jitter in m/s, added in quadrature to the reported errors")

    def items(self) -> List[Tuple[str, float]]:
        """(key, value) of the parameters that are set, in declaration order, extras last."""
        return [(k, v) for k, v in self.model_dump().items() if v is not None]

    @property
    def numpy(self) -> np.ndarray:
        return np.array([v for _, v in self.items()])


class Bounds(Model):
    upper: ParameterSet = Field(..., description="Upper bounds for free parameters")
    lower: ParameterSet = Field(..., description="Lower bounds for free parameters")

    def random(self) -> Dict[str, float]:
        """A random value between the bounds for every bounded parameter."""
        lo, hi = dict(self.lower.items()), dict(self.upper.items())
        mismatched = sorted(set(lo) ^ set(hi))
        if mismatched:
            raise ValueError(f"mismatched lower/upper bounds for parameters: {mismatched}")
        return {k: float(np.random.uniform(lo[k], hi[k])) for k in lo}


class Timeseries(Model):
    time: Array = Field(..., description="Time array in BJD")
    name: str = Field(..., description="Name of the timeseries")
    meta: dict = Field(default_factory=dict, description="Meta data for the timeseries")

    @classmethod
    def load(cls, time: Any, name: str, meta: Optional[dict] = None, **kwargs: Any) -> "Timeseries":
        return cls(time=time, name=name, meta=meta or {}, **kwargs)


class EphemerisData(Timeseries):
    """Mid-transit or mid-eclipse times of one planet with their uncertainties."""

    uncertainty: Array = Field(..., description="Uncertainty array, days")


class LightCurveData(Timeseries):
    flux: Array = Field(..., description="Flux array")
    ferr: Array = Field(..., description="Flux error array")
    airmass: Optional[Array] = Field(None, description="Airmass array (omit, or zeros, for space data)")
    exp_time: float = Field(0.0, description="Exposure time in DAYS; used when the fit is made with n_sub > 1")
    local: ParameterSet = Field(default_factory=ParameterSet, description="Per-dataset local free parameters (e.g. airmass a2)")
    local_bounds: Optional[Bounds] = Field(None, description="Uniform prior bounds for the local free parameters")
    # best-fit bookkeeping, filled in after the fit
    scale: float = Field(1.0, description="Photometric normalisation at the best fit")
    scale_err: float = Field(0.0, description="Scatter of the normalisation over posterior draws")
    model: Array = Field(default_factory=lambda: np.array([]), description="Best-fit model, normalisation or zero point included")
    residuals: Array = Field(default_factory=lambda: np.array([]), description="data - model")
    resid_std: float = 0.0


class RadialVelocityData(Timeseries):
    """A single RV dataset measured on the star (one instrument); it holds the signal of all planets."""

    vel: Array = Field(..., description="Radial velocity array, m/s")
    velerr: Array = Field(..., description="Radial velocity error array, m/s")
    jitter: float = Field(0.0, description="FIXED per-instrument jitter in m/s; a free ParameterSet.rv_jitter in `local` takes precedence")
    local: ParameterSet = Field(default_factory=ParameterSet, description="Per-dataset local free parameters")
    local_bounds: Optional[Bounds] = Field(None, description="Uniform prior bounds for the local free parameters")
    offset: float = Field(0.0, description="Zero point at the best fit (m/s)")
    offset_err: float = Field(0.0, description="Scatter of the zero point over posterior draws")
    model: Array = Field(default_factory=lambda: np.array([]), description="Best-fit model, normalisation or zero point included")
    residuals: Array = Field(default_factory=lambda: np.array([]), description="data - model")
    resid_std: float = 0.0


class PlanetDataset(Model):
    transit: List[LightCurveData] = Field(default_factory=list)
    radial_velocity: List[RadialVelocityData] = Field(default_factory=list)
    ephemeris_transit: List[EphemerisData] = Field(default_factory=list)
    ephemeris_eclipse: List[EphemerisData] = Field(default_factory=list)

    def __getitem__(self, key: str) -> Any:
        if key in type(self).model_fields:
            return getattr(self, key)
        raise KeyError(f"{key} not found in dataset")


#: ParameterSet field -> ESL parameter key, for the fields that belong to a planet
_PLANET_KEYS = ("rprs", "per", "inc", "ecc", "omega", "tmid", "mplanet", "K")
_STAR_KEYS = {"rv_linear": "rvlin", "rv_quad": "rvquad", "a2": "a2", "mstar": "mstar", "rstar": "rstar", "teff": "teff", "feh": "feh"}


class MultiPlanetSystem(Model):
    """A system with superposed observations: each light curve and each velocity dataset holds the signal of all planets."""

    planets: Dict[str, SystemParameters] = Field(default_factory=dict, description="System parameters per planet")
    free: Dict[str, ParameterSet] = Field(default_factory=dict, description="Free (fit) parameters per planet (non-None values are fit)")
    bounds: Dict[str, Bounds] = Field(default_factory=dict, description="Uniform prior bounds per planet")
    transit: List[LightCurveData] = Field(default_factory=list, description="Light curves (all planet signals combined)")
    radial_velocity: List[RadialVelocityData] = Field(default_factory=list, description="Velocity datasets, one per instrument")
    # ---- beyond EXOTIC's class
    ephemeris_transit: Dict[str, List[EphemerisData]] = Field(default_factory=dict, description="Mid-transit times per planet")
    ephemeris_eclipse: Dict[str, List[EphemerisData]] = Field(default_factory=dict, description="Mid-eclipse times per planet")
    ephemeris_noise: float = Field(0.0, description="Days, added in quadrature to every timing uncertainty")
    priors: Dict[str, Dict[str, Prior]] = Field(default_factory=dict, description="Priors that replace the uniform bounds: {planet: {key: esl.Prior.normal(mean, sd)}}")
    name: str = "system"
    kepler: bool = Field(True, description="a/R* from Kepler's law (as EXOTIC's multi-planet fitter does); False uses each planet's ars")
    star: Optional[Star] = Field(None, description="Stellar parameters beyond mass and radius (Teff, log g, [Fe/H]) for derived quantities and limb darkening")
    limb_darkening: Optional[LimbDarkening] = Field(None, description="Replaces the u0..u3 of the first planet, e.g. to let the coefficients follow the star")

    def parameter_space(self) -> Tuple[List[str], np.ndarray, List[Tuple[Optional[str], str, Optional[str]]]]:
        """EXOTIC's free keys ("b_mplanet", "rv_neid_rv_jitter"), their bounds and (planet, key, dataset) triples."""
        keys, bnds, fmap = [], [], []
        for pkey, free in self.free.items():
            lo, hi = (dict(self.bounds[pkey].lower.items()), dict(self.bounds[pkey].upper.items())) if pkey in self.bounds else ({}, {})
            for key, _ in free.items():
                pr = self.priors.get(pkey, {}).get(key)
                if pr is None and (key not in lo or key not in hi):
                    raise ValueError(f"missing bounds for {pkey}_{key}")
                keys.append(f"{pkey}_{key}")
                bnds.append([lo.get(key, np.nan), hi.get(key, np.nan)])
                fmap.append((pkey, key, None))
        for ds in [*self.transit, *self.radial_velocity]:
            lb = ds.local_bounds
            lo, hi = (dict(lb.lower.items()), dict(lb.upper.items())) if lb is not None else ({}, {})
            for key, _ in ds.local.items():
                if key not in lo or key not in hi:
                    raise ValueError(f"missing bounds for {ds.name}_{key}")
                keys.append(f"{ds.name}_{key}")
                bnds.append([lo[key], hi[key]])
                fmap.append((None, key, ds.name))
        return keys, np.array(bnds, dtype=float).reshape(-1, 2), fmap

    def to_session(self, n_sub: int = 1, sampler: Optional[Sampler] = None) -> Tuple[Session, Dict[str, str]]:
        """The ESL session for this system, and the map from EXOTIC's free keys to ESL's ("b_mplanet" -> "mplanet")."""
        if not self.planets:
            raise ValueError("the system has no planets")
        letters = list(self.planets)
        first = self.planets[letters[0]]
        pk = lambda name, letter: name if letter == letters[0] else f"{name}@{letter}"     # noqa: E731
        fixed: Dict[str, float] = {}

        # light curves: one epoch each, sorted in time
        lcs = sorted(self.transit, key=lambda d: float(np.min(d.time)))
        shared_a2 = any(ps.a2 is not None for ps in self.free.values())
        curves, a2_key = [], {}
        for k, ds in enumerate(lcs):
            varies = ds.airmass is not None and float(np.ptp(ds.airmass)) > 0
            use_air = varies and (ds.local.a2 is not None or shared_a2 or first.a2 != 0)
            curves.append(LightCurve(name=ds.name, time=ds.time, flux=ds.flux, flux_err=ds.ferr, airmass=ds.airmass if use_air else None, exposure_min=ds.exp_time * 1440 if n_sub > 1 else 0.0))
            a2_key[ds.name] = ("a2" if len(lcs) == 1 else f"a2@{k + 1}") if use_air else None
            if use_air and ds.local.a2 is None and not shared_a2:
                fixed[a2_key[ds.name]] = first.a2
        if any(a2_key.values()) and shared_a2:
            fixed.setdefault("a2", first.a2)
        light_curve = LightCurve.combine(curves, name="light curves") if curves else None

        rvs = [RadialVelocity(name=ds.name, time=ds.time, velocity=ds.vel, velocity_err=ds.velerr) for ds in self.radial_velocity]
        jit_key = {ds.name: f"jit@rv{k + 1}" for k, ds in enumerate(self.radial_velocity)}
        for ds in self.radial_velocity:
            fixed[jit_key[ds.name]] = ds.jitter
        if rvs:
            fixed["rvlin"], fixed["rvquad"] = first.rv_linear, first.rv_quad

        timing = [TimingPoint(planet=letter, kind=kind, time=float(t), err=float(e), source=ds.name)
                  for kind, table in (("transit", self.ephemeris_transit), ("eclipse", self.ephemeris_eclipse))
                  for letter, sets in table.items() for ds in sets for t, e in zip(ds.time, ds.uncertainty)]

        # free parameters
        keys, bnds, fmap = self.parameter_space()
        keymap: Dict[str, str] = {}
        free: List[FreeParameter] = []
        for exotic_key, (lo, hi), (pkey, key, dsname) in zip(keys, bnds, fmap):
            if key == "a1":
                warnings.warn(f"{exotic_key}: the normalisation a1 is integrated out analytically in ESL and is not sampled", stacklevel=2)
                continue
            if pkey is not None:
                esl_key = pk(key, pkey) if key in _PLANET_KEYS else _STAR_KEYS.get(key, pk(key, pkey))
                prior = self.priors.get(pkey, {}).get(key) or Prior.uniform(float(lo), float(hi))
            else:
                esl_key = jit_key[dsname] if key == "rv_jitter" else a2_key.get(dsname) if key == "a2" else _STAR_KEYS.get(key, key)
                if esl_key is None:
                    raise ValueError(f"{exotic_key}: this light curve has no varying airmass column to fit a2 against")
                prior = Prior.uniform(float(lo), float(hi))
            if esl_key in keymap.values():
                raise ValueError(f"{exotic_key}: {esl_key} is already free (rv_linear, rv_quad and a shared a2 belong to the star: free them on one planet only)")
            keymap[exotic_key] = esl_key
            fixed.pop(esl_key, None)
            free.append(FreeParameter(key=esl_key, label=exotic_key, prior=prior))

        times = [d.time for d in lcs] + [d.time for d in self.radial_velocity] + ([np.array([t.time for t in timing])] if timing else [])
        t_ref = float(np.floor(min(float(np.min(t)) for t in times))) if times else float(np.floor(first.tmid))
        star = (self.star or Star()).model_copy(update={"rstar": first.rstar, "mstar": first.mstar})
        session = Session(
            name=self.name, star=star,
            limb_darkening=self.limb_darkening or LimbDarkening(law="nonlinear", mode="coeffs", coefficients=[first.u0, first.u1, first.u2, first.u3]),
            planets=[Planet(letter=letter, parameters=PlanetParameters(rprs=p.rprs, ars=p.ars, inc=p.inc, per=p.per, tmid=p.tmid, ecc=p.ecc, omega=p.omega, mplanet=p.mplanet)) for letter, p in self.planets.items()],
            kepler=self.kepler, time_reference=t_ref,
            data=Data(light_curve=light_curve, radial_velocity=rvs, timing=timing),
            fit=FitSettings(use=Use(lc=light_curve is not None, rv=bool(rvs), timing=bool(timing)), free=free, fixed=fixed, timing_noise=self.ephemeris_noise, sampler=sampler or Sampler()),
        )
        return session, keymap


class MultiPlanetFit:
    """Fit a :class:`MultiPlanetSystem` with the ESL core. As in EXOTIC the fit runs when the object is made
    (``run=False`` defers it to ``fit_nested()``).

    After the fit: ``parameters`` (best-fit value of every free parameter, EXOTIC's keys), ``errors`` (posterior
    standard deviations), ``quantiles`` (best +- 3 sigma), ``derived`` (per planet: K, a [au], mu, ars, T14 and more),
    ``results`` (an UltraNest-style dictionary), ``session`` / ``result`` (the ESL session and its result), and the
    best-fit ``model``, ``residuals``, ``scale`` / ``offset`` on every dataset of the system.
    """

    def __init__(self, system: MultiPlanetSystem, max_ncalls: float = 2e5, verbose: bool = True, n_sub: int = 1, stepsampler: bool = False,
                 nsteps: Optional[int] = None, seed: Optional[int] = None, live: int = 400, improvement_loops: Optional[int] = None, run: bool = True) -> None:
        self.system = system
        self.max_ncalls = max_ncalls
        self.verbose = verbose
        self.n_sub = int(n_sub)
        self.stepsampler = stepsampler
        self.nsteps = nsteps
        self.live = int(live)
        self.improvement_loops = improvement_loops
        self.seed = seed
        self.parameters: Dict[str, float] = {}
        self.errors: Dict[str, float] = {}
        self.quantiles: Dict[str, List[float]] = {}
        self.derived: Dict[str, Dict[str, float]] = {}
        self.freekeys: List[str] = []
        self.fmap: List[Tuple[Optional[str], str, Optional[str]]] = []
        self.boundarray: Optional[np.ndarray] = None
        self.keymap: Dict[str, str] = {}
        self.session: Optional[Session] = None
        self.results: Optional[Dict[str, Any]] = None
        if run:
            self.fit_nested()

    @property
    def result(self) -> Optional[Result]:
        return None if self.session is None else self.session.result

    def parameter_space(self) -> Tuple[List[str], np.ndarray]:
        keys, bnds, fmap = self.system.parameter_space()
        keep = [i for i, (_, k, _) in enumerate(fmap) if k != "a1"]
        self.freekeys, self.boundarray, self.fmap = [keys[i] for i in keep], bnds[keep], [fmap[i] for i in keep]
        return self.freekeys, self.boundarray

    def build_session(self) -> Session:
        """The ESL session this fit runs (also available, with the result, as ``self.session`` afterwards)."""
        sampler = Sampler(nlive=self.live, maxCalls=float(self.max_ncalls), seed=42 if self.seed is None else int(self.seed),
                          method="slice" if self.stepsampler else None, sliceSteps=self.nsteps)
        session, self.keymap = self.system.to_session(n_sub=self.n_sub, sampler=sampler)
        self.parameter_space()
        return session

    def fit_nested(self, force: bool = False) -> Dict[str, Any]:
        if self.results is not None and not force:
            return self.results
        session = self.build_session()
        if self.verbose:
            print(f"Fitting {len(self.freekeys)} free parameters for {len(self.system.planets)} planets")
        fit = session.run(progress=bool(self.verbose))
        self.session = fit
        r = fit.result
        assert r is not None and r.samples is not None
        t_ref = fit.time_reference
        cols = r.samples.keys
        pts = np.array(r.samples.values, dtype=float).reshape(-1, len(cols))
        for j, k in enumerate(cols):
            if k.split("@")[0] == "tmid":
                pts[:, j] += t_ref
        order = [cols.index(self.keymap[k]) for k in self.freekeys]
        pts = pts[:, order]
        summ = [r[self.keymap[k]] for k in self.freekeys]
        best = np.array([r.best[self.keymap[k]] for k in self.freekeys])
        std = pts.std(axis=0)
        for i, key in enumerate(self.freekeys):
            self.parameters[key] = float(best[i])
            self.errors[key] = float(std[i])
            self.quantiles[key] = [float(best[i] - 3 * std[i]), float(best[i] + 3 * std[i])]
        med = np.array([s.median for s in summ])
        self.results = {
            "paramnames": list(self.freekeys), "logz": r.logZ, "logzerr": r.logZerr, "ncall": r.ncalls, "niter": None, "H": r.information, "ess": r.ess,
            "samples": pts,
            "weighted_samples": {"points": pts, "logl": np.asarray(r.samples.logl, dtype=float), "weights": np.full(len(pts), 1.0 / max(1, len(pts)))},
            "maximum_likelihood": {"point": best.tolist(), "logl": float(np.max(r.samples.logl)) if len(pts) else None},
            "posterior": {"mean": pts.mean(axis=0).tolist(), "stdev": std.tolist(), "median": med.tolist(),
                          "errlo": [s.median - s.minus for s in summ], "errup": [s.median + s.plus for s in summ]},
            "converged": r.converged, "stop_reason": r.stop_reason, "warnings": list(r.warnings),
        }
        if self.verbose:
            print(r.table())
            for w in r.warnings:
                print("warning:", w)
        self.derived_quantities()
        self.best_fit_models()
        return self.results

    def best_fit_planets(self) -> Dict[str, Dict[str, float]]:
        """Per-planet parameter dictionaries with the best-fit values of the free parameters, ``ars`` and ``mu``."""
        assert self.session is not None
        ev = self.session.best_fit()
        out = {}
        for (letter, sp), q in zip(self.system.planets.items(), ev.planets):
            d = sp.model_dump()
            d.update({k: q[k] for k in ("rprs", "ars", "inc", "per", "tmid", "ecc", "omega", "mplanet") if q.get(k) is not None})
            mstar = ev.values.get("mstar", sp.mstar)
            d["mstar"], d["rstar"] = mstar, ev.values.get("rstar", sp.rstar)
            d["rv_linear"], d["rv_quad"] = ev.values.get("rvlin", sp.rv_linear), ev.values.get("rvquad", sp.rv_quad)
            d["mu"] = d["mplanet"] * MJUP_MSUN / (mstar + d["mplanet"] * MJUP_MSUN)
            out[letter] = d
        return out

    def derived_quantities(self) -> Dict[str, Dict[str, float]]:
        """Derived per-planet quantities at the best fit: EXOTIC's five (K, a [au], mu, ars, T14) and the ESL system table."""
        bf = self.best_fit_planets()
        for letter, d in bf.items():
            star = {"rstar": d["rstar"], "mstar": d["mstar"], "mplanet": d["mplanet"]}
            if self.system.star is not None and self.system.star.teff is not None:
                star["teff"] = self.system.star.teff
            tab = _f.derive(d, star)
            self.derived[letter] = {**{k: v for k, v in tab.items() if v is not None}, "K": tab.get("K"), "a": tab.get("aAU"), "mu": d["mu"], "ars": d["ars"], "T14": tab.get("t14")}
        return self.derived

    def best_fit_models(self, n_samples: int = 100) -> None:
        """Store on every dataset its best-fit model, residuals and normalisation (light curves) or zero point (velocities),
        with the scatter of those two over posterior draws."""
        assert self.session is not None and self.result is not None
        s, r = self.session, self.result
        ev = s.best_fit()
        lcs = sorted(self.system.transit, key=lambda d: float(np.min(d.time)))
        draws_a1: List[np.ndarray] = []
        draws_g: List[List[float]] = []
        npts = (len(ev.light_curve.time) if ev.light_curve else 0) + sum(len(x.time) for x in ev.radial_velocity)
        n = 0 if r.samples is None else min(n_samples if npts < 20000 else 20, len(r.samples.values))
        if n:
            pick = np.random.default_rng(42).choice(len(r.samples.values), size=n, replace=False)
            for i in pick:
                at = {k: float(v) + (s.time_reference if k.split("@")[0] == "tmid" else 0.0) for k, v in zip(r.samples.keys, r.samples.values[i])}
                try:
                    e = s.evaluate(at={**r.best, **at})
                except Exception:
                    continue
                if e.light_curve is not None:
                    draws_a1.append(np.asarray(e.light_curve.a1))
                draws_g.append([x.gamma for x in e.radial_velocity])
        if ev.light_curve is not None:
            L = ev.light_curve
            for k, ds in enumerate(lcs):
                sel = slice(None) if L.epoch is None else (L.epoch == k)
                ds.model = np.asarray(L.model)[sel]
                ds.residuals = np.asarray(ds.flux) - ds.model
                ds.resid_std = float(np.std(ds.residuals))
                ds.scale = float(L.a1[k])
                ds.scale_err = float(np.std([a[k] for a in draws_a1])) if draws_a1 else 0.0
        for k, (ds, m) in enumerate(zip(self.system.radial_velocity, ev.radial_velocity)):
            ds.offset = m.gamma
            ds.offset_err = float(np.std([g[k] for g in draws_g])) if draws_g else 0.0
            ds.model = np.asarray(m.model) + m.gamma
            ds.residuals = np.asarray(ds.vel) - ds.model
            ds.resid_std = float(np.std(ds.residuals))

    # ---- figures (matplotlib; see esl.plot)
    def plot_lightcurves(self, **kw: Any) -> Any:
        from . import plot
        return plot.light_curve(self.session, **kw)

    def plot_rv(self, **kw: Any) -> Any:
        from . import plot
        return plot.radial_velocity(self.session, **kw)

    def plot_posterior(self, truths: Optional[Dict[str, float]] = None, **kw: Any) -> Any:
        """Corner plot coloured by likelihood. ``truths`` may use EXOTIC's keys ("b_mplanet") or ESL's."""
        from . import plot
        t = {self.keymap.get(k, k): v for k, v in (truths or {}).items()}
        labels = {v: k for k, v in self.keymap.items()}
        return plot.corner(self.session, truths=t, labels=labels, **kw)

    def plot_oc(self, **kw: Any) -> Any:
        from . import plot
        return plot.oc(self.session, **kw)
