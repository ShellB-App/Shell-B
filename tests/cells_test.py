"""Shell:B Guest cells (server/cells.py, server/cell_boot.py): what the broker lets a cell reach, what cell mode leaves
out, how a cell authenticates, and the gateway's proxy into a cell. No container runs here: a cell is booted in a
subprocess from a fresh copy of the code, the gateway talks to a fake cell on a unix socket, and upstream services
are httpx mock transports."""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import httpx
import uvicorn
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse, StreamingResponse

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import auth
import cells
import db
import guest_app
import guests
from cells import Refused
from roster import get_agents, get_settings

PASSWORD = "copper kettle on the hill"
(shellb.UI_DIST / "guest.html").write_text("<!doctype html><title>guest</title>")
(shellb.UI_DIST / "index.html").write_text("<!doctype html><title>test</title>")


def short_dir() -> Path:
    """Unix socket paths must stay under 108 bytes, so test sockets live in a short temp folder."""
    d = Path(tempfile.mkdtemp(prefix="cb", dir="/tmp"))
    return d


def local_model() -> str:
    return next(a["model"] for a in get_agents() if a["id"] == get_settings()["defaultAgent"])


class Ollama(unittest.TestCase):
    ALLOWED = ["ShellB-Swift", "qwen3-embedding:4b"]

    def body(self, path, **kw):
        return cells.ollama_body(path, kw, self.ALLOWED, "qwen3-embedding:4b")

    def test_model_management_is_refused(self):
        for path in ("/api/pull", "/api/delete", "/api/create", "/api/copy", "/api/push", "/api/blobs/sha256:x"):
            with self.subTest(path=path):
                self.assertRaises(Refused, self.body, path, model="ShellB-Swift")

    def test_only_shared_models(self):
        self.assertRaises(Refused, self.body, "/api/chat", model="gpt-oss:120b", messages=[{"role": "user", "content": "hi"}])
        self.assertEqual(self.body("/api/chat", model="ShellB-Swift:latest", messages=[{"role": "user", "content": "hi"}])["model"],
                         "ShellB-Swift:latest")

    def test_no_loading_without_work(self):
        self.assertRaises(Refused, self.body, "/api/chat", model="ShellB-Swift", messages=[])
        self.assertRaises(Refused, self.body, "/api/generate", model="ShellB-Swift", prompt="  ")
        self.assertRaises(Refused, self.body, "/api/embed", model="qwen3-embedding:4b", input=[])

    def test_options_are_cleaned(self):
        out = self.body("/api/chat", model="ShellB-Swift", messages=[{"role": "user", "content": "hi"}], keep_alive=0,
                        options={"num_gpu": 0, "num_ctx": 262144, "num_predict": 10**9, "temperature": 0.3, "use_mmap": False},
                        extra_field="x")
        self.assertEqual(out["keep_alive"], "2h")
        self.assertEqual(out["options"], {"num_predict": cells.MAX_PREDICT, "temperature": 0.3})
        self.assertNotIn("extra_field", out)
        emb = self.body("/api/embed", model="qwen3-embedding:4b", input=["x"], options={"num_ctx": 2048})
        self.assertEqual(emb["options"], {"num_ctx": 2048})  # Shell:B's own short embedding context stays
        self.assertEqual(self.body("/api/embed", model="qwen3-embedding:4b", input=["x"], options={"num_ctx": 65536})["options"], {})

    def test_show(self):
        self.assertEqual(self.body("/api/show", name="ShellB-Swift", verbose=True), {"model": "ShellB-Swift"})


class Comfy(unittest.TestCase):
    GID = "guest-0123456789ab"

    def flux(self, **changes):
        wf = {
            "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "t5xxl_fp8_e4m3fn.safetensors", "clip_name2": "clip_l.safetensors", "type": "flux"}},
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-schnell-fp8.safetensors", "weight_dtype": "fp8_e4m3fn"}},
            "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 9000, "height": 1024, "batch_size": 8}},
            "9": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 0]}},
            "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": "../../evil/ShellB_Web", "images": ["9", 0]}},
        }
        wf.update(changes)
        return wf

    def test_a_normal_graph_is_confined(self):
        out = cells.comfy_graph(self.GID, self.flux())
        self.assertEqual(out["10"]["inputs"]["filename_prefix"], f"cells/{self.GID}/ShellB_Web")
        self.assertEqual((out["6"]["inputs"]["width"], out["6"]["inputs"]["batch_size"]), (2048, 1))
        glb = cells.comfy_graph(self.GID, {"28": {"class_type": "SaveGLB", "inputs": {"filename_prefix": "3d/ShellB_Web"}}})
        self.assertEqual(glb["28"]["inputs"]["filename_prefix"], f"cells/{self.GID}/3d/ShellB_Web")

    def test_refused_graphs(self):
        cases = {
            "checkpoint save": {"7": {"class_type": "CheckpointSave", "inputs": {"filename_prefix": "x"}}},
            "unknown node": {"7": {"class_type": "ExecutePython", "inputs": {"code": "import os"}}},
            "foreign model": {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "secret-model.safetensors"}}},
            "owner checkpoint": {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "flux1-dev-fp8.safetensors"}}},
            "missing model": {"1": {"class_type": "UNETLoader", "inputs": {}}},
            "foreign upload": {"5": {"class_type": "LoadImage", "inputs": {"image": "owner-photo.png"}}},
            "other cell's upload": {"5": {"class_type": "LoadImage", "inputs": {"image": "cell-guest-ffffffffffff-1.png"}}},
            "dangling link": {"9": {"class_type": "VAEDecode", "inputs": {"samples": ["99", 0]}}},
            "nested value": {"4": {"class_type": "CLIPTextEncode", "inputs": {"text": {"$ref": "x"}}}},
        }
        for label, graph in cases.items():
            with self.subTest(label):
                self.assertRaises(Refused, cells.comfy_graph, self.GID, graph)
        self.assertRaises(Refused, cells.comfy_graph, self.GID, {str(i): {"class_type": "CLIPTextEncode", "inputs": {}} for i in range(65)})

    def test_own_upload_is_fine(self):
        cells.comfy_graph(self.GID, {"5": {"class_type": "LoadImage", "inputs": {"image": f"cell-{self.GID}-ab.png"}}})


class Bodies(unittest.TestCase):
    def test_tts_is_kokoro_only(self):
        out = cells.tts_body({"text": "hi", "voice": "qwen:evie-clone", "fx": {"pitch": 3}, "style": "whisper", "speed": 9})
        self.assertEqual(out, {"text": "hi", "voice": "af_heart", "speed": 2.0, "format": "wav"})
        self.assertEqual(cells.tts_body({"text": "hi", "voice": "bf_emma"})["voice"], "bf_emma")
        self.assertRaises(Refused, cells.tts_body, {"text": " "})

    def test_lengths_are_clamped(self):
        self.assertEqual(cells.music_body({"prompt": "lofi", "duration": 600, "model": "melody"})["duration"], 30)
        self.assertNotIn("model", cells.music_body({"prompt": "lofi", "model": "melody"}))
        self.assertEqual(cells.stable_body({"prompt": "rain", "duration": 47, "steps": 250})["steps"], 150)
        self.assertRaises(Refused, cells.sfx_body, {"prompt": ""})

    def test_search_and_routes(self):
        self.assertEqual(cells.search_params({"q": "otters", "format": "html", "engines": "x"}), {"q": "otters", "format": "json"})
        self.assertRaises(Refused, cells.search_params, {"q": ""})
        r = cells.route_body({"locations": [{"lat": 28.5, "lon": -81.4, "search_cutoff": 10**9}, {"lat": 95, "lon": 0}],
                              "costing": "truck", "date_time": {"type": 1}})
        self.assertEqual(r["costing"], "auto")
        self.assertEqual(r["locations"][0]["search_cutoff"], 35000)
        self.assertEqual(r["locations"][1]["lat"], 90.0)
        self.assertNotIn("date_time", r)


def fake_services(seen: list):
    """Upstream services as an httpx mock: records what the broker forwarded."""
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url), request.content))
        path = request.url.path
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "ShellB-Swift:latest"}, {"name": "gpt-oss:120b"}]})
        if path == "/api/chat":
            return httpx.Response(200, content=b'{"message":{"content":"Hi"},"done":false}\n{"done":true}\n')
        if path == "/prompt":
            return httpx.Response(200, json={"prompt_id": "aaaaaaaa-1111-2222-3333-444444444444", "number": 1})
        if path.startswith("/history/"):
            return httpx.Response(200, json={"ok": True})
        if path == "/tts/voices":
            return httpx.Response(200, json={"voices": ["af_heart", "qwen:evie"], "details": [{"id": "af_heart"}, {"id": "qwen:evie"}]})
        return httpx.Response(200, json={})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class Broker(unittest.IsolatedAsyncioTestCase):
    """The broker over real unix sockets: each cell's socket decides which cell a request belongs to."""

    async def asyncSetUp(self):
        guests._slots = None
        db.kv_set("guest_settings", {"models": [local_model()]})
        self.ga, _ = guests.create_guest("Cell A")
        self.gb, _ = guests.create_guest("Cell B")
        self.dir = short_dir()
        self.seen: list = []
        self._up = cells._up
        cells._up = fake_services(self.seen)
        self.la = cells._Listener(self.ga["id"], self.dir / "a")
        self.lb = cells._Listener(self.gb["id"], self.dir / "b")
        for lst in (self.la, self.lb):
            lst.dir.mkdir()
            await lst.start()

    async def asyncTearDown(self):
        for lst in (self.la, self.lb):
            await lst.stop()
        await cells._up.aclose()
        cells._up = self._up
        shutil.rmtree(self.dir, ignore_errors=True)
        for g in (self.ga, self.gb):
            guests.delete_guest(g["id"])

    def client(self, which: str, svc: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(self.dir / which / f"{svc}.sock")), base_url="http://localhost")

    async def test_refusals(self):
        async with self.client("a", "ollama") as c:
            self.assertEqual((await c.post("/api/pull", json={"model": "llama3"})).status_code, 403)
            self.assertEqual((await c.delete("/api/delete", params={"model": "x"})).status_code, 403)
        async with self.client("a", "hermes") as c:
            self.assertEqual((await c.post("/tts/qwen/voices/clone", json={})).status_code, 403)
            self.assertEqual((await c.put("/tts/lexicon", json=[])).status_code, 403)
            self.assertEqual((await c.post("/speaker_embed", json={})).status_code, 403)
            self.assertEqual((await c.post("/gibberlink/encode", json={})).status_code, 403)
        async with self.client("a", "stableaudio") as c:
            self.assertEqual((await c.post("/unload")).status_code, 403)
        self.assertEqual(self.seen, [])  # nothing refused reached a service

    async def test_lists_are_filtered_and_chat_streams(self):
        async with self.client("a", "ollama") as c:
            tags = (await c.get("/api/tags")).json()
            self.assertEqual([m["name"] for m in tags["models"]], ["ShellB-Swift:latest"])
            r = await c.post("/api/chat", json={"model": local_model(), "messages": [{"role": "user", "content": "hi"}], "keep_alive": 0})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.text.count("\n"), 2)
        sent = json.loads(self.seen[-1][2])
        self.assertEqual(sent["keep_alive"], "2h")
        async with self.client("a", "hermes") as c:
            self.assertEqual((await c.get("/tts/voices")).json()["voices"], ["af_heart"])

    async def test_pictures_belong_to_their_cell(self):
        graph = Comfy().flux()
        async with self.client("a", "comfy") as c:
            r = await c.post("/prompt", json={"prompt": graph, "front": True, "extra_data": {"x": 1}})
            self.assertEqual(r.status_code, 200, r.text)
            pid = r.json()["prompt_id"]
        sent = json.loads(self.seen[-1][2])
        self.assertEqual(set(sent), {"prompt", "client_id"})  # no queue jumping or extras
        self.assertEqual(sent["prompt"]["10"]["inputs"]["filename_prefix"], f"cells/{self.ga['id']}/ShellB_Web")
        self.assertEqual(guests.usage(self.ga["id"])["images"], 1)
        async with self.client("a", "comfy") as c:
            self.assertEqual((await c.get(f"/history/{pid}")).status_code, 200)
            self.assertEqual((await c.get("/view", params={"filename": "x.png", "subfolder": f"cells/{self.gb['id']}", "type": "output"})).status_code, 403)
            self.assertEqual((await c.get("/view", params={"filename": "x.png", "subfolder": "", "type": "output"})).status_code, 403)
            self.assertEqual((await c.get("/view", params={"filename": "x.png", "subfolder": f"cells/{self.ga['id']}", "type": "temp"})).status_code, 403)
            self.assertEqual((await c.get("/view", params={"filename": "x.png", "subfolder": f"cells/{self.ga['id']}", "type": "output"})).status_code, 200)
        async with self.client("b", "comfy") as c:  # cell B can't read cell A's prompt
            self.assertEqual((await c.get(f"/history/{pid}")).status_code, 403)

    async def test_daily_caps(self):
        guests.update_guest(self.ga["id"], {"config": {"imagesPerDay": 1, "audioPerDay": 1}})
        guests._bump(self.ga["id"], "images")
        guests._bump(self.ga["id"], "audio")
        async with self.client("a", "comfy") as c:
            self.assertEqual((await c.post("/prompt", json={"prompt": Comfy().flux()})).status_code, 403)
        async with self.client("a", "orpheus") as c:
            self.assertEqual((await c.post("/generate", json={"prompt": "lofi"})).status_code, 403)

    async def test_upload_renamed_png_only(self):
        async with self.client("a", "comfy") as c:
            bad = await c.post("/upload/image", files={"image": ("x.png", b"GIF89a....", "image/png")})
            self.assertEqual(bad.status_code, 403)
            ok = await c.post("/upload/image", files={"image": ("../../x.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64, "image/png")},
                              data={"subfolder": "../../custom_nodes", "overwrite": "true"})
            self.assertEqual(ok.status_code, 200)
        body = self.seen[-1][2]
        self.assertIn(f'filename="cell-{self.ga["id"]}-'.encode(), body)
        self.assertNotIn(b"custom_nodes", body)
        self.assertIn(b"false", body)  # never overwrite


class CellMode(unittest.TestCase):
    """Boot Shell:B in cell mode in a subprocess, from a fresh copy (cell_boot rewrites settings and the roster)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cellmode-"))
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
import auth, remote
from roster import get_agents, get_settings
paths = sorted({getattr(r, "path", "") for r in app.app.routes} |
               {p for r in app.app.routes if hasattr(r, "original_router") for p in (x.path for x in r.original_router.routes)})
gate = {"x-shellb-cell-gate": "g" * 40}
local = TestClient(app.app, client=("127.0.0.1", 5000), raise_server_exceptions=False)
key = "w-conv1." + auth.frame_mac("f" * 40, "w-conv1")
out = {"paths": paths, "tools": sorted(TOOLS), "remote": sorted(remote.TOOLS), "settings": get_settings(),
       "agents": sorted(a["id"] for a in get_agents()),
       "codes": {
         "gate": local.get("/api/settings", headers=gate).status_code,
         "none": local.get("/api/settings").status_code,
         "badgate": local.get("/api/settings", headers={"x-shellb-cell-gate": "x" * 40}).status_code,
         "admin": local.get("/api/settings", headers={"x-shellb-admin": open("../data/admin.key").read().strip()}).status_code,
         "me": local.get("/api/auth/me", headers=gate).json(),
         "login": local.post("/api/auth/login", json={"password": "x"}, headers=gate).status_code,
         "frame_ok": local.get(f"/api/k/{key}/workspace/conv1/x.txt").status_code,
         "frame_out": local.get(f"/api/k/{key}/settings").status_code,
         "frame_bad": local.get("/api/k/w-conv1." + "0" * 32 + "/workspace/conv1/x.txt").status_code,
         "cross": local.put("/api/settings", json={}, headers={**gate, "origin": "https://evil.example", "host": "guest.example"}).status_code,
         "gone": [(r := local.get(p, headers=gate)).status_code for p in ("/api/selfmod", "/api/guests", "/api/mcp/servers", "/api/sysinfo")] + [r.headers.get("content-type", "")],
         "dev": local.get("/api/projects/proj-000000000000/dev", headers=gate).status_code,
         "status": sorted(local.get("/api/status", headers=gate).json()["services"]),
       }}
print("CELLOUT" + json.dumps(out))
'''
        env = {**os.environ, "SHELLB_CELL": "1", "SHELLB_CELL_SECRET": "g" * 40, "SHELLB_CELL_FRAME_SECRET": "f" * 40,
               "SHELLB_CELL_GUEST": "Robin", "SHELLB_CELL_MODELS": json.dumps({"models": ["ShellB-Swift"], "embeddingModel": "qwen3-embedding:4b",
                                                                                "utilityModel": "ShellB-Swift"})}
        p = subprocess.run([sys.executable, "-c", script], cwd=cls.tmp / "server", env=env, capture_output=True, text=True, timeout=300)
        line = next((ln for ln in p.stdout.splitlines() if ln.startswith("CELLOUT")), None)
        if not line:
            raise AssertionError(f"cell mode didn't boot:\n{p.stdout[-2000:]}\n{p.stderr[-4000:]}")
        cls.out = json.loads(line[len("CELLOUT"):])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_host_routes_are_gone(self):
        host = ("/api/selfmod", "/api/selfreview", "/api/community", "/api/ssh", "/api/screen", "/api/modelstore",
                "/api/backup", "/api/datasets", "/api/watchdog", "/api/nightshift", "/api/guests", "/api/apikeys",
                "/api/v1", "/api/cli-agents", "/api/cli-bridge", "/api/adult", "/api/secretary", "/api/gibberlink",
                "/api/auth/login", "/api/auth/setup", "/api/auth/password", "/api/auth/sessions", "/api/sysinfo", "/api/network")
        for path in self.out["paths"]:
            with self.subTest(path=path):
                self.assertFalse(path.startswith(host), path)
        self.assertIn("/api/auth/me", self.out["paths"])
        self.assertIn("/api/conversations/{conv_id}/chat", self.out["paths"])

    def test_host_tools_are_gone(self):
        for t in ("shellb_self", "shellb_source", "self_findings", "find_capability", "look_at_screen", "browser",
                  "night_shift", "generate_adult_image"):
            self.assertNotIn(t, self.out["tools"])
        self.assertEqual(self.out["remote"], [])
        for t in ("web_search", "generate_image", "memory_save", "create_artifact"):
            self.assertIn(t, self.out["tools"])

    def test_defaults(self):
        s = self.out["settings"]
        self.assertEqual((s["cloudEnabled"], s["nightShift"], s["adultEnabled"], s["promptSuggestions"]), (False, False, False, False))
        self.assertEqual(s["embeddingModel"], "qwen3-embedding:4b")
        agents = self.out["agents"]
        self.assertIn("shellb", agents)
        for a in ("claude", "gemini", "aphrodite", "hephaestus"):  # cloud, adult, and a model not shared (ShellB-Forge)
            self.assertNotIn(a, agents)

    def test_only_the_gate_gets_in(self):
        c = self.out["codes"]
        self.assertEqual((c["gate"], c["none"], c["badgate"], c["admin"]), (200, 401, 401, 401))  # localhost and the admin key mean nothing
        self.assertEqual(c["me"]["frameKey"], "f" * 40)
        self.assertEqual(c["me"]["cell"], {"guest": "Robin"})
        self.assertIn(c["login"], (404, 405))
        self.assertEqual(c["cross"], 403)

    def test_frame_keys(self):
        c = self.out["codes"]
        self.assertEqual(c["frame_ok"], 404)  # allowed through to the route; the file just doesn't exist
        self.assertEqual((c["frame_out"], c["frame_bad"]), (403, 401))

    def test_host_paths_answer_404_as_json(self):
        """Not the UI page: the full UI's fetches read the error instead of choking on HTML (cell_boot.finish)."""
        *codes, ctype = self.out["codes"]["gone"]
        self.assertEqual(codes, [404] * 4)
        self.assertIn("application/json", ctype)
        self.assertEqual(self.out["codes"]["dev"], 404)  # the project route exists (404 = no such project), not the catch-all's HTML

    def test_status_probes_fit_a_cell(self):
        """No Firefox probe (screenshots are the host's) and the sandbox probe asks the broker, not Docker."""
        self.assertNotIn("studio", self.out["codes"]["status"])
        self.assertIn("sandbox", self.out["codes"]["status"])


def fake_cell_app(seen: list):
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        headers = {k.decode(): v.decode() for k, v in scope["headers"]}
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        seen.append({"path": scope["path"], "method": scope["method"], "headers": headers, "body": body})
        if scope["path"].endswith("/chat"):
            async def events():
                for i in range(3):
                    yield f"data: {i}\n\n".encode()
            resp = StreamingResponse(events(), media_type="text/event-stream")
        else:
            resp = JSONResponse({"from": "cell", "path": scope["path"]}, headers={"set-cookie": "shellb_session=x"})
        await resp(scope, receive, send)
    return app


class Gateway(unittest.TestCase):
    """The guest port proxies a cell guest to their cell; account routes stay on the gateway."""

    def setUp(self):
        guest_app._hits.clear()
        guests._codes_tried.clear()
        db.kv_set("guest_settings", {"models": [local_model()]})
        self.dir = short_dir()
        self.seen: list = []
        sock = self.dir / "web.sock"
        self.server = uvicorn.Server(uvicorn.Config(fake_cell_app(self.seen), uds=str(sock), lifespan="off", log_level="warning"))
        threading.Thread(target=self.server.run, daemon=True).start()
        for _ in range(100):
            if sock.exists():
                break
            time.sleep(0.05)
        g, code = guests.create_guest("Celia", {"cell": True})
        self.g = g
        self.c = TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40000),
                            raise_server_exceptions=False)
        r = self.c.post("/api/guest/signup", json={"code": code, "username": f"celia{os.getpid()}{int(time.time() * 1000) % 100000}",
                                                    "password": PASSWORD})
        assert r.status_code == 200, r.text
        cell = cells._cell(g["id"])
        cell.uid, cell.state, cell.secret = os.getuid(), "running", "s" * 43
        cell.client = cells._cell_client(cell, sock)

    def tearDown(self):
        cell = cells._cells.pop(self.g["id"], None)
        if cell and cell.client:
            asyncio.run(cell.client.aclose())
        self.server.should_exit = True
        with db.conn() as c:
            c.execute("DELETE FROM guest_cells WHERE guest_id=?", (self.g["id"],))
        guests.delete_guest(self.g["id"])
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_requests_go_to_the_cell_with_the_gate(self):
        r = self.c.get("/api/settings?x=1", headers={"x-shellb-cell-gate": "forged", "x-shellb-admin": "k"})
        self.assertEqual(r.json(), {"from": "cell", "path": "/api/settings"})
        self.assertNotIn("set-cookie", r.headers)  # the cell can't set cookies on the guest address
        h = self.seen[-1]["headers"]
        self.assertEqual(h["x-shellb-cell-gate"], "s" * 43)  # the browser's forged header was replaced
        self.assertNotIn("x-shellb-admin", h)
        self.assertNotIn(guests.COOKIE, h.get("cookie", ""))  # the gateway's session never reaches the cell

    def test_bodies_and_streams(self):
        r = self.c.post("/api/conversations/conv1/chat", json={"content": "hello"})
        self.assertEqual(r.text, "data: 0\n\ndata: 1\n\ndata: 2\n\n")
        self.assertEqual(json.loads(self.seen[-1]["body"]), {"content": "hello"})

    def test_account_routes_stay_on_the_gateway(self):
        self.assertEqual(self.c.get("/api/guest/account").json()["name"], "Celia")
        me = self.c.get("/api/auth/me").json()
        self.assertEqual((me["cell"], me["frameKey"]), ({"guest": "Celia"}, guests.frame_secret(self.g["id"])))
        self.assertEqual(self.seen, [])
        self.assertIn("<title>test</title>", self.c.get("/").text)  # the full UI, not the guest app

    def test_signed_out_reaches_nothing(self):
        anon = TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40001),
                          raise_server_exceptions=False)
        self.assertEqual(anon.get("/api/settings").status_code, 401)
        self.assertIn("<title>guest</title>", anon.get("/").text)
        self.assertEqual(self.seen, [])

    def test_frames_go_without_the_gate(self):
        key = "w-conv1." + auth.frame_mac(guests.frame_secret(self.g["id"]), "w-conv1")
        anon = TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40002),
                          raise_server_exceptions=False)
        self.assertEqual(anon.get(f"/api/k/{key}/workspace/conv1/index.html").json()["from"], "cell")
        self.assertNotIn("x-shellb-cell-gate", self.seen[-1]["headers"])
        self.assertEqual(anon.get("/api/k/w-conv1." + "0" * 32 + "/workspace/conv1/index.html").status_code, 404)

    def test_owner_toggle(self):
        guests.update_guest(self.g["id"], {"config": {"cell": False}})
        self.assertEqual(self.c.get("/api/conversations").status_code, 200)  # the guest app answers again
        self.assertEqual(self.seen, [])

    def test_cell_state_is_the_gateways(self):
        """The full UI's start screen (AuthGate.tsx) asks the gateway, never the cell, how the container is doing."""
        self.assertEqual(self.c.get("/api/guest/cell").json()["state"], "running")
        self.assertEqual(self.c.post("/api/guest/cell").json()["state"], "running")  # running already: nothing to start
        self.assertEqual(self.seen, [])
        me = self.c.get("/api/auth/me").json()
        self.assertNotIn("gateway", me)  # signed in: the full UI stays
        anon = TestClient(guest_app.root, base_url=f"http://testserver:{guest_app.GUEST_PORT}", client=("127.0.0.1", 40003))
        self.assertTrue(anon.get("/api/auth/me").json()["gateway"])  # signed out: the UI reloads to the gateway's sign-in page


class Defaults(unittest.TestCase):
    """Since 2026-10-10 a new guest gets their own Shell:B unless the owner unticks it (guests.clean_config)."""

    def test_new_guests_get_a_cell(self):
        g, _ = guests.create_guest("Cella")
        lite, _ = guests.create_guest("Lite", {"cell": False})
        try:
            self.assertTrue(g["config"]["cell"])
            self.assertFalse(lite["config"]["cell"])
            self.assertTrue(db.kv_get("guest_cells_default"))  # the one-time move of existing guests ran at init
        finally:
            for x in (g, lite):
                with db.conn() as c:
                    c.execute("DELETE FROM guest_cells WHERE guest_id=?", (x["id"],))
                guests.delete_guest(x["id"])


class CellSocket(unittest.IsolatedAsyncioTestCase):
    """The gateway connects only to a socket the cell's uid owns, never through a symlink."""

    async def asyncSetUp(self):
        self.dir = short_dir()
        self.real = self.dir / "real.sock"
        self.srv = socket.socket(socket.AF_UNIX)
        self.srv.bind(str(self.real))
        self.srv.listen(4)

    async def asyncTearDown(self):
        self.srv.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    async def connect(self, path: Path, uid: int):
        backend = cells._CellSocket(path, uid)
        stream = await backend.connect_unix_socket("ignored")
        await stream.aclose()

    async def test_checks(self):
        await self.connect(self.real, os.getuid())
        link = self.dir / "web.sock"
        link.symlink_to(self.real)
        with self.assertRaises(Exception):
            await self.connect(link, os.getuid())
        with self.assertRaises(Exception):
            await self.connect(self.real, os.getuid() + 1)
        plain = self.dir / "plain"
        plain.write_text("x")
        with self.assertRaises(Exception):
            await self.connect(plain, os.getuid())


if __name__ == "__main__":
    unittest.main()
