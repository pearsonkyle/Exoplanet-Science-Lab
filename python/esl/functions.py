"""The pieces of the core a scientist calls directly: models, limb darkening, ephemerides, the catalogue.

Each function hands its arguments to the JavaScript core and returns numpy arrays or small pydantic models.
"""
from __future__ import annotations

import os
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

import numpy as np
from pydantic import Field

from . import _runtime
from .models import Array, IntArray, LightCurve, Model, RadialVelocity, Session

ParamsLike = Union[Mapping[str, Any], Model, Sequence[Union[Mapping[str, Any], Model]]]

_LAW_BY_COUNT = {0: "uniform", 1: "linear", 2: "quadratic", 4: "nonlinear"}


def _params(p: Any) -> Dict[str, Any]:
    """One planet's parameters as the core takes them. Accepts ESL keys (``ld``, ``law``) and EXOTIC's (``u0..u3``)."""
    d = dict(p.model_dump(exclude_none=True) if hasattr(p, "model_dump") else p)
    if "parameters" in d and isinstance(d["parameters"], Mapping):      # an esl.Planet
        d = dict(d["parameters"])
    if "ld" not in d and "u0" in d:
        d["ld"] = [d.get(f"u{i}", 0.0) for i in range(4)]
        d.setdefault("law", "nonlinear")
    if "ld" in d:
        d["ld"] = [float(x) for x in d["ld"]]
    law = d.pop("law", None) or d.pop("ldLaw", None) or d.pop("ld_law", None)
    d["ldLaw"] = law or _LAW_BY_COUNT.get(len(d.get("ld", [])), "uniform")
    return {k: (float(v) if isinstance(v, (int, float, np.floating, np.integer)) and not isinstance(v, bool) else v) for k, v in d.items()}


def _many(params: ParamsLike) -> Any:
    if isinstance(params, (list, tuple)):
        return [_params(p) for p in params]
    return _params(params)


def transit(times: Any, params: ParamsLike, *, exptime: float = 0.0, supersample: Union[int, str] = "auto") -> np.ndarray:
    """Transit light curve (relative flux, 1 out of transit).

    ``params``: ``rprs, ars, inc, per, tmid, ecc, omega`` and limb darkening as ``ld=[...]`` with ``law``
    (uniform, linear, quadratic, kipping, sqrt, nonlinear), or EXOTIC's ``u0..u3`` (the four Claret coefficients).
    Without ``ars``, ``mstar`` and ``rstar`` (and ``mplanet``) give it through Kepler's law. A list of parameter
    sets gives the product of the planets' transits. ``exptime`` (days) averages the model over each exposure;
    ``supersample`` is the number of sub-samples, or "auto" (as many as ingress needs).
    """
    t = np.asarray(times, dtype=float)
    return np.asarray(_runtime.call("transit", t.reshape(-1), _many(params), {"exptime": exptime, "supersample": supersample}), dtype=float).reshape(t.shape)


def radial_velocity(times: Any, params: ParamsLike, *, rvlin: float = 0.0, rvquad: float = 0.0, tref: Optional[float] = None) -> np.ndarray:
    """Radial velocity of the star in m/s, positive when it recedes.

    ``params``: ``per, tmid, ecc, omega`` and either ``K`` [m/s] or ``mplanet`` [M_Jup], ``mstar`` [M_sun], ``inc``
    (K from the two-body formula). A list sums the planets. ``rvlin`` [m/s/d] and ``rvquad`` [m/s/d^2] add a trend
    about ``tref`` (default: the first time).
    """
    t = np.asarray(times, dtype=float)
    return np.asarray(_runtime.call("radialVelocity", t.reshape(-1), _many(params), {"rvlin": rvlin, "rvquad": rvquad, "tref": tref}), dtype=float).reshape(t.shape)


def semi_amplitude(per: float, mplanet: float, mstar: float, ecc: float = 0.0, inc: float = 90.0) -> float:
    """K in m/s from the period [d], planet mass [M_Jup] and stellar mass [M_sun]."""
    return _runtime.call("semiAmplitude", dict(per=per, mplanet=mplanet, mstar=mstar, ecc=ecc, inc=inc))


def mass_from_k(K: float, per: float, mstar: float, ecc: float = 0.0, inc: float = 90.0) -> float:
    """Planet mass [M_Jup] that gives the semi-amplitude K [m/s]."""
    return _runtime.call("massFromK", dict(K=K, per=per, mstar=mstar, ecc=ecc, inc=inc))


class LimbDarkeningCoefficients(Model):
    coeffs: List[float]
    names: List[str]
    law: str
    band: str
    range: List[float] = Field(description="band edges [nm]")
    source: str = Field(description="'table' (37-band PHOENIX table), 'spectral' (wavelength-resolved PHOENIX table) or 'grey' (grey-atmosphere fallback)")
    clamped: bool = Field(description="the star is outside the table and the nearest edge was used")
    claret: List[float] = Field(description="the same profile as four Claret coefficients")
    physical: bool = Field(description="the profile is non-negative and does not brighten toward the limb")

    def __iter__(self):  # so that  u1, u2 = esl.limb_darkening(...)  works
        return iter(self.coeffs)


def limb_darkening(teff: float, logg: float = 4.44, feh: float = 0.0, band: Union[str, Sequence[float]] = "TESS", law: str = "nonlinear") -> LimbDarkeningCoefficients:
    """Limb darkening coefficients of a star from the bundled PHOENIX tables.

    ``band``: a name from ``esl.bands()`` ("TESS", "Kepler", "Johnson V", "Sloan r", "JWST NIRSpec PRISM", ...) or a
    wavelength range ``(nm, nm)`` between 200 and 5500 nm, served by the wavelength-resolved table.
    ``law``: uniform, linear, quadratic, kipping, sqrt or nonlinear.
    """
    if not isinstance(band, str):
        band = [float(band[0]), float(band[1])]
        _runtime.engine().load_spectral()
    return LimbDarkeningCoefficients.model_validate(_runtime.call("limbDarkening", dict(teff=teff, logg=logg, feh=feh), band, law))


def bands() -> List[str]:
    """Names of the bundled passbands."""
    return _runtime.call("info")["bands"]


class EphemerisFit(Model):
    """``T(E) = t0 + per E (+ dPdE E^2 / 2)`` by weighted least squares, uncertainties from the error bars as given."""

    order: int
    n: int
    k: int
    t0: float
    per: float
    dPdE: float = 0.0
    err: Dict[str, float]
    cov: List[List[float]]
    chi2: float
    dof: int
    bic: float
    dPdt: Optional[float] = Field(None, description="days per day (quadratic fits)")
    dPdtErr: Optional[float] = None
    epochs: IntArray
    residuals: Array = Field(description="observed minus fitted, days")
    model: Array
    maxFrac: Optional[float] = Field(None, description="largest distance of a time from a whole orbit, in periods, when epochs were counted")
    predictions: List[Dict[str, float]] = Field(default_factory=list)

    @property
    def reduced_chi2(self) -> float:
        return self.chi2 / max(1, self.dof)

    @property
    def dPdt_ms_per_year(self) -> Optional[float]:
        return None if self.dPdt is None else self.dPdt * 365.25 * 86400e3


def fit_ephemeris(times: Any, errors: Any, epochs: Any = None, period: Optional[float] = None, t_ref: Optional[float] = None,
                  order: int = 1, predict: Optional[Sequence[int]] = None) -> EphemerisFit:
    """Linear (``order=1``) or quadratic (``order=2``) ephemeris from mid-transit times.

    Give the orbit numbers as ``epochs``, or a ``period`` to count them with (from ``t_ref``, default the first time).
    ``predict``: epochs at which to return the predicted time and its 1-sigma uncertainty.
    """
    opts = {"epochs": None if epochs is None else np.asarray(epochs).astype(int), "per": period, "tRef": t_ref, "order": order, "predict": list(predict) if predict is not None else []}
    return EphemerisFit.model_validate(_runtime.call("fitEphemeris", np.asarray(times, dtype=float), np.asarray(errors, dtype=float), opts))


class Periodogram(Model):
    label: str = ""
    freq: Array
    period: Array = Field(description="epochs")
    power: Array
    fapLevels: List[Dict[str, float]] = Field(default_factory=list)
    peaks: List[Dict[str, Any]] = Field(default_factory=list)


class TimingPeriodogram(Model):
    """Lomb-Scargle search of timing residuals: periodograms, sinusoid models, BIC comparison and a verdict in words."""

    n: int
    order: int
    period: float = Field(description="days per epoch, from the baseline ephemeris")
    epochs: Array
    errs: Array
    residuals: Array
    periodograms: List[Optional[Periodogram]]
    models: List[Optional[Dict[str, Any]]]
    curves: List[Optional[Dict[str, Any]]] = Field(default_factory=list)
    best: int
    recommended: int
    significant: bool
    significant2: bool = False
    deltaBic: List[Optional[float]] = Field(default_factory=list)
    verdict: str = ""
    notes: List[str] = Field(default_factory=list)


def periodogram(times: Any, errors: Any, epochs: Any = None, period: Optional[float] = None, t_ref: Optional[float] = None, **options: Any) -> TimingPeriodogram:
    """Search mid-transit times for periodic timing variations (``timingPeriodogram`` of the core).

    Options as in ``src/core/periodogram.js``: ``order`` (1 or 2), ``oversample``, ``minPeriod``, ``maxPeriod``,
    ``normalization``, ``fapThreshold``, ``bootstrap`` (number of bootstrap periodograms), ``seed``, ``refine``,
    ``countPeriods``, ``nPeaks``.
    """
    opts = {"epochs": None if epochs is None else np.asarray(epochs).astype(int), "per": period, "tRef": t_ref, **options}
    return TimingPeriodogram.model_validate(_runtime.call("periodogram", np.asarray(times, dtype=float), np.asarray(errors, dtype=float), opts))


def derive(params: Any, star: Optional[Any] = None) -> Dict[str, float]:
    """The system table for one planet (``deriveSystem``): Rp, a, b, T14, T eclipse, K, T eq, densities, ...

    ``star``: ``rstar`` [R_sun], ``mstar`` [M_sun], ``teff`` [K], ``mplanet`` [M_Jup] (a dict or an ``esl.Star``).
    """
    p = _params(params)
    s = dict(star.model_dump(exclude_none=True) if hasattr(star, "model_dump") else (star or {}))
    for k in ("rstar", "mstar", "mplanet"):
        if k not in s and k in p:
            s[k] = p[k]
    return _runtime.call("derive", p, s)


def events(params: Any) -> Dict[str, float]:
    """Times of periastron and mid-eclipse nearest the transit, and the transit and eclipse durations (``eventTimes``)."""
    return _runtime.call("events", _params(params))


# ---- files ------------------------------------------------------------------------------------------------------

def _text(source: Union[str, Path]) -> str:
    if isinstance(source, Path) or (isinstance(source, str) and "\n" not in source and len(source) < 1024 and Path(source).exists()):
        return Path(source).read_text(encoding="utf-8", errors="replace")
    return str(source)


def read_light_curve(source: Union[str, Path], name: Optional[str] = None, exposure_min: float = 0.0, **options: Any) -> LightCurve:
    """Read a light curve with the web application's reader: delimited text, AAVSO exoplanet reports, EXOTIC
    FinalLightCurve files, magnitudes, JD / MJD / BTJD / BKJD. ``source`` is a path or the text itself."""
    label = name or (Path(source).stem if isinstance(source, Path) or (isinstance(source, str) and "\n" not in source) else "light curve")
    d = _runtime.call("parseLightCurve", _text(source), label, options)
    lc = LightCurve(name=label, time=d["time"], flux=d["f"], flux_err=d["e"], airmass=d.get("airmass"), exposure_min=exposure_min)
    lc.__pydantic_extra__ = {"notes": d.get("notes", []), "time_system": d.get("timeSystem"), "flux_units": d.get("fluxUnits")}
    return lc


def read_rv(source: Union[str, Path], name: str = "RV") -> List[RadialVelocity]:
    """Read radial velocities (time, velocity, uncertainty, optional instrument column): one dataset per instrument, m/s."""
    d = _runtime.call("parseRV", _text(source), name)
    return [RadialVelocity(name=s["name"], time=s["t"], velocity=s["v"], velocity_err=s["e"]) for s in d["sets"]]


# ---- the catalogue ----------------------------------------------------------------------------------------------

DEFAULT_CATALOG_URL = "https://exoplanet.science/catalog/"


def catalog_location() -> str:
    """Where ``lookup`` reads the archive snapshot: ``$ESL_CATALOG``, else ``public/catalog`` of a repository
    checkout that contains this package, else the web site."""
    env = os.environ.get("ESL_CATALOG")
    if env:
        return env
    for up in Path(__file__).resolve().parents:
        cand = up / "public" / "catalog" / "index.json"
        if cand.exists():
            return str(cand.parent)
    return DEFAULT_CATALOG_URL


def _fetcher(where: str):
    if where.startswith(("http://", "https://")):
        base = where if where.endswith("/") else where + "/"

        def get(name: str) -> str:
            with urllib.request.urlopen(base + name, timeout=30) as r:     # noqa: S310 - the user's catalogue URL
                return r.read().decode("utf-8")
        return get
    root = Path(where)
    return lambda name: (root / name).read_text(encoding="utf-8")


class CatalogSystem(Model):
    """What the catalogue holds for a name: the chosen reference per planet with its checks, and a session to start from."""

    host: str
    planet: Optional[str] = None
    planets: List[str] = Field(default_factory=list)
    snapshot: Optional[str] = None
    system: Dict[str, Any] = Field(description="systemFromRows(): star, planets with values, sources, checks, alternatives, priors")
    session: Session = Field(description="values filled in, nothing free; each planet carries suggested_priors")


def lookup(name: str, catalog: Optional[Union[str, Path]] = None, use: str = "all") -> Optional[CatalogSystem]:
    """Parameters of a planet or host from the NASA Exoplanet Archive snapshot the web application uses.

    For each planet the reference with the most complete and self-consistent set is chosen (``chooseParameters``),
    gaps are filled and labelled, and wide priors are suggested. ``use``: "transit", "rv", "ephemeris" or "all".
    ``catalog``: a folder or URL holding ``index.json`` and the shards (see ``catalog_location``). Returns None
    when the name is not in the snapshot.
    """
    where = str(catalog) if catalog is not None else catalog_location()
    out = _runtime.run_job("lookup", [name, {"use": use, "key": where}], fetch=_fetcher(where))
    return None if out is None else CatalogSystem.model_validate(out)


def search(query: str, catalog: Optional[Union[str, Path]] = None, limit: int = 12) -> List[Dict[str, Any]]:
    """Names in the catalogue that start with or contain ``query``."""
    where = str(catalog) if catalog is not None else catalog_location()
    return _runtime.run_job("search", [query, {"key": where, "limit": limit}], fetch=_fetcher(where))


# ---- everything else --------------------------------------------------------------------------------------------

class _Core:
    """Direct access to the bundled core. ``esl.core.invoke("kepler.eventTimes", params)`` calls any export of any
    module of ``src/core``; ``esl.core.modules()`` lists them. Functions added to the core appear here after
    ``node tools/build_core_bundle.mjs`` with no change to this package."""

    def info(self) -> Dict[str, Any]:
        return _runtime.call("info")

    def modules(self) -> Dict[str, List[str]]:
        return _runtime.call("info")["modules"]

    def invoke(self, path: str, *args: Any) -> Any:
        return _runtime.call("invoke", path, list(args))

    def invoke_async(self, path: str, *args: Any, fetch: Any = None) -> Any:
        """For core functions that return a promise; pass "$fetchJson" where the function takes a fetch callback."""
        return _runtime.run_job("invoke", [path, list(args)], fetch=fetch)

    def call(self, name: str, *args: Any) -> Any:
        return _runtime.call(name, *args)


core = _Core()
