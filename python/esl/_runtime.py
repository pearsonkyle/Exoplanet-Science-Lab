"""Where the JavaScript core runs.

The science of this package is the web application's own code: ``src/core`` bundled into
``esl/_core/esl_core.js`` by ``tools/build_core_bundle.mjs``. This module loads that bundle into a
JavaScript engine and talks to it in JSON. Three engines are supported:

``v8``       PyMiniRacer (``pip install mini-racer``), V8 embedded in the Python process. The default:
             the engine of Chrome and Node, with wheels for macOS, Linux and Windows, nothing else to install.
``node``     a ``node`` subprocess speaking JSON lines. Used when PyMiniRacer is missing and Node is on the PATH.
``quickjs``  the ``quickjs`` package: tiny, no JIT, 20 to 30 times slower. A last resort.

Choose with ``esl.set_runtime("node")`` or the environment variable ``ESL_RUNTIME``. The sampler loop always
runs inside the engine; Python polls it a few times a second for progress.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

CORE_DIR = Path(__file__).parent / "_core"
BUNDLE = CORE_DIR / "esl_core.js"
SPECTRAL = CORE_DIR / "esl_ld_spectral.js"
HOST = CORE_DIR / "host.mjs"

ProgressFn = Callable[[Dict[str, Any]], None]
FetchFn = Callable[[str], str]


class CoreError(RuntimeError):
    """An error raised by the JavaScript core (its message is the core's own)."""


class RuntimeUnavailable(RuntimeError):
    """No JavaScript engine could be started."""


def _default(o: Any) -> Any:
    tolist = getattr(o, "tolist", None)       # numpy arrays and scalars
    if tolist is not None:
        return tolist()
    dump = getattr(o, "model_dump", None)     # pydantic models
    if dump is not None:
        return dump(mode="json", exclude_none=False)
    if isinstance(o, (set, tuple)):
        return list(o)
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"cannot send {type(o).__name__} to the core")


def _clean(o: Any) -> Any:
    """NaN and infinities become null (JSON has neither)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if hasattr(o, "tolist") or hasattr(o, "model_dump"):
        return _clean(_default(o))
    return o


def to_json(args: Any) -> str:
    try:
        return json.dumps(args, default=_default, allow_nan=False, separators=(",", ":"))
    except ValueError:
        return json.dumps(_clean(args), default=_default, allow_nan=False, separators=(",", ":"))


class Engine:
    """A loaded core. ``call`` for synchronous functions, ``run_job`` for the fit and other asynchronous ones."""

    name = "?"
    detail = ""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._spectral = False

    # -- implemented by subclasses
    def _call(self, name: str, args_json: str) -> str: raise NotImplementedError
    def _load(self, path: Path) -> None: raise NotImplementedError
    def run_job(self, name: str, args: List[Any], on_progress: Optional[ProgressFn] = None,
                fetch: Optional[FetchFn] = None) -> Any: raise NotImplementedError
    def close(self) -> None: pass

    def call(self, name: str, *args: Any) -> Any:
        with self._lock:
            out = json.loads(self._call(name, to_json(list(args))))
        if "error" in out:
            raise CoreError(out["error"])
        return out["ok"]

    def load_spectral(self) -> None:
        """Load the wavelength-resolved limb darkening table (260 kB, only needed for custom bands)."""
        with self._lock:
            if not self._spectral:
                self._load(SPECTRAL)
                self._spectral = True


class _Embedded(Engine):
    """An engine inside this process, without an event loop: jobs advance one slice per poll."""

    def _eval(self, code: str) -> Any: raise NotImplementedError
    def _fn(self, fn: str, *args: Any) -> Any: raise NotImplementedError

    def _boot(self) -> None:
        self._eval(BUNDLE.read_text(encoding="utf-8"))
        self._eval("ESL.manualTimers()")

    def _call(self, name: str, args_json: str) -> str:
        return self._fn("ESL.call", name, args_json)

    def _load(self, path: Path) -> None:
        self._eval(path.read_text(encoding="utf-8"))

    def run_job(self, name, args, on_progress=None, fetch=None):
        with self._lock:
            job = self._fn("ESL.start", name, to_json(args))
            stopping, idle = False, 0
            while True:
                try:
                    msg = json.loads(self._fn("ESL.poll", job))
                    if "error" in msg and "done" not in msg:
                        raise CoreError(msg["error"])
                    for req in msg["requests"]:
                        try:
                            if fetch is None:
                                raise RuntimeError("this call cannot read files")
                            self._fn("ESL.resolve", req["id"], fetch(req["name"]))
                        except Exception as exc:  # the core turns it into its own error
                            self._fn("ESL.reject", req["id"], f"{req['name']}: {exc}")
                    if on_progress:
                        for p in msg["progress"]:
                            on_progress(p)
                    if msg["done"]:
                        if "error" in msg:
                            raise CoreError(msg["error"])
                        return msg["result"]
                    idle = 0 if (msg["progress"] or msg["requests"] or msg["waiting"]) else idle + 1
                    if idle > 10000:
                        raise CoreError(f"job '{name}' is waiting for something that never arrives")
                except KeyboardInterrupt:
                    # first Ctrl-C: ask the sampler to stop and return what it has; second: give up
                    if stopping:
                        raise
                    stopping = True
                    self._fn("ESL.stop", job)


class V8Engine(_Embedded):
    name = "v8"

    def __init__(self) -> None:
        super().__init__()
        try:
            from py_mini_racer import MiniRacer
        except ImportError as exc:  # pragma: no cover
            raise RuntimeUnavailable("PyMiniRacer is not installed (pip install mini-racer)") from exc
        self._ctx = MiniRacer()
        self.detail = f"V8 {self._ctx.v8_version} (PyMiniRacer)"
        self._boot()

    def _eval(self, code):
        return self._ctx.eval(code)

    def _fn(self, fn, *args):
        return self._ctx.call(fn, *args)

    def close(self):
        try:
            self._ctx.close()
        except Exception:
            pass


class QuickJSEngine(_Embedded):
    name = "quickjs"

    def __init__(self) -> None:
        super().__init__()
        try:
            import quickjs
        except ImportError as exc:  # pragma: no cover
            raise RuntimeUnavailable("quickjs is not installed (pip install quickjs)") from exc
        self._ctx = quickjs.Context()
        self._ctx.set_max_stack_size(8 * 1024 * 1024)
        self.detail = "QuickJS (no JIT: fits take about 20 times longer than under V8)"
        self._boot()

    def _drain(self):
        while self._ctx.execute_pending_job():
            pass

    def _eval(self, code):
        out = self._ctx.eval(code)
        self._drain()
        return out

    def _fn(self, fn, *args):
        out = self._ctx.eval(f"{fn}({','.join(json.dumps(a) for a in args)})")
        self._drain()
        return out


class NodeEngine(Engine):
    name = "node"

    def __init__(self, executable: Optional[str] = None) -> None:
        super().__init__()
        exe = executable or os.environ.get("ESL_NODE") or shutil.which("node")
        if not exe:
            raise RuntimeUnavailable("node is not on the PATH")
        self._p = subprocess.Popen([exe, str(HOST), str(BUNDLE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        self._id = 0
        hello = self._read()
        if not hello.get("ready"):
            raise RuntimeUnavailable(f"node did not start the core: {hello}")
        self.detail = f"Node {hello['node']} (subprocess)"

    def _send(self, msg: Dict[str, Any]) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
        self._p.stdin.flush()

    def _read(self) -> Dict[str, Any]:
        assert self._p.stdout is not None
        line = self._p.stdout.readline()
        if not line:
            raise CoreError("the node process ended unexpectedly")
        msg = json.loads(line)
        if "fatal" in msg:
            raise CoreError(msg["fatal"])
        return msg

    def _request(self, op: str, **kw: Any) -> str:
        self._id += 1
        self._send({"id": self._id, "op": op, **kw})
        while True:
            msg = self._read()
            if msg.get("id") == self._id and "r" in msg:
                return msg["r"]

    def _call(self, name, args_json):
        return self._request("call", name=name, args=args_json)

    def _load(self, path):
        self._request("load", path=str(path))

    def run_job(self, name, args, on_progress=None, fetch=None):
        with self._lock:
            self._id += 1
            job = self._id
            self._send({"id": job, "op": "start", "name": name, "args": to_json(args)})
            stopping = False
            while True:
                try:
                    msg = self._read()
                    if msg.get("id") != job:
                        continue
                    if "progress" in msg:
                        if on_progress:
                            on_progress(msg["progress"])
                    elif "fetch" in msg:
                        req = msg["fetch"]
                        try:
                            if fetch is None:
                                raise RuntimeError("this call cannot read files")
                            self._send({"op": "resolve", "req": req["req"], "json": fetch(req["name"])})
                        except Exception as exc:
                            self._send({"op": "reject", "req": req["req"], "message": f"{req['name']}: {exc}"})
                    elif msg.get("done"):
                        if "error" in msg:
                            raise CoreError(msg["error"])
                        return msg["result"]
                except KeyboardInterrupt:
                    if stopping:
                        raise
                    stopping = True
                    self._send({"op": "stop", "id": job})

    def close(self):
        try:
            if self._p.stdin:
                self._p.stdin.close()
            self._p.wait(timeout=2)
        except Exception:
            self._p.kill()


_ENGINES = {"v8": V8Engine, "node": NodeEngine, "quickjs": QuickJSEngine}
_ORDER = ["v8", "node", "quickjs"]
_engine: Optional[Engine] = None
_choice: str = os.environ.get("ESL_RUNTIME", "auto").lower()
_guard = threading.Lock()


def set_runtime(name: str = "auto") -> None:
    """Choose the JavaScript engine: "auto" (v8, then node, then quickjs), "v8", "node" or "quickjs"."""
    global _engine, _choice
    name = name.lower()
    if name != "auto" and name not in _ENGINES:
        raise ValueError(f"unknown runtime {name!r}: one of auto, {', '.join(_ENGINES)}")
    with _guard:
        if _engine is not None:
            _engine.close()
        _engine, _choice = None, name


def available_runtimes() -> List[str]:
    """The engines that can be started here, in the order "auto" tries them."""
    out = []
    for n in _ORDER:
        try:
            if n == "v8":
                import py_mini_racer  # noqa: F401
            elif n == "quickjs":
                import quickjs  # noqa: F401
            elif not (os.environ.get("ESL_NODE") or shutil.which("node")):
                continue
            out.append(n)
        except ImportError:
            pass
    return out


def engine() -> Engine:
    """The running engine, started on first use."""
    global _engine
    with _guard:
        if _engine is None:
            if not BUNDLE.exists():
                raise RuntimeUnavailable(f"{BUNDLE} is missing: run `node tools/build_core_bundle.mjs` in the repository")
            names, errors = ([_choice] if _choice != "auto" else _ORDER), []
            for n in names:
                try:
                    _engine = _ENGINES[n]()
                    break
                except RuntimeUnavailable as exc:
                    errors.append(f"{n}: {exc}")
            if _engine is None:
                raise RuntimeUnavailable("no JavaScript engine: `pip install mini-racer`, or install Node.js (" + "; ".join(errors) + ")")
        return _engine


def call(name: str, *args: Any) -> Any:
    """Call a synchronous function of the core's API (see ``esl.core.info()["api"]``)."""
    return engine().call(name, *args)


def run_job(name: str, args: List[Any], on_progress: Optional[ProgressFn] = None, fetch: Optional[FetchFn] = None) -> Any:
    return engine().run_job(name, args, on_progress, fetch)


def runtime_info() -> str:
    """One line: which engine runs the core, and which build of the core it is."""
    e = engine()
    s = e.call("info")
    return f"{e.detail}; core {s['version']} (sources {s['sourceHash']}{', commit ' + s['commit'][:10] if s.get('commit') else ''})"


class Stopwatch:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()

    @property
    def seconds(self) -> float:
        return time.perf_counter() - self.t0
