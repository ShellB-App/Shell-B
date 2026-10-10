"""Passkeys (server/auth.py /api/auth/passkeys/*): options come only from an owner session with the password, the login
ceremony is offered only where a passkey exists, and a forged answer never opens a session."""
import time
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401

import auth
import db


def _remote():
    return TestClient(shellb.app, client=("10.9.8.7", 51000), raise_server_exceptions=False, base_url="https://spark.test")


class Passkeys(unittest.TestCase):
    def setUp(self):
        self.pw = db.kv_get("auth_password")
        auth.set_password("correct horse battery")
        with db.conn() as c:
            c.execute("DELETE FROM auth_passkeys")

    def tearDown(self):
        db.kv_set("auth_password", self.pw)
        with db.conn() as c:
            c.execute("DELETE FROM auth_passkeys")

    def test_registration_needs_session_and_password(self):
        self.assertEqual(client.post("/api/auth/passkeys/register/begin", json={"password": "correct horse battery"}).status_code, 401)  # localhost isn't the owner
        c = _remote()
        c.post("/api/auth/login", json={"password": "correct horse battery"})
        self.assertEqual(c.post("/api/auth/passkeys/register/begin", json={"password": "nope"}).status_code, 403)
        r = c.post("/api/auth/passkeys/register/begin", json={"password": "correct horse battery"})
        self.assertEqual(r.status_code, 200, r.text)
        o = r.json()["options"]
        self.assertEqual(o["rp"]["id"], "spark.test")
        self.assertEqual(o["user"]["name"], "owner")
        self.assertTrue(r.json()["challengeId"])
        # a bad answer is refused and the challenge is spent
        bad = c.post("/api/auth/passkeys/register/finish", json={"challengeId": r.json()["challengeId"], "credential": {"id": "x", "rawId": "eA", "response": {}, "type": "public-key"}})
        self.assertEqual(bad.status_code, 400)
        again = c.post("/api/auth/passkeys/register/finish", json={"challengeId": r.json()["challengeId"], "credential": {}})
        self.assertEqual(again.status_code, 400)
        self.assertIn("expired", again.json()["detail"])
        self.assertEqual(c.get("/api/auth/passkeys").json()["passkeys"], [])

    def test_login_offered_only_where_a_passkey_exists(self):
        c = _remote()
        self.assertEqual(c.get("/api/auth/passkeys/available").json(), {"available": False})
        self.assertEqual(c.post("/api/auth/passkeys/login/begin", json={}).status_code, 404)
        with db.conn() as conn:
            conn.execute("INSERT INTO auth_passkeys VALUES(?,?,?,?,?,?,?,NULL)", ("ab" * 16, b"\x00" * 10, 0, "[]", "Test key", "spark.test", time.time()))
            conn.execute("INSERT INTO auth_passkeys VALUES(?,?,?,?,?,?,?,NULL)", ("cd" * 16, b"\x00" * 10, 0, "[]", "Other host", "other.test", time.time()))
        self.assertEqual(c.get("/api/auth/passkeys/available").json(), {"available": True})
        r = c.post("/api/auth/passkeys/login/begin", json={})
        self.assertEqual(r.status_code, 200, r.text)
        ids = [x["id"] for x in r.json()["options"]["allowCredentials"]]
        self.assertEqual(len(ids), 1)  # only this host's key is offered
        bad = c.post("/api/auth/passkeys/login/finish", json={"challengeId": r.json()["challengeId"], "credential": {"id": "q6urq6urq6urq6urq6urqw", "rawId": "q6urq6urq6urq6urq6urqw", "response": {}, "type": "public-key"}})
        self.assertEqual(bad.status_code, 401)
        self.assertNotIn("shellb_session", bad.cookies)
        self.assertEqual(c.get("/api/conversations").status_code, 401)


if __name__ == "__main__":
    unittest.main()
