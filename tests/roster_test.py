"""Tools shipped after an owner customised the roster still reach their agents (roster.grant_tools), once."""
import unittest

from smoke_test import client, shellb  # noqa: F401

import db
import defaults
import roster


class Grants(unittest.TestCase):
    def test_defaults_carry_the_once_orphaned_tools(self):
        by_id = {a["id"]: a for a in defaults.DEFAULT_AGENTS}
        for t in ("leave_message", "check_messages", "find_capability", "self_findings"):
            self.assertIn(t, by_id["shellb"]["tools"])
        self.assertIn("find_capability", by_id["claude"]["tools"])
        for a in defaults.DEFAULT_AGENTS:
            if "recall_conversations" in a["tools"]:
                self.assertIn("leave_message", a["tools"], a["id"])

    def test_grant_is_additive_and_idempotent(self):
        saved, flag = db.kv_get("agents"), "test_grant_flag"
        try:
            db.kv_set("agents", [{"id": "shellb", "tools": ["web_search"]}, {"id": "spark", "tools": ["web_search"]}])
            db.kv_set(flag, None)
            roster.grant_tools(flag, {"shellb": ["find_capability", "web_search"]})
            agents = {a["id"]: a for a in db.kv_get("agents")}
            self.assertEqual(agents["shellb"]["tools"], ["web_search", "find_capability"])
            self.assertEqual(agents["spark"]["tools"], ["web_search"])
            roster.grant_tools(flag, {"shellb": ["schedule_task"]})  # flag set: nothing more happens
            self.assertNotIn("schedule_task", {a["id"]: a for a in db.kv_get("agents")}["shellb"]["tools"])
        finally:
            db.kv_set("agents", saved)
            db.kv_set(flag, None)


if __name__ == "__main__":
    unittest.main()
