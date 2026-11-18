"""esl.time against local fake servers (no network): an NTP server whose clock is a known offset ahead, a
Kiss-o'-Death server, a gpsd that reports PPS; the 64 s rule; the time scales against the core."""
import json
import socket
import struct
import threading
import time

import pytest

import esl.time as et


def _ntp_server(offset=2.5, stratum=2, kod=None, count=None):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    hits = {"n": 0}

    def run():
        s.settimeout(5)
        while True:
            try:
                data, addr = s.recvfrom(512)
            except OSError:
                return
            hits["n"] += 1
            t = time.time() + offset
            out = bytearray(48)
            out[0] = (0 << 6) | (4 << 3) | 4
            out[1] = 0 if kod else stratum
            out[4:8] = struct.pack("!i", int(0.002 * 2 ** 16))          # root delay 2 ms
            out[8:12] = struct.pack("!I", int(0.001 * 2 ** 16))         # root dispersion 1 ms
            out[12:16] = (kod or "GPS\x00").encode()[:4].ljust(4, b"\x00")
            out[24:32] = data[40:48]                                     # origin = the client's transmit
            out[32:40] = et._unix_to_ntp(t)
            out[40:48] = et._unix_to_ntp(t + 1e-4)
            s.sendto(bytes(out), addr)

    threading.Thread(target=run, daemon=True).start()
    return port, hits, s


@pytest.fixture(autouse=True)
def _fresh():
    et._cache.clear(); et._banned.clear()
    yield


def test_sntp_offset_and_bound():
    port, _, s = _ntp_server(offset=2.5)
    m = et.sntp_once("127.0.0.1", port=port)
    s.close()
    assert m.source == "ntp" and m.detail["stratum"] == 2
    assert abs(m.offset - 2.5) <= m.unc + 1e-3                         # the truth inside the bound
    assert m.unc < 0.01                                                 # root distance: delay/2 + 1 ms + 1 ms


def test_sntp_64_second_rule_and_cache():
    port, hits, s = _ntp_server(offset=-0.75)
    a = et.sntp(["127.0.0.1"], port=port)
    b = et.sntp(["127.0.0.1"], port=port)
    s.close()
    assert hits["n"] == 1, "a server must not be asked twice within 64 s"
    assert a is b and abs(a.offset + 0.75) < 0.01


def test_kiss_of_death_stops_queries():
    port, hits, s = _ntp_server(kod="RATE")
    with pytest.raises(et.KissOfDeath):
        et.sntp_once("127.0.0.1", port=port)
    with pytest.raises(et.KissOfDeath):
        et.sntp_once("127.0.0.1", port=port)
    s.close()
    assert hits["n"] == 1 and et._banned["127.0.0.1"] == "RATE"


def test_no_server_answers():
    with pytest.raises(RuntimeError, match="no NTP server answered"):
        et.sntp(["127.0.0.1"], port=9, timeout=0.3)


def test_gpsd_pps():
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
    port = srv.getsockname()[1]

    def run():
        c, _ = srv.accept()
        c.recv(256)
        now = time.time()
        c.sendall((json.dumps({"class": "TPV", "mode": 3, "time": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now)), "lat": 31.96, "lon": -111.6, "altMSL": 2096, "leapseconds": 18}) + "\n").encode())
        for k in range(3):
            real = int(now) + k
            clk = real - 0.0123                                         # the computer is 12.3 ms behind
            c.sendall((json.dumps({"class": "PPS", "real_sec": real, "real_nsec": 0, "clock_sec": int(clk), "clock_nsec": int((clk % 1) * 1e9)}) + "\n").encode())
        time.sleep(0.2); c.close()

    threading.Thread(target=run, daemon=True).start()
    m = et.gpsd("127.0.0.1", port, wait=2)
    srv.close()
    assert m.source == "pps" and abs(m.offset - 0.0123) < 1e-6 and m.unc == 1e-3
    assert m.detail["fix"]["lat"] == 31.96 and m.detail["leap"] == {"gpsMinusUtc": 18}


def test_clock_picks_best_and_skew_hook():
    c = et.Clock(skew=5.0)                                              # pretend the computer is 5 s fast
    assert c.best().source == "system" and c.best().unc is None
    port, _, s = _ntp_server(offset=0.0)
    c.add(et.sntp_once("127.0.0.1", port=port)); s.close()
    assert abs(c.best().offset + 5.0) < 0.01 and abs(c.now() - time.time()) < 0.02
    c.add(et.Measurement("gps", "rough", -5.0, 0.25, c.system()))
    assert c.best().source == "ntp"


def test_scales_from_the_core():
    jd = 2461363.5
    assert abs((et.convert(jd, "UTC", "TAI") - jd) * 86400 - 37) < 1e-4                  # float64 JD: 40 us
    assert abs((et.convert(jd, "UTC", "GPS") - jd) * 86400 - 18) < 1e-4
    assert abs(et.convert(et.convert(jd, "UTC", "TDB"), "TDB", "UTC") - jd) * 86400 < 1e-4
    t = 1795125600.0                                                    # 2026-11-19 22:00 UTC
    assert et.format(t, "utc")["text"] == "2026-11-19 22:00:00"
    assert et.format(t, "site", site={"lon": -111.6, "tz": "America/Phoenix"})["text"] == "2026-11-19 15:00:00"
    assert et.format(t, "mjd")["text"] == f"{t / 86400 + 40587:.5f}"
    lst = et.format(t, "lst", site={"lon": -111.6}, target={"ra": 31.04, "dec": 46.69})
    assert lst["note"].startswith("HA ") and 0 <= lst["value"] < 24
    assert et.format(t, "bjd", target={"ra": 31.04, "dec": 46.69})["value"] > 2461364
