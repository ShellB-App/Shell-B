"""Interface languages (ui/src/i18n): every English string the UI passes to t()/tn() has a French entry, placeholders
match, and the catalog parses. Keeps the French complete as strings are added: a new t('…') without a translation
fails here rather than falling back to English in Guy's browser.

Keys taken from a variable (t(v.label), t(CATEGORY[x])) can't be seen by this scan; those tables' values are listed
in the catalog by hand."""
import json
import re
import unittest
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "ui" / "src"
CATALOG = UI / "i18n" / "fr.json"
STR = r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")"""
T_CALL = re.compile(r"(?<![\w.])tx?\(\s*" + STR)  # t(), or tx() where a file has its own `t` and imports the alias
TN_CALL = re.compile(r"(?<![\w.])tn\([^,()]+,\s*" + STR + r"\s*,\s*" + STR)
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def _unescape(s: str) -> str:
    return re.sub(r"\\(.)", r"\1", s)


def used_keys() -> dict[str, set[str]]:
    """key → files using it, over every TS/TSX file under ui/src."""
    out: dict[str, set[str]] = {}
    for f in UI.rglob("*.ts*"):
        if "node_modules" in f.parts or f.suffix not in (".ts", ".tsx") or f == UI / "i18n" / "index.ts":  # its doc comments show examples
            continue
        text = f.read_text(encoding="utf-8")
        rel = str(f.relative_to(UI))
        for m in T_CALL.finditer(text):
            out.setdefault(_unescape(m.group(1) if m.group(1) is not None else m.group(2)), set()).add(rel)
        for m in TN_CALL.finditer(text):
            plural = m.group(3) if m.group(3) is not None else m.group(4)
            out.setdefault(_unescape(plural), set()).add(rel)
    return out


class French(unittest.TestCase):
    def setUp(self):
        self.cat = json.loads(CATALOG.read_text(encoding="utf-8"))
        self.used = used_keys()

    def test_scan_finds_the_gates(self):
        self.assertIn("Log in", self.used)
        self.assertIn("Sign in", self.used)
        self.assertGreater(len(self.used), 100)

    def test_every_used_string_is_translated(self):
        missing = sorted(k for k in self.used if k not in self.cat)
        self.assertEqual(missing, [], f"{len(missing)} strings without a French entry, e.g. {missing[:8]}")

    def test_placeholders_match(self):
        for key, val in self.cat.items():
            forms = [val] if isinstance(val, str) else list(val.values())
            want = set(PLACEHOLDER.findall(key))
            for form in forms:
                self.assertIsInstance(form, str, key)
                self.assertEqual(set(PLACEHOLDER.findall(form)) - {"n"}, want - {"n"}, f"placeholders differ: {key!r} → {form!r}")
            if isinstance(val, dict):
                self.assertIn("other", val, key)

    def test_no_untranslated_copies(self):
        """A value equal to its key is fine for names (Wiki, Radio…) but a long one means a forgotten translation."""
        same_in_french = {"Conversations", "Notifications", "Cloudflare Email Sending", "Contacts ({v0})", "{gateway} via {interface}", "Active · …{keyTail}{v0}", "MusicGen · :8002"}
        same = [k for k, v in self.cat.items() if isinstance(v, str) and v == k and len(k) > 12 and k not in same_in_french]
        self.assertEqual(same, [], same)


if __name__ == "__main__":
    unittest.main()
