"""The first-visit welcome and the What's new card (server/onboarding.py): who gets the welcome, news shown once, and
the welcome counting as having seen today's news."""
import unittest
from pathlib import Path

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import changelog
import db

changelog.FILE = Path(__file__).resolve().parent.parent / "docs" / "changelog.json"  # the scratch copy has no docs/


def _forget():
    with db.conn() as c:
        c.execute("DELETE FROM kv WHERE key='onboarding'")


def _has_chats():
    with db.conn() as c:
        return c.execute("SELECT 1 FROM conversations LIMIT 1").fetchone() is not None


class Onboarding(unittest.TestCase):
    def tearDown(self):
        _forget()

    def test_first_run_depends_on_existing_chats(self):
        _forget()
        r = client.get("/api/onboarding").json()
        if _has_chats():  # used before this shipped: no welcome, the latest news instead
            self.assertFalse(r["welcome"])
            self.assertTrue(r["news"])
        else:  # a new person: the welcome, and nothing as "new"
            self.assertTrue(r["welcome"])
            self.assertEqual(r["news"], [])

    def test_news_shows_once(self):
        db.kv_set("onboarding", {"welcomed": True, "seen": []})
        news = client.get("/api/onboarding").json()["news"]
        self.assertTrue(0 < len(news) <= 3)
        self.assertTrue(all(n["news"] for n in news))
        client.post("/api/onboarding/seen", json={"what": "news"})
        self.assertEqual(client.get("/api/onboarding").json()["news"], [])

    def test_welcome_done_hides_it_and_current_news(self):
        db.kv_set("onboarding", {"welcomed": False, "seen": []})
        self.assertTrue(client.get("/api/onboarding").json()["welcome"])
        client.post("/api/onboarding/seen", json={"what": "welcome"})
        self.assertEqual(client.get("/api/onboarding").json(), {"welcome": False, "news": []})


if __name__ == "__main__":
    unittest.main()
