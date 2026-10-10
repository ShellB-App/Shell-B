"""Share links (server/shares.py): a public token opens one snapshot; everything else answers 404; owner-only management."""
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401

import db
import shares

lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


class Shares(unittest.TestCase):
    def setUp(self):
        self.conv = db.create_conversation("shellb", title="Trip notes")
        db.add_message(self.conv["id"], "user", "Plan a trip")
        db.add_message(self.conv["id"], "assistant", "Here is a **plan**", {"agentId": "shellb"})
        db.save_artifact(self.conv["id"], "art1", "Itinerary", "markdown", None, "# Day 1", None)

    def tearDown(self):
        db.delete_conversation(self.conv["id"])

    def test_snapshot_is_public_and_frozen(self):
        self.assertEqual(client.post("/api/shares", json={"kind": "chat", "conversation": self.conv["id"]}).status_code, 401)  # localhost isn't the owner
        r = client.post("/api/shares", json={"kind": "chat", "conversation": self.conv["id"]}, headers=ADMIN)
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()
        self.assertEqual(len(s["token"]), 32)
        pub = lan.get(f"/api/share/{s['token']}")  # no login, not localhost
        self.assertEqual(pub.status_code, 200)
        snap = pub.json()
        self.assertEqual(snap["title"], "Trip notes")
        self.assertEqual([m["content"] for m in snap["messages"]], ["Plan a trip", "Here is a **plan**"])
        self.assertEqual(snap["artifacts"][0]["content"], "# Day 1")
        db.add_message(self.conv["id"], "user", "Secret follow-up")
        self.assertEqual(len(lan.get(f"/api/share/{s['token']}").json()["messages"]), 2)  # frozen
        self.assertEqual(shares.get(s["token"])["views"], 2)
        # revoke: gone for the world, listed as revoked for the owner
        self.assertEqual(client.delete(f"/api/shares/{s['token']}", headers=ADMIN).status_code, 200)
        self.assertEqual(lan.get(f"/api/share/{s['token']}").status_code, 404)
        self.assertEqual(lan.get("/api/share/" + "0" * 32).status_code, 404)
        self.assertEqual(lan.get("/api/share/not-a-token").status_code, 401)  # not even a token shape: the login wall
        self.assertTrue(any(x["token"] == s["token"] and x["revoked"] for x in client.get("/api/shares", headers=ADMIN).json()["shares"]))

    def test_artifact_share_and_refusals(self):
        r = client.post("/api/shares", json={"kind": "artifact", "conversation": self.conv["id"], "artifact": "art1"}, headers=ADMIN)
        self.assertEqual(r.status_code, 200, r.text)
        snap = lan.get(f"/api/share/{r.json()['token']}").json()
        self.assertEqual((snap["kind"], snap["artifact"]["type"], snap["artifact"]["content"]), ("artifact", "markdown", "# Day 1"))
        self.assertEqual(client.post("/api/shares", json={"kind": "artifact", "conversation": self.conv["id"], "artifact": "nope"}, headers=ADMIN).status_code, 404)
        import privacy
        privacy.mark_incognito(self.conv["id"])
        self.assertEqual(client.post("/api/shares", json={"kind": "chat", "conversation": self.conv["id"]}, headers=ADMIN).status_code, 400)
        shares.revoke(r.json()["token"])

    def test_link_uses_the_share_host(self):
        saved = db.kv_get("settings") or {}
        try:
            db.kv_set("settings", {**saved, "shareHost": "share.example.org"})
            self.assertEqual(shares.link("a" * 32), "https://share.example.org/#/s/" + "a" * 32)
            db.kv_set("settings", {**saved, "shareHost": ""})
            self.assertEqual(shares.link("a" * 32), "#/s/" + "a" * 32)
        finally:
            db.kv_set("settings", saved)


if __name__ == "__main__":
    unittest.main()
