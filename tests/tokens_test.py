import unittest

from smoke_test import client, shellb  # noqa: F401  shared scratch copy

import db
import tokens


class TokenCounterTest(unittest.TestCase):
    def test_counts_owner_and_global(self):
        tokens.init()
        before_user, before_all = tokens.total("")["total"], tokens.total()["total"]
        tokens.record("", {"prompt": 100, "completion": 20})
        tokens.record("guest-0123456789ab", {"prompt": 5, "completion": 5})
        tokens.record("", {"prompt": 0, "completion": 0})  # nothing to count, no row bump
        self.assertEqual(tokens.total("")["total"] - before_user, 120)
        self.assertEqual(tokens.total()["total"] - before_all, 130)
        s = tokens.stats("")
        self.assertGreaterEqual(s["userToday"], 120)
        self.assertGreaterEqual(s["globalToday"], 130)

    def test_backfill_runs_once(self):
        tokens.init()
        self.assertTrue(db.kv_get("token_usage_backfilled"))

    def test_me_stats_carry_tokens(self):
        r = client.get("/api/me")
        self.assertEqual(r.status_code, 200)
        self.assertIn("global", r.json()["stats"]["tokens"])


if __name__ == "__main__":
    unittest.main()
