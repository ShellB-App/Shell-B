"""Email (server/mailer.py): Cloudflare sends, the hourly cap, notification email, guest emails and forgot-password,
and the agent tool's approval. Cloudflare is never contacted: httpx.post is replaced."""
import asyncio
import time
import types
import unittest

import httpx

from guest_accounts_test import ADMIN, Base, account, gclient, owner  # noqa: F401 — sets up the scratch copy

import db
import guest_accounts as ga
import mailer
import notify
import remote

ACCOUNT = "0123456789abcdef0123456789abcdef"


class Fake:
    """Stands in for httpx.post: records requests, answers from a script of (status, body) pairs."""
    def __init__(self, *script):
        self.script, self.calls = list(script), []

    def __call__(self, url, json=None, headers=None, **kw):
        self.calls.append({"url": url, "json": json, "headers": headers})
        status, body = self.script.pop(0) if self.script else (200, {"success": True, "result": {"delivered": json["to"]}})
        return httpx.Response(status, json=body, request=httpx.Request("POST", url))


class MailBase(Base):
    def setUp(self):
        super().setUp()
        mailer.init()
        db.kv_set("email", {"provider": "cloudflare", "accountId": ACCOUNT, "from": "notify@shellb.app", "to": "owner@example.com"})
        mailer.TOKEN.write_text("t" * 40)
        mailer._sent.clear()
        self.fake = Fake()
        self._post, self._sleep, self._later = httpx.post, time.sleep, mailer.send_later
        httpx.post, mailer.time.sleep = self.fake, (lambda s: None)
        mailer.send_later = lambda *a, **k: mailer.send(*a, **k)  # synchronous, so tests see the result

    def tearDown(self):
        httpx.post, mailer.time.sleep, mailer.send_later = self._post, self._sleep, self._later
        mailer.TOKEN.unlink(missing_ok=True)
        db.kv_set("email", {})
        db.kv_set("notify_prefs", {})
        super().tearDown()


class Sending(MailBase):
    def test_sends_through_cloudflare(self):
        res = mailer.send("test", "a@example.com", "Hi\r\nBcc: x@evil.com", "body")
        self.assertTrue(res["ok"], res)
        call = self.fake.calls[0]
        self.assertIn(f"/accounts/{ACCOUNT}/email/sending/send", call["url"])
        self.assertEqual(call["headers"]["Authorization"], "Bearer " + "t" * 40)
        self.assertEqual(call["json"]["subject"], "Hi Bcc: x@evil.com")  # no header injection through the subject
        self.assertEqual(call["json"]["from"]["address"], "notify@shellb.app")

    def test_resend(self):
        db.kv_set("email", {"provider": "resend", "from": "notify@shellb.app", "to": "owner@example.com"})
        self.fake.script = [(503, {"message": "busy"}), (200, {"id": "49a3999c"})]
        res = mailer.send("test", ["a@example.com"], "Hi", "body", reply_to="owner@example.com")
        self.assertTrue(res["ok"], res)
        first, second = self.fake.calls
        self.assertEqual(first["url"], "https://api.resend.com/emails")
        self.assertEqual(first["json"]["from"], "Shell:B <notify@shellb.app>")
        self.assertEqual(first["json"]["reply_to"], "owner@example.com")
        self.assertEqual(first["headers"]["Idempotency-Key"], second["headers"]["Idempotency-Key"])  # a retry can't duplicate
        self.fake.calls.clear()
        self.fake.script = [(422, {"statusCode": 422, "message": "The shellb.app domain is not verified."})]
        res = mailer.send("test", "a@example.com", "s", "b")
        self.assertIn("not verified", res["error"])
        self.assertEqual(len(self.fake.calls), 1)

    def test_not_ready_without_token(self):
        mailer.TOKEN.unlink()
        self.assertFalse(mailer.send("test", "a@example.com", "s", "b")["ok"])
        self.assertEqual(self.fake.calls, [])

    def test_retries_only_transient_errors(self):
        self.fake.script = [(503, {"success": False, "errors": [{"message": "upstream"}]}), (200, {"success": True, "result": {}})]
        self.assertTrue(mailer.send("test", "a@example.com", "s", "b")["ok"])
        self.assertEqual(len(self.fake.calls), 2)
        self.fake.calls.clear()
        self.fake.script = [(400, {"success": False, "errors": [{"message": "invalid_request_schema"}]})]
        res = mailer.send("test", "a@example.com", "s", "b")
        self.assertFalse(res["ok"])
        self.assertIn("invalid_request_schema", res["error"])
        self.assertEqual(len(self.fake.calls), 1)

    def test_hourly_cap(self):
        mailer._sent[:] = [time.time()] * mailer.SEND_CAP
        self.assertIn("this hour", mailer.send("test", "a@example.com", "s", "b")["error"])
        self.assertEqual(self.fake.calls, [])

    def test_bad_recipients_refused(self):
        self.assertFalse(mailer.send("test", ["nope"], "s", "b")["ok"])
        self.assertFalse(mailer.send("test", [f"a{i}@x.com" for i in range(11)], "s", "b")["ok"])

    def test_token_is_never_returned_and_config_is_admin_only(self):
        r = owner.get("/api/email", headers=ADMIN)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["tokenSet"])
        self.assertNotIn("t" * 40, r.text)
        self.assertEqual(owner.put("/api/email", json={"to": "x@example.com"}).status_code, 403)  # localhost isn't admin
        self.assertEqual(owner.put("/api/email", headers=ADMIN, json={"accountId": "nope"}).status_code, 400)


class Notifications(MailBase):
    def test_email_is_its_own_channel_and_off_by_default(self):
        notify.event = self._event
        notify.event("schedule", "failed", "Nightly backup", "#/activity")
        self.assertEqual(self.fake.calls, [])
        db.kv_set("notify_prefs", {"email": {"schedule": "attention"}})
        notify.event("schedule", "done", "Nightly backup", "#/activity")
        self.assertEqual(self.fake.calls, [])
        notify.event("schedule", "failed", "Nightly backup", "#/activity")
        self.assertEqual(len(self.fake.calls), 1)
        sent = self.fake.calls[0]["json"]
        self.assertEqual(sent["to"], ["owner@example.com"])
        self.assertIn("Scheduled task failed", sent["subject"])
        self.assertNotIn("Nightly backup", sent["text"])  # titles only with the "details" preference
        self.assertIn("https://ai.shellb.app/#/activity", sent["text"])


class GuestMail(MailBase):
    def test_forgot_password_emails_the_account_without_signing_out(self):
        g, c, username = account()
        with db.conn() as conn:
            conn.execute("UPDATE guests SET email=? WHERE id=?", ("robin@example.com", g["id"]))
        self.assertEqual(c.get("/api/guest/me").status_code, 200)
        r = gclient("198.51.100.7").post("/api/guest/forgot", json={"who": username})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(self.fake.calls[0]["json"]["to"], ["robin@example.com"])
        self.assertIn("#reset=", self.fake.calls[0]["json"]["text"])
        self.assertEqual(c.get("/api/guest/me").status_code, 200)  # asking doesn't sign anyone out
        again = gclient("198.51.100.7").post("/api/guest/forgot", json={"who": username})
        self.assertEqual(again.json(), r.json())
        self.assertEqual(len(self.fake.calls), 1)  # one email per account per 15 minutes

    def test_forgot_password_answers_the_same_for_unknown_accounts(self):
        known = gclient("198.51.100.8").post("/api/guest/forgot", json={"who": "nobody-here"})
        self.assertEqual(known.status_code, 200)
        self.assertEqual(self.fake.calls, [])
        for _ in range(ga.FORGOT_PER_IP - 1):
            gclient("198.51.100.8").post("/api/guest/forgot", json={"who": "nobody-here"})
        self.assertEqual(gclient("198.51.100.8").post("/api/guest/forgot", json={"who": "x"}).status_code, 429)

    def test_owner_emails_invite_and_reset(self):
        import guests
        g, _ = guests.create_guest("Sam")
        r = owner.post(f"/api/guests/{g['id']}/email-invite", headers=ADMIN, json={"email": "sam@example.com"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("#invite=", self.fake.calls[-1]["json"]["text"])
        self.assertEqual(owner.post(f"/api/guests/{g['id']}/email-invite", json={"email": "sam@example.com"}).status_code, 403)
        g2, _, _ = account("Robin")
        self.assertEqual(owner.post(f"/api/guests/{g2['id']}/email-reset", headers=ADMIN).status_code, 409)  # no address


class AgentTool(MailBase):
    def _run(self, decision: str, args: dict):
        seen = {}

        async def wait(aid, abort, meta=None, timeout=0):
            seen.update(meta)
            return decision
        sink = types.SimpleNamespace(blocks=[{}], update=lambda i: asyncio.sleep(0))
        ctx = types.SimpleNamespace(conv_id="c-test")
        orig = remote.wait_approval
        remote.wait_approval = wait
        try:
            res = asyncio.run(mailer.run(args, ctx, asyncio.Event(), sink, 0))
        finally:
            remote.wait_approval = orig
        return res, seen

    def test_sends_only_after_approval(self):
        args = {"to": ["friend@example.com"], "subject": "Dinner", "body": "Friday at 7?"}
        res, seen = self._run("deny", args)
        self.assertTrue(res.error)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("Friday at 7?", seen["detail"])
        self.assertEqual(seen["kind"], "email")
        res, _ = self._run("allow", args)
        self.assertFalse(res.error, res)
        self.assertEqual(self.fake.calls[0]["json"]["reply_to"], "owner@example.com")


if __name__ == "__main__":
    unittest.main()
