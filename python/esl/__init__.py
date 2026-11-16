"""Exoplanet Science Lab for Python.

The model, likelihood and nested sampler of https://exoplanet.science, executed from Python: the package bundles
the web application's JavaScript core and runs it in an embedded engine, so a fit here is the fit there.

Three ways in::

    import esl

    # 1. run an analysis exported from the browser
    fit = esl.Session.load("session.json").run(progress=True)

    # 2. build a system the way EXOTIC's multi-planet fitter does
    from esl import multi_fitter as m
    fit = m.MultiPlanetFit(m.MultiPlanetSystem(planets=..., free=..., bounds=..., transit=[...], radial_velocity=[...]))

    # 3. call the models
    flux = esl.transit(times, dict(rprs=0.1, ars=8.8, inc=87, per=3.5, tmid=0, ld=[0.4, 0.26]))
"""
from ._runtime import CoreError, RuntimeUnavailable, available_runtimes, runtime_info, set_runtime
from ._version import __version__
from .functions import (CatalogSystem, EphemerisFit, LimbDarkeningCoefficients, Periodogram, TimingPeriodogram, bands, catalog_location, core, derive, events,
                        fit_ephemeris, limb_darkening, lookup, mass_from_k, periodogram, radial_velocity, read_light_curve, read_rv, search, semi_amplitude, transit)
from .models import (FORMAT, FORMAT_VERSION, Chi2Parts, Data, FitSettings, FreeParameter, LightCurve, LightCurveEpoch, LightCurveModel, Likelihood, LimbDarkening,
                     ModelEvaluation, ParameterSummary, Planet, PlanetParameters, Prior, Progress, Quantity, RadialVelocity, Result, RVModel, RVZeroPoint, Sampler,
                     Samples, Session, Software, Star, TimingModel, TimingPoint, Use)

__all__ = [
    "__version__", "Session", "Star", "LimbDarkening", "Planet", "PlanetParameters", "Data", "LightCurve", "LightCurveEpoch", "RadialVelocity", "TimingPoint",
    "FitSettings", "FreeParameter", "Prior", "Use", "Sampler", "Result", "ParameterSummary", "Quantity", "Chi2Parts", "RVZeroPoint", "Samples", "Software",
    "ModelEvaluation", "LightCurveModel", "RVModel", "TimingModel", "Likelihood", "Progress", "FORMAT", "FORMAT_VERSION",
    "transit", "radial_velocity", "semi_amplitude", "mass_from_k", "limb_darkening", "bands", "fit_ephemeris", "periodogram", "derive", "events",
    "read_light_curve", "read_rv", "lookup", "search", "catalog_location", "core",
    "EphemerisFit", "TimingPeriodogram", "Periodogram", "LimbDarkeningCoefficients", "CatalogSystem",
    "set_runtime", "available_runtimes", "runtime_info", "CoreError", "RuntimeUnavailable",
]
