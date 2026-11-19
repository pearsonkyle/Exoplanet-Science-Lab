"""Run an observing sequence from Python: the same sequence file, state machine and FITS headers as the web app's
Run page, with a camera of :mod:`esl.cameras` and the clock of :mod:`esl.time`.

    import esl.observe as eo
    from esl.cameras import ZwoCamera
    from esl.time import Clock
    clock = Clock(); clock.sync()                                   # NTP / gpsd
    seq = eo.load("seq-hatp32.json")                                # an esl-sequence (Plan -> "Observe this event" -> Save)
    log = eo.run(seq, ZwoCamera(0), clock=clock, save_dir="~/ESL/frames")

What is shared with the browser (through the bundled core): ``sequence.nextAction`` / ``advance`` (when to cool,
calibrate, wait, expose, pause and stop), ``fitsheader.frameHeader`` (every card) and ``fits.headerLines`` (how
the cards are written). Only the pixels stay in Python. Not done here (yet): the live photometry of the Run page;
reduce the folder afterwards with the Photometry page, which reads these headers.
"""
from __future__ import annotations

import json
import time as _time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

import numpy as np

from . import _runtime
from ._version import __version__
from .cameras import Camera
from .time import Clock

BLOCK = 2880


def load(path: Union[str, Path]) -> Dict[str, Any]:
    """An esl-sequence from a JSON file, checked."""
    seq = json.loads(Path(path).expanduser().read_text())
    errs = _runtime.call("invoke", "sequence.validateSequence", [seq])
    if errs:
        raise ValueError("not a runnable sequence: " + "; ".join(errs))
    return seq


def make(**kw: Any) -> Dict[str, Any]:
    """A sequence from settings (``target``, ``site``, ``window`` in Unix ms, ``exposure``, ``calibration``, ...),
    with the defaults of the core (``sequence.makeSequence``)."""
    return _runtime.call("invoke", "sequence.makeSequence", [kw])


def fits_bytes(img: np.ndarray, cards: list) -> bytes:
    """A FITS file of an image (rows, columns) with the cards of frameHeader: uint16 as BITPIX 16 + BZERO 32768,
    larger integers as BITPIX 32, floats as -32."""
    a = np.asarray(img)
    if a.dtype.kind == "f":
        bitpix, data = -32, a.astype(">f4")
    elif a.dtype.kind in "ui" and a.max(initial=0) <= 65535 and a.min(initial=0) >= 0:
        bitpix, data = 16, (a.astype(np.int32) - 32768).astype(">i2")
    else:
        bitpix, data = 32, a.astype(">i4")
    head = [["SIMPLE", True, "conforms to FITS standard"], ["BITPIX", bitpix, "IEEE single precision" if bitpix == -32 else f"{bitpix}-bit integers"], ["NAXIS", 2], ["NAXIS1", int(a.shape[1]), "columns"], ["NAXIS2", int(a.shape[0]), "rows"]]
    if bitpix == 16:
        head += [["BZERO", 32768, "unsigned 16-bit: physical = stored + 32768"], ["BSCALE", 1]]
    skip = {"SIMPLE", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "BZERO", "BSCALE", "END"}
    lines = _runtime.call("invoke", "fits.headerLines", [head + [c for c in cards if c[0] not in skip]])
    text = "".join(lines) + "END".ljust(80)
    text += " " * (-len(text) % BLOCK)
    raw = data.tobytes()
    return text.encode("ascii") + raw + b"\0" * (-len(raw) % BLOCK)


def run(seq: Dict[str, Any], camera: Camera, *, clock: Optional[Clock] = None, save_dir: Union[str, Path, None] = None,
        telescope: Optional[Dict[str, Any]] = None, on_frame: Optional[Callable[[Dict[str, Any]], None]] = None,
        sleep: Callable[[float], None] = _time.sleep, max_wait: float = 30.0, resume_after_pause: Optional[float] = None) -> Dict[str, Any]:
    """Run a sequence to its end. Returns the final state (counts, log) and the files written.

    ``resume_after_pause``: seconds after which a pause (the meridian) is resumed by itself; None waits for the
    observer to answer at the terminal."""
    clock = clock or Clock()
    out = Path(save_dir).expanduser() / seq["id"] if save_dir else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{seq['id']}.sequence.json").write_text(json.dumps(seq, indent=1))
    if not camera.connected:
        camera.connect()
    X = seq["exposure"]
    if X.get("gain") is not None:
        camera.gain = X["gain"]
    if X.get("offset") is not None:
        camera.offset = X["offset"]
    if X.get("bin", 1) != camera.binx:
        camera.set_bin(int(X.get("bin", 1)))
    camera.cooler_on, camera.set_temperature = bool(seq["cooler"]["on"]), float(seq["cooler"]["setTemp"])
    getattr(camera, "apply_cooler", lambda: None)()
    st = _runtime.call("invoke", "sequence.startState", [])
    files, n = [], 0
    tel = telescope or seq.get("telescope") or {}
    while True:
        now = clock.now() * 1000
        if hasattr(camera, "_step_temp"):
            camera._step_temp()
        a = _runtime.call("invoke", "sequence.nextAction", [seq, st, now, {"ccdTemp": camera.ccd_temperature}])
        if a["type"] == "done":
            st = _runtime.call("invoke", "sequence.advance", [st, a, now])
            break
        if a["type"] == "pause":
            st = _runtime.call("invoke", "sequence.advance", [st, a, now])
            if resume_after_pause is None:
                input(f"{a['reason']}\nPress Enter to resume. ")
            else:
                sleep(resume_after_pause)
            st = _runtime.call("invoke", "sequence.resume", [st])
            continue
        if a["type"] in ("advance",):
            st = _runtime.call("invoke", "sequence.advance", [st, a, now])
            continue
        if a["type"] in ("cool", "wait"):
            st = _runtime.call("invoke", "sequence.advance", [st, a, now])
            sleep(min(max_wait, max(0.2, (a.get("until", now) - now) / 1000)))
            continue
        # an exposure: the start by the corrected clock, just before the camera is told
        t0 = clock.now()
        camera.start_exposure(a["duration"], light=a["kind"] in ("light", "flat"), kind=a["kind"])
        while not camera.image_ready:
            sleep(0.05)
        img = camera.image()
        st = _runtime.call("invoke", "sequence.advance", [st, a, clock.now() * 1000, {}])
        n += 1
        b = clock.best()
        cards = _runtime.call("invoke", "fitsheader.frameHeader", [{
            "exposure": {"start": t0 * 1000, "duration": a["duration"], "kind": a["kind"], "filter": X.get("filter")},
            "clock": {"source": b.source, "label": "esl.time - " + b.label, "offset": b.offset * 1000, "unc": None if b.unc is None else b.aged_unc(clock.system()) * 1000},
            "site": seq["site"], "target": seq["target"],
            "camera": {"name": camera.name, "width": int(img.shape[1]), "height": int(img.shape[0]), "gain": camera.gain, "offset": camera.offset, "egain": camera.electrons_per_adu,
                       "binx": camera.binx, "pixelSize": camera.pixel_size, "ccdTemp": camera.ccd_temperature, "setTemp": camera.set_temperature if camera.cooler_on else None,
                       "bayer": {"pattern": camera.bayer_pattern, "xoff": camera.bayer_offset[0], "yoff": camera.bayer_offset[1]} if camera.bayer_pattern else None},
            "telescope": tel, "sequence": {"id": seq["id"], "name": seq["name"], "frame": n}, "observer": seq.get("observer"),
            "software": f"Exoplanet Science Lab {__version__} (esl.observe)", "written": clock.now() * 1000}])
        name = f"{seq['id']}_{n:04d}_{a['kind']}.fits"
        if out:
            (out / name).write_bytes(fits_bytes(img, cards))
            files.append(str(out / name))
        if on_frame:
            on_frame({"n": n, "kind": a["kind"], "start": t0, "image": img, "cards": cards, "name": name})
    return {"state": st, "files": files, "frames": n}
