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
        md = [f"## `esl.{path.stem}`\n" if path.stem != "__init__" else "## `esl`\n"]
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
        sections.append("\n".join(md))
    head = """---
outline: [2, 3]
---
# Python package: `esl`

The same science code as the website, from Python: the package runs the site's JavaScript core (bundled,
unmodified) in an embedded engine, so a fit gives the browser's numbers. Install it straight from GitHub:

```sh
pip install "git+https://github.com/pearsonkyle/Exoplanet-Science-Lab.git#subdirectory=python"
```

```python
import esl

session = esl.Session.load("session.json")   # a file saved from the Analyze page, or built in Python
fit = session.run(progress=True)
print(fit.result.table())
```

Generated from the package's docstrings (`tools/docs/gen_python.py`).

"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(head + "::: v-pre\n\n" + "\n".join(sections) + "\n:::\n")
    print(f"docs/reference/python.md: {len(sections)} modules")


if __name__ == "__main__":
    main()
