"""Cameras for the local helper (``python -m esl.bridge``) and for observing from Python (``esl.observe``).

Every backend has the same small interface, close to ASCOM's ICamera so the helper can serve it as an Alpaca
camera:

* :class:`SimCamera` — a simulated sky (numpy): a target star that transits, comparison stars, drift, seeing,
  extinction, sky, bias, dark current, read and shot noise, vignetting for flats. No hardware.
* :class:`ZwoCamera` — a ZWO ASI camera through the ``zwoasi`` package (``pip install "exoplanet-science-lab[camera]"``)
  and ZWO's own ASI SDK library (download it from ZWO; point ``ZWO_ASI_LIB`` at ``libASICamera2.so`` /
  ``.dylib`` / ``ASICamera2.dll``; on Linux install ZWO's udev rules so the camera is readable without root).
* :class:`AlpacaCamera` — any ASCOM Alpaca camera on the network (ASCOM Remote in front of a Windows ASCOM driver,
  N.I.N.A., a native Alpaca device), through its REST API with the standard library.

Images are numpy arrays of shape (rows, columns) = (numy, numx), row 0 at the top, uint16 (int32 for Alpaca).
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

import numpy as np

# ASCOM CameraStates
IDLE, WAITING, EXPOSING, READING, DOWNLOAD, ERROR = range(6)
# ASCOM SensorType
MONOCHROME, COLOR, RGGB = 0, 1, 2


class CameraError(RuntimeError):
    """A camera refused or failed; ``code`` is the ASCOM error number."""

    def __init__(self, message: str, code: int = 0x500):
        super().__init__(message)
        self.code = code


class Camera:
    """The interface. Subclasses fill in the properties and the four exposure methods."""
    name = "camera"
    description = ""
    driver_version = "1.0"
    width = 0
    height = 0
    pixel_size = 0.0              # um, unbinned
    max_bin = 1
    sensor_type = MONOCHROME
    bayer_offset = (0, 0)
    bayer_pattern: Optional[str] = None
    max_adu = 65535
    electrons_per_adu = 1.0
    gain_min, gain_max = 0, 0
    offset_min, offset_max = 0, 0
    readout_modes: List[str] = ["Normal"]
    can_cool = False
    exposure_min, exposure_max = 1e-6, 3600.0

    def __init__(self) -> None:
        self.connected = False
        self.binx = self.biny = 1
        self.startx = self.starty = 0
        self.numx, self.numy = self.width, self.height
        self.gain = self.gain_min
        self.offset = self.offset_min
        self.readout_mode = 0
        self.set_temperature = 0.0
        self.cooler_on = False
        self.state = IDLE
        self._t0: Optional[float] = None
        self._duration = 0.0
        self._image: Optional[np.ndarray] = None
        self._lock = threading.RLock()

    # ---- life
    def connect(self) -> None:
        self.connected = True

    def disconnect(self) -> None:
        self.connected = False

    def require(self) -> None:
        if not self.connected:
            raise CameraError("the camera is not connected", 0x407)

    # ---- temperature
    @property
    def ccd_temperature(self) -> float:
        return float("nan")

    @property
    def cooler_power(self) -> float:
        return 0.0

    # ---- binning and the region of interest
    def set_bin(self, bx: int, by: Optional[int] = None) -> None:
        by = bx if by is None else by
        if not (1 <= bx <= self.max_bin and 1 <= by <= self.max_bin):
            raise CameraError(f"binning {bx}x{by} is not supported (1 to {self.max_bin})", 0x401)
        self.binx, self.biny = bx, by
        self.numx, self.numy = self.width // bx, self.height // by
        self.startx = self.starty = 0

    def check_roi(self) -> None:
        if self.startx < 0 or self.starty < 0 or self.startx + self.numx > self.width // self.binx or self.starty + self.numy > self.height // self.biny or self.numx < 1 or self.numy < 1:
            raise CameraError("the region of interest is outside the binned sensor", 0x401)

    # ---- exposures
    def start_exposure(self, duration: float, light: bool = True, kind: Optional[str] = None) -> None:
        raise NotImplementedError

    def abort_exposure(self) -> None:
        with self._lock:
            self.state = IDLE
            self._t0 = None

    @property
    def image_ready(self) -> bool:
        raise NotImplementedError

    def image(self) -> np.ndarray:
        raise NotImplementedError

    @property
    def percent_completed(self) -> int:
        if self.state != EXPOSING or self._t0 is None or self._duration <= 0:
            return 100 if self._image is not None else 0
        return int(min(100, 100 * (time.time() - self._t0) / self._duration))

    def properties(self) -> Dict[str, Any]:
        return {"name": self.name, "width": self.width, "height": self.height, "pixel_size": self.pixel_size, "max_bin": self.max_bin,
                "sensor_type": self.sensor_type, "bayer_pattern": self.bayer_pattern, "max_adu": self.max_adu, "electrons_per_adu": self.electrons_per_adu,
                "gain_range": [self.gain_min, self.gain_max], "offset_range": [self.offset_min, self.offset_max], "can_cool": self.can_cool}


# ---- the simulator --------------------------------------------------------------------------------------------

def _erf(x: np.ndarray) -> np.ndarray:
    # Abramowitz & Stegun 7.1.26 (1.5e-7): numpy has no erf and scipy is not a dependency
    s = np.sign(x); a = np.abs(x)
    t = 1 / (1 + 0.3275911 * a)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-a * a)
    return s * y


class SimCamera(Camera):
    """A simulated camera looking at a field whose target transits (mid-transit ``tmid``, Unix s)."""
    name = "ESL simulated camera"
    description = "Simulated star field with a transiting target (esl.cameras.SimCamera)"
    pixel_size = 3.76
    max_bin = 4
    gain_min, gain_max = 0, 300
    offset_min, offset_max = 0, 100
    can_cool = True
    electrons_per_adu = 1.0

    def __init__(self, width: int = 320, height: int = 240, *, tmid: Optional[float] = None, depth: float = 0.01, duration_h: float = 2.0,
                 flux: float = 4000.0, sky: float = 8.0, bias: float = 300.0, dark: float = 0.02, read: float = 6.0, seeing: float = 1.8,
                 drift=(1.2, -0.8), seed: int = 7, readout_s: float = 0.2):
        self.width, self.height = width, height
        super().__init__()
        self.tmid = tmid if tmid is not None else time.time() + 3600
        self.depth, self.duration_h, self.flux, self.sky, self.bias, self.dark, self.read = depth, duration_h, flux, sky, bias, dark, read
        self.seeing, self.drift, self.readout_s = seeing, drift, readout_s
        self.t_start = self.tmid - 3 * 3600
        rng = np.random.default_rng(seed)
        self.rng = np.random.default_rng(seed + 1)
        tx, ty = width * 0.52, height * 0.48
        stars = [(tx, ty, flux, 0)]
        while len(stars) < 5:
            x, y = 0.12 * width + rng.random() * 0.76 * width, 0.12 * height + rng.random() * 0.76 * height
            if math.hypot(x - tx, y - ty) > 0.15 * min(width, height):
                stars.append((x, y, flux * (0.6 + 1.2 * rng.random()), len(stars)))
        for _ in range(30):
            stars.append((8 + rng.random() * (width - 16), 8 + rng.random() * (height - 16), flux * 0.02 * math.exp(3 * rng.random()), -1))
        self.stars = stars
        self.truth = {"tmid": self.tmid, "depth": depth, "duration_h": duration_h, "target": (tx, ty), "comps": [(s[0], s[1]) for s in stars[1:5]]}
        self._temp = 20.0
        self._kind = "light"

    @property
    def ccd_temperature(self) -> float:
        # the sensor approaches the set point at about 1 degree per second when the cooler is on
        return self._temp

    def _step_temp(self) -> None:
        target = self.set_temperature if self.cooler_on else 20.0
        self._temp += max(-1.0, min(1.0, target - self._temp))

    @property
    def cooler_power(self) -> float:
        return 0.0 if not self.cooler_on else float(min(100, max(0, 3 * (20 - self.set_temperature))))

    def start_exposure(self, duration: float, light: bool = True, kind: Optional[str] = None) -> None:
        self.require()
        if not (self.exposure_min <= duration <= self.exposure_max) and duration != 0:
            raise CameraError(f"exposure {duration} s outside {self.exposure_min}-{self.exposure_max} s", 0x401)
        self.check_roi()
        with self._lock:
            if self.state == EXPOSING:
                raise CameraError("an exposure is already running", 0x40B)
            self._step_temp()
            self._kind = kind or ("light" if light else ("bias" if duration == 0 else "dark"))
            self._t0, self._duration, self._image, self.state = time.time(), float(duration), None, EXPOSING

    @property
    def image_ready(self) -> bool:
        with self._lock:
            if self._image is not None:
                return True
            if self.state == EXPOSING and self._t0 is not None and time.time() >= self._t0 + self._duration + self.readout_s:
                self._image = self._render(self._kind, self._t0, self._duration)
                self.state = IDLE
                return True
            return False

    def image(self) -> np.ndarray:
        if not self.image_ready:
            raise CameraError("no image is ready", 0x40B)
        return self._image

    def _render(self, kind: str, t0: float, exptime: float) -> np.ndarray:
        W, H, b = self.width, self.height, self.binx
        y, x = np.mgrid[0:H, 0:W].astype(float)
        vig = 1 - 0.12 * (((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2)
        if kind == "bias":
            img = self.bias + self.read * self.rng.standard_normal((H, W))
        elif kind == "dark":
            sig = self.dark * exptime
            img = self.bias + sig + np.sqrt(self.read ** 2 + sig) * self.rng.standard_normal((H, W))
        elif kind == "flat":
            sig = 25000 * vig
            img = self.bias + sig + np.sqrt(self.read ** 2 + sig) * self.rng.standard_normal((H, W))
        else:
            mid = t0 + exptime / 2
            hrs = (mid - self.t_start) / 3600
            am = 1.2
            ext = math.exp(-0.25 * (am - 1)) * (1 + 0.01 * math.sin(hrs * 7.3) + 0.004 * self.rng.standard_normal())
            sg = self.seeing * (1 + 0.15 * math.sin(hrs * 2.1)) * am ** 0.6
            dx, dy = self.drift[0] * hrs + 0.2 * math.sin(hrs * 40), self.drift[1] * hrs + 0.2 * math.cos(hrs * 37)
            u = abs(mid - self.tmid) / (self.duration_h * 3600)
            depth = 0.0 if u >= 0.5 else (self.depth if u <= 0.35 else self.depth * (0.5 - u) / 0.15)
            sig = np.full((H, W), self.sky * am * exptime)
            k = 1 / (math.sqrt(2) * sg)
            xe, ye = np.arange(W + 1) - 0.5, np.arange(H + 1) - 0.5
            for sx, sy, f, idx in self.stars:
                fx = 0.5 * np.diff(_erf((xe - sx - dx) * k)); fy = 0.5 * np.diff(_erf((ye - sy - dy) * k))
                sig += f * exptime * ext * (1 - depth if idx == 0 else 1) * np.outer(fy, fx)
            sig *= vig
            sig += self.dark * exptime
            img = self.bias + sig + np.sqrt(self.read ** 2 + sig) * self.rng.standard_normal((H, W))
        img = np.clip(np.rint(img), 0, self.max_adu)
        if b > 1:
            img = img[: H // b * b, : W // b * b].reshape(H // b, b, W // b, b).sum(axis=(1, 3)).clip(0, self.max_adu)
        img = img[self.starty: self.starty + self.numy, self.startx: self.startx + self.numx]
        return img.astype(np.uint16)


# ---- ZWO ------------------------------------------------------------------------------------------------------

class ZwoCamera(Camera):
    """A ZWO ASI camera (``zwoasi`` + ZWO's ASI SDK). ``index`` picks the camera when several are connected."""

    def __init__(self, index: int = 0, *, library: Optional[str] = None, asi: Any = None):
        if asi is None:
            try:
                import zwoasi as asi  # type: ignore
            except ImportError as e:
                raise CameraError('ZWO cameras need the zwoasi package: pip install "exoplanet-science-lab[camera]"') from e
            lib = library or os.environ.get("ZWO_ASI_LIB")
            if not lib:
                raise CameraError("set ZWO_ASI_LIB to ZWO's ASI SDK library (libASICamera2.so / .dylib / ASICamera2.dll), downloaded from ZWO")
            try:
                asi.init(lib)
            except Exception as e:  # noqa: BLE001 - zwoasi raises its own types; already initialised is fine
                if "already" not in str(e).lower():
                    raise CameraError(f"the ASI SDK library could not be loaded from {lib}: {e}") from e
        self.asi = asi
        n = asi.get_num_cameras()
        if n <= index:
            raise CameraError(f"no ZWO camera number {index} ({n} found)")
        self.index = index
        self.cam = asi.Camera(index)
        p = self.cam.get_camera_property()
        self.name = p.get("Name", f"ZWO camera {index}")
        self.description = f"{self.name} (ZWO ASI SDK through zwoasi)"
        self.width, self.height = int(p["MaxWidth"]), int(p["MaxHeight"])
        self.pixel_size = float(p.get("PixelSize", 0))
        self.max_bin = max(p.get("SupportedBins", [1]) or [1])
        self.electrons_per_adu = float(p.get("ElecPerADU", 1.0))
        bits = int(p.get("BitDepth", 16))
        self.max_adu = 65535                                    # RAW16 is scaled to 16 bits by the SDK whatever the ADC depth
        self.adc_bits = bits
        self.can_cool = bool(p.get("IsCoolerCam", False))
        if p.get("IsColorCam"):
            self.sensor_type = RGGB
            self.bayer_pattern = {0: "RGGB", 1: "BGGR", 2: "GRBG", 3: "GBRG"}.get(p.get("BayerPattern", 0), "RGGB")
        ctl = self.cam.get_controls()
        g = ctl.get("Gain", {}); o = ctl.get("Offset", ctl.get("Brightness", {}))
        self.gain_min, self.gain_max = int(g.get("MinValue", 0)), int(g.get("MaxValue", 0))
        self.offset_min, self.offset_max = int(o.get("MinValue", 0)), int(o.get("MaxValue", 0))
        e = ctl.get("Exposure", {})
        if e:
            self.exposure_min, self.exposure_max = e.get("MinValue", 32) / 1e6, e.get("MaxValue", 2e9) / 1e6
        super().__init__()
        self.gain = int(g.get("DefaultValue", self.gain_min))
        self.offset = int(o.get("DefaultValue", self.offset_min))
        self._offset_ctl = getattr(asi, "ASI_OFFSET", getattr(asi, "ASI_BRIGHTNESS", 5))

    def connect(self) -> None:
        self.cam.set_image_type(self.asi.ASI_IMG_RAW16)
        self.cam.set_control_value(self.asi.ASI_BANDWIDTHOVERLOAD, self.cam.get_controls().get("BandWidth", {}).get("MinValue", 40))
        super().connect()

    def disconnect(self) -> None:
        try:
            self.cam.stop_exposure()
        except Exception:  # noqa: BLE001
            pass
        super().disconnect()

    @property
    def ccd_temperature(self) -> float:
        return self.cam.get_control_value(self.asi.ASI_TEMPERATURE)[0] / 10.0

    @property
    def cooler_power(self) -> float:
        if not self.can_cool:
            return 0.0
        return float(self.cam.get_control_value(getattr(self.asi, "ASI_COOLER_POWER_PERC", 15))[0])

    def apply_cooler(self) -> None:
        if self.can_cool:
            self.cam.set_control_value(self.asi.ASI_TARGET_TEMP, int(round(self.set_temperature)))
            self.cam.set_control_value(self.asi.ASI_COOLER_ON, 1 if self.cooler_on else 0)

    def start_exposure(self, duration: float, light: bool = True, kind: Optional[str] = None) -> None:
        self.require(); self.check_roi()
        with self._lock:
            # the SDK's region of interest: start in binned pixels, width a multiple of 8 and height of 2
            w, h = self.numx - self.numx % 8, self.numy - self.numy % 2
            self.cam.set_roi(start_x=self.startx, start_y=self.starty, width=w, height=h, bins=self.binx, image_type=self.asi.ASI_IMG_RAW16)
            self.cam.set_control_value(self.asi.ASI_GAIN, int(self.gain))
            self.cam.set_control_value(self._offset_ctl, int(self.offset))
            self.cam.set_control_value(self.asi.ASI_EXPOSURE, int(round(max(duration, self.exposure_min) * 1e6)))
            self.cam.start_exposure(is_dark=not light)
            self._t0, self._duration, self._image, self.state = time.time(), float(duration), None, EXPOSING

    def abort_exposure(self) -> None:
        self.cam.stop_exposure()
        super().abort_exposure()

    @property
    def image_ready(self) -> bool:
        with self._lock:
            if self._image is not None:
                return True
            if self.state != EXPOSING:
                return False
            st = self.cam.get_exposure_status()
            if st == self.asi.ASI_EXP_SUCCESS:
                self.state = DOWNLOAD
                buf = self.cam.get_data_after_exposure()
                w, h = self.cam.get_roi()[2:4]
                self._image = np.frombuffer(buf, dtype="<u2").reshape(h, w).copy()
                self.state = IDLE
                return True
            if st == self.asi.ASI_EXP_FAILED:
                self.state = ERROR
                raise CameraError("the exposure failed (ASI_EXP_FAILED)")
            return False

    def image(self) -> np.ndarray:
        if not self.image_ready:
            raise CameraError("no image is ready", 0x40B)
        return self._image


# ---- any Alpaca camera ----------------------------------------------------------------------------------------

class AlpacaCamera(Camera):
    """An Alpaca camera at ``url`` (e.g. http://192.168.1.20:11111), device number ``device``."""

    def __init__(self, url: str, device: int = 0, *, timeout: float = 30.0, client_id: int = 4207):
        self.base = url.rstrip("/") + f"/api/v1/camera/{device}/"
        self.timeout, self.client_id, self._tx = timeout, client_id, 0
        super().__init__()
        self._remote_t0: Optional[float] = None

    def _req(self, method: str, name: str, params: Optional[Dict[str, Any]] = None, *, raw: bool = False) -> Any:
        self._tx += 1
        q = {"ClientID": self.client_id, "ClientTransactionID": self._tx}
        if method == "GET":
            url = self.base + name + "?" + urllib.parse.urlencode({**q, **(params or {})})
            req = urllib.request.Request(url, headers={"Accept": "application/imagebytes" if raw else "application/json"})
        else:
            body = urllib.parse.urlencode({**q, **{k: (str(v).lower() if isinstance(v, bool) else v) for k, v in (params or {}).items()}}).encode()
            req = urllib.request.Request(self.base + name, data=body, method="PUT", headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data, ctype = r.read(), r.headers.get("Content-Type", "")
        if raw and "imagebytes" in ctype:
            return data
        j = json.loads(data)
        if j.get("ErrorNumber"):
            raise CameraError(f"{name}: {j.get('ErrorMessage')}", j["ErrorNumber"])
        return j.get("Value")

    def connect(self) -> None:
        self._req("PUT", "connected", {"Connected": True})
        g = lambda n, d=None: self._try(n, d)  # noqa: E731
        self.name = g("name", "Alpaca camera"); self.description = g("description", "")
        self.width, self.height = int(g("cameraxsize", 0)), int(g("cameraysize", 0))
        self.pixel_size = float(g("pixelsizex", 0)); self.max_bin = int(g("maxbinx", 1))
        self.sensor_type = int(g("sensortype", 0)); self.max_adu = int(g("maxadu", 65535)); self.electrons_per_adu = float(g("electronsperadu", 1))
        self.gain_min, self.gain_max = g("gainmin", 0), g("gainmax", 0); self.offset_min, self.offset_max = g("offsetmin", 0), g("offsetmax", 0)
        self.can_cool = bool(g("cansetccdtemperature", False))
        if self.sensor_type == RGGB:
            self.bayer_pattern = "RGGB"; self.bayer_offset = (int(g("bayeroffsetx", 0)), int(g("bayeroffsety", 0)))
        self.numx, self.numy = self.width, self.height
        self.connected = True

    def _try(self, name: str, default: Any = None) -> Any:
        try:
            v = self._req("GET", name)
            return default if v is None else v
        except Exception:  # noqa: BLE001 - optional properties
            return default

    def disconnect(self) -> None:
        self._try_put("connected", {"Connected": False}); self.connected = False

    def _try_put(self, name: str, p: Dict[str, Any]) -> None:
        try:
            self._req("PUT", name, p)
        except Exception:  # noqa: BLE001
            pass

    @property
    def ccd_temperature(self) -> float:
        return float(self._try("ccdtemperature", float("nan")))

    @property
    def cooler_power(self) -> float:
        return float(self._try("coolerpower", 0.0))

    def apply_cooler(self) -> None:
        self._try_put("setccdtemperature", {"SetCCDTemperature": self.set_temperature})
        self._try_put("cooleron", {"CoolerOn": self.cooler_on})

    def start_exposure(self, duration: float, light: bool = True, kind: Optional[str] = None) -> None:
        self.require()
        for k, v in (("binx", {"BinX": self.binx}), ("biny", {"BinY": self.biny}), ("startx", {"StartX": self.startx}), ("starty", {"StartY": self.starty}),
                     ("numx", {"NumX": self.numx}), ("numy", {"NumY": self.numy})):
            self._req("PUT", k, v)
        if self.gain_max:
            self._try_put("gain", {"Gain": int(self.gain)})
        if self.offset_max:
            self._try_put("offset", {"Offset": int(self.offset)})
        self._req("PUT", "startexposure", {"Duration": duration, "Light": light})
        self._t0, self._duration, self._image, self.state = time.time(), float(duration), None, EXPOSING

    def abort_exposure(self) -> None:
        self._try_put("abortexposure", {}); super().abort_exposure()

    @property
    def image_ready(self) -> bool:
        if self._image is not None:
            return True
        return bool(self._req("GET", "imageready"))

    def image(self) -> np.ndarray:
        if self._image is not None:
            return self._image
        raw = self._req("GET", "imagearray", raw=True)
        img = decode_imagebytes(raw) if isinstance(raw, (bytes, bytearray)) else np.asarray(raw["Value"] if isinstance(raw, dict) else raw).T
        self._image = img; self.state = IDLE
        return img


# ---- Alpaca ImageBytes ----------------------------------------------------------------------------------------

# ImageArrayElementTypes of the Alpaca API
_ELEM = {1: "<i2", 2: "<i4", 3: "<f8", 4: "<f4", 6: "u1", 7: "<i8", 8: "<u2", 9: "<u4"}
_CODE = {np.dtype("int16"): 1, np.dtype("int32"): 2, np.dtype("float64"): 3, np.dtype("float32"): 4, np.dtype("uint8"): 6, np.dtype("int64"): 7, np.dtype("uint16"): 8, np.dtype("uint32"): 9}


def encode_imagebytes(img: np.ndarray, client_tx: int = 0, server_tx: int = 0, *, error: int = 0) -> bytes:
    """An image (rows, columns) as Alpaca ImageBytes: a 44-byte header of little-endian int32, then the pixels in
    the order of ImageArray[x][y] (x = column first, y fastest), sent as the image's own type (uint16 for cameras)
    while ImageElementType says Int32 as ICamera.ImageArray is defined."""
    a = np.ascontiguousarray(np.asarray(img).T)                  # (x, y): y fastest
    t = _CODE[a.dtype] if a.dtype in _CODE else 2
    if a.dtype not in _CODE:
        a = a.astype("<i4")
    head = np.array([1, error, client_tx, server_tx, 44, 2, t, 2, a.shape[0], a.shape[1], 0], dtype="<i4").tobytes()
    return head + a.astype(_ELEM[t], copy=False).tobytes()


def decode_imagebytes(b: bytes) -> np.ndarray:
    """Alpaca ImageBytes -> an image (rows, columns)."""
    h = np.frombuffer(b[:44], dtype="<i4")
    if h[0] != 1:
        raise CameraError(f"ImageBytes metadata version {h[0]} is not 1")
    if h[1]:
        raise CameraError(b[h[4]:].decode("utf-8", "replace") or f"error {h[1]}", int(h[1]))
    rank, d1, d2 = int(h[7]), int(h[8]), int(h[9])
    a = np.frombuffer(b, dtype=_ELEM[int(h[6])], offset=int(h[4]), count=d1 * d2 * (int(h[10]) if rank == 3 else 1))
    return a.reshape(d1, d2).T if rank == 2 else a.reshape(d1, d2, int(h[10])).transpose(1, 0, 2)
