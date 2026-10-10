"""Owner two-step verification (server/auth.py + otp.py): the password alone no longer opens the app once it is on."""
import time
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401

import auth
import db
import otp


def _remote():
    """A client that isn't localhost, so the login wall applies (TestClient's default is the trusted 127.0.0.1)."""
    return TestClient(shellb.app, client=("10.9.8.7", 51000), raise_server_exceptions=False)


class Otp(unittest.TestCase):
    def test_codes_match_the_rfc_and_never_replay(self):
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # "12345678901234567890"
        self.assertEqual(otp.totp(secret, 1), "287082")  # RFC 6238 vector for T=59 s
        step = otp.step_for(secret, "287082", 0, now=59)
        self.assertEqual(step, 1)
        self.assertIsNone(otp.step_for(secret, "287082", 1, now=59))  # used
        self.assertIsNone(otp.step_for(secret, "28 70 82x", 0, now=59))


class Login(unittest.TestCase):
    def setUp(self):
        self.pw, self.fa = db.kv_get("auth_password"), db.kv_get("auth_2fa")
        auth.set_password("correct horse battery")
        self.secret = otp.new_secret()
        codes = otp.new_recovery_codes()
        self.recovery = codes[0]
        db.kv_set("auth_2fa", {"secret": self.secret, "last": 0, "recovery": [otp.sha(c) for c in codes], "set": time.time()})
        auth._tickets.clear()

    def tearDown(self):
        db.kv_set("auth_password", self.pw)
        db.kv_set("auth_2fa", self.fa)

    def test_password_alone_gives_a_ticket_not_a_session(self):
        c = _remote()
        r = c.post("/api/auth/login", json={"password": "correct horse battery"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["needsCode"])
        self.assertFalse(r.json()["authenticated"])
        self.assertNotIn("shellb_session", r.cookies)
        self.assertEqual(c.get("/api/conversations").status_code, 401)
        # wrong code: refused, ticket still valid; right code: a session
        bad = c.post("/api/auth/login/code", json={"pending": r.json()["pending"], "code": "000000"})
        self.assertEqual(bad.status_code, 401)
        code = otp.totp(self.secret, int(time.time() // otp.STEP))
        ok = c.post("/api/auth/login/code", json={"pending": r.json()["pending"], "code": code})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(ok.json()["authenticated"])
        self.assertEqual(c.get("/api/conversations").status_code, 200)
        # the same code can't be used for a second login
        r2 = c.post("/api/auth/login", json={"password": "correct horse battery"}).json()
        again = c.post("/api/auth/login/code", json={"pending": r2["pending"], "code": code})
        self.assertEqual(again.status_code, 401)

    def test_recovery_code_works_once(self):
        c = _remote()
        t = c.post("/api/auth/login", json={"password": "correct horse battery"}).json()["pending"]
        self.assertEqual(c.post("/api/auth/login/code", json={"pending": t, "code": otp.pretty(self.recovery)}).status_code, 200)
        self.assertEqual(len(db.kv_get("auth_2fa")["recovery"]), otp.RECOVERY_COUNT - 1)
        c2 = _remote()
        t = c2.post("/api/auth/login", json={"password": "correct horse battery"}).json()["pending"]
        self.assertEqual(c2.post("/api/auth/login/code", json={"pending": t, "code": self.recovery}).status_code, 401)

    def test_ticket_is_bound_to_the_address_and_expires(self):
        a, b = _remote(), TestClient(shellb.app, client=("10.9.8.6", 51001), raise_server_exceptions=False)
        t = a.post("/api/auth/login", json={"password": "correct horse battery"}).json()["pending"]
        code = otp.totp(self.secret, int(time.time() // otp.STEP))
        self.assertEqual(b.post("/api/auth/login/code", json={"pending": t, "code": code}).status_code, 401)
        auth._tickets[t] = (time.time() - auth.TICKET_TTL - 1, "10.9.8.7")
        self.assertEqual(a.post("/api/auth/login/code", json={"pending": t, "code": code}).status_code, 401)

    def test_setup_and_disable_need_an_owner_session_and_the_password(self):
        self.assertEqual(client.get("/api/auth/2fa").status_code, 401)  # localhost is trusted but isn't the owner
        db.kv_set("auth_2fa", None)
        c = _remote()
        self.assertTrue(c.post("/api/auth/login", json={"password": "correct horse battery"}).json()["authenticated"])
        self.assertEqual(c.post("/api/auth/2fa/begin", json={"password": "wrong"}).status_code, 403)
        begin = c.post("/api/auth/2fa/begin", json={"password": "correct horse battery"}).json()
        self.assertIn("otpauth://totp/", begin["uri"])
        self.assertEqual(c.post("/api/auth/2fa/confirm", json={"code": "000000"}).status_code, 400)
        self.assertFalse(auth.two_step_on())
        code = otp.totp(begin["secret"], int(time.time() // otp.STEP))
        done = c.post("/api/auth/2fa/confirm", json={"code": code}).json()
        self.assertTrue(done["on"] and len(done["recovery"]) == otp.RECOVERY_COUNT)
        self.assertTrue(auth.two_step_on())
        self.assertEqual(c.get("/api/auth/2fa").json()["recoveryLeft"], otp.RECOVERY_COUNT)
        self.assertEqual(c.post("/api/auth/2fa/disable", json={"password": "correct horse battery"}).json()["on"], False)
        self.assertFalse(auth.two_step_on())


if __name__ == "__main__":
    unittest.main()
