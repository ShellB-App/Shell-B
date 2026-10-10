"""Shared shelf: a cell copies the owner's shelf (~/shellb/shelf, mounted read-only) into its own Codex once per version,
credited to the author, and leaves an item the guest deleted alone until a new version arrives."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import codex
import db
import shelf


class ShelfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        d = self.tmp / "aia"
        d.mkdir()
        (d / "AIA.txt").write_text("Une histoire au Paléolithique.")
        (d / "text.txt").write_text("Une histoire au Paléolithique.")
        self.item = {"id": "aia", "title": "AÏA", "author": "Guy Minet", "file": "AIA.txt", "version": "1",
                     "description": "Roman."}
        (d / "item.json").write_text(json.dumps(self.item))
        db.kv_set("shelf_seen", {})
        self.patches = [mock.patch.object(shelf, "root", lambda: self.tmp), mock.patch.object(codex, "_spawn", lambda coro: coro.close())]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        for eid in [v["eid"] for v in (db.kv_get("shelf_seen", {}) or {}).values()]:
            if codex.get(eid):
                codex.delete(eid)

    def test_sync_once_per_version(self):
        [eid] = shelf.sync()
        e = codex.get(eid, full=True)
        self.assertEqual(e["title"], "AÏA")
        self.assertEqual(e["createdBy"], "Guy Minet")
        self.assertEqual(e["meta"]["shelf"], "aia")
        self.assertIn("By Guy Minet", e["body"])
        self.assertIn("shared", e["tags"])
        self.assertTrue((codex._dir(eid) / "AIA.txt").is_file())
        self.assertEqual(e["text"], "Une histoire au Paléolithique.")
        self.assertEqual(shelf.sync(), [])  # same version: nothing new

        codex.delete(eid)  # the guest removed it: stays removed
        self.assertEqual(shelf.sync(), [])

        (self.tmp / "aia" / "item.json").write_text(json.dumps({**self.item, "version": "2"}))
        [eid2] = shelf.sync()
        self.assertNotEqual(eid, eid2)
        self.assertTrue(codex.get(eid2))

    def test_bad_items_skipped(self):
        bad = self.tmp / "Bad Name"
        bad.mkdir()
        (bad / "item.json").write_text(json.dumps({**self.item, "id": "Bad Name"}))
        (self.tmp / "nofile").mkdir()
        (self.tmp / "nofile" / "item.json").write_text(json.dumps({**self.item, "id": "nofile", "file": "missing.docx"}))
        self.assertEqual([it["id"] for it in shelf.items()], ["aia"])


if __name__ == "__main__":
    unittest.main()
