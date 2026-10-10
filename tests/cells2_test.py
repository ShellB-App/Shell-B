"""Guest cells, phase 2 (server/cells.py): the sandbox broker service, the egress proxy's rules and the turn caps."""
import asyncio
import json
import unittest
from unittest import mock

from starlette.requests import Request

from smoke_test import client, shellb  # noqa: F401

import cells
import db
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

    async def test_dev_server_requests_are_checked(self):
        """Phase 2b: the broker runs a project's dev server for the cell, only with a sane config and the cell's own project."""
        gid = "guest-ffffffffffff"
        for body in ({"pid": "../x", "command": "uvicorn app:app", "port": 8000},
                     {"pid": "proj-0123456789ab"},  # no command
                     {"pid": "proj-0123456789ab", "command": "x", "port": 80},
                     {"pid": "proj-0123456789ab", "command": "x", "port": 8000, "env": {"bad key": "1"}}):
            with self.assertRaises(cells.Refused, msg=json.dumps(body)):
                await cells._sandbox(_request("POST", "/dev/start", body), gid)
        cfg = cells.dev_config({"command": "uvicorn app:app --port 8000", "port": 8000, "env": {"DEBUG": 1}})
        self.assertEqual(cfg, {"command": "uvicorn app:app --port 8000", "port": 8000, "env": {"DEBUG": "1"}})
        # another cell's project is nobody's business: status says stopped, logs and stop are refused or no-ops
        import devserver
        devserver.register_cell("proj-0123456789ab", db.DATA / "x.sock", 61007, "guest-aaaaaaaaaaaa")
        try:
            st = await cells.dev_status(gid, "proj-0123456789ab")
            self.assertEqual((st["running"], st["port"], st["preview"]), (False, None, None))
            with self.assertRaises(cells.Refused):
                await cells.dev_logs(gid, "proj-0123456789ab", 50)
            with mock.patch.object(devserver, "stop", mock.AsyncMock()) as stop:
                await cells.dev_stop(gid, "proj-0123456789ab")
                stop.assert_not_awaited()
            with self.assertRaises(cells.Refused):  # taken by the other cell
                await cells.dev_start(gid, 61008, "proj-0123456789ab", {"command": "x", "port": 8000})
        finally:
            devserver._cell_socks.pop("proj-0123456789ab", None)
            devserver._last_use.pop("proj-0123456789ab", None)
        # a valid start: the project folder is checked (no symlinks), the dev folder must be the cell's own directory
        with mock.patch.object(cells, "_real_dir", mock.AsyncMock(return_value=db.DATA / "proj")), \
             mock.patch.object(cells, "_dev_sock_dir", side_effect=cells.Refused("make the dev folder first")):
            with self.assertRaises(cells.Refused):
                await cells.dev_start(gid, 61008, "proj-0123456789ab", {"command": "x", "port": 8000})

    def test_dev_sock_dir_must_be_the_cells_directory(self):
        import tempfile
        from pathlib import Path
        gid = "guest-abcdefabcdef"
        with mock.patch.object(cells, "_dir", return_value=Path(tempfile.mkdtemp(prefix="celldev"))) as d, \
             mock.patch.object(cells, "uid_of", return_value=__import__("os").getuid()):
            base = d.return_value / "web" / "dev"
            with self.assertRaises(cells.Refused):  # missing
                cells._dev_sock_dir(gid, "proj-0123456789ab")
            base.mkdir(parents=True)
            (base / "proj-0123456789ab").symlink_to("/tmp")
            with self.assertRaises(cells.Refused):  # a symlink
                cells._dev_sock_dir(gid, "proj-0123456789ab")
            (base / "proj-0123456789ab").unlink()
            (base / "proj-0123456789ab").mkdir()
            self.assertEqual(cells._dev_sock_dir(gid, "proj-0123456789ab"), base / "proj-0123456789ab")

    async def test_screenshots_render_through_the_gateway_with_the_frame_key(self):
        """A static page is rendered by the host's Firefox through the guest gateway under the project's frame key (signed
        with the cell's frame secret); a live page needs the cell's own dev server."""
        import auth
        import projects
        gid = "guest-123456789abc"
        with self.assertRaises(cells.Refused):
            await cells.shot(gid, {"pid": "nope", "path": "index.html"})
        with self.assertRaises(cells.Refused):  # live: no dev server of this cell
            await cells.shot(gid, {"pid": "proj-0123456789ab", "path": "/", "live": True})
        with mock.patch.object(projects, "shoot", mock.AsyncMock(return_value=[b"PNG1", b"PNG2"])) as shoot:
            out = await cells.shot(gid, {"pid": "proj-0123456789ab", "path": "pages/about.html?demo=1", "width": 99999, "height": 10,
                                         "pages": 3, "hold": 700})
            self.assertEqual(out, ["UE5HMQ==", "UE5HMg=="])
            base, width, height, pages, hold = shoot.await_args.args
            key = f"p-proj-0123456789ab.{auth.frame_mac(guests.frame_secret(gid), 'p-proj-0123456789ab')}"
            self.assertEqual(base, f"http://127.0.0.1:{cells.GUEST_PORT}/api/k/{key}/projects/proj-0123456789ab/raw/pages/about.html?demo=1&")
            self.assertEqual((width, height, pages, hold), (2560, 320, 3, 700))

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
