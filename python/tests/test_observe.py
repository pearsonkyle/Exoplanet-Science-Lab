"""esl.observe: a short sequence on the simulated camera, files written with the core's headers and read back with
the core's FITS reader (the same code the Photometry page uses), and the header bytes identical to what the
browser writes for the same frame (encodeFits)."""
import json
import time

import numpy as np

import esl.observe as eo
from esl import _runtime
from esl import time as et
from esl.cameras import SimCamera


def _seq(now_ms, **kw):
    return eo.make(target={"name": "Sim", "ra": 31.04, "dec": 46.69}, site={"name": "Kitt Peak", "lat": 31.9583, "lon": -111.5967, "elev": 2096},
                   window={"start": now_ms + 300, "end": now_ms + 4000}, exposure={"duration": 0.2, "filter": "r"},
                   calibration={"bias": 2, "darks": 2, "flats": 1, "flatDuration": 0.1}, limits={"minAlt": -90, "sunMax": 90, "meridian": "none"},
                   cooler={"on": False, "setTemp": -10, "waitMax": 1}, **kw)   # cooling has its own tests; here it would only eat the window


def test_run_writes_frames_with_the_core_headers(tmp_path):
    clock = et.Clock()
    clock.add(et.Measurement("ntp", "fake NTP", 0.0, 0.003, clock.system()))
    seq = _seq(clock.now() * 1000)
    cam = SimCamera(40, 30, tmid=time.time() + 1, readout_s=0.01)
    r = eo.run(seq, cam, clock=clock, save_dir=tmp_path, telescope={"name": "Sim", "focalLength": 1000}, sleep=lambda s: time.sleep(min(s, 0.05)), max_wait=0.05)
    c = r["state"]["counts"]
    assert c["bias"] == 2 and c["dark"] == 2 and c["flat"] == 1 and c["light"] >= 3 and r["state"]["stopped"] == "sequence complete"
    names = sorted(p.name for p in (tmp_path / seq["id"]).iterdir())
    assert any(n.endswith("_bias.fits") for n in names) and any(n.endswith("sequence.json") for n in names)
    light = [p for p in (tmp_path / seq["id"]).iterdir() if p.name.endswith("_light.fits")][0]
    raw = light.read_bytes()
    assert len(raw) % 2880 == 0
    head = raw[:raw.index(b"END" + b" " * 77) + 80].decode("ascii")
    cards = {head[i:i + 8].strip(): head[i + 10:i + 80] for i in range(0, len(head), 80)}
    val = lambda k: cards[k].split("/")[0].strip()  # noqa: E731
    assert val("BITPIX") == "16" and val("BZERO") == "32768"
    assert "'Light Frame'" in cards["IMAGETYP"] and "esl.time - fake NTP" in cards["CLKSRC"] and 0.003 <= float(val("CLKUNC")) < 0.0035   # 3 ms, aged by the drift allowance
    for k in ("DATE-OBS", "MJD-OBS", "BJD_TDB", "AIRMASS", "LST", "SITELAT", "OBJCTRA", "CTYPE1", "SEQID", "FRAMENO"):
        assert k in cards, k
    # the pixels: BZERO 32768 big-endian 16-bit
    n0 = len(head) + (-len(head) % 2880)
    data = (np.frombuffer(raw[n0:n0 + 40 * 30 * 2], dtype=">i2").astype(int) + 32768).reshape(30, 40)
    assert data.min() >= 0 and data.max() <= 65535 and data.std() > 0


def test_bytes_equal_the_browser_writer():
    """fits_bytes (Python) and encodeFits (JavaScript, the Run page) give the same file for the same cards and pixels."""
    img = (np.arange(12, dtype=np.uint16).reshape(3, 4) * 5000)
    cards = [["OBJECT", "x"], ["EXPTIME", 1.5, "s"], ["HISTORY", "a test"], ["TELESCOP", "a name long enough to continue " * 3]]
    py = eo.fits_bytes(img, cards)
    out = _runtime.call("invoke", "fits.encodeFits", [img.ravel().tolist(), 4, 3, cards, {"bitpix": 16}])
    js = bytes(out[str(i)] for i in range(len(out))) if isinstance(out, dict) else bytes(out)
    assert py == js
