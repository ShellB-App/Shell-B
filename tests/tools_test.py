"""/api/tools tells the UI which tools are picked per agent and which Shell:B adds by its own rules, and why."""
import unittest

from smoke_test import client, shellb  # noqa: F401


class Scopes(unittest.TestCase):
    def test_auto_tools_say_when_they_are_added(self):
        tools = client.get("/api/tools").json()
        scopes = {t["scope"] for t in tools}
        self.assertNotIn(None, scopes)
        for t in tools:
            if t["scope"] in ("global", "group"):
                self.assertTrue(t.get("auto"), f"{t['id']} is added automatically but doesn't say when")
            elif t["scope"] == "agent":
                self.assertFalse(t.get("auto"), f"{t['id']} is listed per agent yet claims an auto rule")
        self.assertIn("agent", scopes)
        self.assertIn("global", scopes)


if __name__ == "__main__":
    unittest.main()
