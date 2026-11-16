"""Generate docs/reference/python.md from the Python package's source (python/esl), without importing it.

Public functions and classes (no leading underscore, listed in esl.__all__ when it exists) with their signatures and
docstrings; pydantic models with their fields. Uses only the standard library (ast), so the docs build needs no
install of the package. Run: python3 tools/docs/gen_python.py
"""
import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "python" / "esl"
OUT = ROOT / "docs" / "reference" / "python.md"


def exported_names():
    init = PKG / "__init__.py"
    tree = ast.parse(init.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "__all__" for t in node.targets):
            return [ast.literal_eval(e) for e in node.value.elts]
    return None


def sig(fn):
    """The signature of a def as written, without the body."""
    a = fn.args
    parts = []
    pos = a.posonlyargs + a.args
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for arg, d in zip(pos, defaults):
        if arg.arg in ("self", "cls"):
            continue
        s = arg.arg + (f": {ast.unparse(arg.annotation)}" if arg.annotation else "")
        if d is not None:
            s += f" = {ast.unparse(d)}"
        parts.append(s)
    if a.vararg:
        parts.append("*" + a.vararg.arg)
    elif a.kwonlyargs:
        parts.append("*")
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        s = arg.arg + (f": {ast.unparse(arg.annotation)}" if arg.annotation else "")
        if d is not None:
            s += f" = {ast.unparse(d)}"
        parts.append(s)
    if a.kwarg:
        parts.append("**" + a.kwarg.arg)
    ret = f" -> {ast.unparse(fn.returns)}" if fn.returns else ""
    return f"{fn.name}({', '.join(parts)}){ret}"


def esc(s):
    return (s or "").replace("<", "&lt;").replace(">", "&gt;").replace("{", "&#123;").replace("}", "&#125;")


def doc_block(node):
    d = ast.get_docstring(node)
    if not d:
        return "_No docstring._\n"
    # docstrings use reStructuredText-ish ``code``: show it as Markdown code
    return esc(d.replace("``", "`")) + "\n"


def main():
    want = exported_names()
    sections = []
    for path in sorted(PKG.glob("*.py")):
        if path.name.startswith("_") and path.name != "__init__.py":
            continue
        tree = ast.parse(path.read_text())
        items = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not node.name.startswith("_"):
                if want is not None and node.name not in want:
                    continue
                items.append(node)
        if not items:
            continue
        md = []
        mod_doc = ast.get_docstring(tree)
        if mod_doc:
            md.append(esc(mod_doc.split("\n\n")[0].replace("``", "`")) + "\n")
        for node in items:
            if isinstance(node, ast.ClassDef):
                bases = ", ".join(ast.unparse(b) for b in node.bases)
                md.append(f"### class {node.name}\n\n```python\nclass {node.name}({bases})\n```\n")
                md.append(doc_block(node))
                fields = [n for n in node.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and not n.target.id.startswith("_")]
                if fields:
                    md.append("| Field | Type | Default |\n| --- | --- | --- |")
                    for f in fields:
                        default = ast.unparse(f.value) if f.value is not None else "required"
                        md.append(f"| `{f.target.id}` | `{esc(ast.unparse(f.annotation))}` | `{esc(default)[:60]}` |")
                    md.append("")
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and not m.name.startswith("_") and ast.get_docstring(m):
                        md.append(f"#### {node.name}.{m.name}\n\n```python\n{sig(m)}\n```\n")
                        md.append(doc_block(m))
            else:
                md.append(f"### {node.name}\n\n```python\n{sig(node)}\n```\n")
                md.append(doc_block(node))
        title = f"esl.{path.stem}" if path.stem != "__init__" else "esl"
        blurb = (ast.get_docstring(tree) or "").split("\n")[0].strip()
        sections.append(f":::: details {title}" + (f" — {esc(blurb)}" if blurb else "") + "\n\n::: v-pre\n\n" + "\n".join(md) + "\n:::\n\n::::\n")
    head = """---
outline: [2, 2]
---
# Python package: `esl`

The website's science core, from Python: the package runs the same JavaScript (bundled, unmodified) in an embedded
engine, so a fit here gives the browser's numbers. New to it? Start with the [labs](../labs/).

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python" matplotlib
```

## Cheat sheet

| You want to | Call |
| --- | --- |
| run an analysis saved on the website | `fit = esl.Session.load("session.json").run()` |
| start from a known planet | `s = esl.lookup("HD 80606 b").session` |
| read a light curve / velocities | `esl.read_light_curve(path_or_text)` · `esl.read_rv(path_or_text)` |
| describe a fit | `esl.Session(planets=[...], data=esl.Data(...), fit=esl.FitSettings(free=[esl.FreeParameter(key="rprs", prior=esl.Prior.uniform(0.05, 0.2))]))` |
| read the result | `fit.result.table()` · `fit.result["rprs"].median` · `fit.result.derived["K"]` · `fit.result.logZ` |
| plot it | `esl.plot.light_curve(fit)` · `esl.plot.radial_velocity(fit, fold=True)` · `esl.plot.corner(fit)` · `esl.plot.oc(fit)` |
| keep it | `fit.save("out.json")` (opens on the website) · `fit.to_markdown()` · `fit.to_latex()` · `fit.to_script()` |
| a model curve | `esl.transit(t, dict(rprs=..., ars=..., inc=..., per=..., tmid=..., ld=[...], law="quadratic"))` · `esl.radial_velocity(t, params)` |
| an ephemeris and O − C | `eph = esl.fit_ephemeris(times, errors, period=P)` · `esl.plot.ephemeris(eph, times, errors)` |
| timing variations | `pg = esl.periodogram(times, errors, period=P); print(pg)` · `esl.plot.periodogram(pg)` |
| limb darkening for a star | `esl.limb_darkening(teff=5600, logg=4.4, feh=0.0, band="TESS")` |

Parameter keys: `rprs` (Rp/R★), `ars` (a/R★, never fitted on its own), `inc` (deg), `per` (d), `tmid` (BJD), `ecc`,
`omega` (deg), `mplanet` (M_Jup), `K` (m/s), `jit@rv1` (jitter of the first velocity set); a second planet's keys end
in its letter: `per@c`. The full format of a session is in [Session format](../FORMAT).

## Full reference

Generated from the package's docstrings (`tools/docs/gen_python.py`). Open a module:

"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(head + "\n".join(sections))
    print(f"docs/reference/python.md: {len(sections)} modules")


if __name__ == "__main__":
    main()
