"""Regression tests for the self-review findings fixed on 2026-10-10 (table `findings`)."""
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from smoke_test import client, shellb, WEB  # noqa: F401

import adult
import community
import selfmod


class SelfmodBranch(unittest.TestCase):
    def test_sync_and_diff_follow_the_live_branch(self):
        live = subprocess.run(["git", "-C", str(WEB), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
        if live and live != "HEAD":
            with mock.patch.object(selfmod, "LIVE", WEB):  # the scratch copy the tests run from isn't a git repo
                self.assertEqual(selfmod.live_branch(), live)
        self.assertEqual(selfmod.live_branch(), "main")  # no repo: the old default
        src = Path(selfmod.__file__).read_text()
        self.assertNotIn('str(LIVE), "main")', src, "a fetch still hard-codes main")


class AdultAttachments(unittest.IsolatedAsyncioTestCase):
    async def test_pictures_are_refused_and_text_is_screened(self):
        self.assertTrue(await adult.screen_attachments([{"kind": "image", "name": "a.png"}], {}))
        with mock.patch("adult.screen", mock.AsyncMock(return_value="Limit: nope")):
            why = await adult.screen_attachments([{"kind": "file", "name": "story.txt", "inline": "some text"}], {})
            self.assertIn("story.txt", why)
        with mock.patch("adult.screen", mock.AsyncMock(return_value="")):
            self.assertEqual(await adult.screen_attachments([{"kind": "file", "name": "ok.txt", "inline": "fine"}], {}), "")
        self.assertEqual(await adult.screen_attachments([], {}), "")


class CommunityIsolation(unittest.TestCase):
    def test_each_server_gets_its_own_cache_volume(self):
        npm = community._docker_cmd("srv1", {"kind": "npm", "identifier": "@x/y", "fields": []})
        uv = community._docker_cmd("srv2", {"kind": "pypi", "identifier": "pkg", "fields": []})
        self.assertIn("shellb-mcp-npm-srv1:/root/.npm", npm)
        self.assertIn("shellb-mcp-uv-srv2:/root/.cache/uv", uv)
        self.assertNotIn("shellb-mcp-npm:/root/.npm", npm)

    def test_plugin_path_cannot_leave_the_repo(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            (root / "skills" / "one").mkdir(parents=True)
            (root / "skills" / "one" / "SKILL.md").write_text("---\nname: one\ndescription: d\n---\n")
            outside = Path(d) / "outside" / "evil"
            outside.mkdir(parents=True)
            (outside / "SKILL.md").write_text("---\nname: evil\ndescription: d\n---\n")
            self.assertEqual(community._skill_items("s", "o/r", "0" * 40, root, "../outside"), [])
            self.assertTrue(community._skill_items("s", "o/r", "0" * 40, root, "skills"))


class ModelStoreNoClobber(unittest.IsolatedAsyncioTestCase):
    async def test_existing_model_file_is_not_overwritten(self):
        import modelstore
        from fastapi import HTTPException
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d) / "checkpoints"
            folder.mkdir()
            (folder / "model.safetensors").write_bytes(b"x")
            with mock.patch.object(modelstore, "COMFY_MODELS", Path(d)):
                with self.assertRaises(HTTPException) as cm:
                    await modelstore.start_file("owner/repo", "model.safetensors", "checkpoints")
                self.assertEqual(cm.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
