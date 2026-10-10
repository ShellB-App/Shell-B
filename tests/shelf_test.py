"""Shared shelf: a cell copies the owner's shelf (~/shellb/shelf, mounted read-only) into its own Codex and keeps it in
step (same entry, new file) as versions change, credited to the author, leaving an item the guest deleted alone until a
new version arrives. On the host, the owner shares a Codex file and only the chosen guests' cells can publish a new
version, which also replaces the owner's own copy and keeps the old file."""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import codex
import db
import guests
import shelf

GUY = "guest-3a34a61694aa"
OTHER = "guest-000000000bad"


class CellSync(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        d = self.tmp / "aia"
        d.mkdir()
        (d / "AIA.txt").write_text("Une histoire au Paléolithique.")
        (d / "text.txt").write_text("Une histoire au Paléolithique.")
        self.item = {"id": "aia", "title": "AÏA", "author": "Guy Minet", "file": "AIA.txt", "version": "1",
                     "description": "Roman.", "maintainers": [GUY]}
        self.put(self.item)
        db.kv_set("shelf_seen", {})
        self.patches = [mock.patch.object(shelf, "root", lambda: self.tmp), mock.patch.object(shelf, "CELL_ID", GUY),
                        mock.patch.object(codex, "_spawn", lambda coro: coro.close())]
        for p in self.patches:
            p.start()

    def put(self, it):
        (self.tmp / "aia" / "item.json").write_text(json.dumps(it))

    def tearDown(self):
        for p in self.patches:
            p.stop()
        for eid in [v["eid"] for v in (db.kv_get("shelf_seen", {}) or {}).values()]:
            if codex.get(eid):
                codex.delete(eid)

    def test_sync_and_versions(self):
        [eid] = shelf.sync()
        e = codex.get(eid, full=True)
        self.assertEqual(e["title"], "AÏA")
        self.assertEqual(e["createdBy"], "Guy Minet")
        self.assertEqual((e["meta"]["shelf"], e["meta"]["shelfVersion"], e["meta"]["shelfCanPublish"]), ("aia", "1", True))
        self.assertIn("By Guy Minet", e["body"])
        self.assertIn("shared", e["tags"])
        self.assertTrue((codex._dir(eid) / "AIA.txt").is_file())
        self.assertEqual(e["text"], "Une histoire au Paléolithique.")
        self.assertEqual(shelf.sync(), [])  # same version: nothing new

        # a new version (new file name) updates the same entry in place
        (self.tmp / "aia" / "AIA.txt").unlink()
        (self.tmp / "aia" / "AIA-v2.txt").write_text("Version deux.")
        (self.tmp / "aia" / "text.txt").write_text("Version deux.")
        self.put({**self.item, "version": "2", "file": "AIA-v2.txt", "updatedBy": "Guy", "maintainers": []})
        self.assertEqual(shelf.sync(), [eid])
        e = codex.get(eid, full=True)
        self.assertEqual((e["meta"]["file"], e["meta"]["shelfVersion"], e["meta"]["shelfUpdatedBy"]), ("AIA-v2.txt", "2", "Guy"))
        self.assertFalse(e["meta"]["shelfCanPublish"])  # no longer a maintainer
        self.assertFalse((codex._dir(eid) / "AIA.txt").exists())
        self.assertEqual(e["text"], "Version deux.")

        codex.delete(eid)  # the guest removed it: stays removed
        self.assertEqual(shelf.sync(), [])
        self.put({**self.item, "version": "3", "file": "AIA-v2.txt"})
        [eid3] = shelf.sync()  # back with a new version
        self.assertNotEqual(eid, eid3)

    def test_bad_items_skipped(self):
        bad = self.tmp / "Bad Name"
        bad.mkdir()
        (bad / "item.json").write_text(json.dumps({**self.item, "id": "Bad Name"}))
        (self.tmp / "nofile").mkdir()
        (self.tmp / "nofile" / "item.json").write_text(json.dumps({**self.item, "id": "nofile", "file": "missing.docx"}))
        self.assertEqual([it["id"] for it in shelf.items()], ["aia"])


class HostShelf(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        names = {GUY: {"id": GUY, "name": "Guy"}, OTHER: {"id": OTHER, "name": "Other"}}
        self.patches = [mock.patch.object(shelf, "HOST_SHELF", self.tmp / "shelf"), mock.patch.object(shelf, "HISTORY", self.tmp / "hist"),
                        mock.patch.object(shelf, "CELL", False), mock.patch.object(guests, "get_guest", names.get),
                        mock.patch.object(codex, "_spawn", lambda coro: coro.close())]
        for p in self.patches:
            p.start()
        self.e = codex.create({"kind": "file", "title": "AÏA A4 - V12"})
        (codex._dir(self.e["id"]) / "aia.docx").write_bytes(b"v1 bytes")
        (codex._dir(self.e["id"]) / "text.txt").write_text("v1 text")
        codex._set_meta(self.e["id"], file="aia.docx", size=8)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        codex.delete(self.e["id"])

    def test_share_publish(self):
        it = shelf.share(self.e["id"], author="Guy Minet", title="AÏA", maintainers=[GUY, "guest-nope", "x"])
        self.assertEqual((it["id"], it["version"], it["maintainers"]), ("aia", "1", [GUY]))
        self.assertEqual((self.tmp / "shelf" / "aia" / "text.txt").read_text(), "v1 text")
        self.assertEqual(codex.get(self.e["id"])["meta"]["sharedShelf"], "aia")
        it = shelf.share(self.e["id"], description="Roman.")  # same file: details only
        self.assertEqual((it["version"], it["author"], it["description"]), ("1", "Guy Minet", "Roman."))

        body = {"item": "aia", "name": "AÏA v2.docx", "data": base64.b64encode(b"v2 bytes").decode(), "text": "v2 text"}
        with self.assertRaises(ValueError):
            shelf.publish(OTHER, body)  # not a maintainer
        with mock.patch("activity.post") as post:
            self.assertEqual(shelf.publish(GUY, body), {"version": "2"})
        self.assertIn("Guy published version 2", post.call_args[0][2])
        d = self.tmp / "shelf" / "aia"
        meta = json.loads((d / "item.json").read_text())
        self.assertEqual((meta["version"], meta["updatedBy"], meta["file"]), ("2", "Guy", "AÏA v2.docx"))
        self.assertEqual((d / "AÏA v2.docx").read_bytes(), b"v2 bytes")
        self.assertFalse((d / "aia.docx").exists())
        self.assertEqual((self.tmp / "hist" / "aia" / "v1" / "aia.docx").read_bytes(), b"v1 bytes")
        # the owner's own entry follows
        own = codex.get(self.e["id"], full=True)
        self.assertEqual((own["meta"]["file"], own["text"]), ("AÏA v2.docx", "v2 text"))
        self.assertEqual((codex._dir(self.e["id"]) / "AÏA v2.docx").read_bytes(), b"v2 bytes")
        self.assertEqual(shelf.publish(GUY, body)["unchanged"], True)

        shelf.unshare("aia")
        self.assertFalse(d.exists())
        with self.assertRaises(ValueError):
            shelf.publish(GUY, body)

    def test_api_owner_only(self):
        r = client.put(f"/api/shelf/entries/{self.e['id']}", json={"author": "x"}, headers={"x-shellb-admin": ""})
        self.assertIn(r.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
