"""Activity: one inbox for the work Shell:B does while nobody is watching. Shown at #/activity.

Scheduled runs, project to-dos, Mega Plans, asset scouts, notebook outputs and self-deploys each post an event here
when they finish, fail or need the owner (`post`). Nothing is posted for things the owner did themselves in front of
the UI (stopping a run, pausing a plan). Approvals that agents are waiting on right now (remote commands, self-deploys)
aren't events: they live in remote.py's in-memory futures, and `pending()` lists them so the inbox can answer them.

Self-deploys that restart the server finish in a separate systemd unit (selfmod.RUNNER) that only writes
data/selfmod/deploys.json, so `_sync_deploys` turns its final states into events when the status poll comes by.
"""
import json
import time

from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/activity")
SOURCES = ("schedule", "todo", "plan", "scout", "notebook", "deploy", "codex", "memory", "data", "brief", "health", "nightshift")
ATTENTION = ("failed", "blocked", "paused", "interrupted", "rolled-back", "restart-pending", "review", "warning")
KEEP = 2000           # events kept; the oldest read ones go first
BODY_LIMIT = 600
_ready = False


def init():
    global _ready
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS activity(
  id TEXT PRIMARY KEY, ts REAL, source TEXT, status TEXT, title TEXT, body TEXT, link TEXT, ref TEXT UNIQUE,
  read INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
""")
    if db.kv_get("activity_since") is None:  # deploys from before the inbox existed aren't news
        db.kv_set("activity_since", time.time())
    _ready = True


def post(source: str, status: str, title: str, body: str = "", link: str = "", ref: str | None = None):
    """Record one event. Never raises: a broken inbox must not break the job that reports to it. `ref` dedupes."""
    try:
        if not _ready:
            init()
        body = (body or "").strip()
        if len(body) > BODY_LIMIT:
            body = body[:BODY_LIMIT].rsplit(" ", 1)[0] + "…"
        with db.conn() as c:
            new = c.execute("INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?,?,?,0)",
                            (db.new_id("act"), time.time(), source, status, title[:200], body, link, ref)).rowcount
            c.execute("DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY read DESC, ts ASC "
                      "LIMIT max(0, (SELECT count(*) FROM activity) - ?))", (KEEP,))
        if new:  # a deduped repeat (same ref) doesn't notify again
            import notify
            notify.event(source, status, title, link, ref)
    except Exception as e:  # noqa: BLE001
        print(f"activity.post failed: {type(e).__name__}: {e}")


def excerpt(text: str | None, n: int = 280) -> str:
    """The end of a run's final reply, where the result usually is, minus Markdown noise."""
    t = " ".join((text or "").replace("#", "").replace("**", "").split())
    return t if len(t) <= n else "…" + t[-n:].split(" ", 1)[-1]


# ── approvals waiting right now ─────────────────────────────────────────────

def pending() -> list[dict]:
    import remote
    out = []
    with db.conn() as c:
        for aid, m in list(remote._meta.items()):
            fut = remote._pending.get(aid)
            if fut is None or fut.done():
                continue
            r = c.execute("SELECT title FROM conversations WHERE id=?", (m.get("conv"),)).fetchone()
            out.append({"id": aid, "kind": m.get("kind", "remote"), "title": m.get("title", ""),
                        "detail": (m.get("detail") or "")[:4000], "convId": m.get("conv"),
                        "convTitle": r["title"] if r else "", "since": m.get("since", 0) * 1000})
    return sorted(out, key=lambda p: p["since"])


# ── self-deploys finished by the restart runner ─────────────────────────────

_deploys_seen = 0.0
DEPLOY_DONE = {"live": "done", "rolled-back": "rolled-back", "restart-pending": "restart-pending"}


def _sync_deploys():
    global _deploys_seen
    import selfmod
    f = selfmod.STATE / "deploys.json"
    try:
        mtime = f.stat().st_mtime
        if mtime == _deploys_seen:
            return
        items = json.loads(f.read_text())
    except (OSError, ValueError):
        return
    _deploys_seen = mtime
    since = db.kv_get("activity_since", 0)
    for d in items:
        st = DEPLOY_DONE.get(d.get("status"))
        if not st or not d.get("server") or d.get("at", 0) < since:  # in-turn deploys were watched live
            continue
        title = {"done": "Self-deploy is live", "rolled-back": "Self-deploy rolled back",
                 "restart-pending": "Self-deploy is waiting for a restart"}[st]
        last = (d.get("log") or [""])[-1]
        post("deploy", st, f"{title}: {d.get('summary') or d['id']}", last.split("\n", 1)[0][9:],
             f"#/c/{d['conv']}" if d.get("conv") else "", ref=f"deploy:{d['id']}:{st}")


# ── reads ───────────────────────────────────────────────────────────────────

def _item(r) -> dict:
    return {"id": r["id"], "ts": r["ts"] * 1000, "source": r["source"], "status": r["status"], "title": r["title"],
            "body": r["body"], "link": r["link"], "read": bool(r["read"]), "attention": r["status"] in ATTENTION}


def summary() -> dict:
    """For /api/status: what the rail badge shows."""
    try:
        _sync_deploys()
        import remote
        with db.conn() as c:
            unread = c.execute("SELECT count(*) FROM activity WHERE read=0").fetchone()[0]
            urgent = c.execute(f"SELECT count(*) FROM activity WHERE read=0 AND status IN ({','.join('?' * len(ATTENTION))})",
                               ATTENTION).fetchone()[0]
        waiting = sum(1 for aid in remote._meta if aid in remote._pending and not remote._pending[aid].done())
        return {"unread": unread, "attention": urgent, "pending": waiting}
    except Exception:  # noqa: BLE001
        return {"unread": 0, "attention": 0, "pending": 0}


@router.get("")
def api_list(limit: int = 100, before: float = 0, source: str = "", only: str = ""):
    _sync_deploys()
    where, args = [], []
    if before:
        where.append("ts<?"); args.append(before / 1000)
    if source in SOURCES:
        where.append("source=?"); args.append(source)
    if only == "unread":
        where.append("read=0")
    elif only == "attention":
        where.append(f"status IN ({','.join('?' * len(ATTENTION))})"); args += ATTENTION
    sql = "SELECT * FROM activity" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY ts DESC LIMIT ?"
    with db.conn() as c:
        rows = c.execute(sql, (*args, max(1, min(limit, 300)))).fetchall()
    return {**summary(), "items": [_item(r) for r in rows], "pending": pending()}


@router.post("/read")
async def api_read(req: Request):
    body = await req.json()
    ids = [str(i) for i in body.get("ids") or []][:500]
    read = 0 if body.get("unread") else 1
    with db.conn() as c:
        if body.get("all"):
            c.execute("UPDATE activity SET read=?", (read,))
        elif ids:
            c.execute(f"UPDATE activity SET read=? WHERE id IN ({','.join('?' * len(ids))})", (read, *ids))
        else:
            raise HTTPException(400, "send ids or all")
    return summary()


@router.delete("/{aid}")
def api_delete(aid: str):
    with db.conn() as c:
        c.execute("DELETE FROM activity WHERE id=?", (aid,))
    return summary()


@router.post("/clear")
def api_clear():
    """Deletes everything already read."""
    with db.conn() as c:
        c.execute("DELETE FROM activity WHERE read=1")
    return summary()
