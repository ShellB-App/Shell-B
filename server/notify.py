"""Notifications: Web Push to the owner's devices, so Shell:B can reach her when the tab isn't in view (backlog C10).

What notifies: every Activity event (`activity.post` calls `event`) and every approval an agent is waiting on
(`remote.wait_approval` calls `approval`), filtered by a per-kind level in kv `notify_prefs`: off, attention (failed,
blocked, needs review…) or all. Approvals are held for APPROVAL_GRACE seconds first, so one answered in front of the
chat never buzzes the phone.

Web Push is implemented here without a push library:
- VAPID (RFC 8292): a P-256 key made once in data/notify/vapid.pem (0600); each request carries an ES256 JWT signed
  with it, and browsers bind subscriptions to its public key (`GET /api/notify/key`).
- Payload encryption (RFC 8291) with the aes128gcm content coding (RFC 8188): one record, ephemeral ECDH key per message.

Privacy: the push services (Google FCM, Mozilla autopush, Apple, Microsoft WNS) are third parties. They can't read
the encrypted payload but do see timing, size and the device. Payloads stay minimal anyway: a generic title ("Mega
Plan finished"), the hash route to open and a tag; the item's own title is added only when the owner turns on
`details`. Only the push hosts in PUSH_HOSTS are ever contacted, never a redirect. Subscribing is per device and
opt-in; subscribe, test, devices and preferences are owner-only (owner session or admin key, not localhost trust).

Tabs that can't get push (no push service reachable, plain http on localhost) can still show notifications while open
but hidden: they poll `GET /api/notify/recent`, a small in-memory ring of the same filtered events (ui/src/notifyLocal.ts).
"""
import asyncio
import base64
import hashlib
import json
import os
import queue
import struct
import threading
import time
from collections import deque
from urllib.parse import urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/notify")
DIR = db.DATA / "notify"
VAPID_KEY = DIR / "vapid.pem"
TTL = 12 * 3600            # push services hold an undelivered message this long
APPROVAL_GRACE = 20        # seconds an approval must stay unanswered before it notifies
RECORD_SIZE = 4096
# push services browsers hand out endpoints for; anything else is refused (the server POSTs to these URLs)
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com",
              ".push.apple.com", ".notify.windows.com")
LEVELS = ("off", "attention", "all")
ATTENTION = {"failed", "blocked", "paused", "interrupted", "rolled-back", "restart-pending", "review", "waiting", "warning"}

# id, label, hint, default level. Activity sources mirror activity.SOURCES; approval/question come from remote.py.
KINDS = [
    ("approval", "Approvals", "A self-deploy, remote command or secret is waiting for you", "all"),
    ("question", "Questions", "An agent asked you something and is waiting for the answer", "all"),
    ("schedule", "Scheduled runs", "A scheduled task finished or failed", "all"),
    ("plan", "Mega Plans", "A plan was drafted, finished, paused or failed", "all"),
    ("todo", "Project to-dos", "A to-do an agent was working on finished or got stuck", "all"),
    ("deploy", "Self-deploys", "A Shell:B update went live or rolled back", "all"),
    ("scout", "Asset scouts", "An asset library scout came back", "attention"),
    ("notebook", "Notebooks", "A notebook output finished or failed", "attention"),
    ("codex", "Codex drafts", "A contact or calendar draft needs review", "attention"),
    ("memory", "Memory", "Shell:B learned something and wants you to check it", "off"),
    ("data", "Offline data", "A dataset download finished or failed", "attention"),
    ("shopping", "Price watch", "A watched item hit your target price, dropped or came back in stock", "all"),
    ("health", "System health", "A service went down or came back, a crash loop, low disk or memory", "all"),
]
KIND_IDS = {k[0] for k in KINDS}
NOUN = {"approval": "Approval", "question": "Question", "schedule": "Scheduled task", "plan": "Mega Plan",
        "todo": "To-do", "deploy": "Self-deploy", "scout": "Asset scout", "notebook": "Notebook", "codex": "Codex draft",
        "memory": "Memory", "data": "Offline data", "health": "System health", "shopping": "Price watch"}
VERB = {"done": "finished", "complete": "finished", "failed": "failed", "blocked": "is blocked", "paused": "paused",
        "interrupted": "was interrupted", "rolled-back": "rolled back", "restart-pending": "is waiting for a restart",
        "review": "needs your review", "waiting": "is waiting for you", "warning": "needs attention",
        "recovered": "recovered"}
APPROVAL_NOUN = {"self": "Self-deploy", "remote": "Remote command", "secret": "Secret access", "question": "Question", "browser": "Browser submit"}

_ready = False
_recent: deque = deque(maxlen=50)
_queue: "queue.Queue[dict]" = queue.Queue()
_worker: threading.Thread | None = None
_lock = threading.Lock()


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def init():
    global _ready
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS push_subs(
  id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, label TEXT, ua TEXT, created REAL,
  last_ok REAL, last_error TEXT)""")
        cols = {r[1] for r in c.execute("PRAGMA table_info(push_subs)")}
        for col, typ in (("last_shown", "REAL"), ("shown_error", "TEXT")):  # what the device itself reported (POST /ack)
            if col not in cols:
                c.execute(f"ALTER TABLE push_subs ADD COLUMN {col} {typ}")
    _ready = True


def _db():
    if not _ready:
        init()


# ── VAPID ───────────────────────────────────────────────────────────────────

def vapid_key() -> ec.EllipticCurvePrivateKey:
    with _lock:
        if not VAPID_KEY.exists():
            DIR.mkdir(parents=True, exist_ok=True)
            DIR.chmod(0o700)
            pem = ec.generate_private_key(ec.SECP256R1()).private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            fd = os.open(VAPID_KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(pem)
        return serialization.load_pem_private_key(VAPID_KEY.read_bytes(), None)


def _point(pub: ec.EllipticCurvePublicKey) -> bytes:
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_key() -> str:
    """The applicationServerKey browsers subscribe with: the uncompressed P-256 point, base64url."""
    return b64u(_point(vapid_key().public_key()))


def vapid_header(endpoint: str, now: float | None = None) -> str:
    u = urlsplit(endpoint)
    claims = {"aud": f"{u.scheme}://{u.netloc}", "exp": int((now or time.time()) + TTL),
              "sub": db.kv_get("notify_vapid_sub") or "mailto:owner@shellb.invalid"}
    token = jwt.encode(claims, vapid_key(), algorithm="ES256", headers={"typ": "JWT"})
    return f"vapid t={token}, k={public_key()}"


# ── RFC 8291 payload encryption ─────────────────────────────────────────────

def _hkdf(salt: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
    return HKDF(hashes.SHA256(), n, salt, info).derive(ikm)


def encrypt(plaintext: bytes, p256dh: str, auth: str, *, salt: bytes | None = None,
            sender: ec.EllipticCurvePrivateKey | None = None, pad: int = 0) -> bytes:
    """aes128gcm body for one Web Push message: header (salt, rs, keyid = our ephemeral public key) + one record."""
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    if len(ua_public) != 65 or ua_public[0] != 4 or len(auth_secret) < 16:
        raise ValueError("bad subscription keys")
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    as_public = _point(sender.public_key())
    ecdh = sender.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))
    ikm = _hkdf(auth_secret, ecdh, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = salt or os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    record = plaintext + b"\x02" + b"\x00" * pad  # 0x02: last (only) record, then optional zero padding
    if len(record) + 16 > RECORD_SIZE:
        raise ValueError("payload too large")
    header = salt + struct.pack("!IB", RECORD_SIZE, len(as_public)) + as_public
    return header + AESGCM(cek).encrypt(nonce, record, None)


# ── preferences ─────────────────────────────────────────────────────────────

def prefs() -> dict:
    saved = db.kv_get("notify_prefs") or {}
    levels = saved.get("levels") or {}
    return {"levels": {k: levels.get(k) if levels.get(k) in LEVELS else d for k, _, _, d in KINDS},
            "details": bool(saved.get("details"))}


def wanted(kind: str, status: str) -> bool:
    level = prefs()["levels"].get(kind, "off")
    return level == "all" or (level == "attention" and status in ATTENTION)


# ── events ──────────────────────────────────────────────────────────────────

def _message(kind: str, status: str, title: str, route: str, tag: str, noun: str | None = None) -> dict:
    head = f"{noun or NOUN.get(kind, 'Shell:B')} {VERB.get(status, status)}"
    if kind == "health" and title:  # watchdog titles hold no private content and are the whole message
        head, title = title[:90], ""
    elif kind == "shopping":  # the item and price stay in the body, which follows the "details" preference
        head = "Price alert" if status in ATTENTION else "Price drop"
    msg = {"t": head, "r": route if route.startswith("#/") else "#/activity", "tag": tag,
           "a": status in ATTENTION, "k": kind}
    if prefs()["details"] and title:
        msg["b"] = title[:90]
    return msg


def _remember(msg: dict):
    _recent.append({**msg, "ts": time.time() * 1000})


def event(source: str, status: str, title: str, link: str = "", ref: str | None = None):
    """Called by activity.post for each new event. Never raises and never blocks the caller."""
    try:
        if source not in KIND_IDS or not wanted(source, status):
            return
        tag = "act-" + hashlib.sha1((ref or f"{source}:{title}:{time.time()}").encode()).hexdigest()[:12]
        msg = _message(source, status, title, link, tag)
        _remember(msg)
        _enqueue(msg)
    except Exception as e:  # noqa: BLE001
        print(f"notify.event failed: {type(e).__name__}: {e}")


def approval(aid: str, meta: dict):
    """Called by remote.wait_approval. Notifies only if the approval is still open after APPROVAL_GRACE seconds."""
    try:
        kind = "question" if meta.get("kind") == "question" else "approval"
        if not wanted(kind, "waiting"):
            return
        noun = APPROVAL_NOUN.get(meta.get("kind", "remote"), "Approval")

        def fire():
            import remote
            fut = remote._pending.get(aid)
            if fut is None or fut.done():
                return
            msg = _message(kind, "waiting", meta.get("title") or "", "#/activity", f"apr-{aid}", noun)
            _remember(msg)
            _enqueue(msg)

        t = threading.Timer(APPROVAL_GRACE, fire)
        t.daemon = True
        t.start()
    except Exception as e:  # noqa: BLE001
        print(f"notify.approval failed: {type(e).__name__}: {e}")


# ── delivery ────────────────────────────────────────────────────────────────

def _subs(sid: str | None = None) -> list:
    _db()
    with db.conn() as c:
        if sid:
            return c.execute("SELECT * FROM push_subs WHERE id=?", (sid,)).fetchall()
        return c.execute("SELECT * FROM push_subs").fetchall()


def send_one(client: httpx.Client, sub, msg: dict) -> dict:
    """POST one encrypted message. Drops the subscription when the push service says it's gone (404/410)."""
    body = encrypt(json.dumps(msg, separators=(",", ":")).encode(), sub["p256dh"], sub["auth"])
    headers = {"Authorization": vapid_header(sub["endpoint"]), "TTL": str(TTL), "Content-Encoding": "aes128gcm",
               "Content-Type": "application/octet-stream",
               # every push becomes a visible notification: "normal" lets Android (FCM) hold it while the phone dozes
               "Urgency": "high"}
    try:
        r = client.post(sub["endpoint"], content=body, headers=headers)
        code, err = r.status_code, "" if r.status_code < 300 else f"{r.status_code} {r.text[:160].strip()}"
    except httpx.HTTPError as e:
        code, err = 0, f"{type(e).__name__}: {e}"[:200]
    with db.conn() as c:
        if code in (404, 410):
            c.execute("DELETE FROM push_subs WHERE id=?", (sub["id"],))
        elif err:
            c.execute("UPDATE push_subs SET last_error=? WHERE id=?", (err, sub["id"]))
        else:
            c.execute("UPDATE push_subs SET last_ok=?, last_error=NULL WHERE id=?", (time.time(), sub["id"]))
    return {"id": sub["id"], "ok": not err, "status": code, "error": err, "removed": code in (404, 410)}


def deliver(msg: dict, sid: str | None = None) -> list[dict]:
    subs = _subs(sid)
    if not subs:
        return []
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        return [send_one(client, s, msg) for s in subs]


def _run():
    while True:
        msg = _queue.get()
        try:
            deliver(msg)
        except Exception as e:  # noqa: BLE001
            print(f"notify delivery failed: {type(e).__name__}: {e}")


def _enqueue(msg: dict):
    global _worker
    if not _subs():
        return
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="notify-push", daemon=True)
            _worker.start()
    _queue.put(msg)


# ── routes ──────────────────────────────────────────────────────────────────

def _owner(req: Request):
    import remote
    remote.require_admin(req)


def _endpoint_ok(endpoint: str) -> bool:
    u = urlsplit(endpoint)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and not u.username and any(
        host == h or (h.startswith(".") and host.endswith(h)) for h in PUSH_HOSTS)


def _ehash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()[:16]


def _device(r) -> dict:
    return {"id": r["id"], "label": r["label"] or "", "service": urlsplit(r["endpoint"]).hostname,
            "hash": _ehash(r["endpoint"]), "created": r["created"] * 1000,
            "lastOk": (r["last_ok"] or 0) * 1000, "lastError": r["last_error"] or "",
            "lastShown": (r["last_shown"] or 0) * 1000, "shownError": r["shown_error"] or ""}


@router.get("/key")
def api_key():
    return {"publicKey": public_key()}


@router.get("/prefs")
def api_prefs(req: Request):
    _owner(req)
    return {**prefs(), "kinds": [{"id": k, "label": l, "hint": h, "default": d} for k, l, h, d in KINDS]}


@router.put("/prefs")
async def api_set_prefs(req: Request):
    _owner(req)
    body = await req.json()
    cur = prefs()
    levels = {**cur["levels"], **{k: v for k, v in (body.get("levels") or {}).items() if k in KIND_IDS and v in LEVELS}}
    details = bool(body["details"]) if "details" in body else cur["details"]
    db.kv_set("notify_prefs", {"levels": levels, "details": details})
    return api_prefs(req)


@router.get("/devices")
def api_devices(req: Request):
    _owner(req)
    return [_device(r) for r in sorted(_subs(), key=lambda r: r["created"])]


@router.post("/subscribe")
async def api_subscribe(req: Request):
    _owner(req)
    body = await req.json()
    sub = body.get("subscription") or {}
    endpoint, keys = str(sub.get("endpoint") or ""), sub.get("keys") or {}
    p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
    if not _endpoint_ok(endpoint):
        raise HTTPException(400, "That push endpoint isn't from a known browser push service.")
    try:
        encrypt(b"probe", p256dh, auth)  # validates the keys
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "The subscription keys are invalid.")
    label = str(body.get("label") or "").strip()[:80]
    ua = req.headers.get("user-agent", "")[:300]
    _db()
    with db.conn() as c:
        old = str(body.get("replaces") or "")
        if old and old != endpoint:
            c.execute("DELETE FROM push_subs WHERE endpoint=?", (old,))
        row = c.execute("SELECT id FROM push_subs WHERE endpoint=?", (endpoint,)).fetchone()
        if row:
            c.execute("UPDATE push_subs SET p256dh=?, auth=?, label=COALESCE(NULLIF(?, ''), label), ua=? WHERE id=?",
                      (p256dh, auth, label, ua, row["id"]))
            sid = row["id"]
        else:
            sid = db.new_id("push")
            c.execute("INSERT INTO push_subs(id, endpoint, p256dh, auth, label, ua, created) VALUES(?,?,?,?,?,?,?)",
                      (sid, endpoint, p256dh, auth, label, ua, time.time()))
    return _device(_subs(sid)[0])


@router.delete("/subscribe")
async def api_unsubscribe(req: Request):
    _owner(req)
    endpoint = str((await req.json()).get("endpoint") or "")
    _db()
    with db.conn() as c:
        n = c.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,)).rowcount
    return {"ok": True, "removed": n}


@router.post("/ack")
async def api_ack(req: Request):
    """The service worker on a device reports what happened to a push: shown, or why not (permission denied, the OS
    refused, skipped because Shell:B was open and focused). Until now the server only knew the push service accepted it.
    Keyed by the subscription endpoint, which only that device knows; behind the normal login like any /api route."""
    try:
        b = await req.json()
    except ValueError:
        raise HTTPException(400, "JSON body expected")
    endpoint = str(b.get("endpoint") or "")
    shown, reason = bool(b.get("shown")), str(b.get("reason") or "")[:200]
    _db()
    with db.conn() as c:
        if shown:
            n = c.execute("UPDATE push_subs SET last_shown=?, shown_error=NULL WHERE endpoint=?", (time.time(), endpoint)).rowcount
        else:
            n = c.execute("UPDATE push_subs SET shown_error=? WHERE endpoint=?", (reason or "not shown", endpoint)).rowcount
    return {"ok": bool(n)}


@router.delete("/devices/{sid}")
def api_remove_device(sid: str, req: Request):
    _owner(req)
    _db()
    with db.conn() as c:
        n = c.execute("DELETE FROM push_subs WHERE id=?", (sid,)).rowcount
    if not n:
        raise HTTPException(404, "No such device")
    return {"ok": True}


@router.post("/test")
async def api_test(req: Request):
    _owner(req)
    try:
        body = await req.json()
    except ValueError:
        body = {}
    sid = (body.get("id") if isinstance(body, dict) else None) or None
    msg = {"t": "Shell:B notifications work", "b": "This is what an Activity alert looks like.",
           "r": "#/activity", "tag": "test", "a": False, "k": "test"}
    results = await asyncio.to_thread(deliver, msg, sid)
    if sid and not results:
        raise HTTPException(404, "No such device")
    return {"sent": sum(r["ok"] for r in results), "results": results}


@router.get("/recent")
def api_recent(since: float = 0):
    """For open-but-hidden tabs without push. Same data class as /api/activity, so it follows that route's auth."""
    return {"now": time.time() * 1000, "items": [m for m in _recent if m["ts"] > since]}
