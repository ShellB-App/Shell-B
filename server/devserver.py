"""Live dev servers for Studio projects: a real back-end (FastAPI/Flask/Express + SQLite) that the preview talks to.

How it is contained:
- The server runs in the sandbox image with `--network none`, so it has no network at all, not even to the host's
  unauthenticated services (Ollama, ComfyUI, …). Inside, socat bridges a Unix socket in data/devservers/<pid>/ to the
  app's TCP port on the container's own loopback; Shell:B talks to that socket. Same limits as run_code (memory, CPU,
  pids, read-only root, the project at /work with .git read-only), and it stops after IDLE_S without traffic.
- The preview is served by a proxy on its own port per project (PORTS), so the app gets its own browser origin: it can't
  script the Shell:B UI or read its API (no CORS), cookie-authenticated writes from it fail auth.py's Origin check, and
  projects can't read each other's storage. The proxy needs the owner's session, a preview ticket (preview hosts, below)
  or localhost, like the main app; it strips both cookies before forwarding and drops any Set-Cookie that tries to
  overwrite the session.

Config: devserver.json in the project root: {"command": "uvicorn server.main:app --port 8000", "port": 8000,
"env": {...}}. The command runs with bash in /work; $PORT is set to the port.
API: GET/POST /api/projects/<pid>/dev (status / {action: start|stop|restart}), GET /api/projects/<pid>/dev/logs.
Agent tools (project scope): dev_server, http_request; screenshot(server=true) renders through the proxy.
"""
import asyncio
import hmac
import json
import os
import re
import shlex
import secrets
import socket
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlencode, parse_qsl

import httpx
from fastapi import APIRouter, HTTPException, Request

import auth
import cell_boot
import db
from tools import SANDBOX_IMAGE, TOOLS, ToolResult, _fn

# In a guest's cell (cell_boot.CELL) the host runs the container for it (cells.dev_start) and the socket lives in a
# folder both can reach: the cell's /run/web/dev (SHELLB_DEV_DIR, set by cells._run_args), data/cells/<gid>/web/dev here.
DEV = Path(os.environ.get("SHELLB_DEV_DIR") or db.DATA / "devservers")
PORTS = list(range(int(os.environ.get("SHELLB_DEV_PORT", "8210")), int(os.environ.get("SHELLB_DEV_PORT", "8210")) + 8))
IDLE_S = 30 * 60
MAX_RUNNING = 4
CONFIG = "devserver.json"
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding",
       "upgrade", "host", "content-length"}
router = APIRouter(prefix="/api/projects")
_last_use: dict[str, float] = {}
_locks: dict[str, asyncio.Lock] = {}


def _root(pid: str) -> Path:
    return db.DATA / "projects" / pid


def _name(pid: str) -> str:
    return f"shellb-dev-{pid}"


# Dev servers the host runs for guests' cells: pid → (socket, the cell's uid, guest id). The preview proxy and the
# screenshot helper reach them through this; cells.dev_start fills it and stop() clears it.
_cell_socks: dict[str, tuple[Path, int, str]] = {}


def register_cell(pid: str, sock: Path, uid: int, gid: str):
    _cell_socks[pid] = (sock, uid, gid)
    _last_use[pid] = time.time()


def cell_owner(pid: str) -> str | None:
    return _cell_socks[pid][2] if pid in _cell_socks else None


def _sock(pid: str) -> Path:
    return _cell_socks[pid][0] if pid in _cell_socks else DEV / pid / "app.sock"


def _unlink_sock(pid: str):
    try:
        _sock(pid).unlink()
    except OSError:  # a cell's socket sits in the cell's own folder: the container's exit removes it
        pass


def _in_cell() -> bool:
    return cell_boot.CELL


async def _broker(path: str, body: dict, timeout: float = 120) -> dict:
    """Cell mode: ask the host broker (cells._sandbox, forwarded to 127.0.0.1:8250 by cell/entry.py)."""
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as c:
            r = await c.post(f"{cell_boot.SANDBOX_URL}{path}", json=body)
    except httpx.HTTPError as e:
        raise RuntimeError(f"The host isn't answering: {type(e).__name__}")
    if r.status_code != 200:
        try:
            why = r.json().get("error") or r.text
        except ValueError:
            why = r.text
        raise RuntimeError(str(why)[:500])
    return r.json()


def config(pid: str) -> dict | None:
    p = _root(pid) / CONFIG
    if not p.is_file():
        return None
    try:
        c = json.loads(p.read_text())
    except ValueError as e:
        raise ValueError(f"{CONFIG} is not valid JSON: {e}")
    cmd, port = c.get("command"), c.get("port", 8000)
    if not isinstance(cmd, str) or not cmd.strip():
        raise ValueError(f'{CONFIG} needs a "command", e.g. "uvicorn server.main:app --host 127.0.0.1 --port 8000"')
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError(f'{CONFIG}: "port" must be an integer 1024-65535')
    env = {str(k): str(v) for k, v in (c.get("env") or {}).items() if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(k))}
    return {"command": cmd, "port": port, "env": env}


# ── stable per-project proxy ports (one browser origin each) ────────────────

def port_for(pid: str, assign: bool = True) -> int | None:
    ports = db.kv_get("devserver_ports", {})
    if pid in ports and ports[pid] in PORTS:
        return ports[pid]
    if not assign:
        return None
    used = set(ports.values())
    free = [p for p in PORTS if p not in used]
    if not free:  # recycle the port of the least recently used project (stopped ones first)
        free = [ports.pop(min(ports, key=lambda k: _last_use.get(k, 0)))]
    ports[pid] = free[0]
    db.kv_set("devserver_ports", ports)
    return free[0]


def pid_for_port(port: int) -> str | None:
    return next((k for k, v in db.kv_get("devserver_ports", {}).items() if v == port), None)


# ── container lifecycle ─────────────────────────────────────────────────────

async def _docker(*args, timeout=60) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "docker timed out"
    return proc.returncode, out.decode(errors="replace")


async def running(pid: str) -> bool:
    if _in_cell():
        try:
            return bool((await _broker("/dev/status", {"pid": pid}, timeout=30)).get("running"))
        except RuntimeError:
            return False
    rc, out = await _docker("inspect", "-f", "{{.State.Running}}", _name(pid))
    return rc == 0 and out.strip() == "true"


async def logs(pid: str, n: int = 200) -> str:
    if _in_cell():
        try:
            return str((await _broker("/dev/logs", {"pid": pid, "lines": n}, timeout=30)).get("logs") or "")
        except RuntimeError as e:
            return f"(no logs: {e})"
    rc, out = await _docker("logs", "--tail", str(n), _name(pid))
    return out if rc == 0 else ""


async def status(pid: str) -> dict:
    try:
        cfg, err = config(pid), None
    except ValueError as e:
        cfg, err = None, str(e)
    if _in_cell():  # the host runs it and owns the preview host and ticket (cells.dev_status)
        try:
            st = await _broker("/dev/status", {"pid": pid}, timeout=30)
        except RuntimeError as e:
            st, err = {"running": False, "port": None, "preview": None, "ticket": None}, err or str(e)
        return {"configured": cfg is not None, "error": err, "running": bool(st.get("running")), "port": st.get("port"),
                "preview": st.get("preview"), "ticket": st.get("ticket"), "command": cfg and cfg["command"],
                "idleStopsIn": max(0, int(IDLE_S - (time.time() - _last_use.get(pid, time.time())))) if st.get("running") else None}
    up = await running(pid)
    port = port_for(pid, assign=False)
    base = preview_base(pid)
    return {"configured": cfg is not None, "error": err, "running": up, "port": port,
            "preview": base, "ticket": preview_ticket(pid) if base else None,
            "command": cfg and cfg["command"], "idleStopsIn": max(0, int(IDLE_S - (time.time() - _last_use.get(pid, time.time()))))
            if up else None}


async def stop(pid: str):
    if _in_cell():
        try:
            await _broker("/dev/stop", {"pid": pid}, timeout=60)
        except RuntimeError:
            pass
    else:
        await _docker("rm", "-f", _name(pid))
    _last_use.pop(pid, None)
    _unlink_sock(pid)
    _cell_socks.pop(pid, None)


async def _make_room(pid: str):
    """At most MAX_RUNNING dev servers on this machine (the owner's and guests' together): the least recently used go."""
    live = [k for k in list(_last_use) if k != pid]
    for k in sorted(live, key=lambda k: _last_use[k])[:max(0, len(live) - MAX_RUNNING + 1)]:
        await stop(k)


async def _wait_up(pid: str) -> int | None:
    """Up to ~30 s for installs-free startups (uvicorn, node, flask): the first HTTP status, or None."""
    code = None
    for _ in range(60):
        await asyncio.sleep(0.5)
        if not await running(pid):
            break
        code = await _probe(pid)
        if code is not None:
            break
    return code


async def _probe(pid: str) -> int | None:
    try:
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(_sock(pid))), timeout=3) as c:
            return (await c.get("http://app/")).status_code
    except (httpx.HTTPError, OSError):
        return None


def boot_command(cfg: dict, sock_mode: int = 0o600) -> str:
    """What runs in the container: socat bridges /run/dev/app.sock to the app's port, then the app itself. socat's
    own connection-refused noise (while the app boots) would bury the app's tracebacks in the logs."""
    return (f"socat UNIX-LISTEN:/run/dev/app.sock,fork,mode={sock_mode:o} TCP:127.0.0.1:{cfg['port']} 2>/dev/null & "
            f"exec bash -c {shlex.quote(cfg['command'])}")


def run_args(cfg: dict, name: str, ws: Path, devdir: Path, uid: int, gid: int, label: str, sock_mode: int = 0o600,
             git_ro: bool = True) -> list[str]:
    """The hardened `docker run` for a dev server (the owner's, or a cell's with its uid and folders)."""
    env = [x for k, v in {**cfg["env"], "PORT": str(cfg["port"]), "HOST": "127.0.0.1", "HOME": "/tmp",
                           "PYTHONUNBUFFERED": "1", "NODE_ENV": "development"}.items() for x in ("-e", f"{k}={v}")]
    return ["run", "-d", "--name", name, "--label", label, "--network", "none",
            "--cap-drop", "ALL",  # see tools.run_code for why not no-new-privileges
            "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,size=256m",
            "--user", f"{uid}:{gid}", *env,
            # --mount (not -v): a missing source is an error, never a root-owned folder conjured into place
            "--mount", f"type=bind,src={ws},dst=/work", *(["-v", f"{ws}/.git:/work/.git:ro"] if git_ro and (ws / ".git").is_dir() else []),
            "-v", f"{devdir}:/run/dev", "-w", "/work", SANDBOX_IMAGE, "bash", "-c", boot_command(cfg, sock_mode)]


async def start(pid: str) -> dict:
    """(Re)start the project's server and wait until it answers HTTP. Returns status plus a log tail."""
    cfg = config(pid)
    if not cfg:
        raise ValueError(f"No {CONFIG} in the project. Write one first, e.g. "
                         '{"command": "uvicorn server.main:app --host 127.0.0.1 --port 8000", "port": 8000}')
    async with _locks.setdefault(pid, asyncio.Lock()):
        await stop(pid)
        (DEV / pid).mkdir(parents=True, exist_ok=True)
        if _in_cell():
            # the host runs the container (cells.dev_start) as this cell's uid, bound to this project and this folder;
            # the folder must let the host in to reach the socket (the cell's umask makes it private otherwise)
            for d in (DEV, DEV / pid):
                os.chmod(d, 0o755)
            _unlink_sock(pid)
            await _broker("/dev/start", {"pid": pid, "command": cfg["command"], "port": cfg["port"], "env": cfg["env"]}, timeout=90)
        else:
            await _make_room(pid)
            rc, out = await _docker(*run_args(cfg, _name(pid), _root(pid), DEV / pid, os.getuid(), os.getgid(), "shellb.dev=1"))
            if rc != 0:
                raise RuntimeError(f"docker run failed: {out.strip()[:800]}")
            port_for(pid)
        _last_use[pid] = time.time()
        code = await _wait_up(pid)
        st = await status(pid)
        st["httpStatus"] = code
        st["logs"] = (await logs(pid, 60))[-4000:]
        return st


async def reaper():
    while True:
        await asyncio.sleep(60)
        for pid, t in list(_last_use.items()):
            if time.time() - t > IDLE_S:
                await stop(pid)
            elif not await running(pid):  # it crashed: forget it but keep the exited container, so its logs stay readable
                _last_use.pop(pid, None)
                _unlink_sock(pid)


async def adopt():
    """After a Shell:B restart, keep dev servers that are still up (and reap them later)."""
    rc, out = await _docker("ps", "--filter", "label=shellb.dev=1", "--format", "{{.Names}}")
    for name in out.split() if rc == 0 else []:
        _last_use[name.removeprefix("shellb-dev-")] = time.time()


# ── the preview proxy (an ASGI app on PORTS) ────────────────────────────────

GIF = (b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,"
       b"\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
INSPECTOR_JS = Path(__file__).resolve().parent.parent / "ui" / "public" / "studio-inspector.js"


def _strip_cookie(raw: str) -> str:
    keep = [c for c in (p.strip() for p in raw.split(";")) if c and not c.startswith((auth.COOKIE + "=", PREVIEW_COOKIE))]
    return "; ".join(keep)


# Preview hosts (setting previewHost, e.g. "shellb.app" → https://p-<12 hex of the project id>.shellb.app): one host per
# project, so each keeps its own origin and a stable URL. The hub edge proxy sends every p-* host to PORTS[0], and the
# proxy takes the project from the Host header. Such a host never gets the shellb_session cookie, so the Canvas hands the
# frame a signed ticket (?__pt=, from GET .../dev); the proxy swaps it for a cookie on that host alone, bound to the project.
PREVIEW_COOKIE = "shellb_preview_"
PROJECT_ID = re.compile(r"proj-[0-9a-f]{12}")
PREVIEW_HOST = re.compile(r"p-([0-9a-f]{12})\.(.+)")
PREVIEW_TTL = 12 * 3600


def _preview_secret() -> str:
    s = db.kv_get("preview_secret")
    if not s:
        s = secrets.token_hex(24)
        db.kv_set("preview_secret", s)
    return s


def _preview_domain() -> str:
    import roster
    return (roster.get_settings().get("previewHost") or "").strip().strip(".").lower()


def preview_base(pid: str) -> str | None:
    host = _preview_domain()
    return f"https://p-{pid.removeprefix('proj-')}.{host}" if host and PROJECT_ID.fullmatch(pid) else None


def _pid_for_host(host: str) -> str | None:
    domain = _preview_domain()
    m = PREVIEW_HOST.fullmatch(host.split(":")[0].lower())
    return f"proj-{m.group(1)}" if domain and m and m.group(2) == domain else None


def preview_ticket(pid: str) -> str:
    # whole 6-hour steps, so the Canvas's frame URL (which carries it) doesn't change, and reload, on every status poll
    exp = (int(time.time()) + PREVIEW_TTL) // 21600 * 21600 + 21600
    return f"{exp}.{auth.frame_mac(_preview_secret(), f'preview:{pid}:{exp}')}"


def _ticket_ok(pid: str, t: str | None) -> bool:
    exp, _, mac = (t or "").partition(".")
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(auth.frame_mac(_preview_secret(), f"preview:{pid}:{exp}"), mac)


async def _send(send, status: int, body: bytes, ctype: str = "text/plain; charset=utf-8", extra: list | None = None):
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", ctype.encode()), (b"cache-control", b"no-store"),
                            (b"content-length", str(len(body)).encode()), *(extra or [])]})
    await send({"type": "http.response.body", "body": body})


async def proxy_app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            msg = await receive()
            if msg["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif msg["type"] == "lifespan.shutdown":
                return await send({"type": "lifespan.shutdown.complete"})
    h = auth._headers(scope)
    port = (scope.get("server") or ("", 0))[1]
    # a p-<id> host names its project; one that doesn't match previewHost names none (never the port's project)
    on_host = PREVIEW_HOST.fullmatch(h.get("host", "").split(":")[0].lower())
    pid = _pid_for_host(h.get("host", "")) if on_host else pid_for_port(port)
    path, qs = scope["path"], scope.get("query_string", b"").decode("latin-1")
    jar = SimpleCookie()
    try:
        jar.load(h.get("cookie", ""))
    except Exception:
        pass
    given = dict(parse_qsl(qs)).get("__pt")
    fresh = bool(pid and given and _ticket_ok(pid, given))
    held = jar.get(f"{PREVIEW_COOKIE}{port}")
    if not (fresh or (pid and held and _ticket_ok(pid, held.value))
            or auth._session(auth._cookie(h)) or auth._is_local(scope, h)):
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 4401})
        return await _send(send, 401, b"<!doctype html><title>Login needed</title><p style='font:16px system-ui;margin:2em'>"
                           b"Log in to Shell:B first, then reload this preview.</p>", "text/html; charset=utf-8")
    if not pid:
        return await _send(send, 404, b"No project uses this preview port.")
    set_cookie = None
    if fresh:
        secure = "; Secure" if h.get("x-forwarded-proto") == "https" else ""
        set_cookie = (b"set-cookie", f"{PREVIEW_COOKIE}{port}={given}; Path=/; Max-Age={int(given.split(".")[0]) - int(time.time())}; HttpOnly; "
                                     f"SameSite=Lax{secure}".encode())
    # screenshot helpers the injected snippet calls on this origin (see projects.screenshot)
    if path.startswith("/api/projects/_shotinfo/"):
        import projects
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        try:
            projects._shot_heights[path.rsplit("/", 1)[-1]] = (time.time(), int(float(body.decode() or 0)))
        except ValueError:
            pass
        return await _send(send, 204, b"")
    if path == "/api/_hold":
        ms = int(dict(parse_qsl(qs)).get("ms", "900") or 900)
        await asyncio.sleep(min(ms, 5000) / 1000)
        return await _send(send, 200, GIF, "image/gif")
    if path == "/__shellb/inspector.js" and INSPECTOR_JS.is_file():
        return await _send(send, 200, INSPECTOR_JS.read_bytes(), "text/javascript")
    # cheap check per request (no docker call): started by us or adopted, and its socket exists
    if pid not in _last_use or not _sock(pid).exists():
        return await _send(send, 503, b"<!doctype html><p style='font:16px system-ui;margin:2em'>The dev server is stopped. "
                           b"Start it from the Studio canvas or ask the agent to.</p>", "text/html; charset=utf-8")
    _last_use[pid] = time.time()
    if scope["type"] == "websocket":
        return await _proxy_ws(pid, scope, receive, send)
    await _proxy_http(pid, scope, receive, send, h, path, qs, set_cookie)


async def _proxy_http(pid, scope, receive, send, h, path, qs, set_cookie=None):
    import projects
    q = dict(parse_qsl(qs, keep_blank_values=True))
    shot = q.pop("__shot", None)
    shot_y, hold = q.pop("__y", "0"), q.pop("__hold", "900")
    inspect = q.pop("__inspect", None) is not None
    ticket = q.pop("__pt", None)
    fwd_qs = urlencode(q) if (shot or inspect or ticket) else qs
    body = b""
    while True:
        m = await receive()
        body += m.get("body", b"")
        if len(body) > 64 * 1024 * 1024:
            return await _send(send, 413, b"Request body too large for the preview proxy.")
        if not m.get("more_body"):
            break
    headers = [(k, v) for k, v in h.items() if k not in HOP and k != "cookie"]
    if h.get("cookie") and _strip_cookie(h["cookie"]):
        headers.append(("cookie", _strip_cookie(h["cookie"])))
    headers += [("host", h.get("host", "localhost")), ("x-forwarded-proto", "http")]
    async with httpx.AsyncClient(transport=_transport(pid), timeout=httpx.Timeout(120, connect=5)) as c:
        try:
            req = c.build_request(scope["method"], f"http://app{path}" + (f"?{fwd_qs}" if fwd_qs else ""),
                                  headers=headers, content=body)
            r = await c.send(req, stream=True)
        except (httpx.HTTPError, OSError) as e:
            return await _send(send, 502, f"The dev server isn't answering: {type(e).__name__}. Check its logs.".encode())
        try:
            out_h = []
            for k, v in r.headers.multi_items():
                lk = k.lower()
                if lk in HOP or lk in ("content-encoding", "date", "server"):  # uvicorn adds its own date/server
                    continue
                if lk == "set-cookie" and v.strip().startswith(auth.COOKIE + "="):
                    continue
                out_h.append((lk.encode("latin-1"), v.encode("latin-1")))
            if set_cookie:
                out_h.append(set_cookie)
            html = "text/html" in r.headers.get("content-type", "")
            if html and (shot or inspect):
                text = (await r.aread()).decode(errors="replace")
                if shot:
                    text = projects.inject(text, head=projects.SHOT_SNIPPET.format(y=int(shot_y or 0), token=re.sub(r"\W", "", shot)),
                                           body_end=projects.SHOT_HOLD.format(ms=min(int(hold or 900), 5000)))
                else:
                    text = projects.inject(text, body_end='<script src="/__shellb/inspector.js"></script>')
                data = text.encode()
                out_h = [(k, v) for k, v in out_h if k != b"content-length"] + [(b"content-length", str(len(data)).encode())]
                await send({"type": "http.response.start", "status": r.status_code, "headers": out_h})
                return await send({"type": "http.response.body", "body": data})
            await send({"type": "http.response.start", "status": r.status_code, "headers": out_h})
            async for chunk in r.aiter_raw():
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})
        finally:
            await r.aclose()


def _transport(pid: str) -> httpx.AsyncHTTPTransport:
    """A cell's socket sits in a folder the cell writes: connect only to a socket its uid owns (cells._CellSocket)."""
    if pid in _cell_socks:
        import httpcore

        import cells
        sock, uid, _gid = _cell_socks[pid]
        t = httpx.AsyncHTTPTransport()
        t._pool = httpcore.AsyncConnectionPool(uds="dev", network_backend=cells._CellSocket(sock, uid))
        return t
    return httpx.AsyncHTTPTransport(uds=str(_sock(pid)))


def _sock_ok(pid: str) -> bool:
    """For the WebSocket hop, which has no pluggable backend: the same ownership check, just before connecting."""
    if pid not in _cell_socks:
        return True
    import stat
    sock, uid, _gid = _cell_socks[pid]
    try:
        fd = os.open(sock, os.O_PATH | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        st = os.fstat(fd)
        return stat.S_ISSOCK(st.st_mode) and st.st_uid == uid
    finally:
        os.close(fd)


async def _proxy_ws(pid, scope, receive, send):
    import websockets
    qs = scope.get("query_string", b"").decode("latin-1")
    try:
        if not _sock_ok(pid):
            raise OSError("not the cell's socket")
        upstream = await websockets.unix_connect(str(_sock(pid)), f"ws://app{scope['path']}" + (f"?{qs}" if qs else ""),
                                                 subprotocols=scope.get("subprotocols") or None, open_timeout=5)
    except Exception:
        return await send({"type": "websocket.close", "code": 1011})
    msg = await receive()
    if msg["type"] != "websocket.connect":
        return await upstream.close()
    await send({"type": "websocket.accept", "subprotocol": upstream.subprotocol})

    async def down():
        async for m in upstream:
            await send({"type": "websocket.send", **({"bytes": m} if isinstance(m, bytes) else {"text": m})})
        await send({"type": "websocket.close", "code": 1000})

    task = asyncio.create_task(down())
    try:
        while True:
            m = await receive()
            if m["type"] == "websocket.disconnect":
                break
            _last_use[pid] = time.time()
            await upstream.send(m["bytes"] if m.get("bytes") is not None else m.get("text", ""))
    finally:
        task.cancel()
        await upstream.close()


_proxy_server = None
_reaper_task: asyncio.Task | None = None
_proxy_task: asyncio.Task | None = None
_proxy_sockets: list[socket.socket] = []


async def serve_proxy():
    """One uvicorn server listening on every preview port; the port tells the proxy which project it is."""
    global _proxy_server, _reaper_task, _proxy_task, _proxy_sockets
    import uvicorn
    socks = []
    # the same addresses as the main app (serve.py SHELLB_HOSTS): loopback for tailscale serve, the docker0 gateway for
    # the hub's edge proxy (previewN.<previewHost>); never the LAN
    hosts = [h.strip() for h in os.environ.get("SHELLB_HOSTS", "127.0.0.1").split(",") if h.strip()]
    for p in PORTS:
        for host in hosts:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
            except OSError:
                s.close()
                continue
            s.listen(128)
            socks.append(s)
    _proxy_sockets = socks

    class Quiet(uvicorn.Server):
        def capture_signals(self):  # the main server owns SIGINT/SIGTERM
            import contextlib
            return contextlib.nullcontext()

    server = Quiet(uvicorn.Config(proxy_app, log_level="warning", lifespan="off"))
    _proxy_server = server
    _proxy_task = asyncio.create_task(server.serve(sockets=socks))
    _reaper_task = asyncio.create_task(reaper())
    await adopt()


async def stop_proxy():
    """Cleanly shut down the devserver proxy, reaper, and close listening sockets."""
    global _proxy_server, _reaper_task, _proxy_task, _proxy_sockets
    if _reaper_task and not _reaper_task.done():
        _reaper_task.cancel()
    if _proxy_server:
        _proxy_server.should_exit = True
    if _proxy_task and not _proxy_task.done():
        _proxy_task.cancel()
        try:
            await asyncio.wait_for(_proxy_task, 2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            pass
    for s in _proxy_sockets:
        try:
            s.close()
        except Exception:
            pass
    _proxy_sockets.clear()


# ── screenshots through the proxy ───────────────────────────────────────────

async def screenshot(pid: str, path: str, width: int, height: int, max_tiles: int = 1) -> list[bytes]:
    """Viewport tiles of a page on the running dev server, rendered through the preview proxy (localhost trust)."""
    import projects
    if _in_cell():  # the host's Firefox renders it through its own proxy (cells.shot)
        return await cell_shot({"pid": pid, "path": path, "width": width, "height": height, "pages": max_tiles, "live": True})
    port = port_for(pid)
    path, _, qs = ("/" + path.lstrip("/")).partition("?")
    return await projects.shoot(f"http://127.0.0.1:{port}{path}?" + (qs + "&" if qs else ""), width, height, max_tiles, 900)


async def cell_shot(body: dict) -> list[bytes]:
    """Cell mode: screenshots come from the host's Firefox (cells.shot); the tiles travel back base64-encoded."""
    import base64
    try:
        out = await _broker("/shot", body, timeout=240)
    except RuntimeError as e:
        print(f"cell screenshot: {e}")
        return []
    return [base64.b64decode(t) for t in out.get("tiles") or []]


# ── HTTP API for the Studio UI ──────────────────────────────────────────────

def _pid_ok(pid: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", pid) or not db.get_project(pid):
        raise HTTPException(404, "No such project")


@router.get("/{pid}/dev")
async def dev_status(pid: str):
    _pid_ok(pid)
    return await status(pid)


@router.post("/{pid}/dev")
async def dev_action(pid: str, req: Request):
    _pid_ok(pid)
    action = (await req.json()).get("action")
    try:
        if action in ("start", "restart"):
            return await start(pid)
        if action == "stop":
            await stop(pid)
            return await status(pid)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    raise HTTPException(400, "action must be start, stop or restart")


@router.get("/{pid}/dev/logs")
async def dev_logs(pid: str, n: int = 300):
    _pid_ok(pid)
    return {"logs": await logs(pid, max(10, min(n, 2000)))}


# ── agent tools ─────────────────────────────────────────────────────────────

async def dev_server_tool(args, ctx):
    pid = ctx.project_id
    if not pid:
        return ToolResult("dev_server works inside a Studio project.", error=True)
    action = str(args.get("action") or "status")
    try:
        if action in ("start", "restart"):
            st = await start(pid)
            ok = st["running"] and st.get("httpStatus") is not None
            await ctx.emit({"type": "devserver", "status": {k: v for k, v in st.items() if k != "logs"}})
            head = (f"Dev server is up (GET / → {st['httpStatus']}); the user's canvas can show it live." if ok else
                    "Dev server did NOT come up" + (" (the container exited)" if not st["running"] else " (no HTTP answer in 30 s)")
                    + ". Read the logs, fix, and start again.")
            return ToolResult(f"{head}\nCommand: {st['command']}\n--- logs (tail) ---\n{st['logs'] or '(empty)'}", error=not ok)
        if action == "stop":
            await stop(pid)
            await ctx.emit({"type": "devserver", "status": await status(pid)})
            return ToolResult("Dev server stopped.")
        if action == "logs":
            return ToolResult((await logs(pid, int(args.get("lines") or 120)))[-8000:] or "(no logs: the server isn't running)")
        st = await status(pid)
        return ToolResult(json.dumps(st))
    except (ValueError, RuntimeError) as e:
        return ToolResult(str(e), error=True)


async def http_request(args, ctx):
    pid = ctx.project_id
    if not pid:
        return ToolResult("http_request works inside a Studio project.", error=True)
    if not await running(pid):
        return ToolResult("The dev server isn't running. Call dev_server action=start first.", error=True)
    method = str(args.get("method") or "GET").upper()
    path = "/" + str(args.get("path") or "/").lstrip("/")
    raw_h = args.get("headers") or {}
    if isinstance(raw_h, str):  # models sometimes send the object as a JSON string
        try:
            raw_h = json.loads(raw_h) if raw_h.strip() else {}
        except ValueError:
            return ToolResult('headers must be an object, e.g. {"Authorization": "Bearer …"}', error=True)
    if not isinstance(raw_h, dict):
        return ToolResult("headers must be an object.", error=True)
    headers = {str(k): str(v) for k, v in raw_h.items()}
    body_json = args.get("json")
    if isinstance(body_json, str):
        try:
            body_json = json.loads(body_json)
        except ValueError:
            pass  # a plain string is valid JSON content too
    kw = {}
    if body_json is not None:
        kw["json"] = body_json
    elif args.get("body") is not None:
        kw["content"] = str(args["body"]).encode()
    _last_use[pid] = time.time()
    t0 = time.time()
    try:
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(_sock(pid))), timeout=60) as c:
            r = await c.request(method, f"http://app{path}", headers=headers, **kw)
    except (httpx.HTTPError, OSError) as e:
        return ToolResult(f"Request failed: {type(e).__name__}: {e}. Check dev_server action=logs.", error=True)
    ms = (time.time() - t0) * 1000
    ctype = r.headers.get("content-type", "")
    if "json" in ctype:
        try:
            text = json.dumps(r.json(), indent=1)
        except ValueError:
            text = r.text
    elif ctype.startswith(("text/", "application/xml", "application/javascript")):
        text = r.text
    else:
        text = f"({len(r.content):,} bytes of {ctype or 'unknown type'})"
    hdrs = "\n".join(f"{k}: {v}" for k, v in r.headers.items() if k.lower() in
                     ("content-type", "location", "set-cookie", "cache-control", "www-authenticate", "access-control-allow-origin"))
    return ToolResult(f"{method} {path} → {r.status_code} {r.reason_phrase} ({ms:.0f} ms)\n{hdrs}\n\n{text[:12000]}",
                      error=r.status_code >= 500)


def register():
    TOOLS["dev_server"] = {
        "fn": dev_server_tool, "service": "sandbox", "scope": "project",
        "ui": {"displayName": "Dev Server", "icon": "Server", "category": "code",
               "description": "Runs the project's back-end (devserver.json) in an offline sandbox, live in the preview."},
        "schema": _fn("dev_server", "Start, restart, stop or inspect this project's live back-end server. It runs the command "
                      f"in {CONFIG} ({{\"command\": \"...\", \"port\": 8000, \"env\": {{}}}}) in the offline sandbox with the "
                      "project at /work; the preview canvas then shows the running app, API included. No network: no pip or "
                      "npm install at runtime. Available: Python FastAPI/uvicorn, Flask, SQLAlchemy/SQLModel, sqlite3, "
                      "jinja2, pyjwt, passlib; Node 20 with express, sql.js, ws and zod (require them; they are "
                      "global). Bind 127.0.0.1:$PORT. Restart after back-end code changes unless the server reloads itself.",
                      {"action": {"type": "string", "enum": ["start", "restart", "stop", "status", "logs"]},
                       "lines": {"type": "integer", "description": "For logs: how many lines (default 120)"}},
                      ["action"]),
    }
    TOOLS["http_request"] = {
        "fn": http_request, "service": "sandbox", "scope": "project",
        "ui": {"displayName": "API Requests", "icon": "Send", "category": "code",
               "description": "Calls the project's running dev server to test its API."},
        "schema": _fn("http_request", "Send an HTTP request to this project's running dev server and see the status, key "
                      "headers and body. Use it to test every API endpoint you build (happy path and errors) before "
                      "wiring the UI to it.",
                      {"method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                       "path": {"type": "string", "description": "e.g. /api/tasks?done=false"},
                       "json": {"description": "JSON body"},
                       "body": {"type": "string", "description": "Raw body (instead of json)"},
                       "headers": {"type": "object"}},
                      ["path"]),
    }
