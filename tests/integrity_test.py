"""Regressions for the 2026-10-07 review: path IDs, project git isolation, backups and non-destructive compaction.

Shares smoke_test's scratch copy (server/ and the DB in a temp dir), so it never touches the live tree.
    cd ~/shellb/web && venv/bin/python -m unittest discover -s tests -p '*_test.py' -v
"""
import asyncio
import importlib.util
import io
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import WEB, client, shellb  # noqa: F401 — importing sets up the scratch copy

import backup
import compaction
import db
import ids
import projects
from agent import history_messages


class PathIds(unittest.TestCase):
    """`/api/projects/%2e%2e/...` used to resolve to data/ itself: it could read admin.key or rmtree everything."""

    def test_dot_segments_refused(self):
        for method, path in [("GET", "/api/projects/%2e%2e/raw/admin.key"), ("GET", "/api/assets/file/%2e%2e/admin.key"),
                             ("DELETE", "/api/projects/%2e%2e"), ("DELETE", "/api/research/%2e%2e"),
                             ("GET", "/api/projects/proj-000000000000/raw/%2e%2e/%2e%2e/admin.key")]:
            with self.subTest(path=path):
                r = client.request(method, path)
                self.assertEqual(r.status_code, 400, r.text[:200])

    def test_folder_helpers_check_ids(self):
        for kind, bad in [("project", ".."), ("project", "proj-../x"), ("board", "rb-zz"), ("assetlib", "")]:
            with self.subTest(kind=kind, bad=bad):
                self.assertFalse(ids.valid(kind, bad))
        with self.assertRaises(Exception):
            projects.root("..")

    def test_unknown_project_delete_is_404(self):
        self.assertEqual(client.delete("/api/projects/proj-0123456789ab").status_code, 404)


class ProjectGit(unittest.TestCase):
    """A project whose .git went missing must get its own repo back, never use the one above it."""

    def setUp(self):
        self.pid = "proj-feedfacecafe"
        self.base = projects.PROJECTS / self.pid
        self.base.mkdir(parents=True, exist_ok=True)
        (self.base / "index.html").write_text("<h1>hi</h1>")

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_missing_git_is_recreated_in_the_project(self):
        self.assertFalse((self.base / ".git").exists())
        projects.git(self.pid, "status")
        self.assertTrue((self.base / ".git").is_dir())
        log = subprocess.run(["git", "log", "--format=%s"], cwd=self.base, capture_output=True, text=True,
                             env=projects.git_env(self.base)).stdout
        self.assertIn("Recovered", log)
        self.assertEqual([f["path"] for f in projects.list_files(self.pid)], ["index.html"])


class Backups(unittest.TestCase):
    def test_archive_lookup_is_exact(self):
        for bad in ("app.py", "../shellb.db", "/etc/passwd", "shellb", ".tar.gz"):
            with self.subTest(bad=bad):
                self.assertIsNone(backup.find_archive(bad))

    def test_project_history_kept_codex_key_left_out(self):
        self.assertNotIn(".git", backup.EXCLUDE_PATTERNS)
        ignore = backup._ignore_for("codex")
        self.assertIn(".key", ignore(str(db.DATA / "codex"), [".key", "notes.json"]))
        self.assertNotIn("notes.json", ignore(str(db.DATA / "codex"), [".key", "notes.json"]))
        self.assertEqual(backup._ignore_for("projects")(str(db.DATA / "projects" / "p"), [".git", "a.html"]), set())

    def test_backups_need_admin(self):
        self.assertEqual(client.get("/api/backup").status_code, 403)  # localhost alone isn't admin


class CellBackups(unittest.TestCase):
    """2026-10-11: every scheduled backup failed on the guest cells' sockets (Errno 6) and on their data folders, which
    belong to the cells' uids (Errno 13). Special files are skipped, cell data goes through cells.export_data, and a
    path that can't be copied is noted in the manifest instead of failing the archive."""

    def setUp(self):
        import cells
        self.cells = cells
        self.root = db.DATA / "cells"
        self.good, self.bad = self.root / "guest-aaaaaaaaaaaa", self.root / "guest-bbbbbbbbbbbb"
        for d in (self.good, self.bad):
            for sub in ("data", "web", "sock"):
                (d / sub).mkdir(parents=True, exist_ok=True)
        (self.good / "data" / "notes.txt").write_text("guest notes")
        cwd = os.getcwd()
        os.chdir(self.good / "web")  # a relative bind keeps the socket path under 108 bytes
        try:
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.bind("web.sock")
        finally:
            os.chdir(cwd)
        self.fifo = db.DATA / "skills" / "pipe"
        self.fifo.parent.mkdir(exist_ok=True)
        os.mkfifo(self.fifo)
        self.locked = db.DATA / "skills" / "locked.md"
        self.locked.write_text("x")
        self.locked.chmod(0)
        self.exported = []

        def export_data(gid, dest, exclude=(), secret=()):
            if gid == self.bad.name:
                raise RuntimeError("docker said no")
            self.exported.append((gid, set(exclude), set(secret)))
            with tarfile.open(dest, "w") as t:
                t.add(self.good / "data" / "notes.txt", arcname="notes.txt")
            return ["tmp/gone.txt: vanished"]
        self.real_export, cells.export_data = cells.export_data, export_data

    def tearDown(self):
        self.cells.export_data = self.real_export
        self.sock.close()
        self.locked.chmod(0o600)
        for p in (self.fifo, self.locked):
            p.unlink(missing_ok=True)
        shutil.rmtree(self.root, ignore_errors=True)

    def test_backup_survives_sockets_cells_and_unreadable_files(self):
        m = backup.create_backup(scope="core", note="cell test")
        path = backup.BACKUP_DIR / m["filename"]
        try:
            with tarfile.open(path) as t:
                names = set(t.getnames())
                cell_tar = tarfile.open(fileobj=t.extractfile(f"cells/{self.good.name}/data.tar"))
                self.assertEqual(cell_tar.extractfile("notes.txt").read(), b"guest notes")
            self.assertFalse({n for n in names if n.endswith(("web.sock", "skills/pipe")) or "/data/" in n or n.endswith("/data")})
            self.assertNotIn(f"cells/{self.bad.name}/data.tar", names)
            self.assertIn("shellb.db", names)
            self.assertEqual(m["cells"], [self.good.name])
            self.assertEqual(self.exported, [(self.good.name, backup.EXCLUDE_PATTERNS, set(backup.SECRET_FILES))])
            skipped = "\n".join(m["skipped"])
            self.assertIn("skills/locked.md", skipped)
            self.assertIn(f"cells/{self.good.name}/data/tmp/gone.txt", skipped)
            self.assertIn(f"cells/{self.bad.name}/data: docker said no", skipped)
        finally:
            path.unlink(missing_ok=True)
            backup._rebuild_index()

    def test_restore_hands_cells_to_import_data(self):
        staged = Path(tempfile.mkdtemp())
        (staged / self.good.name).mkdir()
        (staged / self.good.name / "data.tar").write_bytes(b"")
        (staged / "not-a-cell").mkdir()
        (staged / self.bad.name).mkdir()  # no data.tar: left alone
        calls = []
        real, self.cells.import_data = self.cells.import_data, lambda gid, src, keep=(): calls.append((gid, src.name, list(keep)))
        try:
            self.assertEqual(backup._restore_cells(staged), [])
        finally:
            self.cells.import_data = real
            shutil.rmtree(staged)
        self.assertEqual(calls, [(self.good.name, "data.tar", backup.SECRET_FILES)])


class CellDataTool(unittest.TestCase):
    """cell/datatar.py, run here on plain folders (in production it runs in the cell image as the cell's uid)."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("datatar", WEB / "cell" / "datatar.py")
        self.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.tool)
        self.src, self.dst = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        (self.src / "codex").mkdir()
        (self.src / "codex" / ".key").write_text("secret")
        (self.src / "codex" / "a.txt").write_text("a")
        (self.src / "backups").mkdir()
        (self.src / "backups" / "old.tar.gz").write_text("old")
        (self.src / "link").symlink_to("codex/a.txt")
        os.mkfifo(self.src / "fifo")
        c = sqlite3.connect(self.src / "shellb.db")
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("CREATE TABLE t(x)")
        c.execute("INSERT INTO t VALUES(42)")
        c.commit()
        self.conn = c  # kept open: the -wal file holds the row, as in a running cell

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.src)
        shutil.rmtree(self.dst)

    def run_tool(self, cmd, root, opts, stdin=b""):
        out, err = io.BytesIO(), io.StringIO()
        fake_out = type("Out", (), {"buffer": out})()
        fake_in = type("In", (), {"buffer": io.BytesIO(stdin)})()
        self.tool.ROOT = str(root)
        with mock.patch.object(sys, "stdout", fake_out), mock.patch.object(sys, "stdin", fake_in), \
                mock.patch.object(sys, "stderr", err):
            {"export": self.tool.export, "import": self.tool.import_}[cmd](opts)
        return out.getvalue(), err.getvalue()

    def test_round_trip(self):
        data, err = self.run_tool("export", self.src, {"exclude": ["backups", "shellb.db-wal", "shellb.db-shm"],
                                                      "secret": ["codex/.key"]})
        self.assertEqual(err, "")
        names = set(tarfile.open(fileobj=io.BytesIO(data)).getnames())
        self.assertEqual(names, {"codex", "codex/a.txt", "link", "shellb.db"})
        (self.dst / "stale.txt").write_text("from before")
        (self.dst / "codex").mkdir()
        (self.dst / "codex" / ".key").write_text("this machine's key")
        self.run_tool("import", self.dst, {"keep": ["codex/.key"]}, stdin=data)
        self.assertFalse((self.dst / "stale.txt").exists())
        self.assertEqual((self.dst / "codex" / ".key").read_text(), "this machine's key")
        self.assertEqual(os.readlink(self.dst / "link"), "codex/a.txt")
        self.assertEqual(sqlite3.connect(self.dst / "shellb.db").execute("SELECT x FROM t").fetchall(), [(42,)])


class Compaction(unittest.TestCase):
    """Summaries mark messages; they never delete them, and the prompt says honestly what it lost."""

    def setUp(self):
        self.conv = db.create_conversation(agent_id="shellb", title="compaction test")["id"]
        t = time.time() - 1000
        for i in range(30):
            role = "user" if i % 2 == 0 else "assistant"
            mid = db.add_message(self.conv, role, f"{role} message {i} " + "x" * 2000)
            with db.conn() as c:
                c.execute("UPDATE messages SET created=? WHERE id=?", (t + i, mid))

    def tearDown(self):
        db.delete_conversation(self.conv)

    def test_summary_marks_but_keeps(self):
        before = len(db.list_messages(self.conv))
        res = asyncio.run(compaction.compact_now(self.conv, 8192, {"utilityModel": ""}))
        self.assertTrue(res["compacted"], res)
        history = db.list_messages(self.conv)
        self.assertEqual(len(history), before + 1)  # one summary row added, nothing deleted
        summarized = [m for m in history if m.get("summarizedBy")]
        self.assertEqual(len(summarized), res["compactedCount"])
        vis = compaction.visible(history)
        self.assertTrue(all(not m.get("summarizedBy") for m in vis if m["role"] != "summary"))
        self.assertIn("lossy summary", compaction.note(history, self.conv))
        prompt = history_messages(history, self.conv, 32768)
        self.assertFalse(any("retain the full context" in (m.get("content") or "") for m in prompt))
        self.assertEqual(prompt[0]["role"], "user")

    def test_second_summary_supersedes_the_first(self):
        asyncio.run(compaction.compact_now(self.conv, 8192, {"utilityModel": ""}))
        for i in range(8):
            db.add_message(self.conv, "user" if i % 2 == 0 else "assistant", f"later {i}")
        asyncio.run(compaction.compact_now(self.conv, 8192, {"utilityModel": ""}))
        history = db.list_messages(self.conv)
        live = [m for m in compaction.visible(history) if m["role"] == "summary"]
        self.assertEqual(len(live), 1)

    def test_edit_invalidates_parked_summary(self):
        asyncio.run(compaction.prepare(self.conv, 8192, 0, {"utilityModel": ""}, force=True))
        first = db.list_messages(self.conv)[0]
        db.delete_messages_from(self.conv, first["id"])  # an edit of the very first message
        self.assertIsNone(compaction.commit_pending(self.conv))


if __name__ == "__main__":
    unittest.main()
