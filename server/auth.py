"""Owner login for Shell:B Web: one password, cookie sessions, and trusted localhost.

Who gets in:
- **The machine itself.** A request from 127.0.0.1/::1 that no proxy forwarded (no X-Forwarded-For / Forwarded)
  needs no login. Headless-Firefox screenshots, `shot.sh` and `curl localhost:8200/api/status` keep working.
  The LAN, Tailscale and the Vite dev proxy (which sends X-Forwarded-For) all have to log in.
- **The owner.** POST /api/auth/login with the password sets an HttpOnly `shellb_session` cookie. Sessions last
  30 days from last use. A logged-in owner also counts as admin (see `is_owner`). Localhost is not admin.
- **Sandboxed frames.** Artifacts and Studio pages run in iframes with an opaque origin, and browsers don't send
  SameSite cookies from those. Each session therefore has a `frame_key`, and `/api/k/<frame_key>/<rest>` acts as
  `/api/<rest>` for a short allowlist of read-only content routes plus app state (FRAME_ROUTES). It never grants admin.
  A Studio page loaded into an iframe with the cookie is redirected under that prefix, so its relative URLs keep working.
- **Public:** the UI shell and static assets (non-/api paths), /api/auth/*, /api/_hold, and /api/files/* (generated
  media with random names that only authenticated APIs hand out).

The first password is set in the browser with the admin key from data/admin.key, or from the shell:
    ~/shellb/web/venv/bin/python ~/shellb/web/server/auth.py set-password
Setting a password from the shell signs out every session.
"""
import asyncio
import hashlib
import hmac
import ipaddress
import re
import secrets
import time
from http.cookies import SimpleCookie
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

import db

router = APIRouter(prefix="/api/auth")

COOKIE = "shellb_session"
SESSION_TTL = 30 * 86400
MIN_PASSWORD = 8
PUBLIC = re.compile(r"^/api/(auth(/|$)|_hold$|files/[^/]+$)")
# what a frame key may reach: (methods, path under /api/)
FRAME_ROUTES = [
    ({"GET", "HEAD"}, re.compile(r"^appstate/boot\.js$")),
    ({"GET", "HEAD", "POST"}, re.compile(r"^appstate$")),
    ({"GET", "HEAD"}, re.compile(r"^projects/[A-Za-z0-9_-]+/(raw|draft)/.*")),
    ({"GET", "HEAD"}, re.compile(r"^workspace/[A-Za-z0-9_-]+/.+")),
    ({"GET", "HEAD"}, re.compile(r"^assets/file/[A-Za-z0-9_-]+/.+")),
    ({"GET", "HEAD"}, re.compile(r"^files/[^/]+$")),
]
FRAME_PREFIX = re.compile(r"^/api/k/([A-Za-z0-9_-]{20,64})/(.*)$")
RAW_PAGE = re.compile(r"^/api/projects/[A-Za-z0-9_-]+/(raw|draft)/")
# the only writes sandboxed content (Origin: null) may make on localhost trust: saved app state and the screenshot beacon
SANDBOX_WRITES = re.compile(r"^/api/(appstate|projects/_shotinfo/[A-Za-z0-9]+)$")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def init():
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS auth_sessions(
            id TEXT PRIMARY KEY, frame_key TEXT UNIQUE, created REAL, last_seen REAL, expires REAL, ip TEXT, ua TEXT)""")
        c.execute("DELETE FROM auth_sessions WHERE expires < ?", (time.time(),))
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


def _frame_session(key: str) -> dict | None:
    with db.conn() as c:
        row = c.execute("SELECT * FROM auth_sessions WHERE frame_key=? AND expires>?", (key, time.time())).fetchone()
    return dict(row) if row else None


def drop_sessions(keep_id: str | None = None):
    with db.conn() as c:
        c.execute("DELETE FROM auth_sessions WHERE id IS NOT ?", (keep_id,))


# ── request helpers ─────────────────────────────────────────────────────────

def _headers(scope) -> dict:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


def _raw_socket_ip(scope) -> str:
    return (scope.get("client") or ("", 0))[0] or ""


def _client_ip(scope) -> str:
    h = _headers(scope)
    if "x-forwarded-for" in h:
        raw = h["x-forwarded-for"].split(",")[0].strip()
        try:
            return str(ipaddress.ip_address(raw))
        except ValueError:
            pass
    if "x-real-ip" in h:
        raw = h["x-real-ip"].strip()
        try:
            return str(ipaddress.ip_address(raw))
        except ValueError:
            pass
    raw = _raw_socket_ip(scope)
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
    # headers only: a key in the query string ends up in access logs, browser history and Referer headers
    given = req.headers.get("x-shellb-admin") or req.headers.get("x-admin-key")
    if not given or not ADMIN_KEY_FILE.is_file():
        return False
    return hmac.compare_digest(given.strip(), ADMIN_KEY_FILE.read_text().strip())


def require_admin(req: Request):
    if not is_admin(req):
        raise HTTPException(403, "admin-key-required")


# ── middleware ──────────────────────────────────────────────────────────────

class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/api"):
            return await self.app(scope, receive, send)
        h, path, method = _headers(scope), scope["path"], scope.get("method", "GET")

        m = FRAME_PREFIX.match(path)
        if m:
            key, rest = m.groups()
            sess = _frame_session(key) if any(method in ms and rx.match(rest) for ms, rx in FRAME_ROUTES) else None
            if not sess and not _is_local(scope, h):
                return await _deny(scope, receive, send, 401, "login-required")
            if not sess and _local_write_refused(method, "/api/" + rest, h):
                return await _deny(scope, receive, send, 403, "cross-origin-request")
            scope = {**scope, "path": "/api/" + rest, "raw_path": ("/api/" + rest).encode(),
                     "shellb_auth": "frame", "shellb_session": sess, "shellb_prefix": f"/api/k/{key}"}
            return await self.app(scope, receive, send)

        sess = _session(_cookie(h))
        if sess:
            if method in UNSAFE and not _same_origin(h):
                return await _deny(scope, receive, send, 403, "cross-origin-request")
            # a Studio page framed with the cookie moves under the frame prefix, where its subresources work too
            # a project page opened with the cookie, framed or in its own tab, moves under the frame key: it runs
            # sandboxed (projects.PAGE_SANDBOX), so its relative URLs need a prefix that works without the cookie
            if method == "GET" and RAW_PAGE.match(path) and h.get("sec-fetch-dest") in ("iframe", "frame", "document"):
                qs = scope.get("query_string", b"").decode("latin-1")
                loc = f"/api/k/{sess['frame_key']}/{quote(path[5:])}" + (f"?{qs}" if qs else "")
                return await _redirect(send, loc)
            scope = {**scope, "shellb_auth": "session", "shellb_session": sess}
        elif _is_local(scope, h):
            # localhost trust is for this machine's own tools, not for pages it renders: a write that a browser sends
            # from another origin (e.g. a Studio dev-server preview on :8210, or any website) doesn't get it
            if _local_write_refused(method, path, h):
                return await _deny(scope, receive, send, 403, "cross-origin-request")
            scope = {**scope, "shellb_auth": "local"}
        elif not PUBLIC.match(path):
            return await _deny(scope, receive, send, 401, "login-required")
        return await self.app(scope, receive, send)


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
            "passwordSet": has_password(), "frameKey": sess["frame_key"] if sess else None}


# ── routes ──────────────────────────────────────────────────────────────────

@router.get("/me")
def me(req: Request):
    return JSONResponse(_me(req), headers={"Cache-Control": "no-store"})


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
    return _login_response(req)


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
    if sys.argv[1:] != ["set-password"]:
        sys.exit("usage: auth.py set-password")
    init()
    pw = getpass.getpass("New Shell:B password: ")
    if pw != getpass.getpass("Again: "):
        sys.exit("The passwords don't match.")
    try:
        set_password(pw, reason="password_reset_cli")
    except ValueError as e:
        sys.exit(str(e))
    drop_sessions()
    print("Password set. Every session was signed out.")
