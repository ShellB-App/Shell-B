"""Screen sight (server/screen.py): only the owner or a paired helper can be a source, the helper's token is checked
on every call, and look_at_screen gets a frame from a connected source into the chat's /work/screen."""
import asyncio
import io
import time
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import screen
from tools import ToolContext, WORKSPACES

WEB = Path(__file__).resolve().parent.parent
lan = TestClient(shellb.app, client=("10.0.0.9", 50000), raise_server_exceptions=False)


def pair(name="Test PC") -> str:
    token = "sbs_test-" + name.replace(" ", "")
    devs = screen._devices()
    devs["dev-" + name.replace(" ", "").lower()] = {"name": name, "hash": screen._hash(token), "created": time.time()}
    screen._save_devices(devs)
    return token


def png(w=640, h=360) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (20, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


class Access(unittest.TestCase):
    def test_strangers_cannot_be_a_source(self):
        self.assertEqual(lan.post("/api/screen/connect", json={}).status_code, 403)
        r = lan.post("/api/screen/connect", json={}, headers={"x-shellb-screen": "sbs_wrong"})
        self.assertEqual(r.status_code, 401)

    def test_localhost_is_not_a_source(self):  # local trust is for this machine's tools, not for screens
        self.assertEqual(client.post("/api/screen/connect", json={}).status_code, 403)

    def test_only_source_paths_are_open_to_the_helper(self):
        tok = pair("Lister")
        self.assertEqual(lan.get("/api/screen/sources", headers={"x-shellb-screen": tok}).status_code, 401)
        self.assertEqual(lan.get("/api/screen/devices", headers={"x-shellb-screen": tok}).status_code, 401)

    def test_a_source_answers_only_to_its_owner(self):
        a, b = pair("Owner A"), pair("Owner B")
        sid = lan.post("/api/screen/connect", json={"name": "A"}, headers={"x-shellb-screen": a}).json()["id"]
        try:
            self.assertEqual(lan.post(f"/api/screen/disconnect?id={sid}", headers={"x-shellb-screen": b}).status_code, 403)
        finally:
            screen._drop(sid)

    def test_unpaired_helper_is_refused(self):
        tok = pair("Gone")
        sid = lan.post("/api/screen/connect", json={}, headers={"x-shellb-screen": tok}).json()["id"]
        devs = screen._devices()
        devs.pop("dev-gone")
        screen._save_devices(devs)
        self.assertEqual(lan.get(f"/api/screen/next?id={sid}", headers={"x-shellb-screen": tok}).status_code, 401)
        screen._drop(sid)

    def test_helper_script_gets_its_settings(self):
        screen.HELPER = WEB / "clients" / "shellb_screen.py"
        s = screen.helper_script("https://box.example.ts.net:8443/", "sbs_abc", "Laptop")
        self.assertIn("DEFAULT_URL = 'https://box.example.ts.net:8443'", s)
        self.assertIn("DEFAULT_TOKEN = 'sbs_abc'", s)
        compile(s, "shellb_screen.py", "exec")


class Look(unittest.IsolatedAsyncioTestCase):
    async def test_look_returns_the_frame(self):
        tok = pair("Looker")
        h = {"x-shellb-screen": tok}
        transport = httpx.ASGITransport(app=shellb.app, client=("10.0.0.9", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://spark") as c:
            sid = (await c.post("/api/screen/connect", json={"name": "Looker", "monitors": [{"w": 640, "h": 360}]}, headers=h)).json()["id"]
            self.assertTrue(screen.available())
            ctx = ToolContext("conv-screentest", "m1", {"id": "shellb"}, {}, None)

            async def helper():
                r = (await c.get(f"/api/screen/next?id={sid}", headers=h)).json()["request"]
                self.assertIsNotNone(r)
                ok = await c.post(f"/api/screen/frame/{r['rid']}?id={sid}", content=png(), headers={**h, "content-type": "image/png"})
                self.assertEqual(ok.status_code, 200)

            res, _ = await asyncio.wait_for(asyncio.gather(screen.look_at_screen({}, ctx), helper()), 10)
            self.assertFalse(res.error, res.text)
            self.assertEqual(len(res.model_images), 1)
            url = res.display["images"][0]
            self.assertTrue(url.startswith("/api/workspace/conv-screentest/screen/"))
            self.assertTrue((WORKSPACES / "conv-screentest" / "screen" / url.rsplit("/", 1)[1]).is_file())
            await c.post(f"/api/screen/disconnect?id={sid}", headers=h)
        self.assertFalse(any(s.id == sid for s in screen.live_sources()))

    async def test_no_source_says_how_to_share(self):
        for s in list(screen._sources):
            screen._drop(s)
        res = await screen.look_at_screen({}, ToolContext("conv-screentest", "m1", {"id": "shellb"}, {}, None))
        self.assertTrue(res.error)
        self.assertIn("Share screen live", res.text)

    async def test_stopping_the_share_ends_a_waiting_look(self):
        tok = pair("Quitter")
        sid = lan.post("/api/screen/connect", json={}, headers={"x-shellb-screen": tok}).json()["id"]
        src = screen._sources[sid]
        task = asyncio.create_task(screen.capture(src, None, timeout=5))
        await asyncio.sleep(0.05)
        screen._drop(sid)
        with self.assertRaises(RuntimeError):
            await task


if __name__ == "__main__":
    unittest.main()
