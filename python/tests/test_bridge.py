"""The local helper (esl.bridge) with the simulated camera, driven by alpyca (the ASCOM Initiative's own Alpaca
client: an independent implementation of the protocol), plus the parts alpyca does not cover: ImageBytes, CORS
and origins, /esl/time, /esl/exposure, /esl/save, discovery replies; and the ZWO backend against a fake zwoasi."""
import json
import threading
import time
import types
import urllib.error
import urllib.request

import numpy as np
import pytest

from esl import bridge as B
from esl import cameras as C
from esl import time as et


@pytest.fixture()
def server(tmp_path):
    cam = C.SimCamera(64, 48, tmid=time.time() + 600, readout_s=0.05)
    clock = et.Clock(skew=2.0)                                     # the computer 2 s fast...
    clock.add(et.Measurement("ntp", "fake NTP", -2.0 + 2.0, 0.004, clock.system()))   # ...measured by a reference
    br = B.Bridge(cam, clock=clock, time_sources=(), save_dir=tmp_path)
    srv = B.make_server(br, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield br, f"127.0.0.1:{srv.server_address[1]}", tmp_path
    srv.shutdown()


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, dict(r.headers), r.read()


def test_alpyca_drives_the_simulated_camera(server):
    alpaca = pytest.importorskip("alpaca")
    from alpaca.camera import Camera
    from alpaca import discovery, management
    br, addr, _ = server
    assert management.apiversions(addr) == [1]
    devs = management.configureddevices(addr)
    assert devs[0]["DeviceType"] == "Camera" and devs[0]["DeviceNumber"] == 0
    cam = Camera(addr, 0)
    cam.Connected = True
    assert cam.Connected and cam.CameraXSize == 64 and cam.CameraYSize == 48 and cam.MaxADU == 65535
    cam.BinX = 2
    assert cam.BinY == 2 and cam.NumX == 32 and cam.NumY == 24
    cam.BinX = 1
    cam.Gain = 120
    assert cam.Gain == 120
    with pytest.raises(Exception):
        cam.Gain = 100000                                          # out of range -> InvalidValueException from alpyca
    cam.SetCCDTemperature = -10.0; cam.CoolerOn = True
    assert cam.CoolerOn and cam.SetCCDTemperature == -10.0
    cam.StartExposure(0.2, True)
    t0 = time.time()
    while not cam.ImageReady:
        assert time.time() - t0 < 5
        time.sleep(0.05)
    img = np.array(cam.ImageArray)                                 # alpyca asks for ImageBytes and returns [x][y]
    assert img.shape == (64, 48), "Alpaca ImageArray is indexed [x][y]"
    sim = br.camera.image()
    assert np.array_equal(img.T, sim), "the pixels alpyca decodes are the camera's, in the right order"
    assert cam.LastExposureDuration == 0.2 and cam.LastExposureStartTime.startswith(time.strftime("%Y-%m-%d", time.gmtime()))
    cam.Connected = False


def test_imagebytes_round_trip_and_layout():
    img = (np.arange(6 * 4, dtype=np.uint16).reshape(4, 6) * 1000)   # 4 rows, 6 columns
    b = C.encode_imagebytes(img, 7, 9)
    h = np.frombuffer(b[:44], dtype="<i4")
    assert list(h) == [1, 0, 7, 9, 44, 2, 8, 2, 6, 4, 0]           # version, error, tx, tx, start, Int32, UInt16, rank 2, x size, y size
    # the first pixels on the wire run down column 0: (x=0, y=0), (0, 1), ...
    wire = np.frombuffer(b[44:], dtype="<u2")
    assert list(wire[:4]) == list(img[:, 0])
    assert np.array_equal(C.decode_imagebytes(b), img)


def test_cors_origins_and_private_network(server):
    _, addr, _ = server
    ok = urllib.request.Request(f"http://{addr}/esl/time", method="OPTIONS", headers={"Origin": "https://pearsonkyle.github.io", "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true"})
    with urllib.request.urlopen(ok, timeout=5) as r:
        assert r.status == 204 and r.headers["Access-Control-Allow-Origin"] == "https://pearsonkyle.github.io" and r.headers["Access-Control-Allow-Private-Network"] == "true"
    s, h, _ = _get(f"http://{addr}/esl/time", {"Origin": "http://localhost:5173"})
    assert s == 200 and h["Access-Control-Allow-Origin"] == "http://localhost:5173"
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(f"http://{addr}/api/v1/camera/0/connected", {"Origin": "https://evil.example"})
    assert e.value.code == 403
    s, h, _ = _get(f"http://{addr}/esl/time")                       # no Origin (N.I.N.A., scripts): answered, no CORS headers
    assert s == 200 and "Access-Control-Allow-Origin" not in h


def test_time_and_exposure_use_the_corrected_clock(server):
    br, addr, _ = server
    _, _, body = _get(f"http://{addr}/esl/time")
    t = json.loads(body)
    assert t["source"] == "ntp" and abs(t["now"] - time.time()) < 0.05 and 0.004 <= t["unc"] < 0.01
    br.camera.connect()
    req = urllib.request.Request(f"http://{addr}/api/v1/camera/0/startexposure", data=b"Duration=0.1&Light=true&ClientTransactionID=5", method="PUT", headers={"Content-Type": "application/x-www-form-urlencoded"})
    before = time.time()
    with urllib.request.urlopen(req, timeout=5) as r:
        j = json.loads(r.read())
    assert j["ErrorNumber"] == 0 and j["ClientTransactionID"] == 5
    _, _, body = _get(f"http://{addr}/esl/exposure")
    e = json.loads(body)
    assert abs(e["start"] - before) < 0.05, "start time by the corrected clock, not the computer's (2 s fast)"
    assert e["clock"]["unc"] >= 4 and e["clock"]["source"] == "ntp" and e["duration"] == 0.1


def test_alpaca_errors(server):
    _, addr, _ = server
    _, _, body = _get(f"http://{addr}/api/v1/camera/0/cameraxsize")        # not connected
    assert json.loads(body)["ErrorNumber"] == B.NOT_CONNECTED
    _, _, body = _get(f"http://{addr}/api/v1/camera/0/pulseguide")
    assert json.loads(body)["ErrorNumber"] == B.NOT_IMPLEMENTED
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(f"http://{addr}/api/v1/camera/3/connected")
    assert e.value.code == 400


def test_save(server):
    _, addr, folder = server
    data = b"SIMPLE  =                    T" + b" " * 2850
    req = urllib.request.Request(f"http://{addr}/esl/save?name=frame_001.fits&folder=HAT-P-32", data=data, method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        out = json.loads(r.read())
    assert (folder / "HAT-P-32" / "frame_001.fits").read_bytes() == data and out["bytes"] == len(data)
    for bad in ("../../etc/passwd", "x.exe", ""):
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(urllib.request.Request(f"http://{addr}/esl/save?name={bad}", data=b"x", method="PUT"), timeout=5)
    with pytest.raises(urllib.error.HTTPError) as e:                # never overwrites
        urllib.request.urlopen(urllib.request.Request(f"http://{addr}/esl/save?name=frame_001.fits&folder=HAT-P-32", data=data, method="PUT"), timeout=5)
    assert e.value.code == 409


def test_simulated_transit_is_in_the_pixels():
    """Noise off: the frame at mid-transit minus the same frame without the transit is exactly the missing
    starlight, depth x the target's flux through the optics (vignetting and extinction included)."""
    cam = C.SimCamera(80, 60, tmid=1_800_000_000.0, depth=0.02, readout_s=0)

    class Zero:
        def standard_normal(self, shape=None):
            return np.zeros(shape) if shape else 0.0
    cam.rng = Zero()
    t = cam.tmid - 15
    a = cam._render("light", t, 30).astype(float)
    cam.depth = 0.0
    b = cam._render("light", t, 30).astype(float)
    hrs = (t + 15 - cam.t_start) / 3600
    tx, ty = cam.truth["target"]
    x, y = tx + cam.drift[0] * hrs, ty + cam.drift[1] * hrs
    vig = 1 - 0.12 * (((x - 40) / 40) ** 2 + ((y - 30) / 30) ** 2)
    ext = np.exp(-0.25 * 0.2) * (1 + 0.01 * np.sin(hrs * 7.3))
    expected = 0.02 * cam.flux * 30 * ext * vig
    assert abs((b - a).sum() - expected) / expected < 0.01          # pixels are rounded to whole ADU


def test_zwo_backend_against_a_fake_sdk():
    calls = []

    class FakeCam:
        def __init__(self, i): self.roi = (0, 0, 64, 48); self.status = 0
        def get_camera_property(self): return {"Name": "ZWO ASI fake", "MaxWidth": 64, "MaxHeight": 48, "PixelSize": 3.76, "SupportedBins": [1, 2], "ElecPerADU": 0.25, "BitDepth": 16, "IsCoolerCam": True, "IsColorCam": True, "BayerPattern": 0}
        def get_controls(self): return {"Gain": {"MinValue": 0, "MaxValue": 300, "DefaultValue": 100}, "Offset": {"MinValue": 0, "MaxValue": 80, "DefaultValue": 50}, "Exposure": {"MinValue": 32, "MaxValue": 2000000000}, "BandWidth": {"MinValue": 40}}
        def set_image_type(self, t): calls.append(("type", t))
        def set_control_value(self, k, v): calls.append(("ctl", k, v))
        def get_control_value(self, k): return (-98, False)
        def set_roi(self, **kw): self.roi = (kw["start_x"], kw["start_y"], kw["width"], kw["height"]); calls.append(("roi", kw))
        def get_roi(self): return self.roi
        def start_exposure(self, is_dark=False): self.status = 2; calls.append(("start", is_dark))
        def get_exposure_status(self): return self.status
        def get_data_after_exposure(self): w, h = self.roi[2:]; return (np.arange(w * h, dtype="<u2")).tobytes()
        def stop_exposure(self): pass

    asi = types.SimpleNamespace(get_num_cameras=lambda: 1, Camera=FakeCam, ASI_IMG_RAW16=2, ASI_BANDWIDTHOVERLOAD=6, ASI_GAIN=0, ASI_OFFSET=5, ASI_EXPOSURE=1,
                                ASI_TEMPERATURE=8, ASI_TARGET_TEMP=16, ASI_COOLER_ON=17, ASI_EXP_SUCCESS=2, ASI_EXP_FAILED=3)
    cam = C.ZwoCamera(0, asi=asi)
    assert cam.bayer_pattern == "RGGB" and cam.gain == 100 and cam.offset == 50 and cam.electrons_per_adu == 0.25 and cam.can_cool
    cam.connect()
    cam.set_bin(2)
    cam.start_exposure(1.5, light=False)
    assert ("ctl", 1, 1500000) in calls and ("start", True) in calls and calls[-2][0] == "ctl"
    assert cam.image_ready
    img = cam.image()
    assert img.shape == (24, 32) and img[0, 1] == 1 and img[1, 0] == 32
    assert cam.ccd_temperature == -9.8
