"""The ESL session as pydantic models, one-to-one with ``docs/FORMAT.md``.

A session is one JSON document describing an analysis completely: the system, the data, what is free with
which prior, the sampler settings and, once run, the result. The web application writes it; these classes read
it, build it, run it and write it back::

    session = Session.load("hd80606.json")          # a browser export
    fit = session.run(progress=True)                # the same code the browser ran
    print(fit.result.table())
    fit.save("hd80606_python.json")                 # opens in the browser again

Every model keeps keys it does not know (``extra="allow"``), so documents written by a newer version of the
application, or carrying parameters of models added later (phase curves, moons, ...), pass through unchanged.
Arrays are numpy arrays in Python and plain JSON lists on disk.
"""
from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Callable, Dict, List, Literal, Optional, Sequence, Union

import numpy as np
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer, WithJsonSchema, field_validator, model_validator

from . import _runtime

FORMAT = "esl-session"
FORMAT_VERSION = 1


def _to_f64(v: Any) -> Any:
    if v is None:
        return None
    return np.asarray([np.nan if x is None else x for x in v] if isinstance(v, list) and any(x is None for x in v) else v, dtype=np.float64)


def _to_i32(v: Any) -> Any:
    return None if v is None else np.asarray(v, dtype=np.int64)


_ser = PlainSerializer(lambda a: None if a is None else np.asarray(a).tolist(), when_used="json")
#: A one-dimensional (or, for samples, two-dimensional) array of floats: numpy in Python, a list in JSON.
Array = Annotated[np.ndarray, BeforeValidator(_to_f64), _ser, WithJsonSchema({"type": "array", "items": {"type": "number"}})]
IntArray = Annotated[np.ndarray, BeforeValidator(_to_i32), _ser, WithJsonSchema({"type": "array", "items": {"type": "integer"}})]


class Model(BaseModel):
    """Base of every model here: unknown keys are kept, numpy arrays are allowed."""

    model_config = ConfigDict(extra="allow", arbitrary_types_allowed=True, populate_by_name=True)

    def to_dict(self) -> Dict[str, Any]:
        """Plain JSON-able data (lists, not arrays), without the keys that are unset."""
        return self.model_dump(mode="json", exclude_none=True)


# ---- the system -------------------------------------------------------------------------------------------------

class Software(Model):
    name: str = "exoplanet-science-lab"
    version: Optional[str] = None
    commit: Optional[str] = None


class Star(Model):
    """The star. Radius in solar radii, mass in solar masses; the ``...Err`` fields are 1-sigma uncertainties."""

    teff: Optional[float] = Field(None, description="Effective temperature [K]")
    teffErr: Optional[float] = None
    logg: Optional[float] = Field(None, description="Surface gravity, log10 cgs")
    loggErr: Optional[float] = None
    feh: Optional[float] = Field(None, description="Metallicity [Fe/H], dex")
    fehErr: Optional[float] = None
    rstar: Optional[float] = Field(None, description="Radius [R_sun]")
    rstarErr: Optional[float] = None
    mstar: Optional[float] = Field(None, description="Mass [M_sun]")
    mstarErr: Optional[float] = None


LD_LAWS = {"uniform": 0, "linear": 1, "quadratic": 2, "kipping": 2, "sqrt": 2, "nonlinear": 4}


class LimbDarkening(Model):
    """Limb darkening of the star.

    ``law``: uniform, linear, quadratic (u1, u2), kipping (q1, q2), sqrt (c, d) or nonlinear (Claret's four
    coefficients, ``I = 1 - sum a_n (1 - mu^(n/2))``).
    ``mode``: "coeffs", the coefficients are parameters (``ld0`` .. ``ld3``); "star", they follow the star's
    Teff and [Fe/H] through the PHOENIX tables, and ``teff`` / ``feh`` may be free instead.
    ``band``: one of ``esl.bands()`` or "Custom range" with ``band_custom = [nm, nm]``.
    """

    law: str = "quadratic"
    mode: Literal["coeffs", "star"] = "coeffs"
    band: Optional[str] = "TESS (approx.)"
    band_custom: Optional[List[float]] = None
    coefficients: List[float] = Field(default_factory=lambda: [0.4, 0.25])

    @field_validator("law")
    @classmethod
    def _law(cls, v: str) -> str:
        v = "sqrt" if v in ("squareroot", "square-root") else v      # docs/FORMAT.md says "squareroot", the core "sqrt"
        if v not in LD_LAWS:
            raise ValueError(f"unknown limb darkening law {v!r}: one of {', '.join(LD_LAWS)}")
        return v

    @model_validator(mode="after")
    def _count(self) -> "LimbDarkening":
        if self.mode == "coeffs" and len(self.coefficients) < LD_LAWS[self.law]:
            raise ValueError(f"the {self.law} law takes {LD_LAWS[self.law]} coefficients, got {len(self.coefficients)}")
        return self


class PlanetParameters(Model):
    """Parameters of one planet. Anything else (keys of models added later) is kept and passed to the core."""

    rprs: Optional[float] = Field(None, description="Planet radius / stellar radius")
    ars: Optional[float] = Field(None, description="Semi-major axis / stellar radius (ignored when Session.kepler is true)")
    inc: Optional[float] = Field(None, description="Inclination [deg]")
    per: Optional[float] = Field(None, description="Period [d]")
    tmid: Optional[float] = Field(None, description="Mid-transit time (inferior conjunction), absolute, same system as the data")
    ecc: Optional[float] = Field(0.0, description="Eccentricity")
    omega: Optional[float] = Field(0.0, description="Argument of periastron [deg]")
    mplanet: Optional[float] = Field(None, description="Mass [M_Jup]")
    K: Optional[float] = Field(None, description="Radial-velocity semi-amplitude [m/s]; replaces mplanet when given")


class Planet(Model):
    letter: str = "b"
    parameters: PlanetParameters = Field(default_factory=PlanetParameters)


# ---- the data ---------------------------------------------------------------------------------------------------

class LightCurveEpoch(Model):
    """One observation (night, orbit, instrument) inside a light curve with several."""

    name: str = ""
    airmass: bool = False
    exposure_min: Optional[float] = None


class LightCurve(Model):
    """Relative flux against time. Several observations go in one light curve with ``epoch`` (an index per point)
    and ``epochs`` (one entry per observation); each then has its own normalisation and airmass slope."""

    name: str = "light curve"
    time: Array
    flux: Array
    flux_err: Array
    airmass: Optional[Array] = None
    exposure_min: float = Field(0.0, description="Exposure time in minutes; the model is averaged over it where ingress needs it")
    epoch: Optional[IntArray] = None
    epochs: List[LightCurveEpoch] = Field(default_factory=list)

    @model_validator(mode="after")
    def _lengths(self) -> "LightCurve":
        n = len(self.time)
        for k in ("flux", "flux_err", "airmass", "epoch"):
            a = getattr(self, k)
            if a is not None and len(a) != n:
                raise ValueError(f"light curve: time has {n} points and {k} has {len(a)}")
        return self

    @classmethod
    def combine(cls, curves: Sequence["LightCurve"], name: str = "light curves") -> "LightCurve":
        """Several light curves of the same star as the epochs of one (each keeps its normalisation and airmass slope)."""
        curves = list(curves)
        if len(curves) == 1:
            return curves[0]
        order = np.argsort([float(np.min(c.time)) for c in curves])
        curves = [curves[i] for i in order]
        any_air = any(c.airmass is not None for c in curves)
        return cls(
            name=name,
            time=np.concatenate([c.time for c in curves]), flux=np.concatenate([c.flux for c in curves]), flux_err=np.concatenate([c.flux_err for c in curves]),
            airmass=np.concatenate([c.airmass if c.airmass is not None else np.zeros(len(c.time)) for c in curves]) if any_air else None,
            exposure_min=max(c.exposure_min or 0.0 for c in curves),
            epoch=np.concatenate([np.full(len(c.time), k) for k, c in enumerate(curves)]),
            epochs=[LightCurveEpoch(name=c.name, airmass=c.airmass is not None, exposure_min=c.exposure_min or None) for c in curves],
        )


class RadialVelocity(Model):
    """Velocities of one instrument, m/s. Its zero point is integrated out; its jitter is the parameter ``jit@rv<n>``."""

    name: str = "RV"
    time: Array
    velocity: Array
    velocity_err: Array

    @model_validator(mode="after")
    def _lengths(self) -> "RadialVelocity":
        if not (len(self.time) == len(self.velocity) == len(self.velocity_err)):
            raise ValueError(f'velocities "{self.name}": time, velocity and velocity_err must have the same length')
        return self


class TimingPoint(Model):
    """A mid-transit or mid-eclipse time of a planet, with its 1-sigma uncertainty in days."""

    planet: Optional[str] = None
    kind: Literal["transit", "eclipse"] = "transit"
    time: float
    err: float
    source: Optional[str] = None


class Data(Model):
    light_curve: Optional[LightCurve] = None
    radial_velocity: List[RadialVelocity] = Field(default_factory=list)
    timing: List[TimingPoint] = Field(default_factory=list)


# ---- the fit ----------------------------------------------------------------------------------------------------

class Prior(Model):
    """``uniform``: a = minimum, b = maximum. ``normal``: a = mean, b = standard deviation. For ``tmid`` the values are absolute times."""

    type: str = "uniform"
    a: float
    b: float

    @classmethod
    def uniform(cls, lower: float, upper: float) -> "Prior":
        return cls(type="uniform", a=lower, b=upper)

    @classmethod
    def normal(cls, mean: float, sd: float) -> "Prior":
        return cls(type="normal", a=mean, b=sd)

    def __str__(self) -> str:
        return f"{'Normal' if self.type == 'normal' else self.type.capitalize()}({self.a:.10g}, {self.b:.10g})"


class FreeParameter(Model):
    """A sampled parameter. Keys: planet parameters ``rprs, inc, per, tmid, ecc, omega, mplanet, K`` (``per@c`` for
    planet c), limb darkening ``ld0 .. ld3``, airmass slope ``a2`` (``a2@2`` for the second epoch), velocities
    ``rvlin, rvquad, jit@rv1``, star ``mstar, rstar, teff, feh``. ``ars`` is never free."""

    key: str
    label: Optional[str] = None
    unit: Optional[str] = None
    prior: Prior


class Use(Model):
    """Which kinds of data enter the likelihood."""

    lc: bool = True
    rv: bool = True
    timing: bool = True


class Sampler(Model):
    """Settings of the nested sampler (``src/core/nested.js``)."""

    nlive: int = Field(400, description="Live points")
    fracRemain: float = Field(0.01, description="Stop when the live points hold less than this fraction of the evidence")
    seed: int = 42
    maxCalls: float = Field(1e6, description="Budget of likelihood calls")
    maxSeconds: Optional[float] = Field(None, description="Wall-clock budget")
    method: Optional[str] = Field(None, description="'auto' (default), 'region' or 'slice'")
    sliceSteps: Optional[int] = None


class FitSettings(Model):
    use: Use = Field(default_factory=Use)
    free: List[FreeParameter] = Field(default_factory=list)
    fixed: Dict[str, float] = Field(default_factory=dict, description="Values of non-planet parameters that are not free: a2, rvlin, rvquad, jit@rv1, ...")
    timing_noise: float = Field(0.0, description="Days, added in quadrature to every timing error")
    sampler: Sampler = Field(default_factory=Sampler)


# ---- the result -------------------------------------------------------------------------------------------------

class ParameterSummary(Model):
    key: str
    label: Optional[str] = None
    unit: Optional[str] = None
    median: float
    plus: float
    minus: float
    best: Optional[float] = None

    @property
    def err(self) -> float:
        """Half the width of the 68% interval."""
        return 0.5 * (self.plus + self.minus)


class Quantity(Model):
    median: float
    plus: float = 0.0
    minus: float = 0.0


class Chi2Parts(Model):
    light_curve: Optional[float] = 0.0
    radial_velocity: Optional[float] = 0.0
    timing: Optional[float] = 0.0


class RVZeroPoint(Model):
    name: str
    gamma: float
    jitter: float = 0.0


class Samples(Model):
    """Equal-weight posterior draws. ``values[i, k]`` is draw i of parameter ``keys[k]``; times are relative to the session's ``time_reference``."""

    keys: List[str]
    values: Array
    logl: Array

    def column(self, key: str) -> np.ndarray:
        return self.values[:, self.keys.index(key)]


class Result(Model):
    """What a run returns: evidence, posterior summaries, derived quantities, best fit, chi-square, draws."""

    logZ: float
    logZerr: float
    information: Optional[float] = None
    ess: Optional[float] = None
    ncalls: int
    seconds: Optional[float] = None
    converged: bool
    stop_reason: Optional[str] = None
    warnings: List[str] = Field(default_factory=list)
    parameters: List[ParameterSummary] = Field(default_factory=list)
    derived: Dict[str, Optional[Quantity]] = Field(default_factory=dict)
    best: Dict[str, float] = Field(default_factory=dict)
    chi2: Optional[float] = None
    chi2_parts: Optional[Chi2Parts] = None
    n_data: Optional[int] = None
    bic: Optional[float] = None
    rv_zero_points: List[RVZeroPoint] = Field(default_factory=list)
    samples: Optional[Samples] = None

    def __getitem__(self, key: str) -> ParameterSummary:
        for p in self.parameters:
            if p.key == key:
                return p
        raise KeyError(key)

    def __contains__(self, key: object) -> bool:
        return any(p.key == key for p in self.parameters)

    @property
    def medians(self) -> Dict[str, float]:
        return {p.key: p.median for p in self.parameters}

    @property
    def errors(self) -> Dict[str, float]:
        return {p.key: p.err for p in self.parameters}

    def table(self) -> str:
        """The fitted and derived parameters as text."""
        def fmt(med: float, plus: float, minus: float) -> str:
            e = min(x for x in (plus, minus, np.inf) if x > 0)
            d = 6 if not np.isfinite(e) else int(min(10, max(0, 1 - np.floor(np.log10(e)))))
            return f"{med:.{d}f} +{plus:.{d}f} -{minus:.{d}f}"
        rows = [(p.key, fmt(p.median, p.plus, p.minus), p.unit or "") for p in self.parameters]
        shown = ("K", "mplanet", "ars", "b", "t14", "emid", "rpJup")
        have = {p.key for p in self.parameters}
        drows = [(k, fmt(q.median, q.plus, q.minus) if (q.plus > 0 or q.minus > 0) else f"{q.median:.8g}", "") for k, q in self.derived.items() if q is not None and k.split("@")[0] in shown and k not in have]
        w = max([len(r[0]) for r in rows + drows] + [9])
        lines = [f"{'converged' if self.converged else 'NOT converged (' + str(self.stop_reason) + ')'}: {self.ncalls} calls" + (f", {self.seconds:.1f} s" if self.seconds is not None else "")
                 + f", ln Z = {self.logZ:.3f} +- {self.logZerr:.3f}" + (f", chi2 = {self.chi2:.2f} for {self.n_data} measurements" if self.chi2 is not None else "")]
        lines += [f"  {k:<{w}}  {v}  {u}".rstrip() for k, v, u in rows]
        if drows:
            lines.append("  derived:")
            lines += [f"  {k:<{w}}  {v}".rstrip() for k, v, _ in drows]
        return "\n".join(lines)


# ---- a model evaluation -----------------------------------------------------------------------------------------

class LightCurveModel(Model):
    name: str = ""
    time: Array
    flux: Array
    flux_err: Array
    airmass: Optional[Array] = None
    epoch: Optional[IntArray] = None
    epochs: List[str] = Field(default_factory=list)
    model: Array = Field(description="normalisation x airmass term x transit: what the data are compared with")
    baseline: Array = Field(description="normalisation x airmass term")
    transit: Array = Field(description="the bare transit model (1 out of transit)")
    transits: List[Array] = Field(default_factory=list, description="one bare transit model per planet")
    a1: Array = Field(description="normalisation of each epoch at its conditional maximum")

    @property
    def residuals(self) -> np.ndarray:
        return self.flux - self.model

    @property
    def detrended(self) -> np.ndarray:
        """Flux divided by the baseline: comparable with ``transit``."""
        return self.flux / self.baseline


class RVModel(Model):
    name: str = ""
    time: Array
    velocity: Array
    velocity_err: Array
    gamma: float = Field(description="zero point at its conditional maximum [m/s]")
    jitter: float = 0.0
    chi2: float = 0.0
    model: Array = Field(description="planets + trend, without the zero point")
    planets: List[Array] = Field(default_factory=list)

    @property
    def residuals(self) -> np.ndarray:
        return self.velocity - self.gamma - self.model


class TimingModel(Model):
    planet: str
    kind: str
    time: Array
    err: Array
    model: Array
    epoch: IntArray

    @property
    def residuals(self) -> np.ndarray:
        return self.time - self.model


class ModelEvaluation(Model):
    """The model of a session at one point of parameter space, with every per-point piece."""

    lnL: float
    chi2: float
    chi2_parts: Chi2Parts
    n_data: int
    n_linear: int
    bic: float
    keys: List[str] = Field(default_factory=list)
    values: Dict[str, float] = Field(default_factory=dict)
    light_curve: Optional[LightCurveModel] = None
    radial_velocity: List[RVModel] = Field(default_factory=list)
    timing: List[TimingModel] = Field(default_factory=list)
    planets: List[Dict[str, Any]] = Field(default_factory=list)
    limb_darkening: List[float] = Field(default_factory=list)
    rv_tref: Optional[float] = None


# ---- progress ---------------------------------------------------------------------------------------------------

class Progress(Model):
    """One progress report of the sampler, about eight a second."""

    it: int = 0
    ncalls: int = 0
    logZ: Optional[float] = None
    remFrac: Optional[float] = None
    eff: Optional[float] = None
    mode: Optional[str] = None
    bestL: Optional[float] = None
    best: List[float] = Field(default_factory=list)
    keys: List[str] = Field(default_factory=list)
    elapsed: float = 0.0


def _printer() -> Callable[[Dict[str, Any]], None]:
    import sys

    def show(p: Dict[str, Any]) -> None:
        rem = p.get("remFrac")
        line = (f"\r  iter {p.get('it', 0):>7}  calls {p.get('ncalls', 0):>8}  eff {100 * (p.get('eff') or 0):5.1f}%  ln Z {p.get('logZ') if p.get('logZ') is not None else float('nan'):>12.3f}"
                f"  remainder {100 * rem if rem is not None else float('nan'):6.2f}%  {p.get('elapsed', 0):6.1f} s" + ("  slice" if p.get("mode") == "slice" else "       "))
        sys.stderr.write(line)
        sys.stderr.flush()
    return show


class Likelihood:
    """A session's likelihood, opened in the core for repeated calls (your own sampler or optimiser).

    ``like(theta)`` takes an array of shape (ndim,) or (n, ndim) in the order of ``like.keys`` (``tmid`` absolute)
    and returns ln L; invalid points give -1e100. ``like.transform(u)`` maps unit-cube points through the priors.
    Use it as a context manager, or call ``close()``.
    """

    def __init__(self, session: "Session", use: Optional[Dict[str, bool]] = None) -> None:
        session._ensure_tables()
        info = _runtime.call("problemOpen", session.to_dict(), use)
        self._id: Optional[int] = info["id"]
        self.keys: List[str] = info["keys"]
        self.ndim: int = info["ndim"]
        self.n_data: int = info["n_data"]

    def __call__(self, theta: Any, repeat: int = 1) -> Any:
        th = np.asarray(theta, dtype=float)
        out = np.asarray(_runtime.call("problemLogLike", self._id, th.reshape(-1), repeat), dtype=float)
        return float(out[0]) if th.ndim == 1 else out

    def transform(self, cube: Any) -> np.ndarray:
        u = np.asarray(cube, dtype=float)
        return np.asarray(_runtime.call("problemTransform", self._id, u.reshape(-1)), dtype=float).reshape(u.shape)

    def close(self) -> None:
        if self._id is not None:
            _runtime.call("problemClose", self._id)
            self._id = None

    def __enter__(self) -> "Likelihood":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---- the session ------------------------------------------------------------------------------------------------

class Session(Model):
    """One analysis: system, data, fit set-up and (after ``run``) result. See ``docs/FORMAT.md``."""

    format: str = FORMAT
    version: int = FORMAT_VERSION
    software: Optional[Software] = None
    created: Optional[str] = None
    name: Optional[str] = None
    title: Optional[str] = None
    notes: Optional[str] = None
    star: Star = Field(default_factory=Star)
    limb_darkening: LimbDarkening = Field(default_factory=LimbDarkening)
    planets: List[Planet]
    kepler: bool = Field(False, description="a/R* follows from Kepler's law (M*, R*, P, Mp) instead of each planet's ars")
    time_reference: float = Field(0.0, description="Times are measured from here inside a fit; everything in the document is absolute")
    data: Data = Field(default_factory=Data)
    fit: FitSettings = Field(default_factory=FitSettings)
    result: Optional[Result] = None

    @model_validator(mode="after")
    def _check(self) -> "Session":
        if self.format != FORMAT:
            raise ValueError(f'not an ESL session (format should be "{FORMAT}")')
        if not (1 <= self.version <= FORMAT_VERSION):
            raise ValueError(f"session version {self.version} is not supported by this package (it reads up to {FORMAT_VERSION})")
        if not self.planets:
            raise ValueError("a session needs at least one planet")
        return self

    # -- files
    @classmethod
    def load(cls, path: Union[str, Path]) -> "Session":
        """Read a session file (a browser export, or one written by ``save``)."""
        return cls.model_validate_json(Path(path).read_text(encoding="utf-8"))

    def save(self, path: Union[str, Path], indent: Optional[int] = None) -> Path:
        """Write the session (with its result, if any) as JSON; the web application opens it."""
        path = Path(path)
        path.write_text(self.model_dump_json(exclude_none=True, indent=indent), encoding="utf-8")
        return path

    # -- convenience
    @property
    def letters(self) -> List[str]:
        return [p.letter for p in self.planets]

    @property
    def free_keys(self) -> List[str]:
        return [f.key for f in self.fit.free]

    def key(self, name: str, planet: Optional[str] = None) -> str:
        """The parameter key of a planet's field: ``key("per", "c") == "per@c"``; the first planet's keys are plain."""
        return name if planet is None or planet == self.planets[0].letter else f"{name}@{planet}"

    def planet(self, letter: str) -> Planet:
        for p in self.planets:
            if p.letter == letter:
                return p
        raise KeyError(letter)

    def free(self, key: str, prior: Prior, planet: Optional[str] = None, **kw: Any) -> "Session":
        """Make a parameter free (replacing its prior if it already is). Returns self, so calls chain."""
        k = self.key(key, planet)
        self.fit.free = [f for f in self.fit.free if f.key != k] + [FreeParameter(key=k, prior=prior, **kw)]
        return self

    def fix(self, key: str, planet: Optional[str] = None) -> "Session":
        k = self.key(key, planet)
        self.fit.free = [f for f in self.fit.free if f.key != k]
        return self

    def summary(self) -> str:
        """A few lines saying what the session holds."""
        d, lines = self.data, [f"{self.title or self.name or 'session'}"]
        lines.append(f"  planets: {', '.join(self.letters)}" + ("  (a/R* from Kepler's law)" if self.kepler else ""))
        if d.light_curve is not None:
            lc = d.light_curve
            lines.append(f"  light curve: {len(lc.time)} points" + (f" in {len(lc.epochs)} epochs" if len(lc.epochs) > 1 else "") + ("" if self.fit.use.lc else "  (not in the fit)"))
        for r in d.radial_velocity:
            lines.append(f"  velocities {r.name}: {len(r.time)} points" + ("" if self.fit.use.rv else "  (not in the fit)"))
        if d.timing:
            lines.append(f"  timing: {len(d.timing)} mid-times" + ("" if self.fit.use.timing else "  (not in the fit)"))
        lines.append(f"  limb darkening: {self.limb_darkening.law}, " + ("following the star" if self.limb_darkening.mode == "star" else "fixed or sampled coefficients"))
        lines.append(f"  free ({len(self.fit.free)}): " + ", ".join(f"{f.key} ~ {f.prior}" for f in self.fit.free))
        lines.append(f"  sampler: {self.fit.sampler.nlive} live points, seed {self.fit.sampler.seed}")
        return "\n".join(lines)

    # -- the core
    def _ensure_tables(self) -> None:
        ld = self.limb_darkening
        if ld.mode == "star" and ld.band == "Custom range":
            _runtime.engine().load_spectral()

    def check(self) -> "Session":
        """Validate with the core's own rules (``validateSession`` and the limb darkening set-up). Raises ``esl.CoreError``."""
        self._ensure_tables()
        _runtime.call("validate", self.to_dict())
        return self

    def evaluate(self, at: Optional[Dict[str, float]] = None, use: Optional[Dict[str, bool]] = None) -> ModelEvaluation:
        """The model, chi-square and ln L at given parameter values: the session's own by default, the best fit
        with ``at=session.result.best``. Keys as in ``fit.free`` (``tmid`` absolute)."""
        self._ensure_tables()
        return ModelEvaluation.model_validate(_runtime.call("evaluate", self.to_dict(), at, use))

    def best_fit(self) -> ModelEvaluation:
        """The model at the best-fit point of the stored result (at the session's values when there is none)."""
        return self.evaluate(at=self.result.best if self.result is not None else None)

    def likelihood(self, use: Optional[Dict[str, bool]] = None) -> Likelihood:
        """Open the likelihood for repeated evaluation; see :class:`Likelihood`."""
        return Likelihood(self, use)

    def run(self, progress: Union[bool, Callable[[Progress], None], None] = False, keep_samples: bool = True, max_samples: int = 2000,
            use: Optional[Dict[str, bool]] = None, **sampler: Any) -> "Session":
        """Run the fit. Returns a new session with ``result`` filled in, exactly as the web application writes it.

        ``progress``: True prints a status line to stderr; a function receives :class:`Progress` objects.
        ``sampler`` keywords override ``fit.sampler`` for this run (``nlive=200, seed=3, maxCalls=2e5, ...``).
        Ctrl-C stops the sampler cleanly and returns what it has (``result.converged`` is then False).
        """
        self._ensure_tables()
        doc = self.to_dict()
        if sampler:
            doc["fit"]["sampler"] = {**doc["fit"].get("sampler", {}), **sampler}
        doc.pop("result", None)
        if progress is True:
            cb: Optional[Callable[[Dict[str, Any]], None]] = _printer()
        elif callable(progress):
            fn = progress
            cb = lambda p: fn(Progress.model_validate(p))      # noqa: E731
        else:
            cb = None
        out = _runtime.run_job("run", [doc, {"keepSamples": keep_samples, "maxSamples": max_samples, "use": use}], on_progress=cb)
        if progress is True:
            import sys
            sys.stderr.write("\n")
        return type(self).model_validate(out)

    # -- text exports (the same functions the web application uses: src/core/exportScript.js)
    def to_script(self, embed_data: bool = True, session_file: str = "session.json", figures: bool = True, prefix: Optional[str] = None) -> str:
        """A standalone Python script that rebuilds this session line by line, runs it and draws the figures."""
        return _runtime.call("pythonScript", self.to_dict(), {"embedData": embed_data, "sessionFile": session_file, "figures": figures, "prefix": prefix})

    def to_markdown(self, session_file: str = "session.json") -> str:
        """A report: system, data, priors, sampler, results, software version, how to reproduce."""
        return _runtime.call("markdownReport", self.to_dict(), {"sessionFile": session_file})

    def to_latex(self) -> str:
        """LaTeX tables of the fitted and derived parameters and of the priors."""
        return _runtime.call("latexTables", self.to_dict())
