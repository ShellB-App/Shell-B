"""SQLite persistence for Shell:B Web — conversations, messages, artifacts, memories, settings."""
import json
import logging
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DATA.mkdir(exist_ok=True)
DATA.chmod(0o700)  # the database, keys and every chat live here: owner only
DB_PATH = DATA / "shellb.db"

_audit_logger = logging.getLogger("shellb.audit")

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY, title TEXT, agent_id TEXT, pinned INTEGER DEFAULT 0,
  created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, conv_id TEXT, role TEXT, content TEXT, data TEXT, created REAL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_id, created);
CREATE TABLE IF NOT EXISTS artifacts(
  conv_id TEXT, id TEXT, version INTEGER, title TEXT, type TEXT, language TEXT,
  content TEXT, message_id TEXT, created REAL, PRIMARY KEY(conv_id, id, version));
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY, text TEXT, tags TEXT, embedding BLOB, created REAL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS app_state(scope TEXT, key TEXT, value TEXT, updated REAL, PRIMARY KEY(scope, key));
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, entry TEXT, description TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp REAL,
  action TEXT,
  details TEXT);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(timestamp DESC);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        c.execute("PRAGMA journal_mode=WAL")
    for f in (DB_PATH, DB_PATH.with_name(DB_PATH.name + "-wal"), DB_PATH.with_name(DB_PATH.name + "-shm")):
        if f.exists():
            f.chmod(0o600)  # API keys and every conversation live in here
    with conn() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(conversations)")}
        if "project_id" not in cols:  # Studio threads belong to a project; chat lists skip them
            c.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT")
        if "group_id" not in cols:  # chat Projects (groups of chats + knowledge); unrelated to Studio projects
            c.execute("ALTER TABLE conversations ADD COLUMN group_id TEXT")
        if "incognito" not in cols:  # privacy.py: never remembered, learned from or searched; deleted after a while
            c.execute("ALTER TABLE conversations ADD COLUMN incognito INTEGER DEFAULT 0")
        if "tenant" not in cols:  # guests.py: a guest's chat (always incognito too); never in the owner's lists
            c.execute("ALTER TABLE conversations ADD COLUMN tenant TEXT")
        c.executescript("""
CREATE TABLE IF NOT EXISTS groups(
  id TEXT PRIMARY KEY, name TEXT, description TEXT, instructions TEXT, emoji TEXT, color TEXT,
  pinned INTEGER DEFAULT 0, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS group_chunks(
  group_id TEXT, file TEXT, idx INTEGER, text TEXT, embedding BLOB, PRIMARY KEY(group_id, file, idx));
""")


# ── key/value (agents, tool switches, settings) ─────────────────────────────

def kv_get(key, default=None):
    with conn() as c:
        row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key, value):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(key, value) VALUES(?, ?)", (key, json.dumps(value)))


# ── conversations ───────────────────────────────────────────────────────────

def _conv(row):
    return {
        "id": row["id"], "title": row["title"], "agentId": row["agent_id"],
        "pinned": bool(row["pinned"]), "createdAt": row["created"] * 1000, "updatedAt": row["updated"] * 1000,
        "projectId": row["project_id"],
        "groupId": row["group_id"] if "group_id" in row.keys() else None,
        "incognito": bool(row["incognito"]) if "incognito" in row.keys() else False,
    }


def list_conversations(project_id=None, group_id=None):
    with conn() as c:
        if group_id:
            rows = c.execute("SELECT * FROM conversations WHERE group_id=? AND project_id IS NULL ORDER BY updated DESC", (group_id,)).fetchall()
        elif project_id:
            rows = c.execute("SELECT * FROM conversations WHERE project_id=? ORDER BY updated DESC", (project_id,)).fetchall()
        else:
            rows = c.execute("SELECT * FROM conversations WHERE project_id IS NULL AND tenant IS NULL ORDER BY updated DESC").fetchall()
    return [_conv(r) for r in rows]


def get_conversation(conv_id):
    with conn() as c:
        row = c.execute("SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()
    return _conv(row) if row else None


def create_conversation(agent_id, title="New conversation", project_id=None, group_id=None):
    now = time.time()
    cid = new_id("conv")
    with conn() as c:
        c.execute("INSERT INTO conversations(id, title, agent_id, pinned, created, updated, project_id, group_id) VALUES(?,?,?,0,?,?,?,?)",
                  (cid, title, agent_id, now, now, project_id, group_id or None))
    return get_conversation(cid)


def update_conversation(conv_id, **fields):
    cols = {"title": "title", "agentId": "agent_id", "pinned": "pinned"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in cols and v is not None:
            sets.append(f"{cols[k]}=?")
            vals.append(int(v) if k == "pinned" else v)
    if "groupId" in fields:  # "" or None moves the chat out of its project
        sets.append("group_id=?")
        vals.append(fields["groupId"] or None)
    if sets:
        with conn() as c:
            c.execute(f"UPDATE conversations SET {', '.join(sets)} WHERE id=?", (*vals, conv_id))
    return get_conversation(conv_id)


def touch_conversation(conv_id):
    with conn() as c:
        c.execute("UPDATE conversations SET updated=? WHERE id=?", (time.time(), conv_id))


def _like(s):
    """Escape a literal for a LIKE pattern (ids contain `_`)."""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def delete_conversation(conv_id):
    with conn() as c:
        c.execute("DELETE FROM messages WHERE conv_id=?", (conv_id,))
        c.execute("DELETE FROM artifacts WHERE conv_id=?", (conv_id,))
        c.execute("DELETE FROM app_state WHERE scope LIKE ? ESCAPE '\\'", (_like(f"art:{conv_id}:") + "%",))
        c.execute("DELETE FROM conversations WHERE id=?", (conv_id,))


# ── messages ────────────────────────────────────────────────────────────────

def _msg(row):
    data = json.loads(row["data"] or "{}")
    return {"id": row["id"], "role": row["role"], "content": row["content"],
            "timestamp": row["created"] * 1000, **data}


def list_messages(conv_id):
    with conn() as c:
        rows = c.execute("SELECT * FROM messages WHERE conv_id=? ORDER BY created", (conv_id,)).fetchall()
    return [_msg(r) for r in rows]


def add_message(conv_id, role, content, data=None, msg_id=None):
    mid = msg_id or new_id("msg")
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?)",
                  (mid, conv_id, role, content, json.dumps(data or {}), time.time()))
    touch_conversation(conv_id)
    return mid


def delete_messages_from(conv_id, msg_id):
    """Delete a message and everything after it (used for regenerate / edit)."""
    with conn() as c:
        row = c.execute("SELECT created FROM messages WHERE id=? AND conv_id=?", (msg_id, conv_id)).fetchone()
        if not row:
            return
        c.execute("DELETE FROM messages WHERE conv_id=? AND created>=?", (conv_id, row["created"]))


# ── artifacts (versioned per conversation) ──────────────────────────────────

def _art(row):
    return {"id": row["id"], "version": row["version"], "title": row["title"], "type": row["type"],
            "language": row["language"], "content": row["content"], "messageId": row["message_id"],
            "timestamp": row["created"] * 1000}


def save_artifact(conv_id, art_id, title, type_, language, content, message_id):
    with conn() as c:
        row = c.execute("SELECT MAX(version) v FROM artifacts WHERE conv_id=? AND id=?", (conv_id, art_id)).fetchone()
        version = (row["v"] or 0) + 1
        c.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)",
                  (conv_id, art_id, version, title, type_, language, content, message_id, time.time()))
    return {"id": art_id, "version": version, "title": title, "type": type_, "language": language,
            "content": content, "messageId": message_id}


def list_artifacts(conv_id):
    """All artifact versions in a conversation, grouped by id: [{id, title, type, versions:[...]}]."""
    with conn() as c:
        rows = c.execute("SELECT * FROM artifacts WHERE conv_id=? ORDER BY id, version", (conv_id,)).fetchall()
    out = {}
    for r in rows:
        a = _art(r)
        g = out.setdefault(a["id"], {"id": a["id"], "versions": []})
        g.update(title=a["title"], type=a["type"], language=a["language"])
        g["versions"].append(a)
    return list(out.values())


def latest_artifacts(conv_id):
    return [g["versions"][-1] for g in list_artifacts(conv_id)]


def all_artifacts():
    """The latest version of every artifact in every conversation, newest first, with its chat's title and agent."""
    with conn() as c:
        rows = c.execute("""
            SELECT a.*, n.versions, n.first, v.title conv_title, v.agent_id, v.project_id, v.group_id
            FROM artifacts a
            JOIN (SELECT conv_id, id, MAX(version) top, COUNT(*) versions, MIN(created) first
                  FROM artifacts GROUP BY conv_id, id) n
              ON a.conv_id=n.conv_id AND a.id=n.id AND a.version=n.top
            JOIN conversations v ON v.id=a.conv_id
            WHERE coalesce(v.incognito, 0)=0  -- incognito chats (privacy.py) stay out of the Library
            ORDER BY a.created DESC""").fetchall()
    return [{**_art(r), "convId": r["conv_id"], "convTitle": r["conv_title"], "agentId": r["agent_id"],
             "studioProjectId": r["project_id"], "groupId": r["group_id"], "versions": r["versions"],
             "createdAt": r["first"] * 1000} for r in rows]


# ── memories ────────────────────────────────────────────────────────────────

def add_memory(text, tags, embedding: bytes):
    mid = new_id("mem")
    with conn() as c:
        c.execute("INSERT INTO memories(id, text, tags, embedding, created) VALUES(?,?,?,?,?)",
                  (mid, text, json.dumps(tags or []), embedding, time.time()))
    return mid


def all_memories(with_embeddings=False):
    with conn() as c:
        rows = c.execute("SELECT * FROM memories ORDER BY created DESC").fetchall()
    out = []
    for r in rows:
        m = {"id": r["id"], "text": r["text"], "tags": json.loads(r["tags"] or "[]"), "createdAt": r["created"] * 1000}
        if with_embeddings:
            m["embedding"] = r["embedding"]
        out.append(m)
    return out


def delete_memory(mem_id):
    with conn() as c:
        c.execute("DELETE FROM memories WHERE id=?", (mem_id,))


# ── studio projects ─────────────────────────────────────────────────────────

def _proj(row):
    return {"id": row["id"], "name": row["name"], "kind": row["kind"], "entry": row["entry"],
            "description": row["description"] or "", "createdAt": row["created"] * 1000, "updatedAt": row["updated"] * 1000}


def list_projects():
    with conn() as c:
        rows = c.execute("SELECT * FROM projects ORDER BY updated DESC").fetchall()
    return [_proj(r) for r in rows]


def get_project(pid):
    with conn() as c:
        row = c.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return _proj(row) if row else None


def create_project(name, kind, entry, description=""):
    now = time.time()
    pid = new_id("proj")
    with conn() as c:
        c.execute("INSERT INTO projects VALUES(?,?,?,?,?,?,?)", (pid, name, kind, entry, description, now, now))
    return get_project(pid)


def update_project(pid, **fields):
    allowed = {"name", "kind", "entry", "description"}
    sets = [(k, v) for k, v in fields.items() if k in allowed and v is not None]
    with conn() as c:
        if sets:
            c.execute(f"UPDATE projects SET {', '.join(k + '=?' for k, _ in sets)}, updated=? WHERE id=?",
                      (*[v for _, v in sets], time.time(), pid))
        else:
            c.execute("UPDATE projects SET updated=? WHERE id=?", (time.time(), pid))
    return get_project(pid)


def delete_project(pid):
    with conn() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM conversations WHERE project_id=?", (pid,))]
        for cid in ids:
            c.execute("DELETE FROM messages WHERE conv_id=?", (cid,))
            c.execute("DELETE FROM artifacts WHERE conv_id=?", (cid,))
            c.execute("DELETE FROM app_state WHERE scope LIKE ? ESCAPE '\\'", (_like(f"art:{cid}:") + "%",))
        c.execute("DELETE FROM app_state WHERE scope=?", (f"proj:{pid}",))
        c.execute("DELETE FROM conversations WHERE project_id=?", (pid,))
        c.execute("DELETE FROM projects WHERE id=?", (pid,))


# ── audit logging ───────────────────────────────────────────────────────────

def add_audit_log(action: str, details: dict | list | str | None = None, timestamp: float | None = None):
    ts = timestamp if timestamp is not None else time.time()
    if isinstance(details, (dict, list)):
        dt = json.dumps(details)
    elif details is None:
        dt = ""
    else:
        dt = str(details)
    with conn() as c:
        c.execute("INSERT INTO audit_log(timestamp, action, details) VALUES(?, ?, ?)", (ts, action, dt))
    _audit_logger.info("AUDIT [%s]: %s", action, (dt[:300] + "...") if len(dt) > 300 else dt)


audit_log = add_audit_log


def list_audit_log(limit: int = 100, offset: int = 0, action: str | None = None) -> list[dict]:
    with conn() as c:
        if action:
            rows = c.execute("SELECT * FROM audit_log WHERE action=? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?",
                             (action, limit, offset)).fetchall()
        else:
            rows = c.execute("SELECT * FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?",
                             (limit, offset)).fetchall()
    out = []
    for r in rows:
        d = r["details"]
        try:
            parsed = json.loads(d) if d else {}
        except Exception:
            parsed = d
        out.append({"id": r["id"], "timestamp": r["timestamp"], "action": r["action"], "details": parsed})
    return out

