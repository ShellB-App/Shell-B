"""The cloud reviewer's view of Shell:B: committed source only, and a ledger that doesn't repeat itself."""
import asyncio
import types
import unittest

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import selfreview

CTX = types.SimpleNamespace(message_id="m-test", agent={"id": "claude"}, conv_id=None, project_id=None)


def run(args):
    return asyncio.run(selfreview.shellb_source(args, CTX))


class SourceOnly(unittest.TestCase):
    """Run against the real repository (the scratch copy isn't a git checkout)."""

    def setUp(self):
        import selfmod
        from smoke_test import WEB
        self._live = (selfreview.LIVE, selfmod.LIVE)
        selfreview.LIVE = selfmod.LIVE = WEB

    def tearDown(self):
        import selfmod
        selfreview.LIVE, selfmod.LIVE = self._live

    def test_private_paths_refused(self):
        for path in ("data/admin.key", "data", "../.ssh/id_ed25519", "data/shellb.db", "/etc/passwd"):
            with self.subTest(path=path):
                self.assertTrue(run({"action": "source", "path": path}).error)

    def test_reads_committed_source(self):
        r = run({"action": "source", "path": "server/ids.py", "limit": 5})
        self.assertFalse(r.error, r.text)
        self.assertIn("server/ids.py", r.text)
        self.assertIn("ids.py", run({"action": "source", "path": "server"}).text)

    def test_search_is_committed_files_only(self):
        r = run({"action": "source", "query": "def valid", "path": "server"})
        self.assertIn("server/ids.py", r.text)


class Ledger(unittest.TestCase):
    def test_same_finding_twice_is_one_row(self):
        a = selfreview.upsert("Example leak in foo", "low", "server/foo.py:10", "first")
        b = selfreview.upsert("Example leak in foo", "high", "server/foo.py:99", "second")
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(b["severity"], "high")
        selfreview.mark(a["id"], "fixed", "done")
        again = selfreview.upsert("Example leak in foo", "high", "server/foo.py:1")
        self.assertEqual(again["status"], "open")  # seen again after "fixed": re-opened

    def test_api_lists(self):
        self.assertEqual(client.get("/api/findings").status_code, 200)


if __name__ == "__main__":
    unittest.main()
