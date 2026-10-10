"""Owner login for Shell:B Web: one password, cookie sessions, and trusted localhost.

Who gets in:
- **The machine itself.** A request from 127.0.0.1/::1 that no proxy forwarded (no X-Forwarded-For / Forwarded)
  needs no login. Headless-Firefox screenshots, `shot.sh` and `curl localhost:8200/api/status` keep working.
  The LAN, Tailscale and the Vite dev proxy (which sends X-Forwarded-For) all have to log in.
- **The owner.** POST /api/auth/login with the password sets an HttpOnly `shellb_session` cookie. Sessions last
  30 days from last use. A logged-in owner also counts as admin (see `is_owner`). Localhost is not admin.
- **Sandboxed frames.** Artifacts and Studio pages run in iframes with an opaque origin, and browsers don't send
  SameSite cookies from those. They load through `/api/k/<scope>.<mac>/<rest>`, a key that reaches one thing only:
  `p-<pid>` a project's pages, `w-<conv>` one chat's /work files, `x` neither. Every scope also reaches the shared
  asset-library and media files and its own saved state (`_frame_allowed`). The mac is HMAC(scope) under the session's
  `frame_key` (the UI computes it, ui/src/frameKey.ts) or, for pages shown on the machine itself, a local secret.
  A page opened with the cookie, or from localhost, is redirected under its project's key, so relative URLs keep working.
  Never admin. A page can't read another project's or chat's files: it never learns another scope's key.
- **Sandboxed content on localhost gets no localhost trust.** A loopback request with `Origin: null` or a cross-site /
  same-site `Sec-Fetch-Site` comes from a page (a sandboxed frame, a dev-server preview, any website), not from this
  machine's tools, so it is treated as anonymous (SANDBOX_WRITES aside).
- **Public:** the UI shell and static assets (non-/api paths), /api/auth/*, /api/_hold, and /api/files/* (generated
  media with random names that only authenticated APIs hand out).

The first password is set in the browser with the admin key from data/admin.key, or from the shell:
    ~/shellb/web/venv/bin/python ~/shellb/web/server/auth.py set-password
Setting a password from the shell signs out every session.
"""
import asyncio
import hashlib
import json
import hmac
import ipaddress
import os
import re
import secrets
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

import db
import otp

router = APIRouter(prefix="/api/auth")

COOKIE = "shellb_session"
SESSION_TTL = 30 * 86400
MIN_PASSWORD = 8
# screen/*: the Shell:B Screen helper signs in with its own device token (screen.py checks it on every call)
# v1/*: the Shell:B API checks its own API key on every call (public_api.py)
# share/<token>: a read-only snapshot the owner published (shares.py); the 32-hex token is the whole credential
PUBLIC = re.compile(r"^/api/(auth(/|$)|_hold$|files/[^/]+$|share/[0-9a-f]{32}$|screen/(connect|next|(frame|result)/[0-9a-f]+|disconnect)$|fleet/agent$|v1/)")
# what every frame key may reach, whatever its scope: (methods, path under /api/)
FRAME_SHARED = [
    ({"GET", "HEAD"}, re.compile(r"^assets/file/[A-Za-z0-9_-]+/.+")),
    ({"GET", "HEAD"}, re.compile(r"^files/[^/]+$")),
]
FRAME_PREFIX = re.compile(r"^/api/k/([A-Za-z0-9_.-]{1,160})/(.*)$")
SCOPED_KEY = re.compile(r"^(p-[A-Za-z0-9_-]{1,64}|w-[A-Za-z0-9_-]{1,64}|x)\.([0-9a-f]{32})$")
RAW_PAGE = re.compile(r"^/api/projects/([A-Za-z0-9_-]+)/(raw|draft)/")
WORK_PAGE = re.compile(r"^/api/workspace/([A-Za-z0-9_-]+)/.")
PAGE_DESTS = ("iframe", "frame", "document")
SANDBOX_SITES = {"cross-site", "same-site"}  # Sec-Fetch-Site of a request a page made, not this machine's own tools
# the only writes sandboxed content (Origin: null) may make on localhost trust: saved app state and the screenshot beacon
SANDBOX_WRITES = re.compile(r"^/api/(appstate|projects/_shotinfo/[A-Za-z0-9]+)$")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# Cell mode (cell_boot.py): this instance is one guest's Shell:B in a container. Its only way in is the guest gateway,
# which sends CELL_HEADER with this container's secret on requests from the signed-in guest; that counts as the owner.
# Frame keys are signed with the cell's frame secret. No cookie, localhost or admin key means anything here.
CELL = os.environ.get("SHELLB_CELL") == "1"
CELL_SECRET = os.environ.get("SHELLB_CELL_SECRET", "")
CELL_FRAME_SECRET = os.environ.get("SHELLB_CELL_FRAME_SECRET", "")
CELL_HEADER = "x-shellb-cell-gate"
if CELL and (len(CELL_SECRET) < 32 or len(CELL_FRAME_SECRET) < 32):
    raise RuntimeError("cell mode needs SHELLB_CELL_SECRET and SHELLB_CELL_FRAME_SECRET (32+ characters each)")
CELL_SESSION = {"id": "cell", "frame_key": CELL_FRAME_SECRET, "created": 0, "last_seen": 0, "expires": 0, "ip": "", "ua": ""}


def init():
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS auth_sessions(
            id TEXT PRIMARY KEY, frame_key TEXT UNIQUE, created REAL, last_seen REAL, expires REAL, ip TEXT, ua TEXT)""")
        c.execute("DELETE FROM auth_sessions WHERE expires < ?", (time.time(),))
        c.execute("""CREATE TABLE IF NOT EXISTS auth_passkeys(
            id TEXT PRIMARY KEY, public_key BLOB, sign_count INTEGER DEFAULT 0, transports TEXT, label TEXT, rp_id TEXT,
            created REAL, last_used REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS auth_attempts(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT,
            ts REAL,
            success INTEGER,
            endpoint TEXT DEFAULT 'login')""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_auth_attempts_ts ON auth_attempts(ts)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_ts ON auth_attempts(ip, ts)")
        c.execute("DELETE FROM auth_attempts WHERE ts < ?", (time.time() - 86400,))
    _load_recent_fails()


# ── password ────────────────────────────────────────────────────────────────

def _hash(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 15, r=8, p=1, maxmem=64 * 1024 * 1024).hex()


def has_password() -> bool:
    return bool(db.kv_get("auth_password"))


def set_password(password: str, reason: str = "password_change", ip: str | None = None):
    if len(password) < MIN_PASSWORD:
        raise ValueError(f"Use at least {MIN_PASSWORD} characters")
    salt = secrets.token_bytes(16)
    db.kv_set("auth_password", {"salt": salt.hex(), "hash": _hash(password, salt), "set": time.time()})
    db.audit_log(f"admin:{reason}", {"ip": ip} if ip else {})


def check_password(password: str) -> bool:
    rec = db.kv_get("auth_password")
    if not rec:
        return False
    return hmac.compare_digest(_hash(password, bytes.fromhex(rec["salt"])), rec["hash"])


# ── sessions ────────────────────────────────────────────────────────────────

def _sid(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session(req: Request) -> str:
    token, now = secrets.token_urlsafe(32), time.time()
    with db.conn() as c:
        c.execute("INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?)",
                  (_sid(token), secrets.token_urlsafe(24), now, now, now + SESSION_TTL,
                   _client_ip(req.scope), req.headers.get("user-agent", "")[:200]))
    return token


def _session(token: str | None) -> dict | None:
    if not token:
        return None
    now = time.time()
    with db.conn() as c:
        row = c.execute("SELECT * FROM auth_sessions WHERE id=? AND expires>?", (_sid(token), now)).fetchone()
        if row and now - row["last_seen"] > 3600:  # sliding expiry, written at most hourly
            c.execute("UPDATE auth_sessions SET last_seen=?, expires=? WHERE id=?", (now, now + SESSION_TTL, row["id"]))
    return dict(row) if row else None


def frame_mac(secret: str, scope: str) -> str:
    return hmac.new(secret.encode(), scope.encode(), hashlib.sha256).hexdigest()[:32]


def local_frame_secret() -> str:
    """The frame secret of pages shown on this machine without a login (kiosk, cover screenshots)."""
    s = db.kv_get("frame_local_secret")
    if not s:
        s = secrets.token_hex(24)
        db.kv_set("frame_local_secret", s)
    return s


def frame_prefix(secret: str, scope: str) -> str:
    return f"/api/k/{scope}.{frame_mac(secret, scope)}"


_grants: dict[str, tuple[float, str, str | None]] = {}  # key -> (checked at, scope, session id or None for local)


def _frame_grant(key: str, local: bool) -> tuple[str, dict | None] | None:
    """(scope, session) for a valid scoped key, else None. A local-secret key is only good on loopback."""
    m = SCOPED_KEY.match(key)
    if not m:
        return None
    scope, mac = m.groups()
    now = time.time()
    hit = _grants.get(key)
    with db.conn() as c:
        if hit and now - hit[0] < 60:
            if hit[2] is None:
                return (scope, None) if local else None
            row = c.execute("SELECT * FROM auth_sessions WHERE id=? AND expires>?", (hit[2], now)).fetchone()
            return (scope, dict(row)) if row else None
        rows = c.execute("SELECT * FROM auth_sessions WHERE expires>?", (now,)).fetchall()
    if len(_grants) > 2000:
        _grants.clear()
    for r in rows:
        if hmac.compare_digest(frame_mac(r["frame_key"], scope), mac):
            _grants[key] = (now, scope, r["id"])
            return scope, dict(r)
    if hmac.compare_digest(frame_mac(local_frame_secret(), scope), mac):
        _grants[key] = (now, scope, None)
        return (scope, None) if local else None
    return None


def _frame_allowed(scope: str, method: str, rest: str, query: str) -> bool:
    """A scoped key reaches its own project or chat, the shared files, and its own saved state."""
    if any(method in ms and rx.match(rest) for ms, rx in FRAME_SHARED):
        return True
    kind, _, ident = scope.partition("-")
    if rest in ("appstate/boot.js", "appstate") and method in ({"GET", "HEAD"} if rest.endswith(".js") else {"GET", "HEAD", "POST"}):
        s = (parse_qs(query).get("s") or [""])[0]
        return not s or (kind == "p" and s == f"proj:{ident}") or (kind == "w" and s.startswith(f"art:{ident}:"))
    if method not in ("GET", "HEAD"):
        return False
    if kind == "p":
        return re.match(rf"^projects/{re.escape(ident)}/(raw|draft)/", rest) is not None
    if kind == "w":
        return rest.startswith(f"workspace/{ident}/") and len(rest) > len(f"workspace/{ident}/")
    return False


def _from_page(h: dict) -> bool:
    """A request some page made (sandboxed frame, preview, website) rather than this machine's own tools."""
    return h.get("origin") == "null" or h.get("sec-fetch-site") in SANDBOX_SITES


def drop_sessions(keep_id: str | None = None):
    with db.conn() as c:
        c.execute("DELETE FROM auth_sessions WHERE id IS NOT ?", (keep_id,))


# ── request helpers ─────────────────────────────────────────────────────────

def _headers(scope) -> dict:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


def _raw_socket_ip(scope) -> str:
    return (scope.get("client") or ("", 0))[0] or ""


# Proxies whose forwarding headers are believed: `tailscale serve` (loopback) and hub-cloudflared / Caddy (Docker
# bridges). Anyone else could put any address in X-Forwarded-For and get a fresh login-throttle bucket per attempt.
_PROXY_NETS = [ipaddress.ip_network(n) for n in ("127.0.0.0/8", "::1/128", "172.16.0.0/12")]


def _is_proxy(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a in n for n in _PROXY_NETS)


def _client_ip(scope) -> str:
    """The address a request came from: the socket peer, or, behind a trusted proxy, the right-most forwarded address
    that isn't itself a proxy (left-most entries are whatever the client claimed)."""
    raw = _raw_socket_ip(scope)
    if _is_proxy(raw):
        h = _headers(scope)
        hops = [x.strip() for x in h.get("x-forwarded-for", "").split(",") if x.strip()]
        if h.get("x-real-ip"):
            hops.append(h["x-real-ip"].strip())
        for hop in reversed(hops):
            try:
                ip = str(ipaddress.ip_address(hop))
            except ValueError:
                continue
            if not _is_proxy(ip):
                return ip
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return raw


def _is_local(scope, h: dict) -> bool:
    if "x-forwarded-for" in h or "forwarded" in h or "x-real-ip" in h:
        return False
    try:
        return ipaddress.ip_address(_raw_socket_ip(scope)).is_loopback
    except ValueError:
        return False


def _cookie(h: dict) -> str | None:
    c = SimpleCookie()
    try:
        c.load(h.get("cookie", ""))
    except Exception:
        return None
    return c[COOKIE].value if COOKIE in c else None


def _same_origin(h: dict) -> bool:
    """For cookie-authenticated writes: block other sites and other ports on this host (SameSite ignores ports)."""
    origin = h.get("origin")
    if origin is None:
        return True  # browsers send Origin on cross-origin writes; tools like curl don't, and can't ride the cookie anyway
    hosts = {h.get("host", ""), h.get("x-forwarded-host", "")} - {""}
    return any(origin.endswith("://" + host) for host in hosts)


def is_owner(req: Request) -> bool:
    """A logged-in owner session (not localhost, not a frame key). Used as the admin check."""
    return req.scope.get("shellb_auth") == "session"


def session_of(req: Request) -> dict | None:
    return req.scope.get("shellb_session")


ADMIN_KEY_FILE = db.DATA / "admin.key"


def is_admin(req: Request) -> bool:
    if is_owner(req):
        return True
    if CELL:  # the admin key is the host's; inside a cell only the gateway's owner session counts
        return False
    # headers only: a key in the query string ends up in access logs, browser history and Referer headers
    given = req.headers.get("x-shellb-admin") or req.headers.get("x-admin-key")
    if not given or not ADMIN_KEY_FILE.is_file():
        return False
    return hmac.compare_digest(given.strip(), ADMIN_KEY_FILE.read_text().strip())


def require_admin(req: Request):
    if not is_admin(req):
        raise HTTPException(403, "admin-key-required")


# ── middleware ──────────────────────────────────────────────────────────────

def _bad_path(path: str) -> bool:
    """A decoded path with a `.` or `..` segment, a backslash or a NUL. No route has one, and an ID taken from such a
    segment points outside its folder: `/api/projects/%2e%2e` would be data/ itself."""
    return "\\" in path or "\0" in path or any(seg in (".", "..") for seg in path.split("/"))


class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/api"):
            return await self.app(scope, receive, send)
        h, path, method = _headers(scope), scope["path"], scope.get("method", "GET")
        if _bad_path(path):
            return await _deny(scope, receive, send, 400, "bad-path")
        if CELL:
            return await _cell_auth(self.app, scope, receive, send, h, path, method)

        m = FRAME_PREFIX.match(path)
        if m:
            key, rest = m.groups()
            grant = _frame_grant(key, _is_local(scope, h))
            if not grant:
                return await _deny(scope, receive, send, 401, "login-required")
            if not _frame_allowed(grant[0], method, rest, scope.get("query_string", b"").decode("latin-1")):
                return await _deny(scope, receive, send, 403, "outside-frame-scope")
            scope = {**scope, "path": "/api/" + rest, "raw_path": ("/api/" + rest).encode(),
                     "shellb_auth": "frame", "shellb_session": grant[1], "shellb_prefix": f"/api/k/{key}"}
            return await self.app(scope, receive, send)

        sess = _session(_cookie(h))
        if sess:
            if method in UNSAFE and not _same_origin(h):
                return await _deny(scope, receive, send, 403, "cross-origin-request")
            # a Studio page framed with the cookie moves under the frame prefix, where its subresources work too
            # a project page opened with the cookie, framed or in its own tab, moves under the frame key: it runs
            # sandboxed (projects.PAGE_SANDBOX), so its relative URLs need a prefix that works without the cookie
            loc = _page_location(sess["frame_key"], method, path, h, scope)
            if loc:
                return await _redirect(send, loc)
            scope = {**scope, "shellb_auth": "session", "shellb_session": sess}
        elif _is_local(scope, h) and _from_page(h):
            # loopback, but sent by a page (a sandboxed frame, a preview, a website open on this machine): no local trust
            if method in UNSAFE and SANDBOX_WRITES.match(path):
                scope = {**scope, "shellb_auth": "local"}
            elif not PUBLIC.match(path):
                return await _deny(scope, receive, send, 401, "login-required")
        elif _is_local(scope, h):
            loc = _page_location(local_frame_secret(), method, path, h, scope)  # kiosk, cover screenshots
            if loc:
                return await _redirect(send, loc)
            # localhost trust is for this machine's own tools, not for pages it renders: a write that a browser sends
            # from another origin (e.g. a Studio dev-server preview on :8210, or any website) doesn't get it
            if _local_write_refused(method, path, h):
                return await _deny(scope, receive, send, 403, "cross-origin-request")
            scope = {**scope, "shellb_auth": "local"}
        elif not PUBLIC.match(path):
            return await _deny(scope, receive, send, 401, "login-required")
        return await self.app(scope, receive, send)


async def _cell_auth(app, scope, receive, send, h: dict, path: str, method: str):
    """Cell mode: a frame key signed with the cell's frame secret reaches its own scope; the gateway's header is the
    owner; nothing else gets in (requests arrive over the gateway's socket, so there is no localhost here)."""
    m = FRAME_PREFIX.match(path)
    if m:
        key, rest = m.groups()
        km = SCOPED_KEY.match(key)
        if not km or not hmac.compare_digest(frame_mac(CELL_FRAME_SECRET, km.group(1)), km.group(2)):
            return await _deny(scope, receive, send, 401, "login-required")
        if not _frame_allowed(km.group(1), method, rest, scope.get("query_string", b"").decode("latin-1")):
            return await _deny(scope, receive, send, 403, "outside-frame-scope")
        scope = {**scope, "path": "/api/" + rest, "raw_path": ("/api/" + rest).encode(),
                 "shellb_auth": "frame", "shellb_session": None, "shellb_prefix": f"/api/k/{key}"}
        return await app(scope, receive, send)
    if not hmac.compare_digest(h.get(CELL_HEADER, "").encode("latin-1"), CELL_SECRET.encode()):
        return await _deny(scope, receive, send, 401, "login-required")
    if method in UNSAFE and not _same_origin(h):
        return await _deny(scope, receive, send, 403, "cross-origin-request")
    loc = _page_location(CELL_FRAME_SECRET, method, path, h, scope)
    if loc:
        return await _redirect(send, loc)
    return await app({**scope, "shellb_auth": "session", "shellb_session": CELL_SESSION}, receive, send)


def _page_location(secret: str, method: str, path: str, h: dict, scope) -> str | None:
    """A project page or a chat's /work file opened as a page (framed or in its own tab) runs sandboxed, so its relative
    URLs need a prefix that works without the cookie: redirect it under its own scoped key."""
    if method != "GET" or h.get("sec-fetch-dest") not in PAGE_DESTS:
        return None
    m = RAW_PAGE.match(path)
    w = None if m else WORK_PAGE.match(path)
    if not (m or w):
        return None
    qs = scope.get("query_string", b"").decode("latin-1")
    return f"{frame_prefix(secret, ('p-' if m else 'w-') + (m or w).group(1))}/{quote(path[5:])}" + (f"?{qs}" if qs else "")


def _local_write_refused(method: str, path: str, h: dict) -> bool:
    """Localhost trust is for this machine's own tools (no Origin) and the app's own page, not for pages it renders.
    A write from another origin (a dev-server preview on :8210, any website) is refused, and so is one from sandboxed
    content (Origin: null, e.g. a project page in a headless-Firefox screenshot) except SANDBOX_WRITES."""
    if method not in UNSAFE:
        return False
    origin = h.get("origin")
    if origin is None:
        return False
    if origin == "null":
        return not SANDBOX_WRITES.match(path)
    return not _same_origin(h)


async def _deny(scope, receive, send, status, detail):
    if scope["type"] == "websocket":
        return await send({"type": "websocket.close", "code": 4401})
    await JSONResponse({"detail": detail}, status_code=status, headers={"Cache-Control": "no-store"})(scope, receive, send)


async def _redirect(send, loc):
    await send({"type": "http.response.start", "status": 302,
                "headers": [(b"location", loc.encode("latin-1")), (b"cache-control", b"no-store"), (b"content-length", b"0")]})
    await send({"type": "http.response.body", "body": b""})


# ── login throttling & brute-force protection ──────────────────────────────

_IP_FAILS: dict[str, list[float]] = {}
_GLOBAL_FAILS: list[float] = []
_GLOBAL_COOLDOWN_UNTIL: float = 0.0


def _load_recent_fails():
    """Load recent failures from DB on startup so restarts don't clear lockouts."""
    global _IP_FAILS, _GLOBAL_FAILS
    now = time.time()
    try:
        with db.conn() as c:
            rows = c.execute(
                "SELECT ip, ts FROM auth_attempts WHERE ts > ? AND success = 0 ORDER BY ts ASC",
                (now - 900,)
            ).fetchall()
            _IP_FAILS = {}
            _GLOBAL_FAILS = []
            for r in rows:
                _IP_FAILS.setdefault(r["ip"], []).append(r["ts"])
                _GLOBAL_FAILS.append(r["ts"])
    except Exception:
        pass


def _throttle(ip: str):
    """Dual-layer rate limiting: per-IP exponential backoff + global single-password brute-force protection."""
    now = time.time()
    global _GLOBAL_COOLDOWN_UNTIL, _GLOBAL_FAILS, _IP_FAILS

    # 1. Global single-password brute-force protection across ALL IPs
    _GLOBAL_FAILS = [t for t in _GLOBAL_FAILS if now - t < 900]
    if now < _GLOBAL_COOLDOWN_UNTIL:
        wait = int(_GLOBAL_COOLDOWN_UNTIL - now) + 1
        raise HTTPException(
            status_code=429,
            detail=f"System login temporarily locked due to repeated failed attempts across the network. Try again in {wait} s.",
            headers={"Retry-After": str(wait)}
        )

    recent_5m_global = [t for t in _GLOBAL_FAILS if now - t < 300]
    if len(recent_5m_global) >= 20:
        _GLOBAL_COOLDOWN_UNTIL = now + 120
        raise HTTPException(
            status_code=429,
            detail="System login temporarily locked due to repeated failed attempts across the network. Try again in 120 s.",
            headers={"Retry-After": "120"}
        )
    elif len(recent_5m_global) >= 10:
        elapsed = now - recent_5m_global[-1]
        if elapsed < 5:
            wait = int(5 - elapsed) + 1
            raise HTTPException(
                status_code=429,
                detail=f"High failure rate detected. Please wait {wait} s before retrying.",
                headers={"Retry-After": str(wait)}
            )

    # 2. Per-IP rate limiting
    recent_ip = [t for t in _IP_FAILS.get(ip, []) if now - t < 900]
    _IP_FAILS[ip] = recent_ip
    if len(recent_ip) >= 5:
        exponent = min(len(recent_ip) - 5, 5)
        backoff = min(30 * (2 ** exponent), 900)
        elapsed = now - recent_ip[-1]
        wait = backoff - elapsed
        if wait > 0:
            wait_sec = int(wait) + 1
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed login attempts from this IP. Try again in {wait_sec} s.",
                headers={"Retry-After": str(wait_sec)}
            )


async def _failed(ip: str, endpoint: str = "login"):
    """Records a failed attempt in memory and SQLite, and applies timing/burst delay."""
    now = time.time()
    global _GLOBAL_FAILS, _IP_FAILS
    _GLOBAL_FAILS.append(now)
    _IP_FAILS.setdefault(ip, []).append(now)
    try:
        with db.conn() as c:
            c.execute(
                "INSERT INTO auth_attempts(ip, ts, success, endpoint) VALUES(?, ?, 0, ?)",
                (ip, now, endpoint)
            )
    except Exception:
        pass
    # Mitigation against automated rapid-fire bursts and timing attacks
    await asyncio.sleep(0.5)


def _succeeded(ip: str, endpoint: str = "login"):
    """Records a successful login, resetting failure counters for this IP."""
    now = time.time()
    global _IP_FAILS
    _IP_FAILS.pop(ip, None)
    try:
        with db.conn() as c:
            c.execute(
                "INSERT INTO auth_attempts(ip, ts, success, endpoint) VALUES(?, ?, 1, ?)",
                (ip, now, endpoint)
            )
    except Exception:
        pass


def _set_cookie(resp: JSONResponse, req: Request, token: str):
    secure = req.url.scheme == "https" or req.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True, samesite="lax", secure=secure, path="/")


def _me(req: Request, sess: dict | None = None) -> dict:
    sess = sess if sess is not None else session_of(req)
    how = req.scope.get("shellb_auth")
    return {"authenticated": bool(sess) or how == "local", "via": "session" if sess else how,
            "passwordSet": has_password(),
            "frameKey": sess["frame_key"] if sess else local_frame_secret() if how == "local" else None}


# ── routes ──────────────────────────────────────────────────────────────────

@router.get("/me")
def me(req: Request):
    return JSONResponse(_me(req), headers={"Cache-Control": "no-store"})


@router.get("/passkeys/available")
def passkeys_available(req: Request):
    """Public: whether a passkey exists for this address, so the login screen can offer the button."""
    rp_id, _o = _rp(req)
    return {"available": any(r["rp_id"] == rp_id for r in _passkey_rows())}


@router.get("/status")
def auth_status(req: Request):
    ip = _client_ip(req.scope)
    now = time.time()
    ip_fails = len([t for t in _IP_FAILS.get(ip, []) if now - t < 900])
    global_fails = len([t for t in _GLOBAL_FAILS if now - t < 900])
    return {
        "ip": ip,
        "recentIpFailures": ip_fails,
        "maxIpFailuresBeforeLock": 5,
        "recentGlobalFailures": global_fails,
        "globalLockActive": now < _GLOBAL_COOLDOWN_UNTIL,
    }


@router.post("/setup")
async def setup(req: Request):
    """First run: choose the password. Proves access to the box with the admin key from data/admin.key."""
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if has_password():
        raise HTTPException(409, "A password is already set. Log in, or reset it from the shell.")
    given = str(body.get("adminKey", "")).strip()
    if not given or not hmac.compare_digest(given, (db.DATA / "admin.key").read_text().strip()):
        await _failed(ip, "setup")
        raise HTTPException(403, "That admin key is wrong. Run: cat ~/shellb/web/data/admin.key")
    try:
        set_password(str(body.get("password", "")), reason="password_setup", ip=ip)
    except ValueError as e:
        raise HTTPException(400, str(e))
    _succeeded(ip, "setup")
    return _login_response(req)


@router.post("/login")
async def login(req: Request):
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not has_password():
        raise HTTPException(409, "no-password")
    if not check_password(str(body.get("password", ""))):
        await _failed(ip, "login")
        raise HTTPException(401, "Wrong password")
    _succeeded(ip, "login")
    if two_step_on():  # the password alone opens nothing: a short-lived ticket waits for the code
        ticket = secrets.token_urlsafe(32)
        _prune_tickets()
        _tickets[ticket] = (time.time(), ip)
        return JSONResponse({"authenticated": False, "via": None, "passwordSet": True, "frameKey": None,
                             "needsCode": True, "pending": ticket})
    return _login_response(req)


# ── two-step verification (owner) ───────────────────────────────────────────
# kv auth_2fa = {"secret": base32, "last": step, "recovery": [sha256 of normalised codes, unused only], "set": ts}.
# Stored like the password (same database, same backups); losing the phone is handled by a recovery code or by
# `auth.py set-password` from the shell, which clears it along with the password.

TICKET_TTL = 10 * 60
SETUP_TTL = 15 * 60
ISSUER = "Shell:B"
_tickets: dict[str, tuple[float, str]] = {}  # login ticket → (issued, ip): password accepted, code still due
_setup: tuple[str, float] | None = None       # (secret being set up, when)


def two_step_on() -> bool:
    return bool((db.kv_get("auth_2fa") or {}).get("secret"))


def _prune_tickets():
    now = time.time()
    for t, (ts, _ip) in list(_tickets.items()):
        if now - ts > TICKET_TTL:
            _tickets.pop(t, None)


def _owner_session(req: Request) -> dict:
    sess = session_of(req)
    if not sess or not is_owner(req):
        raise HTTPException(401, "login-required")
    return sess


@router.post("/login/code")
async def login_code(req: Request):
    """Second step of the login: the authenticator code (or a recovery code) for a ticket from /login."""
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    _prune_tickets()
    ticket = str(body.get("pending") or "")
    issued = _tickets.get(ticket)
    if not issued or issued[1] != ip:
        raise HTTPException(401, "Start the login again.")
    rec = db.kv_get("auth_2fa") or {}
    if not rec.get("secret"):
        _tickets.pop(ticket, None)
        return _login_response(req)
    code = str(body.get("code") or "")
    step = otp.step_for(rec["secret"], code, int(rec.get("last") or 0))
    used_recovery = False
    if step is None:
        h = otp.sha(otp.norm_recovery(code))
        if len(otp.norm_recovery(code)) == 10 and h in (rec.get("recovery") or []):
            used_recovery = True
        else:
            await _failed(ip, "code")
            raise HTTPException(401, "That code doesn't match. Enter the newest code from your authenticator, or a recovery code.")
    if used_recovery:
        rec["recovery"] = [x for x in rec["recovery"] if x != otp.sha(otp.norm_recovery(code))]
        db.audit_log("admin:2fa_recovery_used", {"ip": ip, "left": len(rec["recovery"])})
    else:
        rec["last"] = step
    db.kv_set("auth_2fa", rec)
    _tickets.pop(ticket, None)
    _succeeded(ip, "code")
    return _login_response(req)


# ── passkeys (WebAuthn) ─────────────────────────────────────────────────────
# A passkey is a second way in, next to the password: the owner registers one from a signed-in session (any platform
# authenticator or security key), and later signs in with it alone; two-step verification is satisfied by the passkey
# itself (it is a possession factor verified by the device). py_webauthn does the ceremonies; the relying party id is the
# host the app is reached on (ai.shellb.app, the Tailscale name…), so a passkey is bound to the address it was made at.
# Table auth_passkeys: credential id, public key, sign count, transports, a label, the rp id.

PASSKEY_TTL = 5 * 60
_passkey_challenges: dict[str, tuple[bytes, float, str]] = {}  # challenge id → (challenge, issued, kind)


def _rp(req: Request) -> tuple[str, str]:
    """(rp id, expected origin) for this request: the host name without a port, and the scheme+host the browser sees."""
    host = (req.headers.get("x-forwarded-host") or req.headers.get("host") or "localhost").split(",")[0].strip()
    hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 and not host.startswith("[") else host.strip("[]").split("]")[0]
    proto = (req.headers.get("x-forwarded-proto") or req.url.scheme or "https").split(",")[0].strip()
    return hostname.lower(), f"{proto}://{host}"


def _passkey_rows() -> list[dict]:
    with db.conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM auth_passkeys ORDER BY created")]


def passkeys_on() -> bool:
    with db.conn() as c:
        return bool(c.execute("SELECT 1 FROM auth_passkeys LIMIT 1").fetchone())


def _new_challenge(kind: str) -> tuple[str, bytes]:
    now = time.time()
    for k, (_c, ts, _k) in list(_passkey_challenges.items()):
        if now - ts > PASSKEY_TTL:
            _passkey_challenges.pop(k, None)
    cid, ch = secrets.token_urlsafe(16), secrets.token_bytes(32)
    _passkey_challenges[cid] = (ch, now, kind)
    return cid, ch


def _take_challenge(cid: str, kind: str) -> bytes:
    item = _passkey_challenges.pop(str(cid or ""), None)
    if not item or item[2] != kind or time.time() - item[1] > PASSKEY_TTL:
        raise HTTPException(400, "That passkey request expired. Start again.")
    return item[0]


@router.get("/passkeys")
def passkeys_list(req: Request):
    _owner_session(req)
    return {"passkeys": [{"id": r["id"], "label": r["label"], "rpId": r["rp_id"], "created": r["created"], "lastUsed": r["last_used"]}
                         for r in _passkey_rows()]}


@router.post("/passkeys/register/begin")
async def passkey_register_begin(req: Request):
    """Options for navigator.credentials.create(); needs the password (a session alone shouldn't mint a lasting key)."""
    _owner_session(req)
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not check_password(str(body.get("password", ""))):
        await _failed(ip, "passkey")
        raise HTTPException(403, "The password is wrong")
    _succeeded(ip, "passkey")
    from webauthn import generate_registration_options, options_to_json
    from webauthn.helpers.structs import AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor, ResidentKeyRequirement, UserVerificationRequirement
    rp_id, _origin = _rp(req)
    cid, ch = _new_challenge("register")
    opts = generate_registration_options(
        rp_id=rp_id, rp_name="Shell:B", user_id=b"owner", user_name="owner", user_display_name="Shell:B owner", challenge=ch,
        exclude_credentials=[PublicKeyCredentialDescriptor(id=bytes.fromhex(r["id"])) for r in _passkey_rows()],
        authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.PREFERRED,
                                                              user_verification=UserVerificationRequirement.PREFERRED),
        timeout=PASSKEY_TTL * 1000)
    return {"challengeId": cid, "options": json.loads(options_to_json(opts))}


@router.post("/passkeys/register/finish")
async def passkey_register_finish(req: Request):
    _owner_session(req)
    body = await req.json()
    from webauthn import verify_registration_response
    rp_id, origin = _rp(req)
    ch = _take_challenge(body.get("challengeId"), "register")
    try:
        v = verify_registration_response(credential=body.get("credential"), expected_challenge=ch, expected_rp_id=rp_id,
                                         expected_origin=origin, require_user_verification=False)
    except Exception as e:  # noqa: BLE001  py_webauthn raises its own classes, ValueError, KeyError, binascii.Error… all mean "no"
        raise HTTPException(400, f"The browser's answer didn't verify: {type(e).__name__}: {str(e)[:160]}")
    label = str(body.get("label") or "").strip()[:60] or f"Passkey ({time.strftime('%Y-%m-%d')})"
    transports = json.dumps([str(t) for t in (body.get("transports") or [])][:6])
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO auth_passkeys(id, public_key, sign_count, transports, label, rp_id, created, last_used) VALUES(?,?,?,?,?,?,?,NULL)",
                  (v.credential_id.hex(), v.credential_public_key, int(v.sign_count), transports, label, rp_id, time.time()))
    db.audit_log("admin:passkey_added", {"label": label, "rp": rp_id, "ip": _client_ip(req.scope)})
    return {"ok": True, "id": v.credential_id.hex(), "label": label}


@router.delete("/passkeys/{pid}")
def passkey_delete(pid: str, req: Request):
    _owner_session(req)
    with db.conn() as c:
        n = c.execute("DELETE FROM auth_passkeys WHERE id=?", (pid,)).rowcount
    if not n:
        raise HTTPException(404, "No such passkey")
    db.audit_log("admin:passkey_removed", {"id": pid[:16]})
    return {"ok": True}


@router.post("/passkeys/login/begin")
async def passkey_login_begin(req: Request):
    """Options for navigator.credentials.get(); public, like /login. Only credentials made for this host are offered."""
    ip = _client_ip(req.scope)
    _throttle(ip)
    rp_id, _origin = _rp(req)
    rows = [r for r in _passkey_rows() if r["rp_id"] == rp_id]
    if not rows:
        raise HTTPException(404, "No passkey is set up for this address")
    from webauthn import generate_authentication_options, options_to_json
    from webauthn.helpers.structs import PublicKeyCredentialDescriptor, UserVerificationRequirement
    cid, ch = _new_challenge("login")
    opts = generate_authentication_options(rp_id=rp_id, challenge=ch, timeout=PASSKEY_TTL * 1000,
                                           allow_credentials=[PublicKeyCredentialDescriptor(id=bytes.fromhex(r["id"])) for r in rows],
                                           user_verification=UserVerificationRequirement.PREFERRED)
    return {"challengeId": cid, "options": json.loads(options_to_json(opts))}


@router.post("/passkeys/login/finish")
async def passkey_login_finish(req: Request):
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    from webauthn import verify_authentication_response
    from webauthn.helpers import base64url_to_bytes
    rp_id, origin = _rp(req)
    ch = _take_challenge(body.get("challengeId"), "login")
    cred = body.get("credential") or {}
    try:
        raw_id = base64url_to_bytes(str(cred.get("rawId") or cred.get("id") or "")).hex()
    except Exception:  # noqa: BLE001
        raw_id = ""
    with db.conn() as c:
        row = c.execute("SELECT * FROM auth_passkeys WHERE id=? AND rp_id=?", (raw_id, rp_id)).fetchone()
    if not row:
        await _failed(ip, "passkey")
        raise HTTPException(401, "That passkey isn't registered here")
    try:
        v = verify_authentication_response(credential=cred, expected_challenge=ch, expected_rp_id=rp_id, expected_origin=origin,
                                           credential_public_key=row["public_key"], credential_current_sign_count=int(row["sign_count"] or 0),
                                           require_user_verification=False)
    except Exception as e:  # noqa: BLE001
        await _failed(ip, "passkey")
        raise HTTPException(401, f"The passkey didn't verify: {type(e).__name__}: {str(e)[:140]}")
    with db.conn() as c:
        c.execute("UPDATE auth_passkeys SET sign_count=?, last_used=? WHERE id=?", (int(v.new_sign_count), time.time(), raw_id))
    _succeeded(ip, "passkey")
    db.audit_log("admin:passkey_login", {"label": row["label"], "ip": ip})
    return _login_response(req)  # a passkey is its own second factor: no TOTP step


@router.get("/2fa")
def two_step_status(req: Request):
    _owner_session(req)
    rec = db.kv_get("auth_2fa") or {}
    return {"on": bool(rec.get("secret")), "recoveryLeft": len(rec.get("recovery") or []), "since": rec.get("set")}


@router.post("/2fa/begin")
async def two_step_begin(req: Request):
    """Start setup: the current password, then a fresh secret to scan. Nothing changes until /2fa/confirm."""
    global _setup
    _owner_session(req)
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not check_password(str(body.get("password", ""))):
        await _failed(ip, "2fa")
        raise HTTPException(403, "The password is wrong")
    _succeeded(ip, "2fa")
    secret = otp.new_secret()
    _setup = (secret, time.time())
    return {"secret": secret, "uri": otp.uri(ISSUER, "owner", secret)}


@router.post("/2fa/confirm")
async def two_step_confirm(req: Request):
    """Prove the authenticator has the secret (one correct code), then turn two-step on and hand out recovery codes."""
    global _setup
    _owner_session(req)
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not _setup or time.time() - _setup[1] > SETUP_TTL:
        raise HTTPException(409, "Setup timed out. Start again.")
    step = otp.step_for(_setup[0], str(body.get("code") or ""), 0)
    if step is None:
        await _failed(ip, "2fa")
        raise HTTPException(400, "That code doesn't match. Check the phone's clock, then enter the newest code.")
    codes = otp.new_recovery_codes()
    db.kv_set("auth_2fa", {"secret": _setup[0], "last": step, "recovery": [otp.sha(c) for c in codes], "set": time.time()})
    _setup = None
    _succeeded(ip, "2fa")
    db.audit_log("admin:2fa_on", {"ip": ip})
    return {"on": True, "recovery": [otp.pretty(c) for c in codes]}


@router.post("/2fa/recovery")
async def two_step_recovery(req: Request):
    """New recovery codes (the old ones stop working). Needs the password."""
    _owner_session(req)
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    rec = db.kv_get("auth_2fa") or {}
    if not rec.get("secret"):
        raise HTTPException(409, "Two-step verification is off.")
    if not check_password(str(body.get("password", ""))):
        await _failed(ip, "2fa")
        raise HTTPException(403, "The password is wrong")
    _succeeded(ip, "2fa")
    codes = otp.new_recovery_codes()
    rec["recovery"] = [otp.sha(c) for c in codes]
    db.kv_set("auth_2fa", rec)
    db.audit_log("admin:2fa_recovery_new", {"ip": ip})
    return {"recovery": [otp.pretty(c) for c in codes]}


@router.post("/2fa/disable")
async def two_step_disable(req: Request):
    _owner_session(req)
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not check_password(str(body.get("password", ""))):
        await _failed(ip, "2fa")
        raise HTTPException(403, "The password is wrong")
    _succeeded(ip, "2fa")
    db.kv_set("auth_2fa", None)
    db.audit_log("admin:2fa_off", {"ip": ip})
    return {"on": False}


def _login_response(req: Request) -> JSONResponse:
    token = new_session(req)
    resp = JSONResponse(_me(req, _session(token)))
    _set_cookie(resp, req, token)
    return resp


@router.post("/logout")
def logout(req: Request):
    sess = session_of(req)
    if sess:
        with db.conn() as c:
            c.execute("DELETE FROM auth_sessions WHERE id=?", (sess["id"],))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@router.post("/password")
async def change_password(req: Request):
    """Change the password (needs the current one) and sign out every other session."""
    sess = session_of(req)
    if not sess or not is_owner(req):
        raise HTTPException(401, "login-required")
    body = await req.json()
    ip = _client_ip(req.scope)
    _throttle(ip)
    if not check_password(str(body.get("current", ""))):
        await _failed(ip, "password")
        raise HTTPException(403, "The current password is wrong")
    try:
        set_password(str(body.get("password", "")), reason="password_change", ip=ip)
    except ValueError as e:
        raise HTTPException(400, str(e))
    _succeeded(ip, "password")
    drop_sessions(keep_id=sess["id"])
    return {"ok": True}


@router.get("/sessions")
def sessions(req: Request):
    sess = session_of(req)
    if not is_owner(req):
        raise HTTPException(401, "login-required")
    with db.conn() as c:
        rows = c.execute("SELECT id, created, last_seen, ip, ua FROM auth_sessions WHERE expires>? ORDER BY last_seen DESC",
                         (time.time(),)).fetchall()
    return [{"created": r["created"], "lastSeen": r["last_seen"], "ip": r["ip"], "userAgent": r["ua"],
             "current": r["id"] == sess["id"]} for r in rows]


@router.post("/logout-others")
def logout_others(req: Request):
    if not is_owner(req):
        raise HTTPException(401, "login-required")
    drop_sessions(keep_id=session_of(req)["id"])
    return {"ok": True}


if __name__ == "__main__":
    import getpass
    import sys
    if sys.argv[1:] == ["disable-2fa"]:
        init()
        db.kv_set("auth_2fa", None)
        db.audit_log("admin:2fa_off_cli", {})
        sys.exit("Two-step verification is off. The password still applies.")
    if sys.argv[1:] != ["set-password"]:
        sys.exit("usage: auth.py set-password | disable-2fa")
    init()
    pw = getpass.getpass("New Shell:B password: ")
    if pw != getpass.getpass("Again: "):
        sys.exit("The passwords don't match.")
    try:
        set_password(pw, reason="password_reset_cli")
    except ValueError as e:
        sys.exit(str(e))
    if two_step_on():
        db.kv_set("auth_2fa", None)
        print("Two-step verification was turned off too (set it up again from Settings → Account).")
    drop_sessions()
    print("Password set. Every session was signed out.")
