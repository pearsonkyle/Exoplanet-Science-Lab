"""An ephemeris from 40 mid-transit times, and a search for periodic timing variations:
EXOTIC's examples/ephemeris/fit_ephemeris.py.

Should print (README, "EXOTIC's examples, reproduced" and "Periodic signals in the timing residuals"):
    ephemeris     40 mid-times against statsmodels WLS, before and after the example's 3 sigma clip:
                  T0, P and errors agree to 1e-6; 26 of 40 survive the clip
    periodogram   on EXOTIC's 40-time example: 57.3 d, 2.78 +- 0.16 min
"""
import json

import numpy as np

import esl
from _common import Checks, csv, figures_wanted, repo

check = Checks()
ROOT = repo()
times = csv(ROOT / "public/examples/ephemeris/transit_times.csv")
t, err = times["tmid"], times["err"]
W = json.loads((ROOT / "test" / "exotic_reference.json").read_text())["ephemeris"]      # statsmodels, run by test/make_exotic_reference.py

fit = esl.fit_ephemeris(t, err, period=2.7962868, t_ref=float(t.min()))
print(f"T0 = {fit.t0:.6f} +- {fit.err['t0']:.6f}, P = {fit.per:.9f} +- {fit.err['per']:.3e} d, chi2/dof = {fit.reduced_chi2:.1f}")
w = W["wls"]
check("40 times, orbits counted from the period", fit.n == 40 and fit.maxFrac < 0.05)
check("T0 and P equal statsmodels WLS", abs(fit.t0 - w["T0"]) < 1e-3 * w["T0_err"] + 1e-9 and abs(fit.per - w["P"]) < 1e-4 * w["P_err"], f"statsmodels: {w['T0']:.6f}, {w['P']:.9f}")
check("their uncertainties agree to 1e-6", abs(fit.err["t0"] / w["T0_err"] - 1) < 1e-6 and abs(fit.err["per"] / w["P_err"] - 1) < 1e-6)

keep = np.abs(fit.residuals / err) < 3                         # the example's clip: the timing signal itself is counted as outliers
clipped = esl.fit_ephemeris(t[keep], err[keep], epochs=fit.epochs[keep])
w2 = W["wls_clipped"]
check("26 of 40 survive the example's 3 sigma clip", int(keep.sum()) == 26 == W["kept"])
check("after the clip: P and its error equal statsmodels", abs(clipped.per - w2["P"]) < 1e-4 * w2["P_err"] and abs(clipped.err["per"] / w2["P_err"] - 1) < 1e-6, f"P = {clipped.per:.9f} +- {clipped.err['per']:.3e}")

quad = esl.fit_ephemeris(t, err, epochs=fit.epochs, order=2)
print(f"quadratic: dP/dt = {quad.dPdt_ms_per_year:.1f} +- {quad.dPdtErr * 365.25 * 86400e3:.1f} ms/yr, BIC {quad.bic:.1f} against {fit.bic:.1f} linear")
nxt = esl.fit_ephemeris(t, err, epochs=fit.epochs, predict=[int(fit.epochs.max()) + k for k in (1, 100)]).predictions
print("next transit:", f"{nxt[0]['t']:.5f} +- {nxt[0]['sigma'] * 1440:.2f} min; in 100 orbits: +- {nxt[1]['sigma'] * 1440:.2f} min")

pg = esl.periodogram(t, err, epochs=fit.epochs)
peak, term = pg.periodograms[0].peaks[0], pg.models[1]["terms"][0]
print(pg.verdict)
check("strongest peak at 57.3 d", abs(peak["periodDays"] - 57.3) < 0.2, f"{peak['periodDays']:.2f} d, false-alarm probability {peak['fap']:.1e}")
check("amplitude 2.78 +- 0.16 min", abs(term["amp"] * 1440 - 2.78) < 0.02 and abs(term["ampErr"] * 1440 - 0.16) < 0.01, f"{term['amp'] * 1440:.2f} +- {term['ampErr'] * 1440:.2f} min")
check("the peak is significant and a sinusoid lowers the BIC", pg.significant and pg.recommended >= 1, f"delta BIC {pg.deltaBic[1]:.1f}")

out = figures_wanted()
if out:
    import esl.plot
    esl.plot.ephemeris(fit, t, err).savefig(out / "ephemeris_oc.png", dpi=150)
    esl.plot.periodogram(pg).savefig(out / "ephemeris_periodogram.png", dpi=150)
check.finish()
