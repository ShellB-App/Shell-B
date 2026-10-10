"""Shell:B Guest accounts (server/guest_accounts.py): sign-up by invite only, passwords, lockouts, two-step codes,
reset links, device codes, and that nothing about accounts reaches the owner's port or leaks a secret."""
import re
import secrets
import time
import unittest

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import auth
import db
import guest_accounts as ga
import guest_app
import guests
import notify

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}
PASSWORD = "copper kettle on the hill"
owner = TestClient(shellb.app, client=("127.0.0.1", 50000), raise_server_exceptions=False)
lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
(shellb.UI_DIST / "guest.html").write_text("<!doctype html><title>guest</title>")


def gclient(ip: str | None = None) -> TestClient:
    """A browser on the guest port through the tunnel; `ip` is the forwarded client address."""
    c = TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40000),
                   raise_server_exceptions=False)
    if ip:
        c.headers["x-forwarded-for"] = ip
    return c


def account(name="Robin", username=None, password=PASSWORD) -> tuple[dict, TestClient, str]:
    g, code = guests.create_guest(name, {"cell": False})  # on the guest app: no container to proxy to in tests
    username = username or f"r{secrets.token_hex(5)}"
    c = gclient()
    r = c.post("/api/guest/signup", json={"code": code, "username": username, "password": password})
    assert r.status_code == 200, r.text
    return guests.get_guest(g["id"]), c, username


def login(username, password=PASSWORD, ip=None, **extra):
    c = gclient(ip)
    return c, c.post("/api/guest/login", json={"username": username, "password": password, **extra})


class Base(unittest.TestCase):
    def setUp(self):
        guests._codes_tried.clear()
        guest_app._hits.clear()
        ga._tickets.clear()
        self.pushes = []
        self._event = notify.event
        notify.event = lambda *a, **k: self.pushes.append(a)  # never push to the owner's real devices

    def tearDown(self):
        notify.event = self._event


class Passwords(unittest.TestCase):
    def test_weak_passwords_are_refused(self):
        for pw in ("short", "1234567890", "qwertyuiop", "aaaaaaaaaaaa", "1212121212", "password2024!", "P@ssw0rd123",
                   "p@ssw0rd12345", "Welcome12345", "shellb-2026", "abcdefghijkl"):
            with self.subTest(pw=pw):
                self.assertIsNotNone(ga.password_problem(pw))
        self.assertEqual(ga.password_problem("robin1234567", "robin"), "Don't build your password from your username.")

    def test_reasonable_passwords_pass(self):
        for pw in (PASSWORD, "Tr0ub4dor&3x", "monkeybusiness99", "8264019375", "samantha-loves-tea"):
            with self.subTest(pw=pw):
                self.assertIsNone(ga.password_problem(pw, "sam"))

    def test_totp_matches_rfc_6238(self):
        secret = __import__("base64").b32encode(b"12345678901234567890").decode()
        self.assertEqual(ga.totp(secret, 59 // 30), "287082")  # RFC 6238 appendix B, last 6 of 94287082
        self.assertEqual(ga.totp(secret, 1111111109 // 30), "081804")  # 07081804


class SignUp(Base):
    def test_invite_then_account_then_sign_in(self):
        g, code = guests.create_guest("Robin")
        c = gclient()
        self.assertEqual(c.post("/api/guest/code", json={"code": code}).json(), {"kind": "invite", "name": "Robin", "username": None})
        r = c.post("/api/guest/signup", json={"code": code, "username": "Robin.K", "password": PASSWORD, "email": "r@example.org"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("max-age", r.headers["set-cookie"].lower())  # remembered by default
        me = c.get("/api/guest/me").json()
        self.assertEqual((me["username"], me["deviceCodes"]), ("robin.k", True))
        c2, r2 = login("ROBIN.k")  # usernames are case-insensitive
        self.assertEqual(r2.status_code, 200, r2.text)
        self.assertEqual(c2.get("/api/guest/account").json()["email"], "r@example.org")
        self.assertEqual([e["event"] for e in ga.auth_log(g["id"])][:2], ["signin", "signin"])

    def test_bad_input_doesnt_spend_the_invite(self):
        g, code = guests.create_guest("Kit")
        c = gclient()
        for body, status in (({"username": "kit", "password": "kit1234567"}, 400),
                             ({"username": "x", "password": PASSWORD}, 400),
                             ({"username": "kit", "password": PASSWORD, "email": "not an email"}, 400)):
            with self.subTest(body=body):
                self.assertEqual(c.post("/api/guest/signup", json={"code": code, **body}).status_code, status)
        _, _, taken = account("Other")
        self.assertEqual(c.post("/api/guest/signup", json={"code": code, "username": taken.upper(), "password": PASSWORD}).status_code, 409)
        self.assertEqual(c.post("/api/guest/signup", json={"code": code, "username": "kit", "password": PASSWORD}).status_code, 200)

    def test_no_open_registration(self):
        c = gclient()
        for code in ("", "made-up-code", "a" * 24):
            self.assertEqual(c.post("/api/guest/signup", json={"code": code, "username": "eve", "password": PASSWORD}).status_code, 401)
        self.assertIsNone(ga._by_username("eve"))

    def test_existing_accounts_get_reset_links_not_invites(self):
        g, _, _ = account()
        self.assertEqual(owner.post(f"/api/guests/{g['id']}/invite", headers=ADMIN).status_code, 409)

    def test_remember_me_off(self):
        _, _, u = account()
        c, r = login(u, remember=False)
        self.assertNotIn("max-age", r.headers["set-cookie"].lower())  # a browser-session cookie
        with db.conn() as conn:  # 12 hours idle, then the password again
            conn.execute("UPDATE guest_sessions SET last_used=? WHERE id=?",
                         (time.time() - guests.IDLE_TTL - 60, guests._sha(c.cookies.get(guests.COOKIE))))
        self.assertEqual(c.get("/api/guest/me").status_code, 401)


class BruteForce(Base):
    def test_wrong_passwords_lock_the_account(self):
        g, c, u = account("Lee")
        for i in range(ga.LOCK_AFTER):  # spread over addresses, so only the account counter stops it
            self.assertEqual(login(u, "wrong password here", ip=f"203.0.113.{i + 1}")[1].status_code, 401)
        _, r = login(u, ip="198.51.100.7")
        self.assertEqual(r.status_code, 429)  # even with the right password
        self.assertIn("locked", r.json()["detail"])
        self.assertTrue(guests.get_guest(g["id"])["lockedUntil"])
        self.assertTrue(any(p[0] == "guest" and p[1] == "warning" for p in self.pushes))
        with db.conn() as conn:
            self.assertTrue(conn.execute("SELECT 1 FROM activity WHERE source='guest' AND title LIKE ?", ("%Lee%locked%",)).fetchone())
        self.assertIn("locked", [e["event"] for e in ga.auth_log(g["id"])])
        self.assertEqual(lan.post(f"/api/guests/{g['id']}/unlock").status_code, 401)
        self.assertEqual(owner.post(f"/api/guests/{g['id']}/unlock", headers=ADMIN).status_code, 200)
        self.assertEqual(login(u, ip="198.51.100.7")[1].status_code, 200)
        self.assertNotIn("127.0.0.1", auth._IP_FAILS)  # the owner's lockout counters are untouched

    def test_one_address_is_throttled(self):
        _, _, u = account()
        for _ in range(10):
            login("nobody-here", "wrong password here", ip="192.0.2.50")
        self.assertEqual(login(u, ip="192.0.2.50")[1].status_code, 429)
        self.assertEqual(login(u, ip="192.0.2.51")[1].status_code, 200)

    def test_unknown_and_wrong_look_the_same(self):
        _, _, u = account()
        a = login("no-such-user", "wrong password here", ip="192.0.2.60")[1]
        b = login(u, "wrong password here", ip="192.0.2.61")[1]
        self.assertEqual((a.status_code, a.json()), (b.status_code, b.json()))


class TwoStep(Base):
    def enable(self, c) -> tuple[str, list[str]]:
        self.assertEqual(c.post("/api/guest/account/two-step/setup", json={"password": "wrong password here"}).status_code, 403)
        setup = c.post("/api/guest/account/two-step/setup", json={"password": PASSWORD}).json()
        self.assertTrue(setup["uri"].startswith("otpauth://totp/Shell%3AB%20Guest%3A"))
        self.assertEqual(c.post("/api/guest/account/two-step", json={"code": "000000"}).status_code, 400)
        now = int(time.time() // ga.TOTP_STEP)
        r = c.post("/api/guest/account/two-step", json={"code": ga.totp(setup["secret"], now)})
        self.assertEqual(r.status_code, 200, r.text)
        return setup["secret"], r.json()["recoveryCodes"]

    def test_code_after_password(self):
        g, c, u = account()
        secret, codes = self.enable(c)
        self.assertEqual(len(codes), 10)
        other, r = login(u)
        ticket = r.json()["ticket"]
        self.assertNotIn(guests.COOKIE, other.cookies)  # the password alone signs nothing in
        self.assertEqual(other.get("/api/guest/me").status_code, 401)
        nxt = ga.totp(secret, int(time.time() // ga.TOTP_STEP) + 1)
        self.assertEqual(other.post("/api/guest/login/two-step", json={"ticket": ticket, "code": "123456"}).status_code, 401)
        self.assertEqual(other.post("/api/guest/login/two-step", json={"ticket": ticket, "code": nxt}).status_code, 200)
        self.assertEqual(other.get("/api/guest/me").status_code, 200)
        third, r = login(u)  # the same code twice: refused
        self.assertEqual(third.post("/api/guest/login/two-step", json={"ticket": r.json()["ticket"], "code": nxt}).status_code, 401)

    def test_recovery_code_works_once(self):
        g, c, u = account()
        _, codes = self.enable(c)
        _, r = login(u)
        ok = gclient().post("/api/guest/login/two-step", json={"ticket": r.json()["ticket"], "code": codes[0].upper()})
        self.assertEqual(ok.status_code, 200)
        _, r = login(u)
        self.assertEqual(gclient().post("/api/guest/login/two-step", json={"ticket": r.json()["ticket"], "code": codes[0]}).status_code, 401)
        self.assertEqual(c.get("/api/guest/account").json()["recoveryLeft"], 9)
        self.assertIn("recovery_used", [e["event"] for e in ga.auth_log(g["id"])])

    def test_tickets_wear_out(self):
        _, c, u = account()
        self.enable(c)
        _, r = login(u)
        t = r.json()["ticket"]
        for _ in range(ga.TICKET_TRIES):
            gclient().post("/api/guest/login/two-step", json={"ticket": t, "code": "000000"})
        self.assertNotIn(t, ga._tickets)

    def test_turning_it_off(self):
        g, c, u = account()
        self.enable(c)
        self.assertEqual(c.post("/api/guest/account/two-step/off", json={"password": "wrong password here"}).status_code, 403)
        self.assertEqual(c.post("/api/guest/account/two-step/off", json={"password": PASSWORD}).status_code, 200)
        self.assertEqual(login(u)[1].json().get("ok"), True)
        self.enable(c)
        self.assertEqual(lan.post(f"/api/guests/{g['id']}/two-step/off").status_code, 401)
        self.assertEqual(owner.post(f"/api/guests/{g['id']}/two-step/off", headers=ADMIN).json()["twoStep"], False)
        self.assertEqual(login(u)[1].json().get("ok"), True)


class Resets(Base):
    def test_reset_link_works_once_and_signs_out_everywhere(self):
        g, c, u = account()
        self.assertEqual(lan.post(f"/api/guests/{g['id']}/reset").status_code, 401)
        link = owner.post(f"/api/guests/{g['id']}/reset", headers=ADMIN).json()["link"]
        code = re.search(r"#reset=([\w-]+)", link).group(1)
        self.assertEqual(c.get("/api/guest/me").status_code, 401)  # every device signed out
        d = gclient()
        self.assertEqual(d.post("/api/guest/code", json={"code": code}).json()["kind"], "reset")
        self.assertEqual(d.post("/api/guest/reset", json={"code": code, "password": "short"}).status_code, 400)  # not spent
        self.assertEqual(d.post("/api/guest/reset", json={"code": code, "password": "a brand new phrase"}).status_code, 200)
        self.assertEqual(d.get("/api/guest/me").status_code, 200)
        self.assertEqual(gclient().post("/api/guest/reset", json={"code": code, "password": "another new phrase"}).status_code, 401)
        self.assertEqual(login(u)[1].status_code, 401)
        self.assertEqual(login(u, "a brand new phrase")[1].status_code, 200)

    def test_reset_unlocks(self):
        g, _, u = account()
        with db.conn() as conn:
            conn.execute("UPDATE guests SET locked_until=? WHERE id=?", (time.time() + 600, g["id"]))
        code = re.search(r"#reset=([\w-]+)", ga.reset_link(g["id"])).group(1)
        self.assertEqual(gclient().post("/api/guest/reset", json={"code": code, "password": "a brand new phrase"}).status_code, 200)

    def test_no_reset_before_an_account(self):
        g, _ = guests.create_guest("Pending", {"cell": False})
        self.assertEqual(owner.post(f"/api/guests/{g['id']}/reset", headers=ADMIN).status_code, 409)


class Devices(Base):
    def test_device_codes_need_a_password_session(self):
        g, c, _ = account()
        code = c.post("/api/guest/device-code").json()["code"]
        phone = gclient()
        self.assertEqual(phone.post("/api/guest/redeem", json={"code": code}).status_code, 200)
        self.assertEqual(phone.get("/api/guest/me").json()["deviceCodes"], False)
        self.assertEqual(phone.post("/api/guest/device-code").status_code, 403)  # no chains of device codes
        self.assertIn("device", [e["event"] for e in ga.auth_log(g["id"])])

    def test_password_change_keeps_only_this_device(self):
        _, c, u = account()
        other, _ = login(u)
        self.assertEqual(c.post("/api/guest/account/password", json={"current": "wrong password here", "password": "a brand new phrase"}).status_code, 403)
        self.assertEqual(c.post("/api/guest/account/password", json={"current": PASSWORD, "password": "abc"}).status_code, 400)
        self.assertEqual(c.post("/api/guest/account/password", json={"current": PASSWORD, "password": "a brand new phrase"}).status_code, 200)
        self.assertEqual(c.get("/api/guest/me").status_code, 200)
        self.assertEqual(other.get("/api/guest/me").status_code, 401)
        self.assertEqual(login(u, "a brand new phrase")[1].status_code, 200)


class InviteOnlyGuests(Base):
    """Guests who joined before accounts existed keep their device but must choose a username and password first."""
    def test_must_choose_a_password(self):
        g, _ = guests.create_guest("Early", {"cell": False})
        c = gclient()
        c.cookies.set(guests.COOKIE, guests.new_session(g["id"], _req(), via="invite"))
        me = c.get("/api/auth/me").json()
        self.assertEqual((me["authenticated"], me["needsAccount"], me["frameKey"]), (True, True, None))
        self.assertEqual(c.get("/api/conversations").status_code, 403)
        self.assertEqual(c.post("/api/guest/device-code").status_code, 403)
        r = c.post("/api/guest/account/create", json={"username": "early-bird", "password": PASSWORD})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.get("/api/conversations").status_code, 200)
        self.assertEqual(c.post("/api/guest/account/create", json={"username": "early-two", "password": PASSWORD}).status_code, 409)
        self.assertEqual(login("early-bird")[1].status_code, 200)


def _req():
    """Enough of a Request for guests.new_session."""
    class R:
        headers = {"user-agent": "test"}
        scope = {"client": ("127.0.0.1", 1), "headers": []}
    return R()


class Walls(Base):
    SECRETS = ("pw_hash", "pw_salt", "totp_secret", "totp_last")

    def test_accounts_dont_exist_on_the_owner_port(self):
        for path in ("/api/guest/login", "/api/guest/signup", "/api/guest/reset", "/api/guest/account/create",
                     "/api/guest/account/password", "/api/guest/code"):
            with self.subTest(path=path):
                self.assertIn(owner.post(path, json={}).status_code, (404, 405))  # no such route (405: the SPA's GET)
                self.assertEqual(lan.post(path, json={}).status_code, 401)

    def test_no_secret_leaves_the_server(self):
        g, c, _ = account()
        c.post("/api/guest/account/two-step/setup", json={"password": PASSWORD})
        row = ga._row(g["id"])
        bodies = [owner.get("/api/guests", headers=ADMIN).text, owner.get(f"/api/guests/{g['id']}/log", headers=ADMIN).text,
                  c.get("/api/guest/me").text, c.get("/api/guest/account").text, c.get("/api/auth/me").text]
        for body in bodies:
            for key in self.SECRETS:
                self.assertNotIn(key, body)
            self.assertNotIn(row["pw_hash"], body)
            self.assertNotIn(PASSWORD, body)

    def test_delete_wipes_account_rows(self):
        g, c, u = account()
        owner.delete(f"/api/guests/{g['id']}", headers=ADMIN)
        self.assertIsNone(ga._by_username(u))
        self.assertEqual(ga.auth_log(g["id"]), [])
        self.assertEqual(login(u)[1].status_code, 401)


if __name__ == "__main__":
    unittest.main()
