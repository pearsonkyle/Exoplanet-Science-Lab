"""SED fitting through Python: the same star as test/sed.test.mjs fits in JavaScript."""
from pathlib import Path

import pytest

import esl

PUBLIC = Path(__file__).resolve().parents[2] / "public"
pytestmark = pytest.mark.skipif(not (PUBLIC / "stellar" / "phoenix.esls").exists(), reason="the stellar spectra are not in this checkout")


def test_hd209458_against_interferometry():
    mags = {"Gaia BP": (7.793284, 0.002848), "Gaia G": (7.521246, 0.002776), "Gaia RP": (7.080288, 0.003844), "Tycho BT": (8.334, 0.017), "Tycho VT": (7.699, 0.012),
            "2MASS J": (6.591, 0.020), "2MASS H": (6.366, 0.038), "2MASS Ks": (6.308, 0.026), "WISE W3": (6.320, 0.016), "WISE W4": (6.265, 0.053)}
    r = esl.star_fit(mags, parallax=(20.7694, 0.0266), logg=(4.28, 0.1), feh=(0.0, 0.1), public=PUBLIC)
    p = r["parameters"]
    assert r["converged"] and len(r["bands"]) == 10
    assert abs(p["theta_mas"]["median"] / 0.2254 - 1) < 0.04          # Boyajian et al. 2015: 0.2254 +- 0.0072 mas
    assert abs(p["teff"]["median"] - 6092) < 120                      # 6092 +- 103 K
    assert 1.10 < p["rstar"]["median"] < 1.25 and p["lum"]["median"] > 1.5
    assert any(b["name"] == "Gaia G" and b["system"] == "Vega" for b in esl.star_bands())
    with pytest.raises(esl.CoreError):
        esl.star_fit({"Gaia G": (7.5, 0.01)}, public=PUBLIC)             # fewer than three magnitudes
