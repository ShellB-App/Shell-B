"""Studio preview hosts (previewN.<previewHost>): signed tickets stand in for the session cookie those hosts never get."""
import asyncio
import time
import unittest

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import auth
import db
import devserver

PID, OTHER = "proj-0123456789ab", "proj-ba9876543210"


def call(qs: str = "", cookie: str = "", host: str = "preview.local") -> int:
    headers = [(b"host", host.encode()), (b"x-forwarded-for", b"203.0.113.9"), (b"x-forwarded-proto", b"https")]
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
            db.kv_set("settings", {**settings, "previewHost": ""})
            self.assertIsNone(devserver.preview_base(PID))
            db.kv_set("settings", {**settings, "previewHost": "shellb.app"})
            self.assertEqual(devserver.preview_base(PID), "https://p-0123456789ab.shellb.app")
            self.assertIsNone(devserver.preview_base("proj-../x"))
        finally:
            db.kv_set("settings", settings)

    def test_a_cells_dev_server_is_reached_by_its_own_socket(self):
        """cells.dev_start registers the socket in the cell's folder; the proxy uses it and only as the cell's own socket."""
        import os
        import tempfile
        from pathlib import Path
        sock = Path(tempfile.mkdtemp(prefix="celldev")) / "app.sock"
        devserver.register_cell(PID, sock, os.getuid(), "guest-0123456789ab")
        try:
            self.assertEqual(devserver._sock(PID), sock)
            self.assertEqual(devserver.cell_owner(PID), "guest-0123456789ab")
            self.assertFalse(devserver._sock_ok(PID))  # nothing there yet
            # a ticketed request answers 503 (stopped) rather than 404: the proxy knows the project
            self.assertEqual(call(f"__pt={devserver.preview_ticket(PID)}"), 503)
            sock.symlink_to("/dev/null")
            self.assertFalse(devserver._sock_ok(PID))  # never through a symlink
            t = devserver._transport(PID)
            self.assertEqual(type(t._pool._network_backend).__name__, "_CellSocket")
            self.assertEqual(call(f"__pt={devserver.preview_ticket(PID)}"), 502)  # the planted link isn't connected to
        finally:
            asyncio.run(devserver.stop(PID))
            self.assertIsNone(devserver.cell_owner(PID))

    def test_host_names_the_project(self):
        settings = db.kv_get("settings", {})
        try:
            db.kv_set("settings", {**settings, "previewHost": "shellb.app"})
            other = "p-ba9876543210.shellb.app"  # served on PORTS[0], which belongs to PID: the host wins
            self.assertEqual(call("__pt=" + devserver.preview_ticket(OTHER), host=other), 503)
            self.assertEqual(call("__pt=" + devserver.preview_ticket(PID), host=other), 401)
            # a p-* host under another domain names no project, and never falls back to the port's
            self.assertEqual(call("__pt=" + devserver.preview_ticket(PID), host="p-0123456789ab.evil.example"), 401)
        finally:
            db.kv_set("settings", settings)


if __name__ == "__main__":
    unittest.main()
