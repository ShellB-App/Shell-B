"""Community gallery: a fetched repository becomes a catalogue, themes install through the validator, screensavers
become sandboxed Studio projects with only the folder's allowed files, templates start new projects, installing needs the owner."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import community
import db
import gallery
import projects
import themes

THEME = {"name": "Testpool", "blurb": "A test theme", "mode": "light", "author": "Tester", "license": "MIT", "version": "1.1",
         "palette": {"bg": "#eef5f1", "panel": "#f7fbf8", "text": "#10302a", "text2": "#3f5f58", "muted": "#5b746e",
                     "accent": "#0f7f73", "brand": "#2c6fb0", "line": "#0a2a24"},
         "inks": ["#0f7f73", "#2c6fb0"], "fonts": {"display": "sora", "body": "sora"}, "shape": "round",
         "backdrop": {"sky": ["#f4f9f6", "#cfe4dc"], "horizon": "waves", "horizonColor": "#9fcabd"},
         "particles": {"kind": "bubbles", "colors": ["#ffffff"], "density": 0.7}}
SAVER_HTML = "<!doctype html><html><body><canvas id=c></canvas><script>addEventListener('resize',()=>{});</script></body></html>"


def fake_repo(root: Path):
    t = root / "themes" / "testpool"
    t.mkdir(parents=True)
    (t / "theme.json").write_text(json.dumps(THEME))
    (root / "themes" / "Bad Name").mkdir()
    (root / "themes" / "Bad Name" / "theme.json").write_text(json.dumps(THEME))
    s = root / "screensavers" / "swirl"
    (s / "assets").mkdir(parents=True)
    (s / "saver.json").write_text(json.dumps({"name": "Swirl", "blurb": "Swirly", "author": "Tester", "license": "MIT", "version": "2.0", "clockSafe": False}))
    (s / "index.html").write_text(SAVER_HTML)
    (s / "assets" / "dot.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (s / "assets" / "tool.exe").write_bytes(b"MZ")          # not an allowed type
    (s / ".secret").write_text("x")                          # dotfile
    (s / "preview.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    os.symlink("/etc/hostname", s / "link.txt")              # symlink
    t = root / "templates" / "launch"
    (t / "assets").mkdir(parents=True)
    (t / "template.json").write_text(json.dumps({"name": "Launch page", "kind": "website", "blurb": "A launch page", "brief": "Sell the thing.",
                                                 "author": "Tester", "authorUrl": "https://example.org/t", "license": "MIT", "version": "1.2"}))
    (t / "index.html").write_text("<!doctype html><title>Launch</title><h1>Launch</h1>")
    (t / "assets" / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (t / "notes.exe").write_bytes(b"MZ")
    (t / "preview.jpg").write_bytes(b"\xff\xd8\xff")
    (root / "templates" / "nokind").mkdir()
    (root / "templates" / "nokind" / "template.json").write_text(json.dumps({"name": "x", "kind": "poster", "author": "a", "license": "MIT"}))
    (root / "templates" / "nokind" / "index.html").write_text("x")
    (root / ".complete").write_text("1")


class Gallery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="gallery-"))
        cls.sha = "0" * 40
        cls.repo = "example/Shell-B-Things"
        root = community._repo_dir(cls.repo, cls.sha)
        root.mkdir(parents=True, exist_ok=True)
        fake_repo(root)
        db.kv_set("gallery_sources", [{"id": "test-themes", "kind": "theme", "repo": cls.repo, "ref": cls.sha},
                                      {"id": "test-savers", "kind": "screensaver", "repo": cls.repo, "ref": cls.sha},
                                      {"id": "test-templates", "kind": "template", "repo": cls.repo, "ref": cls.sha}])
        db.kv_set("gallery_theme", {})
        db.kv_set("gallery_screensaver", {})
        db.kv_set("gallery_template", {})
        db.kv_set(gallery.INSTALLED_KEY, {})

    def test_listing_reads_the_pinned_repo(self):
        res = asyncio.run(gallery.listing("theme", refresh=True))
        self.assertEqual(res["errors"], [])
        items = res["sources"][0]["items"]
        self.assertEqual([i["id"] for i in items], ["testpool"])   # the badly named folder is skipped
        self.assertEqual(items[0]["theme"]["palette"]["accent"], "#0f7f73")
        self.assertEqual(items[0]["swatch"]["inks"], ["#0f7f73", "#2c6fb0"])
        res = asyncio.run(gallery.listing("screensaver", refresh=True))
        sv = res["sources"][0]["items"][0]
        self.assertEqual(sv["name"], "Swirl")
        self.assertFalse(sv["clockSafe"])
        self.assertEqual(sv["files"], ["assets/dot.svg", "index.html"])   # exe, dotfile and symlink left out
        self.assertEqual(sv["preview"], "screensavers/swirl/preview.png")
        r = client.get("/api/gallery/screensaver/test-savers/swirl/preview")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/png")
        self.assertEqual(client.get("/api/gallery/theme/test-themes/testpool/preview").status_code, 404)
        self.assertEqual(client.get("/api/gallery/nothing").status_code, 404)

    def test_install_needs_owner(self):
        self.assertEqual(client.post("/api/gallery/install", json={"kind": "theme", "source": "test-themes", "id": "testpool"}).status_code, 403)
        self.assertEqual(client.post("/api/gallery/sources", json={"kind": "theme", "repo": "a/b"}).status_code, 403)
        self.assertEqual(client.get("/api/gallery/theme").status_code, 200)   # browsing is open

    def test_theme_installs_through_the_validator_and_updates_in_place(self):
        asyncio.run(gallery.listing("theme", refresh=True))
        res = gallery.install_theme("test-themes", "testpool")
        t = res["theme"]
        self.assertEqual(t["name"], "Testpool")
        self.assertEqual(t["community"]["repo"], self.repo)
        self.assertIn("accentText", t["palette"])                      # cleaned, not copied raw
        self.assertTrue(any(x["id"] == t["id"] for x in themes.all_themes()))
        again = gallery.install_theme("test-themes", "testpool")["theme"]
        self.assertEqual(again["id"], t["id"])                          # reinstall replaces, no twin
        listed = asyncio.run(gallery.listing("theme"))["sources"][0]["items"][0]
        self.assertEqual(listed["installed"], t["id"])
        self.assertEqual(listed["installedVersion"], "1.1")
        r = client.get(f"/api/gallery/export/theme/{t['id']}")
        self.assertEqual(r.status_code, 200)
        out = r.json()
        self.assertNotIn("id", out)
        self.assertNotIn("accentText", out["palette"])
        self.assertEqual(out["inks"], ["#0f7f73", "#2c6fb0"])
        themes.delete_theme(t["id"])
        self.assertIsNone(asyncio.run(gallery.listing("theme"))["sources"][0]["items"][0]["installed"])

    def test_screensaver_becomes_a_project_with_only_safe_files(self):
        asyncio.run(gallery.listing("screensaver", refresh=True))
        res = gallery.install_screensaver("test-savers", "swirl")
        pid = res["project"]["id"]
        self.assertEqual(res["project"]["kind"], "screensaver")
        base = projects.root(pid)
        self.assertEqual((base / "index.html").read_text(), SAVER_HTML)
        self.assertTrue((base / "assets" / "dot.svg").exists())
        for bad in ("assets/tool.exe", ".secret", "link.txt", "saver.json", "preview.png"):
            self.assertFalse((base / bad).exists(), bad)
        self.assertIn("community gallery", (base / "DESIGN.md").read_text())
        self.assertEqual(gallery.install_screensaver("test-savers", "swirl")["project"]["id"], pid)   # update in place
        listed = asyncio.run(gallery.listing("screensaver"))["sources"][0]["items"][0]
        self.assertEqual(listed["installed"], pid)
        client.delete(f"/api/projects/{pid}")
        self.assertIsNone(asyncio.run(gallery.listing("screensaver"))["sources"][0]["items"][0]["installed"])

    def test_template_starts_a_new_project_each_time(self):
        res = asyncio.run(gallery.listing("template", refresh=True))
        items = res["sources"][0]["items"]
        self.assertEqual([i["id"] for i in items], ["launch"])            # unknown kind skipped
        it = items[0]
        self.assertEqual((it["kind"], it["entry"], it["authorUrl"]), ("website", "index.html", "https://example.org/t"))
        self.assertEqual(it["files"], ["assets/logo.svg", "index.html"])   # exe left out
        self.assertNotIn("installed", it)
        a = gallery.install_template("test-templates", "launch", "My launch")
        b = gallery.install_template("test-templates", "launch")
        self.assertNotEqual(a["project"]["id"], b["project"]["id"])          # a template never updates in place
        self.assertEqual((a["project"]["name"], a["project"]["kind"]), ("My launch", "website"))
        base = projects.root(a["project"]["id"])
        self.assertIn("<h1>Launch</h1>", (base / "index.html").read_text())
        self.assertTrue((base / "assets" / "logo.svg").exists())
        self.assertFalse((base / "notes.exe").exists())
        design = (base / "DESIGN.md").read_text()
        self.assertIn("Sell the thing.", design)
        self.assertIn("Launch page", design)
        self.assertEqual(client.get("/api/gallery/template/test-templates/launch/preview").status_code, 200)
        self.assertNotIn("installed", asyncio.run(gallery.listing("template"))["sources"][0]["items"][0])
        for r in (a, b):
            client.delete(f"/api/projects/{r['project']['id']}")

    def test_sources(self):
        src = gallery.add_source("theme", "https://github.com/Some-One/Their-Themes.git")
        self.assertEqual(src["repo"], "Some-One/Their-Themes")
        self.assertIn(src["id"], [s["id"] for s in gallery.sources()])
        gallery.remove_source(src["id"])
        self.assertNotIn(src["id"], [s["id"] for s in gallery.sources()])
        with self.assertRaises(ValueError):
            gallery.add_source("theme", "not a repo")
        with self.assertRaises(ValueError):
            gallery.add_source("font", "a/b")


class Via(unittest.TestCase):
    """Shell:B's own repositories follow their git.shellb.app redirect; anything else, or a failed lookup, keeps its name."""
    def resolve(self, repo, response=None, error=None):
        from unittest import mock
        import httpx
        community._via_cache.clear()
        async def head(_self, url, **kw):
            if error:
                raise error
            return httpx.Response(response[0], headers=response[1], request=httpx.Request("HEAD", url))
        with mock.patch.object(httpx.AsyncClient, "head", head):
            return asyncio.run(community.resolve_repo(repo))

    def test_resolve(self):
        import httpx
        moved = (302, {"location": "https://github.com/shellb-org/Themes"})
        self.assertEqual(self.resolve("ShellB-App/Shell-B-Themes", moved), "shellb-org/Themes")
        same = (302, {"location": "https://github.com/shellb-app/shell-b-themes"})
        self.assertEqual(self.resolve("ShellB-App/Shell-B-Themes", same), "ShellB-App/Shell-B-Themes")
        self.assertEqual(self.resolve("ShellB-App/Shell-B-Themes", (404, {})), "ShellB-App/Shell-B-Themes")
        self.assertEqual(self.resolve("ShellB-App/Shell-B-Themes", (302, {"location": "https://evil.example/x/y"})),
                         "ShellB-App/Shell-B-Themes")
        self.assertEqual(self.resolve("ShellB-App/Shell-B-Themes", error=httpx.ConnectError("down")),
                         "ShellB-App/Shell-B-Themes")
        self.assertEqual(self.resolve("someone/else", moved), "someone/else")
        community._via_cache.clear()


if __name__ == "__main__":
    unittest.main()
