"""Settings → Community: the official repositories are always listed, the owner can add and remove their own, a fetched
repository is counted from its index.json (or its folder), and changing the list needs the owner."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import community
import db
import family
import gallery


def fake_repo(root: Path, kind: str, n: int):
    (root / "index.json").write_text(json.dumps({"format": 1, "kind": kind, "items": [{"id": f"i{i}", "name": f"Item {i}"} for i in range(n)]}))
    (root / ".complete").write_text("1")


class Family(unittest.TestCase):
    def setUp(self):
        db.kv_set("family_repos", [])
        db.kv_set("family_stats", {})
        db.kv_set("gallery_sources", [])
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        fake_repo(self.root, "theme", 3)

        async def ls(repo, ref):
            return "abc123" * 6 + "abcdef12"

        async def fetch(repo, sha):
            return self.root
        self.p1 = mock.patch.object(community, "_ls_remote", ls)
        self.p2 = mock.patch.object(community, "fetch_repo", fetch)
        self.p1.start(); self.p2.start()

    def tearDown(self):
        self.p1.stop(); self.p2.stop(); self.tmp.cleanup()

    def test_official_always_listed(self):
        rows = client.get("/api/family").json()["repos"]
        self.assertEqual([r["id"] for r in rows if r["official"]], [o["id"] for o in family.OFFICIAL])
        self.assertTrue(all(r["url"].startswith("https://github.com/EveAeternam/Shell-B") for r in rows if r["official"]))
        self.assertEqual({r["kind"] for r in rows}, set(family.KINDS))
        self.assertTrue(all(r["where"] and r["kindLabel"] for r in rows))

    def test_add_refresh_remove(self):
        with mock.patch.object(gallery, "add_source", wraps=gallery.add_source) as add:
            entry = family.add("theme", "https://github.com/someone/Their-Themes.git", "main", "")
            self.assertEqual(entry["repo"], "someone/Their-Themes")
            self.assertEqual(entry["name"], "Their-Themes")
            add.assert_called_once_with("theme", "someone/Their-Themes", "main")  # a theme repo becomes a gallery source
        self.assertTrue(any(s["repo"] == "someone/Their-Themes" for s in gallery.sources()))
        rows = family.repos()
        self.assertFalse(rows[-1]["official"])
        self.assertIsNone(rows[-1]["stats"])

        import asyncio
        stat = asyncio.run(family.refresh(rows[-1]))
        self.assertEqual(stat["count"], 3)
        self.assertEqual(stat["names"], ["Item 0", "Item 1", "Item 2"])
        self.assertEqual(stat["error"], "")
        self.assertEqual(family.repos()[-1]["stats"]["count"], 3)

        with self.assertRaises(ValueError):
            family.add("theme", "someone/Their-Themes")           # twice
        with self.assertRaises(ValueError):
            family.add("theme", "EveAeternam/Shell-B-Themes")      # an official one
        with self.assertRaises(ValueError):
            family.add("poem", "a/b")                              # unknown kind
        with self.assertRaises(ValueError):
            family.add("theme", "not a repo")

        family.remove(rows[-1]["id"])
        self.assertTrue(all(r["official"] for r in family.repos()))
        self.assertFalse(any(s["repo"] == "someone/Their-Themes" for s in gallery.sources()))
        with self.assertRaises(KeyError):
            family.remove("shellb-themes")                         # official ones stay

    def test_wrong_kind_and_unreachable(self):
        import asyncio
        entry = family.add("agent", "someone/odd")
        stat = asyncio.run(family.refresh(entry))
        self.assertIn("holds themes, not agents", stat["error"])

        async def down(repo, ref):
            raise ValueError("Couldn't reach github.com/someone/odd")
        with mock.patch.object(community, "_ls_remote", down):
            stat = asyncio.run(family.refresh(entry))
        self.assertIn("Couldn't reach", stat["error"])
        self.assertEqual(stat["sha"], "abc123" * 6 + "abcdef12")   # the last good fetch is kept

    def test_changing_needs_owner(self):
        self.assertEqual(client.post("/api/family", json={"kind": "theme", "repo": "a/b"}).status_code, 403)
        self.assertEqual(client.delete("/api/family/shellb-themes").status_code, 403)
        self.assertEqual(client.get("/api/family").status_code, 200)   # reading is open


if __name__ == "__main__":
    unittest.main()
