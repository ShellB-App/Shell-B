"""Shell:B Guest cells: each guest's own Shell:B in a container, and the host-side broker it reaches the machine through.

Layout (docs/plans/guest-cells.md has the full design):
    browser ── guest gateway (guest_app.py, guest port) ──unix socket──▶ cell container "shellb-cell-<gid>"
                                                                           Shell:B in cell mode (cell_boot.py)
                                                                           │ localhost:11434, :8001 … (cell/entry.py)
                     broker (this module, in the host process) ◀──unix sockets──┘

- **A cell** runs the unmodified Shell:B code with SHELLB_CELL=1, `--network none`, a read-only root, every capability
  dropped, its own unprivileged uid (UID_BASE + n, never the owner's), memory/CPU/pid limits, and these mounts only:
  the code and built UI (read-only), the guest's data dir (read-write, /app/data), the broker's sockets (read-only),
  its own web socket dir, and the offline wiki, maps and law (read-only). No Docker socket, no home directory.
- **Identity comes from the filesystem.** Each cell gets its own broker sockets in data/cells/<gid>/sock, a directory
  the cell can't write. Uvicorn reports the socket a request arrived on in scope["server"], so the broker knows which
  cell and service it serves without trusting anything the cell sends.
- **The broker allows only safe requests** (POLICIES): chat, embeddings and model info for the models shared with
  guests, with dangerous options dropped; ComfyUI graphs made only of the nodes and model files Shell:B's own image, 3D
  and cut-out tools use, writing only under output/cells/<gid>; Kokoro speech, transcription and the music and sound
  generators with clamped lengths; SearXNG searches; Valhalla routes. Model pulls, deletes, voice cloning, unloads and
  everything else are refused. JSON bodies are rebuilt from allowed fields, never passed through.
- **Fair use:** generation waits behind the owner's own turns (up to ownerWait seconds) and shares the guest slots
  with every other guest (guests.slots). Pictures and audio count against the guest's daily caps here.
- **The gateway's proxy** connects to the cell's web socket only after checking, on an O_PATH descriptor, that it is a
  socket owned by the cell's uid (a cell could otherwise put a symlink to some host socket there), and adds the
  cell's gate secret (auth.CELL_HEADER). The guest's cookie and any gate header from the browser are stripped.
- **Lifecycle:** started on the guest's first request, stopped after IDLE seconds without requests or turns, at most
  `cellsMax` (guest setting) at once. Deleting a guest wipes its cell with a root helper container, since the files
  belong to the cell's uid.
"""
import asyncio
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpcore
import httpx
import uvicorn
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

import db
import guests
import providers
from roster import get_settings
from tools import BIREFNET, COMFY, HUNYUAN3D, OLLAMA, ORPHEUS, SEARXNG

WEB = Path(__file__).resolve().parent.parent
ROOT = db.DATA / "cells"
SHELLB = Path.home() / "shellb"
IMAGE = os.environ.get("SHELLB_CELL_IMAGE", "shellb-cell:latest")
HELPER_IMAGE = "alpine:latest"
HERMES = "http://localhost:8001"
STABLE_AUDIO = "http://127.0.0.1:8003"
VALHALLA = "http://127.0.0.1:8230"
UID_BASE = 61000
GID_RX = re.compile(r"^guest-[0-9a-f]{12}$")
IDLE = 30 * 60
START_TIMEOUT = 120
LIMITS = ["--memory", "3g", "--memory-swap", "3g", "--cpus", "4", "--pids-limit", "512"]
# service → (port inside the cell, upstream on the host)
SERVICES = {"ollama": (11434, OLLAMA), "hermes": (8001, HERMES), "orpheus": (8002, ORPHEUS),
            "stableaudio": (8003, STABLE_AUDIO), "comfy": (8188, COMFY), "searxng": (8080, SEARXNG),
            "valhalla": (8230, VALHALLA),
            "circles": (8240, None),  # circles.py's store: answered here (circles.broker_app), for this cell's guest only
            "sandbox": (8250, None),  # run_code for the cell (the host runs the sandbox image as the cell's uid) + usage reports
            "egress": (3128, None)}   # a filtered CONNECT/HTTP proxy: the cell's web access without a network (_Egress)
EGRESS_PORTS = {80, 443}
EGRESS_PER_MINUTE = 120
EGRESS_MAX_BYTES = 64 * 2**20
SANDBOX_TIMEOUT = 180
SANDBOX_LIMITS = ["--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256"]
WS_RE = re.compile(r"^(workspaces|projects)/[A-Za-z0-9_-]{1,64}$")
DEV_PID = re.compile(r"^proj-[0-9a-f]{12}$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DEV_LABEL = "shellb.celldev"  # dev-server containers the host runs for cells (never `shellb.dev=1`, the owner's)
GUEST_PORT = int(os.environ.get("SHELLB_GUEST_PORT", "8220"))
_egress_conns: dict[str, list[float]] = {}
_sandbox_locks: dict[str, asyncio.Lock] = {}
_data_bytes: dict[str, tuple[float, int]] = {}
MAX_BODY = 48 * 2**20  # chat with images, uploads
MAX_JSON = 8 * 2**20
SEARCHES_PER_MINUTE = 30
# request headers the gateway never forwards into a cell, and response headers it never forwards out
DROP_REQUEST = {"cookie", "x-shellb-cell-gate", "x-shellb-admin", "x-admin-key", "authorization", "connection",
                "keep-alive", "transfer-encoding", "te", "upgrade", "proxy-connection", "x-forwarded-for",
                "x-forwarded-proto", "x-real-ip", "forwarded"}
DROP_RESPONSE = {"set-cookie", "connection", "keep-alive", "transfer-encoding", "te", "upgrade", "proxy-connection"}


class Refused(Exception):
    """A request the broker won't pass on; the message goes back to the cell."""


@dataclass
class Cell:
    gid: str
    uid: int
    secret: str = ""
    state: str = "stopped"  # starting | running | stopping | stopped
    started: float = 0.0
    last: float = 0.0
    error: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    listener: "_Listener | None" = None
    client: httpx.AsyncClient | None = None


_cells: dict[str, Cell] = {}
_socks: dict[str, tuple[str, str]] = {}  # broker socket path → (gid, service)
_prompts: dict[str, str] = {}  # ComfyUI prompt id → gid
_searches: dict[str, list[float]] = {}
_up: httpx.AsyncClient | None = None
_reaper: asyncio.Task | None = None


def init():
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS guest_cells(guest_id TEXT PRIMARY KEY, uid INTEGER UNIQUE, created REAL)")


def name(gid: str) -> str:
    return f"shellb-cell-{gid.removeprefix('guest-')}"


def _dir(gid: str) -> Path:
    if not GID_RX.match(gid):
        raise ValueError(f"bad guest id {gid!r}")
    return ROOT / gid


def uid_of(gid: str) -> int:
    with db.conn() as c:
        r = c.execute("SELECT uid FROM guest_cells WHERE guest_id=?", (gid,)).fetchone()
        if r:
            return r["uid"]
        uid = (c.execute("SELECT max(uid) FROM guest_cells").fetchone()[0] or UID_BASE) + 1
        c.execute("INSERT INTO guest_cells VALUES(?,?,?)", (gid, uid, time.time()))
    return uid


def enabled(guest: dict | None) -> bool:
    return bool(guest and guest["config"].get("cell"))


def _cell(gid: str) -> Cell:
    if gid not in _cells:
        _cells[gid] = Cell(gid, uid_of(gid))
    return _cells[gid]


# ── docker ──────────────────────────────────────────────────────────────────

async def _docker(*args: str, timeout: float = 60) -> tuple[int, str]:
    p = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        return 124, "timed out"
    return p.returncode or 0, out.decode(errors="replace").strip()


def _helper(gid: str, script: str) -> list[str]:
    """A throwaway root container that may change the cell's files (they belong to the cell's uid, not the owner)."""
    return ["run", "--rm", "--network", "none", "--user", "0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
            "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "-v", f"{_dir(gid)}:/c", HELPER_IMAGE, "sh", "-c", script]


async def _prepare(cell: Cell):
    """data/cells/<gid>/: data (the cell's, 0700) and web (its socket, 0755) belong to the cell's uid; sock (the
    broker's sockets) and the folder itself stay the owner's, so the cell can't swap them."""
    d = _dir(cell.gid)
    for sub, mode in (("", 0o711), ("sock", 0o755), ("data", 0o700), ("web", 0o755)):
        p = d / sub if sub else d
        p.mkdir(parents=True, exist_ok=True)
        if p.stat().st_uid == os.getuid():
            p.chmod(mode)
    if (d / "data").stat().st_uid != cell.uid or (d / "web").stat().st_uid != cell.uid:
        rc, out = await _docker(*_helper(cell.gid, f"chown {cell.uid}:{cell.uid} /c/data /c/web"))
        if rc:
            raise RuntimeError(f"couldn't hand the cell its folders: {out[-300:]}")


def _run_args(cell: Cell, guest: dict) -> list[str]:
    d, s = _dir(cell.gid), get_settings()
    models = {"models": allowed_models(), "embeddingModel": s.get("embeddingModel"), "utilityModel": s.get("utilityModel"),
              "visionFallbackModel": s.get("visionFallbackModel")}
    env = {"SHELLB_CELL": "1", "SHELLB_CELL_SECRET": cell.secret, "SHELLB_CELL_FRAME_SECRET": guests.frame_secret(cell.gid),
           "SHELLB_CELL_GUEST": guest["name"], "SHELLB_CELL_MODELS": json.dumps(models), "SHELLB_DEV_DIR": "/run/web/dev",
           "SHELLB_CELL_FORWARD": ",".join(f"{port}:{svc}" for svc, (port, _up) in SERVICES.items()),
           "HOME": "/home/cell", "TZ": os.environ.get("TZ") or _host_tz(), "PYTHONDONTWRITEBYTECODE": "1",
           # web access goes through the host's filtered proxy (_Egress); the model services stay direct
           "HTTP_PROXY": "http://127.0.0.1:3128", "HTTPS_PROXY": "http://127.0.0.1:3128", "http_proxy": "http://127.0.0.1:3128",
           "https_proxy": "http://127.0.0.1:3128", "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"}
    mounts = [(WEB / "server", "/app/server", "ro"), (WEB / "cell", "/app/cell", "ro"), (WEB / "ui" / "dist", "/app/ui/dist", "ro"),
              (WEB / "ui" / "src" / "cdnMap.json", "/app/ui/src/cdnMap.json", "ro"),
              (WEB / "ui" / "public" / "studio-inspector.js", "/app/ui/public/studio-inspector.js", "ro"),
              (WEB / "docs" / "changelog.json", "/app/docs/changelog.json", "ro"),
              (d / "data", "/app/data", "rw"), (d / "sock", "/run/shellb", "ro"), (d / "web", "/run/web", "rw")]
    mounts += [(SHELLB / x, f"/home/cell/shellb/{x}", "ro") for x in ("wiki", "maps", "legal") if (SHELLB / x).is_dir()]
    args = ["run", "-d", "--name", name(cell.gid), "--label", f"shellb.cell={cell.gid}", "--network", "none",
            "--read-only", "--cap-drop", "ALL", "--user", f"{cell.uid}:{cell.uid}", *LIMITS,
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
            "--tmpfs", f"/home/cell:rw,nosuid,nodev,size=64m,uid={cell.uid},gid={cell.uid},mode=0700"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    for src, dst, mode in mounts:
        if src.exists():
            args += ["-v", f"{src}:{dst}:{mode}"]
    return args + [IMAGE]


def _host_tz() -> str:
    try:
        return str(Path("/etc/timezone").read_text().strip()) or "UTC"
    except OSError:
        return "UTC"


# ── lifecycle ───────────────────────────────────────────────────────────────

async def ensure(guest: dict) -> Cell:
    """The guest's cell, running; started (and waited for) if it wasn't."""
    cell = _cell(guest["id"])
    cell.last = time.time()
    if cell.state == "running":
        return cell
    async with cell.lock:
        if cell.state == "running":
            return cell
        await _make_room(cell.gid)
        cell.state, cell.error = "starting", ""
        try:
            await _start(cell, guest)
        except Exception as e:
            cell.state, cell.error = "stopped", str(e)[:300]
            await _teardown(cell)
            raise
        cell.state, cell.started = "running", time.time()
    return cell


async def _start(cell: Cell, guest: dict):
    await _prepare(cell)
    await _docker("rm", "-f", name(cell.gid))
    cell.secret = secrets.token_urlsafe(32)
    cell.listener = _Listener(cell.gid)
    await cell.listener.start()
    rc, out = await _docker(*_run_args(cell, guest), timeout=60)
    if rc:
        raise RuntimeError(f"the cell didn't start: {out[-300:]}")
    cell.client = _cell_client(cell)
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        try:
            r = await cell.client.get("/api/auth/me", headers={"x-shellb-cell-gate": cell.secret}, timeout=5)
            if r.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        rc, state = await _docker("inspect", "-f", "{{.State.Status}}", name(cell.gid))
        if rc or state not in ("created", "running"):
            _, logs = await _docker("logs", "--tail", "20", name(cell.gid))
            raise RuntimeError(f"the cell stopped while starting: {logs[-500:]}")
        await asyncio.sleep(1)
    raise RuntimeError("the cell took too long to start")


async def _teardown(cell: Cell):
    import devserver
    for pid in [p for p, (_s, _u, g) in list(devserver._cell_socks.items()) if g == cell.gid]:
        await devserver.stop(pid)
    if cell.client:
        await cell.client.aclose()
        cell.client = None
    if cell.listener:
        await cell.listener.stop()
        cell.listener = None
    await _docker("rm", "-f", name(cell.gid), timeout=30)


async def stop(gid: str):
    cell = _cells.get(gid)
    if not cell:
        await _docker("rm", "-f", name(gid), timeout=30)
        return
    async with cell.lock:
        cell.state = "stopping"
        await _teardown(cell)
        cell.state = "stopped"


async def _busy(cell: Cell) -> bool:
    """Whether the cell has a turn or job in flight (its own /api/status), so idling out would cut it off."""
    try:
        r = await cell.client.get("/api/status", headers={"x-shellb-cell-gate": cell.secret}, timeout=10)
        s = r.json()
        return bool(s.get("active") or s.get("notebook") or s.get("todo") or s.get("generate") or s.get("megaPlan"))
    except (httpx.HTTPError, ValueError, AttributeError):
        return False


async def _make_room(gid: str):
    running = [c for c in _cells.values() if c.state in ("running", "starting") and c.gid != gid]
    cap = int(guests.settings().get("cellsMax") or 3)
    if len(running) < cap:
        return
    for c in sorted(running, key=lambda c: c.last):
        if c.state == "running" and time.time() - c.last > 120 and not await _busy(c):
            await stop(c.gid)
            return
    raise RuntimeError("Shell:B is busy with other guests right now. Try again in a few minutes.")


async def _reap():
    while True:
        await asyncio.sleep(60)
        for c in list(_cells.values()):
            try:
                if c.state == "running" and time.time() - c.last > IDLE and not await _busy(c):
                    await stop(c.gid)
                elif c.state == "running" and c.client:  # the container died under us: forget it
                    rc, state = await _docker("inspect", "-f", "{{.State.Status}}", name(c.gid))
                    if rc or state != "running":
                        await stop(c.gid)
            except Exception as e:  # noqa: BLE001  one bad cell doesn't stop the reaper
                print(f"cells: reaper: {type(e).__name__}: {e}")


def startup():
    """Host startup: cells from the last run lost their broker with it, so they go; then the idle reaper starts."""
    global _reaper

    async def go():
        for label in ("shellb.cell", DEV_LABEL):
            rc, ids = await _docker("ps", "-aq", "--filter", f"label={label}")
            if not rc and ids.split():
                await _docker("rm", "-f", *ids.split(), timeout=60)
    asyncio.get_running_loop().create_task(go())
    _reaper = asyncio.get_running_loop().create_task(_reap())


async def shutdown():
    if _reaper:
        _reaper.cancel()
    for c in list(_cells.values()):
        if c.state != "stopped":
            try:
                await asyncio.wait_for(_teardown(c), 10)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001  the next startup removes leftovers
                pass


def forget(gid: str):
    """Delete a guest's cell and everything in it (guests.delete_guest; runs in a worker thread)."""
    _cells.pop(gid, None)
    subprocess.run(["docker", "rm", "-f", name(gid)], capture_output=True, timeout=60)
    devs = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={DEV_LABEL}={gid}"], capture_output=True, text=True, timeout=60)
    if devs.stdout.split():
        subprocess.run(["docker", "rm", "-f", *devs.stdout.split()], capture_output=True, timeout=60)
    d = _dir(gid)
    if d.exists():
        subprocess.run(["docker", *_helper(gid, "rm -rf /c/data /c/web")], capture_output=True, timeout=120)
        shutil.rmtree(d, ignore_errors=True)
    with db.conn() as c:
        c.execute("DELETE FROM guest_cells WHERE guest_id=?", (gid,))


def status(gid: str) -> dict:
    c = _cells.get(gid)
    return {"state": c.state if c else "stopped", "started": c.started if c else None, "lastActive": c.last if c else None,
            "error": c.error if c else ""}


# ── the gateway's proxy into a cell ─────────────────────────────────────────

class _CellSocket(httpcore.AsyncNetworkBackend):
    """Connects only to a socket owned by the cell's uid, checked on an O_PATH descriptor and connected through it,
    so the cell can't swap in a symlink to some host socket between the check and the connect."""

    def __init__(self, path: Path, uid: int):
        self.path, self.uid, self.inner = str(path), uid, httpcore.AnyIOBackend()

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        try:
            fd = os.open(self.path, os.O_PATH | os.O_NOFOLLOW)
        except OSError as e:
            raise httpcore.ConnectError(f"cell socket: {e}") from e
        try:
            st = os.fstat(fd)
            if not stat.S_ISSOCK(st.st_mode) or st.st_uid != self.uid:
                raise httpcore.ConnectError("cell socket isn't the cell's own socket")
            return await self.inner.connect_unix_socket(f"/proc/self/fd/{fd}", timeout, socket_options)
        finally:
            os.close(fd)

    async def connect_tcp(self, *args, **kwargs):
        raise httpcore.ConnectError("cells are reached over their socket only")

    async def sleep(self, seconds):
        await self.inner.sleep(seconds)


def _cell_client(cell: Cell, path: Path | None = None) -> httpx.AsyncClient:
    transport = httpx.AsyncHTTPTransport()
    transport._pool = httpcore.AsyncConnectionPool(uds="cell", max_connections=64,
                                                   network_backend=_CellSocket(path or _dir(cell.gid) / "web" / "web.sock", cell.uid))
    return httpx.AsyncClient(transport=transport, base_url="http://cell", trust_env=False,
                             timeout=httpx.Timeout(connect=10, read=None, write=120, pool=30))


async def proxy(req: Request, guest: dict, gate: bool = True) -> Response:
    """Forward a request from the guest's browser to their cell and stream the answer back (SSE included). A cell
    that refuses the connection (its container died) is restarted once; nothing of the request was sent yet."""
    has_body = req.method in ("POST", "PUT", "PATCH", "DELETE")
    body = req.stream() if has_body else None
    for attempt in (1, 2):
        try:
            cell = await ensure(guest)
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"detail": f"Your Shell:B couldn't start: {e}"}, status_code=503, headers={"Retry-After": "30"})
        cell.last = time.time()
        headers = [(k, v) for k, v in req.headers.raw if k.decode("latin-1").lower() not in DROP_REQUEST]
        if gate:
            headers.append((b"x-shellb-cell-gate", cell.secret.encode()))
        headers.append((b"x-forwarded-proto", (req.headers.get("x-forwarded-proto") or req.url.scheme).encode("latin-1")))
        upstream = cell.client.build_request(req.method, httpx.URL(path=req.url.path, query=req.url.query.encode("latin-1")),
                                             headers=headers, content=body)
        try:
            r = await cell.client.send(upstream, stream=True)
            break
        except httpx.ConnectError:
            if attempt == 2:
                return JSONResponse({"detail": "Your Shell:B didn't answer. Try again in a minute."}, status_code=502)
            await stop(cell.gid)
        except httpx.HTTPError as e:
            return JSONResponse({"detail": f"Your Shell:B didn't answer ({type(e).__name__})"}, status_code=502)
    out = [(k, v) for k, v in r.headers.raw if k.decode("latin-1").lower() not in DROP_RESPONSE]
    resp = StreamingResponse(r.aiter_raw(), status_code=r.status_code, background=BackgroundTask(r.aclose))
    resp.raw_headers = out
    return resp


def frame_owner(key: str) -> dict | None:
    """The cell guest whose frame secret signed this /api/k/ key (sandboxed frames carry no cookie)."""
    import hmac

    import auth
    m = auth.SCOPED_KEY.match(key or "")
    if not m:
        return None
    for g in guests.list_guests():
        if enabled(g) and not g["disabled"] and hmac.compare_digest(auth.frame_mac(guests.frame_secret(g["id"]), m.group(1)), m.group(2)):
            return g
    return None


# ── the broker ──────────────────────────────────────────────────────────────

class _Listener:
    """One cell's broker sockets (data/cells/<gid>/sock/<service>.sock), served by the broker app below."""

    def __init__(self, gid: str, directory: Path | None = None):
        self.gid, self.dir = gid, directory or _dir(gid) / "sock"
        self.paths: list[str] = []
        self.server: uvicorn.Server | None = None
        self.egress: asyncio.AbstractServer | None = None

    async def start(self):
        socks = []
        egress_path = str(self.dir / "egress.sock")
        try:
            os.unlink(egress_path)
        except FileNotFoundError:
            pass
        self.egress = await asyncio.start_unix_server(lambda r, w: _egress_conn(self.gid, r, w), path=egress_path)
        os.chmod(egress_path, 0o666)
        self.paths.append(egress_path)
        for svc in SERVICES:
            if svc == "egress":
                continue
            path = str(self.dir / f"{svc}.sock")
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.bind(path)
            os.chmod(path, 0o666)  # the cell's uid connects; the folder is the owner's, so nothing can be swapped in
            s.listen(128)
            socks.append(s)
            self.paths.append(path)
            _socks[path] = (self.gid, svc)
        config = uvicorn.Config(broker, lifespan="off", log_level="warning", proxy_headers=False, access_log=False)
        config.load()
        self.server = uvicorn.Server(config)
        self.server.lifespan = config.lifespan_class(config)
        await self.server.startup(sockets=socks)

    async def stop(self):
        if self.egress:
            self.egress.close()
            self.egress = None
        if self.server:
            for srv in getattr(self.server, "servers", []):
                srv.close()
            for conn in list(self.server.server_state.connections):
                conn.shutdown()
        for p in self.paths:
            _socks.pop(p, None)
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
        self.paths = []


def _upstream() -> httpx.AsyncClient:
    global _up
    if _up is None or _up.is_closed:
        _up = httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(connect=10, read=900, write=120, pool=60))
    return _up


def allowed_models() -> list[str]:
    """What a cell's Ollama calls may name: the guest model list plus the embedding, utility and vision models."""
    s = get_settings()
    extra = [s.get("embeddingModel"), s.get("utilityModel"), s.get("visionFallbackModel")]
    out = []
    for m in guests.allowed_models() + extra:
        if m and not providers.is_cloud(m) and m not in out:
            out.append(m)
    return out


def _tag(model) -> str:
    m = str(model or "").strip()
    return m if ":" in m else f"{m}:latest"


async def _json(req: Request, cap: int = MAX_JSON) -> dict:
    raw = await _read(req, cap)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise Refused("send JSON")
    if not isinstance(body, dict):
        raise Refused("send a JSON object")
    return body


async def _read(req: Request, cap: int) -> bytes:
    if int(req.headers.get("content-length") or 0) > cap:
        raise Refused("request too large")
    chunks, size = [], 0
    async for chunk in req.stream():
        size += len(chunk)
        if size > cap:
            raise Refused("request too large")
        chunks.append(chunk)
    return b"".join(chunks)


class _Turn:
    """A generation slot: waits for a guest slot, then for the owner's own turns (up to ownerWait seconds)."""

    def __init__(self):
        self.sem = guests.slots()
        self.held = False

    async def __aenter__(self):
        await self.sem.acquire()
        self.held = True
        t0, wait = time.time(), guests.settings()["ownerWait"]
        while guests.owner_busy() and time.time() - t0 < wait:
            await asyncio.sleep(1)
        return self

    def release(self):
        if self.held:
            self.held = False
            self.sem.release()

    async def __aexit__(self, *exc):
        self.release()


async def _relay(method: str, url: str, *, gated: bool = False, json_body=None, content=None, headers=None,
                 params=None, timeout=None) -> Response:
    """Send to the upstream service and stream its answer back; a generation slot is held until the stream ends."""
    turn = _Turn() if gated else None
    if turn:
        await turn.__aenter__()
    try:
        client = _upstream()
        r = await client.send(client.build_request(method, url, json=json_body, content=content, headers=headers,
                                                   params=params, timeout=timeout), stream=True)
    except httpx.HTTPError as e:
        if turn:
            turn.release()
        return JSONResponse({"error": f"service unavailable ({type(e).__name__})"}, status_code=502)
    except BaseException:
        if turn:
            turn.release()
        raise

    async def done():
        await r.aclose()
        if turn:
            turn.release()
    keep = {"content-type", "content-disposition", "x-orpheus-model", "x-orpheus-duration", "x-orpheus-sample-rate"}
    hdrs = {k: v for k, v in r.headers.items() if k.lower() in keep}
    return StreamingResponse(_decoded(r), status_code=r.status_code, headers=hdrs, background=BackgroundTask(done))


async def _decoded(r: httpx.Response):
    """The body decoded (Content-Encoding isn't passed on), as it arrives; a body already read is sent whole."""
    if r.is_stream_consumed:
        yield r.content
        return
    async for chunk in r.aiter_bytes():
        yield chunk


async def _fetch_json(method: str, url: str, **kw):
    r = await _upstream().request(method, url, **kw)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def _caps(gid: str, kind: str):
    g = guests.get_guest(gid)
    if not g or g["disabled"]:
        raise Refused("this guest is paused")
    cap = g["config"].get(f"{kind}PerDay") or 0
    if cap and guests.usage(gid)[kind] >= cap:
        raise Refused(f"today's {cap} {'pictures' if kind == 'images' else 'audio clips'} are used up; they reset at midnight")


# ── Ollama ──────────────────────────────────────────────────────────────────

OLLAMA_OPTIONS = {"temperature", "top_p", "top_k", "min_p", "typical_p", "repeat_penalty", "repeat_last_n",
                  "presence_penalty", "frequency_penalty", "seed", "stop", "num_predict", "mirostat", "mirostat_tau",
                  "mirostat_eta", "tfs_z", "num_ctx"}
OLLAMA_FIELDS = {
    "/api/chat": {"model", "messages", "tools", "format", "options", "stream", "think"},
    "/api/generate": {"model", "prompt", "suffix", "images", "format", "options", "system", "template", "stream", "raw",
                      "think", "context"},
    "/api/embed": {"model", "input", "truncate", "options", "dimensions"},
    "/v1/chat/completions": {"model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice",
                             "response_format", "seed", "stop", "frequency_penalty", "presence_penalty"},
    "/api/show": {"model", "name", "verbose"},
}
MAX_PREDICT = 16384
EMBED_CTX = 2048


def ollama_body(path: str, body: dict, allowed: list[str], embed_model: str | None) -> dict:
    """The request a cell may send to Ollama: allowed fields of an allowed model, safe options, the owner's keep_alive.
    num_ctx is dropped (a different value makes Ollama reload the model the owner is using), except the embedding
    model's short context, which is what Shell:B itself sends."""
    fields = OLLAMA_FIELDS.get(path)
    if fields is None:
        raise Refused(f"{path} isn't available to guests")
    out = {k: v for k, v in body.items() if k in fields}
    model = out.get("model") or out.get("name")
    if _tag(model) not in {_tag(m) for m in allowed}:
        raise Refused(f"model {model!r} isn't shared with guests")
    if path == "/api/show":
        return {"model": model}
    if path == "/api/chat" and not (isinstance(out.get("messages"), list) and out["messages"]):
        raise Refused("messages can't be empty")
    if path == "/v1/chat/completions" and not (isinstance(out.get("messages"), list) and out["messages"]):
        raise Refused("messages can't be empty")
    if path == "/api/generate" and not (isinstance(out.get("prompt"), str) and out["prompt"].strip()):
        raise Refused("prompt can't be empty")
    if path == "/api/embed" and not out.get("input"):
        raise Refused("input can't be empty")
    opts = out.get("options") if isinstance(out.get("options"), dict) else {}
    opts = {k: v for k, v in opts.items() if k in OLLAMA_OPTIONS}
    ctx = opts.pop("num_ctx", None)
    if path == "/api/embed" and embed_model and _tag(model) == _tag(embed_model) and ctx == EMBED_CTX:
        opts["num_ctx"] = EMBED_CTX
    if "num_predict" in opts:
        try:
            opts["num_predict"] = max(1, min(MAX_PREDICT, int(opts["num_predict"])))
        except (TypeError, ValueError):
            opts.pop("num_predict")
    if "max_tokens" in out:
        try:
            out["max_tokens"] = max(1, min(MAX_PREDICT, int(out["max_tokens"])))
        except (TypeError, ValueError):
            out.pop("max_tokens")
    if path != "/v1/chat/completions":
        out["options"] = opts
        out["keep_alive"] = "2h"  # what Shell:B itself sends: never 0 (unloads the owner's model) or forever
    return out


async def _ollama(req: Request, gid: str) -> Response:
    path, s = req.url.path, get_settings()
    allowed = allowed_models()
    if req.method == "GET" and path in ("/api/tags", "/api/ps"):
        code, data = await _fetch_json("GET", f"{OLLAMA}{path}")
        names = {_tag(m) for m in allowed}
        data["models"] = [m for m in data.get("models") or [] if _tag(m.get("name") or m.get("model")) in names]
        return JSONResponse(data, status_code=code)
    if req.method == "GET" and path == "/api/version":
        code, data = await _fetch_json("GET", f"{OLLAMA}/api/version")
        return JSONResponse({"version": data.get("version", "")}, status_code=code)
    if req.method != "POST":
        raise Refused(f"{req.method} {path} isn't available to guests")
    if path in ("/api/chat", "/api/generate", "/v1/chat/completions"):
        _turn_caps(gid)
    body = ollama_body(path, await _json(req, MAX_BODY), allowed, s.get("embeddingModel"))
    gated = path in ("/api/chat", "/api/generate", "/v1/chat/completions")
    return await _relay("POST", f"{OLLAMA}{path}", gated=gated, json_body=body)


# ── ComfyUI ─────────────────────────────────────────────────────────────────

FLUX_SCHNELL = "flux1-schnell-fp8.safetensors"
# node class → {input: the only value allowed} for model files; nodes not listed here are refused
COMFY_NODES = {
    "UNETLoader": {"unet_name": {FLUX_SCHNELL}},
    "DualCLIPLoader": {"clip_name1": {"t5xxl_fp8_e4m3fn.safetensors"}, "clip_name2": {"clip_l.safetensors"}},
    "VAELoader": {"vae_name": {"ae.safetensors"}},
    "ImageOnlyCheckpointLoader": {"ckpt_name": {HUNYUAN3D}},
    "LoadBackgroundRemovalModel": {"bg_removal_name": {BIREFNET}},
    "CLIPTextEncode": {}, "EmptyLatentImage": {}, "KSampler": {}, "VAEDecode": {}, "SaveImage": {}, "LoadImage": {},
    "RemoveBackground": {}, "MaskToImage": {}, "EmptyImage": {}, "ImageCompositeMasked": {}, "ModelSamplingAuraFlow": {},
    "CLIPVisionEncode": {}, "Hunyuan3Dv2Conditioning": {}, "EmptyLatentHunyuan3Dv2": {}, "VAEDecodeHunyuan3D": {},
    "VoxelToMesh": {}, "SaveGLB": {}, "FluxGuidance": {},
}
# numbers clamped per node input: (lowest, highest)
COMFY_CLAMP = {
    ("EmptyLatentImage", "width"): (64, 2048), ("EmptyLatentImage", "height"): (64, 2048),
    ("EmptyLatentImage", "batch_size"): (1, 1), ("EmptyImage", "width"): (1, 2048), ("EmptyImage", "height"): (1, 2048),
    ("EmptyImage", "batch_size"): (1, 1), ("KSampler", "steps"): (1, 50),
    ("EmptyLatentHunyuan3Dv2", "resolution"): (256, 4096), ("EmptyLatentHunyuan3Dv2", "batch_size"): (1, 1),
    ("VAEDecodeHunyuan3D", "num_chunks"): (1000, 16000), ("VAEDecodeHunyuan3D", "octree_resolution"): (64, 512),
}
MAX_NODES = 64
MAX_TEXT = 8000
UPLOAD_MAX = 20 * 2**20


def comfy_prefix(gid: str, prefix) -> str:
    """Every file a cell's graph saves goes under output/cells/<gid>/ (a "3d/" subfolder may stay)."""
    p = str(prefix or "ShellB_Web")
    sub = "3d/" if p.startswith("3d/") else ""
    base = re.sub(r"[^A-Za-z0-9_-]", "", p.rsplit("/", 1)[-1])[:40] or "ShellB_Web"
    return f"cells/{gid}/{sub}{base}"


def comfy_graph(gid: str, graph) -> dict:
    """A ComfyUI graph a cell may queue: known nodes only, pinned model files, clamped sizes, its own uploads and
    output folder, links only between its own nodes."""
    if not isinstance(graph, dict) or not 0 < len(graph) <= MAX_NODES:
        raise Refused("the graph must be 1 to 64 nodes")
    out = {}
    for nid, node in graph.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise Refused(f"node {nid}: malformed")
        cls = node.get("class_type")
        if cls not in COMFY_NODES:
            raise Refused(f"node type {cls!r} isn't available to guests")
        inputs = {}
        for k, v in node["inputs"].items():
            if isinstance(v, list):
                if len(v) != 2 or str(v[0]) not in graph or not isinstance(v[1], int) or isinstance(v[1], bool):
                    raise Refused(f"node {nid}: bad link in {k}")
                inputs[k] = [str(v[0]), v[1]]
                continue
            if not isinstance(v, (str, int, float, bool)) and v is not None:
                raise Refused(f"node {nid}: bad value for {k}")
            if isinstance(v, str) and len(v) > MAX_TEXT:
                raise Refused(f"node {nid}: {k} is too long")
            pinned = COMFY_NODES[cls].get(k)
            if pinned is not None and v not in pinned:
                raise Refused(f"node {nid}: {k} {v!r} isn't available to guests")
            lim = COMFY_CLAMP.get((cls, k))
            if lim and isinstance(v, (int, float)) and not isinstance(v, bool):
                v = max(lim[0], min(lim[1], v))
            inputs[k] = v
        for k in COMFY_NODES[cls]:
            if k not in inputs:
                raise Refused(f"node {nid}: {k} is required")
        if cls in ("SaveImage", "SaveGLB"):
            inputs["filename_prefix"] = comfy_prefix(gid, inputs.get("filename_prefix"))
        if cls == "LoadImage" and not str(inputs.get("image", "")).startswith(f"cell-{gid}-"):
            raise Refused("LoadImage can only read pictures this guest uploaded")
        out[str(nid)] = {"class_type": cls, "inputs": inputs}
    return out


async def _comfy(req: Request, gid: str) -> Response:
    path, method = req.url.path, req.method
    if method == "POST" and path == "/prompt":
        _caps(gid, "images")
        body = await _json(req)
        graph = comfy_graph(gid, body.get("prompt"))
        async with _Turn():
            code, data = await _fetch_json("POST", f"{COMFY}/prompt", json={"prompt": graph, "client_id": f"cell-{gid}"})
        pid = data.get("prompt_id") if isinstance(data, dict) else None
        if code == 200 and pid:
            _prompts[str(pid)] = gid
            if len(_prompts) > 5000:
                for k in list(_prompts)[:1000]:
                    _prompts.pop(k, None)
            guests._bump(gid, "images")
        return JSONResponse(data, status_code=code)
    m = re.fullmatch(r"/history/([0-9a-fA-F-]{8,64})", path)
    if method == "GET" and m:
        if _prompts.get(m.group(1)) != gid:
            raise Refused("not one of this guest's pictures")
        code, data = await _fetch_json("GET", f"{COMFY}/history/{m.group(1)}")
        return JSONResponse(data, status_code=code)
    if method == "GET" and path == "/view":
        q = req.query_params
        sub, fname = q.get("subfolder", ""), q.get("filename", "")
        if q.get("type", "output") != "output" or not (sub == f"cells/{gid}" or sub.startswith(f"cells/{gid}/")) \
                or ".." in sub or not fname or "/" in fname or "\\" in fname or fname.startswith("."):
            raise Refused("not one of this guest's files")
        return await _relay("GET", f"{COMFY}/view", params={"filename": fname, "subfolder": sub, "type": "output"})
    if method == "POST" and path == "/upload/image":
        form = await req.form(max_files=1, max_fields=4)
        f = form.get("image")
        data = await f.read(UPLOAD_MAX + 1) if f is not None and hasattr(f, "read") else b""
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > UPLOAD_MAX:
            raise Refused("uploads must be PNG pictures under 20 MB")
        fname = f"cell-{gid}-{secrets.token_hex(8)}.png"
        code, out = await _fetch_json("POST", f"{COMFY}/upload/image", files={"image": (fname, data, "image/png")},
                                      data={"type": "input", "overwrite": "false"})
        return JSONResponse(out, status_code=code)
    if method == "POST" and path == "/free":
        await _upstream().post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True})
        return JSONResponse({})
    if method == "GET" and path == "/system_stats":
        code, _ = await _fetch_json("GET", f"{COMFY}/system_stats")
        return JSONResponse({}, status_code=code)
    raise Refused(f"{method} {path} isn't available to guests")


# ── speech, music, sound ────────────────────────────────────────────────────

KOKORO = re.compile(r"^[a-z]{2}_[a-z]+$")


def tts_body(body: dict) -> dict:
    """Kokoro voices only (designed and cloned voices, effects and styles are the owner's); text and speed bounded."""
    text = str(body.get("text") or "")[:5000]
    if not text.strip():
        raise Refused("nothing to say")
    voice = str(body.get("voice") or "")
    try:
        speed = max(0.5, min(2.0, float(body.get("speed") or 1.0)))
    except (TypeError, ValueError):
        speed = 1.0
    return {"text": text, "voice": voice if KOKORO.match(voice) else "af_heart", "speed": speed,
            "format": "mp3" if body.get("format") == "mp3" else "wav"}


def _clamp(v, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def _prompt(body: dict) -> str:
    p = str(body.get("prompt") or "").strip()[:2000]
    if not p:
        raise Refused("say what to make")
    return p


def music_body(body: dict) -> dict:
    return {"prompt": _prompt(body), "duration": _clamp(body.get("duration"), 1, 30, 10),
            "temperature": _clamp(body.get("temperature"), 0.1, 2.0, 1.0), "cfg_coef": _clamp(body.get("cfg_coef"), 1, 10, 3)}


def sfx_body(body: dict) -> dict:
    return {"prompt": _prompt(body), "duration": _clamp(body.get("duration"), 0.5, 20, 3),
            "temperature": _clamp(body.get("temperature"), 0.1, 2.0, 1.0), "cfg_coef": _clamp(body.get("cfg_coef"), 1, 10, 3)}


def stable_body(body: dict) -> dict:
    out = {"prompt": _prompt(body), "duration": _clamp(body.get("duration"), 0.5, 30, 5),
           "steps": int(_clamp(body.get("steps"), 10, 150, 100)), "guidance": _clamp(body.get("guidance"), 1, 15, 7)}
    if isinstance(body.get("negative_prompt"), str):
        out["negative_prompt"] = body["negative_prompt"][:500]
    if isinstance(body.get("seed"), int) and not isinstance(body.get("seed"), bool):
        out["seed"] = body["seed"]
    return out


async def _hermes(req: Request, gid: str) -> Response:
    path, method = req.url.path, req.method
    if method == "POST" and path == "/tts":
        return await _relay("POST", f"{HERMES}/tts", json_body=tts_body(await _json(req)), timeout=180)
    if method == "POST" and path == "/stt":
        raw = await _read(req, 25 * 2**20)
        return await _relay("POST", f"{HERMES}/stt", content=raw, headers={"content-type": req.headers.get("content-type", "")},
                            timeout=300)
    if method == "GET" and path == "/tts/voices":
        code, data = await _fetch_json("GET", f"{HERMES}/tts/voices")
        keep = [v for v in data.get("voices") or [] if KOKORO.match(str(v))]
        return JSONResponse({"voices": keep, "details": [d for d in data.get("details") or [] if d.get("id") in keep],
                             "default": data.get("default") if data.get("default") in keep else "af_heart"}, status_code=code)
    if method == "GET" and path == "/tts/lexicon":
        code, data = await _fetch_json("GET", f"{HERMES}/tts/lexicon")
        return JSONResponse(data, status_code=code)
    if method == "POST" and path == "/tts/lexicon/apply":
        body = await _json(req)
        code, data = await _fetch_json("POST", f"{HERMES}/tts/lexicon/apply", json={"text": str(body.get("text") or "")[:5000]})
        return JSONResponse(data, status_code=code)
    if method == "GET" and path == "/health":
        return await _health(f"{HERMES}/health")
    raise Refused(f"{method} {path} isn't available to guests")


async def _health(url: str) -> Response:
    try:
        r = await _upstream().get(url, timeout=10)
        return JSONResponse({"ok": r.status_code == 200}, status_code=r.status_code)
    except httpx.HTTPError:
        return JSONResponse({"ok": False}, status_code=502)


async def _audio(req: Request, gid: str, base: str, routes: dict) -> Response:
    path, method = req.url.path, req.method
    if method == "GET" and path == "/health":
        return await _health(f"{base}/health")
    if method == "POST" and path in routes:
        _caps(gid, "audio")
        body = routes[path](await _json(req))
        resp = await _relay("POST", f"{base}{path}", gated=True, json_body=body, timeout=600)
        if resp.status_code == 200:
            guests._bump(gid, "audio")
        return resp
    raise Refused(f"{method} {path} isn't available to guests")


async def _orpheus(req: Request, gid: str) -> Response:
    return await _audio(req, gid, ORPHEUS, {"/generate": music_body, "/generate/sfx": sfx_body})


async def _stableaudio(req: Request, gid: str) -> Response:
    return await _audio(req, gid, STABLE_AUDIO, {"/generate": stable_body})


# ── search and routes ───────────────────────────────────────────────────────

SEARCH_PARAMS = ("q", "format", "pageno", "categories", "language", "time_range", "safesearch")


def search_params(params) -> dict:
    out = {k: str(params.get(k))[:500] for k in SEARCH_PARAMS if params.get(k)}
    if not out.get("q", "").strip():
        raise Refused("search for something")
    out["format"] = "json"
    return out


async def _searxng(req: Request, gid: str) -> Response:
    path = req.url.path
    if req.method == "GET" and path == "/healthz":
        return await _health(f"{SEARXNG}/healthz")
    if req.method != "GET" or path != "/search":
        raise Refused(f"{req.method} {path} isn't available to guests")
    now = time.time()
    recent = [t for t in _searches.get(gid, []) if now - t < 60]
    if len(recent) >= SEARCHES_PER_MINUTE:
        raise Refused("too many searches this minute")
    _searches[gid] = recent + [now]
    return await _relay("GET", f"{SEARXNG}/search", params=search_params(req.query_params), timeout=30)


def route_body(body: dict) -> dict:
    locs = body.get("locations")
    if not isinstance(locs, list) or not 2 <= len(locs) <= 10:
        raise Refused("a route needs 2 to 10 locations")
    clean = []
    for p in locs:
        if not isinstance(p, dict):
            raise Refused("bad location")
        try:
            loc = {"lat": max(-90.0, min(90.0, float(p["lat"]))), "lon": max(-180.0, min(180.0, float(p["lon"])))}
            if "search_cutoff" in p:
                loc["search_cutoff"] = int(_clamp(p["search_cutoff"], 100, 35000, 3000))
            clean.append(loc)
        except (KeyError, TypeError, ValueError):
            raise Refused("bad location")
    costing = body.get("costing") if body.get("costing") in ("auto", "bicycle", "pedestrian") else "auto"
    out = {"locations": clean, "costing": costing}
    for k in ("units", "language"):
        if isinstance(body.get(k), str):
            out[k] = body[k][:20]
    if isinstance(body.get("directions_options"), dict):
        out["directions_options"] = {k: str(v)[:20] for k, v in body["directions_options"].items() if k in ("units", "language")}
    return out


async def _valhalla(req: Request, gid: str) -> Response:
    path = req.url.path
    if req.method == "GET" and path == "/status":
        return await _health(f"{VALHALLA}/status")
    if req.method == "POST" and path == "/route":
        return await _relay("POST", f"{VALHALLA}/route", json_body=route_body(await _json(req)), timeout=60)
    raise Refused(f"{req.method} {path} isn't available to guests")


def _turn_caps(gid: str):
    """turnsPerDay / tokensPerDay for a cell: the cell reports each turn through the sandbox socket (`POST /usage`)."""
    g = guests.get_guest(gid)
    if not g or g["disabled"]:
        raise Refused("this guest is paused")
    cfg, use = g["config"], guests.usage(gid)
    if cfg.get("turnsPerDay") and use["turns"] >= cfg["turnsPerDay"]:
        raise Refused(f"today's {cfg['turnsPerDay']} replies are used up; they reset at midnight")
    if cfg.get("tokensPerDay") and use["tokens"] >= cfg["tokensPerDay"]:
        raise Refused(f"today's {cfg['tokensPerDay']:,} tokens are used up; they reset at midnight")


# ── sandbox (run_code for cells) ────────────────────────────────────────────

def parse_run_output(stdout: str) -> tuple[str, int | None, list[str]]:
    """The wrapper prints the program's output, then a marker with its exit code, then the files it changed."""
    marker = "\n__SHELLB_RC__ "
    i = stdout.rfind(marker)
    if i < 0:
        return stdout, None, []
    head, tail = stdout[:i], stdout[i + len(marker):]
    lines = tail.splitlines()
    try:
        rc = int(lines[0].strip())
    except (IndexError, ValueError):
        rc = None
    changed = [ln[len("/work/"):] for ln in lines[1:] if ln.startswith("/work/") and "/.git/" not in ln]
    return head, rc, changed


async def _real_dir(gid: str, rel: str) -> Path:
    """The host path of a folder inside the cell's data, after checking (from a root helper, since the folder belongs
    to the cell's uid) that it is a real directory and no part of it is a symlink: Docker resolves a bind source on the
    host, so a link planted by the cell could otherwise mount a host folder into its sandbox."""
    if not shutil.which("docker"):
        raise Refused("the code sandbox isn't available on this machine")
    rc, out = await _docker(*_helper(gid, f'p=$(readlink -f /c/data/{rel}) && test -d "$p" && test "$p" = /c/data/{rel}'), timeout=30)
    if rc:
        raise Refused("that workspace doesn't exist yet" if rc == 1 else f"couldn't check the workspace: {out[-200:]}")
    return _dir(gid) / "data" / rel


async def run_sandbox(gid: str, uid: int, workspace: str, language: str, code: str) -> dict:
    """Run a cell's code on the host: the sandbox image as the cell's uid, only that workspace bound at /work."""
    from tools import CELLS, SANDBOX_IMAGE
    src = await _real_dir(gid, workspace)
    script = CELLS / f"run-{secrets.token_hex(8)}.{'py' if language == 'python' else 'sh'}"
    script.write_text(code)
    os.chmod(script, 0o644)
    runner = "python" if language == "python" else "bash"
    wrapper = (f"touch /tmp/.mark; {runner} /cell/main; rc=$?; echo; echo __SHELLB_RC__ $rc; "
               "find /work -type f -newer /tmp/.mark -not -path '*/.git/*' -not -path '*/__pycache__/*' 2>/dev/null | head -500")
    name = f"shellb-cellrun-{secrets.token_hex(5)}"
    cmd = ["docker", "run", "--rm", "--name", name, "--network", "none", "--cap-drop", "ALL", *SANDBOX_LIMITS, "--read-only",
           "--tmpfs", "/tmp:rw,exec,size=512m", "--user", f"{uid}:{uid}", "-e", "HOME=/tmp", "-e", "MPLBACKEND=Agg", "-e", "PYTHONUNBUFFERED=1",
           # --mount (not -v): a missing source is an error, never a root-owned folder conjured into the cell's data
           "--mount", f"type=bind,src={src},dst=/work", "-v", f"{script}:/cell/main:ro", "-w", "/work", SANDBOX_IMAGE, "bash", "-c", wrapper]
    lock = _sandbox_locks.setdefault(gid, asyncio.Lock())
    t0 = time.time()
    async with lock:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=SANDBOX_TIMEOUT)
            timed_out = False
        except asyncio.TimeoutError:
            await (await asyncio.create_subprocess_exec("docker", "kill", name)).wait()
            out, err = await proc.communicate()
            timed_out = True
        finally:
            script.unlink(missing_ok=True)
    stdout, rc, changed = parse_run_output(out.decode(errors="replace"))
    stderr = err.decode(errors="replace")
    if "bind source path does not exist" in stderr or "invalid mount config" in stderr:
        raise Refused("that workspace doesn't exist yet")
    return {"exit": rc if rc is not None else proc.returncode, "timedOut": timed_out, "elapsed": round(time.time() - t0, 1),
            "stdout": stdout[-200_000:], "stderr": stderr[-50_000:], "changed": changed}


async def _sandbox(req: Request, gid: str) -> Response:
    path = req.url.path
    if req.method == "GET" and path == "/healthz":
        return JSONResponse({"ok": True})
    if req.method != "POST":
        raise Refused(f"{req.method} {path} isn't available to guests")
    body = await _json(req, MAX_JSON)
    if path == "/usage":
        p, c = int(body.get("prompt") or 0), int(body.get("completion") or 0)
        guests._bump(gid, "turns", 1)
        if p + c:
            guests._bump(gid, "tokens", p + c)
        return JSONResponse({"ok": True})
    if path == "/run":
        language = str(body.get("language") or "python").lower()
        code = str(body.get("code") or "")
        ws = str(body.get("workspace") or "")
        if language not in ("python", "bash") or not WS_RE.match(ws) or not code or len(code) > 200_000:
            raise Refused("a run needs language (python|bash), code and a workspace of this cell")
        return JSONResponse(await run_sandbox(gid, _cell(gid).uid, ws, language, code))
    if path.startswith("/dev/"):
        pid = str(body.get("pid") or "")
        if not DEV_PID.match(pid):
            raise Refused("a dev server needs a project id")
        if path == "/dev/start":
            return JSONResponse(await dev_start(gid, _cell(gid).uid, pid, body))
        if path == "/dev/status":
            return JSONResponse(await dev_status(gid, pid))
        if path == "/dev/stop":
            await dev_stop(gid, pid)
            return JSONResponse({"ok": True})
        if path == "/dev/logs":
            return JSONResponse({"logs": await dev_logs(gid, pid, int(body.get("lines") or 200))})
    if path == "/shot":
        return JSONResponse({"tiles": await shot(gid, body)})
    raise Refused(f"{req.method} {path} isn't available to guests")


# ── dev servers for a cell's Studio projects (phase 2b) ────────────────────
# The host runs the project's container (devserver.run_args) as the cell's uid, with the project bound at /work and the
# socket in data/cells/<gid>/web/dev/<pid>, a folder the cell made (0755) so both sides reach it: the cell's own
# devserver.py probes and proxies the app's API through it, and the host's preview proxy (devserver.proxy_app) serves
# the guest's browser over the project's preview host with a ticket signed by the host.

def dev_config(body: dict) -> dict:
    command, port, env = body.get("command"), body.get("port", 8000), body.get("env") or {}
    if not isinstance(command, str) or not command.strip() or len(command) > 2000:
        raise Refused("a dev server needs a command")
    if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
        raise Refused("port must be an integer 1024-65535")
    if not isinstance(env, dict) or len(env) > 32 or not all(isinstance(k, str) and ENV_KEY.match(k) for k in env):
        raise Refused("env must be an object of up to 32 variables")
    return {"command": command, "port": port, "env": {k: str(v)[:4000] for k, v in env.items()}}


def _dev_sock_dir(gid: str, pid: str) -> Path:
    """The cell's dev folder for a project: a real directory the cell's uid owns (never a symlink it planted)."""
    base = _dir(gid) / "web" / "dev"
    for p in (base, base / pid):
        try:
            st = os.lstat(p)
        except OSError:
            raise Refused("make the dev folder first")
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid_of(gid):
            raise Refused("the dev folder isn't the cell's own directory")
    return base / pid


def _dev_owned(gid: str, pid: str):
    import devserver
    if devserver.cell_owner(pid) != gid:
        raise Refused("no such dev server")


async def dev_start(gid: str, uid: int, pid: str, body: dict) -> dict:
    import devserver
    cfg = dev_config(body)
    if devserver.cell_owner(pid) not in (None, gid):
        raise Refused("that project id is taken")
    ws = await _real_dir(gid, f"projects/{pid}")
    devdir = _dev_sock_dir(gid, pid)
    await devserver.stop(pid)
    await devserver._make_room(pid)
    rc, out = await _docker(*devserver.run_args(cfg, devserver._name(pid), ws, devdir, uid, uid, f"{DEV_LABEL}={gid}",
                                                sock_mode=0o666, git_ro=False), timeout=60)
    if rc:
        raise Refused(f"the dev server didn't start: {out.strip()[-600:]}")
    devserver.register_cell(pid, devdir / "app.sock", uid, gid)
    devserver.port_for(pid)
    return await dev_status(gid, pid)


async def dev_status(gid: str, pid: str) -> dict:
    import devserver
    owned = devserver.cell_owner(pid) == gid
    base = devserver.preview_base(pid) if owned else None
    return {"running": owned and await devserver.running(pid), "port": devserver.port_for(pid, assign=False) if owned else None,
            "preview": base, "ticket": devserver.preview_ticket(pid) if base else None}


async def dev_stop(gid: str, pid: str):
    import devserver
    if devserver.cell_owner(pid) == gid:
        await devserver.stop(pid)


async def dev_logs(gid: str, pid: str, n: int) -> str:
    import devserver
    _dev_owned(gid, pid)
    return (await devserver.logs(pid, max(10, min(n, 2000))))[-20_000:]


async def shot(gid: str, body: dict) -> list[str]:
    """Screenshots for a cell's agents: the host's Firefox renders the page. A static page goes through the guest
    gateway under the project's frame key (what the Studio canvas itself uses for this guest, signed with the cell's
    frame secret); a live dev-server page goes through the preview proxy's port, as for the owner."""
    import base64
    from urllib.parse import quote

    import auth
    import devserver
    import projects
    pid = str(body.get("pid") or "")
    if not DEV_PID.match(pid):
        raise Refused("a screenshot needs a project id")
    width = int(_clamp(body.get("width"), 320, 2560, 1280))
    height = int(_clamp(body.get("height"), 320, 2560, 800))
    pages = int(_clamp(body.get("pages"), 1, 6, 1))
    hold = int(_clamp(body.get("hold"), 0, 5000, 900))
    rel = str(body.get("path") or "")
    if len(rel) > 1000 or "\\" in rel or "\0" in rel:
        raise Refused("bad path")
    if body.get("live"):
        _dev_owned(gid, pid)
        tiles = await devserver.screenshot(pid, rel, width, height, pages)
    else:
        rel, _, qs = rel.partition("?")
        key = f"p-{pid}.{auth.frame_mac(guests.frame_secret(gid), f'p-{pid}')}"
        base = f"http://127.0.0.1:{GUEST_PORT}/api/k/{key}/projects/{pid}/raw/{quote(rel)}?" + (qs + "&" if qs else "")
        tiles = await projects.shoot(base, width, height, pages, hold)
    return [base64.b64encode(t).decode() for t in tiles]


def data_bytes(gid: str) -> int:
    """Size of the cell's data folder (owned by its uid, so measured from the helper container); cached a minute."""
    hit = _data_bytes.get(gid)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    n = 0
    if shutil.which("docker") and (_dir(gid) / "data").exists():
        try:
            r = subprocess.run(["docker", *_helper(gid, "du -sb /c/data | cut -f1")], capture_output=True, text=True, timeout=30)
            n = int(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else 0
        except (subprocess.SubprocessError, ValueError, OSError):
            n = 0
    _data_bytes[gid] = (time.time(), n)
    return n


# ── egress: a filtered proxy, the cell's only way to the web ────────────────

def egress_target(request_line: str) -> tuple[str, str, int, bytes | None]:
    """('connect'|'http', host, port, rewritten request line) for a proxy request line; Refused otherwise."""
    from urllib.parse import urlparse
    parts = request_line.strip().split()
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise Refused("bad proxy request")
    method, target, version = parts
    if method == "CONNECT":
        host, _, port = target.rpartition(":")
        if not host or not port.isdigit():
            raise Refused("CONNECT needs host:port")
        return "connect", host.strip("[]").lower(), int(port), None
    u = urlparse(target)
    if u.scheme != "http" or not u.hostname or u.username or u.password:
        raise Refused("only absolute http:// requests or CONNECT")
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    return "http", u.hostname.lower(), u.port or 80, f"{method} {path} {version}\r\n".encode()


async def egress_allow(gid: str, host: str, port: int):
    from tools import _blocked_host
    if port not in EGRESS_PORTS:
        raise Refused(f"port {port} isn't allowed; only 80 and 443")
    if not re.fullmatch(r"[a-z0-9.-]+", host) or host in ("localhost",) or await asyncio.to_thread(_blocked_host, host):
        raise Refused(f"{host} isn't a public address")
    now = time.time()
    recent = [t for t in _egress_conns.get(gid, []) if now - t < 60]
    if len(recent) >= EGRESS_PER_MINUTE:
        raise Refused("too many connections this minute")
    _egress_conns[gid] = recent + [now]


async def _pipe_capped(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, cap: int):
    moved = 0
    try:
        while data := await asyncio.wait_for(reader.read(64 * 1024), 120):
            moved += len(data)
            if moved > cap:
                break
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def _egress_conn(gid: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    up_w = None
    try:
        line = await asyncio.wait_for(reader.readline(), 30)
        kind, host, port, first = egress_target(line.decode(errors="replace"))
        headers = []
        while True:
            h = await asyncio.wait_for(reader.readline(), 30)
            if not h or h in (b"\r\n", b"\n"):
                break
            if not h.lower().startswith((b"proxy-", b"connection:", b"keep-alive:")):
                headers.append(h)
        await egress_allow(gid, host, port)
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(host, port), 20)
        if kind == "connect":
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        else:
            up_w.write(first + b"".join(headers) + b"Connection: close\r\n\r\n")
            await up_w.drain()
        await writer.drain()
        await asyncio.gather(_pipe_capped(reader, up_w, EGRESS_MAX_BYTES), _pipe_capped(up_r, writer, EGRESS_MAX_BYTES))
    except Refused as e:
        try:
            writer.write(f"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{e}\n".encode())
            await writer.drain()
        except (ConnectionError, OSError):
            pass
    except (asyncio.TimeoutError, ConnectionError, OSError, UnicodeDecodeError, ValueError):
        try:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            await writer.drain()
        except (ConnectionError, OSError):
            pass
    finally:
        for w in (writer, up_w):
            if w is not None:
                try:
                    w.close()
                except OSError:
                    pass


POLICIES = {"ollama": _ollama, "comfy": _comfy, "hermes": _hermes, "orpheus": _orpheus, "stableaudio": _stableaudio,
            "searxng": _searxng, "valhalla": _valhalla, "sandbox": _sandbox}


async def broker(scope, receive, send):
    """The ASGI app behind every cell's broker sockets: which cell and service is decided by the socket."""
    if scope["type"] != "http":
        return
    where = _socks.get(str((scope.get("server") or ("", None))[0]))
    if not where:
        return await JSONResponse({"error": "unknown socket"}, status_code=404)(scope, receive, send)
    gid, svc = where
    if svc == "circles":  # the person is the cell the socket belongs to; nothing the cell sends can change it
        import circles
        return await circles.broker_app({**scope, "shellb_person": gid}, receive, send)
    req = Request(scope, receive)
    try:
        resp = await POLICIES[svc](req, gid)
    except Refused as e:
        resp = JSONResponse({"error": str(e)}, status_code=403)
    except Exception as e:  # noqa: BLE001
        print(f"cells: broker {svc} for {gid}: {type(e).__name__}: {e}")
        resp = JSONResponse({"error": "the broker failed on this request"}, status_code=500)
    await resp(scope, receive, send)
