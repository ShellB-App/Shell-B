"""Git remotes (server/gitremote.py) against a local bare repository standing in for GitHub."""
import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb  # noqa: F401

import db
import gitremote
import projects as P

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


class Remote(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gitremote-"))
        self.bare = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.bare)], check=True)
        proj = db.create_project("Remote test", "code", "README.md", "")
        self.pid = proj["id"]
        (P.PROJECTS / self.pid).mkdir(parents=True, exist_ok=True)
        root = P.root(self.pid)
        (root / "README.md").write_text("# hi\n")
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True, env=P.git_env(root))
        P.commit(self.pid, "first")
        # file:// stands in for https in the tests
        self._patches = [mock.patch.object(gitremote, "check_url", lambda u: u),
                         mock.patch.object(gitremote, "GIT_PROTOCOLS", ["-c", "protocol.file.allow=always"])]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        db.delete_project(self.pid)
        import shutil
        shutil.rmtree(P.root(self.pid), ignore_errors=True)
        shutil.rmtree(P.META / self.pid, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_https_only_without_credentials_in_the_url(self):
        for p in self._patches:
            p.stop()
        try:
            for bad in ("http://github.com/o/r.git", "https://user:tok@github.com/o/r.git", "ssh://git@github.com/o/r", "https://192.168.1.4/x.git", "file:///tmp/x"):
                with self.assertRaises(ValueError, msg=bad):
                    gitremote.check_url(bad)
            self.assertEqual(gitremote.check_url("https://github.com/o/r.git"), "https://github.com/o/r.git")
        finally:
            for p in self._patches:
                p.start()

    def test_set_push_pull_and_status(self):
        cfg = gitremote.set_remote(self.pid, f"file://{self.bare}", "main")
        st = gitremote.status(self.pid, cfg)
        self.assertEqual((st["branch"], st["ahead"], st["behind"]), ("main", None, None))  # nothing fetched yet
        out = asyncio.run(gitremote.push(self.pid, cfg))
        self.assertEqual((out["ahead"], out["behind"]), (0, 0))
        self.assertIn("first", subprocess.run(["git", "--git-dir", str(self.bare), "log", "--oneline"], capture_output=True, text=True).stdout)
        # the remote moves on: pull fast-forwards
        clone = self.tmp / "clone"
        subprocess.run(["git", "clone", "-q", str(self.bare), str(clone)], check=True)
        (clone / "other.txt").write_text("x")
        subprocess.run(["git", "-C", str(clone), "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(clone), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "upstream"], check=True)
        subprocess.run(["git", "-C", str(clone), "push", "-q", "origin", "main"], check=True)
        st = asyncio.run(gitremote.fetch(self.pid, cfg))
        self.assertEqual((st["ahead"], st["behind"]), (0, 1))
        out = asyncio.run(gitremote.pull(self.pid, cfg))
        self.assertTrue((P.root(self.pid) / "other.txt").exists())
        self.assertEqual((out["ahead"], out["behind"]), (0, 0))
        # diverged: no silent merge
        (P.root(self.pid) / "mine.txt").write_text("m")
        P.commit(self.pid, "mine")
        (clone / "theirs.txt").write_text("t")
        subprocess.run(["git", "-C", str(clone), "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(clone), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "theirs"], check=True)
        subprocess.run(["git", "-C", str(clone), "push", "-q", "origin", "main"], check=True)
        with self.assertRaises(RuntimeError) as cm:
            asyncio.run(gitremote.pull(self.pid, cfg))
        self.assertIn("1 commit(s) ahead and 1 behind", str(cm.exception))
        self.assertEqual(gitremote.outgoing(self.pid, cfg)[0].split(" ", 1)[1], "mine")
        # routes: admin only
        self.assertEqual(client.get(f"/api/projects/{self.pid}/git").status_code, 403)
        r = client.get(f"/api/projects/{self.pid}/git", headers=ADMIN)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["remote"]["ahead"], 1)
        self.assertEqual(client.post(f"/api/projects/{self.pid}/git/pull", headers=ADMIN).status_code, 409)
        self.assertTrue(gitremote.clear_remote(self.pid))
        self.assertEqual(client.get(f"/api/projects/{self.pid}/git", headers=ADMIN).json(), {"remote": None})

    def test_tool_refuses_push_without_a_chat_and_credential_flows_through_askpass(self):
        cfg = gitremote.set_remote(self.pid, f"file://{self.bare}", "main")

        class Ctx:
            project_id = self.pid
            conv_id = "conv-test"
        out = asyncio.run(gitremote.run({"action": "push"}, Ctx()))
        self.assertTrue(out.error)
        self.assertIn("approval", out.text)
        out = asyncio.run(gitremote.run({"action": "status"}, Ctx()))
        self.assertIn('"branch": "main"', out.text)
        with mock.patch.object(gitremote, "_credential", return_value=("x-access-token", "sekret")):
            r = gitremote._run(self.pid, cfg, "config", "--get", "credential.helper")
            self.assertEqual(r.stdout.strip(), "")  # helpers off
            self.assertEqual(gitremote._redact("token sekret here", cfg), "token *** here")
            self.assertTrue(gitremote.ASKPASS.exists())
            self.assertIn("SHELLB_GIT_PASS", gitremote.ASKPASS.read_text())


if __name__ == "__main__":
    unittest.main()
