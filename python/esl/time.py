"""Trusted time for observing: how far this computer's clock is off, from NTP, gpsd or a GNSS-disciplined server,
and the time scales an observer reads (UTC, JD, MJD, BJD_TDB, LST).

    import esl.time as et
    clock = et.Clock()
    clock.sync()                       # NTP pool (one query per server, at most 4 servers), or gpsd if running
    clock.now()                        # Unix seconds, corrected
    clock.info()                       # source, offset [s], uncertainty [s]
    et.format(clock.now(), "bjd", target={"ra": 31.04, "dec": 46.69})
    et.convert(2461363.5, "UTC", "TDB")

Sources (each returns a :class:`Measurement`):

* :func:`sntp` — Simple NTP over UDP (RFC 4330), standard library only. The NTP Pool's rules are kept: at most four
  servers, no bursts (one packet per server per call), no server asked twice within 64 s (the cached answer is
  returned), Kiss-o'-Death answers (RATE, DENY, RSTR) stop all further queries to that server. Servers come from
  ``ESL_NTP_SERVERS`` (comma-separated) or default to ``0-3.pool.ntp.org``. Anyone shipping this in a product that
  runs on many machines should ask the NTP Pool for a vendor zone (https://www.ntppool.org/vendors.html) and set it.
* :func:`gpsd` — a running gpsd (localhost:2947): PPS pulses when gpsd sees them (about 1 ms), else the
  receiver's time messages (about 0.25 s, the serial latency).
* :func:`geerling` — opt-in: SNTP to ``ntp-01.jeffgeerling.com`` (stratum 2, synced to his GNSS-disciplined
  stratum-1 clock) plus its status page (``https://time.jeffgeerling.com/api/status``: GNSS lock, leap seconds).
  It is one person's server: call it yourself, it is never used by default.

The time scales and the offset arithmetic are the JavaScript core's (``timescale.js``, ``timeformat.js``,
``clocksync.js``), so numbers here are the browser's.
"""
from __future__ import annotations

import json
import os
import socket
import struct
import threading
import time as _time
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from . import _runtime

NTP_EPOCH = 2208988800                      # seconds from 1900-01-01 to 1970-01-01
MIN_POLL_S = 64                             # the shortest interval between two queries to one server
DEFAULT_SERVERS = ("0.pool.ntp.org", "1.pool.ntp.org", "2.pool.ntp.org", "3.pool.ntp.org")
GEERLING_NTP = "ntp-01.jeffgeerling.com"
GEERLING_STATUS = "https://time.jeffgeerling.com/api/status"
USER_AGENT = "exoplanet-science-lab (esl.time)"


@dataclass
class Measurement:
    """One clock comparison. ``offset`` = reference minus this computer [s]; ``unc`` bounds its error [s]."""
    source: str                             # 'ntp', 'gps', 'pps', 'https', 'system'
    label: str
    offset: float
    unc: Optional[float]
    at: float                               # local Unix time of the measurement
    detail: Dict[str, Any] = field(default_factory=dict)

    def aged_unc(self, now: Optional[float] = None, drift: float = 20e-6) -> Optional[float]:
        """Uncertainty now: a computer clock drifts by up to about 20 ppm (72 ms an hour)."""
        if self.unc is None:
            return None
        return self.unc + drift * max(0.0, (now if now is not None else _time.time()) - self.at)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class KissOfDeath(RuntimeError):
    """The server asked us to stop (RATE, DENY or RSTR)."""


# ---- SNTP --------------------------------------------------------------------------------------------------------

_cache: Dict[str, Measurement] = {}
_banned: Dict[str, str] = {}
_lock = threading.Lock()


def _ntp_to_unix(b: bytes) -> float:
    s, f = struct.unpack("!II", b)
    return s - NTP_EPOCH + f / 2 ** 32


def _unix_to_ntp(t: float) -> bytes:
    s = int(t) + NTP_EPOCH
    return struct.pack("!II", s & 0xFFFFFFFF, int((t % 1) * 2 ** 32) & 0xFFFFFFFF)


def sntp_once(host: str, *, port: int = 123, timeout: float = 2.0, _clock=_time.time) -> Measurement:
    """One SNTP exchange with ``host``, without the cache or the 64 s rule (use :func:`sntp`)."""
    if host in _banned:
        raise KissOfDeath(f"{host} sent a Kiss-o'-Death ({_banned[host]}); not asked again in this process")
    addr = socket.getaddrinfo(host, port, 0, socket.SOCK_DGRAM)[0]
    with socket.socket(addr[0], socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        t1 = _clock()
        sent = _unix_to_ntp(t1)
        pkt = bytes([0x23]) + bytes(39) + sent                     # LI 0, version 4, mode 3 (client); transmit time
        s.sendto(pkt, addr[4])
        while True:
            data, _ = s.recvfrom(512)
            t4 = _clock()
            if len(data) >= 48 and data[24:32] == sent:             # the answer to this request (origin = our transmit)
                break
    li, vn, mode, stratum = data[0] >> 6, (data[0] >> 3) & 7, data[0] & 7, data[1]
    refid = data[12:16]
    if stratum == 0:
        code = refid.decode("ascii", "replace")
        if code in ("RATE", "DENY", "RSTR"):
            _banned[host] = code
        raise KissOfDeath(f"{host}: Kiss-o'-Death {code}")
    if mode not in (4, 5) or li == 3:
        raise RuntimeError(f"{host}: not a synchronised server answer (mode {mode}, leap indicator {li})")
    root_delay = struct.unpack("!i", data[4:8])[0] / 2 ** 16
    root_disp = struct.unpack("!I", data[8:12])[0] / 2 ** 16
    t2, t3 = _ntp_to_unix(data[32:40]), _ntp_to_unix(data[40:48])
    offset = ((t2 - t1) + (t3 - t4)) / 2
    delay = (t4 - t1) - (t3 - t2)
    # the root distance: a bound on the error of the offset (RFC 5905 section 11.2)
    unc = abs(delay) / 2 + root_delay / 2 + root_disp
    return Measurement("ntp", f"NTP {host} (stratum {stratum})", offset, unc, t4,
                       {"host": host, "stratum": stratum, "delay": delay, "root_delay": root_delay, "root_dispersion": root_disp,
                        "leap_indicator": li, "version": vn, "refid": refid.hex() if stratum > 1 else refid.decode("ascii", "replace").strip("\x00")})


def servers() -> List[str]:
    env = os.environ.get("ESL_NTP_SERVERS")
    return [h.strip() for h in env.split(",") if h.strip()][:4] if env else list(DEFAULT_SERVERS)


def sntp(hosts: Optional[Sequence[str]] = None, *, timeout: float = 2.0, port: int = 123) -> Measurement:
    """Ask up to four NTP servers once each and return the answer with the smallest error bound.

    A server asked less than 64 s ago is not asked again: its earlier answer is used. Failures are skipped;
    if none answers, RuntimeError lists why."""
    hosts = list(hosts or servers())[:4]
    got, errors = [], []
    for h in hosts:
        with _lock:
            c = _cache.get(h)
            if c is not None and _time.time() - c.at < MIN_POLL_S:
                got.append(c)
                continue
        try:
            m = sntp_once(h, timeout=timeout, port=port)
            with _lock:
                _cache[h] = m
            got.append(m)
        except Exception as e:                                      # noqa: BLE001 - every failure is reported together
            errors.append(f"{h}: {e}")
    if not got:
        raise RuntimeError("no NTP server answered: " + "; ".join(errors))
    best = min(got, key=lambda m: m.aged_unc())
    best.detail = {**best.detail, "asked": hosts, "errors": errors, "answers": len(got)}
    return best


# ---- gpsd --------------------------------------------------------------------------------------------------------

def gpsd(host: str = "127.0.0.1", port: int = 2947, *, wait: float = 3.0, _clock=_time.time) -> Measurement:
    """Time from a running gpsd: its PPS reports (``real`` - ``clock``) when it has them, otherwise its TOFF or TPV
    reports against the arrival time. Also returns the fix and the leap-second count in ``detail``."""
    pps, toff, tpv, leap = [], [], None, None
    deadline = _clock() + wait
    with socket.create_connection((host, port), timeout=wait) as s:
        s.sendall(b'?WATCH={"enable":true,"json":true,"pps":true};\n')
        f = s.makefile("r", encoding="ascii", errors="replace")
        while _clock() < deadline and len(pps) < 3:
            s.settimeout(max(0.05, deadline - _clock()))
            try:
                line = f.readline()
            except (socket.timeout, OSError):
                break
            if not line:
                break
            at = _clock()
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            cls = msg.get("class")
            if cls == "PPS" and "real_sec" in msg:
                pps.append((msg["real_sec"] + msg.get("real_nsec", 0) * 1e-9) - (msg["clock_sec"] + msg.get("clock_nsec", 0) * 1e-9))
            elif cls == "TOFF" and "real_sec" in msg:
                toff.append((msg["real_sec"] + msg.get("real_nsec", 0) * 1e-9) - (msg["clock_sec"] + msg.get("clock_nsec", 0) * 1e-9))
            elif cls == "TPV" and msg.get("time") and msg.get("mode", 0) >= 2:
                tpv = (msg, at)
                if "leapseconds" in msg:
                    leap = msg["leapseconds"]
    fix = None
    if tpv:
        m = tpv[0]
        fix = {k: m.get(k) for k in ("lat", "lon", "altMSL", "alt", "mode") if k in m}
    detail = {"host": f"{host}:{port}", "fix": fix, "leap": {"gpsMinusUtc": leap} if leap is not None else None}
    now = _clock()
    if pps:
        pps.sort()
        return Measurement("pps", "gpsd PPS", pps[len(pps) // 2], 1e-3, now, {**detail, "pulses": len(pps)})
    if toff:
        return Measurement("gps", "gpsd (serial time)", toff[-1], 0.25, now, detail)
    if tpv:
        from datetime import datetime
        t = datetime.fromisoformat(tpv[0]["time"].replace("Z", "+00:00")).timestamp()
        # the report for second t arrives after t by the receiver's latency (0 to about 0.25 s)
        return Measurement("gps", "gpsd (TPV)", t - tpv[1] + 0.125, 0.125, now, detail)
    raise RuntimeError(f"gpsd at {host}:{port} sent no time within {wait} s (no fix yet?)")


# ---- the GNSS-disciplined server of time.jeffgeerling.com (opt-in) ------------------------------------------------

def geerling_status(timeout: float = 5.0) -> Dict[str, Any]:
    """The status of time.jeffgeerling.com: GNSS lock, satellites, leap seconds, the server's own offsets."""
    req = urllib.request.Request(GEERLING_STATUS, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def geerling(timeout: float = 5.0) -> Measurement:
    """SNTP to ntp-01.jeffgeerling.com, checked against its status page (lock, leap seconds). Opt-in only."""
    m = sntp([GEERLING_NTP], timeout=timeout)
    try:
        st = geerling_status(timeout)
        g = st.get("gnss") or {}
        m.detail = {**m.detail, "status": st.get("status_text"), "gnss_satellites": g.get("used"), "leap": {"gpsMinusUtc": g.get("leap")} if g.get("leap") is not None else None}
        if st.get("status") != "ok":
            m.unc = (m.unc or 0) + 1.0                             # not locked to GNSS: count it as a rough clock
    except Exception as e:                                          # noqa: BLE001
        m.detail = {**m.detail, "status": f"status page unreachable: {e}"}
    m.label = "NTP ntp-01.jeffgeerling.com (GNSS)"
    return m


# ---- the clock ---------------------------------------------------------------------------------------------------

class Clock:
    """The best of the measurements made so far. Without any, it is the system clock (``unc`` None)."""

    def __init__(self, skew: float = 0.0):
        self.measurements: Dict[str, Measurement] = {}
        self.skew = skew                                           # test hook: pretend the computer is this far off [s]

    def system(self) -> float:
        return _time.time() + self.skew

    def add(self, m: Measurement) -> Measurement:
        if self.skew:
            m = Measurement(m.source, m.label, m.offset - self.skew, m.unc, m.at + self.skew, m.detail)
        self.measurements[m.source] = m
        return m

    def sync(self, sources: Sequence[str] = ("gpsd", "ntp"), *, hosts: Optional[Sequence[str]] = None) -> "Measurement":
        """Measure with each source in turn ('gpsd', 'ntp', 'geerling'); failures are kept in ``errors``."""
        self.errors: Dict[str, str] = {}
        for s in sources:
            try:
                if s == "gpsd":
                    self.add(gpsd())
                elif s == "ntp":
                    self.add(sntp(hosts))
                elif s == "geerling":
                    self.add(geerling())
                else:
                    raise ValueError(f"unknown source {s!r}")
            except Exception as e:                                  # noqa: BLE001
                self.errors[s] = str(e)
        return self.best()

    def best(self) -> Measurement:
        now = self.system()
        live = [m for m in self.measurements.values() if m.unc is not None]
        if not live:
            return Measurement("system", "system clock (not checked)", 0.0, None, now)
        return min(live, key=lambda m: m.aged_unc(now))

    def now(self) -> float:
        """Unix seconds, corrected by the best measurement."""
        return self.system() + self.best().offset

    def info(self) -> Dict[str, Any]:
        b = self.best()
        out = b.to_dict()
        out["effective_unc"] = b.aged_unc(self.system())
        out["sources"] = [m.to_dict() for m in self.measurements.values()]
        lp = (b.detail or {}).get("leap")
        if lp:
            out["leap_check"] = _runtime.call("invoke", "timescale.leapCheck", [convert_unix_to_jd(self.now()), lp])
        return out


_default = Clock()


def default_clock() -> Clock:
    return _default


def now(scale: str = "unix", *, site: Optional[Dict[str, Any]] = None, target: Optional[Dict[str, Any]] = None) -> Any:
    """The present from the default clock (call ``esl.time.default_clock().sync()`` first to correct it):
    Unix seconds for ``scale="unix"``, else :func:`format` of it."""
    t = _default.now()
    return t if scale == "unix" else format(t, scale, site=site, target=target)


def convert_unix_to_jd(t: float) -> float:
    return t / 86400 + 2440587.5


def convert(jd: float, from_scale: str, to_scale: str) -> float:
    """A Julian date between UTC, TAI, TT, GPS and TDB (``timescale.convertJd`` of the core)."""
    return float(_runtime.call("invoke", "timescale.convertJd", [jd, from_scale, to_scale]))


def format(t: float, scale: str, *, site: Optional[Dict[str, Any]] = None, target: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:  # noqa: A001
    """Unix seconds ``t`` in a display scale: local, site, utc, jd, mjd, bjd, lst (``timeformat.formatScale``).
    ``site`` = {"lon": deg east, "tz": IANA name}; ``target`` = {"ra", "dec"} in degrees (for BJD_TDB and the hour angle)."""
    return _runtime.call("invoke", "timeformat.formatScale", [t * 1000.0, scale, {"site": site, "target": target}])


def main(argv: Optional[Sequence[str]] = None) -> int:
    """``python -m esl.time [--geerling] [--gpsd]``: measure this computer's clock and print the result."""
    import argparse
    ap = argparse.ArgumentParser(prog="python -m esl.time", description=main.__doc__)
    ap.add_argument("--gpsd", action="store_true", help="also ask a local gpsd")
    ap.add_argument("--geerling", action="store_true", help="also ask ntp-01.jeffgeerling.com (opt-in)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    c = Clock()
    c.sync((["gpsd"] if a.gpsd else []) + ["ntp"] + (["geerling"] if a.geerling else []))
    info = c.info()
    if a.json:
        print(json.dumps({**info, "errors": c.errors}, indent=1, default=str))
    else:
        for m in info["sources"]:
            print(f"{m['label']:<45} offset {m['offset'] * 1000:+9.3f} ms  ± {m['unc'] * 1000:.3f} ms")
        for k, e in c.errors.items():
            print(f"{k}: {e}")
        print(f"best: {info['label']}; this computer is {abs(info['offset']) * 1000:.1f} ms {'slow' if info['offset'] > 0 else 'fast'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
