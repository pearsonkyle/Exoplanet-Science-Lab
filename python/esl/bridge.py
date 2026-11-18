"""The local helper: ``python -m esl.bridge``. It runs on the observing computer and lets the web app (the
deployed site or a local copy) use what a browser cannot reach by itself:

* **time** — ``GET /esl/time``: this computer's clock corrected by NTP (the NTP Pool, or servers you name), gpsd
  (PPS when available) or, if you ask for it, ntp-01.jeffgeerling.com; with the uncertainty and the leap seconds
  (``esl.time``).
* **a camera** — served as an **ASCOM Alpaca** camera (``/api/v1/camera/0/...``, ``/management/...``, UDP discovery
  on 32227): a ZWO ASI camera (``--zwo``), any other Alpaca camera passed through (``--alpaca URL``), or a simulated
  sky (``--simulate``). Images go out as Alpaca ImageBytes (binary). Other Alpaca clients (N.I.N.A., alpyca) can
  use it too.
* **exposure times** — ``GET /esl/exposure``: when the last exposure started, by the corrected clock of this
  computer (the one that talks to the camera), and how good that clock was.
* **saving** — ``PUT /esl/save?name=frame.fits``: writes a FITS file the page made into ``--save-dir``, for
  browsers that cannot write to a folder themselves.

Security: it listens on 127.0.0.1 only unless ``--host`` says otherwise, and it answers web pages only from the
origins in ``--allow-origin`` (by default the published site and pages served from localhost), so another web
site cannot drive your camera. Requests without an Origin header (N.I.N.A., scripts) are always answered.
Chrome asks once whether the site may reach this computer's local network; allow it.

    python -m esl.bridge --simulate
    ZWO_ASI_LIB=/path/libASICamera2.dylib python -m esl.bridge --zwo --save-dir ~/ESL/frames
    python -m esl.bridge --alpaca http://192.168.1.20:11111 --time ntp,gpsd
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

import numpy as np

from . import time as etime
from ._version import __version__
from .cameras import EXPOSING, AlpacaCamera, Camera, CameraError, SimCamera, ZwoCamera, encode_imagebytes

ALPACA_PORT = 11111
DISCOVERY_PORT = 32227
DEFAULT_ORIGINS = ("https://pearsonkyle.github.io", "https://exoplanet.science", "http://localhost", "http://127.0.0.1", "http://[::1]")
MAX_SAVE = 512 * 1024 * 1024
UNIQUE_ID = "esl-bridge-camera-0"

# ASCOM error numbers
NOT_IMPLEMENTED, INVALID_VALUE, VALUE_NOT_SET, NOT_CONNECTED, INVALID_OPERATION, UNSPECIFIED = 0x400, 0x401, 0x402, 0x407, 0x40B, 0x500


class Bridge:
    """The state behind the HTTP server: the camera, the clock, the last exposure."""

    def __init__(self, camera: Optional[Camera], *, clock: Optional[etime.Clock] = None, time_sources=("ntp",), save_dir: Optional[Path] = None,
                 origins=DEFAULT_ORIGINS, resync_s: float = 900.0):
        self.camera = camera
        self.clock = clock or etime.Clock()
        self.time_sources = tuple(time_sources)
        self.save_dir = Path(save_dir).expanduser() if save_dir else None
        self.origins = tuple(origins)
        self.resync_s = resync_s
        self.server_tx = 0
        self.last_exposure: Optional[Dict[str, Any]] = None
        self.lock = threading.Lock()

    # ---- time
    def sync_clock(self) -> None:
        if self.time_sources:
            self.clock.sync(self.time_sources)

    def start_clock_thread(self) -> None:
        def run():
            while True:
                try:
                    self.sync_clock()
                except Exception:  # noqa: BLE001 - keep serving the system clock
                    pass
                time.sleep(self.resync_s)
        threading.Thread(target=run, daemon=True, name="esl-clock").start()

    def time_info(self) -> Dict[str, Any]:
        b = self.clock.best()
        now = self.clock.now()
        unc = b.aged_unc(self.clock.system())
        leap = (b.detail or {}).get("leap")
        return {"now": now, "unc": unc, "source": b.source, "label": b.label, "offset": b.offset, "leap": leap,
                "errors": getattr(self.clock, "errors", {}), "server": "esl.bridge " + __version__}

    def clock_cards(self) -> Dict[str, Any]:
        """The clock as fitsheader.frameHeader takes it (milliseconds)."""
        b = self.clock.best(); u = b.aged_unc(self.clock.system())
        return {"source": b.source, "label": "helper - " + b.label, "offset": b.offset * 1000, "unc": None if u is None else u * 1000}

    def origin_allowed(self, origin: Optional[str]) -> bool:
        if not origin:
            return True
        if "*" in self.origins:
            return True
        o = origin.rstrip("/")
        return any(o == a or (a.startswith("http://") and re.fullmatch(re.escape(a) + r"(:\d+)?", o)) for a in self.origins)


def _params(handler: BaseHTTPRequestHandler) -> Dict[str, str]:
    """Query and form parameters, names lower-cased (Alpaca names are case-insensitive)."""
    q = urllib.parse.urlsplit(handler.path).query
    p = {k.lower(): v[-1] for k, v in urllib.parse.parse_qs(q, keep_blank_values=True).items()}
    if handler.command == "PUT":
        n = int(handler.headers.get("Content-Length") or 0)
        ctype = handler.headers.get("Content-Type", "")
        if n and "form" in ctype:
            body = handler.rfile.read(n).decode("utf-8", "replace")
            p.update({k.lower(): v[-1] for k, v in urllib.parse.parse_qs(body, keep_blank_values=True).items()})
    return p


def _bool(v: str) -> bool:
    if str(v).lower() in ("true", "1"):
        return True
    if str(v).lower() in ("false", "0"):
        return False
    raise CameraError(f"{v!r} is not true or false", INVALID_VALUE)


def _num(v: Optional[str], kind=float):
    if v is None:
        raise CameraError("a parameter is missing", INVALID_VALUE)
    try:
        return kind(v)
    except ValueError as e:
        raise CameraError(f"{v!r} is not a number", INVALID_VALUE) from e


def camera_routes(br: Bridge) -> Dict[str, Tuple[Optional[Callable[[], Any]], Optional[Callable[[Dict[str, str]], Any]]]]:
    """Alpaca camera methods: name -> (GET, PUT)."""
    c = lambda: br.camera  # noqa: E731

    def need():
        cam = c()
        if cam is None:
            raise CameraError("no camera", NOT_CONNECTED)
        cam.require()
        return cam

    def put_connected(p):
        cam = c(); v = _bool(p.get("connected", ""))
        cam.connect() if v else cam.disconnect()

    def start(p):
        cam = need()
        dur, light = _num(p.get("duration")), _bool(p.get("light", "true"))
        if dur < 0:
            raise CameraError("negative duration", INVALID_VALUE)
        kind = p.get("esl_kind")                      # our own page says which calibration frame it is
        # the corrected clock just before the camera is told to start: the exposure start of the FITS header
        t = br.clock.now()
        cam.start_exposure(dur, light, kind)
        br.last_exposure = {"start": t, "start_after": br.clock.now(), "duration": dur, "light": light, "kind": kind, "clock": br.clock_cards()}

    def roi(name):
        def setter(p):
            cam = need(); v = _num(p.get(name), int)
            if v < 0:
                raise CameraError(f"{name} must be >= 0", INVALID_VALUE)
            setattr(cam, name, v)
        return setter

    def binning(p, axis):
        cam = need(); v = _num(p.get("bin" + axis), int)
        if not 1 <= v <= cam.max_bin:
            raise CameraError(f"binning {v} not supported", INVALID_VALUE)
        cam.set_bin(v, v)                           # symmetric binning only (CanAsymmetricBin = false)

    def gain(p):
        cam = need(); v = _num(p.get("gain"), int)
        if not cam.gain_min <= v <= cam.gain_max:
            raise CameraError(f"gain {v} outside {cam.gain_min}-{cam.gain_max}", INVALID_VALUE)
        cam.gain = v

    def offset(p):
        cam = need(); v = _num(p.get("offset"), int)
        if not cam.offset_min <= v <= cam.offset_max:
            raise CameraError(f"offset {v} outside {cam.offset_min}-{cam.offset_max}", INVALID_VALUE)
        cam.offset = v

    def set_temp(p):
        cam = need(); cam.set_temperature = _num(p.get("setccdtemperature"))
        getattr(cam, "apply_cooler", lambda: None)()

    def cooler(p):
        cam = need(); cam.cooler_on = _bool(p.get("cooleron", ""))
        getattr(cam, "apply_cooler", lambda: None)()

    def last_start():
        e = br.last_exposure
        if not e:
            raise CameraError("no exposure yet", VALUE_NOT_SET)
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(e["start"])) + f".{int(e['start'] % 1 * 1000):03d}"

    def last_dur():
        e = br.last_exposure
        if not e:
            raise CameraError("no exposure yet", VALUE_NOT_SET)
        return e["duration"]

    def readmode(p):
        cam = need(); v = _num(p.get("readoutmode"), int)
        if not 0 <= v < len(cam.readout_modes):
            raise CameraError("no such readout mode", INVALID_VALUE)
        cam.readout_mode = v

    R = {
        # common
        "connected": (lambda: bool(c() and c().connected), put_connected),
        "description": (lambda: c().description, None), "driverinfo": (lambda: f"esl.bridge {__version__}: {c().description}", None),
        "driverversion": (lambda: __version__, None), "interfaceversion": (lambda: 3, None), "name": (lambda: c().name, None),
        "supportedactions": (lambda: [], None),
        # sensor
        "cameraxsize": (lambda: need().width, None), "cameraysize": (lambda: need().height, None),
        "pixelsizex": (lambda: need().pixel_size, None), "pixelsizey": (lambda: need().pixel_size, None),
        "maxbinx": (lambda: need().max_bin, None), "maxbiny": (lambda: need().max_bin, None), "canasymmetricbin": (lambda: False, None),
        "binx": (lambda: need().binx, lambda p: binning(p, "x")), "biny": (lambda: need().biny, lambda p: binning(p, "y")),
        "startx": (lambda: need().startx, roi("startx")), "starty": (lambda: need().starty, roi("starty")),
        "numx": (lambda: need().numx, roi("numx")), "numy": (lambda: need().numy, roi("numy")),
        "maxadu": (lambda: need().max_adu, None), "electronsperadu": (lambda: need().electrons_per_adu, None),
        "fullwellcapacity": (lambda: need().max_adu * need().electrons_per_adu, None),
        "sensortype": (lambda: need().sensor_type, None), "sensorname": (lambda: need().name, None),
        "bayeroffsetx": (lambda: need().bayer_offset[0], None), "bayeroffsety": (lambda: need().bayer_offset[1], None),
        "gain": (lambda: need().gain, gain), "gainmin": (lambda: need().gain_min, None), "gainmax": (lambda: need().gain_max, None),
        "offset": (lambda: need().offset, offset), "offsetmin": (lambda: need().offset_min, None), "offsetmax": (lambda: need().offset_max, None),
        "readoutmodes": (lambda: need().readout_modes, None), "readoutmode": (lambda: need().readout_mode, readmode),
        "canfastreadout": (lambda: False, None), "hasshutter": (lambda: False, None),
        "exposuremin": (lambda: need().exposure_min, None), "exposuremax": (lambda: need().exposure_max, None), "exposureresolution": (lambda: 1e-6, None),
        # cooling
        "cansetccdtemperature": (lambda: need().can_cool, None), "cangetcoolerpower": (lambda: need().can_cool, None),
        "ccdtemperature": (lambda: need().ccd_temperature, None), "setccdtemperature": (lambda: need().set_temperature, set_temp),
        "cooleron": (lambda: need().cooler_on, cooler), "coolerpower": (lambda: need().cooler_power, None),
        "heatsinktemperature": (lambda: float("nan"), None),
        # exposures
        "canabortexposure": (lambda: True, None), "canstopexposure": (lambda: False, None), "canpulseguide": (lambda: False, None),
        "camerastate": (lambda: (lambda cam: cam.state if not (cam.state == EXPOSING and cam.image_ready) else 0)(need()), None),
        "imageready": (lambda: need().image_ready, None), "percentcompleted": (lambda: need().percent_completed, None),
        "startexposure": (None, start), "abortexposure": (None, lambda p: need().abort_exposure()),
        "lastexposurestarttime": (last_start, None), "lastexposureduration": (last_dur, None),
    }
    return R


class Handler(BaseHTTPRequestHandler):
    bridge: Bridge = None  # type: ignore[assignment]
    routes: Dict[str, Any] = {}
    server_version = "esl.bridge/" + __version__

    def log_message(self, fmt, *args):  # quieter: one line per exposure and error only
        if os.environ.get("ESL_BRIDGE_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- CORS
    def _cors(self) -> bool:
        origin = self.headers.get("Origin")
        if not self.bridge.origin_allowed(origin):
            return False
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Expose-Headers", "Content-Type")
        return True

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        if not self._cors() and self.headers.get("Origin"):
            pass
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj: Any, code: int = 200) -> None:
        self._send(code, json.dumps(obj, default=lambda x: None if isinstance(x, float) and x != x else str(x)).encode(), "application/json")

    def _alpaca(self, value: Any = None, err: int = 0, msg: str = "", p: Optional[Dict[str, str]] = None) -> None:
        br = self.bridge
        with br.lock:
            br.server_tx += 1; stx = br.server_tx
        ctx = int((p or {}).get("clienttransactionid", "0") or 0) if str((p or {}).get("clienttransactionid", "0")).isdigit() else 0
        out = {"ClientTransactionID": ctx, "ServerTransactionID": stx, "ErrorNumber": err, "ErrorMessage": msg}
        if value is not None or err == 0:
            out["Value"] = value
        if isinstance(value, float) and value != value:
            out["Value"] = None
        self._json(out)

    def do_OPTIONS(self):  # noqa: N802 - CORS preflight
        if not self.bridge.origin_allowed(self.headers.get("Origin")):
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_PUT(self):  # noqa: N802
        self._handle("PUT")

    def _handle(self, method: str) -> None:
        if not self.bridge.origin_allowed(self.headers.get("Origin")):
            self._send(403, b'{"error": "this origin may not use the helper (see --allow-origin)"}', "application/json"); return
        path = urllib.parse.urlsplit(self.path).path.rstrip("/").lower()
        try:
            if path.startswith("/esl/"):
                return self._esl(method, path)
            if path.startswith("/management/"):
                return self._management(path)
            m = re.fullmatch(r"/api/v1/camera/(\d+)/([a-z]+)", path)
            if not m:
                self._send(400, f"unknown path {path}".encode(), "text/plain"); return
            if int(m.group(1)) != 0 or self.bridge.camera is None:
                self._send(400, f"no camera number {m.group(1)}".encode(), "text/plain"); return
            name = m.group(2)
            p = _params(self)
            if name == "imagearray" and method == "GET":
                return self._image(p)
            if name not in self.routes:
                return self._alpaca(None, NOT_IMPLEMENTED, f"{name} is not implemented", p)
            get, put = self.routes[name]
            fn = get if method == "GET" else put
            if fn is None:
                return self._alpaca(None, NOT_IMPLEMENTED, f"{method} {name} is not implemented", p)
            v = fn() if method == "GET" else fn(p)
            if isinstance(v, np.generic):
                v = v.item()
            self._alpaca(v if method == "GET" else None, 0, "", p)
        except CameraError as e:
            self._alpaca(None, e.code, str(e), locals().get("p"))
        except Exception as e:  # noqa: BLE001
            self._alpaca(None, UNSPECIFIED, f"{type(e).__name__}: {e}", locals().get("p"))

    def _image(self, p: Dict[str, str]) -> None:
        cam = self.bridge.camera
        img = cam.image()
        ctx = int(p.get("clienttransactionid", "0") or 0)
        if "application/imagebytes" in (self.headers.get("Accept") or ""):
            self._send(200, encode_imagebytes(img, ctx, self.bridge.server_tx), "application/imagebytes")
        else:
            self._json({"Type": 2, "Rank": 2, "Value": np.asarray(img).T.astype(int).tolist(), "ClientTransactionID": ctx, "ServerTransactionID": self.bridge.server_tx, "ErrorNumber": 0, "ErrorMessage": ""})

    def _management(self, path: str) -> None:
        cam = self.bridge.camera
        if path == "/management/apiversions":
            return self._alpaca([1])
        if path == "/management/v1/description":
            return self._alpaca({"ServerName": "esl.bridge", "Manufacturer": "Exoplanet Science Lab", "ManufacturerVersion": __version__, "Location": socket.gethostname()})
        if path == "/management/v1/configureddevices":
            return self._alpaca([] if cam is None else [{"DeviceName": cam.name, "DeviceType": "Camera", "DeviceNumber": 0, "UniqueID": UNIQUE_ID}])
        self._send(400, b"unknown management path", "text/plain")

    def _esl(self, method: str, path: str) -> None:
        br = self.bridge
        if path == "/esl/time":
            return self._json(br.time_info())
        if path == "/esl/exposure":
            return self._json(br.last_exposure or {})
        if path == "/esl/info":
            cam = br.camera
            return self._json({"server": "esl.bridge", "version": __version__, "camera": cam.properties() if cam is not None else None,
                               "connected": bool(cam and cam.connected), "save_dir": str(br.save_dir) if br.save_dir else None, "time": br.time_info()})
        if path == "/esl/save" and method == "PUT":
            if not br.save_dir:
                return self._json({"error": "saving is off: start the helper with --save-dir"}, 400)
            name = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("name", [""])[-1]
            name = os.path.basename(name)
            if not re.fullmatch(r"[\w.\-+]{1,120}\.(fits|fit|fts|fz|json|csv)", name):
                return self._json({"error": "file names: letters, digits, . _ - +, ending .fits, .fit, .fts, .fz, .json or .csv"}, 400)
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= MAX_SAVE:
                return self._json({"error": f"size {n} outside 1 byte to {MAX_SAVE} bytes"}, 400)
            sub = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("folder", [""])[-1]
            folder = br.save_dir / (re.sub(r"[^\w.\-]", "_", sub)[:80] if sub else "")
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / name
            if dest.exists():
                return self._json({"error": f"{dest} exists"}, 409)
            data = self.rfile.read(n)
            dest.write_bytes(data)
            return self._json({"saved": str(dest), "bytes": n})
        self._json({"error": f"unknown {path}"}, 404)


def discovery_thread(port: int) -> Optional[threading.Thread]:
    """Answer Alpaca discovery broadcasts (UDP 32227, 'alpacadiscovery1') with our port. None when 32227 is taken."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        s.bind(("", DISCOVERY_PORT))
    except OSError:
        return None

    def run():
        while True:
            try:
                data, addr = s.recvfrom(256)
                if data.strip().startswith(b"alpacadiscovery1"):
                    s.sendto(json.dumps({"AlpacaPort": port}).encode(), addr)
            except OSError:
                return
    t = threading.Thread(target=run, daemon=True, name="alpaca-discovery"); t.start()
    return t


def make_server(bridge: Bridge, host: str = "127.0.0.1", port: int = ALPACA_PORT) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"bridge": bridge, "routes": camera_routes(bridge)})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    return srv


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m esl.bridge", description="The local helper of Exoplanet Science Lab: trusted time and an Alpaca camera for the web app.")
    cam = ap.add_mutually_exclusive_group()
    cam.add_argument("--simulate", action="store_true", help="a simulated camera and sky (no hardware)")
    cam.add_argument("--zwo", nargs="?", const=0, type=int, metavar="N", help="ZWO ASI camera number N (default 0); needs zwoasi and ZWO_ASI_LIB")
    cam.add_argument("--alpaca", metavar="URL", help="pass through the Alpaca camera at URL (e.g. http://192.168.1.20:11111)")
    ap.add_argument("--alpaca-device", type=int, default=0)
    ap.add_argument("--sim-tmid", type=float, help="simulated transit: mid-transit as Unix seconds (default: one hour from now)")
    ap.add_argument("--sim-size", default="320x240", help="simulated sensor, WIDTHxHEIGHT")
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1: this computer only)")
    ap.add_argument("--port", type=int, default=ALPACA_PORT)
    ap.add_argument("--time", default="gpsd,ntp", help="time sources in order: gpsd, ntp, geerling (opt-in), none")
    ap.add_argument("--ntp", help="NTP servers, comma-separated (default: ESL_NTP_SERVERS or 0-3.pool.ntp.org)")
    ap.add_argument("--save-dir", help="folder for frames the page sends to PUT /esl/save")
    ap.add_argument("--allow-origin", action="append", help="web origins allowed to use the helper (repeatable; '*' for any)")
    ap.add_argument("--no-discovery", action="store_true", help="do not answer Alpaca discovery on UDP 32227")
    a = ap.parse_args(argv)
    if a.ntp:
        os.environ["ESL_NTP_SERVERS"] = a.ntp
    camera: Optional[Camera] = None
    try:
        if a.simulate:
            w, h = (int(x) for x in a.sim_size.lower().split("x"))
            camera = SimCamera(w, h, tmid=a.sim_tmid)
        elif a.zwo is not None:
            camera = ZwoCamera(a.zwo)
        elif a.alpaca:
            camera = AlpacaCamera(a.alpaca, a.alpaca_device)
    except CameraError as e:
        print(f"camera: {e}", file=sys.stderr); return 2
    sources = tuple(s for s in a.time.split(",") if s and s != "none")
    br = Bridge(camera, time_sources=sources, save_dir=Path(a.save_dir) if a.save_dir else None, origins=tuple(a.allow_origin or DEFAULT_ORIGINS))
    br.start_clock_thread()
    srv = make_server(br, a.host, a.port)
    disc = None if a.no_discovery else discovery_thread(a.port)
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"warning: listening on {a.host}: other computers on this network can reach the camera", file=sys.stderr)
    print(f"esl.bridge {__version__} on http://{a.host}:{a.port}  camera: {camera.name if camera else 'none'}  time: {', '.join(sources) or 'system clock'}"
          f"  discovery: {'on' if disc else 'off'}  saving: {br.save_dir or 'off'}")
    print(f"web pages allowed: {', '.join(br.origins)}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
