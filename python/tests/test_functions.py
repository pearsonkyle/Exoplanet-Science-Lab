"""Limb darkening, ephemerides, periodogram, derived quantities, readers, the catalogue."""
import numpy as np
import pytest

import esl

from conftest import EXAMPLES, LD_TESS_HD80606, csv


def _profile(a, mu):
    return 1 - sum(a[n] * (1 - mu ** ((n + 1) / 2)) for n in range(4))


def test_limb_darkening_hd80606_tess_against_exotethys():
    # README: against the coefficients EXOTIC's examples use (ExoTETHyS, solar metallicity): I(mu) rms 5.6e-5
    ld = esl.limb_darkening(5565, 4.4, 0.0, "TESS", "nonlinear")
    mu = np.linspace(0.05, 1, 200)
    rms = float(np.sqrt(np.mean((_profile(ld.coeffs, mu) - _profile(LD_TESS_HD80606, mu)) ** 2)))
    print(f"\nHD 80606 / TESS: I(mu) rms against ExoTETHyS {rms:.1e}")
    assert ld.source == "table" and not ld.clamped and ld.physical and ld.band == "TESS (approx.)" and rms < 2e-4
    # at the star's own metallicity the profile moves by 0.0043 rms (README)
    z = esl.limb_darkening(5565, 4.4, 0.35, "TESS")
    assert 0.002 < float(np.sqrt(np.mean((_profile(z.coeffs, mu) - _profile(ld.coeffs, mu)) ** 2))) < 0.008


def test_limb_darkening_laws_bands_and_fallbacks():
    assert len(esl.bands()) >= 37 and "Johnson V" in esl.bands()
    mu = np.linspace(0.1, 1, 50)
    ref = _profile(esl.limb_darkening(5000, 4.5, 0.0, "Kepler").claret, mu)
    for law, n in (("linear", 1), ("quadratic", 2), ("kipping", 2), ("sqrt", 2), ("nonlinear", 4), ("uniform", 0)):
        r = esl.limb_darkening(5000, 4.5, 0.0, "Kepler", law)
        assert len(r.coeffs) == n == len(r.names)
        if n >= 2:
            assert np.max(np.abs(_profile(r.claret, mu) - ref)) < 0.03, law
    u1, u2 = esl.limb_darkening(5000, 4.5, 0.0, "kepler", "quadratic")
    assert 0.3 < u1 < 0.7 and 0 < u2 < 0.4
    assert esl.limb_darkening(9600, 4.0, 0.0, "TESS").clamped                # off the grid: nearest edge, flagged
    wide = esl.limb_darkening(5000, 4.5, 0.0, (430, 890), "quadratic")       # a custom range: the wavelength-resolved table
    assert wide.source == "spectral" and np.allclose(wide.coeffs, [u1, u2], atol=0.05)
    assert esl.limb_darkening(5000, 4.5, 0.0, (6000, 8000), "quadratic").source == "grey"     # beyond 5.5 micron: grey fallback
    with pytest.raises(esl.CoreError, match="not one of the bundled bands"):
        esl.limb_darkening(5000, 4.5, 0.0, "Gaia G")


def test_ephemeris_against_numpy(exotic_ref):
    E = exotic_ref["ephemeris"]
    t, e = np.array(E["tmid"]), np.array(E["tmid_err"] if "tmid_err" in E else E["err"])
    fit = esl.fit_ephemeris(t, e, period=E["P_guess"], t_ref=float(t.min()))
    ep = np.asarray(fit.epochs, float)
    A = np.vstack([np.ones_like(ep), ep]).T / e[:, None]
    coef, *_ = np.linalg.lstsq(A, (t - t[0]) / e, rcond=None)
    cov = np.linalg.inv(A.T @ A)
    assert fit.n == len(t) and fit.maxFrac < 0.1
    assert fit.per == pytest.approx(coef[1], abs=1e-3 * np.sqrt(cov[1, 1])) and fit.t0 == pytest.approx(t[0] + coef[0], abs=1e-3 * np.sqrt(cov[0, 0]))
    assert fit.err["per"] == pytest.approx(np.sqrt(cov[1, 1]), rel=1e-6) and fit.err["t0"] == pytest.approx(np.sqrt(cov[0, 0]), rel=1e-6)
    assert np.allclose(fit.residuals, t - (fit.t0 + fit.per * ep), atol=1e-7) and fit.chi2 == pytest.approx(float(np.sum((fit.residuals / e) ** 2)), rel=1e-6)
    pred = esl.fit_ephemeris(t, e, epochs=fit.epochs, predict=[int(ep.max()) + 500]).predictions[0]
    assert pred["t"] == pytest.approx(fit.t0 + fit.per * (ep.max() + 500), abs=1e-6) and pred["sigma"] > fit.err["t0"]
    quad = esl.fit_ephemeris(t, e, epochs=fit.epochs, order=2)
    assert quad.order == 2 and quad.dPdt is not None and quad.chi2 <= fit.chi2
    with pytest.raises(esl.CoreError, match="period"):
        esl.fit_ephemeris(t, e)


def test_periodogram_on_exotics_example(repo):
    a = csv(EXAMPLES / "ephemeris" / "transit_times.csv")
    pg = esl.periodogram(a["tmid"], a["err"], period=2.7962868)
    pk = pg.periodograms[0].peaks[0]
    amp = pg.models[1]["terms"][0]
    print(f"\n{pg.n} times: strongest peak {pk['periodDays']:.1f} d, FAP {pk['fap']:.1e}; amplitude {amp['amp'] * 1440:.2f} +- {amp['ampErr'] * 1440:.2f} min")
    # README: "On EXOTIC's 40-time example it finds 57.3 d, 2.78 +- 0.16 min"
    assert pg.n == 40 and abs(pk["periodDays"] - 57.3) < 0.5 and abs(amp["amp"] * 1440 - 2.78) < 0.05 and abs(amp["ampErr"] * 1440 - 0.16) < 0.02
    assert pg.significant and pg.recommended >= 1 and pg.verdict and len(pg.periodograms[0].power) == len(pg.periodograms[0].period)
    assert pg.curves[1] is not None and len(pg.curves[1]["E"]) == len(pg.curves[1]["y"])


def test_derived_quantities_reproduce_table_7():
    # Pearson et al. (2022), Table 7, fed its own values (README, "System table")
    p = dict(rprs=np.sqrt(0.01019), ars=94.452, inc=89.24, per=111.436765, tmid=2458888.07466, ecc=0.93183, omega=-58.887)
    d = esl.derive(p, dict(rstar=1.05, mstar=1.05, teff=5565, mplanet=4.1641))
    # the tolerances of test/physics.test.mjs against the paper: Rp 1.032 R_Jup, a 0.4603 au, a/R* 94.452, K 469.22 m/s, T14 0.4990 d
    assert abs(d["rpJup"] - 1.032) < 0.006 and abs(d["aKeplerAU"] - 0.4603) < 0.0006 and abs(d["arsKepler"] - 94.452) < 0.25
    assert abs(d["K"] - 469.22) < 1.5 and abs(d["t14"] - 0.4990) < 0.001
    ev = esl.events(p)
    assert abs(ev["e14"] - 0.0834) < 0.0005                    # this code and a 30-digit orbit; the paper's 0.0717 d is reproduced by neither
    assert ev["tperi"] < p["tmid"] and abs(d["emid"] - ev["tecl"]) < 1e-9


def test_readers_are_the_analyzers(repo):
    lc = esl.read_light_curve(EXAMPLES / "hd80606" / "2458888_08_lightcurve.csv", name="TESS", exposure_min=2)
    raw = csv(EXAMPLES / "hd80606" / "2458888_08_lightcurve.csv")
    assert len(lc.time) == len(raw) and lc.exposure_min == 2 and lc.name == "TESS"
    assert np.allclose(lc.time, raw[raw.dtype.names[0]], atol=1e-6) and np.array_equal(lc.flux, raw[raw.dtype.names[1]])
    sets = esl.read_rv(EXAMPLES / "hd80606" / "HD80606_RV.csv")
    assert sum(len(s.time) for s in sets) >= 264 and {"HIRES_k", "ELODIE", "HRS"} <= {s.name for s in sets}
    text = "BJD,flux,err\n" + "".join(f"{2459000.1 + 0.01 * i},{1.0 - 0.01 * (4 < i < 8)},0.001\n" for i in range(12))
    lc2 = esl.read_light_curve(text)
    assert len(lc2.time) == 12 and lc2.time[0] == pytest.approx(2459000.1, abs=1e-6) and lc2.flux.min() == 0.99
    with pytest.raises(esl.CoreError, match="fewer than 10"):
        esl.read_light_curve("BJD,flux,err\n2459000.1,1.0,0.001\n")


def test_lookup_in_the_catalogue_snapshot(repo):
    hit = esl.lookup("HD 80606 b")
    assert hit is not None and hit.host == "HD 80606" and hit.planet == "HD 80606 b" and hit.snapshot
    p = hit.session.planets[0]
    assert p.letter == "b" and p.reference == "Pearson et al. 2022"            # README: "for HD 80606 b it picks Pearson et al. 2022"
    assert abs(p.parameters.per - 111.436765) < 1e-4 and abs(p.parameters.ecc - 0.93183) < 1e-3 and abs(p.parameters.ars - 94.45) < 0.3
    assert "per" in p.suggested_priors and hit.session.star.teff and hit.system["planets"][0]["checks"]
    assert esl.lookup("hd80606b").host == "HD 80606"                             # names are matched loosely
    assert esl.lookup("No Such Star b") is None
    multi = esl.lookup("TRAPPIST-1")
    assert len(multi.session.planets) == 7 and multi.session.letters[0] == "b"
    assert any(h["label"].startswith("WASP-12") for h in esl.search("wasp12"))
    with pytest.raises(esl.CoreError):
        esl.lookup("HD 80606 b", catalog=repo / "public" / "examples")           # no index there
