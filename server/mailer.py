"""Email from Shell:B through Resend (default) or Cloudflare Email Sending: notifications, guest links, agent mail.

Three senders, one door:
- **Notifications** (notify.py): a channel next to Web Push with its own per-kind level (`notify_prefs.email`), off
  by default. Approvals wait EMAIL_GRACE seconds first, so one answered in the app never reaches the inbox.
- **Guests** (guest_accounts.py): the owner can email an invite or a reset link, and a guest can ask for a reset link
  at sign-in ("Forgot password?"). That request answers the same whether or not the account exists.
- **Agents**: the `send_email` tool. Every message waits for the owner's approval with the full text shown (like the
  browser tool's submits), and replies go to the owner (Reply-To). Never in guest turns or the adult agent.

Config (kv `email`, admin-only to change): the provider (`resend`, whose free tier suits this; `cloudflare` needs a paid
plan and its account id), the From address on a domain verified with that provider, the owner's own address (`to`) and
the app's public URL for links. The API key lives in data/email/api.token (0600) and is never returned by any route. Every send is logged in `email_log` (90 days), and SEND_CAP per hour bounds what
a runaway loop could send.

Privacy: mail leaves through the provider and lands in the recipient's provider. Notification mail follows the same
`details` preference as push: by default only a generic subject ("Mega Plan finished") and a link go out.
"""
import asyncio
import os
import re
import threading
import time
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Request

import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/email")
DIR = db.DATA / "email"
TOKEN = DIR / "api.token"
PROVIDERS = {"resend": "https://api.resend.com/emails",
             "cloudflare": "https://api.cloudflare.com/client/v4/accounts/{account}/email/sending/send"}
DEFAULTS = {"provider": "resend", "accountId": "", "from": "notify@shellb.app", "fromName": "Shell:B", "to": "", "appUrl": "https://ai.shellb.app"}
SEND_CAP = 40              # emails per rolling hour, all senders together
EMAIL_GRACE = 120          # seconds an approval stays unanswered before it is emailed
MAX_RECIPIENTS = 10
MAX_BODY = 20_000
LOG_DAYS = 90
ADDRESS = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")
ACCOUNT = re.compile(r"^[0-9a-f]{32}$")
RETRYABLE = {429, 500, 502, 503, 504}

_sent: list[float] = []
_lock = threading.Lock()


def init():
    DIR.mkdir(parents=True, exist_ok=True)
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS email_log(id TEXT PRIMARY KEY, ts REAL, kind TEXT, to_addr TEXT, "
                  "subject TEXT, ok INTEGER, error TEXT)")
        c.execute("DELETE FROM email_log WHERE ts < ?", (time.time() - LOG_DAYS * 86400,))


def config() -> dict:
    return {**DEFAULTS, **(db.kv_get("email") or {})}


def _token() -> str:
    try:
        return TOKEN.read_text().strip()
    except OSError:
        return ""


def ready() -> bool:
    cfg = config()
    account_ok = cfg["provider"] != "cloudflare" or ACCOUNT.match(cfg["accountId"])
    return bool(cfg["provider"] in PROVIDERS and account_ok and ADDRESS.match(cfg["from"]) and _token())


def valid_address(value) -> str | None:
    s = str(value or "").strip()
    return s if len(s) <= 254 and ADDRESS.match(s) else None


def _log(kind: str, to: list[str], subject: str, ok: bool, error: str = ""):
    with db.conn() as c:
        c.execute("INSERT INTO email_log VALUES(?,?,?,?,?,?,?)",
                  (uuid.uuid4().hex, time.time(), kind, ", ".join(to)[:500], subject[:200], int(ok), error[:300]))


def _reserve() -> bool:
    with _lock:
        now = time.time()
        _sent[:] = [t for t in _sent if now - t < 3600]
        if len(_sent) >= SEND_CAP:
            return False
        _sent.append(now)
        return True


def send(kind: str, to: list[str] | str, subject: str, text: str, html: str | None = None,
         reply_to: str | None = None) -> dict:
    """Send one message. Blocking (use asyncio.to_thread from async code). Never raises; returns {ok, error, ...}."""
    to = [to] if isinstance(to, str) else list(to)
    subject = re.sub(r"[\r\n]+", " ", subject).strip()[:200]
    if not ready():
        return {"ok": False, "error": "Email isn't set up (Settings → Notifications → Email)."}
    bad = [a for a in to if not valid_address(a)]
    if not to or bad or len(to) > MAX_RECIPIENTS:
        return {"ok": False, "error": f"Bad recipient list: {', '.join(bad) or len(to)}"}
    if not _reserve():
        _log(kind, to, subject, False, "hourly cap")
        return {"ok": False, "error": f"Shell:B already sent {SEND_CAP} emails this hour. Try again later."}
    cfg = config()
    resend = cfg["provider"] == "resend"
    name = cfg["fromName"] or "Shell:B"
    body = {"to": to, "subject": subject, "text": text,
            "from": f"{name} <{cfg['from']}>" if resend else {"address": cfg["from"], "name": name}}
    if html:
        body["html"] = html
    if reply_to and valid_address(reply_to):
        body["reply_to"] = reply_to
    headers = {"Authorization": f"Bearer {_token()}"}
    if resend:
        headers["Idempotency-Key"] = uuid.uuid4().hex  # a retry after a lost response can't send it twice
    err, result = "", {}
    for attempt in range(3):
        try:
            r = httpx.post(PROVIDERS[cfg["provider"]].format(account=cfg["accountId"]), json=body, timeout=20,
                           follow_redirects=False, headers=headers)
            data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code < 300 and (data.get("id") if resend else data.get("success")):
                result = {} if resend else data.get("result") or {}
                err = ""
                break
            errs = data.get("errors") or [{"message": data.get("message") or r.text[:200]}]
            err = f"{r.status_code} " + "; ".join(str(e.get("message", e)) for e in errs)[:250]
            if r.status_code not in RETRYABLE:
                break
        except httpx.HTTPError as e:
            err = f"{type(e).__name__}: {e}"[:250]
        time.sleep(2 * (attempt + 1))
    bounced = result.get("permanent_bounces") or []
    if not err and bounced:
        err = "bounced: " + ", ".join(map(str, bounced))[:200]
    _log(kind, to, subject, not err, err)
    return {"ok": not err, "error": err, "delivered": result.get("delivered") or [], "queued": result.get("queued") or []}


def send_later(kind: str, to, subject: str, text: str, **kw):
    """Fire and forget from sync code (notify's timers, request handlers that mustn't wait on the mail service)."""
    threading.Thread(target=send, args=(kind, to, subject, text), kwargs=kw, name="mailer", daemon=True).start()


def link(route: str = "") -> str:
    base = config()["appUrl"].rstrip("/")
    return f"{base}/{route}" if route.startswith("#") else base


# ── notifications (called by notify.py) ─────────────────────────────────────

def notify(msg: dict):
    to = valid_address(config()["to"])
    if not to or not ready():
        return
    lines = [msg["t"]]
    if msg.get("b"):
        lines += ["", msg["b"]]
    lines += ["", f"Open: {link(msg.get('r') or '#/activity')}", "",
              "— Shell:B. Choose what emails you in Settings → Notifications."]
    send_later("notify", to, f"Shell:B: {msg['t']}", "\n".join(lines))


# ── routes ──────────────────────────────────────────────────────────────────

def _owner(req: Request):
    import remote
    remote.require_admin(req)


def status() -> dict:
    cfg = config()
    with db.conn() as c:
        rows = c.execute("SELECT ts, kind, to_addr, subject, ok, error FROM email_log ORDER BY ts DESC LIMIT 25").fetchall()
    return {**cfg, "tokenSet": bool(_token()), "ready": ready(), "cap": SEND_CAP,
            "log": [{"ts": r["ts"] * 1000, "kind": r["kind"], "to": r["to_addr"], "subject": r["subject"],
                     "ok": bool(r["ok"]), "error": r["error"] or ""} for r in rows]}


@router.get("")
def api_status(req: Request):
    _owner(req)
    return status()


@router.put("")
async def api_config(req: Request):
    _owner(req)
    body = await req.json()
    cur = {k: v for k, v in config().items() if k in DEFAULTS}
    if "provider" in body:
        if body["provider"] not in PROVIDERS:
            raise HTTPException(400, f"Provider must be one of: {', '.join(PROVIDERS)}.")
        cur["provider"] = body["provider"]
    if "accountId" in body:
        v = str(body["accountId"] or "").strip().lower()
        if v and not ACCOUNT.match(v):
            raise HTTPException(400, "The account ID is the 32-character hex string in the Cloudflare dashboard URL.")
        cur["accountId"] = v
    for k in ("from", "to"):
        if k in body:
            v = str(body[k] or "").strip()
            if v and not valid_address(v):
                raise HTTPException(400, f"{v!r} isn't an email address.")
            cur[k] = v
    if "fromName" in body:
        cur["fromName"] = re.sub(r"[\r\n<>\"]", "", str(body["fromName"] or ""))[:60].strip()
    if "appUrl" in body:
        v = str(body["appUrl"] or "").strip().rstrip("/")
        if v and not re.match(r"^https://[\w.-]+(:\d+)?$", v):
            raise HTTPException(400, "The app address must look like https://ai.shellb.app.")
        cur["appUrl"] = v
    db.kv_set("email", cur)
    return status()


@router.put("/token")
async def api_token(req: Request):
    _owner(req)
    token = str((await req.json()).get("token") or "").strip()
    if not re.match(r"^[A-Za-z0-9_-]{30,200}$", token):
        raise HTTPException(400, "That doesn't look like an API key.")
    DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(TOKEN, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    return status()


@router.delete("/token")
def api_token_delete(req: Request):
    _owner(req)
    TOKEN.unlink(missing_ok=True)
    return status()


@router.post("/test")
async def api_test(req: Request):
    _owner(req)
    to = valid_address(config()["to"])
    if not to:
        raise HTTPException(400, "Add your own address first.")
    res = await asyncio.to_thread(send, "test", to, "Shell:B email works",
                                  f"This is a test from Shell:B.\n\nOpen Shell:B: {link()}")
    if not res["ok"]:
        raise HTTPException(502, res["error"])
    return res


# ── agent tool ──────────────────────────────────────────────────────────────

def _recipients(args) -> list[str]:
    raw = args.get("to")
    items = raw if isinstance(raw, list) else re.split(r"[,;\s]+", str(raw or ""))
    return [str(a).strip() for a in items if str(a).strip()]


async def run(args, ctx, abort, sink, idx) -> ToolResult:
    """send_email in an owner turn: show the whole message, wait for approval, then send it."""
    import remote
    if not ready():
        return ToolResult("Email isn't set up yet. The owner sets it up in Settings → Notifications → Email.", error=True)
    to = _recipients(args if isinstance(args, dict) else {})
    subject = str(args.get("subject") or "").strip()
    body = str(args.get("body") or "")
    bad = [a for a in to if not valid_address(a)]
    if not to or bad:
        return ToolResult(f"Give one to {MAX_RECIPIENTS} valid addresses in `to`." + (f" Not valid: {', '.join(bad)}" if bad else ""), error=True)
    if len(to) > MAX_RECIPIENTS:
        return ToolResult(f"At most {MAX_RECIPIENTS} recipients per email.", error=True)
    if not subject or not body.strip():
        return ToolResult("An email needs a subject and a body.", error=True)
    if len(body) > MAX_BODY:
        return ToolResult(f"The body is {len(body):,} characters; keep it under {MAX_BODY:,}.", error=True)
    owner = valid_address(config()["to"])
    title = f"Send an email to {', '.join(to)}"[:160]
    detail = "\n".join([f"From: {config()['fromName']} <{config()['from']}>", f"To: {', '.join(to)}",
                        f"Reply-To: {owner or '(none)'}", f"Subject: {subject[:200]}", "", body])
    aid = uuid.uuid4().hex
    b = sink.blocks[idx]
    b.update(status="approval", approval={"id": aid, "kind": "email", "title": title, "detail": detail})
    await sink.update(idx)
    decision = await remote.wait_approval(aid, abort, {"kind": "email", "conv": ctx.conv_id, "title": title, "detail": detail})
    b.pop("approval", None)
    b.update(status="running", decision=decision)
    await sink.update(idx)
    try:
        remote.audit(kind="email", conv=ctx.conv_id, title=title, decision=decision)
    except Exception:
        pass
    if decision != "allow":
        why = {"deny": "The user declined", "timeout": "Nobody approved it in time",
               "stopped": "The turn was stopped"}.get(decision, "It wasn't approved")
        return ToolResult(f"{why}, so the email was not sent. Don't resend it unchanged; ask the user what to change.", error=True)
    res = await asyncio.to_thread(send, "agent", to, subject, body, reply_to=owner)
    if not res["ok"]:
        return ToolResult(f"The email was approved but sending failed: {res['error']}", error=True)
    return ToolResult(f"Sent to {', '.join(to)}" + (" (queued by the mail service)." if res["queued"] else "."))


async def _live_only(args, ctx):
    return ToolResult("send_email needs the owner's approval, so it only runs in the owner's own chats.", error=True)


def register():
    TOOLS["send_email"] = {
        "fn": _live_only, "service": None, "scope": "global", "auto": "in live owner chats once email is set up (every email waits for your approval)",
        "ui": {"displayName": "Send email", "icon": "Mail",
               "description": "Agents can write emails from your Shell:B address. Each one waits for your approval with the "
                              "full text, and replies come to you."},
        "schema": _fn("send_email",
                      "Send an email from Shell:B's address. The user sees the whole message and must approve it before it "
                      "goes; replies go to the user. Plain text only. Use it only when the user asked for an email to be sent.",
                      {"to": {"type": "array", "items": {"type": "string"}, "description": f"1-{MAX_RECIPIENTS} email addresses"},
                       "subject": {"type": "string"},
                       "body": {"type": "string", "description": "the plain-text message, signed as the user wants"}},
                      ["to", "subject", "body"]),
    }
