"""Smoke and regression tests for the Shell:B Web server, run against a scratch copy.

    cd ~/shellb/web && venv/bin/python -m unittest discover -s tests -p '*_test.py' -v

Importing server/app.py has side effects (schedules.init() marks in-flight runs as interrupted, background loops start on
startup), so the tests never touch the live tree: they copy server/ and data/shellb.db to a temp dir and import from
there (db.DATA is relative to db.py). TestClient is used without its context manager, so startup hooks don't run and no
background loops start. Requests from TestClient count as localhost (owner) requests.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
_TMP = Path(tempfile.mkdtemp(prefix="shellb-test-"))
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)


def _scratch():
    shutil.copytree(WEB / "server", _TMP / "server", ignore=shutil.ignore_patterns("__pycache__"))
    (_TMP / "data").mkdir()
    if (WEB / "data" / "shellb.db").exists():
        shutil.copy2(WEB / "data" / "shellb.db", _TMP / "data" / "shellb.db")
    (_TMP / "ui" / "dist" / "assets").mkdir(parents=True)
    (_TMP / "ui" / "src").mkdir(parents=True)
    shutil.copy2(WEB / "ui" / "src" / "cdnMap.json", _TMP / "ui" / "src" / "cdnMap.json")  # offline.py reads it at import
    (_TMP / "ui" / "dist" / "index.html").write_text("<!doctype html><title>test</title>")
    sys.path.insert(0, str(_TMP / "server"))
    os.chdir(_TMP / "server")


_scratch()
from fastapi.testclient import TestClient  # noqa: E402

import app as shellb  # noqa: E402
import projects  # noqa: E402

client = TestClient(shellb.app, client=("127.0.0.1", 50000), raise_server_exceptions=False)  # localhost = owner


class ReadRoutes(unittest.TestCase):
    """Every page's first request should answer without a server error."""
    ROUTES = ["/api/conversations", "/api/agents", "/api/tools", "/api/settings", "/api/models", "/api/library",
              "/api/memory", "/api/codex", "/api/codex/entries", "/api/activity", "/api/schedules",
              "/api/generate", "/api/generate/history", "/api/notify/key", "/api/commitments", "/api/brief",
              "/api/import/status"]

    def test_no_server_errors(self):
        for path in self.ROUTES:
            with self.subTest(path=path):
                r = client.get(path)
                self.assertEqual(r.status_code, 200, f"{path}: {r.status_code} {r.text[:300]}")


class WorkspaceFiles(unittest.TestCase):
    def setUp(self):
        self.conv = "conv-smoketest"
        self.ws = shellb.WORKSPACES / self.conv
        self.ws.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def _get(self, name, body="x"):
        (self.ws / name).write_text(body)
        return client.get(f"/api/workspace/{self.conv}/{name}")

    def test_pages_are_sandboxed(self):
        for name in ("a.html", "a.svg", "a.shtml", "a.xht", "a.xsl"):
            with self.subTest(name=name):
                self.assertIn("sandbox", self._get(name).headers.get("content-security-policy", ""))

    def test_passive_files_are_not(self):
        r = self._get("notes.txt")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("content-security-policy", r.headers)

    def test_conv_id_cannot_escape(self):
        self.assertEqual(client.get("/api/workspace/..%2Fprojects/x").status_code, 404)


class ProjectPaths(unittest.TestCase):
    def test_root_is_refused_for_deletes(self):
        pid = "proj-smoketest"
        (projects.PROJECTS / pid).mkdir(parents=True, exist_ok=True)
        try:
            for rel in ("", ".", "/", "./"):
                with self.subTest(rel=rel):
                    with self.assertRaises(ValueError):
                        projects.safe_path(pid, rel, allow_root=False)
            self.assertEqual(projects.safe_path(pid, ""), projects.root(pid).resolve())
            with self.assertRaises(ValueError):
                projects.safe_path(pid, "../other")
        finally:
            shutil.rmtree(projects.PROJECTS / pid, ignore_errors=True)


class FrameScope(unittest.TestCase):
    """A sandboxed page's key reaches its own project or chat (plus shared files and its own saved state), nothing else;
    pages on this machine get no localhost trust."""
    @classmethod
    def setUpClass(cls):
        import auth
        import db
        cls.auth = auth
        cls.secret = "test-frame-secret-0123456789"
        with db.conn() as c:
            c.execute("INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?)",
                      ("sid-frametest", cls.secret, 0, 0, 4e9, "10.0.0.2", "test"))
        cls.lan = TestClient(shellb.app, client=("10.0.0.2", 50000), raise_server_exceptions=False, follow_redirects=False)
        for pid in ("proj-fa", "proj-fb"):
            (projects.PROJECTS / pid).mkdir(parents=True, exist_ok=True)
            (projects.PROJECTS / pid / "index.html").write_text(f"<p>{pid}</p>")
        for conv in ("conv-fa", "conv-fb"):
            (shellb.WORKSPACES / conv).mkdir(parents=True, exist_ok=True)
            (shellb.WORKSPACES / conv / "data.txt").write_text(conv)

    @classmethod
    def tearDownClass(cls):
        for d in (projects.PROJECTS / "proj-fa", projects.PROJECTS / "proj-fb", shellb.WORKSPACES / "conv-fa", shellb.WORKSPACES / "conv-fb"):
            shutil.rmtree(d, ignore_errors=True)

    def k(self, scope, secret=None):
        return self.auth.frame_prefix(secret or self.secret, scope)

    def test_project_key_reaches_only_its_project(self):
        own = self.lan.get(f"{self.k('p-proj-fa')}/projects/proj-fa/raw/index.html")
        self.assertEqual(own.status_code, 200, own.text[:200])
        self.assertEqual(self.lan.get(f"{self.k('p-proj-fa')}/projects/proj-fb/raw/index.html").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('p-proj-fa')}/workspace/conv-fa/data.txt").status_code, 403)

    def test_chat_key_reaches_only_its_workspace(self):
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/workspace/conv-fa/data.txt").text, "conv-fa")
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/workspace/conv-fb/data.txt").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/projects/proj-fa/raw/index.html").status_code, 403)

    def test_saved_state_is_scoped(self):
        self.assertEqual(self.lan.get(f"{self.k('p-proj-fa')}/appstate/boot.js?s=proj:proj-fa").status_code, 200)
        self.assertEqual(self.lan.get(f"{self.k('p-proj-fa')}/appstate?s=proj:proj-fb").status_code, 403)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/appstate?s=art:conv-fa:a1").status_code, 200)
        self.assertEqual(self.lan.get(f"{self.k('w-conv-fa')}/appstate?s=art:conv-fb:a1").status_code, 403)

    def test_forged_and_old_keys_fail(self):
        self.assertEqual(self.lan.get(f"/api/k/p-proj-fa.{'0' * 32}/projects/proj-fa/raw/index.html").status_code, 401)
        self.assertEqual(self.lan.get(f"/api/k/{self.secret}/projects/proj-fa/raw/index.html").status_code, 401)  # unscoped
        other = self.k("p-proj-fb").split(".")[-1]
        self.assertEqual(self.lan.get(f"/api/k/p-proj-fa.{other}/projects/proj-fa/raw/index.html").status_code, 401)

    def test_local_key_only_on_loopback(self):
        local = self.auth.local_frame_secret()
        url = f"{self.k('w-conv-fa', local)}/workspace/conv-fa/data.txt"
        self.assertEqual(client.get(url).status_code, 200)
        self.assertEqual(self.lan.get(url).status_code, 401)

    def test_pages_on_this_machine_get_no_local_trust(self):
        for h in ({"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(h=h):
                self.assertEqual(client.get("/api/workspace/conv-fb/data.txt", headers=h).status_code, 401)
                self.assertEqual(client.get("/api/conversations", headers=h).status_code, 401)
        self.assertEqual(client.get("/api/workspace/conv-fb/data.txt", headers={"Sec-Fetch-Site": "same-origin"}).status_code, 200)

    def test_page_loads_move_under_their_key(self):
        noredir = TestClient(shellb.app, client=("127.0.0.1", 50000), raise_server_exceptions=False, follow_redirects=False)
        r = noredir.get("/api/projects/proj-fa/raw/index.html", headers={"Sec-Fetch-Dest": "iframe"})
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.headers["location"].startswith(self.k("p-proj-fa", self.auth.local_frame_secret()) + "/projects/proj-fa/raw/"))
        self.assertEqual(noredir.get(r.headers["location"]).status_code, 200)
        w = noredir.get("/api/workspace/conv-fa/data.txt", headers={"Sec-Fetch-Dest": "document"})
        self.assertEqual(w.status_code, 302)
        self.assertEqual(noredir.get(w.headers["location"]).text, "conv-fa")
        self.assertEqual(noredir.get("/api/workspace/conv-fa/data.txt").status_code, 200)  # tools (no fetch metadata) as before


class Codex(unittest.TestCase):
    def test_spawn_from_worker_thread(self):
        """Sync endpoints run in a worker thread; codex._spawn must hand the task to the loop instead of raising."""
        import codex
        ran = []

        async def job():
            ran.append(True)

        async def main():
            codex._LOOP = asyncio.get_running_loop()
            await asyncio.to_thread(codex._spawn, job())
            await asyncio.sleep(0.05)
        asyncio.run(main())
        self.assertEqual(ran, [True])


if __name__ == "__main__":
    unittest.main()
