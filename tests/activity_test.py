"""Activity sources stay in step: what the server posts, what notify.py can push, what the UI can filter."""
import re
import unittest

from smoke_test import client, shellb, WEB  # noqa: F401

import activity
import notify


class Sources(unittest.TestCase):
    def test_every_posted_source_is_filterable(self):
        activity.post("shopping", "done", "Price watch test", ref="test-shopping-1")
        activity.post("guest", "warning", "Guest report test", ref="test-guest-1")
        rows = client.get("/api/activity?source=shopping").json()["items"]
        self.assertTrue(rows and all(r["source"] == "shopping" for r in rows))
        rows = client.get("/api/activity?source=guest").json()["items"]
        self.assertTrue(rows and all(r["source"] == "guest" for r in rows))

    def test_notify_knows_every_source(self):
        missing = set(activity.SOURCES) - notify.KIND_IDS
        self.assertFalse(missing, f"notify.KINDS drops events from: {sorted(missing)}")

    def test_ui_union_matches_server(self):
        ts = (WEB / "ui" / "src" / "types.ts").read_text()
        m = re.search(r"export type ActivitySource = ([^;]+);", ts)
        self.assertIsNotNone(m)
        ui = set(re.findall(r"'([a-z]+)'", m.group(1)))
        self.assertEqual(ui, set(activity.SOURCES))
        tsx = (WEB / "ui" / "src" / "components" / "Activity.tsx").read_text()
        for s in activity.SOURCES:
            self.assertRegex(tsx, rf"\n  {s}: \{{ label:", f"Activity.tsx has no chip for {s}")


if __name__ == "__main__":
    unittest.main()
