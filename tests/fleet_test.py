"""Fleet: routing between the Spark and other machines, the node helper relaying to their Ollama, failover, and copying
a model built here to another machine. Two fake Ollamas stand in for the Spark's and the other machine's, and the real
clients/shellb_node.py runs in front of the second one."""
import asyncio
import json
import socket
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from smoke_test import WEB, client, shellb  # noqa: F401

import db
import fleet

ADMIN = {"x-shellb-admin": (db.DATA / "admin.key").read_text().strip()}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def fake_ollama(models, log):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, obj, stream=None):
            if stream is None:
                b = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for item in stream:
                line = json.dumps(item).encode() + b"\n"
                self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
                self.wfile.flush()
                time.sleep(0.02)
            self.wfile.write(b"0\r\n\r\n")

        def do_GET(self):
            if self.path == "/api/version":
                return self._send({"version": "0.0-test"})
            if self.path == "/api/tags":
                return self._send({"models": [{"name": m, "size": 1000} for m in models]})
            if self.path == "/api/ps":
                return self._send({"models": []})
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            log.append((self.path, body))
            if self.path == "/api/chat":
                if body.get("stream") is False:
                    return self._send({"message": {"role": "assistant", "content": f"hi from {log.name}"}, "done": True})
                return self._send(None, [{"message": {"content": "hel"}}, {"message": {"content": "lo"}},
                                         {"done": True, "eval_count": 2, "prompt_eval_count": 5}])
            if self.path == "/api/show":
                return self._send({"capabilities": ["completion"], "parameters": 'num_ctx 131072\nstop "<|im_end|>"\nstop "<|endoftext|>"',
                                   "system": "You are Swift.", "template": "{{ .Prompt }}",
                                   "modelfile": "FROM /usr/share/ollama/.ollama/models/blobs/sha256-abc\nRENDERER qwen3.5\nPARSER qwen3.5\n",
                                   "details": {"parent_model": "tiny:q8", "family": "qwen"}})
            if self.path in ("/api/pull", "/api/create"):
                models.append(body["model"])
                return self._send(None, [{"status": "pulling", "total": 10, "completed": 5}, {"status": "success"}])
            self._send({})

    srv = ThreadingHTTPServer(("127.0.0.1", free_port()), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Log(list):
    def __init__(self, name):
        super().__init__()
        self.name = name


class FleetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.local_log, cls.remote_log = Log("spark"), Log("node")
        cls.local_models, cls.remote_models = ["tiny:latest", "shellb-swift:latest"], ["tiny:latest", "big:70b"]
        cls.local = fake_ollama(cls.local_models, cls.local_log)
        cls.remote = fake_ollama(cls.remote_models, cls.remote_log)
        cls._real_ollama = fleet.OLLAMA
        fleet.AGENT_SCRIPT = WEB / "clients" / "shellb_node.py"  # the scratch copy has server/ only
        fleet.OLLAMA = f"http://127.0.0.1:{cls.local.server_port}"
        fleet.NODES.unlink(missing_ok=True)
        cls.port = free_port()
        r = client.post("/api/fleet/nodes", headers=ADMIN, json={"name": "test-node", "url": f"127.0.0.1:{cls.port}", "slots": 1})
        assert r.status_code == 200, r.text
        cls.node = r.json()["node"]
        cls.setup_cmds = r.json()["setup"]
        cls.token = fleet._load()["nodes"][0]["token"]
        cls.helper = subprocess.Popen([sys.executable, str(WEB / "clients" / "shellb_node.py"), "--token", cls.token,
                                       "--host", "127.0.0.1", "--port", str(cls.port),
                                       "--ollama", f"http://127.0.0.1:{cls.remote.server_port}"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        asyncio.run(fleet.poll_once())

    @classmethod
    def tearDownClass(cls):
        cls.helper.terminate()
        cls.helper.wait(5)
        cls.local.shutdown()
        cls.remote.shutdown()
        fleet.OLLAMA = cls._real_ollama
        fleet.NODES.unlink(missing_ok=True)
        fleet._status.clear()

    def setUp(self):
        fleet._inflight.clear()
        cfg = fleet._load()
        cfg["mode"], cfg["localSlots"] = "overflow", 2
        cfg["nodes"] = [n for n in cfg["nodes"] if n["id"] == self.node["id"]]
        cfg["nodes"][0].update(enabled=True, private=False)
        fleet._save(cfg)
        asyncio.run(fleet.poll_once())

    def ids(self, model, **kw):
        return [n["id"] for n in fleet.route(model, **kw)]

    def test_helper_reports_the_machine(self):
        s = fleet._status[self.node["id"]]
        self.assertTrue(s["up"], s.get("error"))
        self.assertEqual(s["models"], {"tiny:latest", "big:70b"})
        self.assertIn("memory", s["info"])
        self.assertEqual(s["info"]["ollama"]["version"], "0.0-test")

    def test_overflow_keeps_the_spark_first_until_its_slots_fill(self):
        self.assertEqual(self.ids("tiny"), ["local", self.node["id"]])
        fleet._inflight["local"] = 2
        self.assertEqual(self.ids("tiny")[0], self.node["id"])
        fleet._inflight[self.node["id"]] = 1  # everyone full: queue where the queue is shortest
        fleet._inflight["local"] = 3
        self.assertEqual(self.ids("tiny")[0], self.node["id"])

    def test_models_only_elsewhere_go_there(self):
        self.assertEqual(self.ids("big:70b"), [self.node["id"], "local"])
        self.assertEqual(self.ids("shellb-swift"), ["local"])
        self.assertIn("big:70b", fleet.remote_models())

    def test_private_and_off_stay_home(self):
        self.assertEqual(self.ids("big:70b", private=True), ["local"])
        cfg = fleet._load()
        cfg["nodes"][0]["private"] = True
        fleet._save(cfg)
        self.assertEqual(self.ids("big:70b", private=True)[0], self.node["id"])
        cfg["mode"] = "off"
        fleet._save(cfg)
        self.assertEqual(self.ids("big:70b"), ["local"])

    def test_disabled_machine_is_skipped(self):
        r = client.patch(f"/api/fleet/nodes/{self.node['id']}", headers=ADMIN, json={"enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.ids("big:70b"), ["local"])

    def test_stream_through_the_helper(self):
        async def go():
            async with fleet.stream("/api/chat", {"model": "big:70b", "messages": []}, timeout=10) as r:
                lines = [json.loads(x) async for x in r.aiter_lines() if x.strip()]
                return r.extensions["fleet_node"], lines
        node, lines = asyncio.run(go())
        self.assertEqual(node, "test-node")
        self.assertEqual("".join(x.get("message", {}).get("content", "") for x in lines), "hello")
        self.assertEqual(self.remote_log[-1][0], "/api/chat")
        self.assertEqual(fleet._inflight[self.node["id"]], 0)

    def test_post_and_failover(self):
        cfg = fleet._load()
        cfg["mode"] = "spread"
        dead = {"id": "node-dead000000", "name": "dead", "url": f"http://127.0.0.1:{free_port()}", "kind": "agent",
                "token": "x" * 32, "enabled": True, "slots": 4, "private": False}
        cfg["nodes"].append(dead)
        fleet._save(cfg)
        fleet._status[dead["id"]] = {"up": True, "models": {"tiny:latest"}, "loaded": {"tiny:latest"}}
        fleet._inflight["local"] = fleet._inflight[self.node["id"]] = 5  # the dead machine looks best
        self.assertEqual(self.ids("tiny")[0], dead["id"])
        r = asyncio.run(fleet.post("/api/chat", {"model": "tiny", "stream": False}, timeout=5))
        self.assertEqual(r.status_code, 200)
        self.assertNotEqual(r.extensions["fleet_node"], "dead")
        self.assertFalse(fleet._status[dead["id"]]["up"])

    def test_wrong_token_is_refused(self):
        cfg = fleet._load()
        good = cfg["nodes"][0]["token"]
        cfg["nodes"][0]["token"] = "wrong-token-wrong-token"
        fleet._save(cfg)
        try:
            asyncio.run(fleet.poll_once())
            s = fleet._status[self.node["id"]]
            self.assertFalse(s["up"])
            self.assertIn("token", s["error"])
        finally:
            cfg["nodes"][0]["token"] = good
            fleet._save(cfg)

    def test_copy_a_model_built_here(self):
        job = {"state": "running", "status": "", "completed": 0, "total": 0, "error": ""}
        self.addCleanup(lambda: self.remote_models.__setitem__(slice(None), ["tiny:latest", "big:70b"]))
        asyncio.run(fleet._copy(fleet._load()["nodes"][0], "ShellB-Swift", job))
        self.assertEqual(job["state"], "done", job.get("error"))
        calls = dict(self.remote_log)
        self.assertEqual(calls["/api/pull"]["model"], "tiny:q8")
        create = calls["/api/create"]
        self.assertEqual((create["model"], create["from"], create["renderer"], create["parser"]),
                         ("ShellB-Swift", "tiny:q8", "qwen3.5", "qwen3.5"))
        self.assertEqual(create["parameters"], {"num_ctx": 131072, "stop": ["<|im_end|>", "<|endoftext|>"]})
        self.assertEqual(create["system"], "You are Swift.")

    def test_owner_only_and_token_download(self):
        self.assertEqual(client.post("/api/fleet/nodes", json={"url": "10.0.0.9"}).status_code, 403)
        self.assertEqual(client.get("/api/fleet/agent").status_code, 403)
        self.assertEqual(client.get("/api/fleet/agent", headers={"X-Fleet-Token": "nope" * 8}).status_code, 403)
        r = client.get("/api/fleet/agent", headers={"X-Fleet-Token": self.token})
        self.assertEqual(r.status_code, 200)
        self.assertIn("Shell:B fleet node", r.text)
        view = client.get("/api/fleet").json()
        self.assertNotIn("token", json.dumps(view["nodes"]).replace("hasToken", ""))
        self.assertIn(self.token, self.setup_cmds["linux"])


if __name__ == "__main__":
    unittest.main()
