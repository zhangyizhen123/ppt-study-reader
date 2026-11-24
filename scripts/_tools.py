"""Shared environment fixes for the helper scripts (mirrors server/tools_env.mjs).

- Prepends a Unicode-capable poppler build to PATH on Windows (Git/MSYS ships an
  xpdf pdftotext without -bbox; MiKTeX's poppler cannot open non-ANSI paths).
  Override with the PPT_POPPLER_BIN environment variable.
- Forces UTF-8 stdout/stderr so Chinese file names print on any console code page.
"""

import os
import subprocess
import sys


def _is_poppler_bin(d: str) -> bool:
    exe = os.path.join(d, "pdftotext.exe" if os.name == "nt" else "pdftotext")
    if not os.path.isfile(exe):
        return False
    try:
        r = subprocess.run([exe, "-v"], capture_output=True, text=True, encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return "poppler" in (r.stdout + r.stderr).lower()


def _candidates():
    if os.environ.get("PPT_POPPLER_BIN"):
        yield os.environ["PPT_POPPLER_BIN"]
    if os.name == "nt":
        scoop = os.environ.get("SCOOP") or os.path.join(os.path.expanduser("~"), "scoop")
        yield os.path.join(scoop, "apps", "poppler", "current", "bin")
        if os.environ.get("CONDA_PREFIX"):
            yield os.path.join(os.environ["CONDA_PREFIX"], "Library", "bin")
        yield r"C:\ProgramData\chocolatey\lib\poppler\tools\Library\bin"


def apply_tool_env() -> str:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    for d in _candidates():
        if d and _is_poppler_bin(d):
            parts = os.environ.get("PATH", "").split(os.pathsep)
            os.environ["PATH"] = os.pathsep.join([d] + [p for p in parts if p != d])
            return d
    return ""
