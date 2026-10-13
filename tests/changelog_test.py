"""The shipped docs/changelog.json parses, is well-formed, and /api/changelog serves it newest first. Every `news` line
(the What's new card) has a French entry, since the UI translates it from a variable the i18n scan can't see."""
import json
import unittest
from pathlib import Path

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import changelog

changelog.FILE = Path(__file__).resolve().parent.parent / "docs" / "changelog.json"  # the scratch copy has no docs/


class Changelog(unittest.TestCase):
    def test_file_is_well_formed(self):
        entries, error = changelog.load()
        self.assertEqual(error, "")
        self.assertTrue(entries)
        for e in entries:
            self.assertRegex(e["date"], r"^\d{4}-\d\d-\d\d$")
            self.assertTrue(e["title"])

    def test_news_lines_are_translated(self):
        entries, _ = changelog.load()
        fr = json.loads((changelog.FILE.parent.parent / "ui" / "src" / "i18n" / "fr.json").read_text(encoding="utf-8"))
        missing = [e["news"] for e in entries if e["news"] and e["news"] not in fr]
        self.assertEqual(missing, [])

    def test_endpoint_newest_first(self):
        r = client.get("/api/changelog").json()
        dates = [e["date"] for e in r["entries"]]
        self.assertEqual(dates, sorted(dates, reverse=True))


if __name__ == "__main__":
    unittest.main()
