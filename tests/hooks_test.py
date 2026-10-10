"""Webhooks (server/hooks.py): inbound deliveries need the hook's secret and start an unattended turn; outbound hooks
only go to public addresses, sign their payloads and pick their event kinds."""
import hashlib
import hmac
import json
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from smoke_test import client, shellb  # noqa: F401

import db
import hooks
from public_api_test import fake_begin_turn, CALLS

lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)
ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


class Inbound(unittest.TestCase):
    def setUp(self):
        self._real = hooks.begin_turn
        hooks.begin_turn = fake_begin_turn
        hooks._recent.clear()
        CALLS.clear()
        self.h = hooks.create_in("GitHub", "shellb", "Push on {{payload.ref}} by {{payload.pusher.name}}: {{payload.head_commit.message}} ({{header.x-github-event}})")

    def tearDown(self):
        hooks.begin_turn = self._real
        hooks.delete_in(self.h["id"])

    def test_management_is_admin_only(self):
        self.assertEqual(lan.get("/api/webhooks").status_code, 401)
        self.assertEqual(client.get("/api/webhooks").status_code, 403)
        r = client.get("/api/webhooks", headers=ADMIN)
        self.assertEqual(r.status_code, 200)
        self.assertIn(self.h["id"], [h["id"] for h in r.json()["inbound"]])

    def test_secret_or_signature_required(self):
        url = f"/api/v1/hooks/{self.h['id']}"
        body = json.dumps({"ref": "refs/heads/main", "pusher": {"name": "evie"}, "head_commit": {"message": "Fix the thing"}}).encode()
        self.assertEqual(lan.post(url, content=body, headers={"Content-Type": "application/json"}).status_code, 401)
        self.assertEqual(lan.post(url, content=body, headers={"X-Hook-Secret": "wrong"}).status_code, 401)
        self.assertEqual(lan.post("/api/v1/hooks/hk_nope", content=body, headers={"X-Hook-Secret": self.h["secret"]}).status_code, 401)
        sig = "sha256=" + hmac.new(self.h["secret"].encode(), body, hashlib.sha256).hexdigest()
        r = lan.post(url, content=body, headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig, "X-GitHub-Event": "push"})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertEqual(len(CALLS), 1)
        self.assertEqual(CALLS[0]["body"]["content"], "Push on refs/heads/main by evie: Fix the thing (push)")
        self.assertEqual(CALLS[0]["interactive"], False)
        self.assertIn("Webhook delivery", CALLS[0]["note"])
        conv = db.get_conversation(r.json()["conversation"])
        self.assertEqual(conv["title"], "Webhook: GitHub")
        db.delete_conversation(conv["id"])

    def test_wait_returns_the_reply_and_rate_limit_holds(self):
        url = f"/api/v1/hooks/{self.h['id']}?wait=1"
        r = lan.post(url, json={"ref": "x", "pusher": {"name": "a"}, "head_commit": {"message": "m"}}, headers={"X-Hook-Secret": self.h["secret"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["reply"], "Helloworld")
        db.delete_conversation(r.json()["conversation"])
        hooks._recent[self.h["id"]] = [__import__("time").time()] * hooks.PER_MINUTE
        r = lan.post(url, json={}, headers={"X-Hook-Secret": self.h["secret"]})
        self.assertEqual(r.status_code, 429)

    def test_disabled_hook_and_empty_template_result(self):
        hooks.update_in(self.h["id"], {"enabled": False})
        r = lan.post(f"/api/v1/hooks/{self.h['id']}", json={"a": 1}, headers={"X-Hook-Secret": self.h["secret"]})
        self.assertEqual(r.status_code, 403)
        hooks.update_in(self.h["id"], {"enabled": True, "template": "{{payload.missing}}"})
        r = lan.post(f"/api/v1/hooks/{self.h['id']}", json={"a": 1}, headers={"X-Hook-Secret": self.h["secret"]})
        self.assertEqual(r.status_code, 400)

    def test_render(self):
        self.assertEqual(hooks.render("", {"a": 1}, '{"a": 1}', {}, {}), '{\n "a": 1\n}')
        self.assertEqual(hooks.render("{{text}}|{{query.q}}|{{payload.list.1}}", {"list": ["x", "y"]}, "raw", {}, {"q": "hi"}), "raw|hi|y")


class Outbound(unittest.TestCase):
    def test_urls_stay_on_the_public_internet(self):
        for bad in ("http://127.0.0.1:8200/x", "http://192.168.1.5/hook", "http://localhost/x", "ftp://example.com/x", "https://user:pw@example.com/x"):
            with self.assertRaises(ValueError, msg=bad):
                hooks.create_out("bad", bad, ["plan"])
        with self.assertRaises(ValueError):
            hooks.create_out("none", "https://example.com/hook", ["not-a-kind"])

    def test_emit_posts_only_wanted_kinds_with_a_signature(self):
        with mock.patch("tools._blocked_host", return_value=False):
            h = hooks.create_out("n8n", "https://hooks.example.com/shellb", ["plan", "calendar"], secret="s3cret")
        sent = []

        class FakeResp:
            status_code = 200

        class FakeClient:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def post(self, url, content=None, headers=None):
                sent.append((url, content, headers))
                return FakeResp()
        try:
            with mock.patch("hooks.httpx.Client", FakeClient), mock.patch("hooks.threading.Thread") as T:
                T.side_effect = lambda target, args, **kw: mock.Mock(start=lambda: target(*args))
                hooks.emit("plan", "done", "Plan finished", "#/plans/x", "pl-1")
                hooks.emit("schedule", "done", "Not wanted")
            self.assertEqual(len(sent), 1)
            url, body, headers = sent[0]
            ev = json.loads(body)
            self.assertEqual((ev["event"], ev["kind"], ev["title"]), ("plan.done", "plan", "Plan finished"))
            want = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
            self.assertEqual(headers["X-Shellb-Signature"], want)
            self.assertEqual(headers["X-Shellb-Event"], "plan")
            self.assertEqual(hooks.get_out(h["id"])["failures"], 0)
            r = client.get("/api/webhooks", headers=ADMIN).json()
            self.assertTrue(any(x["hook_id"] == h["id"] and x["direction"] == "out" and x["status"] == 200 for x in r["log"]))
        finally:
            hooks.delete_out(h["id"])


if __name__ == "__main__":
    unittest.main()
