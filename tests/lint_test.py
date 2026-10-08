"""Static checks that catch the bugs that took Shell:B down before: a name used but never defined (the `os` import
crash loop, the planetary fetchers deleted while still called) only fails when that line runs, so a restart or a
rarely used route finds it first. pyflakes finds it now.

Only the error classes that are always bugs fail the test; unused imports and style are left to taste.
"""
import io
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent

try:
    from pyflakes import api, messages, reporter
except ImportError:  # pragma: no cover
    api = None

FATAL = tuple(getattr(messages, n) for n in ("UndefinedName", "UndefinedLocal", "UndefinedExport", "DuplicateArgument",
                                               "ReturnOutsideFunction", "YieldOutsideFunction", "ContinueOutsideLoop",
                                               "BreakOutsideLoop", "ImportStarUsed") if api and hasattr(messages, n))


class _Collect(reporter.Reporter if api else object):
    def __init__(self):
        if api:
            super().__init__(io.StringIO(), io.StringIO())
        self.found = []

    def flake(self, message):
        if isinstance(message, FATAL):
            self.found.append(str(message))

    def syntaxError(self, filename, msg, lineno, offset, text):
        self.found.append(f"{filename}:{lineno}: syntax error: {msg}")


@unittest.skipIf(api is None, "pyflakes isn't installed (venv/bin/pip install pyflakes)")
class Pyflakes(unittest.TestCase):
    def test_no_undefined_names(self):
        rep = _Collect()
        for f in sorted((WEB / "server").glob("*.py")):
            api.checkPath(str(f), rep)
        self.assertEqual(rep.found, [], "\n" + "\n".join(rep.found))


if __name__ == "__main__":
    unittest.main()
