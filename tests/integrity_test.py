"""Regressions for the 2026-10-07 review: path IDs, project git isolation, backups and non-destructive compaction.

Shares smoke_test's scratch copy (server/ and the DB in a temp dir), so it never touches the live tree.
    cd ~/shellb/web && venv/bin/python -m unittest discover -s tests -p '*_test.py' -v
"""
import asyncio
import shutil
import subprocess
import time
import unittest

from smoke_test import client, shellb  # noqa: F401 — importing sets up the scratch copy

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
