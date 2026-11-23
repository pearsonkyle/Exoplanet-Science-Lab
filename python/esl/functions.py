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

    def summary(self) -> str:
        """The fit in a few readable lines (what ``print(fit)`` shows)."""
        kind = "Quadratic" if self.order == 2 else "Linear"
        lines = [f"{kind} ephemeris from {self.n} times",
                 f"  T0 = {self.t0:.6f} +- {self.err.get('t0', float('nan')):.6f} BJD_TDB",
                 f"  P  = {self.per:.8f} +- {self.err.get('per', float('nan')):.8f} d"]
        if self.order == 2 and self.dPdt is not None:
            lines.append(f"  dP/dt = {self.dPdt_ms_per_year:.2f} +- {(self.dPdtErr or 0) * 365.25 * 86400e3:.2f} ms per year")
        lines.append(f"  chi2 = {self.chi2:.1f} for {self.dof} degrees of freedom (reduced {self.reduced_chi2:.2f}), BIC = {self.bic:.1f}")
        if self.reduced_chi2 > 2:
            lines.append("  reduced chi2 well above 1: the error bars are too small for this model, or the times vary in another way")
        for p in self.predictions[:5]:
            lines.append(f"  epoch {p.get('epoch')}: {p.get('t', float('nan')):.5f} +- {1440 * p.get('err', float('nan')):.1f} min")
        return "\n".join(lines)

    def __str__(self) -> str:
        return self.summary()


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

    def summary(self) -> str:
        """The verdict in words, then the models compared (what ``print(pg)`` shows)."""
        lines = [self.verdict] if self.verdict else []
        for m in self.models:
            if m:
                lines.append(f"  {m.get('name', m.get('key')):<18s} chi2 = {m.get('chi2', float('nan')):.1f}  BIC = {m.get('bic', float('nan')):.1f}" +
                             "".join(f"  [period {t['period']:.2f} epochs = {t['periodDays']:.1f} d, amplitude {1440 * t['amp']:.1f} min]" for t in m.get("terms", [])))
        return "\n".join(lines + [f"  note: {n}" for n in self.notes])

    def __str__(self) -> str:
        return self.summary()


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


def read_light_curve(source: Union[str, Path], name: Optional[str] = None, exposure_min: float = 0.0, detrend: Optional[Dict[str, Any]] = None, **options: Any) -> LightCurve:
    """Read a light curve with the web application's reader: delimited text, AAVSO exoplanet reports, EXOTIC
    FinalLightCurve files, magnitudes, JD / MJD / BTJD / BKJD. ``source`` is a path or the text itself. Further
    numeric columns (centroids, sky, FWHM, ...) are kept in ``columns``; ``detrend`` (e.g. ``{"columns": ["xc", "yc"],
    "poly": 1}``, see :class:`esl.models.Detrend`) puts a systematics model built on them in the baseline."""
    label = name or (Path(source).stem if isinstance(source, Path) or (isinstance(source, str) and "\n" not in source) else "light curve")
    d = _runtime.call("parseLightCurve", _text(source), label, options)
    cols = d.get("columns") or None
    lc = LightCurve(name=label, time=d["time"], flux=d["f"], flux_err=d["e"], airmass=d.get("airmass"), exposure_min=exposure_min, columns=cols, detrend=detrend if cols else None)
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


# ---- atmospheres ----------------------------------------------------------------------------------------------------

def _opacity_dir(opacity_dir: Optional[Union[str, Path]] = None) -> Path:
    """The folder with the site's public data (``opacity/*.eslo``, ``chem/equilibrium.eslc``): the argument, the
    environment variable ``ESL_PUBLIC``, or ``public/`` of a checkout this package was installed from."""
    for cand in (opacity_dir, os.environ.get("ESL_PUBLIC"), Path(__file__).resolve().parents[2] / "public"):
        if cand and (Path(cand) / "opacity" / "index.json").exists():
            return Path(cand)
    raise FileNotFoundError(
        "the opacity tables were not found. They are not part of the pip package (25 MB): pass public= the folder that "
        "holds opacity/ and chem/ (the public/ folder of a checkout of exoplanet-science-lab), or set ESL_PUBLIC.")


def atmosphere_worlds() -> List[Dict[str, Any]]:
    """The preset worlds (``name``, ``about``, ``tables``): WASP-39 b, WASP-121 b's day side, Jupiter, Titan."""
    return _runtime.call("atmosphereWorlds")


def atmosphere(world: Optional[str] = None, model: Optional[Mapping[str, Any]] = None, *, wl_min: Optional[float] = None,
               wl_max: Optional[float] = None, merge: int = 1, R: Optional[float] = None, species: Optional[Sequence[str]] = None,
               emission: bool = True, transmission: bool = True, public: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """Transmission and emission spectrum of a model atmosphere (the forward model of the Atmosphere page).

    ``world``: one of :func:`atmosphere_worlds`; ``model``: a model description, or changes to the world's (planet,
    star, tp, vmr, chemistry, condensation, cloud, haze, cloudTop, bulk, ...: see ``src/core/rtmodel.js``).
    ``tp={"kind": "consistent", "teq": ..., "f": 0.25}`` works the temperatures out from the gases; ``chemistry=
    {"mh": 0, "co": 0.59}`` takes the gases from chemical equilibrium; ``condensation={"rainout": True}`` rains them out.
    ``wl_min``/``wl_max`` (micron) cut the opacity tables to that range first and ``merge`` joins that many bins: both
    make a run faster. ``R`` bins the answer. Returns ``wl, lo, hi, depth, fpfs, flux, brightness`` as arrays, the
    ``profile`` (``p`` in bar, ``t``, ``mu``, ``z`` in km, ``gases``), ``clouds``, ``climate`` and the ``model`` as run.
    """
    import base64
    request: Dict[str, Any] = {k: v for k, v in dict(world=world, model=dict(model) if model else None, wlMin=wl_min, wlMax=wl_max, merge=merge, R=R,
                                                     species=list(species) if species else None, emission=emission, transmission=transmission).items() if v is not None}
    need = _runtime.call("atmosphereNeeds", request)
    have = set(_runtime.call("atmosphereLoaded"))
    want = [s for s in list(need["lines"]) + list(need["cia"]) if s not in have]
    chem = need.get("chem") and "chem" not in have
    if want or chem:
        root = _opacity_dir(public)
        b64 = lambda p: base64.b64encode(Path(p).read_bytes()).decode("ascii")
        _runtime.call("atmosphereLoad", {s: b64(root / "opacity" / f"{s}.eslo") for s in want}, b64(root / "chem" / "equilibrium.eslc") if chem else None)
    out = _runtime.call("atmosphereRun", request)
    for k in ("wl", "lo", "hi", "depth", "fpfs", "flux", "brightness"):
        if out.get(k) is not None:
            out[k] = np.asarray(out[k], dtype=float)
    prof = out["profile"]
    for k in ("p", "t", "mu", "z"):
        prof[k] = np.asarray(prof[k], dtype=float)
    prof["gases"] = {k: np.asarray(v, dtype=float) for k, v in prof["gases"].items()}
    return out


def retrieve_atmosphere(data: Sequence[Mapping[str, Any]], free: Sequence[str], world: Optional[str] = None, model: Optional[Mapping[str, Any]] = None, *,
                        priors: Optional[Mapping[str, Any]] = None, species: Optional[Sequence[str]] = None, merge: Optional[int] = None, layers: int = 30,
                        nlive: int = 100, max_models: int = 20000, max_seconds: Optional[float] = None, seed: int = 42,
                        public: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """Fit a model atmosphere to spectra with nested sampling (an atmospheric retrieval).

    ``data``: one mapping per spectrum, ``{"kind": "transit" | "eclipse" | "night", "wl": micron, "y": depth (or
    Fp/Fs), "err": ..., "lo": ..., "hi": ...}`` (bin edges optional). ``free``: the parameters fitted: ``teq, tint,
    logKappaIR, logGamma`` (Guillot profile), ``t`` (isothermal), ``mh, co`` (chemical equilibrium), ``logX_<gas>``,
    ``rplanet, logCloudTop, cloudFraction, logHaze, hazeSlope, nightDT, offset_<n>``. ``world`` / ``model`` as in
    :func:`atmosphere`: what is not free stays as given; the profile must be ``"guillot"`` or ``"isothermal"``.
    ``priors``: ``{key: (low, high)}`` (uniform); wide defaults otherwise, returned as ``priors``.

    Returns ``summary`` (``median, lo, hi, best`` per key: the 16, 50 and 84% points), ``logZ``, ``logZerr``,
    ``converged``, ``chi2``, ``ndata``, ``ncalls``, ``seconds``, ``warnings`` and ``best`` (``values`` and the model
    ``spectra`` on each data set's bins). ``converged`` False means the budget (``max_models``, ``max_seconds``) ran
    out first: the summary is then not a posterior. A fit takes from seconds to many minutes (2000 to 30000 models
    per free parameter). ``layers`` sets the number of layers (30) and ``merge`` joins opacity bins (default: as many
    as leave three model bins in one of the data's), both for speed: together about 10 ppm on a hot Jupiter. Without
    ``lo`` and ``hi`` the bins are taken to meet halfway between neighbouring wavelengths.
    """
    import base64
    sets = []
    for d in data:
        sets.append({k: (np.asarray(v, dtype=float).tolist() if k in ("wl", "y", "err", "lo", "hi") else v) for k, v in dict(d).items() if v is not None})
    request: Dict[str, Any] = {k: v for k, v in dict(world=world, model=dict(model) if model else None, data=sets, free=list(free),
                                                     priors={k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in priors.items()} if priors else None,
                                                     species=list(species) if species else None, merge=merge, layers=layers,
                                                     sampler={k: v for k, v in dict(nlive=nlive, maxCalls=max_models, maxSeconds=max_seconds, seed=seed).items() if v is not None}).items() if v is not None}
    need = _runtime.call("atmosphereRetrieveNeeds", request)
    have = set(_runtime.call("atmosphereLoaded"))
    want = [s for s in list(need["lines"]) + list(need["cia"]) if s not in have]
    chem = (need.get("chem") or any(k in ("mh", "co", "logQuench") for k in free)) and "chem" not in have
    if want or chem:
        root = _opacity_dir(public)
        b64 = lambda p: base64.b64encode(Path(p).read_bytes()).decode("ascii")
        _runtime.call("atmosphereLoad", {s: b64(root / "opacity" / f"{s}.eslo") for s in want}, b64(root / "chem" / "equilibrium.eslc") if chem else None)
    out = _runtime.call("atmosphereRetrieve", request)
    out["best"]["spectra"] = [np.asarray(a, dtype=float) for a in out["best"]["spectra"]]
    return out


# ---- stars ----------------------------------------------------------------------------------------------------------

def star_bands() -> List[Dict[str, Any]]:
    """The passbands :func:`star_fit` knows (``name``, ``survey``, ``system`` Vega or AB, zero point ``zp`` in Jy)."""
    return _runtime.call("starBands")


def star_fit(magnitudes: Mapping[str, Sequence[float]], *, parallax: Optional[Sequence[float]] = None, logg: Optional[Sequence[float]] = None,
             feh: Optional[Sequence[float]] = None, av_max: float = 0.1, teff: Optional[Sequence[float]] = None, floor: float = 0.02,
             nlive: int = 300, seed: int = 42, public: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """A star's effective temperature, angular diameter, radius and luminosity from catalogue magnitudes (an SED fit).

    ``magnitudes``: ``{"Gaia G": (7.521, 0.003), "2MASS J": (6.591, 0.020), ...}`` with band names of :func:`star_bands`
    (Vega magnitudes for Gaia, Tycho, Johnson, 2MASS, WISE; AB for SDSS, Pan-STARRS, GALEX, as the catalogues give them).
    ``parallax`` (mas, error) gives the radius and luminosity; ``logg`` and ``feh`` (value, sigma) are priors, worth giving
    because magnitudes hardly constrain them; ``av_max`` bounds the extinction searched. Returns ``parameters`` (each with
    ``median, lo, hi, best``), ``bands`` (model magnitude and residual of each), ``spectrum``, ``chi2``, ``converged`` and
    ``warnings``. Models: PHOENIX-ACES, 2300 to 8000 K, main-sequence gravities (the grid of the Star page).
    """
    import base64
    if not _runtime.call("starLoaded"):
        _runtime.call("starLoad", base64.b64encode((_opacity_dir(public) / "stellar" / "phoenix.esls").read_bytes()).decode("ascii"))
    obs = [dict(band=k, mag=float(v[0]), err=float(v[1])) for k, v in magnitudes.items()]
    priors: Dict[str, Any] = dict(avMax=float(av_max))
    for key, val in (("plx", parallax), ("logg", logg), ("feh", feh), ("teff", teff)):
        if val is not None:
            priors[key] = [float(val[0]), float(val[1])]
    out = _runtime.call("starFit", obs, dict(priors=priors, floor=floor, nlive=nlive, seed=seed))
    out["spectrum"] = {k: np.asarray(v, dtype=float) for k, v in out["spectrum"].items()}
    return out
