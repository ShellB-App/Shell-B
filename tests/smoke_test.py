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
