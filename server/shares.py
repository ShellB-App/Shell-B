"""Share links: a read-only, public copy of one chat or one artifact at `#/s/<token>`.

A share is a snapshot, not a window: `POST /api/shares` copies the chat's messages (role, text, time, agent) or the
artifact's content (one version) into data/shares/<token>.json, so later edits, deletions and new messages never leak.
The token is 32 hex characters; `GET /api/share/<token>` is public (auth.PUBLIC) and answers 404 for anything revoked,
expired or unknown, and nothing else about why. The page (ui/src/components/SharedView.tsx) renders Markdown and
sandboxes HTML/SVG artifacts exactly as the owner's own view does, and makes no other API calls.

Refused: incognito chats, guests' chats and API-key chats (not the owner's to share), adult-agent chats. Shares expire
after `expires` days (30 by default; 0 = never) and can be revoked on Settings → Account → Shared links. Views are
counted, not logged. The link is built from `shareHost` when set (a host without Cloudflare Access in front of it, see
MANUAL § Share links); otherwise it is this origin, which only people who can already log in can open.
"""
import json
import re
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/shares")        # owner
public_router = APIRouter(prefix="/api/share")  # anyone with the token
DIR = db.DATA / "shares"
TOKEN = re.compile(r"^[0-9a-f]{32}$")
DEFAULT_DAYS = 30
MAX_MESSAGES = 500


def init():
    DIR.mkdir(parents=True, exist_ok=True)
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS shares(
            token TEXT PRIMARY KEY, kind TEXT, conv_id TEXT, artifact_id TEXT, version INTEGER, title TEXT, created REAL,
            expires REAL, views INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0)""")


def _path(token: str) -> Path:
    return DIR / f"{token}.json"


def _row(r) -> dict:
    return {"token": r["token"], "kind": r["kind"], "convId": r["conv_id"], "artifactId": r["artifact_id"], "version": r["version"],
            "title": r["title"], "created": r["created"], "expires": r["expires"], "views": r["views"], "revoked": bool(r["revoked"]),
            "url": link(r["token"])}


def link(token: str) -> str:
    host = str((db.kv_get("settings") or {}).get("shareHost") or "").strip().lower().rstrip("/")
    base = f"https://{host}" if host and not host.startswith("http") else host
    return f"{base}/#/s/{token}" if base else f"#/s/{token}"


def _shareable(conv: dict):
    if conv.get("incognito"):
        raise ValueError("Incognito chats can't be shared")
    if conv.get("tenant"):
        raise ValueError("A guest's chat isn't yours to share")
    with db.conn() as c:
        if c.execute("SELECT 1 FROM api_conversations WHERE conv_id=?", (conv["id"],)).fetchone():
            raise ValueError("Chats made through an API key can't be shared")
    import adult
    from roster import find_agent
    agent, _ = find_agent(conv.get("agentId") or "")
    if adult.is_adult(agent):
        raise ValueError("That chat can't be shared")


def _agent_names() -> dict:
    from roster import get_agents
    return {a["id"]: a["name"] for a in get_agents()}


def create(kind: str, conv_id: str, artifact_id: str | None = None, version: int | None = None, days: int = DEFAULT_DAYS) -> dict:
    conv = db.get_conversation(conv_id)
    if not conv:
        raise LookupError("No such conversation")
    _shareable(conv)
    token = secrets.token_hex(16)
    now = time.time()
    if kind == "artifact":
        arts = db.list_artifacts(conv_id)
        g = next((a for a in arts if a["id"] == artifact_id), None)
        if not g or not g["versions"]:
            raise LookupError("No such artifact")
        v = next((x for x in g["versions"] if x["version"] == version), None) if version else g["versions"][-1]
        if not v:
            raise LookupError("No such version")
        title = g["title"] or "Artifact"
        snap = {"kind": "artifact", "title": title, "artifact": {"id": g["id"], "type": v["type"], "language": v.get("language"),
                                                                 "version": v["version"], "content": v["content"]}}
        version = v["version"]
    elif kind == "chat":
        names = _agent_names()
        msgs = []
        for m in db.list_messages(conv_id)[-MAX_MESSAGES:]:
            if m.get("summarizedBy"):
                continue
            msgs.append({"id": m["id"], "role": m["role"], "content": m.get("content") or "", "timestamp": m.get("timestamp"),
                         "agent": names.get(m.get("agentId") or conv.get("agentId") or "", "") if m["role"] == "assistant" else "",
                         "attachments": [{"name": a.get("name"), "kind": a.get("kind")} for a in (m.get("attachments") or []) if isinstance(a, dict)]})
        title = conv.get("title") or "Conversation"
        snap = {"kind": "chat", "title": title, "agent": names.get(conv.get("agentId") or "", ""), "messages": msgs,
                "artifacts": [{"id": a["id"], "title": a["title"], "type": a["versions"][-1]["type"], "content": a["versions"][-1]["content"],
                               "language": a["versions"][-1].get("language")} for a in db.list_artifacts(conv_id) if a["versions"]]}
        artifact_id = None
    else:
        raise ValueError("kind is chat or artifact")
    snap.update(token=token, created=now)
    _path(token).write_text(json.dumps(snap, ensure_ascii=False))
    expires = now + days * 86400 if days else None
    with db.conn() as c:
        c.execute("INSERT INTO shares(token, kind, conv_id, artifact_id, version, title, created, expires, views, revoked) VALUES(?,?,?,?,?,?,?,?,0,0)",
                  (token, kind, conv_id, artifact_id, version, title[:200], now, expires))
    db.audit_log("share:create", {"kind": kind, "conv": conv_id, "artifact": artifact_id, "token": token[:8]})
    return get(token)


def get(token: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
    return _row(r) if r else None


def list_shares() -> list[dict]:
    with db.conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM shares ORDER BY created DESC")]


def revoke(token: str) -> bool:
    with db.conn() as c:
        n = c.execute("UPDATE shares SET revoked=1 WHERE token=?", (token,)).rowcount
    if n:
        _path(token).unlink(missing_ok=True)
        db.audit_log("share:revoke", {"token": token[:8]})
    return n > 0


def snapshot(token: str) -> dict | None:
    """The public view: the snapshot if the share is live, else None (and nothing about why)."""
    if not TOKEN.match(token or ""):
        return None
    with db.conn() as c:
        r = c.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
        if not r or r["revoked"] or (r["expires"] and r["expires"] < time.time()):
            return None
        c.execute("UPDATE shares SET views=views+1 WHERE token=?", (token,))
    p = _path(token)
    if not p.exists():
        return None
    return json.loads(p.read_text())


# ── routes ──────────────────────────────────────────────────────────────────

def _owner(req: Request):
    import auth
    if not (auth.is_owner(req) or auth.is_admin(req)):  # not localhost: a share publishes content
        raise HTTPException(401, "login-required")


@router.get("")
def api_list(req: Request):
    _owner(req)
    return {"shares": list_shares(), "host": str((db.kv_get("settings") or {}).get("shareHost") or "")}


@router.post("")
async def api_create(req: Request):
    _owner(req)
    b = await req.json()
    try:
        days = int(b.get("days", DEFAULT_DAYS))
        return create(str(b.get("kind") or "chat"), str(b.get("conversation") or ""), b.get("artifact"), b.get("version"), max(0, min(3650, days)))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/{token}")
def api_revoke(token: str, req: Request):
    _owner(req)
    if not revoke(token):
        raise HTTPException(404, "No such share")
    return {"ok": True}


@public_router.get("/{token}")
def api_public(token: str):
    snap = snapshot(token)
    if snap is None:
        raise HTTPException(404, "This link doesn't open anything.")
    return snap
