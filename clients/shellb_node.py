#!/usr/bin/env python3
"""Shell:B fleet node: lets Shell:B run its models on this machine too.

Shell:B (on the DGX Spark) sends model requests here when it's busy or when this machine has the model. This helper
relays them to the Ollama on this machine, which stays on 127.0.0.1, and reports the machine's memory and GPUs.
Every request must carry the token Shell:B gave you (Models → Fleet → Add a machine); anything else gets 401.

Needs Python 3.9+ (standard library only) and Ollama (https://ollama.com/download). Run it on a private network:
Tailscale is ideal (the helper listens on this machine's Tailscale address when it has one).

    python3 shellb_node.py --token <token>                    # run in the foreground
    python3 shellb_node.py --token <token> --install-service  # Linux: a systemd user service; Windows: a logon task
"""
import argparse
import hmac
import http.client
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0"
ALLOWED = {"/api/chat", "/api/generate", "/api/embed", "/api/embeddings", "/api/show", "/api/tags", "/api/ps",
           "/api/version", "/api/pull", "/api/create", "/api/delete"}
MAX_BODY = 512 * 1024 * 1024  # chats carry base64 images; anything bigger is a mistake
ARGS = None


# ── machine info ────────────────────────────────────────────────────────────

def _run(cmd, timeout=4):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def memory():
    try:
        if sys.platform.startswith("linux"):
            m = {}
            for line in open("/proc/meminfo"):
                k, v = line.split(":", 1)
                m[k] = int(v.split()[0]) * 1024
            return {"total": m.get("MemTotal", 0), "available": m.get("MemAvailable", 0)}
        if sys.platform == "win32":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            s = MS()
            s.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return {"total": s.ullTotalPhys, "available": s.ullAvailPhys}
        if sys.platform == "darwin":
            total = int(_run(["sysctl", "-n", "hw.memsize"]) or 0)
            pages = {k.strip(): int(v.strip(" .\n") or 0) for k, v in
                     (ln.split(":", 1) for ln in _run(["vm_stat"]).splitlines()[1:] if ":" in ln)}
            free = (pages.get("Pages free", 0) + pages.get("Pages inactive", 0)) * 16384
            return {"total": total, "available": free}
    except Exception:  # noqa: BLE001
        pass
    return {"total": 0, "available": 0}


def gpus():
    if not shutil.which("nvidia-smi"):
        return []
    out = []
    for ln in _run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits"]).splitlines():
        p = [x.strip() for x in ln.split(",")]
        if len(p) < 5:
            continue

        def num(x):
            try:
                return float(x)
            except ValueError:
                return None
        tot, used = num(p[1]), num(p[2])
        out.append({"name": p[0], "memTotal": int(tot * 2**20) if tot else None, "memUsed": int(used * 2**20) if used else None,
                    "util": num(p[3]), "temp": num(p[4])})
    return out


def load():
    try:
        return round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        return None


# ── Ollama relay ────────────────────────────────────────────────────────────

def _ollama():
    u = urllib.parse.urlsplit(ARGS.ollama)
    return http.client.HTTPConnection(u.hostname, u.port or 11434, timeout=None)


def ollama_get(path):
    c = _ollama()
    c.timeout = 5
    try:
        c.request("GET", path)
        r = c.getresponse()
        return json.loads(r.read() or b"{}") if r.status == 200 else {}
    finally:
        c.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"ShellBNode/{VERSION}"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _authed(self):
        given = self.headers.get("Authorization", "")
        if given.startswith("Bearer ") and hmac.compare_digest(given[7:].encode(), ARGS.token.encode()):
            return True
        self._json(401, {"error": "bad or missing token"})
        return False

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if not self._authed():
            return
        if self.path == "/node/info":
            info = {"name": socket.gethostname(), "os": f"{platform.system()} {platform.release()}",
                    "arch": platform.machine(), "cpus": os.cpu_count(), "load": load(), "memory": memory(),
                    "gpus": gpus(), "helper": VERSION, "time": time.time()}
            try:
                info["ollama"] = {"up": True, "version": ollama_get("/api/version").get("version")}
                info["tags"] = ollama_get("/api/tags").get("models", [])
                info["ps"] = ollama_get("/api/ps").get("models", [])
            except OSError as e:
                info["ollama"] = {"up": False, "error": str(e)}
            return self._json(200, info)
        self._relay("GET")

    def do_POST(self):
        if self._authed():
            self._relay("POST")

    def do_DELETE(self):
        if self._authed():
            self._relay("DELETE")

    def _relay(self, method):
        if not self.path.startswith("/ollama/") or self.path[7:].split("?")[0] not in ALLOWED:
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "request too large"})
        body = self.rfile.read(n) if n else None
        c = _ollama()
        try:
            c.request(method, self.path[7:], body=body, headers={"Content-Type": "application/json"} if body else {})
            r = c.getresponse()
        except OSError as e:
            c.close()
            return self._json(502, {"error": f"Ollama on this machine isn't answering: {e}"})
        try:
            self.send_response(r.status)
            self.send_header("Content-Type", r.getheader("Content-Type", "application/json"))
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = r.read1(65536)  # whatever has arrived: each streamed line goes out as soon as Ollama sends it
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # Shell:B hung up (Stop); closing our side makes Ollama drop the generation
        finally:
            c.close()


# ── setup ───────────────────────────────────────────────────────────────────

def tailscale_ip():
    exe = shutil.which("tailscale") or (r"C:\Program Files\Tailscale\tailscale.exe" if sys.platform == "win32" else None)
    if not exe or not os.path.exists(exe):
        return None
    ip = _run([exe, "ip", "-4"]).strip().splitlines()
    return ip[0] if ip else None


def install_service(argv):
    script = str(Path(__file__).resolve())
    args = [a for a in argv if a != "--install-service"]
    if sys.platform.startswith("linux"):
        unit = Path.home() / ".config/systemd/user/shellb-node.service"
        unit.parent.mkdir(parents=True, exist_ok=True)
        unit.write_text("[Unit]\nDescription=Shell:B fleet node\nAfter=network-online.target\n\n[Service]\n"
                        f"ExecStart={sys.executable} {script} {' '.join(args)}\nRestart=always\nRestartSec=5\n\n"
                        "[Install]\nWantedBy=default.target\n")
        unit.chmod(0o600)  # it holds the token
        subprocess.run(["systemctl", "--user", "daemon-reload"])
        subprocess.run(["systemctl", "--user", "enable", "--now", "shellb-node"])
        print(f"Installed {unit}. It starts at login; for boot without login run: sudo loginctl enable-linger $USER")
    elif sys.platform == "win32":
        exe = sys.executable.replace("python.exe", "pythonw.exe")
        cmd = f'"{exe}" "{script}" {" ".join(args)}'
        subprocess.run(["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", "Shell-B Node", "/TR", cmd])
        subprocess.run(["schtasks", "/Run", "/TN", "Shell-B Node"])
        print("Installed the 'Shell-B Node' logon task and started it.")
    else:
        print("On macOS, add this to a launchd agent or run it in a terminal:", sys.executable, script, *args)


def main():
    global ARGS
    p = argparse.ArgumentParser(description="Shell:B fleet node")
    p.add_argument("--token", default=os.environ.get("SHELLB_NODE_TOKEN"), help="the token from Shell:B (or SHELLB_NODE_TOKEN)")
    p.add_argument("--host", help="address to listen on (default: this machine's Tailscale IP, else all interfaces)")
    p.add_argument("--port", type=int, default=8211)
    p.add_argument("--ollama", default=os.environ.get("SHELLB_NODE_OLLAMA", "http://127.0.0.1:11434"))
    p.add_argument("--install-service", action="store_true", help="run at login from now on, then exit")
    p.add_argument("-v", "--verbose", action="store_true")
    ARGS = p.parse_args()
    if not ARGS.token or len(ARGS.token) < 16:
        p.error("--token is required (Shell:B → Models → Fleet shows it when you add this machine)")
    if ARGS.install_service:
        return install_service(sys.argv[1:])
    host = ARGS.host or tailscale_ip() or "0.0.0.0"
    if host == "0.0.0.0":
        print("No Tailscale address found: listening on every interface. Only the token protects it; prefer a private network.")
    try:
        ollama_get("/api/version")
    except OSError:
        print(f"Warning: Ollama doesn't answer at {ARGS.ollama}. Install or start it; Shell:B will see this machine once it does.")
    srv = ThreadingHTTPServer((host, ARGS.port), Handler)
    srv.daemon_threads = True
    print(f"Shell:B node {VERSION} on http://{host}:{ARGS.port} → Ollama {ARGS.ollama}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
