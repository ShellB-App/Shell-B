"""Aphrodite for guests (server/guests.py adult_ok, cells.py broker, cell_boot.py): off by default, the owner's call per
guest, only in the guest's own Shell:B, re-checked by the broker on every request, and the guest's own opt-in inside
their cell. No container runs here: the broker is driven over real unix sockets with mocked upstreams, and a cell is
booted in a subprocess from a fresh copy of the code (as in cells_test)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import httpx

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import adult
import cells
import db
import guests
from cells import Refused
from roster import get_agents, get_settings

CKPT = "Test-SDXL-NSFW.safetensors"
ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


def short_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="ag", dir="/tmp"))  # unix socket paths must stay short


def aphrodite_model() -> str:
    return next(a["model"] for a in get_agents() if a.get("adult"))


def set_host(on: bool, ckpt: str = CKPT):
    s = dict(db.kv_get("settings", {}) or {})
    s.update(adultEnabled=on, adultImageCheckpoint=ckpt)
    db.kv_set("settings", s)


def adult_graph(prompt="Portrait of a woman in her thirties, red silk, warm light", saver="PreviewImage", ckpt="aphrodite"):
    wf = adult._workflow("sdxl", ckpt, f"adult, {prompt}", 832, 1216, 7)
    if saver != "PreviewImage":
        wf["10"] = {"class_type": saver, "inputs": {"filename_prefix": "x", "images": ["9", 0]}}
    return wf


class HostSide(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ckpt"))
        (self.tmp / CKPT).write_bytes(b"x")
        self._ckpts, adult.CHECKPOINTS = adult.CHECKPOINTS, self.tmp
        set_host(True)
        self.g, _ = guests.create_guest("Ada")

    def tearDown(self):
        adult.CHECKPOINTS = self._ckpts
        set_host(False, "")
        guests.delete_guest(self.g["id"])
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_off_by_default(self):
        g = guests.get_guest(self.g["id"])
        self.assertFalse(g["config"]["adult"])
        self.assertFalse(guests.adult_ok(g))
        self.assertTrue(g["config"]["cell"])

    def test_every_condition_counts(self):
        gid = self.g["id"]
        self.assertTrue(guests.adult_ok(guests.update_guest(gid, {"config": {"adult": True}})))
        set_host(False)
        self.assertFalse(guests.adult_ok(guests.get_guest(gid)), "the owner's master switch is off")
        set_host(True)
        self.assertFalse(guests.adult_ok(guests.update_guest(gid, {"config": {"cell": False}})), "the lighter guest app never runs her")
        guests.update_guest(gid, {"config": {"cell": True}})
        self.assertFalse(guests.adult_ok(guests.update_guest(gid, {"disabled": True})), "a paused guest")
        guests.update_guest(gid, {"disabled": False})
        self.assertTrue(guests.adult_ok(guests.get_guest(gid)))
        self.assertTrue(guests.agent_ok(next(a for a in get_agents() if a.get("adult"))), "still refused in the lighter app")

    def test_owner_api_and_listing(self):
        r = client.patch(f"/api/guests/{self.g['id']}", json={"config": {"adult": True}}, headers=ADMIN)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(guests.get_guest(self.g["id"])["config"]["adult"])
        self.assertTrue(client.get("/api/guests", headers=ADMIN).json()["aphrodite"])

    def test_cell_start_config(self):
        cfg = lambda: json.loads(next(a for a in cells._run_args(cells._cell(self.g["id"]), guests.get_guest(self.g["id"]))
                                       if a.startswith("SHELLB_CELL_MODELS="))[len("SHELLB_CELL_MODELS="):])
        self.assertNotIn("adult", cfg())
        guests.update_guest(self.g["id"], {"config": {"adult": True}})
        self.assertEqual(cfg()["adult"], {"model": aphrodite_model(), "images": True})
        set_host(True, "")
        self.assertEqual(cfg()["adult"]["images"], False, "no SDXL checkpoint: words only (guests never get FLUX.1-dev)")

    def test_graphs(self):
        gid = self.g["id"]
        self.assertRaises(Refused, cells.comfy_graph, gid, adult_graph())  # not allowed: her nodes don't exist
        out = cells.comfy_graph(gid, adult_graph(), CKPT)
        self.assertEqual(out["1"]["inputs"]["ckpt_name"], CKPT)  # the owner's file, whatever the cell named
        self.assertEqual(out["10"]["class_type"], "PreviewImage")
        self.assertRaises(Refused, cells.comfy_graph, gid, adult_graph(ckpt="flux1-dev-fp8.safetensors"), CKPT)
        self.assertRaises(Refused, cells.comfy_graph, gid, adult_graph(saver="SaveImage"), CKPT)  # previews only
        for bad in ("a teen on a beach", "schoolgirl uniform", "a 16 year old"):
            with self.subTest(prompt=bad):
                self.assertRaises(Refused, cells.comfy_graph, gid, adult_graph(bad), CKPT)
        self.assertIn("child", out["5"]["inputs"]["text"])  # the negative prompt isn't screened (it lists what to avoid)


def fake_upstream(seen: list, temp_name: str):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, dict(request.url.params), request.content))
        p = request.url.path
        if p == "/api/chat":
            return httpx.Response(200, content=b'{"message":{"content":"Hi"},"done":true}\n')
        if p == "/prompt":
            return httpx.Response(200, json={"prompt_id": "bbbbbbbb-1111-2222-3333-444444444444"})
        if p.startswith("/history/"):
            pid = p.rsplit("/", 1)[1]
            return httpx.Response(200, json={pid: {"outputs": {"10": {"images": [{"filename": temp_name, "subfolder": "", "type": "temp"}]}}}})
        if p == "/view":
            return httpx.Response(200, content=b"\x89PNG fake", headers={"content-type": "image/png"})
        return httpx.Response(200, json={})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class Broker(unittest.IsolatedAsyncioTestCase):
    """The permission is asked on every request: allowed guest vs not, and revoking takes effect at once."""

    async def asyncSetUp(self):
        guests._slots = None
        self.tmp = Path(tempfile.mkdtemp(prefix="ckpt"))
        (self.tmp / CKPT).write_bytes(b"x")
        self._ckpts, adult.CHECKPOINTS = adult.CHECKPOINTS, self.tmp
        self.temp = self.tmp / "comfytemp"
        self.temp.mkdir()
        self._temp, cells.COMFY_TEMP = cells.COMFY_TEMP, self.temp
        set_host(True)
        self.ga, _ = guests.create_guest("Allowed")
        self.gb, _ = guests.create_guest("Not allowed")
        guests.update_guest(self.ga["id"], {"config": {"adult": True}})
        self.dir = short_dir()
        self.seen: list = []
        self.pic = "ComfyUI_temp_abcde_00001_.png"
        (self.temp / self.pic).write_bytes(b"png")
        self._up, cells._up = cells._up, fake_upstream(self.seen, self.pic)
        self.la = cells._Listener(self.ga["id"], self.dir / "a")
        self.lb = cells._Listener(self.gb["id"], self.dir / "b")
        for lst in (self.la, self.lb):
            lst.dir.mkdir()
            await lst.start()

    async def asyncTearDown(self):
        for lst in (self.la, self.lb):
            await lst.stop()
        await cells._up.aclose()
        cells._up, cells.COMFY_TEMP, adult.CHECKPOINTS = self._up, self._temp, self._ckpts
        set_host(False, "")
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        for g in (self.ga, self.gb):
            guests.delete_guest(g["id"])

    def client(self, which: str, svc: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(self.dir / which / f"{svc}.sock")), base_url="http://localhost")

    async def chat(self, which: str) -> int:
        async with self.client(which, "ollama") as c:
            return (await c.post("/api/chat", json={"model": aphrodite_model(), "messages": [{"role": "user", "content": "hi"}]})).status_code

    async def test_her_model(self):
        self.assertEqual(await self.chat("a"), 200)
        self.assertEqual(await self.chat("b"), 403)
        guests.update_guest(self.ga["id"], {"config": {"adult": False}})  # revoked: refused on the very next request
        self.assertEqual(await self.chat("a"), 403)
        guests.update_guest(self.ga["id"], {"config": {"adult": True}})
        set_host(False)  # the owner's master switch
        self.assertEqual(await self.chat("a"), 403)

    async def test_pictures(self):
        async with self.client("b", "comfy") as c:
            self.assertEqual((await c.post("/prompt", json={"prompt": adult_graph()})).status_code, 403)
        async with self.client("a", "comfy") as c:
            r = await c.post("/prompt", json={"prompt": adult_graph()})
            self.assertEqual(r.status_code, 200, r.text)
            pid = r.json()["prompt_id"]
            sent = json.loads(next(x[3] for x in self.seen if x[1] == "/prompt"))
            self.assertEqual(sent["prompt"]["1"]["inputs"]["ckpt_name"], CKPT)
            view = {"filename": self.pic, "subfolder": "", "type": "temp"}
            self.assertEqual((await c.get("/view", params=view)).status_code, 403)  # not before it's in this cell's history
            self.assertEqual((await c.get(f"/history/{pid}")).status_code, 200)
        async with self.client("b", "comfy") as c:
            self.assertEqual((await c.get("/view", params=view)).status_code, 403)  # never another cell's picture
        async with self.client("a", "comfy") as c:
            got = await c.get("/view", params=view)
            self.assertEqual((got.status_code, got.content), (200, b"\x89PNG fake"))
            self.assertFalse((self.temp / self.pic).exists(), "deleted from the host once fetched")
            self.assertEqual((await c.get("/view", params=view)).status_code, 403)  # once only
            await c.post("/history", json={"delete": [pid, "cccccccc-0000-0000-0000-000000000000"]})
        cleared = [json.loads(x[3]) for x in self.seen if x[0] == "POST" and x[1] == "/history"]
        self.assertEqual(cleared, [{"delete": [pid]}])  # only its own prompt
        self.assertEqual(guests.usage(self.ga["id"])["images"], 1)


class CellWithAphrodite(unittest.TestCase):
    """A cell booted with the owner's permission: she's there, but off until the guest opts in."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cellmode-adult-"))
        here = Path.cwd()  # smoke_test's scratch server/
        shutil.copytree(here, cls.tmp / "server", ignore=shutil.ignore_patterns("__pycache__"))
        (cls.tmp / "data").mkdir()
        shutil.copytree(here.parent / "ui", cls.tmp / "ui")
        script = r'''
import json, sys
sys.path.insert(0, ".")
import app
from fastapi.testclient import TestClient
from tools import TOOLS
from roster import get_agents, get_settings
paths = sorted({getattr(r, "path", "") for r in app.app.routes})
gate = {"x-shellb-cell-gate": "g" * 40}
c = TestClient(app.app, client=("127.0.0.1", 5000), raise_server_exceptions=False)
before = {"settings": get_settings()["adultEnabled"], "listed": [a["id"] for a in c.get("/api/agents", headers=gate).json()]}
optin = c.put("/api/settings", json={"adultEnabled": True}, headers=gate).status_code
after = [a["id"] for a in c.get("/api/agents", headers=gate).json()]
aph = next(a for a in get_agents() if a.get("adult"))
print("CELLOUT" + json.dumps({"paths": paths, "tools": sorted(TOOLS), "before": before, "optin": optin, "after": after,
                              "model": aph["model"], "default": get_settings()["defaultAgent"],
                              "me": c.get("/api/auth/me", headers=gate).json()["cell"],
                              "nogate": c.put("/api/settings", json={"adultEnabled": False}).status_code}))
'''
        env = {**os.environ, "SHELLB_CELL": "1", "SHELLB_CELL_SECRET": "g" * 40, "SHELLB_CELL_FRAME_SECRET": "f" * 40,
               "SHELLB_CELL_GUEST": "Robin",
               "SHELLB_CELL_MODELS": json.dumps({"models": ["ShellB-Swift"], "embeddingModel": "qwen3-embedding:4b", "utilityModel": "ShellB-Swift",
                                                 "adult": {"model": "Some-Local-Model", "images": True}})}
        p = subprocess.run([sys.executable, "-c", script], cwd=cls.tmp / "server", env=env, capture_output=True, text=True, timeout=300)
        line = next((ln for ln in p.stdout.splitlines() if ln.startswith("CELLOUT")), None)
        if not line:
            raise AssertionError(f"cell mode didn't boot:\n{p.stdout[-2000:]}\n{p.stderr[-4000:]}")
        cls.out = json.loads(line[len("CELLOUT"):])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_her_pieces_stay(self):
        self.assertIn("generate_adult_image", self.out["tools"])
        self.assertIn("/api/adult/files/{conv_id}/{name}", self.out["paths"])
        self.assertNotIn("/api/adult/checkpoints", self.out["paths"])  # the owner's files are not the guest's business
        self.assertEqual(self.out["model"], "Some-Local-Model")  # the model the host serves her on
        self.assertEqual(self.out["me"], {"guest": "Robin", "adult": True})
        self.assertNotEqual(self.out["default"], "aphrodite")

    def test_the_guest_opts_in(self):
        self.assertFalse(self.out["before"]["settings"])  # allowed is not on: the guest switches her on
        self.assertNotIn("aphrodite", self.out["before"]["listed"])
        self.assertEqual(self.out["optin"], 200)
        self.assertIn("aphrodite", self.out["after"])
        self.assertEqual(self.out["nogate"], 401)


if __name__ == "__main__":
    unittest.main()
