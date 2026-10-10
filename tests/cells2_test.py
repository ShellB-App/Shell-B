"""Guest cells, phase 2 (server/cells.py): the sandbox broker service, the egress proxy's rules and the turn caps."""
import asyncio
import json
import unittest
from unittest import mock

from starlette.requests import Request

from smoke_test import client, shellb  # noqa: F401

import cells
import guests


def _request(method: str, path: str, body: dict | None = None) -> Request:
    data = json.dumps(body or {}).encode()
    scope = {"type": "http", "method": method, "path": path, "query_string": b"", "headers": [(b"content-type", b"application/json")],
             "server": ("sock", None), "client": ("cell", 0), "scheme": "http", "root_path": "", "http_version": "1.1"}
    sent = {"done": False}

    async def receive():
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": data, "more_body": False}
    return Request(scope, receive)


class Egress(unittest.IsolatedAsyncioTestCase):
    def test_request_lines(self):
        self.assertEqual(cells.egress_target("CONNECT api.example.com:443 HTTP/1.1"), ("connect", "api.example.com", 443, None))
        kind, host, port, first = cells.egress_target("GET http://Example.com/a/b?x=1 HTTP/1.1")
        self.assertEqual((kind, host, port, first), ("http", "example.com", 80, b"GET /a/b?x=1 HTTP/1.1\r\n"))
        for bad in ("GET /relative HTTP/1.1", "GET https://example.com/ HTTP/1.1", "CONNECT nohostport HTTP/1.1", "nonsense",
                    "GET http://user:pw@example.com/ HTTP/1.1"):
            with self.assertRaises(cells.Refused, msg=bad):
                cells.egress_target(bad)

    async def test_allow_rules(self):
        cells._egress_conns.clear()
        with mock.patch("tools._blocked_host", return_value=False):
            await cells.egress_allow("guest-aaaaaaaaaaaa", "example.com", 443)
            with self.assertRaises(cells.Refused):
                await cells.egress_allow("guest-aaaaaaaaaaaa", "example.com", 8200)
            with self.assertRaises(cells.Refused):
                await cells.egress_allow("guest-aaaaaaaaaaaa", "localhost", 80)
            cells._egress_conns["guest-bbbbbbbbbbbb"] = [__import__("time").time()] * cells.EGRESS_PER_MINUTE
            with self.assertRaises(cells.Refused):
                await cells.egress_allow("guest-bbbbbbbbbbbb", "example.com", 443)
        with mock.patch("tools._blocked_host", return_value=True):
            with self.assertRaises(cells.Refused):
                await cells.egress_allow("guest-aaaaaaaaaaaa", "spark-e1d5.tailnet.ts.net", 443)

    async def test_proxy_refuses_local_target_end_to_end(self):
        import tempfile, os
        d = tempfile.mkdtemp()
        path = os.path.join(d, "egress.sock")
        server = await asyncio.start_unix_server(lambda r, w: cells._egress_conn("guest-cccccccccccc", r, w), path=path)
        try:
            with mock.patch("tools._blocked_host", return_value=True):
                r, w = await asyncio.open_unix_connection(path)
                w.write(b"CONNECT 10.0.0.5:443 HTTP/1.1\r\nHost: 10.0.0.5:443\r\n\r\n")
                await w.drain()
                status = await asyncio.wait_for(r.readline(), 5)
                self.assertTrue(status.startswith(b"HTTP/1.1 403"))
                w.close()
        finally:
            server.close()
            await server.wait_closed()


class Sandbox(unittest.IsolatedAsyncioTestCase):
    def test_output_parsing(self):
        out = "hello\nworld\n\n__SHELLB_RC__ 3\n/work/out.png\n/work/sub/data.csv\n/work/.git/index\n"
        head, rc, changed = cells.parse_run_output(out)
        self.assertEqual((head, rc, changed), ("hello\nworld\n", 3, ["out.png", "sub/data.csv"]))
        self.assertEqual(cells.parse_run_output("no marker"), ("no marker", None, []))

    async def test_run_requests_are_checked(self):
        gid = "guest-dddddddddddd"
        for body in ({"language": "ruby", "code": "x", "workspace": "workspaces/c1"},
                     {"language": "python", "code": "", "workspace": "workspaces/c1"},
                     {"language": "python", "code": "x", "workspace": "../../etc"},
                     {"language": "python", "code": "x", "workspace": "shellb.db"}):
            with self.assertRaises(cells.Refused, msg=json.dumps(body)):
                await cells._sandbox(_request("POST", "/run", body), gid)
        with self.assertRaises(cells.Refused):
            await cells._sandbox(_request("GET", "/run"), gid)
        ok = await cells._sandbox(_request("GET", "/healthz"), gid)
        self.assertEqual(ok.status_code, 200)
        # a valid request reaches run_sandbox with the cell's uid and the checked workspace
        with mock.patch.object(cells, "run_sandbox", mock.AsyncMock(return_value={"exit": 0, "stdout": "ok", "stderr": "", "changed": [], "timedOut": False, "elapsed": 0.1})) as rs, \
             mock.patch.object(cells, "_cell", return_value=mock.Mock(uid=61007)):
            r = await cells._sandbox(_request("POST", "/run", {"language": "bash", "code": "echo ok", "workspace": "projects/proj-abc"}), gid)
            self.assertEqual(r.status_code, 200)
            rs.assert_awaited_once_with(gid, 61007, "projects/proj-abc", "bash", "echo ok")

    async def test_usage_report_and_turn_caps(self):
        gid = "guest-eeeeeeeeeeee"
        with mock.patch.object(guests, "_bump") as bump:
            r = await cells._sandbox(_request("POST", "/usage", {"prompt": 120, "completion": 30}), gid)
            self.assertEqual(r.status_code, 200)
            bump.assert_any_call(gid, "turns", 1)
            bump.assert_any_call(gid, "tokens", 150)
        with mock.patch.object(guests, "get_guest", return_value={"disabled": False, "config": {"turnsPerDay": 5, "tokensPerDay": 0}}), \
             mock.patch.object(guests, "usage", return_value={"turns": 5, "tokens": 10, "images": 0, "audio": 0, "reports": 0}):
            with self.assertRaises(cells.Refused):
                cells._turn_caps(gid)
        with mock.patch.object(guests, "get_guest", return_value={"disabled": False, "config": {"turnsPerDay": 5, "tokensPerDay": 1000}}), \
             mock.patch.object(guests, "usage", return_value={"turns": 1, "tokens": 10, "images": 0, "audio": 0, "reports": 0}):
            cells._turn_caps(gid)  # under both caps: fine


if __name__ == "__main__":
    unittest.main()
