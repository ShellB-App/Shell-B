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

    def test_detail_ledger_and_report(self):
        tokens.init()
        tokens.record("", {"prompt": 300, "completion": 60}, "shellb", "ShellB-Swift")
        tokens.record("guest-0123456789ab", {"prompt": 40, "completion": 10}, "spark", "ShellB-Swift")
        tokens.record("api", {"prompt": 70, "completion": 30}, "claude", "claude-code/opus")
        r = tokens.report(7)
        self.assertEqual(len(r["series"]), 7)
        today = r["series"][-1]
        self.assertGreaterEqual(today["owner"], 360)
        self.assertGreaterEqual(today["guests"], 50)
        self.assertGreaterEqual(today["api"], 100)
        by_agent = {a["name"]: a for a in r["agents"]}
        self.assertGreaterEqual(by_agent["shellb"]["prompt"], 300)
        self.assertIn("claude-code/opus", {m["name"] for m in r["models"]})
        self.assertIsNone(r["cost"])  # no prices set
        saved = db.kv_get("settings") or {}
        try:
            db.kv_set("settings", {**saved, "modelCosts": {"claude-code/opus": {"in": 15, "out": 75}}})
            priced = tokens.report(7)
            self.assertIsNotNone(priced["cost"])
            self.assertGreaterEqual(priced["cost"], 70 / 1e6 * 15 + 30 / 1e6 * 75 - 1e-9)
        finally:
            db.kv_set("settings", saved)
        res = client.get("/api/usage?days=7")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["days"], 7)

    def test_me_stats_carry_tokens(self):
        r = client.get("/api/me")
        self.assertEqual(r.status_code, 200)
        self.assertIn("global", r.json()["stats"]["tokens"])


if __name__ == "__main__":
    unittest.main()
