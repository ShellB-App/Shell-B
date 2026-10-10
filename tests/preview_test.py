"""Studio preview hosts (previewN.<previewHost>): signed tickets stand in for the session cookie those hosts never get."""
import asyncio
import time
import unittest

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import auth
import db
import devserver

PID, OTHER = "proj-0123456789ab", "proj-ba9876543210"


def call(qs: str = "", cookie: str = "") -> int:
    headers = [(b"host", b"preview0.shellb.app"), (b"x-forwarded-for", b"203.0.113.9"), (b"x-forwarded-proto", b"https")]
    if cookie:
        headers.append((b"cookie", cookie.encode()))
    scope = {"type": "http", "method": "GET", "path": "/", "query_string": qs.encode(), "headers": headers,
             "server": ("172.17.0.1", devserver.PORTS[0]), "client": ("172.17.0.1", 40000)}
    sent = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(m):
        sent.append(m)
    asyncio.run(devserver.proxy_app(scope, receive, send))
    return sent[0]["status"]


class PreviewTickets(unittest.TestCase):
    def setUp(self):
        db.kv_set("devserver_ports", {PID: devserver.PORTS[0], OTHER: devserver.PORTS[1]})

    def test_no_ticket_needs_login(self):
        self.assertEqual(call(), 401)

    def test_ticket_gets_past_auth(self):
        # 503: authorised, and the (not running) dev server is the next thing it reaches
        self.assertEqual(call("__pt=" + devserver.preview_ticket(PID)), 503)
        self.assertEqual(call(cookie=f"{devserver.PREVIEW_COOKIE}{devserver.PORTS[0]}={devserver.preview_ticket(PID)}"), 503)

    def test_ticket_is_bound_to_the_project(self):
        self.assertEqual(call("__pt=" + devserver.preview_ticket(OTHER)), 401)

    def test_expired_or_forged_ticket_refused(self):
        exp = int(time.time()) - 5
        old = f"{exp}.{auth.frame_mac(devserver._preview_secret(), f'preview:{PID}:{exp}')}"
        self.assertEqual(call("__pt=" + old), 401)
        self.assertEqual(call("__pt=9999999999.deadbeef"), 401)

    def test_cookies_never_reach_the_dev_server(self):
        raw = f"{auth.COOKIE}=s; {devserver.PREVIEW_COOKIE}8210=t; app=1"
        self.assertEqual(devserver._strip_cookie(raw), "app=1")

    def test_preview_base_follows_the_setting(self):
        settings = db.kv_get("settings", {})
        try:
            self.assertIsNone(devserver.preview_base(devserver.PORTS[2]))
            db.kv_set("settings", {**settings, "previewHost": "shellb.app"})
            self.assertEqual(devserver.preview_base(devserver.PORTS[2]), "https://preview2.shellb.app")
            self.assertIsNone(devserver.preview_base(None))
        finally:
            db.kv_set("settings", settings)


if __name__ == "__main__":
    unittest.main()
