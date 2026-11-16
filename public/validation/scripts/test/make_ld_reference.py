# Independent reference for the bundled limb darkening table (src/data/ld_table.js): ExoTETHyS
# coefficients (Morello et al. 2020) as shipped with pylightcurve 4, read through pylightcurve's own
# exotethys() (its trilinear interpolation, its passband files, its law fits). Run with an environment
# that has pylightcurve:
#   /path/to/python test/make_ld_reference.py        -> test/limbdark_reference.json
#
# What is and is not independent:
#   - 'phoenix' cases: ExoTETHyS processed the same PHOENIX-ACES model family the table is built from
#     (the grids coincide, including the missing 5000 K model), with its own band integration, limb
#     definition, law fits and interpolation. So these check the table's processing, the grid it keeps
#     and the app's interpolation, not the atmosphere physics. pylightcurve's PHOENIX set is solar
#     metallicity only (it resets [Fe/H] to 0, with a message), so every phoenix case has feh 0.
#   - 'atlas' cases: ATLAS9 plane-parallel models, a different atmosphere code, Teff >= 3500 K, with
#     metallicity. They are stored at the star's [Fe/H] and at [Fe/H] = 0 so the test can compare the
#     metallicity response of the table (I at [Fe/H] minus I at 0) with an independent one, and can
#     report how far two atmosphere codes differ in absolute terms.
import contextlib, io, json, os
import numpy as np
from pylightcurve import exotethys
import pylightcurve

# name, Teff, log g, [Fe/H]: M to F dwarfs off the table nodes, an A star, and two stars that fall
# outside the table (a subgiant with log g below 4.0; Teff above 8000 K) to show what clamping costs.
STARS = [
    ("TRAPPIST-1 (M8)", 2566, 5.24, 0.04),
    ("LHS 1140 (M4.5)", 3096, 5.04, -0.15),
    ("GJ 1214-like (M4)", 3250, 4.95, 0.20),
    ("GJ 436 (M2.5)", 3586, 4.84, 0.02),
    ("WASP-43 (K7)", 4400, 4.65, -0.05),
    ("HD 189733 (K2)", 5052, 4.59, -0.03),
    ("KELT-11 (G8 subgiant, log g outside the table)", 5375, 3.70, 0.17),
    ("HD 80606 (G5)", 5565, 4.40, 0.35),
    ("Sun (G2)", 5772, 4.44, 0.00),
    ("HD 209458 (F9)", 6091, 4.45, 0.00),
    ("WASP-12 (F9, low gravity)", 6360, 4.16, 0.30),
    ("WASP-121 (F6)", 6459, 4.24, 0.13),
    ("WASP-33 (A5)", 7430, 4.30, 0.10),
    ("KELT-9 (B9.5, Teff outside the table)", 9600, 4.10, 0.00),
]
# table filter name (key of FILTERS in src/core/ldest.js) -> pylightcurve filter name
FILTERS = {
    "TESS (approx.)": "TESS", "Kepler (approx.)": "Kepler", "CHEOPS (approx.)": "CHEOPS",
    "Johnson U": "JOHNSON_U", "Johnson B": "JOHNSON_B", "Johnson V": "JOHNSON_V", "Cousins R": "COUSINS_R", "Cousins I": "COUSINS_I",
    "Sloan u": "sdss_u", "Sloan g": "sdss_g", "Sloan r": "sdss_r", "Sloan i": "sdss_i", "Sloan z": "sdss_z",
    "Near-Infrared J": "2mass_j", "Near-Infrared H": "2mass_h", "Near-Infrared K": "2mass_ks",
}
# pylightcurve's square-root law is I = 1 - c1 (1 - sqrt(mu)) - c2 (1 - mu); the app's is [c, d] with c on (1 - mu), so swap
LAWS = {"nonlinear": ("claret", 4), "quadratic": ("quad", 2), "linear": ("linear", 1), "sqrt": ("sqrt", 2)}


def coeffs(logg, teff, feh, filt, model):
    out = {}
    for law, (method, n) in LAWS.items():
        with contextlib.redirect_stdout(io.StringIO()):      # pylightcurve prints when it resets [Fe/H]
            c = exotethys(logg, teff, feh, filt, method=method, stellar_model=model)
        out[law] = [round(float(x), 6) for x in (c[:n][::-1] if law == "sqrt" else c[:n])]
    return out


cases = []
for name, teff, logg, feh in STARS:
    for esl, plc in FILTERS.items():
        cases.append({"star": name, "teff": teff, "logg": logg, "feh": 0.0, "filter": esl, "model": "phoenix", **coeffs(logg, teff, 0.0, plc, "phoenix")})
        if plc != "CHEOPS" and 3500 <= teff <= 10000 and logg <= 5.0:        # ATLAS grid; no CHEOPS file
            for z in sorted({0.0, feh}):
                cases.append({"star": name, "teff": teff, "logg": logg, "feh": z, "filter": esl, "model": "atlas", **coeffs(logg, teff, z, plc, "atlas")})

ref = {
    "source": f"ExoTETHyS coefficients via pylightcurve {pylightcurve.__version__} exotethys(); see the header of test/make_ld_reference.py",
    # the coefficients used throughout EXOTIC's examples for HD 80606 in the TESS band
    "anchor": {"star": "HD 80606", "filter": "TESS (approx.)", "teff": 5565, "logg": 4.4, "feh": 0.0, "feh_star": 0.35,
               "nonlinear": [0.49387060813646527, -0.07294561715247563, 0.4578497817617948, -0.21582471000247333],
               "note": "exotethys(logg, teff, feh, 'TESS', method='claret', stellar_model='phoenix'); pylightcurve resets [Fe/H] to 0 for PHOENIX, "
                       "so the published numbers are for solar metallicity. With log g 4.4 the current pylightcurve data reproduce them to 1.2e-4 (pylightcurve_now)."},
    "cases": cases,
}
with contextlib.redirect_stdout(io.StringIO()):
    now = [float(x) for x in exotethys(4.4, 5565, 0.35, "TESS", method="claret", stellar_model="phoenix")]
ref["anchor"]["pylightcurve_now"] = now
print("anchor: pylightcurve now gives", np.round(now, 5), "max difference from the published coefficients", f"{np.abs(np.array(now) - ref['anchor']['nonlinear']).max():.1e}")
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "limbdark_reference.json")
with open(out, "w") as fh:
    json.dump(ref, fh, separators=(",", ":"))
print(f"wrote {out}: {len(cases)} cases, {os.path.getsize(out) / 1024:.0f} KB")
